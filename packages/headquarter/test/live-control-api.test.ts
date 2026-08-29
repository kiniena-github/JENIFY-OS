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
import { founderConsole } from '../src/application/console.js';
import { EXECUTION_PROVIDER_KEY } from '../src/operator/provider-binding.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  MAX_APPROVAL_NOTE_LENGTH,
  MAX_DENIAL_REASON_LENGTH,
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
    /** Make the credential verifier report an exhausted failure budget. */
    rateLimited?: boolean;
    mutationsEnabled?: boolean;
    /** Grant the Founder principal origination for the direct-order capability. */
    grant?: boolean;
  } = {},
): Harness {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  // The ONE registry: identity resolution and authorization both read
  // ops.principals, so the test cannot accidentally prove a property that a
  // second, separately-wired registry would break.
  const principals = fixture.principals;
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
    founderMap: options.founderMap ?? MAP,
    allowedOrigins: options.origins ?? [ORIGIN],
    secretsEnv: CLAUDE_ONLY,
    sessions: { resolve: () => current },
    credentials: {
      verify: (_a, p) =>
        options.rateLimited === true
          ? 'rate_limited'
          : p === (options.password ?? 'correct-horse')
            ? 'ok'
            : 'rejected',
    },
    audit: { record: (event) => audit.push(event) },
    mutationsEnabled: options.mutationsEnabled,
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
        (method === 'GET'
          ? // What a browser actually sends on the console's same-origin
            // session fetch: no `Origin` (same-origin GETs carry none) and the
            // `/hq/` page URL as `Referer` under the default referrer policy.
            // The advertised controls are derived from the REQUESTING origin
            // now, so a test that sends no origin evidence at all is testing
            // an unknown-origin request, not an ordinary console load.
            { referer: `${ORIGIN}/hq/command-center.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
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

  it('creates the order and reports it BLOCKED when the provider cannot dispatch (issue #224)', () => {
    // The browser used to get 409 with op_tasks empty: the order was lost, not
    // blocked. #200's sequence is create-then-report.
    const h = harness();
    h.deps.secretsEnv = {};
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      ok: true,
      dispatchBlocked: true,
      boundProvider: 'CLAUDE',
      status: 'needs_approval',
      requiresFounderApproval: true,
    });
    // Truthful about WHY, in fact names only — never values.
    const route = response.body.route as Record<string, unknown>;
    expect(route.resolved).toBeNull();
    expect(route.missingFacts).toEqual(['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN']);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(1);
    expect(h.fixture.ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('never substitutes one provider for another', () => {
    const h = harness();
    // Codex asked for explicitly; only Claude is connected. The order is
    // recorded — bound to CODEX, blocked — and never routed to Claude.
    const response = h.call({ body: { ...ORDER_BODY, route: 'CODEX' } });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, dispatchBlocked: true, boundProvider: 'CODEX' });
    const created = h.fixture.ops.queue.listByStatus('needs_approval');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ executionProvider: 'CODEX' });
  });

  it('records an AUTO order with nothing connected, blocked on the declared preference', () => {
    const h = harness();
    h.deps.secretsEnv = {};
    const response = h.call({ body: { ...ORDER_BODY, route: 'AUTO' } });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, dispatchBlocked: true, status: 'needs_approval' });
    // Truthful: nothing RESOLVED, even though the order is recorded against a
    // provider — the browser must not read this as an available route.
    expect((response.body.route as Record<string, unknown>).resolved).toBeNull();
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(1);
    expect(h.fixture.ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('carries the blocked state on the live approvals route the console renders', () => {
    // A field that lived only on the polled snapshot was a promise nothing
    // kept: the console fetches GET /approvals, which goes through
    // `approvalView`.
    const h = harness();
    h.deps.secretsEnv = {};
    expect(h.call({ body: ORDER_BODY }).status).toBe(201);

    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.approvals, body: undefined });
    expect(listed.status).toBe(200);
    const approvals = listed.body.approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.dispatchBlocked).toBe(true);
  });

  it('stops reporting the block once a host says the provider is dispatchable', () => {
    const h = harness();
    h.deps.secretsEnv = {};
    // A host holding the real transport answers for its provider, even with no
    // routine secrets in this process.
    h.deps.dispatchAvailability = () => true;
    expect(h.call({ body: ORDER_BODY }).status).toBe(201);

    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.approvals, body: undefined });
    const approvals = listed.body.approvals as Array<Record<string, unknown>>;
    expect(approvals[0]!.dispatchBlocked).toBe(false);
  });

  it('leaks no instruction text into the blocked response', () => {
    const h = harness();
    h.deps.secretsEnv = {};
    const response = h.call({ body: ORDER_BODY });
    expect(JSON.stringify(response.body)).not.toContain(ORDER_BODY.instruction);
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

  it('reports it off — and refuses the POST — when the definition was weakened', () => {
    // Issue #219, Codex P1 on `49da330`. Re-registering the reserved id with a
    // weaker definition takes the Founder gate off the capability the whole
    // path depends on, and reading only the id and the enabled flag could not
    // see it. Both readers must answer the same way here too.
    const h = harness();
    h.fixture.ops.queue.capabilities.register({
      id: DIRECT_ORDER_CAPABILITY.id,
      description: DIRECT_ORDER_CAPABILITY.description,
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls.directOrder).toBe(false);
    const post = h.call({ body: ORDER_BODY });
    // 403, not 400 (issue #219, Codex P2 on `6e5f054`). The order itself is
    // well formed; what refuses it is the server's own registry row.
    expect(post.status).toBe(403);
    expect((post.body.error as { code: string }).code).toBe('capability_definition_altered');
    // Refused before anything was created, and the weakened row is left for a
    // deliberate configuration action to repair — not quietly rewritten here.
    expect(h.fixture.ops.queue.listByStatus('queued')).toEqual([]);
    expect(h.fixture.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)!.riskClass).toBe(
      'read_only',
    );
  });

  // Issue #219, Codex P2 on `6e5f054`. `capability_definition_altered` was
  // missing from the 403 branch, so it fell through to the 400 default and a
  // valid order was reported to the console as MALFORMED. The three
  // capability-state refusals all answer the same question — may this
  // capability be invoked here as it is configured — and none of them is
  // something the caller can fix by editing the request, so all three must
  // land on the same side of the 400/403 line. A genuinely bad request must
  // still be a 400, or the fix would have bought consistency by erasing a
  // distinction the console needs.
  it('answers every capability-state refusal with 403, and a bad request still with 400', () => {
    const altered = harness();
    altered.fixture.ops.queue.capabilities.register({
      id: DIRECT_ORDER_CAPABILITY.id,
      description: DIRECT_ORDER_CAPABILITY.description,
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const alteredPost = altered.call({ body: ORDER_BODY });
    expect(alteredPost.status).toBe(403);
    expect((alteredPost.body.error as { code: string }).code).toBe(
      'capability_definition_altered',
    );

    const disabled = harness();
    disabled.fixture.ops.queue.capabilities.setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    const disabledPost = disabled.call({ body: ORDER_BODY });
    expect(disabledPost.status).toBe(403);
    expect((disabledPost.body.error as { code: string }).code).toBe('capability_disabled');

    // The distinction is still real: this order IS malformed, and the caller
    // can fix it by resending a valid one.
    const wellFormed = harness();
    const badRoute = wellFormed.call({ body: { ...ORDER_BODY, route: 'NOT_A_ROUTE' } });
    expect(badRoute.status).toBe(400);
    expect((badRoute.body.error as { code: string }).code).toBe('invalid_input');
  });

  it('stays fail-closed on the altered definition: nothing created, nothing repaired, refusal audited', () => {
    const h = harness();
    h.fixture.ops.queue.capabilities.register({
      id: DIRECT_ORDER_CAPABILITY.id,
      description: DIRECT_ORDER_CAPABILITY.description,
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });

    // Repeated attempts must not wear the refusal down, and the 403 must not
    // have become a "retry and it will work" hint.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const post = h.call({ body: ORDER_BODY });
      expect(post.status).toBe(403);
      expect(post.body.ok).toBe(false);
      // The refusal names the drifted fields rather than the values of
      // anything the caller sent.
      expect(String((post.body.error as { message: string }).message)).toContain('riskClass');
    }

    expect(h.fixture.ops.queue.listByStatus('queued')).toEqual([]);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toEqual([]);
    // Not repaired by being invoked: restoring the reserved contract stays the
    // explicit registration action.
    const row = h.fixture.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)!;
    expect(row.riskClass).toBe('read_only');
    expect(row.sideEffect).toBe(false);
    // Every refusal is evidence, attributed to the mapped principal.
    expect(h.audit.map((event) => event.detail)).toEqual([
      'capability_definition_altered',
      'capability_definition_altered',
      'capability_definition_altered',
    ]);
    for (const event of h.audit) {
      expect(event).toMatchObject({ outcome: 'refused', principalId: 'founder' });
    }
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

describe('read-only deployments say so (Codex round 1, P2)', () => {
  it('never advertises a write control the same layer would refuse', () => {
    // The defect this replaces: the flag was enforced in the host adapter and
    // never reached the availability calculation, so a read-only deployment
    // told the console that approve/deny/directOrder were live and every
    // click came back mutations_disabled.
    const h = harness({ mutationsEnabled: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    const controls = session.body.controls as Record<string, unknown>;
    expect(controls).toMatchObject({
      directOrder: false,
      approve: false,
      deny: false,
      mutationsEnabled: false,
    });
  });

  it('refuses the write it just said was unavailable, and creates nothing', () => {
    const h = harness({ mutationsEnabled: false });
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('mutations_disabled');
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('still serves the reads', () => {
    const h = harness({ mutationsEnabled: false });
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.approvals }).status).toBe(200);
  });

  it('advertises the writes as live when they are', () => {
    const h = harness();
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls).toMatchObject({ directOrder: true, approve: true, deny: true });
  });
});

describe('an exhausted step-up budget is reported as 429', () => {
  it('refuses the approval and leaves the task awaiting approval', () => {
    const h = harness({ rateLimited: true });
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
      idempotencyKey: 'coo-order-rl',
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const card = founderConsole(h.fixture.ops, NOW).approvals[0]!;
    const stale = { ...FOUNDER_ACCOUNT, authenticatedAt: STALE };
    const response = h.call(
      {
        path: CONTROL_ROUTES.approve,
        body: {
          taskId: card.taskId,
          expectedActionDigest: card.actionDigest,
          stepUpPassword: 'guess',
        },
      },
      stale,
    );
    expect(response.status).toBe(429);
    expect((response.body.error as { code: string }).code).toBe('step_up_rate_limited');
    expect(h.fixture.ops.queue.get(card.taskId)!.status).toBe('needs_approval');
  });
});

describe('a denial reason is validated before any canonical write (Codex round 2, P1)', () => {
  function pendingTask(h: Harness): { taskId: string; digest: string } {
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
      idempotencyKey: 'coo-order-deny',
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const card = founderConsole(h.fixture.ops, NOW).approvals[0]!;
    return { taskId: card.taskId, digest: card.actionDigest };
  }

  it('refuses a credential-shaped reason and leaves the task untouched', () => {
    // The defect this replaces: queue.deny blocked the task, wrote
    // block_reason and inserted the hq_approvals row, and only THEN appended
    // evidence — which threw. The caller was told the denial failed while it
    // had in fact committed and stored the credential in two tables.
    const h = harness();
    const { taskId, digest } = pendingTask(h);
    const response = h.call({
      path: CONTROL_ROUTES.deny,
      body: { taskId, reason: 'token: abcdefgh1234', expectedActionDigest: digest },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unsafe_reason');

    const task = h.fixture.ops.queue.get(taskId)!;
    expect(task.status).toBe('needs_approval');
    expect(task.blockReason).toBeNull();
    const approvals = h.fixture.db
      .prepare('SELECT decision FROM hq_approvals WHERE task_id = ?')
      .all(taskId);
    expect(approvals).toHaveLength(0);
  });

  it('refuses it at the canonical layer too, so the CLI cannot commit one either', () => {
    // Validating only at the browser boundary would leave the partial-commit
    // hole open for every other caller of denyTask.
    const h = harness();
    const { taskId } = pendingTask(h);
    const result = h.fixture.ops.denyTask({
      taskId,
      founderId: 'founder',
      reason: 'api_key = abcdefgh1234',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    const task = h.fixture.ops.queue.get(taskId)!;
    expect(task.status).toBe('needs_approval');
    expect(task.blockReason).toBeNull();
    expect(
      h.fixture.db.prepare('SELECT decision FROM hq_approvals WHERE task_id = ?').all(taskId),
    ).toHaveLength(0);
  });

  it('bounds the reason, since it is persisted in three places', () => {
    const h = harness();
    const { taskId } = pendingTask(h);
    const response = h.call({
      path: CONTROL_ROUTES.deny,
      body: { taskId, reason: 'x'.repeat(MAX_DENIAL_REASON_LENGTH + 1) },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('reason_too_long');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('still accepts an ordinary reason', () => {
    const h = harness();
    const { taskId } = pendingTask(h);
    const response = h.call({
      path: CONTROL_ROUTES.deny,
      body: { taskId, reason: 'Out of scope this quarter' },
    });
    expect(response.status).toBe(200);
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('blocked');
  });
});

describe('advertised controls come from the principal grants (Codex round 2, P2)', () => {
  function controlsFor(principal: {
    originateCapabilities: string[];
    approvalAuthority: boolean;
  }): Record<string, unknown> {
    const h = harness();
    h.fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      active: true,
      ...principal,
    });
    return h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<
      string,
      unknown
    >;
  }

  it('hides approve and deny from a principal with no approval authority', () => {
    // approvalAuthority and originateCapabilities are independent registry
    // fields, so being the mapped Founder proves neither.
    const controls = controlsFor({
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: false,
    });
    expect(controls).toMatchObject({ approve: false, deny: false, directOrder: true });
  });

  it('hides direct order from a principal with no origination grant', () => {
    const controls = controlsFor({ originateCapabilities: [], approvalAuthority: true });
    expect(controls).toMatchObject({ directOrder: false, approve: true, deny: true });
  });

  it('shows every control to a principal holding both', () => {
    const controls = controlsFor({
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
    });
    expect(controls).toMatchObject({ directOrder: true, approve: true, deny: true });
  });

  it('advertises nothing to a caller who is not the Founder', () => {
    const h = harness({ account: STAFF_ACCOUNT });
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls).toMatchObject({ directOrder: false, approve: false, deny: false });
  });
});

describe('an approval note is validated before it is stored (Codex round 3, P1)', () => {
  function pendingFromOther(h: Harness): { taskId: string; digest: string } {
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
      idempotencyKey: 'coo-order-note',
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const card = founderConsole(h.fixture.ops, NOW).approvals[0]!;
    return { taskId: card.taskId, digest: card.actionDigest };
  }

  function storedNotes(h: Harness, taskId: string): unknown[] {
    return h.fixture.db
      .prepare('SELECT decision_note FROM hq_approvals WHERE task_id = ?')
      .all(taskId);
  }

  it('refuses a credential-shaped note and approves nothing', () => {
    // Worse than the denial case rather than merely similar: queue.approve's
    // evidence payload carries the approval id, digest and expiry but NOT the
    // note, so the evidence guard never sees it. Without this check the note
    // was stored silently — and renderFounderApprovals publishes that column
    // into the generated HTML.
    const h = harness();
    const { taskId, digest } = pendingFromOther(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest, note: 'password: abcdefgh1234' },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unsafe_note');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
    expect(storedNotes(h, taskId)).toHaveLength(0);
  });

  it('refuses it at the canonical layer too, so the CLI cannot store one either', () => {
    const h = harness();
    const { taskId, digest } = pendingFromOther(h);
    const result = h.fixture.ops.approveTask({
      taskId,
      founderId: 'founder',
      expectedActionDigest: digest,
      note: 'api_key = abcdefgh1234',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
    expect(storedNotes(h, taskId)).toHaveLength(0);
  });

  it('bounds the note, since it is stored permanently and rendered', () => {
    const h = harness();
    const { taskId, digest } = pendingFromOther(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: {
        taskId,
        expectedActionDigest: digest,
        note: 'x'.repeat(MAX_APPROVAL_NOTE_LENGTH + 1),
      },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('note_too_long');
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('needs_approval');
  });

  it('still accepts an ordinary note, and stores it', () => {
    const h = harness();
    const { taskId, digest } = pendingFromOther(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId, expectedActionDigest: digest, note: 'Agreed, proceed this week' },
    });
    expect(response.status).toBe(200);
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('queued');
    expect(storedNotes(h, taskId)).toEqual([{ decision_note: 'Agreed, proceed this week' }]);
  });
});

describe('an unusable origin list disables the advertised controls (Codex round 3, P2)', () => {
  it('advertises nothing writable when no origin is configured', () => {
    // Every POST would be refused as origin_allowlist_empty, so telling the
    // console the buttons work is the same lie in a third costume.
    const h = harness({ origins: [] });
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls).toMatchObject({
      directOrder: false,
      approve: false,
      deny: false,
      trustedOriginConfigured: false,
    });
  });

  it('treats an unparseable origin list as no origin at all', () => {
    // Derived from the same function the gate uses, so "usable" cannot mean
    // one thing to the check and another to the advertisement.
    const h = harness({ origins: ['not a url', 'https://hq.example/with/path', ''] });
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls).toMatchObject({ approve: false, trustedOriginConfigured: false });
  });

  it('advertises the controls once one usable origin is configured', () => {
    const h = harness({ origins: ['nonsense', ORIGIN] });
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(controls).toMatchObject({
      directOrder: true,
      approve: true,
      deny: true,
      trustedOriginConfigured: true,
    });
  });
});

describe('the advertised controls follow the REQUESTING origin (issue #219, Codex P2)', () => {
  const PREVIEW = 'https://jenify-hq-preview-42.vercel.app';

  /** A console page load from `origin`: no Origin header, Referer and Host set. */
  function pageLoad(origin: string): Record<string, string> {
    const url = new URL(origin);
    return { referer: `${origin}/hq/command-center.html`, host: url.host };
  }

  function sessionControls(h: Harness, headers: Record<string, string | undefined>) {
    return h.call({ method: 'GET', path: CONTROL_ROUTES.session, headers }).body
      .controls as Record<string, unknown>;
  }

  it('hides every write control when the page origin is not the trusted one', () => {
    // The regression itself. The allow-list is non-empty and perfectly valid —
    // it just names a DIFFERENT host than the one this preview is served from,
    // which is the ordinary consequence of a preview being redeployed or
    // renamed. Advertising the controls here told the console to draw buttons
    // whose every POST returns `origin_not_allowed`.
    const h = harness({ origins: [ORIGIN] });
    const controls = sessionControls(h, pageLoad(PREVIEW));
    expect(controls).toMatchObject({
      directOrder: false,
      approve: false,
      deny: false,
      // Non-empty and usable: the old, weaker question still answers yes.
      trustedOriginConfigured: true,
      requestOriginAllowed: false,
      requestOriginSource: 'referer',
    });
  });

  it('says why, in the Founder session answer the console renders', () => {
    const h = harness({ origins: [ORIGIN] });
    const body = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.session,
      headers: pageLoad(PREVIEW),
    }).body;
    expect(body.founder).toBe(true);
    expect(String(body.message)).toContain('not served from an origin that is trusted');
    // A reason must not become a reflection channel for a header the caller
    // controls: the untrusted origin is never echoed back into the page.
    expect(String(body.message)).not.toContain('vercel.app');
  });

  it('states nothing extra when the page origin IS trusted', () => {
    const h = harness({ origins: [ORIGIN] });
    const response = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.session,
      headers: pageLoad(ORIGIN),
    });
    expect(response.body.message).toBeUndefined();
    expect(response.body.controls).toMatchObject({
      approve: true,
      requestOriginAllowed: true,
      requestOriginSource: 'referer',
    });
  });

  it('advertises exactly what the POST gate will accept, host by host', () => {
    // The property that matters, checked as a pair rather than asserted: for
    // each candidate origin, what the session route CLAIMS and what the order
    // route DOES must agree. A future change that loosens one and not the
    // other fails here.
    const cases = [
      { label: 'the configured origin', origin: ORIGIN, accepted: true },
      { label: 'a different preview hostname', origin: PREVIEW, accepted: false },
      { label: 'the same host over http', origin: 'http://hq.example', accepted: false },
      { label: 'the same host on another port', origin: 'https://hq.example:8443', accepted: false },
      { label: 'a lookalike suffix host', origin: 'https://hq.example.evil.test', accepted: false },
    ];
    for (const scenario of cases) {
      const h = harness({ origins: [ORIGIN] });
      const advertised = sessionControls(h, pageLoad(scenario.origin)).directOrder === true;
      const post = h.call({
        headers: { origin: scenario.origin, 'content-type': 'application/json' },
        body: ORDER_BODY,
      });
      const accepted = post.status === 201;
      expect(accepted, `${scenario.label}: POST outcome`).toBe(scenario.accepted);
      expect(advertised, `${scenario.label}: advertisement must match the POST`).toBe(accepted);
      if (!accepted) {
        expect((post.body.error as { code: string }).code).toBe('origin_not_allowed');
      }
    }
  });

  it('never lets a trusted Referer rescue an untrusted Origin header', () => {
    // A cross-origin GET carries the attacker's Origin. If the weaker sources
    // were consulted after a present-but-disallowed Origin, a forged Referer
    // would decide the answer — so a present Origin is decided on alone.
    const h = harness({ origins: [ORIGIN] });
    const controls = sessionControls(h, {
      origin: PREVIEW,
      referer: `${ORIGIN}/hq/command-center.html`,
      host: 'hq.example',
    });
    expect(controls).toMatchObject({
      approve: false,
      requestOriginAllowed: false,
      requestOriginSource: 'origin',
    });
  });

  it('refuses an opaque or unparseable origin rather than reading past it', () => {
    const h = harness({ origins: [ORIGIN] });
    for (const origin of ['null', 'not a url', 'file://', 'chrome-extension://abcdef']) {
      const controls = sessionControls(h, { origin, host: 'hq.example' });
      expect(controls.approve, origin).toBe(false);
      expect(controls.requestOriginAllowed, origin).toBe(false);
    }
  });

  it('advertises nothing on the arrival Host alone, even a trusted hostname', () => {
    // Issue #219, Codex P2 on `49da330`. Matching the Host against the trusted
    // HOSTS answered yes for a page that might have been loaded over http,
    // whose POST the gate then refuses on the scheme. Host is evidence of the
    // hostname that answered, never of the page's origin, so it advertises
    // nothing — and `requestOriginSource` still says `host`, so the deployment
    // can be told what is missing rather than that its config is wrong.
    const h = harness({ origins: [ORIGIN] });
    expect(sessionControls(h, { host: 'hq.example' })).toMatchObject({
      directOrder: false,
      approve: false,
      deny: false,
      requestOriginAllowed: false,
      requestOriginSource: 'host',
    });
    expect(sessionControls(h, { host: 'jenify-hq-preview-42.vercel.app' })).toMatchObject({
      approve: false,
      requestOriginAllowed: false,
      requestOriginSource: 'host',
    });
  });

  it('does not advertise for an http page whose host is trusted over https', () => {
    // The finding's exact scenario end to end: `https://hq.example` trusted, a
    // page served at `http://hq.example`, referrer stripped. Host-only would
    // have drawn the buttons; the POST from that page is refused.
    const h = harness({ origins: [ORIGIN] });
    expect(sessionControls(h, { host: 'hq.example' }).approve).toBe(false);
    const post = h.call({
      headers: {
        origin: 'http://hq.example',
        host: 'hq.example',
        'content-type': 'application/json',
      },
      body: ORDER_BODY,
    });
    expect(post.status).not.toBe(201);
    expect((post.body.error as { code: string }).code).toBe('origin_not_allowed');
  });

  it('explains a Host-only refusal as missing evidence, not a wrong configuration', () => {
    // Two different situations produce the same `false`, and sending a Founder
    // to edit an allow-list that is already correct wastes the one explanation
    // the console gets to give.
    const h = harness({ origins: [ORIGIN] });
    const hostOnly = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.session,
      headers: { host: 'hq.example' },
    }).body;
    expect(String(hostOnly.message)).toContain('no evidence of the origin');
    expect(String(hostOnly.message)).not.toContain('not served from an origin that is trusted');
    const untrusted = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.session,
      headers: pageLoad(PREVIEW),
    }).body;
    expect(String(untrusted.message)).toContain('not served from an origin that is trusted');
  });

  it('advertises nothing when the requesting origin cannot be established at all', () => {
    // Unknown is not permission. A write from such a request would be refused
    // `origin_missing` anyway, so claiming the control works is the same lie.
    const h = harness({ origins: [ORIGIN] });
    expect(sessionControls(h, {})).toMatchObject({
      directOrder: false,
      approve: false,
      deny: false,
      requestOriginAllowed: false,
      requestOriginSource: 'none',
    });
  });

  it('keeps a non-Founder session answer consistent too', () => {
    // The same computation serves the unmapped-session answer, so a signed-in
    // non-Founder on an untrusted preview is not told a different story.
    const h = harness({ founderMap: [], origins: [ORIGIN] });
    const controls = sessionControls(h, pageLoad(PREVIEW));
    expect(controls).toMatchObject({
      approve: false,
      deny: false,
      requestOriginAllowed: false,
      trustedOriginConfigured: true,
    });
  });

  it('still reports an empty allow-list as the unconfigured deployment it is', () => {
    // The two facts stay separable: nothing configured, and this page not
    // trusted. A deployment reading the answer can tell which one it has.
    const h = harness({ origins: [] });
    expect(sessionControls(h, pageLoad(ORIGIN))).toMatchObject({
      approve: false,
      trustedOriginConfigured: false,
      requestOriginAllowed: false,
    });
  });
});

describe('identity and authorization read ONE registry (Codex round 4, P1)', () => {
  it('resolves the acting principal from ops.principals, not a second port', () => {
    // Structural, not behavioural: the deps shape has no `principals` field at
    // all, so a host cannot wire a registry for authentication that differs
    // from the one HeadquarterOperations authorizes against. The divergence is
    // unrepresentable rather than merely detected.
    const h = harness();
    expect(Object.keys(h.deps)).not.toContain('principals');
  });

  it('sees a grant change made through the ops registry immediately', () => {
    // Proves the API reads the operations registry: revoking approval
    // authority through the canonical human-principal table must change what
    // the session route advertises, with no separate port to keep in sync.
    const h = harness();
    const before = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(before.approve).toBe(true);

    h.fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: false,
      active: true,
    });

    const after = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body
      .controls as Record<string, unknown>;
    expect(after.approve).toBe(false);
  });

  it('refuses a Founder whose principal was deactivated in the ops registry', () => {
    const h = harness();
    h.fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: false,
    });
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('principal_inactive');
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});

describe('a failing audit sink never misreports a committed write (Codex round 4, P2)', () => {
  function exploding(h: Harness): void {
    h.deps.audit = {
      record: () => {
        throw new Error('logging backend unavailable');
      },
    };
  }

  it('still reports success for an order that was actually created', () => {
    // The audit call happens AFTER the canonical write. Letting it throw would
    // escape to the catch-all and return 500 for a task that exists — telling
    // the client to retry something already committed.
    const h = harness();
    exploding(h);
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(201);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(1);
  });

  it('still reports success for an approval that was actually granted', () => {
    const h = harness();
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
      idempotencyKey: 'coo-audit',
      requestedBy: 'coo',
      title: 'COO order',
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const card = founderConsole(h.fixture.ops, NOW).approvals[0]!;
    exploding(h);
    const response = h.call({
      path: CONTROL_ROUTES.approve,
      body: { taskId: card.taskId, expectedActionDigest: card.actionDigest },
    });
    expect(response.status).toBe(200);
    expect(h.fixture.ops.queue.get(card.taskId)!.status).toBe('queued');
  });

  it('still refuses correctly when the sink throws on a refusal path', () => {
    const h = harness({ account: null });
    exploding(h);
    const response = h.call({ body: ORDER_BODY });
    expect(response.status).toBe(401);
    expect((response.body.error as { code: string }).code).toBe('unauthenticated');
  });
});
