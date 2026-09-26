import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  DataTable,
  PageHeader,
  Skeleton,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { canAccessPath } from '../../routing/routeTable';
import { getCompliance } from './api';
import type { ComplianceEntry } from './types';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function toEpochSeconds(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
}

export function CompliancePage() {
  const auth = useAuth();
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(daysAgo(0));

  const query = useQuery({
    queryKey: ['apparatus', 'compliance', from, to],
    queryFn: () => getCompliance(auth, toEpochSeconds(from), toEpochSeconds(to) + 86399),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const columns: DataTableColumn<ComplianceEntry>[] = [
    { key: 'unitId', header: 'Unit', sortValue: (e) => e.unitId, render: (e) => e.unitId },
    {
      key: 'expected',
      header: 'Expected',
      sortValue: (e) => e.expectedChecks,
      render: (e) => e.expectedChecks,
    },
    {
      key: 'actual',
      header: 'Actual',
      sortValue: (e) => e.actualChecks,
      render: (e) => e.actualChecks,
    },
    {
      key: 'compliant',
      header: 'Compliant',
      sortValue: (e) => (e.compliant ? 1 : 0),
      render: (e) => (
        <StatusChip status={e.compliant ? 'ok' : 'danger'}>{e.compliant ? 'Yes' : 'No'}</StatusChip>
      ),
    },
  ];

  return (
    <main id="main-content">
      <PageHeader
        title="Check compliance"
        // ADMIN can open this report but not /apparatus, so only link the parent crumb for
        // roles that can follow it (PR #321 review m4).
        breadcrumbs={[
          canAccessPath('/apparatus', auth.roles)
            ? { label: 'Apparatus', to: '/apparatus' }
            : { label: 'Apparatus' },
          { label: 'Compliance' },
        ]}
      />

      <div style={{ display: 'flex', gap: 'var(--bx-space-md)' }}>
        <TextInput
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {query.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <DataTable
          caption="Check compliance by unit"
          rowKey={(e) => e.unitId}
          columns={columns}
          rows={query.data ?? []}
          emptyMessage="No compliance data for this range."
        />
      )}
    </main>
  );
}
