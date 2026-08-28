/**
 * The narrow HQ browser-control API, end to end against the real canonical
 * machinery (issue #200, Founder decision of 2026-08-28).
 *
 * `live-auth.test.ts` proves the boundary in isolation. This suite proves the
 * things that can only be wrong once the boundary is WIRED: that the acting
 * principal reaching `HeadquarterOperations` is the mapped one and never a
 * caller's, that a mapped Founder genuinely creates a canonical Operator task
 * through the existing facade, that no canonical rule (no-self-approval,
 * digest binding, provider binding, deny-by-default, idempotency) is loosened
 * by having a browser in front of it, and that nothing secret leaves.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { founderConsole } from '../src/application/console.js';
import { EXECUTION_PROVIDER_KEY } from '../src/operator/provider-binding.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-08-28T16:00:00.000Z');
/** A session established one minute ago: fresh enough to satisfy step-up. */
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
/** A session established yesterday: step-up will demand a password. */
const STALE = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

const FOUNDER_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-founder',
  displayName: 'Founder',
  authenticatedAt: FRESH,
};
const STAFF_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-staff',
  displayName: 'Warehouse Lead',
  authenticatedAt: FRESH,
};
const MAP = [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }];

interface Harness {
  fixture: Fixture;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
  deps: ControlApiDeps;
}

function harness(
  options: {
    account?: AuthenticatedAccount | null;
    founderMap?: unknown;
    origins?: string[];
    password?: string;
    /** Grant the Founder principal origination for the direct-order capability. */
    grant?: boolean;
  } = {},
): Harness {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  const principals = new HumanPrincipalRegistry(fixture.db);
  principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: options.grant === false ? [] : [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  principals.register({
    id: 'coo',
    displayName: 'Chief Operating Officer',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });

  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    principals,
    founderMap: options.founderMap ?? MAP,
    allowedOrigins: options.origins ?? [ORIGIN],
    secretsEnv: CLAUDE_ONLY,
    sessions: { resolve: () => current },
    credentials: { verify: (_a, p) => p === (options.password ?? 'correct-horse') },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
  };

  return {
    fixture,
    audit,
    deps,
    call(request, account) {
      if (account !== undefined) current = account;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.orders, headers, body: request.body },
        deps,
      );
    },
  };
}

const ORDER_BODY = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  route: 'CLAUDE',
  project: 'mesob',
  title: 'Q3 maintenance plan',
};

describe('a mapped Founder creates a canonical order, and only through the facade', () => {
  it('creates a needs_approval Operator task attributed to the mapped principal', () => {
    const h = harness();
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.requiresFounderApproval).toBe(true);

    const task = h.fixture.ops.queue.get(response.body.taskId as string)!;
    expect(task.status).toBe('needs_approval');
    expect(task.capabilityId).toBe(DIRECT_ORDER_CAPABILITY.id);
    // The acting principal came from the map, not from anything the caller sent.
    expect(task.createdBy).toBe('founder');
    // Provider binding survives the browser hop: the queue will refuse any
    // worker not declared as this provider.
    expect(task.payload[EXECUTION_PROVIDER_KEY]).toBe('CLAUDE');
  });

  it('records the authenticated marker on the canonical task, inside the digest', () => {
    const h = harness();
    const response = h.call({ body: ORDER_BODY });
    const task = h.fixture.ops.queue.get(response.body.taskId as string)!;
    // The one interface entitled to claim authentication says so — and says it
    // in the payload, so an approver reads it and it cannot be edited between
    // rendering and approval.
    expect(task.payload.actorAuthentication).toBe('authenticated_os_session');
  });

  it('never publishes the instruction text back to the browser', () => {
    const h = harness();
    const created = h.call({ body: ORDER_BODY });
    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.approvals });
    const serialized = JSON.stringify([created.body, listed.body]);
    expect(serialized).not.toContain('Q3 maintenance plan for the Mesob line');
    // The chosen title is published — that is what choosing one means.
    expect(serialized).toContain('Q3 maintenance plan');
  });

  it('deduplicates a double-submitted order onto one canonical task', () => {
    const h = harness();
    const first = h.call({ body: ORDER_BODY });
    const second = h.call({ body: ORDER_BODY });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.taskId).toBe(first.body.taskId);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(1);
  });

  it('refuses an unconnected provider and creates nothing', () => {
    const h = harness();
    h.deps.secretsEnv = {};
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'provider_not_connected' } });
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('never substitutes one provider for another', () => {
    const h = harness();
    // Codex asked for explicitly; only Claude is connected.
    const response = h.call({ body: { ...ORDER_BODY, route: 'CODEX' } });
    expect(response.status).toBe(409);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('still obeys deny-by-default when the principal holds no origination grant', () => {
    const h = harness({ grant: false });
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(403);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});

describe('every hostile caller is refused, and nothing is written', () => {
  const attempts: Array<{
    name: string;
    build: () => Harness;
    request?: Partial<ControlRequest>;
    status: number;
    code: string;
  }> = [
    {
      name: 'unauthenticated',
      build: () => harness({ account: null }),
      status: 401,
      code: 'unauthenticated',
    },
    {
      name: 'authenticated but not the Founder',
      build: () => harness({ account: STAFF_ACCOUNT }),
      status: 403,
      code: 'not_founder',
    },
    {
      name: 'no Founder bound at all',
      build: () => harness({ founderMap: [] }),
      status: 403,
      code: 'founder_map_unconfigured',
    },
    {
      name: 'malformed Founder map',
      build: () => harness({ founderMap: [{ realmId: 'tenant-1' }] }),
      status: 403,
      code: 'founder_map_malformed',
    },
    {
      name: 'ambiguous Founder map',
      build: () =>
        harness({
          founderMap: [
            { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
            { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'coo' },
          ],
        }),
      status: 403,
      code: 'founder_map_ambiguous',
    },
    {
      name: 'forged client principal',
      build: () => harness(),
      request: { body: { ...ORDER_BODY, requestedBy: 'coo' } },
      status: 400,
      code: 'client_identity_supplied',
    },
    {
      name: 'forged trust marker',
      build: () => harness(),
      request: { body: { ...ORDER_BODY, actorAuthentication: 'authenticated_os_session' } },
      status: 400,
      code: 'client_identity_supplied',
    },
    {
      name: 'cross-site origin',
      build: () => harness(),
      request: {
        body: ORDER_BODY,
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      },
      status: 403,
      code: 'origin_not_allowed',
    },
    {
      name: 'cross-site form post',
      build: () => harness(),
      request: {
        body: ORDER_BODY,
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      },
      status: 403,
      code: 'content_type_not_json',
    },
    {
      name: 'no trusted origin configured',
      build: () => harness({ origins: [] }),
      request: { body: ORDER_BODY },
      status: 403,
      code: 'origin_allowlist_empty',
    },
  ];

  for (const attempt of attempts) {
    it(`refuses: ${attempt.name}`, () => {
      const h = attempt.build();
      const response = h.call(attempt.request ?? { body: ORDER_BODY });
      expect(response.status).toBe(attempt.status);
      expect((response.body.error as { code: string }).code).toBe(attempt.code);
      // The real proof: no canonical task exists afterwards.
      expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
      expect(h.fixture.ops.queue.listByStatus('queued')).toHaveLength(0);
    });
  }

  it('refuses an unknown route without revealing what does exist', () => {
    const h = harness();
    for (const path of ['/api/hq/control', '/api/hq/control/tasks', '/api/hq/control/approvals/x']) {
      const response = h.call({ method: 'GET', path });
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('orders');
    }
  });

  it('exposes no generic mutation surface — the whole route table is five entries', () => {
    expect(Object.values(CONTROL_ROUTES).sort()).toEqual([
      '/api/hq/control/approvals',
      '/api/hq/control/approvals/approve',
      '/api/hq/control/approvals/deny',
      '/api/hq/control/orders',
      '/api/hq/control/session',
    ]);
  });
});

describe('approval keeps every canonical rule it had before the browser', () => {
  /** Open an order as the COO so the Founder may legitimately approve it. */
  function orderFromAnotherPrincipal(h: Harness): { taskId: string; digest: string } {
    h.fixture.principals.register({
      id: 'coo',
      displayName: 'Chief Operating Officer',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const created = h.fixture.ops.createTask({
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      payload: { kind: 'direct_order', instruction: 'x', [EXECUTION_PROVIDER_KEY]: 'CLAUDE' },
      idempotencyKey: 'coo-order-1',
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const card = founderConsole(h.fixture.ops, NOW).approvals.find(
      (entry) => entry.taskId === created.data.task.id,
    )!;
    return { taskId: card.taskId, digest: card.actionDigest };
  }

  it('refuses self-approval even for a correctly authenticated Founder', () => {
    const h = harness();
    const created = h.call({ body: ORDER_BODY });
    const card = founderConsole(h.fixture.ops, NOW).approvals[0]!;
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId: created.body.taskId, expectedActionDigest: card.actionDigest },
    });
    expect(response.status).toBe(403);
    expect(h.fixture.ops.queue.get(created.body.taskId as string)!.status).toBe('needs_approval');
  });

  it('refuses an approval whose digest no longer matches the action', () => {
    const h = harness();
    const { taskId } = orderFromAnotherPrincipal(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: 'a'.repeat(64) },
    });
    expect(response.status).toBe(409);
    expect((response.body.error as { code: string }).code).toBe('action_digest_mismatch');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('demands step-up for a founder_gate approval on a stale session', () => {
    const h = harness();
    const { taskId, digest } = orderFromAnotherPrincipal(h);
    const stale = { ...FOUNDER_ACCOUNT, authenticatedAt: STALE };
    const refused = h.call(
      { path: CONTROL_ROUTES.approve, body: { taskId, expectedActionDigest: digest } },
      stale,
    );
    expect(refused.status).toBe(401);
    expect((refused.body.error as { code: string }).code).toBe('step_up_required');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');

    const wrong = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest, stepUpPassword: 'nope' },
    });
    expect((wrong.body.error as { code: string }).code).toBe('step_up_failed');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');

    const ok = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest, stepUpPassword: 'correct-horse' },
    });
    expect(ok.status).toBe(200);
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('accepts a fresh session as its own step-up', () => {
    const h = harness();
    const { taskId, digest } = orderFromAnotherPrincipal(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest },
    });
    expect(response.status).toBe(200);
  });

  it('never lets a step-up password reach the browser or the audit log', () => {
    const h = harness();
    const { taskId, digest } = orderFromAnotherPrincipal(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest, stepUpPassword: 'correct-horse' },
    });
    const everything = JSON.stringify([response.body, h.audit]);
    expect(everything).not.toContain('correct-horse');
  });

  it('denies with a reason, and a denial needs no step-up', () => {
    // Making it harder to STOP something than to allow it would be backwards.
    const h = harness();
    const { taskId, digest } = orderFromAnotherPrincipal(h);
    const stale = { ...FOUNDER_ACCOUNT, authenticatedAt: STALE };
    const response = h.call(
      {
        path: CONTROL_ROUTES.deny,
        body: { taskId, reason: 'Out of scope this quarter', expectedActionDigest: digest },
      },
      stale,
    );
    expect(response.status).toBe(200);
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('blocked');
  });

  it('refuses an approval for a task that does not exist', () => {
    const h = harness();
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId: 'no-such-task', expectedActionDigest: 'x' },
    });
    expect(response.status).toBe(404);
  });
});

describe('what the console is told about itself', () => {
  it('tells a signed-in non-Founder that they are signed in and the controls are off', () => {
    const h = harness({ account: STAFF_ACCOUNT });
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, founder: false, reason: 'not_founder' });
    // It must not reveal WHICH account is the Founder.
    expect(JSON.stringify(response.body)).not.toContain('user-founder');
  });

  it('answers 401 for a caller with no session at all', () => {
    const h = harness({ account: null });
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ authenticated: false, founder: false });
  });

  it('reports ask-for-changes as unavailable, with the reason, rather than drawing it', () => {
    const h = harness();
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    const controls = response.body.controls as Record<string, unknown>;
    expect(controls.askForChanges).toBe(false);
    expect(String(controls.askForChangesReason)).toContain('approve or deny only');
    expect(controls.directOrder).toBe(true);
  });

  it('reports the direct-order control as off when the capability is not registered', () => {
    const h = harness();
    h.fixture.ops.queue.capabilities.setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((response.body.controls as Record<string, unknown>).directOrder).toBe(false);
  });

  it('marks an approval the Founder may not give, before they try', () => {
    const h = harness();
    h.call({ body: ORDER_BODY });
    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.approvals });
    const approvals = listed.body.approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.selfApproval).toBe(true);
    expect(approvals[0]!.stepUpRequired).toBe(true);
    expect(approvals[0]!.actionDigest).toEqual(expect.any(String));
  });

  it('audits allowed and refused privileged activity without any credential', () => {
    const h = harness();
    h.call({ body: ORDER_BODY });
    h.call({ body: ORDER_BODY }, null);
    expect(h.audit.map((event) => event.detail)).toEqual(['order_created', 'unauthenticated']);
    expect(h.audit[0]).toMatchObject({ outcome: 'allowed', principalId: 'founder' });
    // An unresolved caller is audited with no account fields at all.
    expect(h.audit[1]!.accountId).toBeUndefined();
    for (const event of h.audit) {
      expect(Object.keys(event)).not.toContain('body');
      expect(Object.keys(event)).not.toContain('token');
    }
  });
});

describe('the browser-safety guard runs on the way out', () => {
  it('refuses to emit a response carrying a credential-shaped value', () => {
    const h = harness();
    // A title that looks like a secret is refused BEFORE the write, by the
    // same guard the snapshot uses — so it can never reach a response either.
    const response = h.call({
      body: { ...ORDER_BODY, title: 'sk-lLveryLongLookingSecretValue0123456789abcd' },
    });
    expect(response.body.ok).toBe(false);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});
