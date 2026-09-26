import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

vi.mock('../eligibility/dynamoClient.js', () => ({
  createDynamoClient: vi.fn(),
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
}));

interface FakeItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

function createFakeDdb(seed: readonly FakeItem[] = []): {
  send: DynamoDBDocumentClient['send'];
  items: Map<string, FakeItem>;
} {
  const items = new Map<string, FakeItem>();
  for (const item of seed) {
    items.set(`${item.pk}#${item.sk}`, item);
  }
  const send = vi.fn((command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      return Promise.resolve({ Item: items.get(`${key.pk}#${key.sk}`) });
    }
    if (name === 'PutCommand') {
      const put = input as { Item: FakeItem; ConditionExpression?: string };
      const key = `${put.Item.pk}#${put.Item.sk}`;
      if (put.ConditionExpression && items.has(key)) {
        const existing = items.get(key);
        if (
          put.ConditionExpression.includes('expiresAt') &&
          typeof existing?.expiresAt === 'number' &&
          existing.expiresAt <
            ((input as { ExpressionAttributeValues?: Record<string, unknown> })
              .ExpressionAttributeValues?.[':now'] as number)
        ) {
          items.set(key, put.Item);
          return Promise.resolve({});
        }
        throw new ConditionalCheckFailedException({
          message: 'conditional check failed',
          $metadata: {},
        });
      }
      items.set(key, put.Item);
      return Promise.resolve({});
    }
    if (name === 'DeleteCommand') {
      const del = input as { Key: { pk: string; sk: string } };
      items.delete(`${del.Key.pk}#${del.Key.sk}`);
      return Promise.resolve({});
    }
    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as ReadonlyArray<Record<string, unknown>>;
      const failedIndex = transactItems.findIndex((txItem) => {
        const put = txItem.Put as { Item: FakeItem; ConditionExpression?: string } | undefined;
        return (
          put?.ConditionExpression === 'attribute_not_exists(idempotencyKey)' &&
          items.has(`${put.Item.pk}#${put.Item.sk}`)
        );
      });
      if (failedIndex !== -1) {
        throw new TransactionCanceledException({
          message: 'conditional check failed',
          $metadata: {},
          CancellationReasons: transactItems.map((_, i) => ({
            Code: i === failedIndex ? 'ConditionalCheckFailed' : 'None',
          })),
        });
      }
      for (const txItem of transactItems) {
        if (txItem.Put) {
          const put = txItem.Put as { Item: FakeItem };
          items.set(`${put.Item.pk}#${put.Item.sk}`, put.Item);
        }
      }
      return Promise.resolve({});
    }
    throw new Error(`fake ddb: unsupported command ${name}`);
  });
  return { send, items };
}

describe('canary handler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.CANARY_DEPT_ID = 'NICHOLS';
    process.env.CANARY_MEMBER_ID = 'canary-device';
    process.env.ALERTING_TABLE_NAME = 'alerting-table';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('starts a new self-test run addressed to the canary member and records a pointer for next time', async () => {
    const { send, items } = createFakeDdb();
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const pointer = items.get('DEPT#NICHOLS#CANARY#STATE');
    expect(pointer).toBeDefined();
    expect(typeof pointer?.pendingTestId).toBe('string');
    const run = [...items.values()].find((item) => item.entityType === 'SELF_TEST_RUN');
    expect(run).toMatchObject({ memberId: 'canary-device', overallResult: 'RUNNING' });
  });

  it('completes a pending run as PASS when the self-test finished within the latency budget, and records a CANARY_RUN (AC1)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { send, items } = createFakeDdb([
      { pk: 'DEPT#NICHOLS#CANARY', sk: 'STATE', pendingTestId: 'canary-1', pendingRunAt: now - 2 },
      {
        pk: 'DEPT#NICHOLS#MEMBER#canary-device',
        sk: 'SELFTEST#canary-1',
        entityType: 'SELF_TEST_RUN',
        overallResult: 'PASS',
        channelResults: { PUSH: { ok: true, ms: 100 } },
        completedAtMs: (now - 1) * 1000,
      },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const canaryRun = [...items.values()].find((item) => item.entityType === 'CANARY_RUN');
    expect(canaryRun).toMatchObject({ result: 'PASS', testId: 'canary-1' });
  });

  it('marks the run FAIL when the self-test never completed (AC2: pages on-call, not silently blinded)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { send, items } = createFakeDdb([
      { pk: 'DEPT#NICHOLS#CANARY', sk: 'STATE', pendingTestId: 'canary-1', pendingRunAt: now - 2 },
    ]);
    const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
    vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

    const { handler } = await import('./handler.js');
    await handler();

    const canaryRun = [...items.values()].find((item) => item.entityType === 'CANARY_RUN');
    expect(canaryRun).toMatchObject({ result: 'FAIL', testId: 'canary-1' });
  });

  it('does not reprocess a stale pointer and duplicate the CANARY_RUN record when the next self-test cooldown fails to acquire (MAJOR #1 regression)', async () => {
    vi.useFakeTimers();
    try {
      const start = Math.floor(Date.now() / 1000);
      const { send, items } = createFakeDdb([
        {
          pk: 'DEPT#NICHOLS#CANARY',
          sk: 'STATE',
          pendingTestId: 'canary-1',
          pendingRunAt: start - 2,
        },
        {
          pk: 'DEPT#NICHOLS#MEMBER#canary-device',
          sk: 'SELFTEST#canary-1',
          entityType: 'SELF_TEST_RUN',
          overallResult: 'PASS',
          channelResults: { PUSH: { ok: true, ms: 100 } },
          completedAtMs: (start - 1) * 1000,
        },
        // A cooldown that is still held (e.g. from a concurrent/retried self-test run) —
        // acquireSelfTestCooldown will fail on startNextRun for both invocations below.
        {
          pk: 'DEPT#NICHOLS#MEMBER#canary-device',
          sk: 'SELFTEST_COOLDOWN',
          entityType: 'SELF_TEST_COOLDOWN',
          expiresAt: start + 60,
        },
      ]);
      const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
      vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);

      const { handler } = await import('./handler.js');
      await handler();

      let canaryRuns = [...items.values()].filter((item) => item.entityType === 'CANARY_RUN');
      expect(canaryRuns).toHaveLength(1);
      expect(canaryRuns[0]).toMatchObject({ result: 'PASS', testId: 'canary-1' });
      // The pointer must be cleared even though startNextRun could not acquire the cooldown —
      // otherwise the next invocation re-reads this same stale pendingTestId.
      expect(items.get('DEPT#NICHOLS#CANARY#STATE')).toBeUndefined();

      // Simulate the next EventBridge tick, still inside the held cooldown window.
      vi.setSystemTime((start + 30) * 1000);
      await handler();

      canaryRuns = [...items.values()].filter((item) => item.entityType === 'CANARY_RUN');
      expect(canaryRuns).toHaveLength(1); // no duplicate FAIL/PASS record, no growing latencyMs
    } finally {
      vi.useRealTimers();
    }
  });
  describe('latency is measured from the self-test run itself, not the next canary tick', () => {
    const TICK_INTERVAL_MS = 2 * 60 * 1000;

    async function runNextTick(seed: readonly FakeItem[], tickAtMs: number) {
      vi.useFakeTimers();
      vi.setSystemTime(tickAtMs);
      const { send, items } = createFakeDdb(seed);
      const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
      vi.mocked(createDynamoClient).mockReturnValue({ send } as unknown as DynamoDBDocumentClient);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const { handler } = await import('./handler.js');
        await handler();
        const canaryRun = [...items.values()].find((item) => item.entityType === 'CANARY_RUN');
        const emittedLatency = logSpy.mock.calls
          .map((call) => {
            try {
              return JSON.parse(call[0] as string) as Record<string, unknown>;
            } catch {
              return {};
            }
          })
          .find((entry) => entry.CanaryLatencyMs !== undefined)?.CanaryLatencyMs;
        return { canaryRun, emittedLatency };
      } finally {
        logSpy.mockRestore();
        vi.useRealTimers();
      }
    }

    function seedFor(armedAtMs: number, run: Record<string, unknown> | undefined): FakeItem[] {
      return [
        {
          pk: 'DEPT#NICHOLS#CANARY',
          sk: 'STATE',
          pendingTestId: 'canary-1',
          pendingRunAt: Math.floor(armedAtMs / 1000),
          pendingRunAtMs: armedAtMs,
        },
        ...(run
          ? [
              {
                pk: 'DEPT#NICHOLS#MEMBER#canary-device',
                sk: 'SELFTEST#canary-1',
                entityType: 'SELF_TEST_RUN',
                channelResults: { PUSH: { ok: true, ms: 100 } },
                ...run,
              },
            ]
          : []),
      ];
    }

    it('records PASS with latency = completedAtMs - armed time even though the tick is 2 minutes later', async () => {
      const armedAtMs = Date.UTC(2026, 8, 26, 12, 0, 0, 250);
      const { canaryRun, emittedLatency } = await runNextTick(
        seedFor(armedAtMs, { overallResult: 'PASS', completedAtMs: armedAtMs + 1_800 }),
        armedAtMs + TICK_INTERVAL_MS,
      );
      expect(canaryRun).toMatchObject({ result: 'PASS', testId: 'canary-1', latencyMs: 1_800 });
      expect(emittedLatency).toBe(1_800);
    });

    it('records FAIL when the run itself completed outside the 5s budget', async () => {
      const armedAtMs = Date.UTC(2026, 8, 26, 12, 0, 0, 0);
      const { canaryRun } = await runNextTick(
        seedFor(armedAtMs, { overallResult: 'PASS', completedAtMs: armedAtMs + 7_000 }),
        armedAtMs + TICK_INTERVAL_MS,
      );
      expect(canaryRun).toMatchObject({ result: 'FAIL', latencyMs: 7_000 });
    });

    it('records FAIL (latency = elapsed so far) when the run never completed', async () => {
      const armedAtMs = Date.UTC(2026, 8, 26, 12, 0, 0, 0);
      const { canaryRun } = await runNextTick(
        seedFor(armedAtMs, { overallResult: 'RUNNING' }),
        armedAtMs + TICK_INTERVAL_MS,
      );
      expect(canaryRun).toMatchObject({ result: 'FAIL', latencyMs: TICK_INTERVAL_MS });
    });

    it('falls back to second-precision pendingRunAt for a pointer written before pendingRunAtMs', async () => {
      const armedAtMs = Date.UTC(2026, 8, 26, 12, 0, 0, 0);
      const [pointer, run] = seedFor(armedAtMs, {
        overallResult: 'PASS',
        completedAtMs: armedAtMs + 900,
      });
      const legacyPointer: FakeItem = { ...pointer! };
      delete legacyPointer.pendingRunAtMs;
      const { canaryRun } = await runNextTick([legacyPointer, run!], armedAtMs + TICK_INTERVAL_MS);
      expect(canaryRun).toMatchObject({ result: 'PASS', latencyMs: 900 });
    });

    it('arms the next pointer with a millisecond start time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.UTC(2026, 8, 26, 12, 0, 0, 431));
      try {
        const { send, items } = createFakeDdb();
        const { createDynamoClient } = await import('../eligibility/dynamoClient.js');
        vi.mocked(createDynamoClient).mockReturnValue({
          send,
        } as unknown as DynamoDBDocumentClient);
        const { handler } = await import('./handler.js');
        await handler();
        expect(items.get('DEPT#NICHOLS#CANARY#STATE')).toMatchObject({
          pendingRunAtMs: Date.UTC(2026, 8, 26, 12, 0, 0, 431),
          pendingRunAt: Math.floor(Date.UTC(2026, 8, 26, 12, 0, 0, 431) / 1000),
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
