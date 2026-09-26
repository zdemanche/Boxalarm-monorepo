import type { StatusRole } from '@boxalarm/design-tokens';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, PageHeader, Skeleton, StatusChip, Tabs } from '../../components/ui';
import { listEquipment } from '../inventory/api';
import { getApparatus } from './api';
import { InventoryTab } from './InventoryTab';
import { MaintenanceTab } from './MaintenanceTab';
import { ScbaTab } from './ScbaTab';
import { ServiceStatusControls } from './ServiceStatusControls';
import { TestingTab } from './TestingTab';
import type { OpenDefectSummary } from './types';

const SEVERITY_WORD: Record<OpenDefectSummary['severity'], string> = {
  MINOR: 'Minor',
  MAJOR: 'Major',
  OUT_OF_SERVICE: 'Out of service',
};

const SEVERITY_STATUS: Record<OpenDefectSummary['severity'], StatusRole> = {
  MINOR: 'warning',
  MAJOR: 'caution',
  OUT_OF_SERVICE: 'danger',
};

/** A signed http(s) URL or a same-origin path. An S3 key is not a displayable photo. */
export function defectPhotoSrc(defect: OpenDefectSummary): string | null {
  const candidate = defect.photoUrl?.trim();
  if (!candidate) return null;
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' || url.protocol === 'http:') return candidate;
  } catch {
    return null;
  }
  return null;
}

export function ApparatusDetailPage() {
  // The route param is the display unitId: the backend resolves GET /apparatus/{unitId} by
  // unitId (apparatus-service getApparatus.ts -> getApparatusByUnitId), not by apparatusId.
  const { id = '' } = useParams();
  const auth = useAuth();

  const detailQuery = useQuery({
    queryKey: ['apparatus', id],
    queryFn: () => getApparatus(auth, id),
    enabled: Boolean(id),
  });

  const apparatusId = detailQuery.data?.apparatusId ?? '';
  const equipmentQuery = useQuery({
    queryKey: ['inventory', 'equipment', 'byApparatus', apparatusId],
    queryFn: () => listEquipment(auth, { assignedToType: 'APPARATUS', assignedToId: apparatusId }),
    enabled: Boolean(apparatusId),
  });

  if (detailQuery.error) {
    return (
      <ApiForbiddenGate error={detailQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const unit = detailQuery.data;

  return (
    <main id="main-content">
      <PageHeader
        title={unit?.unitId ?? '…'}
        breadcrumbs={[{ label: 'Apparatus', to: '/apparatus' }, { label: unit?.unitId ?? '…' }]}
      />
      {detailQuery.isLoading || !unit ? (
        <Skeleton lines={3} />
      ) : (
        <>
          <Card>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content 1fr',
                columnGap: 'var(--bx-space-lg)',
                rowGap: 'var(--bx-space-sm)',
                fontSize: 14,
                margin: 0,
              }}
            >
              <dt style={{ color: 'var(--bx-fg-muted)' }}>Type</dt>
              <dd style={{ margin: 0 }}>{unit.type}</dd>
              <dt style={{ color: 'var(--bx-fg-muted)' }}>Apparatus ID</dt>
              <dd style={{ margin: 0, fontFamily: 'var(--bx-font-mono)' }}>{unit.apparatusId}</dd>
            </dl>
            {unit.failedTests.length > 0 ? (
              <div
                role="alert"
                style={{
                  marginTop: 'var(--bx-space-md)',
                  color: 'var(--bx-status-danger)',
                  fontWeight: 600,
                }}
              >
                Failed tests: {unit.failedTests.map((t) => t.testType).join(', ')}
              </div>
            ) : null}
          </Card>

          <ServiceStatusControls unit={unit} />

          <Card title="Open defects">
            {unit.openDefects.length === 0 ? (
              <p>No open defects.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {unit.openDefects.map((defect) => {
                  const photo = defectPhotoSrc(defect);
                  const reported = new Date(defect.reportedAt * 1000);
                  return (
                    <li
                      key={defect.defectId}
                      style={{
                        display: 'flex',
                        gap: 'var(--bx-space-md)',
                        alignItems: 'flex-start',
                        padding: 'var(--bx-space-md) 0',
                        borderBottom: '1px solid var(--bx-border-decorative)',
                      }}
                    >
                      {photo ? (
                        <img
                          src={photo}
                          alt={defect.description}
                          width={120}
                          height={90}
                          style={{
                            width: 120,
                            height: 90,
                            objectFit: 'cover',
                            borderRadius: 8,
                            flexShrink: 0,
                          }}
                        />
                      ) : null}
                      <div>
                        <strong>{defect.description}</strong>
                        <div
                          style={{
                            display: 'flex',
                            gap: 'var(--bx-space-sm)',
                            alignItems: 'center',
                            marginTop: 'var(--bx-space-xs)',
                          }}
                        >
                          <StatusChip status={SEVERITY_STATUS[defect.severity]}>
                            {SEVERITY_WORD[defect.severity]}
                          </StatusChip>
                          <time dateTime={reported.toISOString()}>
                            {reported.toLocaleDateString()}
                          </time>
                        </div>
                        {photo ? null : defect.photoS3Key ? (
                          <p style={{ margin: 'var(--bx-space-xs) 0 0', fontSize: 13 }}>
                            Photo on file. The apparatus record did not include a signed photo URL.
                          </p>
                        ) : (
                          <p style={{ margin: 'var(--bx-space-xs) 0 0', fontSize: 13 }}>
                            No photo.
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Tabs
            label="Apparatus detail sections"
            items={[
              {
                value: 'maintenance',
                label: 'Maintenance',
                content: <MaintenanceTab apparatusId={unit.apparatusId} />,
              },
              {
                // POST /{unitId}/scba resolves the unit by unitId; the due-soon feed carries the
                // resolved apparatusId, so the tab needs both.
                value: 'scba',
                label: 'SCBA',
                content: <ScbaTab unitId={unit.unitId} apparatusId={unit.apparatusId} />,
              },
              {
                // Testing schedules are the one sub-resource the backend resolves and returns by
                // display unit code, so it alone still takes unitId — see the tab-identifier note
                // in the apparatus-service INFRA reconciliation ticket for the full picture.
                value: 'testing',
                label: 'Testing',
                content: <TestingTab unitId={unit.unitId} />,
              },
              {
                value: 'inventory',
                label: 'Inventory',
                content: <InventoryTab apparatusId={unit.apparatusId} />,
              },
            ]}
          />

          <Card title="Assigned equipment">
            {equipmentQuery.isLoading ? (
              <Skeleton lines={2} />
            ) : (equipmentQuery.data ?? []).length === 0 ? (
              <p>No equipment assigned.</p>
            ) : (
              <ul>
                {(equipmentQuery.data ?? []).map((asset) => (
                  <li key={asset.assetId}>
                    <Link to={`/inventory/${asset.assetId}`}>{asset.serialNumber}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
