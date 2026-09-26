import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';

const loggedErrors = vi.fn();
vi.mock('./logger.js', () => ({ logError: loggedErrors }));

const {
  CertNotFoundError,
  createCertification,
  deriveCertificationStatus,
  expireCertification,
  listCertificationsForMember,
  queryCertificationsDueInMonth,
  revokeCertification,
} = await import('./certificationRepository.js');

const deptId = toVerifiedDeptId({ deptId: 'NICHOLS' });
const env = { TRAINING_DYNAMO_TABLE_NAME: 'platform-service' };

beforeEach(() => {
  loggedErrors.mockClear();
});

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('deriveCertificationStatus', () => {
  it('returns REVOKED unconditionally when the stored status is REVOKED, even before expiry', () => {
    expect(
      deriveCertificationStatus('REVOKED', '2099-01-01', new Date('2026-01-01T00:00:00Z')),
    ).toBe('REVOKED');
  });

  it('returns CURRENT for a stored CURRENT record on or before its expiryDate', () => {
    expect(
      deriveCertificationStatus('CURRENT', '2026-09-14', new Date('2026-09-14T12:00:00Z')),
    ).toBe('CURRENT');
  });

  it('derives EXPIRED at read time for a stored CURRENT record past its expiryDate', () => {
    expect(
      deriveCertificationStatus('CURRENT', '2026-01-01', new Date('2026-09-14T12:00:00Z')),
    ).toBe('EXPIRED');
  });
});

describe('createCertification', () => {
  it('writes the cert Put and the audit Put in one TransactWriteItems call (AC1, AC4, core-harm)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const record = await createCertification(client, env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      actorId: 'MBR-0034',
      correlationId: 'trace-1',
      certType: 'FF1',
      issueDate: '2024-01-10',
      expiryDate: '2027-01-10',
      issuingAuthority: 'CT DESPP',
      attachmentS3Key: null,
      now: new Date('2026-09-14T12:00:00Z'),
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const items = command.input.TransactItems ?? [];
    expect(items).toHaveLength(2);

    const certPut = items[0]?.Put?.Item as Record<string, unknown>;
    expect(certPut.entityType).toBe('CERTIFICATION');
    expect(certPut.pk).toBe('DEPT#NICHOLS#MEMBER#MBR-0034');
    expect(certPut.sk).toBe('CERT#CERT-0091');
    expect(certPut.status).toBe('CURRENT');

    const auditPut = items[1]?.Put?.Item as Record<string, unknown>;
    expect(auditPut.entityType).toBe('AUDIT_LOG_ENTRY');
    expect(auditPut.action).toBe('CREATE');
    expect(auditPut.mutatedEntityId).toBe('CERT-0091');
    expect(auditPut.pk).toBe('DEPT#NICHOLS#AUDIT#2026-09-14');
    expect(auditPut.gsi3pk).toBe('DEPT#NICHOLS#AUDIT#ENTITY#CERTIFICATION#CERT-0091');
    expect(auditPut.ts).toBe(1789387200);
    expect(auditPut.sk).toBe('1789387200#CERTIFICATION#CERT-0091#MBR-0034');
    expect(auditPut.gsi3sk).toBe('1789387200');
    expect(auditPut.changedFields).toEqual({
      certType: { old: null, new: 'FF1' },
      issueDate: { old: null, new: '2024-01-10' },
      expiryDate: { old: null, new: '2027-01-10' },
      issuingAuthority: { old: null, new: 'CT DESPP' },
      attachmentS3Key: { old: null, new: null },
    });

    expect(record).toEqual({
      certId: 'CERT-0091',
      memberId: 'MBR-0034',
      certType: 'FF1',
      issueDate: '2024-01-10',
      expiryDate: '2027-01-10',
      issuingAuthority: 'CT DESPP',
      attachmentS3Key: null,
      status: 'CURRENT',
    });
  });

  it('logs the original error including CancellationReasons and rethrows — no partial write', async () => {
    const cancellation = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    const send = vi.fn().mockRejectedValue(cancellation);
    const client = fakeClient(send);

    await expect(
      createCertification(client, env, {
        deptId,
        memberId: 'MBR-0034',
        certId: 'CERT-0091',
        actorId: 'MBR-0034',
        correlationId: 'trace-2',
        certType: 'FF1',
        issueDate: '2024-01-10',
        expiryDate: '2027-01-10',
        issuingAuthority: 'CT DESPP',
        attachmentS3Key: null,
        now: new Date('2026-09-14T12:00:00Z'),
      }),
    ).rejects.toBe(cancellation);

    expect(loggedErrors).toHaveBeenCalledTimes(1);
    const logged = loggedErrors.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('certification.create.failed');
    expect(logged.correlationId).toBe('trace-2');
    expect(logged.certId).toBe('CERT-0091');
    expect(logged.cancellationReasons).toEqual(['None', 'ConditionalCheckFailed']);
  });
});

describe('listCertificationsForMember', () => {
  it('issues a Query with a key condition on pk and a begins_with sk prefix, never a Scan (dynamodb-access-patterns)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          certId: 'CERT-0091',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
      ],
    });
    const client = fakeClient(send);

    const records = await listCertificationsForMember(client, env, {
      deptId,
      memberId: 'MBR-0034',
      correlationId: 'trace-3',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.KeyConditionExpression).toContain('begins_with');
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':pk': 'DEPT#NICHOLS#MEMBER#MBR-0034',
      ':skPrefix': 'CERT#',
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.certId).toBe('CERT-0091');
  });

  it('returns an empty array when the member has zero certifications', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const records = await listCertificationsForMember(client, env, {
      deptId,
      memberId: 'MBR-0099',
      correlationId: 'trace-4',
    });

    expect(records).toEqual([]);
  });

  it('logs the original error and rethrows on a dependency failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);

    await expect(
      listCertificationsForMember(client, env, {
        deptId,
        memberId: 'MBR-0034',
        correlationId: 'trace-5',
      }),
    ).rejects.toBe(failure);

    const logged = loggedErrors.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('certification.list.failed');
    expect(logged.correlationId).toBe('trace-5');
  });
});

describe('queryCertificationsDueInMonth', () => {
  it('queries gsi2 on the dept-scoped DUE#CERTIFICATION#{yearMonth} partition (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          certId: 'CERT-0091',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2026-09-20',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
      ],
    });
    const client = fakeClient(send);

    const records = await queryCertificationsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-09',
      correlationId: 'trace-6',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.IndexName).toBe('GSI2');
    expect(command.input.ExpressionAttributeValues).toEqual({
      ':gsi2pk': 'DEPT#NICHOLS#DUE#CERTIFICATION#2026-09',
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.certId).toBe('CERT-0091');
  });

  it('returns an empty array when nothing is due in that month partition', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const records = await queryCertificationsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-10',
      correlationId: 'trace-7',
    });

    expect(records).toEqual([]);
  });

  it('logs the original error and rethrows on a dependency failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);

    await expect(
      queryCertificationsDueInMonth(client, env, {
        deptId,
        yearMonth: '2026-09',
        correlationId: 'trace-8',
      }),
    ).rejects.toBe(failure);

    const logged = loggedErrors.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('certification.queryDueInMonth.failed');
    expect(logged.correlationId).toBe('trace-8');
  });

  it('follows LastEvaluatedKey across pages and accumulates all items past the 1MB response cap', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ certId: 'CERT-A', memberId: 'MBR-A' }],
        LastEvaluatedKey: { pk: 'p', sk: 's1' },
      })
      .mockResolvedValueOnce({
        Items: [{ certId: 'CERT-B', memberId: 'MBR-B' }],
      });
    const client = fakeClient(send);

    const records = await queryCertificationsDueInMonth(client, env, {
      deptId,
      yearMonth: '2026-09',
      correlationId: 'trace-9',
    });

    expect(send).toHaveBeenCalledTimes(2);
    const secondCommand = send.mock.calls[1]?.[0] as QueryCommand;
    expect(secondCommand.input.ExclusiveStartKey).toEqual({ pk: 'p', sk: 's1' });
    expect(records.map((r) => r.certId)).toEqual(['CERT-A', 'CERT-B']);
  });
});

describe('expireCertification', () => {
  it('conditionally flips a CURRENT cert to EXPIRED and writes an audit Put in one transaction (AC1)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = fakeClient(send);

    const flipped = await expireCertification(client, env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      correlationId: 'trace-expire-1',
      now: new Date('2026-09-14T12:00:00Z'),
    });

    expect(flipped).toBe(true);
    const command = send.mock.calls[0]?.[0] as TransactWriteCommand;
    const items = command.input.TransactItems ?? [];
    const update = items[0]?.Update as {
      Key: Record<string, string>;
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(update.Key).toEqual({ pk: 'DEPT#NICHOLS#MEMBER#MBR-0034', sk: 'CERT#CERT-0091' });
    // `status` is a DynamoDB reserved word; a bare reference is rejected at runtime.
    expect(update.UpdateExpression).toBe('SET #status = :expired');
    expect(update.ConditionExpression).toBe('#status = :current');
    expect(update.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(update.ExpressionAttributeValues[':expired']).toBe('EXPIRED');
    const auditPut = items[1]?.Put?.Item as Record<string, unknown>;
    expect(auditPut.action).toBe('UPDATE');
    expect(auditPut.changedFields).toEqual({ status: { old: 'CURRENT', new: 'EXPIRED' } });
  });

  it('returns false without throwing when the conditional check fails (already-flipped re-run)', async () => {
    const cancellation = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi.fn().mockRejectedValue(cancellation);
    const client = fakeClient(send);

    const flipped = await expireCertification(client, env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      correlationId: 'trace-expire-2',
      now: new Date('2026-09-14T12:00:00Z'),
    });

    expect(flipped).toBe(false);
  });

  it('logs the original error and rethrows on an unexpected dependency failure', async () => {
    const failure = new Error('DynamoDB unavailable');
    const send = vi.fn().mockRejectedValue(failure);
    const client = fakeClient(send);

    await expect(
      expireCertification(client, env, {
        deptId,
        memberId: 'MBR-0034',
        certId: 'CERT-0091',
        correlationId: 'trace-expire-3',
        now: new Date('2026-09-14T12:00:00Z'),
      }),
    ).rejects.toBe(failure);

    const logged = loggedErrors.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('certification.expire.failed');
  });
});

describe('revokeCertification', () => {
  it('flips a CURRENT cert to REVOKED and writes an audit Put in one transaction (AC5)', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          certId: 'CERT-0091',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
      })
      .mockResolvedValueOnce({});
    const client = fakeClient(send);

    const record = await revokeCertification(client, env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      actorId: 'OFFICER-1',
      correlationId: 'trace-revoke-1',
      now: new Date('2026-09-14T12:00:00Z'),
    });

    expect(record.status).toBe('REVOKED');
    const command = send.mock.calls[1]?.[0] as TransactWriteCommand;
    const items = command.input.TransactItems ?? [];
    const auditPut = items[1]?.Put?.Item as Record<string, unknown>;
    expect(auditPut.actorId).toBe('OFFICER-1');
    expect(auditPut.changedFields).toEqual({ status: { old: 'CURRENT', new: 'REVOKED' } });
    const update = items[0]?.Update as {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
    };
    expect(update.UpdateExpression).toBe('SET #status = :revoked');
    expect(update.ConditionExpression).toBe('#status = :expectedStatus');
    expect(update.ExpressionAttributeNames).toEqual({ '#status': 'status' });
  });

  it('is idempotent when the cert is already REVOKED — no transaction write', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: {
        certId: 'CERT-0091',
        memberId: 'MBR-0034',
        certType: 'FF1',
        issueDate: '2024-01-10',
        expiryDate: '2027-01-10',
        issuingAuthority: 'CT DESPP',
        attachmentS3Key: null,
        status: 'REVOKED',
      },
    });
    const client = fakeClient(send);

    const record = await revokeCertification(client, env, {
      deptId,
      memberId: 'MBR-0034',
      certId: 'CERT-0091',
      actorId: 'OFFICER-1',
      correlationId: 'trace-revoke-2',
      now: new Date('2026-09-14T12:00:00Z'),
    });

    expect(record.status).toBe('REVOKED');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('guards the write on the status just read and rethrows on a concurrent status change (AC5, cross-path seam)', async () => {
    const cancellation = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: {
          certId: 'CERT-0091',
          memberId: 'MBR-0034',
          certType: 'FF1',
          issueDate: '2024-01-10',
          expiryDate: '2027-01-10',
          issuingAuthority: 'CT DESPP',
          attachmentS3Key: null,
          status: 'CURRENT',
        },
      })
      .mockRejectedValueOnce(cancellation);
    const client = fakeClient(send);

    await expect(
      revokeCertification(client, env, {
        deptId,
        memberId: 'MBR-0034',
        certId: 'CERT-0091',
        actorId: 'OFFICER-1',
        correlationId: 'trace-12',
        now: new Date('2026-09-14T12:00:00Z'),
      }),
    ).rejects.toBe(cancellation);

    const command = send.mock.calls[1]?.[0] as TransactWriteCommand;
    const items = command.input.TransactItems ?? [];
    const update = items[0]?.Update as { ExpressionAttributeValues: Record<string, unknown> };
    expect(update.ExpressionAttributeValues[':expectedStatus']).toBe('CURRENT');
  });

  it('throws CertNotFoundError when the cert does not exist', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    const client = fakeClient(send);

    await expect(
      revokeCertification(client, env, {
        deptId,
        memberId: 'MBR-0034',
        certId: 'CERT-MISSING',
        actorId: 'OFFICER-1',
        correlationId: 'trace-revoke-3',
        now: new Date('2026-09-14T12:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(CertNotFoundError);
  });
});
