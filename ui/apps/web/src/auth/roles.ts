export type Role = 'MEMBER' | 'OFFICER' | 'TRAINING' | 'APPARATUS' | 'ADMIN' | 'CHIEF';

export const KNOWN_ROLES: readonly Role[] = [
  'MEMBER',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'ADMIN',
  'CHIEF',
];

function isRole(value: string): value is Role {
  return (KNOWN_ROLES as readonly string[]).includes(value);
}

/** Map Cognito ID-token claims → app roles. Backend authorizer uses `cognito:groups`. */
export function rolesFromProfile(profile: Record<string, unknown>): Role[] {
  const groups = profile['cognito:groups'];
  if (!Array.isArray(groups)) return ['MEMBER'];

  const roles = groups
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.toUpperCase())
    .filter(isRole);

  return roles.length > 0 ? roles : ['MEMBER'];
}

/** Training-record management (certifications, events, hours, transcripts): TRAINING or ADMIN.
 * One definition instead of per-file role checks (PR #321 review m10). */
export function canManageTraining(roles: readonly Role[]): boolean {
  return roles.includes('TRAINING') || roles.includes('ADMIN');
}

/** Highest-authority first. Cognito group order is arbitrary, so anything that shows a single
 * role (dashboard choice, the top-bar label) picks by this order, never roles[0]. */
export const ROLE_PRIORITY: readonly Role[] = [
  'CHIEF',
  'ADMIN',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'MEMBER',
];

export function primaryRole(roles: readonly Role[]): Role {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'MEMBER';
}
