import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
  type ProblemResponse,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  deriveCertificationStatus,
  listCertificationsForMember,
} from '../certificationRepository.js';
import { emitTrainingMetric, logError, readTrainingConfig } from '../client.js';
import { createDynamoClient } from '../dynamoClient.js';
import { listMemberAttendanceRecords } from '../repository.js';
import { renderTranscriptPdf } from './pdfRenderer.js';
import { buildTranscript, toCsv } from './transcript.js';

const EXPORT_FORMATS = ['json', 'csv', 'pdf'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

function serverErrorProblem(traceId: string): ProblemResponse {
  return {
    statusCode: 500,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred.',
      traceId,
    }),
  };
}

async function getTranscriptInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, [{ field: 'memberId', detail: 'is required' }]);
  }

  const rawFormat = event.queryStringParameters?.format;
  if (rawFormat && !isExportFormat(rawFormat)) {
    return badRequestProblem(traceId, [
      { field: 'format', detail: 'must be one of json, csv, pdf' },
    ]);
  }
  const format: ExportFormat = rawFormat && isExportFormat(rawFormat) ? rawFormat : 'json';

  const deptId = toVerifiedDeptId(principal);
  const now = new Date();
  try {
    const client = createDynamoClient();
    const [certifications, attendance] = await Promise.all([
      listCertificationsForMember(client, process.env, {
        deptId,
        memberId,
        correlationId: traceId,
      }),
      listMemberAttendanceRecords(client, readTrainingConfig(process.env), deptId, memberId),
    ]);

    const transcript = buildTranscript(
      memberId,
      certifications.map((record) => ({
        ...record,
        status: deriveCertificationStatus(record.status, record.expiryDate, now),
      })),
      attendance,
    );

    emitTrainingMetric('TranscriptViewed');

    if (format === 'csv') {
      return {
        statusCode: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': `attachment; filename="transcript-${memberId}.csv"`,
        },
        body: toCsv(transcript),
      };
    }
    if (format === 'pdf') {
      return {
        statusCode: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="transcript-${memberId}.pdf"`,
        },
        body: renderTranscriptPdf(transcript).toString('base64'),
        isBase64Encoded: true,
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(transcript),
    };
  } catch (error) {
    logError('transcript.get.unhandled', error, { correlationId: traceId, memberId });
    emitTrainingMetric('TranscriptExportFailed');
    return serverErrorProblem(traceId);
  }
}

export const handler = withAuthorization(getTranscriptInner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewTranscript',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
