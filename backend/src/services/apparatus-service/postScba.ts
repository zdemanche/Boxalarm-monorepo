import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { createApparatusRepository } from './apparatusRepository.js';
import {
  buildScbaDueItems,
  buildScbaMetadataItem,
  buildScbaTestItem,
  parseScbaMetadataItem,
  type ScbaRecordInput,
} from './scbaRecord.js';
import { apparatusNotFoundProblem, validationProblem } from './problemDetails.js';
import type { ValidationFieldError } from './problemDetails.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_NAMESPACE = 'Boxalarm/ApparatusService';

interface PostScbaDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

function emitScbaMetric(outcome: 'Created' | 'CreateFailed'): void {
  emitOutcomeMetric(METRIC_NAMESPACE, `Scba${outcome}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateFields(
  body: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: ScbaRecordInput }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];

  if (!isNonEmptyString(body.scbaUnitId)) {
    errors.push({ field: 'scbaUnitId', message: 'is required and must be a non-empty string' });
  } else if (body.scbaUnitId.includes('#')) {
    errors.push({ field: 'scbaUnitId', message: 'must not contain the "#" delimiter' });
  }
  if (!isNonEmptyString(body.cylinderId)) {
    errors.push({ field: 'cylinderId', message: 'is required and must be a non-empty string' });
  }
  if (!isNonEmptyString(body.flowTestDate) || !ISO_DATE.test(body.flowTestDate)) {
    errors.push({
      field: 'flowTestDate',
      message: 'is required and must be an ISO date (YYYY-MM-DD)',
    });
  }
  if (!isNonEmptyString(body.hydroTestDate) || !ISO_DATE.test(body.hydroTestDate)) {
    errors.push({
      field: 'hydroTestDate',
      message: 'is required and must be an ISO date (YYYY-MM-DD)',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      scbaUnitId: body.scbaUnitId as string,
      cylinderId: body.cylinderId as string,
      flowTestDate: body.flowTestDate as string,
      hydroTestDate: body.hydroTestDate as string,
    },
  };
}

async function postScba(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: PostScbaDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return apparatusNotFoundProblem(traceId);
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'scba.validation_failed',
        reason: 'MalformedJson',
        correlationId: traceId,
        deptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }

  const validation = validateFields(rawBody);
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }

  const apparatusRepository = createApparatusRepository(deps.client, deps.tableName);
  const existingApparatus = await apparatusRepository.getApparatusByUnitId(deptId, unitId);
  if (!existingApparatus) {
    return apparatusNotFoundProblem(traceId);
  }
  // The path segment is the display unitId (architecture: POST /{unitId}/scba). The SCBA and due
  // items carry the resolved apparatusId, like postTestRecord does, so ScbaDueEntry.apparatusId
  // really is an apparatusId and matches the apparatus record the web detail page loads.
  const { apparatusId } = existingApparatus;

  const metadataItem = buildScbaMetadataItem(deptId, apparatusId, validation.value);
  const testItem = buildScbaTestItem(deptId, apparatusId, validation.value);
  const [flowDueItem, hydroDueItem] = buildScbaDueItems(deptId, apparatusId, validation.value);

  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: deps.tableName, Item: metadataItem } },
          { Put: { TableName: deps.tableName, Item: testItem } },
          { Put: { TableName: deps.tableName, Item: flowDueItem } },
          { Put: { TableName: deps.tableName, Item: hydroDueItem } },
        ],
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'scba.put_failed',
        correlationId: traceId,
        deptId,
        apparatusId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitScbaMetric('CreateFailed');
    throw error;
  }
  emitScbaMetric('Created');

  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parseScbaMetadataItem(metadataItem, deptId)),
  };
}

interface PostScbaOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: PostScbaOverrides): PostScbaDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
  };
}

export function createPostScbaHandler(
  overrides: PostScbaOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => postScba(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'LogScbaRecord',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createPostScbaHandler();
