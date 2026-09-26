import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readTrainingDynamoConfig } from './dynamoClient.js';
import { logError } from './logger.js';

export type CertificationStatus = 'CURRENT' | 'EXPIRED' | 'REVOKED';

export class CertNotFoundError extends Error {
  constructor(readonly certId: string) {
    super(`Certification ${certId} not found`);
    this.name = 'CertNotFoundError';
  }
}

export function deriveCertificationStatus(
  stored: CertificationStatus,
  expiryDate: string,
  now: Date,
): CertificationStatus {
  if (stored === 'REVOKED') {
    return 'REVOKED';
  }
  const today = now.toISOString().slice(0, 10);
  return today > expiryDate ? 'EXPIRED' : 'CURRENT';
}

type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

type AuditLogAction = 'CREATE' | 'UPDATE' | 'DELETE';

interface ChangedFieldDiff {
  readonly old: unknown;
  readonly new: unknown;
}

interface AuditLogParams {
  readonly tableName: string;
  readonly deptId: VerifiedDeptId;
  readonly mutatedEntityType: string;
  readonly mutatedEntityId: string;
  readonly action: AuditLogAction;
  readonly actorId: string;
  readonly changedFields: Readonly<Record<string, ChangedFieldDiff>>;
  readonly ts: number;
}

function buildAuditLogPut(params: AuditLogParams): TransactWriteItem {
  const date = new Date(params.ts * 1000).toISOString().slice(0, 10);
  const pk = buildDeptScopedPk(params.deptId, 'AUDIT', date);
  const sk = `${params.ts}#${params.mutatedEntityType}#${params.mutatedEntityId}#${params.actorId}`;
  const gsi3pk = buildDeptScopedPk(
    params.deptId,
    'AUDIT',
    'ENTITY',
    params.mutatedEntityType,
    params.mutatedEntityId,
  );
  return {
    Put: {
      TableName: params.tableName,
      Item: {
        pk,
        sk,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: params.mutatedEntityType,
        mutatedEntityId: params.mutatedEntityId,
        action: params.action,
        actorId: params.actorId,
        changedFields: params.changedFields,
        ts: params.ts,
        gsi3pk,
        gsi3sk: `${params.ts}`,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export interface CertificationRecord {
  readonly certId: string;
  readonly memberId: string;
  readonly certType: string;
  readonly issueDate: string;
  readonly expiryDate: string;
  readonly issuingAuthority: string;
  readonly attachmentS3Key: string | null;
  readonly status: CertificationStatus;
}

export interface CreateCertificationParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly certId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly certType: string;
  readonly issueDate: string;
  readonly expiryDate: string;
  readonly issuingAuthority: string;
  readonly attachmentS3Key: string | null;
  readonly now: Date;
}

function logRepositoryError(
  event: string,
  error: unknown,
  correlationId: string,
  certId?: string,
): void {
  logError({
    event,
    service: 'training',
    reason: error instanceof Error ? error.constructor.name : 'UnknownError',
    message: error instanceof Error ? error.message : undefined,
    correlationId,
    ...(certId ? { certId } : {}),
    ...(error instanceof TransactionCanceledException
      ? { cancellationReasons: error.CancellationReasons?.map((r) => r.Code) }
      : {}),
  });
}

export async function createCertification(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: CreateCertificationParams,
): Promise<CertificationRecord> {
  const { tableName } = readTrainingDynamoConfig(env);
  const certId = params.certId;
  const yearMonth = params.expiryDate.slice(0, 7);

  const certificationItem = {
    pk: buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId),
    sk: `CERT#${certId}`,
    entityType: 'CERTIFICATION',
    certId,
    memberId: params.memberId,
    certType: params.certType,
    issueDate: params.issueDate,
    expiryDate: params.expiryDate,
    issuingAuthority: params.issuingAuthority,
    attachmentS3Key: params.attachmentS3Key,
    status: 'CURRENT',
    gsi1pk: `MEMBER#${params.memberId}`,
    gsi1sk: `CERTIFICATION#${params.expiryDate}`,
    gsi2pk: buildDeptScopedPk(params.deptId, 'DUE', 'CERTIFICATION', yearMonth),
    gsi2sk: `${params.expiryDate}#${certId}`,
  };

  const auditPut = buildAuditLogPut({
    tableName,
    deptId: params.deptId,
    mutatedEntityType: 'CERTIFICATION',
    mutatedEntityId: certId,
    action: 'CREATE',
    actorId: params.actorId,
    changedFields: {
      certType: { old: null, new: params.certType },
      issueDate: { old: null, new: params.issueDate },
      expiryDate: { old: null, new: params.expiryDate },
      issuingAuthority: { old: null, new: params.issuingAuthority },
      attachmentS3Key: { old: null, new: params.attachmentS3Key },
    },
    ts: Math.floor(params.now.getTime() / 1000),
  });

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [{ Put: { TableName: tableName, Item: certificationItem } }, auditPut],
      }),
    );
  } catch (error) {
    logRepositoryError('certification.create.failed', error, params.correlationId, certId);
    throw error;
  }

  return {
    certId,
    memberId: params.memberId,
    certType: params.certType,
    issueDate: params.issueDate,
    expiryDate: params.expiryDate,
    issuingAuthority: params.issuingAuthority,
    attachmentS3Key: params.attachmentS3Key,
    status: 'CURRENT',
  };
}

export interface ListCertificationsParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly correlationId: string;
}

function toCertificationRecord(item: Record<string, unknown>): CertificationRecord {
  return {
    certId: item.certId as string,
    memberId: item.memberId as string,
    certType: item.certType as string,
    issueDate: item.issueDate as string,
    expiryDate: item.expiryDate as string,
    issuingAuthority: item.issuingAuthority as string,
    attachmentS3Key: (item.attachmentS3Key as string | null | undefined) ?? null,
    status: item.status as CertificationStatus,
  };
}

export async function listCertificationsForMember(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: ListCertificationsParams,
): Promise<readonly CertificationRecord[]> {
  const { tableName } = readTrainingDynamoConfig(env);
  try {
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId),
          ':skPrefix': 'CERT#',
        },
      }),
    );
    return (output.Items ?? []).map(toCertificationRecord);
  } catch (error) {
    logRepositoryError('certification.list.failed', error, params.correlationId);
    throw error;
  }
}

export interface QueryCertificationsDueInMonthParams {
  readonly deptId: VerifiedDeptId;
  readonly yearMonth: string;
  readonly correlationId: string;
}

export async function queryCertificationsDueInMonth(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: QueryCertificationsDueInMonthParams,
): Promise<readonly CertificationRecord[]> {
  const { tableName } = readTrainingDynamoConfig(env);
  try {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const output = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI2',
          KeyConditionExpression: 'gsi2pk = :gsi2pk',
          ExpressionAttributeValues: {
            ':gsi2pk': buildDeptScopedPk(params.deptId, 'DUE', 'CERTIFICATION', params.yearMonth),
          },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(output.Items ?? []));
      exclusiveStartKey = output.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items.map(toCertificationRecord);
  } catch (error) {
    logRepositoryError('certification.queryDueInMonth.failed', error, params.correlationId);
    throw error;
  }
}

export interface ExpireCertificationParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly certId: string;
  readonly correlationId: string;
  readonly now: Date;
}

export async function expireCertification(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: ExpireCertificationParams,
): Promise<boolean> {
  const { tableName } = readTrainingDynamoConfig(env);
  const pk = buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId);
  const sk = `CERT#${params.certId}`;
  const ts = Math.floor(params.now.getTime() / 1000);
  const auditPut = buildAuditLogPut({
    tableName,
    deptId: params.deptId,
    mutatedEntityType: 'CERTIFICATION',
    mutatedEntityId: params.certId,
    action: 'UPDATE',
    actorId: 'system:expiry-scan',
    changedFields: { status: { old: 'CURRENT', new: 'EXPIRED' } },
    ts,
  });

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              // `status` is a DynamoDB reserved word — a bare reference is a
              // ValidationException, so it must go through an attribute-name alias.
              UpdateExpression: 'SET #status = :expired',
              ConditionExpression: '#status = :current',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':expired': 'EXPIRED', ':current': 'CURRENT' },
            },
          },
          auditPut,
        ],
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
    ) {
      return false;
    }
    logRepositoryError('certification.expire.failed', error, params.correlationId, params.certId);
    throw error;
  }
}

export interface RevokeCertificationParams {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly certId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly now: Date;
}

export async function revokeCertification(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  params: RevokeCertificationParams,
): Promise<CertificationRecord> {
  const { tableName } = readTrainingDynamoConfig(env);
  const pk = buildDeptScopedPk(params.deptId, 'MEMBER', params.memberId);
  const sk = `CERT#${params.certId}`;

  let existing: Record<string, unknown>;
  try {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    if (!result.Item) {
      throw new CertNotFoundError(params.certId);
    }
    existing = result.Item;
  } catch (error) {
    if (error instanceof CertNotFoundError) {
      throw error;
    }
    logRepositoryError(
      'certification.revoke.lookupFailed',
      error,
      params.correlationId,
      params.certId,
    );
    throw error;
  }

  const record = toCertificationRecord(existing);
  if (record.status === 'REVOKED') {
    return record;
  }

  const auditPut = buildAuditLogPut({
    tableName,
    deptId: params.deptId,
    mutatedEntityType: 'CERTIFICATION',
    mutatedEntityId: params.certId,
    action: 'UPDATE',
    actorId: params.actorId,
    changedFields: { status: { old: record.status, new: 'REVOKED' } },
    ts: Math.floor(params.now.getTime() / 1000),
  });

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              // `status` is a DynamoDB reserved word — alias it (see expireCertification).
              UpdateExpression: 'SET #status = :revoked',
              ConditionExpression: '#status = :expectedStatus',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':revoked': 'REVOKED',
                ':expectedStatus': record.status,
              },
            },
          },
          auditPut,
        ],
      }),
    );
  } catch (error) {
    logRepositoryError(
      'certification.revoke.writeFailed',
      error,
      params.correlationId,
      params.certId,
    );
    throw error;
  }

  return { ...record, status: 'REVOKED' };
}
