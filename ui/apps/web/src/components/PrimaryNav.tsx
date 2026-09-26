import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { activeNavPathFor, routesForRoles } from '../routing/routeTable';
import {
  CalendarClock,
  ClipboardList,
  Flame,
  GraduationCap,
  LayoutDashboard,
  Package,
  RadioTower,
  ScrollText,
  Settings,
  ShieldAlert,
  Truck,
  Users,
  type LucideIcon,
} from './ui/icons';
import styles from './AppShell.module.css';

// Keyed by navPath prefix so a sibling ticket's route (appended to routeTable.ts) still gets a
// sensible icon without this file needing to change — falls back to LayoutDashboard.
const ICON_BY_PREFIX: Array<[string, LucideIcon]> = [
  ['/alerts', RadioTower],
  ['/incidents', Flame],
  ['/personnel', Users],
  ['/certifications', ShieldAlert],
  ['/training', GraduationCap],
  ['/apparatus', Truck],
  ['/inventory', Package],
  ['/schedule', CalendarClock],
  ['/reporting', ClipboardList],
  ['/settings', Settings],
  ['/audit-log', ScrollText],
];

function iconFor(navPath: string): LucideIcon {
  return ICON_BY_PREFIX.find(([prefix]) => navPath.startsWith(prefix))?.[1] ?? LayoutDashboard;
}

interface NavListContentProps {
  /** Called after a nav link is clicked or Sign out is chosen — NavDrawer (MAJOR-1) passes this
   * to close itself, so the drawer doesn't stay open behind the page it just navigated to. */
  onNavigate?: () => void;
}

/** The nav's actual content — brand mark, link list, and Sign out — shared between the
 * always-visible desktop sidebar (`PrimaryNav` below) and the below-`md` `NavDrawer`, so
 * route/role/icon logic lives in exactly one place. */
export function NavListContent({ onNavigate }: NavListContentProps) {
  const { roles, signOut } = useAuth();
  const links = routesForRoles(roles);
  // Exactly one active entry: the nav entry the current route belongs to. A prefix match
  // (NavLink's default) lit up both "Apparatus" and "Apparatus compliance" on
  // /apparatus/compliance.
  const activeNavPath = activeNavPathFor(useLocation().pathname);

  return (
    <>
      <div className={styles.brand}>
        <Flame size={18} aria-hidden="true" />
        Boxalarm
      </div>
      <ul className={styles.navList}>
        {links.map((route) => {
          const Icon = iconFor(route.navPath);
          return (
            <li key={route.navPath}>
              <Link
                to={route.navPath}
                className={[
                  styles.navLink,
                  route.navPath === activeNavPath ? styles.navLinkActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={route.navPath === activeNavPath ? 'page' : undefined}
                onClick={onNavigate}
              >
                <Icon size={18} aria-hidden="true" />
                {route.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className={styles.signOutWrap}>
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            void signOut();
          }}
          className={styles.navLink}
          style={{ width: '100%' }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}

export function PrimaryNav() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return null;

  return (
    <nav aria-label="Primary" className={styles.sidebar}>
      <NavListContent />
    </nav>
  );
}
