import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { putRosterCopyEntryIfNewer } from './dispatchProjection.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-incident';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('putRosterCopyEntryIfNewer', () => {
  it('writes the roster copy under ROSTER#{memberId}', async () => {
    const send = vi.fn().mockResolvedValue({});

    await expect(
      putRosterCopyEntryIfNewer(fakeClient(send), TABLE_NAME, DEPT_ID, 'DISPATCH-1', {
        memberId: 'MBR-0034',
        status: 'RESPONDING',
        ackAt: 1,
      }),
    ).resolves.toBe('updated');

    const [command] = send.mock.calls[0] as [{ input: { Item: Record<string, unknown> } }];
    expect(command.input.Item).toMatchObject({
      pk: 'DEPT#NICHOLS#DISPATCH_COPY#DISPATCH-1',
      sk: 'ROSTER#MBR-0034',
    });
  });

  it('refuses a memberId or dispatchId containing the key delimiter without writing', async () => {
    const send = vi.fn().mockResolvedValue({});
    const entry = { memberId: 'MBR-0034', status: 'RESPONDING', ackAt: 1 };

    await expect(
      putRosterCopyEntryIfNewer(fakeClient(send), TABLE_NAME, DEPT_ID, 'DISPATCH-1', {
        ...entry,
        memberId: 'MBR#X',
      }),
    ).rejects.toThrow(/memberId/);
    await expect(
      putRosterCopyEntryIfNewer(fakeClient(send), TABLE_NAME, DEPT_ID, 'D#1', entry),
    ).rejects.toThrow(/dispatchId/);
    expect(send).not.toHaveBeenCalled();
  });
});
