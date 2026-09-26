import { describe, expect, test } from 'vitest';
import { canManageTraining, rolesFromProfile, type Role } from './roles';

describe('rolesFromProfile', () => {
  test('reads cognito:groups and maps known groups to Role', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['CHIEF', 'OFFICER'] })).toEqual([
      'CHIEF',
      'OFFICER',
    ] satisfies Role[]);
  });

  test('normalizes mixed-case cognito group names', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['chief', 'Admin'] })).toEqual(['CHIEF', 'ADMIN']);
  });

  test('falls back to MEMBER when cognito:groups is missing or empty', () => {
    expect(rolesFromProfile({ sub: 'm1' })).toEqual(['MEMBER']);
    expect(rolesFromProfile({ 'cognito:groups': [] })).toEqual(['MEMBER']);
  });

  test('ignores unknown groups and falls back to MEMBER when none known', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['SOME_CUSTOM_GROUP'] })).toEqual(['MEMBER']);
  });

  test('prefers cognito:groups over a legacy roles claim', () => {
    expect(
      rolesFromProfile({
        'cognito:groups': ['TRAINING'],
        roles: ['CHIEF'],
      }),
    ).toEqual(['TRAINING']);
  });

  test('does not use legacy roles when cognito:groups is absent (claim is never issued)', () => {
    expect(rolesFromProfile({ roles: ['CHIEF'] })).toEqual(['MEMBER']);
  });
});

describe('canManageTraining', () => {
  test.each<[Role[], boolean]>([
    [['TRAINING'], true],
    [['ADMIN'], true],
    [['MEMBER', 'TRAINING'], true],
    [['CHIEF'], false],
    [['OFFICER'], false],
    [['MEMBER'], false],
  ])('%j -> %s', (roles, expected) => {
    expect(canManageTraining(roles)).toBe(expected);
  });
});
