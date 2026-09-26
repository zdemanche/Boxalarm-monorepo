import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { StatusChip } from '../../components/ui/Chip';
import { TextInput } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { createApparatus, listApparatus } from './api';
import { MaintenanceDueSoonPanel } from './MaintenanceDueSoonPanel';
import type { Apparatus, CreateApparatusInput } from './types';

const emptyForm: CreateApparatusInput = { unitId: '', type: '' };

function formatElapsed(elapsedSeconds: number): string {
  const days = Math.floor(elapsedSeconds / 86400);
  if (days <= 0) return 'today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function ApparatusListPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  // §7.1: /apparatus is APPARATUS|CHIEF only — create is the APPARATUS officer action.
  const canCreate = auth.roles.includes('APPARATUS');
  const [form, setForm] = useState<CreateApparatusInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateApparatusInput) => createApparatus(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['apparatus'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const columns: DataTableColumn<Apparatus>[] = [
    {
      key: 'unitId',
      header: 'Unit',
      sortValue: (u) => u.unitId,
      render: (u) => (
        <Link
          to={`/apparatus/${encodeURIComponent(u.unitId)}`}
          style={{ fontFamily: 'var(--bx-font-mono)', fontWeight: 600 }}
        >
          {u.unitId}
        </Link>
      ),
    },
    { key: 'type', header: 'Type', sortValue: (u) => u.type, render: (u) => u.type },
    {
      key: 'status',
      header: 'Status',
      sortValue: (u) => u.status,
      render: (u) => (
        <>
          <StatusChip status={u.status === 'IN_SERVICE' ? 'ok' : 'danger'}>
            {u.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
          </StatusChip>
          {u.status === 'OUT_OF_SERVICE' && u.outOfService ? (
            <span style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
              {u.outOfService.reason} — {formatElapsed(u.outOfService.elapsedSeconds)}
            </span>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <main id="main-content">
      <PageHeader title="Apparatus" />

      <DataTable
        caption="Apparatus registry"
        rowKey={(u) => u.apparatusId}
        columns={columns}
        rows={listQuery.data ?? []}
        loading={listQuery.isLoading}
        emptyMessage="No apparatus yet."
      />

      <MaintenanceDueSoonPanel apparatus={listQuery.data ?? []} />

      {canCreate ? (
        <Card title="Add apparatus" style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}>
          <form
            aria-label="Create apparatus"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              createMutation.mutate(form);
            }}
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <TextInput
              label="Unit ID"
              value={form.unitId}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, unitId: e.target.value }))}
            />
            <TextInput
              label="Type"
              value={form.type}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
            />
            {formError ? (
              <p role="alert" aria-live="assertive" style={{ color: 'var(--bx-status-danger)' }}>
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={createMutation.isPending}>
              Create apparatus
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
