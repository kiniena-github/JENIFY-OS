/**
 * The env-gated HQ host wiring and the Founder-gated same-origin site
 * (issue #200, integration lane).
 *
 * `headquarter-control.test.ts` proves the control API over real HTTP with a
 * hand-built plane. This suite proves the two pieces the integration lane
 * added around it:
 *
 *   1. `loadHeadquarterHost` — OFF by default, ON only through deliberate
 *      environment configuration, and fail-closed on every partial or broken
 *      configuration (missing DB path, broken Founder map JSON), with the
 *      environment narrowed to declared provider facts.
 *   2. `/hq/` static serving — same-origin with the API so `fos_session`
 *      and the control API actually reach the pages, gated on the SAME
 *      Founder resolution the control API enforces: anonymous 401, signed-in
 *      non-Founder 403, mapped Founder 200, and `no-store` everywhere.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadHeadquarterHost, observableProviderFacts } from '../src/services/headquarter-host.js';
import { createUser } from '../src/services/users.js';
import { createRole } from '../src/services/permissions.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { openMemoryHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';

let db: Db;
let tenant: TestTenant;
let founderUserId: string;

beforeEach(() => {
  db = testDb();
  tenant = makeTestTenant(db, 'SALTB');
  founderUserId = createUser(tenant.sysCtx, {
    username: 'founder.saltb',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
  const staffRoleId = createRole(tenant.sysCtx, {
    code: 'staff',
    name: 'Staff',
    matrix: matrixOf([['inventory', ['view']]]),
  });
  createUser(tenant.sysCtx, {
    username: 'staff.saltb',
    displayName: 'Warehouse Lead',
    password: 'test-password',
    roleId: staffRoleId,
  });
});

function plane() {
  const hqDb = openMemoryHqDatabase();
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });
  // The SAME registry the ops facade authorizes against, reached through the
  // shared database — never a second source of truth.
  const principals = new HumanPrincipalRegistry(hqDb);
  return {
    ops,
    principals,
    founderMap: [{ realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' }],
    allowedOrigins: ['http://localhost:3001'],
    secretsEnv: {},
  };
}

function siteDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hq-site-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>JENIFY HQ</title>');
  writeFileSync(join(dir, 'hq-snapshot.json'), '{"generatedAt":"2026-08-28T00:00:00Z","mode":"sample"}');
  return dir;
}

async function signIn(instance: ReturnType<typeof buildApp>, username: string): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === 'fos_session')!;
  return `fos_session=${cookie.value}`;
}

/* ------------------------------------------------------------------ */
/* The env loader is OFF by default and fail-closed                    */
/* ------------------------------------------------------------------ */

describe('loadHeadquarterHost', () => {
  const silent = () => {};

  it('returns null for an unconfigured environment — the Mesob pilot shape', () => {
    expect(loadHeadquarterHost({}, silent)).toBeNull();
    expect(loadHeadquarterHost({ FACTORYOS_HQ_DB: '/tmp/x.sqlite' }, silent)).toBeNull();
  });

  it('treats anything but the literal "1" as off', () => {
    for (const value of ['true', 'yes', 'on', '0', '']) {
      expect(loadHeadquarterHost({ FACTORYOS_HQ_CONTROL: value }, silent)).toBeNull();
    }
  });

  it('stays off, loudly, when the switch is on but no database path was chosen', () => {
    const lines: string[] = [];
    const host = loadHeadquarterHost({ FACTORYOS_HQ_CONTROL: '1' }, (line) => lines.push(line));
    expect(host).toBeNull();
    expect(lines.join('\n')).toContain('FACTORYOS_HQ_DB is not set');
  });

  it('builds a read-only plane by default: mutations require their own explicit flag', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hq-db-')), 'hq.sqlite');
    const host = loadHeadquarterHost(
      { FACTORYOS_HQ_CONTROL: '1', FACTORYOS_HQ_DB: dbPath },
      silent,
    );
    expect(host).not.toBeNull();
    expect(host!.plane.mutationsEnabled).toBe(false);
    expect(host!.plane.allowedOrigins).toEqual([]);
    expect(host!.plane.founderMap).toBeNull();
    expect(host!.siteRoot).toBeUndefined();
  });

  it('passes a broken Founder map through raw so the boundary refuses it visibly', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hq-db-')), 'hq.sqlite');
    const lines: string[] = [];
    const host = loadHeadquarterHost(
      {
        FACTORYOS_HQ_CONTROL: '1',
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_FOUNDER_MAP: '{not json',
      },
      (line) => lines.push(line),
    );
    expect(host!.plane.founderMap).toBe('{not json');
    expect(lines.join('\n')).toContain('not valid JSON');
  });

  it('narrows the environment to declared provider facts — nothing else travels', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hq-db-')), 'hq.sqlite');
    const facts = observableProviderFacts();
    expect(facts.length).toBeGreaterThan(0);
    const host = loadHeadquarterHost(
      {
        FACTORYOS_HQ_CONTROL: '1',
        FACTORYOS_HQ_DB: dbPath,
        [facts[0]!]: 'present',
        SOME_UNRELATED_SECRET: 'must-not-travel',
        PATH: '/usr/bin',
      },
      silent,
    );
    expect(host!.plane.secretsEnv[facts[0]!]).toBe('present');
    expect(host!.plane.secretsEnv).not.toHaveProperty('SOME_UNRELATED_SECRET');
    expect(host!.plane.secretsEnv).not.toHaveProperty('PATH');
  });

  it('parses origins and the mutation flag only from their own explicit variables', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hq-db-')), 'hq.sqlite');
    const host = loadHeadquarterHost(
      {
        FACTORYOS_HQ_CONTROL: '1',
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_ALLOWED_ORIGINS: ' http://localhost:3001 , https://hq.example ',
        FACTORYOS_HQ_MUTATIONS: '1',
      },
      silent,
    );
    expect(host!.plane.allowedOrigins).toEqual(['http://localhost:3001', 'https://hq.example']);
    expect(host!.plane.mutationsEnabled).toBe(true);
  });

  it('refuses a site directory that does not exist rather than serving nothing silently', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'hq-db-')), 'hq.sqlite');
    const lines: string[] = [];
    const host = loadHeadquarterHost(
      {
        FACTORYOS_HQ_CONTROL: '1',
        FACTORYOS_HQ_DB: dbPath,
        FACTORYOS_HQ_SITE_DIR: '/nonexistent/hq-site',
      },
      (line) => lines.push(line),
    );
    expect(host!.siteRoot).toBeUndefined();
    expect(lines.join('\n')).toContain('does not exist');
  });
});

/* ------------------------------------------------------------------ */
/* Same-origin static serving, Founder-gated                           */
/* ------------------------------------------------------------------ */

describe('the /hq/ static site', () => {
  it('does not exist on an ordinary tenant deployment', async () => {
    const instance = buildApp({ db });
    const response = await instance.inject({ method: 'GET', url: '/hq/index.html' });
    expect(response.statusCode).toBe(404);
  });

  it('cannot be served without the control plane it is gated by', () => {
    expect(() =>
      buildApp({ db, headquarterSite: { root: siteDir() } } as AppOptions),
    ).toThrowError(/requires the headquarter control plane/);
  });

  it('refuses anonymous requests with 401 and the static handler never runs', async () => {
    const instance = buildApp({ db, headquarter: plane(), headquarterSite: { root: siteDir() } });
    const response = await instance.inject({ method: 'GET', url: '/hq/index.html' });
    expect(response.statusCode).toBe(401);
    // The refusal is the hook's OWN body — proof the chain stopped there and
    // the static handler never ran: the refusal text is present, and not one
    // byte of the page (or its doctype) is.
    expect(response.body).toContain('HQ access refused');
    expect(response.body).not.toContain('JENIFY HQ');
    expect(response.body).not.toContain('<!doctype');
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses the snapshot to anonymous callers the same way', async () => {
    const instance = buildApp({ db, headquarter: plane(), headquarterSite: { root: siteDir() } });
    const response = await instance.inject({ method: 'GET', url: '/hq/hq-snapshot.json' });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('HQ access refused');
    expect(response.body).not.toContain('generatedAt');
  });

  it('refuses a signed-in non-Founder with 403 — authenticated is not authorized', async () => {
    const instance = buildApp({ db, headquarter: plane(), headquarterSite: { root: siteDir() } });
    const staff = await signIn(instance, 'staff.saltb');
    const response = await instance.inject({
      method: 'GET',
      url: '/hq/index.html',
      headers: { cookie: staff },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('HQ access refused');
    expect(response.body).not.toContain('JENIFY HQ');
    expect(response.body).not.toContain('<!doctype');
  });

  it('refuses even the Founder account while the map binds a principal the registry does not hold', async () => {
    // The plane above maps the account to principal 'founder', which is NOT
    // registered in the fresh HQ database — the binding must open nothing.
    const instance = buildApp({ db, headquarter: plane(), headquarterSite: { root: siteDir() } });
    const founder = await signIn(instance, 'founder.saltb');
    const response = await instance.inject({
      method: 'GET',
      url: '/hq/index.html',
      headers: { cookie: founder },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('not registered');
    expect(response.body).not.toContain('JENIFY HQ');
    expect(response.body).not.toContain('<!doctype');
  });

  it('serves the pages and the snapshot to the mapped, registered Founder, uncached', async () => {
    const hqPlane = plane();
    hqPlane.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    });
    const instance = buildApp({ db, headquarter: hqPlane, headquarterSite: { root: siteDir() } });
    const founder = await signIn(instance, 'founder.saltb');

    const page = await instance.inject({
      method: 'GET',
      url: '/hq/index.html',
      headers: { cookie: founder },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('JENIFY HQ');
    expect(page.headers['cache-control']).toBe('no-store');

    const snapshot = await instance.inject({
      method: 'GET',
      url: '/hq/hq-snapshot.json',
      headers: { cookie: founder },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(JSON.parse(snapshot.body).mode).toBe('sample');
    expect(snapshot.headers['cache-control']).toBe('no-store');
  });
});
