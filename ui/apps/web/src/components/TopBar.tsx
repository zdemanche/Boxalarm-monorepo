import { useAuth } from '../auth/AuthContext';
import { primaryRole as pickPrimaryRole } from '../auth/roles';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import { usePalette } from '../lib/usePalette';
import { IconButton } from './ui/Button';
import { AlertTriangle, CheckCircle2, Menu, Moon, Sun } from './ui/icons';
import styles from './AppShell.module.css';

const ROLE_LABEL: Record<string, string> = {
  MEMBER: 'Member',
  OFFICER: 'Officer',
  TRAINING: 'Training officer',
  APPARATUS: 'Apparatus officer',
  ADMIN: 'Administrator',
  CHIEF: 'Chief',
};

interface TopBarProps {
  /** Opens NavDrawer — MAJOR-1 (PR #318 review): below `md` (767px) and at high browser zoom,
   * PrimaryNav's static sidebar is hidden and this button is the only way to reach navigation
   * and Sign out. Visible only below `md` (AppShell.module.css `.menuButton`). */
  onOpenNav: () => void;
}

export function TopBar({ onOpenNav }: TopBarProps) {
  const { roles } = useAuth();
  const [palette, setPalette] = usePalette();
  const isCab = palette === 'cab';
  // Cognito group order is arbitrary; label with the highest-priority role (PR #321 m12).
  const primaryRole = roles.length > 0 ? pickPrimaryRole(roles) : undefined;
  // MAJOR-2 (PR #318 review): this used to be a hardcoded "Connected" string in this live
  // region, which is a false operational-status claim in a life-safety dispatch app - it never
  // reflected reality, including when the API was down or the browser was offline. This is the
  // only connectivity signal available in this app's current scope (no dispatch/API reachability
  // channel exists yet), so it is labelled for exactly what it measures rather than implied to
  // be a general "connected" status.
  const isOnline = useOnlineStatus();

  return (
    <header className={styles.topbar} role="banner">
      <div className={styles.topbarLeft}>
        <IconButton
          icon={Menu}
          label="Open navigation"
          onClick={onOpenNav}
          size="sm"
          className={styles.menuButton}
        />
        <div
          className={styles.connectivity}
          role="status"
          title="Your browser's network connection. Does not reflect dispatch or server connectivity."
        >
          {isOnline ? (
            <CheckCircle2 size={15} aria-hidden="true" />
          ) : (
            <AlertTriangle size={15} aria-hidden="true" />
          )}
          <span>Browser network: {isOnline ? 'online' : 'offline'}</span>
        </div>
      </div>
      <div className={styles.topbarRight}>
        {primaryRole ? (
          <span className={styles.roleLabel}>{ROLE_LABEL[primaryRole] ?? primaryRole}</span>
        ) : null}
        <IconButton
          icon={isCab ? Sun : Moon}
          label={isCab ? 'Switch to day palette' : 'Switch to cab palette'}
          onClick={() => setPalette(isCab ? 'day' : 'cab')}
          size="sm"
        />
      </div>
    </header>
  );
}
