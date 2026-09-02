/**
 * The standalone JENIFY HQ process (Phase 2, Stage 1).
 *
 * This is the Stage 1 claim, tested: HQ boots and serves in a process that
 * never loads `@factoryos/server`. It also pins the honest posture — with no
 * identity wired, the process runs and refuses, and says so at boot rather than
 * appearing broken or, worse, appearing open.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_ROUTES, type AuthenticatedAccount } from '@factoryos/headquarter/live';
import { openHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import { registerDirectOrderCapability, DIRECT_ORDER_CAPABILITY } from '@factoryos/headquarter/live';
import type { HqIdentityPort } from '@factoryos/hq-host';
import { buildStandaloneHq } from '../src/main.js';

let workDir: string;
let dbPath: string;
let siteDir: string;

const FOUNDER: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Proof Founder',
  authenticatedAt: new Date().toISOString(),
};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'hq-standalone-'));
  dbPath = join(workDir, 'hq.sqlite');
  siteDir = join(workDir, 'site');
  // A real HQ database, created the way the product creates one.
  const db = openHqDatabase(dbPath);
  registerDirectOrderCapability(db);
  new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Proof Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  db.close();
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), '<title>HQ</title><p>canonical state</p>');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    FACTORYOS_HQ_CONTROL: '1',
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_SITE_DIR: siteDir,
    FACTORYOS_HQ_FOUNDER_MAP: JSON.stringify([
      { realmId: 'realm', accountId: 'acc-1', principalId: 'founder' },
    ]),
    FACTORYOS_HQ_ALLOWED_ORIGINS: 'https://hq.example',
    ...overrides,
  };
}

const identityFor = (account: AuthenticatedAccount | null): HqIdentityPort => ({
  forRequest: () => ({ sessions: { resolve: () => account } }),
});

describe('HQ runs as its own process', () => {
  it('boots from the environment alone, with no tenant platform', async () => {
    const built = await buildStandaloneHq({ env: env(), identity: identityFor(FOUNDER), log: () => {} });
    expect(built).not.toBeNull();
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: CONTROL_ROUTES.session });
    expect(res.statusCode).toBe(200);
    expect(res.json().founder).toBe(true);
    await built!.close();
  });

  it('serves the Founder-gated site it was pointed at', async () => {
    const built = await buildStandaloneHq({ env: env(), identity: identityFor(FOUNDER), log: () => {} });
    await built!.app.ready();
    const res = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('canonical state');
    await built!.close();
  });
});

describe('it stays OFF unless deliberately switched on', () => {
  it('does not start without the master switch', async () => {
    const built = await buildStandaloneHq({
      env: env({ FACTORYOS_HQ_CONTROL: undefined }),
      log: () => {},
    });
    expect(built).toBeNull();
  });

  it('does not start without a database, rather than inventing one', async () => {
    const built = await buildStandaloneHq({ env: env({ FACTORYOS_HQ_DB: undefined }), log: () => {} });
    expect(built).toBeNull();
  });
});

describe('with no identity wired it refuses, loudly and truthfully', () => {
  it('defaults to NO_IDENTITY and refuses every read', async () => {
    const built = await buildStandaloneHq({ env: env(), log: () => {} });
    await built!.app.ready();
    expect((await built!.app.inject({ method: 'GET', url: CONTROL_ROUTES.session })).statusCode).toBe(401);
    const page = await built!.app.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.statusCode).toBe(401);
    expect(page.body).not.toContain('canonical state');
    await built!.close();
  });

  it('says at boot that it is not a hosted HQ', async () => {
    // The product rule from issue #227: a deployment that cannot really do the
    // thing must SAY so rather than look functional.
    const lines: string[] = [];
    const built = await buildStandaloneHq({ env: env(), log: (line) => lines.push(line) });
    await built!.close();
    const banner = lines.join('\n');
    expect(banner).toContain('NO IDENTITY SOURCE');
    expect(banner).toContain('It is NOT a hosted HQ');
  });
});
