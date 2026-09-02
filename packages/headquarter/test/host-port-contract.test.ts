/**
 * The host port contract (Phase 2, Stage 0).
 *
 * ## Why this suite exists
 *
 * Until now exactly one host existed — `@factoryos/server` — so "the contract"
 * and "what the server happens to do" were the same sentence. Phase 2 breaks
 * that: `@factoryos/hq-host` serves HQ without the tenant platform, and a
 * desktop shell will host the same core again later. Three hosts, one set of
 * obligations, and nothing yet stating them.
 *
 * This file states them, against `handleControlRequest` and with no framework
 * anywhere. `live-auth.test.ts` already proves the auth HELPERS in isolation;
 * this is deliberately a level up — the obligations a host takes on when it
 * wires those helpers together, which is the layer a new host actually gets
 * wrong. `packages/hq-host/test/host-contract.test.ts` runs the same
 * obligations through Fastify, so the two cannot drift.
 *
 * ## The obligations
 *
 * 1. Supply a session port, and let it be asked on EVERY request.
 * 2. Never let identity arrive from the caller.
 * 3. Optional ports are optional, but their absence fails CLOSED.
 * 4. One `mutationsEnabled` flag decides both what happens and what is claimed.
 * 5. Provider secret VALUES never leave; only names and presence do.
 * 6. An omitted `dispatchAvailability` is ignorance, not a negative answer.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROL_ROUTES,
  handleControlRequest,
  type ControlApiDeps,
} from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlRequest, SessionResolverPort } from '../src/live/auth.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import { setupFixture } from './application.fixture.js';

const ORIGIN = 'https://hq.example';

const FOUNDER: AuthenticatedAccount = {
  realmId: 'realm',
  accountId: 'acc-1',
  displayName: 'Founder',
  authenticatedAt: new Date().toISOString(),
};

/** A host's wiring, with every knob a host actually controls. */
function host(
  overrides: Partial<ControlApiDeps> = {},
  account: AuthenticatedAccount | null = FOUNDER,
): { deps: ControlApiDeps; sessionCalls: () => number } {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  let calls = 0;
  const sessions: SessionResolverPort = {
    resolve() {
      calls += 1;
      return account;
    },
  };
  return {
    sessionCalls: () => calls,
    deps: {
      ops: fixture.ops,
      sessions,
      founderMap: [{ realmId: 'realm', accountId: 'acc-1', principalId: 'founder' }],
      allowedOrigins: [ORIGIN],
      secretsEnv: {},
      mutationsEnabled: true,
      ...overrides,
    },
  };
}

function get(path: string): ControlRequest {
  return { method: 'GET', path, headers: { referer: `${ORIGIN}/hq/index.html` } };
}

function post(path: string, body: unknown = {}): ControlRequest {
  return {
    method: 'POST',
    path,
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body,
  };
}

describe('obligation 1 — the session port is asked on every request', () => {
  it('refuses every route when no session resolves', () => {
    const { deps } = host({}, null);
    for (const path of Object.values(CONTROL_ROUTES)) {
      const writes = path.includes('approve') || path.includes('deny') || path.endsWith('orders');
      const result = handleControlRequest(writes ? post(path) : get(path), deps);
      expect(result.status, `${path} must not answer an unauthenticated caller`).toBe(401);
    }
  });

  it('answers /session descriptively rather than as an error', () => {
    // `/session` is the probe a page uses to discover its OWN state, so it is
    // the one route that reports the refusal as data: 401, but `ok: true` and
    // an explicit `authenticated: false`. A host must preserve that shape —
    // flattening it into a generic error blinds the console, which then cannot
    // tell "not signed in" from "control plane broken".
    const { deps } = host({}, null);
    const result = handleControlRequest(get(CONTROL_ROUTES.session), deps);
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(true);
    expect(result.body.authenticated).toBe(false);
    expect(result.body.founder).toBe(false);
    expect(result.body.reason).toBe('unauthenticated');
  });

  it('refuses the other routes as errors carrying no state', () => {
    const { deps } = host({}, null);
    for (const path of [CONTROL_ROUTES.approvals, CONTROL_ROUTES.orders, CONTROL_ROUTES.approve, CONTROL_ROUTES.deny]) {
      const writes = path !== CONTROL_ROUTES.approvals;
      const result = handleControlRequest(writes ? post(path) : get(path), deps);
      expect(result.body.ok, `${path} leaked a success shape to a stranger`).toBe(false);
    }
  });

  it('re-asks the port per request rather than caching a decision', () => {
    // The contract requires the resolver to enforce expiry and revocation on
    // every request. A host that resolved once and reused the answer would
    // keep a revoked session alive, and nothing else in the stack would catch
    // it — so the count, not the verdict, is the assertion.
    const { deps, sessionCalls } = host();
    expect(sessionCalls()).toBe(0);
    handleControlRequest(get(CONTROL_ROUTES.session), deps);
    const afterFirst = sessionCalls();
    expect(afterFirst).toBeGreaterThan(0);
    handleControlRequest(get(CONTROL_ROUTES.session), deps);
    expect(sessionCalls()).toBeGreaterThan(afterFirst);
  });
});

describe('obligation 2 — identity never arrives from the caller', () => {
  it('refuses a body that names an actor instead of ignoring it', () => {
    const { deps } = host();
    const result = handleControlRequest(
      post(CONTROL_ROUTES.orders, { principalId: 'founder', instruction: 'x' }),
      deps,
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.ok).toBe(false);
    // Refused, not silently re-attributed: a client that believes it can name
    // an actor has to learn that it cannot.
    expect(JSON.stringify(result.body)).toContain('identity');
  });
});

describe('obligation 3 — absent optional ports fail closed', () => {
  it('answers reads with no credentials port supplied', () => {
    const { deps } = host({ credentials: undefined });
    const result = handleControlRequest(get(CONTROL_ROUTES.session), deps);
    expect(result.status).toBe(200);
    expect(result.body.founder).toBe(true);
  });

  it('never lets a missing credentials port become a passed step-up', () => {
    // A host that omits the port must not thereby SKIP step-up. The whole
    // point of the port being optional is that a host without one can serve
    // reads — not that it can approve irreversible work without a credential.
    const { deps } = host({ credentials: undefined });
    const result = handleControlRequest(
      post(CONTROL_ROUTES.approve, { taskId: 'nonexistent', password: 'anything' }),
      deps,
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.ok).toBe(false);
  });

  it('serves reads with no audit port and no dispatchAvailability', () => {
    const { deps } = host({ audit: undefined, dispatchAvailability: undefined });
    expect(handleControlRequest(get(CONTROL_ROUTES.session), deps).status).toBe(200);
  });
});

describe('obligation 4 — one mutations flag governs both act and claim', () => {
  it('refuses the write AND says the control is unavailable', () => {
    const { deps } = host({ mutationsEnabled: false });
    const session = handleControlRequest(get(CONTROL_ROUTES.session), deps);
    const controls = session.body.controls as Record<string, boolean>;
    // The defect this pins: enforcing the flag in the adapter only left the
    // session route advertising buttons that could only ever fail.
    expect(controls.directOrder).toBe(false);
    const write = handleControlRequest(post(CONTROL_ROUTES.orders, { instruction: 'x' }), deps);
    expect(write.body.ok).toBe(false);
  });

  it('refuses a mutation when the host allow-listed no origin', () => {
    const { deps } = host({ allowedOrigins: [] });
    const result = handleControlRequest(post(CONTROL_ROUTES.orders, { instruction: 'x' }), deps);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.ok).toBe(false);
  });
});

describe('obligation 5 — secret values never leave the host', () => {
  it('never echoes a provider secret value into any response', () => {
    const secret = 'ghp-THIS-VALUE-MUST-NEVER-APPEAR-IN-A-RESPONSE';
    const { deps } = host({ secretsEnv: { CLAUDE_ROUTINE_TOKEN: secret } });
    for (const path of [CONTROL_ROUTES.session, CONTROL_ROUTES.approvals]) {
      const body = JSON.stringify(handleControlRequest(get(path), deps).body);
      expect(body, `${path} leaked a secret value`).not.toContain(secret);
    }
  });
});

describe('obligation 6 — omitted dispatch availability is ignorance, not a No', () => {
  it('still resolves routes when the host observes no transport', () => {
    const { deps } = host({ dispatchAvailability: undefined });
    const result = handleControlRequest(get(CONTROL_ROUTES.session), deps);
    expect(result.status).toBe(200);
    // The routing contract answers instead; the host is not required to know.
    expect(Array.isArray(result.body.routes)).toBe(true);
  });

  it('lets a host that genuinely observes the transport answer for it', () => {
    const { deps } = host({ dispatchAvailability: (p) => (p === 'CLAUDE' ? true : null) });
    const result = handleControlRequest(get(CONTROL_ROUTES.session), deps);
    const routes = result.body.routes as Array<{ requested: string; connected: boolean }>;
    expect(routes.find((r) => r.requested === 'CLAUDE')?.connected).toBe(true);
  });
});
