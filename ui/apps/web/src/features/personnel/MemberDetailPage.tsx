import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { canManageTraining } from '../../auth/roles';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Badge } from '../../components/ui/Chip';
import { ConfirmDialog } from '../../components/ui/Dialog';
import { PageHeader } from '../../components/ui/PageHeader';
import { revokeMemberSessions } from '../platform/api';
import { CertificationsPanel } from '../training/CertificationsPanel';
import { TranscriptPanel } from '../training/TranscriptPanel';
import { issueMemberPpe, listMemberPpe } from '../inventory/api';
import type { IssuePpeInput } from '../inventory/types';
import {
  getMember,
  getMemberLosap,
  getQuals,
  listOwnAttendance,
  putQual,
  recordAttendance,
  updateMemberStatus,
} from './api';
import type { AttendanceActivityType, MemberStatus } from './types';

const STATUSES: MemberStatus[] = ['PROBATIONARY', 'ACTIVE', 'LOA', 'RETIRED'];
const ACTIVITY_TYPES: AttendanceActivityType[] = [
  'CALL',
  'DRILL',
  'MEETING',
  'WORK_DETAIL',
  'STANDBY',
];
const today = () => new Date().toISOString().slice(0, 10);
const emptyPpeForm: IssuePpeInput = { itemType: '', size: '', issueDate: today() };

function QualsSection({ memberId, canEdit }: { memberId: string; canEdit: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [qualCode, setQualCode] = useState('');

  const qualsQuery = useQuery({
    queryKey: ['personnel', 'members', memberId, 'quals'],
    queryFn: () => getQuals(auth, memberId),
  });

  const addQual = useMutation({
    mutationFn: () => putQual(auth, memberId, qualCode, null),
    onSuccess: async () => {
      setQualCode('');
      await queryClient.invalidateQueries({
        queryKey: ['personnel', 'members', memberId, 'quals'],
      });
    },
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Qualifications</h2>
      {qualsQuery.isLoading ? (
        <p>Loading qualifications…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(qualsQuery.data ?? []).map((qual) => (
            <li key={qual.qualCode} style={{ padding: 'var(--boxalarm-spacing-xs) 0' }}>
              <strong>{qual.qualCode}</strong> —{' '}
              {qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
              {qual.grantedByCertId ? (
                <>
                  {' '}
                  (<Link to={`/certifications`}>cert {qual.grantedByCertId}</Link>)
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          aria-label="Assign qualification"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            addQual.mutate();
          }}
          style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', alignItems: 'end' }}
        >
          <label style={{ display: 'grid', gap: 4 }}>
            Qual code
            <input
              value={qualCode}
              onChange={(e) => setQualCode(e.target.value)}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <button type="submit" style={{ minHeight: 44 }}>
            Assign
          </button>
        </form>
      ) : null}
    </section>
  );
}

function LosapSection({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const losapQuery = useQuery({
    queryKey: ['personnel', 'members', memberId, 'losap'],
    queryFn: () => getMemberLosap(auth, memberId),
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>LOSAP</h2>
      {losapQuery.isLoading ? (
        <p>Loading LOSAP total…</p>
      ) : losapQuery.error ? (
        <ApiForbiddenGate error={losapQuery.error} embedded>
          <p>Unable to load LOSAP total.</p>
        </ApiForbiddenGate>
      ) : (
        <p>
          {losapQuery.data?.totalPoints} points in {losapQuery.data?.year}
        </p>
      )}
    </section>
  );
}

function AttendanceSection({ memberId, isOwnRecord }: { memberId: string; isOwnRecord: boolean }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ activityType: AttendanceActivityType; hours: string }>({
    activityType: 'DRILL',
    hours: '',
  });

  const attendanceQuery = useQuery({
    queryKey: ['personnel', 'attendance', memberId],
    queryFn: () => listOwnAttendance(auth),
    enabled: isOwnRecord,
  });

  const addEntry = useMutation({
    mutationFn: () =>
      recordAttendance(auth, {
        activityType: form.activityType,
        refId: null,
        occurredAt: Math.floor(Date.now() / 1000),
        hours: Number(form.hours),
      }),
    onSuccess: async () => {
      setForm({ activityType: 'DRILL', hours: '' });
      await queryClient.invalidateQueries({ queryKey: ['personnel', 'attendance', memberId] });
    },
  });

  if (!isOwnRecord) {
    return null;
  }

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Attendance</h2>
      {attendanceQuery.isLoading ? (
        <p>Loading attendance…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(attendanceQuery.data ?? [])
            .slice()
            .sort((a, b) => a.occurredAt - b.occurredAt)
            .map((record) => (
              <li key={`${record.activityType}-${record.occurredAt}`}>
                {record.activityType} — {new Date(record.occurredAt * 1000).toLocaleDateString()}
                {record.refId ? ` — dispatch ${record.refId}` : ''} — {record.hours}h
              </li>
            ))}
        </ul>
      )}
      <form
        aria-label="Record attendance"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          addEntry.mutate();
        }}
        style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', alignItems: 'end' }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          Activity
          <select
            value={form.activityType}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                activityType: e.target.value as AttendanceActivityType,
              }))
            }
            style={{ minHeight: 44 }}
          >
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Hours
          <input
            type="number"
            min="0"
            step="0.25"
            value={form.hours}
            onChange={(e) => setForm((prev) => ({ ...prev, hours: e.target.value }))}
            required
            style={{ minHeight: 44, padding: '0 12px', width: 100 }}
          />
        </label>
        <button type="submit" style={{ minHeight: 44 }}>
          Record
        </button>
      </form>
    </section>
  );
}

export function MemberDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = auth.roles.includes('ADMIN');
  const canRevokeSessions = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeForbidden, setRevokeForbidden] = useState<unknown>(null);
  const [revoked, setRevoked] = useState(false);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: () => revokeMemberSessions(auth, id),
    onSuccess: () => {
      setRevokeError(null);
      setRevokeForbidden(null);
      setRevoked(true);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 403) {
        setRevokeError(null);
        setRevokeForbidden(error);
        return;
      }
      setRevokeForbidden(null);
      setRevokeError('Could not revoke this member’s sessions. Try again.');
    },
  });

  // ConfirmDialog names the member (PR #321 review m3). Role check alone gates it - no step-up.
  function handleRevoke() {
    setRevoked(false);
    revokeMutation.mutate();
  }

  const isTraining = canManageTraining(auth.roles);
  // Matches the inspections write-access precedent (ADMIN || CHIEF) — PPE issuance is a new
  // control added in this PR, unlike the pre-existing ADMIN-only member-status gate below.
  const canIssuePpe = isAdmin || auth.roles.includes('CHIEF');
  const [ppeForm, setPpeForm] = useState<IssuePpeInput>(emptyPpeForm);
  const [ppeFormError, setPpeFormError] = useState<string | null>(null);

  const memberQuery = useQuery({
    queryKey: ['personnel', 'members', id],
    queryFn: () => getMember(auth, id),
    enabled: Boolean(id),
  });

  const ppeQuery = useQuery({
    queryKey: ['inventory', 'ppe', id],
    queryFn: () => listMemberPpe(auth, id),
    enabled: Boolean(id),
  });

  const issuePpeMutation = useMutation({
    mutationFn: (input: IssuePpeInput) => issueMemberPpe(auth, id, input),
    onSuccess: async () => {
      setPpeForm(emptyPpeForm);
      setPpeFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'ppe', id] });
    },
    onError: (error: Error) => setPpeFormError(error.message),
  });

  const statusMutation = useMutation({
    mutationFn: (status: MemberStatus) => updateMemberStatus(auth, id, status),
    onSuccess: (member) => {
      queryClient.setQueryData(['personnel', 'members', id], member);
      void queryClient.invalidateQueries({ queryKey: ['personnel', 'members'] });
    },
  });

  if (memberQuery.error) {
    return (
      <ApiForbiddenGate error={memberQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const member = memberQuery.data;

  return (
    <main id="main-content">
      <PageHeader
        title={member ? `${member.firstName} ${member.lastName}` : '…'}
        breadcrumbs={[
          { label: 'Personnel', to: '/personnel' },
          { label: member ? `${member.firstName} ${member.lastName}` : '…' },
        ]}
        actions={member ? <Badge>{member.status}</Badge> : undefined}
      />
      {memberQuery.isLoading || !member ? (
        <p>Loading member…</p>
      ) : (
        <>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              columnGap: 'var(--bx-space-lg)',
              rowGap: 'var(--bx-space-sm)',
              fontSize: 14,
            }}
          >
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Email</dt>
            <dd style={{ margin: 0 }}>{member.email}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Phone</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--bx-font-mono)' }}>{member.phone}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Rank</dt>
            <dd style={{ margin: 0 }}>{member.rank}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Agency ID</dt>
            <dd style={{ margin: 0 }}>{member.agencyId}</dd>
            <dt style={{ color: 'var(--bx-fg-muted)' }}>Join date</dt>
            <dd style={{ margin: 0 }}>{member.joinDate}</dd>
          </dl>

          {isAdmin ? (
            <label
              style={{
                display: 'grid',
                gap: 4,
                maxWidth: 320,
                marginTop: 'var(--bx-space-lg)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Change status
              <select
                aria-label="Member status"
                value={member.status}
                disabled={statusMutation.isPending}
                onChange={(e) => statusMutation.mutate(e.target.value as MemberStatus)}
                style={{
                  minHeight: 'var(--bx-target-office)',
                  padding: '0 var(--bx-space-sm)',
                  fontSize: 14,
                  fontWeight: 400,
                  background: 'var(--bx-surface-raised)',
                  color: 'var(--bx-fg)',
                  border: '1px solid var(--bx-border)',
                  borderRadius: 'var(--bx-radius-md)',
                }}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {statusMutation.error ? (
            <ApiForbiddenGate error={statusMutation.error} embedded>
              <p role="alert">{statusMutation.error.message}</p>
            </ApiForbiddenGate>
          ) : null}

          {canRevokeSessions ? (
            <div style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
              <button
                type="button"
                onClick={() => setConfirmRevokeOpen(true)}
                disabled={revokeMutation.isPending}
                style={{ minHeight: 44 }}
              >
                Revoke all sessions (lost device)
              </button>
              {revokeForbidden ? (
                <ApiForbiddenGate error={revokeForbidden} embedded>
                  <p role="alert">Could not revoke this member’s sessions.</p>
                </ApiForbiddenGate>
              ) : null}
              {revokeError ? (
                <p role="alert" aria-live="assertive">
                  {revokeError}
                </p>
              ) : null}
              {revoked ? <p role="status">Sessions revoked.</p> : null}
              <ConfirmDialog
                open={confirmRevokeOpen}
                onOpenChange={setConfirmRevokeOpen}
                title={`Revoke all sessions for ${member.firstName} ${member.lastName}?`}
                consequence={`${member.firstName} ${member.lastName} will be signed out on every device and must sign in again.`}
                confirmLabel="Revoke sessions"
                onConfirm={handleRevoke}
                danger
              />
            </div>
          ) : null}
          <CertificationsPanel memberId={member.memberId} />
          {isTraining ? <TranscriptPanel memberId={member.memberId} /> : null}
          <h2
            style={{
              fontSize: 'var(--boxalarm-font-size-lg)',
              marginTop: 'var(--boxalarm-spacing-xl)',
            }}
          >
            PPE
          </h2>
          {ppeQuery.isLoading ? (
            <p>Loading PPE…</p>
          ) : (ppeQuery.data ?? []).length === 0 ? (
            <p>No PPE issued.</p>
          ) : (
            <ul>
              {(ppeQuery.data ?? []).map((item) => (
                <li key={item.ppeItemId}>
                  {item.itemType} · size {item.size} · expires {item.nfpaExpiryDate} ·{' '}
                  <strong
                    style={
                      item.status === 'EXPIRED' ? { color: 'var(--boxalarm-error)' } : undefined
                    }
                  >
                    {item.status === 'EXPIRED' ? 'EXPIRED' : item.status}
                  </strong>
                </li>
              ))}
            </ul>
          )}

          {canIssuePpe ? (
            <form
              aria-label="Issue PPE"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                issuePpeMutation.mutate(ppeForm);
              }}
              style={{
                marginTop: 'var(--boxalarm-spacing-lg)',
                display: 'grid',
                gap: 'var(--boxalarm-spacing-md)',
                maxWidth: 480,
              }}
            >
              <label style={{ display: 'grid', gap: 4 }}>
                Item type
                <input
                  value={ppeForm.itemType}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, itemType: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Size
                <input
                  value={ppeForm.size}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, size: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                Issue date
                <input
                  type="date"
                  value={ppeForm.issueDate}
                  required
                  onChange={(e) => setPpeForm((prev) => ({ ...prev, issueDate: e.target.value }))}
                  style={{ minHeight: 44, padding: '0 12px' }}
                />
              </label>
              {ppeFormError ? (
                <p role="alert" aria-live="assertive">
                  {ppeFormError}
                </p>
              ) : null}
              <button type="submit" style={{ minHeight: 44 }}>
                Issue PPE
              </button>
            </form>
          ) : null}
          <QualsSection memberId={id} canEdit={isAdmin} />
          <LosapSection memberId={id} />
          <AttendanceSection memberId={id} isOwnRecord={id === auth.user?.profile.sub} />
        </>
      )}
    </main>
  );
}
