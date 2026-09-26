import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { Button, Card, Skeleton, TextInput } from '../../components/ui';
import { createScbaRecord, getScbaDueSoon } from './api';
import type { CreateScbaInput, ScbaRecord } from './types';

const emptyForm: CreateScbaInput = {
  scbaUnitId: '',
  cylinderId: '',
  flowTestDate: '',
  hydroTestDate: '',
};

// POST /apparatus/{unitId}/scba resolves the unit by its display unitId (backend postScba.ts,
// via GSI3), and stores the resolved apparatusId on the SCBA and due items. So the write goes
// to unitId and the due-soon filter matches on apparatusId.
export function ScbaTab({ unitId, apparatusId }: { unitId: string; apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [records, setRecords] = useState<ScbaRecord[]>([]);

  const dueSoonQuery = useQuery({
    queryKey: ['apparatus', 'scba', 'due-soon'],
    queryFn: () => getScbaDueSoon(auth),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateScbaInput) => createScbaRecord(auth, unitId, input),
    onSuccess: (created) => {
      setRecords((prev) => [created, ...prev]);
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', 'scba', 'due-soon'] });
    },
  });

  // A failed due-soon read is reported inline in its own section; it must not take down the
  // "Log SCBA record" form below, which writes to a different endpoint (PR #321 review M3).
  // 403 copy stays generic, never the problem detail (ForbiddenState rule, PR #93 review).
  const dueSoonErrorMessage =
    dueSoonQuery.error instanceof ApiError && dueSoonQuery.error.problem.status === 403
      ? 'You do not have access to the SCBA due-soon list.'
      : 'The SCBA due-soon list could not be loaded.';

  const dueForUnit = (dueSoonQuery.data ?? []).filter((entry) => entry.apparatusId === apparatusId);

  return (
    <section>
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>SCBA</h2>

      {records.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {records.map((record) => (
            <li
              key={record.scbaUnitId}
              style={{
                padding: 'var(--bx-space-sm) 0',
                borderBottom: '1px solid var(--bx-border-decorative)',
              }}
            >
              <strong>{record.scbaUnitId}</strong> — cylinder {record.cylinderId}
              <div style={{ fontSize: 13, color: 'var(--bx-fg-muted)' }}>
                Next flow test due {record.nextFlowTestDue} — next hydro test due{' '}
                {record.nextHydroTestDue}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Due soon</h3>
      {dueSoonQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : dueSoonQuery.error ? (
        <div role="alert">
          <p>{dueSoonErrorMessage}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void dueSoonQuery.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : dueForUnit.length === 0 ? (
        <p>Nothing due soon for this unit.</p>
      ) : (
        <ul>
          {dueForUnit.map((entry) => (
            <li key={`${entry.scbaUnitId}-${entry.testType}`}>
              {entry.scbaUnitId} — {entry.testType === 'SCBA_FLOW' ? 'Flow test' : 'Hydro test'} due{' '}
              {entry.dueDate}
            </li>
          ))}
        </ul>
      )}

      <Card title="Log SCBA record" style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}>
        <form
          aria-label="Log SCBA record"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate(form);
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)' }}
        >
          <TextInput
            label="SCBA unit"
            value={form.scbaUnitId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, scbaUnitId: e.target.value }))}
          />
          <TextInput
            label="Cylinder ID"
            value={form.cylinderId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, cylinderId: e.target.value }))}
          />
          <TextInput
            label="Flow test date"
            type="date"
            value={form.flowTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, flowTestDate: e.target.value }))}
          />
          <TextInput
            label="Hydro test date"
            type="date"
            value={form.hydroTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, hydroTestDate: e.target.value }))}
          />
          {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
          <Button type="submit" loading={mutation.isPending} style={{ maxWidth: 240 }}>
            Save SCBA record
          </Button>
        </form>
      </Card>
    </section>
  );
}
