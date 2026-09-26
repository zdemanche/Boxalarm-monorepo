import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FORBIDDEN_PATH_BY_ROLE, PERSONAS } from '../auth/personas';
import type { Role } from '../../src/auth/roles';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
const CLIENT_ID = 'test-web-client';
const KID = 'test-kid';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function issueIdToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(
    JSON.stringify({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'member-1',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey));
  return `${header}.${body}.${signature}`;
}

async function stubCognitoWithGroups(
  page: Page,
  privateKey: KeyObject,
  jwk: JsonWebKey,
  groups: string[],
): Promise<void> {
  let capturedNonce: string | undefined;

  await page.route(`${ISSUER}/.well-known/openid-configuration`, (route) =>
    route.fulfill({
      json: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      },
    }),
  );

  await page.route(`${ISSUER}/.well-known/jwks.json`, (route) =>
    route.fulfill({ json: { keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] } }),
  );

  await page.route(`${ISSUER}/oauth2/authorize**`, async (route) => {
    const url = new URL(route.request().url());
    capturedNonce = url.searchParams.get('nonce') ?? undefined;
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    await route.fulfill({
      status: 302,
      headers: { location: `${redirectUri}?code=test-code&state=${state}` },
    });
  });

  await page.route(`${ISSUER}/oauth2/token`, async (route) => {
    const idToken = issueIdToken(privateKey, {
      'cognito:groups': groups,
      ...(capturedNonce ? { nonce: capturedNonce } : {}),
    });
    await route.fulfill({
      json: {
        access_token: 'test-access-token',
        id_token: idToken,
        refresh_token: 'test-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    });
  });
}

// MAJOR-1 (PR #318 review): below `md` (the new `mobile-chromium` project), PrimaryNav's static
// sidebar is display:none and NavDrawer is closed until TopBar's hamburger button is used — open
// it first so the assertions below see the same "Primary" nav landmark on every project.
async function openNavIfCollapsed(page: Page): Promise<void> {
  const menuButton = page.getByRole('button', { name: 'Open navigation' });
  if (await menuButton.isVisible()) {
    await menuButton.click();
  }
}

const ALL_NAV_LABELS = [
  'Dashboard',
  'Live roster',
  'Alert diagnostics',
  'Incidents',
  'Personnel',
  'Certifications',
  'Training events',
  'Apparatus',
  'Apparatus compliance',
  'Schedule',
  'Reporting',
  'Settings',
  'Audit log',
];

for (const role of Object.keys(PERSONAS) as Role[]) {
  const persona = PERSONAS[role];

  test.describe(`persona ${role}`, () => {
    test(`PrimaryNav shows exactly granted routes`, async ({ page }) => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
      await stubCognitoWithGroups(page, privateKey, jwk, persona.groups);

      await page.goto('/login');
      await page.getByRole('button', { name: 'Sign in' }).click();

      if (role === 'MEMBER') {
        await expect(page.getByRole('heading', { name: 'Member home' })).toBeVisible();
        await openNavIfCollapsed(page);
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        for (const label of ALL_NAV_LABELS) {
          await expect(
            page
              .getByRole('navigation', { name: 'Primary' })
              .getByRole('link', { name: label, exact: true }),
          ).toHaveCount(0);
        }
        return;
      }

      await openNavIfCollapsed(page);
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav).toBeVisible();

      for (const label of persona.expectedNavLabels) {
        await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
      }
      for (const label of ALL_NAV_LABELS) {
        if (!persona.expectedNavLabels.includes(label)) {
          await expect(nav.getByRole('link', { name: label, exact: true })).toHaveCount(0);
        }
      }
    });

    test(`forbidden URL is not reachable as page content`, async ({ page }) => {
      const forbiddenPath = FORBIDDEN_PATH_BY_ROLE[role];
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
      await stubCognitoWithGroups(page, privateKey, jwk, persona.groups);

      await page.goto('/login');
      await page.getByRole('button', { name: 'Sign in' }).click();
      // Wait for auth to settle before deep-linking (full reload keeps localStorage session).
      await openNavIfCollapsed(page);
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

      await page.goto(forbiddenPath);
      await expect(page).toHaveURL(new RegExp(`${forbiddenPath.replace('/', '\\/')}$`));
      await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();
    });
  });
}

// MAJOR-1 (PR #318 review): this is the regression the desktop-only Playwright config couldn't
// catch — the static sidebar's <nav aria-label="Primary"> and Sign out were unreachable below
// 768px with no replacement. Runs on both projects: mobile-chromium exercises the drawer path,
// chromium confirms the static sidebar still needs no hamburger.
test('Primary nav and Sign out are reachable on every viewport this suite runs at', async ({
  page,
}) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  await stubCognitoWithGroups(page, privateKey, jwk, ['CHIEF']);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Chief dashboard' })).toBeVisible();

  await openNavIfCollapsed(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('CHIEF landing shows chief dashboard (cognito:groups, not roles claim)', async ({ page }) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  await stubCognitoWithGroups(page, privateKey, jwk, ['CHIEF']);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Chief dashboard' })).toBeVisible();
});

test('AppShell PrimaryNav passes axe for CHIEF', async ({ page }) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  await stubCognitoWithGroups(page, privateKey, jwk, ['CHIEF']);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // On the mobile-chromium project this opens NavDrawer, so the axe scan below also covers the
  // MAJOR-1 replacement nav, not just the desktop sidebar.
  await openNavIfCollapsed(page);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('ForbiddenState after MEMBER deep-link passes axe', async ({ page }) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  await stubCognitoWithGroups(page, privateKey, jwk, ['MEMBER']);

  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await openNavIfCollapsed(page);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  await page.goto(FORBIDDEN_PATH_BY_ROLE.MEMBER);
  await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
