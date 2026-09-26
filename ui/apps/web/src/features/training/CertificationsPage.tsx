import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { DataTable, PageHeader, Select, Tabs, type DataTableColumn } from '../../components/ui';
import { listMembers } from '../personnel/api';
import { listExpiringCertifications } from './api';
import { CertificationsPanel } from './CertificationsPanel';
import type { ExpiringCertification } from './types';

type Tab = 'certifications' | 'expiring';

function ExpiringTab() {
  const auth = useAuth();
  const expiringQuery = useQuery({
    queryKey: ['training', 'certifications', 'expiring'],
    queryFn: () => listExpiringCertifications(auth),
  });

  if (expiringQuery.error) {
    return (
      <ApiForbiddenGate error={expiringQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const rows = [...(expiringQuery.data ?? [])].sort((a, b) =>
    a.expiryDate.localeCompare(b.expiryDate),
  );

  const columns: DataTableColumn<ExpiringCertification>[] = [
    { key: 'memberId', header: 'Member', render: (r) => r.memberId },
    { key: 'certType', header: 'Certification', render: (r) => r.certType },
    {
      key: 'expiryDate',
      header: 'Expires',
      sortValue: (r) => r.expiryDate,
      render: (r) => r.expiryDate,
    },
  ];

  return (
    <DataTable
      caption="Expiring certifications"
      rowKey={(r) => r.certId}
      columns={columns}
      rows={rows}
      loading={expiringQuery.isLoading}
      emptyMessage="No certifications are due to expire within the configured window."
    />
  );
}

export function CertificationsPage() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('certifications');
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');

  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });

  return (
    <main id="main-content">
      <PageHeader title="Certifications" />

      {/* Shared Radix Tabs (PR #321 review m7): tab/tabpanel wiring, aria-controls, roving
          tabindex and arrow-key navigation, instead of a hand-rolled role="tab" row. */}
      <Tabs
        label="Certifications views"
        value={tab}
        onValueChange={(next) => setTab(next as Tab)}
        items={[
          {
            value: 'certifications',
            label: 'Certifications',
            content: (
              <div style={{ marginTop: 'var(--bx-space-lg)' }}>
                <Select
                  label="Member"
                  value={selectedMemberId}
                  onChange={(e) => setSelectedMemberId(e.target.value)}
                  style={{ maxWidth: 320 }}
                >
                  <option value="">Select a member…</option>
                  {(membersQuery.data ?? []).map((member) => (
                    <option key={member.memberId} value={member.memberId}>
                      {member.lastName}, {member.firstName}
                    </option>
                  ))}
                </Select>
                {selectedMemberId ? <CertificationsPanel memberId={selectedMemberId} /> : null}
              </div>
            ),
          },
          {
            value: 'expiring',
            label: 'Expiring',
            content: (
              <div style={{ marginTop: 'var(--bx-space-lg)' }}>
                <ExpiringTab />
              </div>
            ),
          },
        ]}
      />
    </main>
  );
}
