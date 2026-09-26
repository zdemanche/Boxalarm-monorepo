import { assertNoDelimiter, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ChannelName = 'push' | 'sms' | 'voice';

export interface ChannelEnvelopePayload {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly toneSequence: number;
  readonly incidentType: string;
  readonly address: string;
  /** Self-test/canary dispatch — fan-out stamps it; anything but `true` is a real page. */
  readonly isTest: boolean;
}

export type ChannelTier = 'primary' | 'escalation';

/**
 * The dispatch-record fields a page's text is built from. Every producer sources these from
 * the DISPATCH_ALERT METADATA item (stream image or GetItem), never from a caller.
 */
export interface DispatchAlertText {
  readonly incidentType: string | undefined;
  readonly address: string | undefined;
  readonly isTest: boolean;
  readonly crossStreets?: string | undefined;
  readonly narrative?: string | undefined;
  readonly mapLink?: string | undefined;
  readonly sourceSystem?: string | undefined;
}

// Ingress rejects a dispatch without incidentType/address, so these only fire on a corrupt or
// legacy record. Paging with placeholder text beats a parser rejection that DLQs the page (or,
// on the fan-out stream, wedges the shard behind a record that can never succeed).
export const INCIDENT_TYPE_FALLBACK = 'DISPATCH';
export const ADDRESS_FALLBACK = 'ADDRESS UNAVAILABLE - CHECK CAD/RADIO';

function textOrFallback(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback;
}

export function readDispatchAlertText(item: Record<string, unknown>): DispatchAlertText {
  const optional = (key: string): string | undefined =>
    typeof item[key] === 'string' ? item[key] : undefined;
  return {
    incidentType: optional('incidentType'),
    address: optional('address'),
    isTest: item.isTest === true,
    crossStreets: optional('crossStreets'),
    narrative: optional('narrative'),
    mapLink: optional('mapLink'),
    sourceSystem: optional('sourceSystem'),
  };
}

/**
 * The producer half of the channel-worker contract. Every publisher to the alerting topic
 * builds its payload here, so the compiler — not a hand-rolled object literal per call site —
 * guarantees each page carries every field parseChannelEnvelope requires.
 */
export interface ChannelPagePayload extends ChannelEnvelopePayload {
  readonly alertKind: 'dispatch';
  readonly channelTier: ChannelTier;
  readonly isTest: boolean;
  readonly crossStreets?: string | undefined;
  readonly narrative?: string | undefined;
  readonly mapLink?: string | undefined;
  readonly sourceSystem?: string | undefined;
  readonly reason?: string | undefined;
}

export interface ChannelPageInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: ChannelName;
  readonly channelTier: ChannelTier;
  readonly toneSequence: number;
  readonly dispatch: DispatchAlertText;
  readonly reason?: string;
}

export function buildChannelPagePayload(input: ChannelPageInput): ChannelPagePayload {
  const { dispatch } = input;
  return {
    alertKind: 'dispatch',
    deptId: input.deptId,
    dispatchId: input.dispatchId,
    memberId: input.memberId,
    channel: input.channel,
    channelTier: input.channelTier,
    toneSequence: input.toneSequence,
    incidentType: textOrFallback(dispatch.incidentType, INCIDENT_TYPE_FALLBACK),
    address: textOrFallback(dispatch.address, ADDRESS_FALLBACK),
    isTest: dispatch.isTest,
    crossStreets: dispatch.crossStreets,
    narrative: dispatch.narrative,
    mapLink: dispatch.mapLink,
    sourceSystem: dispatch.sourceSystem,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export function parseChannelEnvelope(
  body: string,
  expectedChannel: ChannelName,
): ChannelEnvelopePayload {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  const deptId = payload?.deptId;
  const dispatchId = payload?.dispatchId;
  const memberId = payload?.memberId;
  const channel = payload?.channel;
  const toneSequence = payload?.toneSequence;
  const incidentType = payload?.incidentType;
  const address = payload?.address;
  if (
    typeof deptId !== 'string' ||
    typeof dispatchId !== 'string' ||
    typeof memberId !== 'string' ||
    (channel !== 'push' && channel !== 'sms' && channel !== 'voice') ||
    typeof toneSequence !== 'number' ||
    !Number.isFinite(toneSequence) ||
    typeof incidentType !== 'string' ||
    typeof address !== 'string'
  ) {
    throw new Error('alerting channel envelope failed shape validation');
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `channel envelope routed to the ${expectedChannel} worker carries channel=${channel}`,
    );
  }
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(memberId, 'memberId');
  const isTest = payload?.isTest === true;
  return { deptId, dispatchId, memberId, channel, toneSequence, incidentType, address, isTest };
}

/**
 * Officer mutual-aid prompt (F1.13): rides the push queue with `alertKind: 'mutual_aid_prompt'`
 * and deliberately no toneSequence — the push worker branches on alertKind and guards it in its
 * own namespace rather than a per-tone RECEIPT# key an officer toned at tone 3 already holds.
 */
export interface MutualAidPromptPayload {
  readonly alertKind: 'mutual_aid_prompt';
  readonly deptId: string;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: 'push';
  readonly incidentType: string;
  readonly address: string;
  /** Self-test/canary prompt — the push worker sends it with the sandbox credentials. */
  readonly isTest: boolean;
}

export type MutualAidPromptPagePayload = MutualAidPromptPayload;

export interface MutualAidPromptInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly dispatch: DispatchAlertText;
}

export function buildMutualAidPromptPayload(
  input: MutualAidPromptInput,
): MutualAidPromptPagePayload {
  return {
    alertKind: 'mutual_aid_prompt',
    deptId: input.deptId,
    dispatchId: input.dispatchId,
    memberId: input.memberId,
    channel: 'push',
    incidentType: textOrFallback(input.dispatch.incidentType, INCIDENT_TYPE_FALLBACK),
    address: textOrFallback(input.dispatch.address, ADDRESS_FALLBACK),
    isTest: input.dispatch.isTest,
  };
}

/**
 * Returns undefined when the body is not a mutual-aid prompt (the caller then parses it as a
 * dispatch page); throws when it claims to be one but is malformed or misrouted.
 */
export function parseMutualAidPromptEnvelope(
  body: string,
  expectedChannel: ChannelName,
): MutualAidPromptPayload | undefined {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (payload?.alertKind !== 'mutual_aid_prompt') {
    return undefined;
  }
  const { deptId, dispatchId, memberId, channel, incidentType, address } = payload;
  if (
    typeof deptId !== 'string' ||
    typeof dispatchId !== 'string' ||
    typeof memberId !== 'string' ||
    channel !== 'push' ||
    typeof incidentType !== 'string' ||
    typeof address !== 'string'
  ) {
    throw new Error('mutual-aid prompt envelope failed shape validation');
  }
  if (channel !== expectedChannel) {
    throw new Error(
      `mutual-aid prompt routed to the ${expectedChannel} worker carries channel=${channel}`,
    );
  }
  assertNoDelimiter(dispatchId, 'dispatchId');
  assertNoDelimiter(memberId, 'memberId');
  return {
    alertKind: 'mutual_aid_prompt',
    deptId,
    dispatchId,
    memberId,
    channel,
    incidentType,
    address,
    isTest: payload.isTest === true,
  };
}

export function noTargetReason(channel: ChannelName): string {
  return `${channel}: no target registered`;
}

export interface ContactChannelSnapshot {
  readonly channel: string;
  readonly valid?: boolean;
  readonly token?: string;
  readonly phoneNumber?: string;
}

export type ResolveChannelTargetResult =
  | { readonly skipped: true; readonly reason: string }
  | { readonly skipped: false; readonly target: string };

const CONTACT_CHANNEL_KEY: Record<ChannelName, string> = {
  push: 'PUSH',
  sms: 'SMS',
  voice: 'VOICE',
};

export function resolveChannelTarget(
  channel: ChannelName,
  contactChannels: readonly ContactChannelSnapshot[] | undefined,
): ResolveChannelTargetResult {
  const entry = (contactChannels ?? []).find(
    (candidate) => candidate.channel === CONTACT_CHANNEL_KEY[channel] && candidate.valid !== false,
  );
  const target = channel === 'push' ? entry?.token : entry?.phoneNumber;
  if (!target) {
    return { skipped: true, reason: noTargetReason(channel) };
  }
  return { skipped: false, target };
}
