/**
 * Host wiring for LIVE HQ CONTROL V1 (issue #200 integration).
 *
 * `headquarter-control.test.ts` proves the authentication boundary over real
 * HTTP. This suite proves the three links that make the flow reachable in a
 * real process — env-gated control plane, same-origin static site, and the
 * contract the browser console depends on — plus the hostile cases the
 * integration adds:
 *
 *   - the plane is OFF by default and every knob fails closed;
 *   - forged identity in HEADERS is ignored on top of the body scan;
 *   - create-order idempotency over HTTP (retry-safe, deliberate-second-order);
 *   - an unavailable provider is a truthful 409 with no substitution;
 *   - a created founder_gate order does not execute, and self-approval and
 *     registry-only partial grants are refused with the session route
 *     advertising exactly what the write routes will allow.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  observableSecretsEnv,
  resolveHeadquarterEnv,
  resolveHeadquarterSite,
} from '../src/hq-host.js';
import { createUser } from '../src/services/users.js';
import { createRole } from '../src/services/permissions.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { openMemoryHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { HeadquarterOperations, HumanPrincipalRegistry } from '@factoryos/headquarter/application';
import {
  registerDirectOrderCapability,
  DIRECT_ORDER_CAPABILITY,
  loadFounderBindings,
} from '@factoryos/headquarter/live';

const ORIGIN = 'http://localhost:3001';
const JSON_HEADERS = { origin: ORIGIN, 'content-type': 'application/json' };
/** Claude genuinely dispatchable; Codex genuinely not. Facts, not fabrication. */
const SECRETS = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

let db: Db;
let tenant: TestTenant;
let founderUserId: string;

interface Plane {
  ops: HeadquarterOperations;
  principals: HumanPrincipalRegistry;
}

function hqPlane(principal: { approvalAuthority?: boolean; originate?: boolean } = {}): Plane {
  const hqDb = openMemoryHqDatabase();
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });
  registerDirectOrderCapability(ops);
  const principals = new HumanPrincipalRegistry(hqDb);
  principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: principal.originate === false ? [] : [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: principal.approvalAuthority !== false,
    active: true,
  });
  return { ops, principals };
}

function app(plane: Plane, overrides: Record<string, unknown> = {}) {
  return buildApp({
    db,
    headquarter: {
      ops: plane.ops,
      founderMap: [{ realmId: tenant.tenantId, accountId: founderUserId, principalId: 'founder' }],
      allowedOrigins: [ORIGIN],
      secretsEnv: SECRETS,
      ...overrides,
    },
  });
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

const ORDER = {
  instruction: 'Summarise this week’s Mesob production evidence for review.',
  route: 'CLAUDE',
  title: 'Weekly evidence summary',
};

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

/* ------------------------------------------------------------------ */
/* Env gating                                                          */
/* ------------------------------------------------------------------ */

describe('the control plane is env-gated and off by default', () => {
  it('resolves to nothing unless FACTORYOS_HQ_CONTROL is explicitly on', () => {
    for (const env of [
      {},
      { FACTORYOS_HQ_CONTROL: '' },
      { FACTORYOS_HQ_CONTROL: '0' },
      { FACTORYOS_HQ_CONTROL: 'false' },
      { FACTORYOS_HQ_CONTROL: 'anything-else' },
      // Configuring everything BUT the switch still serves nothing: the
      // deliberate act is the switch, not the surrounding configuration.
      {
        FACTORYOS_HQ_FOUNDER_MAP: '[]',
        FACTORYOS_HQ_ORIGINS: ORIGIN,
        FACTORYOS_HQ_SITE: '/tmp',
      },
    ]) {
      expect(resolveHeadquarterEnv(env as NodeJS.ProcessEnv), JSON.stringify(env)).toBeNull();
    }
  });

  it('starts with nobody bound and no trusted origin when enabled bare', () => {
    const config = resolveHeadquarterEnv({ FACTORYOS_HQ_CONTROL: '1' } as NodeJS.ProcessEnv)!;
    expect(config).not.toBeNull();
    expect(config.founderMap).toEqual([]);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.notices.join(' ')).toContain('no account is bound');
    expect(config.notices.join(' ')).toContain('origin allow-list is empty');
    // An empty map is VALID and authenticates nobody — the boundary's rule.
    const parsed = loadFounderBindings(config.founderMap);
    expect(parsed).toEqual({ ok: true, bindings: [] });
  });

  it('passes a malformed Founder map through RAW so the boundary refuses it whole', () => {
    const config = resolveHeadquarterEnv({
      FACTORYOS_HQ_CONTROL: '1',
      FACTORYOS_HQ_FOUNDER_MAP: '{not json',
    } as NodeJS.ProcessEnv)!;
    expect(config.founderMap).toBe('{not json');
    const parsed = loadFounderBindings(config.founderMap);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('malformed');
    expect(config.notices.join(' ')).toContain('not valid JSON');
  });

  it('parses origins and the read-only switch', () => {
    const config = resolveHeadquarterEnv({
      FACTORYOS_HQ_CONTROL: 'true',
      FACTORYOS_HQ_ORIGINS: ` ${ORIGIN} , https://hq.example ,, `,
      FACTORYOS_HQ_MUTATIONS: '0',
      FACTORYOS_HQ_DB: ' /tmp/hq-test.sqlite ',
    } as NodeJS.ProcessEnv)!;
    expect(config.allowedOrigins).toEqual([ORIGIN, 'https://hq.example']);
    expect(config.mutationsEnabled).toBe(false);
    expect(config.dbPath).toBe('/tmp/hq-test.sqlite');
  });

  it('observes only catalogued fact NAMES from the environment, never the rest', () => {
    const observed = observableSecretsEnv({
      CLAUDE_ROUTINE_URL: 'https://internal',
      CLAUDE_ROUTINE_TOKEN: 'tok',
      PATH: '/usr/bin',
      HOME: '/root',
      SOME_UNRELATED_SECRET: 'x',
    } as NodeJS.ProcessEnv);
    expect(Object.keys(observed)).toContain('CLAUDE_ROUTINE_URL');
    expect(Object.keys(observed)).not.toContain('PATH');
    expect(Object.keys(observed)).not.toContain('HOME');
    expect(Object.keys(observed)).not.toContain('SOME_UNRELATED_SECRET');
  });
});

/* ------------------------------------------------------------------ */
/* Same-origin site mount                                              */
/* ------------------------------------------------------------------ */

describe('the same-origin HQ site mount', () => {
  function builtSiteDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hq-site-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>JENIFY HQ — Command Center</title>');
    writeFileSync(join(dir, 'hq-snapshot.json'), '{"mode":"sample"}');
    return dir;
  }

  it('serves the built site under /hq/ without touching existing routes', async () => {
    const dir = builtSiteDir();
    const instance = buildApp({ db, headquarterSite: { root: dir } });
    const page = await instance.inject({ method: 'GET', url: '/hq/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('JENIFY HQ');
    const snapshot = await instance.inject({ method: 'GET', url: '/hq/hq-snapshot.json' });
    expect(snapshot.statusCode).toBe(200);
    const redirect = await instance.inject({ method: 'GET', url: '/hq' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/hq/');
    // Nothing shadowed: health and the API answer exactly as before.
    const health = await instance.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, service: 'factoryos' });
  });

  it('an ordinary deployment serves no /hq/ at all', async () => {
    const instance = buildApp({ db });
    const page = await instance.inject({ method: 'GET', url: '/hq/' });
    expect(page.statusCode).toBe(404);
  });

  it('fails gracefully and truthfully when the site build is absent', () => {
    const missing = resolveHeadquarterSite({
      FACTORYOS_HQ_SITE: '/nonexistent/site-dir',
    } as NodeJS.ProcessEnv);
    expect(missing.site).toBeNull();
    expect(missing.notices.join(' ')).toContain('NOT being served');
    expect(missing.notices.join(' ')).toContain('build:site');

    const empty = mkdtempSync(join(tmpdir(), 'hq-empty-'));
    const noIndex = resolveHeadquarterSite({ FACTORYOS_HQ_SITE: empty } as NodeJS.ProcessEnv);
    expect(noIndex.site).toBeNull();
    expect(noIndex.notices.join(' ')).toContain('no index.html');

    const unset = resolveHeadquarterSite({} as NodeJS.ProcessEnv);
    expect(unset.site).toBeNull();
    expect(unset.notices).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Hostile identity, everywhere a client could put one                 */
/* ------------------------------------------------------------------ */

describe('no client-supplied principal is trusted, in body OR headers', () => {
  const FORGED_HEADERS = {
    'x-principal-id': 'founder',
    'x-founder-id': 'founder',
    'x-hq-principal': 'founder',
    'x-actor': 'founder',
    'x-user-id': 'anything',
  };

  it('ignores forged identity headers from an anonymous caller', async () => {
    const instance = app(hqPlane());
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, ...FORGED_HEADERS },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(401);
  });

  it('ignores forged identity headers from a signed-in non-Founder', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const staff = await signIn(instance, 'staff.saltb');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, ...FORGED_HEADERS, cookie: staff },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('not_founder');
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('attributes the real Founder from the session even under contradictory headers', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, 'x-principal-id': 'somebody-else', cookie: founder },
      payload: ORDER,
    });
    expect(response.statusCode).toBe(201);
    const tasks = plane.ops.queue.listByStatus('needs_approval');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.createdBy).toBe('founder'); // from the map, never the header
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency over HTTP                                               */
/* ------------------------------------------------------------------ */

describe('create-order idempotency over real HTTP', () => {
  it('deduplicates an identical retry and keeps exactly one canonical task', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');
    const submit = () =>
      instance.inject({
        method: 'POST',
        url: '/api/hq/control/orders',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { ...ORDER, idempotencyKey: 'browser-key-1' },
      });

    const first = await submit();
    expect(first.statusCode).toBe(201);
    expect(first.json().deduplicated).toBe(false);

    const second = await submit();
    expect(second.statusCode).toBe(200);
    expect(second.json().deduplicated).toBe(true);
    expect(second.json().taskId).toBe(first.json().taskId);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(1);
  });

  it('treats a different client key as a deliberate second order', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');
    for (const key of ['browser-key-1', 'browser-key-2']) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/hq/control/orders',
        headers: { ...JSON_HEADERS, cookie: founder },
        payload: { ...ORDER, idempotencyKey: key },
      });
      expect(response.statusCode).toBe(201);
    }
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Truthful blocking, gating, and authority                            */
/* ------------------------------------------------------------------ */

describe('provider unavailability, approval gating and authority stay canonical over HTTP', () => {
  it('refuses an unconnected provider with a truthful 409 and substitutes nothing', async () => {
    const plane = hqPlane();
    const instance = app(plane); // secretsEnv names only CLAUDE facts
    const founder = await signIn(instance, 'founder.saltb');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { ...ORDER, route: 'CODEX' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe('provider_not_connected');
    expect(body.error.message).toContain('blocked');
    // Candidate verdicts name missing FACTS, never values, and never Claude.
    expect(JSON.stringify(body.route)).toContain('CODEX');
    expect(JSON.stringify(body.route)).not.toContain('present');
    // NOTHING was created — not for CODEX, and not silently for CLAUDE.
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('refuses an unknown route outright (deny by default)', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');
    const response = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { ...ORDER, route: 'GEMINI' },
    });
    expect(response.statusCode).toBe(400);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('parks a created order behind Founder approval and refuses self-approval', async () => {
    const plane = hqPlane();
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');
    const created = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(created.statusCode).toBe(201);
    const { taskId, actionDigest, requiresFounderApproval } = created.json();
    expect(requiresFounderApproval).toBe(true);
    expect(plane.ops.queue.get(taskId)!.status).toBe('needs_approval');

    // The creator's own (fresh) session may NOT approve its own order.
    const approve = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/approvals/approve',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: { taskId, expectedActionDigest: actionDigest },
    });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().error.message).toContain('may not approve its own action');
    // Still unexecuted, still awaiting an independent Founder decision.
    expect(plane.ops.queue.get(taskId)!.status).toBe('needs_approval');

    // And the live approvals list tells the console so before it even tries.
    const list = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/approvals',
      headers: { cookie: founder },
    });
    const card = list.json().approvals.find((entry: { taskId: string }) => entry.taskId === taskId);
    expect(card.selfApproval).toBe(true);
  });

  it('advertises exactly the controls a partially-granted principal holds, and refuses the rest', async () => {
    // Approval authority without the originate grant: the session must not
    // advertise directOrder, and the write route must refuse it — registry
    // authority is never widened by being the mapped Founder.
    const plane = hqPlane({ originate: false });
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');

    const session = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie: founder },
    });
    const controls = session.json().controls;
    expect(controls.directOrder).toBe(false);
    expect(controls.approve).toBe(true);
    expect(controls.deny).toBe(true);

    const order = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(order.statusCode).toBe(403);
    expect(plane.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('advertises no approve/deny for a principal without approval authority, and refuses a deny', async () => {
    const plane = hqPlane({ approvalAuthority: false });
    const instance = app(plane);
    const founder = await signIn(instance, 'founder.saltb');

    const session = await instance.inject({
      method: 'GET',
      url: '/api/hq/control/session',
      headers: { cookie: founder },
    });
    const controls = session.json().controls;
    expect(controls.approve).toBe(false);
    expect(controls.deny).toBe(false);
    expect(controls.directOrder).toBe(true);

    const created = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/orders',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: ORDER,
    });
    expect(created.statusCode).toBe(201);
    const deny = await instance.inject({
      method: 'POST',
      url: '/api/hq/control/approvals/deny',
      headers: { ...JSON_HEADERS, cookie: founder },
      payload: {
        taskId: created.json().taskId,
        expectedActionDigest: created.json().actionDigest,
        reason: 'testing that authority is not widened',
      },
    });
    expect(deny.statusCode).toBe(403);
    expect(plane.ops.queue.get(created.json().taskId)!.status).toBe('needs_approval');
  });
});
