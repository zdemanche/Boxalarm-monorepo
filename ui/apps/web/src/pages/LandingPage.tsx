import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { spacing, typography } from '@boxalarm/design-tokens';
import { useAuth, type Role } from '../auth/AuthContext';
import { primaryRole } from '../auth/roles';
import { canAccessPath, firstGrantedNavPath } from '../routing/routeTable';
import { listApparatus } from '../features/apparatus/api';
import { listMembers } from '../features/personnel/api';
import { ApiForbiddenGate } from '../components/ApiForbiddenGate';
import { Card, Stat } from '../components/ui/Card';
import styles from './LandingPage.module.css';

const ROLE_LABEL: Record<Role, string> = {
  CHIEF: 'Chief dashboard',
  ADMIN: 'Admin dashboard',
  OFFICER: 'Officer dashboard',
  TRAINING: 'Training dashboard',
  APPARATUS: 'Apparatus dashboard',
  MEMBER: 'Member home',
};

// Command-console dashboards are shown for roles that manage the department; a plain member's
// home stays a simple summary (docs/design.md §4.4 — member read-only scope).
const DASHBOARD_ROLES: readonly Role[] = ['CHIEF', 'ADMIN', 'OFFICER', 'APPARATUS'];

function CommandConsole() {
  const auth = useAuth();
  // MAJOR-3 (PR #318 review): §7.1 grants /apparatus to APPARATUS|CHIEF only and /personnel to
  // OFFICER|TRAINING|ADMIN|CHIEF only, but this dashboard used to fetch both unconditionally for
  // every DASHBOARD_ROLES member — e.g. an OFFICER (who can't read /apparatus) or an APPARATUS
  // officer (who can't read /personnel) triggered a query that Cedar denies with 403 on every
  // dashboard visit. Gate each query on the same route table the rest of the app uses, so a role
  // that can't read a resource never requests it.
  const canViewApparatus = canAccessPath('/apparatus', auth.roles);
  const canViewMembers = canAccessPath('/personnel', auth.roles);

  const apparatusQuery = useQuery({
    queryKey: ['apparatus'],
    queryFn: () => listApparatus(auth),
    enabled: canViewApparatus,
  });
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    enabled: canViewMembers,
  });

  // MAJOR-3: a failed query (offline, 500, or a 403 that slips through the gate above) used to
  // fall through to `?? []`, so the tile silently read "0 / 0 apparatus in service" — a failure
  // rendered as a clean, healthy zero. Route it through the project's ApiError/ApiForbiddenGate
  // convention (same pattern as ApparatusListPage/PersonnelListPage) instead: a 403 renders
  // ForbiddenState, anything else renders the generic retryable ApiErrorState. `embedded` +
  // `headingLevel="h2"` because LandingPage already owns the page's one <h1>.
  const queryError = apparatusQuery.error ?? membersQuery.error;
  if (queryError) {
    return (
      <ApiForbiddenGate error={queryError} embedded>
        {null}
      </ApiForbiddenGate>
    );
  }

  const apparatus = apparatusQuery.data ?? [];
  const inService = apparatus.filter((a) => a.status === 'IN_SERVICE').length;
  const outOfService = apparatus.filter((a) => a.status === 'OUT_OF_SERVICE').length;
  const members = membersQuery.data ?? [];
  const activeMembers = members.filter((m) => m.status === 'ACTIVE').length;

  return (
    <>
      {/* MAJOR-2 (PR #318 review): this used to hardcode "No active call." with a green
          checkmark in a role="status" live region, stated as fact regardless of whether a call
          was actually active — a false operational claim on the CHIEF/OFFICER dashboard of a
          life-safety dispatch app. There is no incidents/dispatch feature in this app yet to
          wire a real answer to, so this is an honest "not wired" placeholder (matching the
          shift/certification cards below) instead of a fabricated status. */}
      <div className={styles.callBanner}>
        Active-call status isn&rsquo;t wired to this dashboard yet.
      </div>

      <div className={styles.statGrid}>
        {canViewApparatus ? (
          <>
            <Stat
              label="Apparatus in service"
              value={apparatusQuery.isLoading ? '—' : `${inService} / ${apparatus.length}`}
            />
            <Stat
              label="Out of service"
              value={apparatusQuery.isLoading ? '—' : outOfService}
              alarm={outOfService > 0}
            />
          </>
        ) : null}
        {canViewMembers ? (
          <Stat
            label="Active members"
            value={membersQuery.isLoading ? '—' : `${activeMembers} / ${members.length}`}
          />
        ) : null}
        <Stat label="Expiring certifications" value="—" hint="Not yet wired to this screen" />
      </div>

      <div className={styles.sectionGrid}>
        <Card title="Today's shifts">Shift coverage isn't wired to this dashboard yet.</Card>
        <Card title="Expiring certifications">
          Certification tracking isn't wired to this dashboard yet.
        </Card>
      </div>
    </>
  );
}

export function LandingPage() {
  const { roles } = useAuth();
  const role = primaryRole(roles);

  if (!canAccessPath('/', roles)) {
    const fallback = firstGrantedNavPath(roles);
    if (fallback) return <Navigate to={fallback} replace />;
  }

  return (
    <main id="main-content" style={{ padding: spacing.lg }}>
      <h1 style={{ fontSize: typography.size.xl, margin: 0 }}>{ROLE_LABEL[role]}</h1>
      {DASHBOARD_ROLES.includes(role) ? <CommandConsole /> : null}
    </main>
  );
}
