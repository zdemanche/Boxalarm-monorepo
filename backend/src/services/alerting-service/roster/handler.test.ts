import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: { pathParameters?: { dispatchId?: string } }) => string;
}

const capturedOptions: CapturedOptions[] = vi.hoisted(() => []);

vi.mock('@boxalarm/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boxalarm/authz')>();
  return {
    ...actual,
    withAuthorization: (
      inner: (event: unknown, principal: unknown) => Promise<unknown>,
      options: CapturedOptions,
    ) => {
      capturedOptions.push(options);
      return async (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
        inner(event, event.requestContext.authorizer.lambda);
    },
  };
});

vi.mock('../eligibility/dynamoClient.js', () => ({
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  createDynamoClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  queryRoster: vi.fn(),
}));

import { queryRoster } from './repository.js';
import { handler } from './handler.js';

const principal = { sub: 'MBR-0012', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    pathParameters: { dispatchId: 'NICHOLS-4471-1798000000' },
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('roster handler', () => {
  it('wires the ViewRoster action against the Dispatch resource', () => {
    expect(capturedOptions[capturedOptions.length - 1]).toMatchObject({
      actionType: 'Boxalarm::Action',
      actionId: 'ViewRoster',
      resourceType: 'Boxalarm::Dispatch',
    });
  });

  it('resolves the Cedar resourceId to the dispatchId path parameter', () => {
    const options = capturedOptions[capturedOptions.length - 1];
    expect(options?.resourceId(buildEvent())).toBe('NICHOLS-4471-1798000000');
    expect(options?.resourceId({})).toBe('');
  });

  it('returns 404 when dispatchId is missing from the path', async () => {
    const result = (await handler(buildEvent({ pathParameters: {} }))) as { statusCode: number };
    expect(result.statusCode).toBe(404);
    expect(queryRoster).not.toHaveBeenCalled();
  });

  it('returns 200 with an empty members array when nobody has responded yet', async () => {
    vi.mocked(queryRoster).mockResolvedValue([]);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      dispatchId: 'NICHOLS-4471-1798000000',
      members: [],
    });
  });

  it('maps roster rows to the response, including quals, apparatus, and DIRECT_TO_SCENE (AC2, AC4, AC5)', async () => {
    vi.mocked(queryRoster).mockResolvedValue([
      {
        pk: 'DEPT#NICHOLS#DISPATCH#NICHOLS-4471-1798000000',
        sk: 'ROSTER#MBR-0012',
        entityType: 'DISPATCH_ROSTER_ENTRY',
        memberId: 'MBR-0012',
        quals: ['INTERIOR'],
        ackStatus: 'DIRECT_TO_SCENE',
        ackAt: 1798000300,
        eta: 3,
        assignedApparatusId: null,
        lastAnsweredTone: 1,
      },
    ]);
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body) as { members: unknown[] };
    expect(parsed.members).toEqual([
      {
        memberId: 'MBR-0012',
        ackStatus: 'DIRECT_TO_SCENE',
        ackAt: 1798000300,
        eta: 3,
        assignedApparatusId: null,
        quals: ['INTERIOR'],
        lastAnsweredTone: 1,
      },
    ]);
  });

  it('returns 503 (fail-closed) and does not swallow the error, when DynamoDB is unavailable at read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(queryRoster).mockRejectedValue(new Error('table unavailable'));
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalled();
  });
});
