/**
 * Environment wiring for the HQ control plane (issue #200, integration lane).
 *
 * `headquarter-control.test.ts` proves the boundary over real HTTP. This suite
 * proves the layer ABOVE it: that the plane cannot come into existence without
 * the explicit opt-in, that malformed configuration fails closed with the
 * precise reason visible at the session probe, that mutations stay off until
 * separately enabled, and that the static HQ site is served same-origin only
 * when a control plane exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadHqControlPlane, envFlag, HQ_ENV_VARS } from '../src/hq-control.js';
import { createUser } from '../src/services/users.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { openMemoryHqDatabase } from '@factoryos/headquarter/store';
import {
  registerDirectOrderCapability,
  DIRECT_ORDER_CAPABILITY,
} from '@factoryos/headquarter/live';
import { HumanPrincipalRegistry } from '@factoryos/headquarter/application';

const PORT = 3001;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let db: Db;
let tenant: TestTenant;
let founderUserId: string;

beforeEach(() => {
  _resetRateLimiter();
  db = testDb();
  tenant = makeTestTenant(db, 'SALTB');
  founderUserId = createUser(tenant.sysCtx, {
    username: 'founder.saltb',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
});

function load(env: Record<string, string | undefined>) {
  return loadHqControlPlane(env, { port: PORT, openDb: () => openMemoryHqDatabase() });
}

async function signIn(instance: ReturnType<typeof buildApp>): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'founder.saltb', password: 'test-password' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((c) => c.name === 'fos_session')!;
  return `fos_session=${cookie.value}`;
}

describe('the opt-in flag', () => {
  it('treats only an explicit 1/true as on', () => {
    expect(envFlag('1')).toBe(true);
    expect(envFlag('true')).toBe(true);
    expect(envFlag('TRUE')).toBe(true);
    for (const off of [undefined, '', '0', 'false', 'yes', 'on', 'enabled', ' 1 x']) {
      expect(envFlag(off), String(off)).toBe(false);
    }
  });
});

describe('default OFF — the Mesob pilot shape is untouched', () => {
  it('builds no plane from an empty environment', () => {
    const loaded = load({});
    expect(loaded.headquarter).toBeUndefined();
    expect(loaded.notes.join(' ')).toContain('OFF');
  });

  it('builds no plane when the flag is anything but 1/true', () => {
    for (const value of ['0', 'false', 'yes', 'on']) {
      expect(load({ [HQ_ENV_VARS.enabled]: value }).headquarter, value).toBeUndefined();
    }
  });

  it('a server built without a plane has no HQ route and no /hq/ site', async () => {
    const instance = buildApp({ db });
    const api = await instance.inject({ method: 'GET', url: '/api/hq/control/session' });
    expect(api.statusCode).toBe(404);
    const site = await instance.inject({ method: 'GET', url: '/hq/index.html' });
    expect(site.statusCode).toBe(404);
  });
});

describe('fail-closed configuration', () => {
  it('an unset Founder map is valid-empty: reads up, controls off, precise reason', async () => {
    const loaded = load({ [HQ_ENV_VARS.enabled]: '1' });
    expect(loaded.headquarter).toBeDefined();
    expect(loaded.headquarter!.founderMap).toEqual([]);
    const instance = buildApp({ db, headquarter: loaded.headquarter });
    const cookie = await signIn(instance);
    const session = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.founder).toBe(false);
    expect(body.reason).toBe('founder_map_unconfigured');
  });

  it('a malformed Founder map is passed through RAW and refused as malformed, not repaired', async () => {
    const loaded = load({
      [HQ_ENV_VARS.enabled]: '1',
      [HQ_ENV_VARS.founderMap]: '{not json',
    });
    // The loader must not have "fixed" it into anything the boundary accepts.
    expect(loaded.headquarter!.founderMap).toBe('{not json');
    expect(loaded.notes.join(' ')).toContain('founder_map_malformed');
    const instance = buildApp({ db, headquarter: loaded.headquarter });
    const cookie = await signIn(instance);
    const session = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie },
    });
    expect(session.json().reason).toBe('founder_map_malformed');
    expect(session.json().founder).toBe(false);
  });

  it('mutations stay OFF without their own explicit flag, and the writes really refuse', async () => {
    const loaded = load({
      [HQ_ENV_VARS.enabled]: '1',
      [HQ_ENV_VARS.founderMap]: JSON.stringify([
        { realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' },
      ]),
    });
    expect(loaded.headquarter!.mutationsEnabled).toBe(false);
    // Register the principal + capability so the ONLY thing off is the flag.
    const ops = loaded.headquarter!.ops;
    registerDirectOrderCapability(ops);
    (ops.principals as HumanPrincipalRegistry).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const instance = buildApp({ db, headquarter: loaded.headquarter });
    const cookie = await signIn(instance);

    const session = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie },
    });
    expect(session.json().founder).toBe(true);
    expect(session.json().controls.mutationsEnabled).toBe(false);
    expect(session.json().controls.directOrder).toBe(false);

    const write = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { instruction: 'Anything at all', route: 'AUTO' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('mutations_disabled');
  });

  it('writes work only with BOTH flags plus a valid map, and land in needs_approval', async () => {
    const loaded = load({
      [HQ_ENV_VARS.enabled]: '1',
      [HQ_ENV_VARS.mutationsEnabled]: 'true',
      [HQ_ENV_VARS.founderMap]: JSON.stringify([
        { realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' },
      ]),
      CLAUDE_ROUTINE_URL: 'present',
      CLAUDE_ROUTINE_TOKEN: 'present',
    });
    const ops = loaded.headquarter!.ops;
    registerDirectOrderCapability(ops);
    (ops.principals as HumanPrincipalRegistry).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const instance = buildApp({ db, headquarter: loaded.headquarter });
    const cookie = await signIn(instance);
    const write = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      payload: { instruction: 'Draft the Q3 maintenance plan.', route: 'CLAUDE' },
    });
    expect(write.statusCode).toBe(201);
    const body = write.json();
    expect(body.status).toBe('needs_approval');
    expect(body.requiresFounderApproval).toBe(true);
    expect(typeof body.actionDigest).toBe('string');
  });
});

describe('origins', () => {
  it('defaults to the server’s own origin only', () => {
    const loaded = load({ [HQ_ENV_VARS.enabled]: '1' });
    expect(loaded.headquarter!.allowedOrigins).toEqual([
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
    ]);
  });

  it('uses the explicit list verbatim when configured', () => {
    const loaded = load({
      [HQ_ENV_VARS.enabled]: '1',
      [HQ_ENV_VARS.allowedOrigins]: 'https://hq.example, https://hq2.example',
    });
    expect(loaded.headquarter!.allowedOrigins).toEqual([
      'https://hq.example',
      'https://hq2.example',
    ]);
  });
});

describe('same-origin static site', () => {
  function siteDirWith(html: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    return dir;
  }

  it('serves the built site at /hq/ when the plane names a directory', async () => {
    const dir = siteDirWith('<!doctype html><title>HQ</title>');
    const loaded = load({ [HQ_ENV_VARS.enabled]: '1', [HQ_ENV_VARS.siteDir]: dir });
    expect(loaded.headquarter!.siteDir).toBe(dir);
    const instance = buildApp({ db, headquarter: loaded.headquarter });
    const page = await instance.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>HQ</title>');
    // Directory index too, so /hq/ is the landing URL.
    const index = await instance.inject({ method: 'GET', url: '/hq/' });
    expect(index.statusCode).toBe(200);
  });

  it('declines a missing directory instead of mounting a broken site', () => {
    const loaded = load({
      [HQ_ENV_VARS.enabled]: '1',
      [HQ_ENV_VARS.siteDir]: '/nonexistent/hq-site',
    });
    expect(loaded.headquarter!.siteDir).toBeUndefined();
    expect(loaded.notes.join(' ')).toContain('NOT served');
  });

  it('never serves /hq/ without a control plane, even if a directory exists', async () => {
    // The site is an HQ surface: no plane, no surface. (siteDir sits on the
    // plane type, so this is enforced by construction — asserted here so a
    // refactor cannot quietly detach the two.)
    const instance = buildApp({ db });
    const page = await instance.inject({ method: 'GET', url: '/hq/index.html' });
    expect(page.statusCode).toBe(404);
  });
});
