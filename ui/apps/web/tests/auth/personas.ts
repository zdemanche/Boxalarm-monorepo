import type { Role } from '../../src/auth/roles';

/**
 * Six Cognito personas for Playwright stubs.
 * `expectedNavLabels` is a frozen copy of architecture §7.1 — do NOT derive from
 * `routesForRoles()`, or a wrong route table would make the E2E pass vacuously.
 */
export const PERSONAS: Record<Role, { groups: Role[]; expectedNavLabels: readonly string[] }> = {
  MEMBER: { groups: ['MEMBER'], expectedNavLabels: [] },
  OFFICER: {
    groups: ['OFFICER'],
    expectedNavLabels: [
      'Dashboard',
      'Live roster',
      'Alert diagnostics',
      'Incidents',
      'Personnel',
      'Schedule',
    ],
  },
  TRAINING: {
    groups: ['TRAINING'],
    expectedNavLabels: ['Personnel', 'Certifications', 'Training events', 'Reporting'],
  },
  APPARATUS: {
    groups: ['APPARATUS'],
    expectedNavLabels: ['Apparatus'],
  },
  ADMIN: {
    groups: ['ADMIN'],
    expectedNavLabels: [
      'Alert diagnostics',
      'Personnel',
      'Certifications',
      'Training events',
      'Schedule',
      'Reporting',
      'Settings',
      'Audit log',
      'Apparatus compliance',
    ],
  },
  CHIEF: {
    groups: ['CHIEF'],
    expectedNavLabels: [
      'Dashboard',
      'Live roster',
      'Alert diagnostics',
      'Incidents',
      'Personnel',
      'Apparatus',
      'Reporting',
      'Audit log',
      'Apparatus compliance',
    ],
  },
};

/** A path each persona must NOT be able to open (architecture §7.1). */
export const FORBIDDEN_PATH_BY_ROLE: Record<Role, string> = {
  MEMBER: '/settings',
  OFFICER: '/settings',
  TRAINING: '/settings',
  APPARATUS: '/settings',
  ADMIN: '/incidents',
  CHIEF: '/settings',
};
