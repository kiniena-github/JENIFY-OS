/**
 * Phase 9 collaboration routes, end to end against the real canonical
 * machinery.
 *
 * The three reads and the two writes join the control API behind the SAME
 * pipeline as every other route — origin/content-type gate, client-identity
 * scan (body AND query), Founder resolution, `safe()` on every response.
 * This suite proves the wiring: the acting principal is always the mapped
 * one, `role` on the wire is refused as an identity key (the body/query key
 * is `collaborationRole`), there is NO contribute route, the Mission Room
 * read composes every canonical element without raw intent bodies or task
 * payloads, the context read never carries founder_only material, refusals
 * carry one status per cause, and the session advertises the command
 * control from the conditions that decide it.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { admit, collaborationFixture, contribute, count, openSession, roomWithThree, type CollaborationFixture } from './collaboration.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { COLLABORATION_COMMAND_CAPABILITY } from '../src/application/collaboration-command.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-06T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-analyst', principalId: 'analyst' },
];

function account(accountId: string, authenticatedAt = FRESH): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt };
}
const STAFF = account('user-staff');

interface Harness {
  fixture: CollaborationFixture;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; mutationsEnabled?: boolean } = {}): Harness {
  const fixture = collaborationFixture();
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null = options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
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
          ? { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.collaboration, headers, body: request.body, query: request.query },
        deps,
      );
    },
  };
}

function openBody(h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { missionId: h.fixture.missionId, title: 'Speed war room', purpose: 'Plan the load-time work', ...over };
}

describe('the collaboration write surface', () => {
  it('names the open and admit writes and keeps the room and context reads off it', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.collaboration);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.collaborationAdmit);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.collaborationRoom);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.collaborationContext);
  });

  it('opens a session attributed to the mapped principal, 201 then 200 deduplicated, no idempotency key on the wire', () => {
    const h = harness();
    const first = h.call({ body: openBody(h) });
    expect(first.status).toBe(201);
    const session = first.body.session as Record<string, unknown>;
    expect(session.openedBy).toBe('founder');
    expect(session.standing).toBe('active');
    expect(session.missionId).toBe(h.fixture.missionId);
    expect(JSON.stringify(first.body)).not.toContain('idempotencyKey');
    const second = h.call({ body: openBody(h) });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(count(h.fixture, 'hq_collab_sessions')).toBe(1);
  });

  it('admits a registered worker under collaborationRole; a body naming `role` is refused as a client-identity key before anything is written', () => {
    const h = harness();
    const session = h.call({ body: openBody(h) }).body.session as { id: string };
    const identity = h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'claude', role: 'builder' } });
    expect(identity.status).toBe(400);
    expect((identity.body.error as { code: string }).code).toBe('client_identity_supplied');
    const admitted = h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'claude', collaborationRole: 'builder' } });
    expect(admitted.status).toBe(201);
    expect(admitted.body.participant).toMatchObject({ workerId: 'claude', role: 'builder', admittedBy: 'founder', providerId: 'CLAUDE' });
    const again = h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'claude', collaborationRole: 'builder' } });
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    const badRole = h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'claude', collaborationRole: 'boss' } });
    expect(badRole.status).toBe(400);
    expect(count(h.fixture, 'hq_collab_participants')).toBe(1);
  });

  it('has NO contribute route: a POST to a contribute path is a 404 that reveals nothing, and the browser never records a contribution', () => {
    const h = harness();
    const session = h.call({ body: openBody(h) }).body.session as { id: string };
    for (const path of [`${CONTROL_ROUTES.collaboration}/contribute`, `${CONTROL_ROUTES.collaboration}/contributions`, CONTROL_ROUTES.collaborationRoom, CONTROL_ROUTES.collaborationContext]) {
      const response = h.call({ path, body: { sessionId: session.id, kind: 'finding', content: 'from the browser' } });
      expect(response.status, path).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('collaboration');
    }
    expect(count(h.fixture, 'hq_collab_contributions')).toBe(0);
  });
});

describe('the Founder-gated reads', () => {
  it('GET /collaboration/room composes the mission, canonical tasks, participants, contributions with binding truth, disagreements, handoffs beside the canonical claim, truth, approvals, runs and actions — with no raw intent body and no task payload on the wire', () => {
    const h = harness();
    const fx = h.fixture;
    const sessionId = roomWithThree(fx);
    expectOk(fx.ops.amendMissionIntent({ missionId: fx.missionId, amendment: 'RATIONALE-STAYS-SERVER-SIDE', objective: 'Under two seconds', requestedBy: 'founder' }));
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, fx.taskId));
    expectOk(fx.ops.startTask(fx.taskId, 'claude', claimed.fence));
    const finding = contribute(fx, sessionId, { taskId: fx.taskId });
    contribute(fx, sessionId, { kind: 'critique', content: 'Disagree.', requestedBy: 'codex', disagreesWith: [finding.id] });
    contribute(fx, sessionId, { kind: 'handoff_request', content: 'Hand to jules.', handoff: { taskId: fx.taskId, toWorkerId: 'jules', reason: 'Context.' } });
    expectOk(fx.ops.recordTruth({ entityKind: 'task', entityId: fx.taskId, statement: 'Load time is 4.2 s.', evidenceRefs: [fx.evidenceId], requestedBy: 'claude' }));
    expectOk(fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'PRIVATE-ROOM-TRUTH', privacy: 'founder_only', requestedBy: 'founder' }));

    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationRoom, query: { missionId: fx.missionId } });
    expect(response.status).toBe(200);
    const room = response.body.room as Record<string, unknown>;
    expect((room.mission as { objective: string }).objective).toBe('Under two seconds');
    expect((room.execution as { linkedTasks: { taskId: string; claimedBy: string }[] }).linkedTasks[0]).toMatchObject({ taskId: fx.taskId, claimedBy: 'claude' });
    expect((room.participants as { workerId: string }[]).map((p) => p.workerId).sort()).toEqual(['claude', 'codex', 'jules']);
    expect((room.contributions as { total: number }).total).toBe(3);
    expect((room.contributions as { items: { id: string; standing: string; binding: { providerId: string } }[] }).items.find((c) => c.id === finding.id)).toMatchObject({ standing: 'disputed', binding: { providerId: 'CLAUDE' } });
    expect(room.disagreements).toHaveLength(1);
    expect((room.handoffRequests as { canonical: { claimedBy: string } }[])[0]!.canonical.claimedBy).toBe('claude');
    // Founder-gated: founder_only truth about the mission IS carried here, exactly as GET /truth carries it.
    expect((room.truth as { records: { statement: string }[] }).records.map((r) => r.statement).sort()).toEqual(['Load time is 4.2 s.', 'PRIVATE-ROOM-TRUTH']);
    expect(Array.isArray(room.approvals)).toBe(true);
    expect(Array.isArray(room.recentRuns)).toBe(true);
    expect((room.externalActions as { total: number }).total).toBe(0);
    const wire = JSON.stringify(response.body);
    expect(wire).not.toContain('RATIONALE-STAYS-SERVER-SIDE');
    expect(wire).not.toContain('lighthouse');
    expect(wire).not.toContain('idempotency');
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationRoom, query: { missionId: 'no-such' } }).status).toBe(404);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationRoom }).status).toBe(400);
  });

  it('GET /collaboration lists sessions bounded with the total; ?missionId= narrows; ?principalId= is refused', () => {
    const h = harness();
    const fx = h.fixture;
    const session = openSession(fx);
    const otherMission = expectOk(fx.ops.commandMission({ title: 'Other', objective: 'O', requestedBy: 'founder' })).mission;
    openSession(fx, { missionId: otherMission.id, title: 'Other room' });
    const all = h.call({ method: 'GET', path: CONTROL_ROUTES.collaboration });
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.storePresent).toBe(true);
    const narrowed = h.call({ method: 'GET', path: CONTROL_ROUTES.collaboration, query: { missionId: fx.missionId } });
    expect((narrowed.body.sessions as { id: string }[]).map((s) => s.id)).toEqual([session.id]);
    const injected = h.call({ method: 'GET', path: CONTROL_ROUTES.collaboration, query: { principalId: 'someone-else' } });
    expect(injected.status).toBe(400);
    expect((injected.body.error as { code: string }).code).toBe('client_identity_supplied');
  });

  it('GET /collaboration/context audits a role’s bundle for the mapped Founder: `role=` in the query is refused, founder_only material never travels, an unknown session is 404, an unlinked task is 400', () => {
    const h = harness();
    const fx = h.fixture;
    const sessionId = roomWithThree(fx);
    expectOk(fx.ops.recordTruth({ entityKind: 'mission', entityId: fx.missionId, statement: 'PRIVATE-BUNDLE-TRUTH', privacy: 'founder_only', requestedBy: 'founder' }));
    expectOk(fx.ops.recordMemory({ kind: 'founder_note', title: 'PRIVATE-BUNDLE-MEMORY', body: 'b', project: 'qos', missionId: fx.missionId, privacy: 'founder_only', requestedBy: 'founder' }));
    const identity = h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId, role: 'planner' } });
    expect(identity.status).toBe(400);
    expect((identity.body.error as { code: string }).code).toBe('client_identity_supplied');
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId, collaborationRole: 'planner' } });
    expect(response.status).toBe(200);
    const bundle = response.body.bundle as { role: string; withheld: { founderOnlyMemory: number; founderOnlyTruth: number } };
    expect(bundle.role).toBe('planner');
    expect(bundle.withheld).toMatchObject({ founderOnlyMemory: 1, founderOnlyTruth: 1 });
    const wire = JSON.stringify(response.body);
    expect(wire).not.toContain('PRIVATE-BUNDLE-TRUTH');
    expect(wire).not.toContain('PRIVATE-BUNDLE-MEMORY');
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId, collaborationRole: 'boss' } }).status).toBe(400);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId: 'no-such', collaborationRole: 'planner' } }).status).toBe(404);
    const unlinked = expectOk(fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: { check: 'x' }, idempotencyKey: 'route-unlinked', requestedBy: 'claude' })).task;
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId, collaborationRole: 'builder', taskId: unlinked.id } }).status).toBe(400);
  });
});

describe('one status per cause', () => {
  it('404 unknown session/mission, 409 closed session and terminal mission, 403 for a mapped principal without the command grant and for an unknown or human worker', () => {
    const h = harness();
    const fx = h.fixture;
    const session = openSession(fx);
    expect(h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: 'no-such', workerId: 'claude', collaborationRole: 'builder' } }).status).toBe(404);
    expect(h.call({ body: openBody(h, { missionId: 'no-such' }) }).status).toBe(404);
    expect(h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'ghost', collaborationRole: 'builder' } }).status).toBe(403);
    expect(h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'analyst', collaborationRole: 'builder' } }).status).toBe(403);
    expect(h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'retired-bot', collaborationRole: 'builder' } }).status).toBe(409);
    const analyst = h.call({ body: openBody(h, { title: 'By analyst' }) }, account('user-analyst'));
    expect(analyst.status).toBe(403);
    expect((analyst.body.error as { code: string }).code).toBe('not_permitted');
    expectOk(fx.ops.transitionMission({ missionId: fx.missionId, to: 'cancelled', note: 'done', requestedBy: 'founder' }));
    const closed = h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: session.id, workerId: 'claude', collaborationRole: 'builder' } }, account('user-founder'));
    expect(closed.status).toBe(409);
    expect((closed.body.error as { code: string }).code).toBe('session_closed');
    const terminal = h.call({ body: openBody(h, { title: 'Too late' }) });
    expect(terminal.status).toBe(409);
    expect((terminal.body.error as { code: string }).code).toBe('mission_terminal');
    expect(count(fx, 'hq_collab_sessions')).toBe(1);
    expect(count(fx, 'hq_collab_participants')).toBe(0);
  });
});

describe('every hostile caller is refused, and nothing is written', () => {
  it('refuses the anonymous and the non-Founder alike on every collaboration route', () => {
    for (const who of [null, STAFF]) {
      const h = harness({ account: who });
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaboration }).status).toBe(who ? 403 : 401);
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationRoom, query: { missionId: h.fixture.missionId } }).status).toBe(who ? 403 : 401);
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationContext, query: { sessionId: 'x', collaborationRole: 'planner' } }).status).toBe(who ? 403 : 401);
      expect(h.call({ body: openBody(h) }).status).toBe(who ? 403 : 401);
      expect(h.call({ path: CONTROL_ROUTES.collaborationAdmit, body: { sessionId: 'x', workerId: 'claude', collaborationRole: 'builder' } }).status).toBe(who ? 403 : 401);
      expect(count(h.fixture, 'hq_collab_sessions')).toBe(0);
    }
  });

  it('refuses a body naming an actor, refuses writes when mutations are disabled while reads stay open, and refuses secret-like titles before anything persists', () => {
    const h = harness();
    const named = h.call({ body: openBody(h, { requestedBy: 'founder' }) });
    expect(named.status).toBe(400);
    expect((named.body.error as { code: string }).code).toBe('client_identity_supplied');
    const secret = h.call({ body: openBody(h, { title: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }) });
    expect(secret.status).toBe(400);
    expect((secret.body.error as { code: string }).code).toBe('unsafe_collaboration_content');
    expect(count(h.fixture, 'hq_collab_sessions')).toBe(0);
    const off = harness({ mutationsEnabled: false });
    expect(off.call({ body: openBody(off) }).status).toBe(403);
    expect(off.call({ method: 'GET', path: CONTROL_ROUTES.collaboration }).status).toBe(200);
    expect(count(off.fixture, 'hq_collab_sessions')).toBe(0);
  });
});

describe('the session advertises the collaboration control from the deciding conditions', () => {
  it('collaborationCommand needs the grant and the intact row; the analyst and a disabled row get false', () => {
    const h = harness();
    const founder = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((founder.body.controls as { collaborationCommand: boolean }).collaborationCommand).toBe(true);
    const analyst = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-analyst'));
    expect((analyst.body.controls as { collaborationCommand: boolean }).collaborationCommand).toBe(false);
    new CapabilityRegistry(h.fixture.db).setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, false);
    const disabled = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-founder'));
    expect((disabled.body.controls as { collaborationCommand: boolean }).collaborationCommand).toBe(false);
    expect(h.call({ body: openBody(h) }).status).toBe(403);
    // The admission of a real worker admitted through the facade is visible in the room read.
    new CapabilityRegistry(h.fixture.db).setEnabled(COLLABORATION_COMMAND_CAPABILITY.id, true);
    const session = openSession(h.fixture);
    admit(h.fixture, session.id, 'jules', 'critic');
    const room = h.call({ method: 'GET', path: CONTROL_ROUTES.collaborationRoom, query: { missionId: h.fixture.missionId } });
    expect((room.body.room as { participants: { workerId: string; roles: string[] }[] }).participants).toEqual([{ workerId: 'jules', roles: ['critic'], providerId: null, memberIdentityKey: null }]);
  });
});
