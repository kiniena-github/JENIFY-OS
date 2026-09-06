/**
 * Phase 8 action-ledger routes, end to end against the real canonical
 * machinery.
 *
 * The two reads and the two writes join the control API behind the SAME
 * pipeline as every other route — origin/content-type gate, client-identity
 * scan (body AND query), Founder resolution, `safe()` on every response. This
 * suite proves the wiring: the proposing principal is always the mapped one,
 * reconcile demands STEP-UP always, the payload body never crosses back to the
 * browser, no secret does either, refusals carry one status per cause, and
 * there is deliberately NO route through which a browser can authorize or
 * execute an external action.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { authorizedAction, fakeAdapter, gatewayFixture, startedTask, type GatewayFixture } from './action-gateway.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-06T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
const STALE = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-coo', principalId: 'coo' },
  { realmId: 'tenant-1', accountId: 'user-analyst', principalId: 'analyst' },
];

function account(accountId: string, authenticatedAt = FRESH): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt };
}

interface Harness {
  fixture: GatewayFixture;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; mutationsEnabled?: boolean; fixture?: GatewayFixture } = {}): Harness {
  const fixture = options.fixture ?? gatewayFixture();
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null = options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    credentials: { verify: (_a, password) => (password === 'correct-password' ? 'ok' : 'rejected') },
    audit: { record: (event) => audit.push(event) },
    mutationsEnabled: options.mutationsEnabled,
    now: () => NOW,
  };
  return {
    fixture,
    audit,
    deps,
    call(request, next) {
      if (next !== undefined) current = next;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/archive.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.actions, headers, body: request.body, query: request.query },
        deps,
      );
    },
  };
}

function proposeBody(taskId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId,
    adapterId: 'fake.local',
    actionType: 'post_comment',
    target: 'issue/7',
    payload: { text: 'a comment from the browser' },
    ...over,
  };
}

describe('the action write surface', () => {
  it('names propose and reconcile, keeps the reads off it, and offers NO authorize/execute route', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.actions);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.actionReconcile);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.actionDetail);
    const paths = Object.values(CONTROL_ROUTES) as string[];
    expect(paths.some((p) => /authori[sz]e|execute/.test(p))).toBe(false);
    const h = harness();
    for (const path of ['/api/hq/control/actions/authorize', '/api/hq/control/actions/execute']) {
      const response = h.call({ path, body: { actionId: 'x' } });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('a mapped Founder proposes through the facade', () => {
  it('201 attributed to the mapped principal, 200 deduplicated; the payload body and idempotency key never come back', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    const response = h.call({ body: proposeBody(started.taskId) });
    expect(response.status).toBe(201);
    const action = response.body.action as Record<string, unknown>;
    expect(action.requestedBy).toBe('founder');
    expect(action.state).toBe('proposed');
    expect(action.riskLevel).toBe('medium');
    expect('payload' in action).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('a comment from the browser');
    expect(JSON.stringify(response.body)).not.toContain('idempotencyKey');
    const again = h.call({ body: proposeBody(started.taskId) });
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(h.fixture.adapter.calls).toHaveLength(0);
  });

  it('refuses a body or a query that names an actor rather than re-attributing it', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    const body = h.call({ body: proposeBody(started.taskId, { requestedBy: 'coo' }) });
    expect(body.status).toBe(400);
    expect((body.body.error as { code: string }).code).toBe('client_identity_supplied');
    const query = h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: 'x', principalId: 'coo' } });
    expect(query.status).toBe(400);
    expect((query.body.error as { code: string }).code).toBe('client_identity_supplied');
  });

  it('one status per cause: 403 ungranted, 404 unknown task, 400 malformed risk, 400 credential-like payload', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    const ungranted = h.call({ body: proposeBody(started.taskId) }, account('user-analyst'));
    expect(ungranted.status).toBe(403);
    expect((ungranted.body.error as { code: string }).code).toBe('not_permitted');
    const unknown = h.call({ body: proposeBody('no-such-task') }, account('user-founder'));
    expect(unknown.status).toBe(404);
    const badRisk = h.call({ body: proposeBody(started.taskId, { risk: { productionScope: 'yes' } }) });
    expect(badRisk.status).toBe(400);
    const secret = h.call({ body: proposeBody(started.taskId, { payload: { apiKey: 'abcd1234efgh5678' } }) });
    expect(secret.status).toBe(400);
    expect((secret.body.error as { code: string }).code).toBe('unsafe_action_content');
    const rawToken = h.call({ body: proposeBody(started.taskId, { payload: { text: `use ghp_${'a'.repeat(30)}` } }) });
    expect(rawToken.status).toBe(400);
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_intents`).get() as { n: number }).n).toBe(0);
  });

  it('risk escalation travels from the body and cannot lower the level; 403 when it then demands an approval', () => {
    const h = harness();
    const started = startedTask(h.fixture, { capabilityId: CAPS.openPr, payload: { branch: 'b' } });
    const escalated = h.call({
      body: proposeBody(started.taskId, { actionType: 'write_note', risk: { spend: true, blastRadius: 'single' } }),
    });
    expect(escalated.status).toBe(201);
    const action = escalated.body.action as Record<string, unknown>;
    expect(action.riskLevel).toBe('critical');
    // The capability row's own factors stay (openPr IS an external side effect); the body only ADDED one.
    expect(action.riskFactors).toEqual(['side_effect', 'capability_external_side_effect', 'money_spend']);
    // The refusal that follows is the facade's, at the worker step (no route).
    const refused = h.fixture.ops.authorizeAction({ actionId: action.id as string, workerId: 'claude', fence: started.fence });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('approval_required_by_risk');
  });
});

describe('the reads', () => {
  it('list is bounded with a stated total, narrows by taskId and state, and the detail read answers 404 for nobody', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    const a = authorizedAction(h.fixture, started);
    const b = authorizedAction(h.fixture, started, { idempotencyKey: 'b' });
    expectOk(h.fixture.ops.executeAction({ actionId: a, workerId: 'claude', fence: started.fence }));
    const list = h.call({ method: 'GET', query: { taskId: started.taskId } });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.truncated).toBe(false);
    expect((list.body.actions as { id: string }[]).map((x) => x.id)).toEqual([b, a]);
    const succeeded = h.call({ method: 'GET', query: { state: 'succeeded' } });
    expect((succeeded.body.actions as unknown[]).length).toBe(1);
    expect(h.call({ method: 'GET', query: { state: 'done' } }).status).toBe(400);
    const detail = h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: a } });
    expect(detail.status).toBe(200);
    expect((detail.body.action as { state: string }).state).toBe('succeeded');
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: 'nope' } }).status).toBe(404);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail }).status).toBe(400);
  });

  it('a credential in an adapter result is withheld on the wire too; the response passes the browser guard', () => {
    const token = `ghp_${'b'.repeat(30)}`;
    const fixture = gatewayFixture({ adapter: fakeAdapter({ externalRef: { token } }) });
    const h = harness({ fixture });
    const started = startedTask(fixture);
    const a = authorizedAction(fixture, started);
    expectOk(fixture.ops.executeAction({ actionId: a, workerId: 'claude', fence: started.fence }));
    const detail = h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: a } });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(token);
    expect((detail.body.action as { outcome: { externalRefWithheld: boolean } }).outcome.externalRefWithheld).toBe(true);
  });

  it('a credential in an adapter MESSAGE is withheld on the wire too — the detail route answers 200, not a permanent 500', () => {
    // Review round 2: the message went into the immutable ledger unscanned and
    // `safe()` then refused the detail response for that action forever.
    const token = `ghp_${'d'.repeat(30)}`;
    const adapter = fakeAdapter();
    adapter.execute = (request) => {
      adapter.calls.push(request);
      return { ok: false, kind: 'rejected', message: `401: token ${token} rejected` };
    };
    const fixture = gatewayFixture({ adapter });
    const h = harness({ fixture });
    const started = startedTask(fixture);
    const a = authorizedAction(fixture, started);
    expectOk(fixture.ops.executeAction({ actionId: a, workerId: 'claude', fence: started.fence }));
    const detail = h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: a } });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(token);
    const outcome = (detail.body.action as { outcome: { state: string; message: string | null; messageWithheld: boolean } }).outcome;
    expect(outcome).toMatchObject({ state: 'failed', message: null, messageWithheld: true });
    const list = h.call({ method: 'GET', query: { taskId: started.taskId } });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });
});

describe('reconcile takes STEP-UP always and the Founder gate', () => {
  function unknownAttempt(): { h: Harness; actionId: string } {
    const fixture = gatewayFixture({ adapter: fakeAdapter({ mode: 'unknown' }) });
    const h = harness({ fixture });
    const started = startedTask(fixture);
    const actionId = authorizedAction(fixture, started);
    expectOk(fixture.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }));
    return { h, actionId };
  }

  it('401 required on a stale session, 403 wrong password, then 200 with the password; the proposer is refused 403', () => {
    const { h, actionId } = unknownAttempt();
    const body = { actionId, decision: 'confirmed_failed', note: 'Checked the remote: nothing landed.' };
    const bare = h.call({ path: CONTROL_ROUTES.actionReconcile, body }, account('user-coo', STALE));
    expect(bare.status).toBe(401);
    expect((bare.body.error as { code: string }).code).toBe('step_up_required');
    const wrong = h.call({ path: CONTROL_ROUTES.actionReconcile, body: { ...body, stepUpPassword: 'nope' } });
    expect(wrong.status).toBe(403);
    expect(h.fixture.ops.getAction(actionId)!.state).toBe('outcome_unknown');
    // The proposer (founder) with a fresh session: past step-up, refused by the facade's independence rule.
    const self = h.call({ path: CONTROL_ROUTES.actionReconcile, body }, account('user-founder'));
    expect(self.status).toBe(403);
    expect((self.body.error as { code: string }).code).toBe('not_permitted');
    const ok = h.call({ path: CONTROL_ROUTES.actionReconcile, body: { ...body, stepUpPassword: 'correct-password' } }, account('user-coo', STALE));
    expect(ok.status).toBe(200);
    expect((ok.body.action as { state: string }).state).toBe('reconciled');
    const again = h.call({ path: CONTROL_ROUTES.actionReconcile, body: { ...body, stepUpPassword: 'correct-password' } });
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('action_state_conflict');
    expect(JSON.stringify(h.audit)).not.toContain('correct-password');
  });

  it('400 on a missing decision or note, 404 on an unknown action, 409 on an action with nothing to reconcile', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    const authorized = authorizedAction(h.fixture, started);
    expect(h.call({ path: CONTROL_ROUTES.actionReconcile, body: { actionId: authorized } }).status).toBe(400);
    expect(
      h.call({ path: CONTROL_ROUTES.actionReconcile, body: { actionId: 'nope', decision: 'confirmed_failed', note: 'n' } }).status,
    ).toBe(404);
    const conflict = h.call({
      path: CONTROL_ROUTES.actionReconcile,
      body: { actionId: authorized, decision: 'confirmed_failed', note: 'n' },
    }, account('user-coo'));
    expect(conflict.status).toBe(409);
  });
});

describe('the session advertises the reconcile control from the Founder gate, and hostile callers get nothing', () => {
  it('actionReconcile mirrors approval authority; there is no actionPropose flag', () => {
    const h = harness();
    const founder = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>;
    expect(founder.actionReconcile).toBe(true);
    expect('actionPropose' in founder).toBe(false);
    const analyst = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-analyst')).body.controls as Record<string, unknown>;
    expect(analyst.actionReconcile).toBe(false);
  });

  it('nobody, an unmapped staff account and mutations-off are refused across the whole surface', () => {
    const h = harness();
    const started = startedTask(h.fixture);
    for (const [who, status] of [
      [null, 401],
      [account('user-staff'), 403],
    ] as const) {
      expect(h.call({ body: proposeBody(started.taskId) }, who).status).toBe(status);
      expect(h.call({ method: 'GET' }, who).status).toBe(status);
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.actionDetail, query: { id: 'x' } }, who).status).toBe(status);
      expect(h.call({ path: CONTROL_ROUTES.actionReconcile, body: { actionId: 'x', decision: 'confirmed_failed', note: 'n' } }, who).status).toBe(status);
    }
    const off = harness({ mutationsEnabled: false });
    const startedOff = startedTask(off.fixture);
    expect(off.call({ body: proposeBody(startedOff.taskId) }).status).toBe(403);
    expect(off.call({ method: 'GET' }).status).toBe(200);
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_intents`).get() as { n: number }).n).toBe(0);
  });
});
