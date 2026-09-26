import type { Role } from '../auth/roles';

export interface AppRoute {
  path: string;
  /** Path used for nav links (no params). */
  navPath: string;
  label: string;
  roles: readonly Role[];
  /** When true, shown in PrimaryNav. Param routes use a parent list entry. */
  showInNav: boolean;
}

/**
 * Architecture §7.1 web SPA route table — single source for PrimaryNav + guards.
 * Sibling issues fill page bodies; this ticket only wires access.
 */
export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    navPath: '/',
    label: 'Dashboard',
    roles: ['CHIEF', 'OFFICER'],
    showInNav: true,
  },
  {
    path: '/alerts/roster',
    navPath: '/alerts/roster',
    label: 'Live roster',
    roles: ['OFFICER', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/alerts/diagnostics',
    navPath: '/alerts/diagnostics',
    label: 'Alert diagnostics',
    roles: ['OFFICER', 'CHIEF', 'ADMIN'],
    showInNav: true,
  },
  {
    path: '/incidents',
    navPath: '/incidents',
    label: 'Incidents',
    roles: ['OFFICER', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/incidents/:id',
    navPath: '/incidents',
    label: 'Incident detail',
    roles: ['OFFICER', 'CHIEF'],
    showInNav: false,
  },
  {
    path: '/personnel',
    navPath: '/personnel',
    label: 'Personnel',
    roles: ['OFFICER', 'TRAINING', 'ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/personnel/:id',
    navPath: '/personnel',
    label: 'Member detail',
    roles: ['OFFICER', 'TRAINING', 'ADMIN', 'CHIEF'],
    showInNav: false,
  },
  {
    path: '/certifications',
    navPath: '/certifications',
    label: 'Certifications',
    roles: ['TRAINING', 'ADMIN'],
    showInNav: true,
  },
  {
    path: '/training/events',
    navPath: '/training/events',
    label: 'Training events',
    roles: ['TRAINING', 'ADMIN'],
    showInNav: true,
  },
  {
    path: '/apparatus',
    navPath: '/apparatus',
    label: 'Apparatus',
    roles: ['APPARATUS', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/apparatus/compliance',
    navPath: '/apparatus/compliance',
    label: 'Apparatus compliance',
    roles: ['ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/apparatus/:id',
    navPath: '/apparatus',
    label: 'Apparatus detail',
    roles: ['APPARATUS', 'CHIEF'],
    showInNav: false,
  },
  {
    path: '/inventory',
    navPath: '/inventory',
    label: 'Inventory',
    roles: ['ADMIN', 'APPARATUS', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/inventory/:assetId',
    navPath: '/inventory',
    label: 'Equipment detail',
    roles: ['ADMIN', 'APPARATUS', 'CHIEF'],
    showInNav: false,
  },
  {
    path: '/inspections/occupancies',
    navPath: '/inspections/occupancies',
    label: 'Occupancies',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/inspections/occupancies/:id',
    navPath: '/inspections/occupancies',
    label: 'Occupancy detail',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    showInNav: false,
  },
  {
    path: '/inspections/hydrants',
    navPath: '/inspections/hydrants',
    label: 'Hydrants',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/inspections',
    navPath: '/inspections',
    label: 'Inspections',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/inspections/map',
    navPath: '/inspections/map',
    label: 'Inspections map',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    showInNav: true,
  },
  {
    path: '/schedule',
    navPath: '/schedule',
    label: 'Schedule',
    roles: ['OFFICER', 'ADMIN'],
    showInNav: true,
  },
  {
    path: '/reporting',
    navPath: '/reporting',
    label: 'Reporting',
    roles: ['CHIEF', 'ADMIN', 'TRAINING'],
    showInNav: true,
  },
  {
    path: '/settings',
    navPath: '/settings',
    label: 'Settings',
    roles: ['ADMIN'],
    showInNav: true,
  },
  {
    path: '/settings/losap',
    navPath: '/settings',
    label: 'LOSAP settings',
    roles: ['ADMIN'],
    showInNav: false,
  },
  {
    path: '/audit-log',
    navPath: '/audit-log',
    label: 'Audit log',
    roles: ['ADMIN', 'CHIEF'],
    showInNav: true,
  },
] as const;

export function routesForRoles(userRoles: readonly Role[]): AppRoute[] {
  return APP_ROUTES.filter(
    (route) => route.showInNav && route.roles.some((r) => userRoles.includes(r)),
  );
}

export function canAccessPath(pathname: string, userRoles: readonly Role[]): boolean {
  const match = APP_ROUTES.find((route) => pathMatches(route.path, pathname));
  if (!match) return false;
  return match.roles.some((r) => userRoles.includes(r));
}

/** The nav entry a pathname belongs to: `/apparatus/compliance` -> `/apparatus/compliance`,
 * `/apparatus/E1` -> `/apparatus`. Used for the nav's active state, so a nested nav route
 * doesn't also light up its parent (PR #321 review m4). */
export function activeNavPathFor(pathname: string): string | null {
  return APP_ROUTES.find((route) => pathMatches(route.path, pathname))?.navPath ?? null;
}

export function firstGrantedNavPath(userRoles: readonly Role[]): string | null {
  const routes = routesForRoles(userRoles);
  return routes[0]?.navPath ?? null;
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern === '/') return pathname === '/';
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}
