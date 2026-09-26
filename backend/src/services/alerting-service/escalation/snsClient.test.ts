import { describe, expect, it, vi } from 'vitest';
import type { SNSClient } from '@aws-sdk/client-sns';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildEscalationDeduplicationId, publishEscalationTriggered } from './snsClient.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const DISPATCH = { incidentType: 'STRUCTURE_FIRE', address: '1 Main St', isTest: false };

describe('buildEscalationDeduplicationId', () => {
  it('is deterministic for the same dispatchId/toneSequence/memberId', () => {
    const first = buildEscalationDeduplicationId('dispatch-1', 1, 'mbr-1');
    const second = buildEscalationDeduplicationId('dispatch-1', 1, 'mbr-1');
    expect(first).toBe(second);
  });

  it('differs when toneSequence differs (never keyed on channelTier alone)', () => {
    const tone1 = buildEscalationDeduplicationId('dispatch-1', 1, 'mbr-1');
    const tone2 = buildEscalationDeduplicationId('dispatch-1', 2, 'mbr-1');
    expect(tone1).not.toBe(tone2);
  });
});

describe('publishEscalationTriggered', () => {
  it('publishes the escalation envelope with channel=voice, channelTier=escalation, and the tone-scoped dedup id', async () => {
    const send = vi.fn().mockResolvedValue({});

    await publishEscalationTriggered(
      { send } as unknown as SNSClient,
      'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
      {
        deptId: DEPT_ID,
        dispatchId: 'dispatch-1',
        memberId: 'mbr-1',
        toneSequence: 1,
        dispatch: DISPATCH,
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input.MessageGroupId).toBe('dispatch-1');
    expect(command.input.MessageDeduplicationId).toBe(
      buildEscalationDeduplicationId('dispatch-1', 1, 'mbr-1'),
    );
    const attrs = command.input.MessageAttributes as Record<string, { StringValue: string }>;
    expect(attrs.channel?.StringValue).toBe('voice');
    expect(attrs.channelTier?.StringValue).toBe('escalation');
    const envelope = JSON.parse(command.input.Message as string) as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(envelope.eventType).toBe('alerting.escalation.triggered');
    expect(envelope.payload).toMatchObject({
      deptId: 'NICHOLS',
      channel: 'voice',
      channelTier: 'escalation',
      toneSequence: 1,
      incidentType: 'STRUCTURE_FIRE',
      address: '1 Main St',
      isTest: false,
    });
  });

  it('rethrows on a publish failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('sns unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      publishEscalationTriggered(
        { send } as unknown as SNSClient,
        'arn:aws:sns:us-east-1:1:alerting-topic.fifo',
        {
          deptId: DEPT_ID,
          dispatchId: 'dispatch-1',
          memberId: 'mbr-1',
          toneSequence: 1,
          dispatch: DISPATCH,
        },
      ),
    ).rejects.toThrow('sns unavailable');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('sns unavailable'));
  });
});
