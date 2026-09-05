/**
 * Founder Command over the browser-control API, end to end (issue #254).
 *
 * `mission-core.test.ts` proves the module against the facade; this suite
 * proves what can only be wrong once a browser is in front of it: that the
 * acting principal is the mapped session and never a body field, that an
 * unauthenticated or non-Founder caller is refused with nothing written, that
 * an absent mission store fails closed, that a duplicate command is one
 * mission, that no Founder text or secret crosses the wire, that zero renders
 * as zero, that an expired session locks the next read, and that a mutation
 * changes what the state route answers next.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';
import { MissionStore } from '../src/mission/store.js';
import type { MissionView } from '../src/mission/view.js';
import type { RoomView } from '../src/client/contracts.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-05T09:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
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
  missions: MissionStore;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; grant?: boolean; store?: false } = {}): Harness {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: options.grant === false ? [] : [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  const missions = new MissionStore(fixture.db);
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null = options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: CLAUDE_ONLY,
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
    ...(options.store === false ? {} : { missions }),
  };
  return {
    fixture,
    missions,
    audit,
    deps,
    call(request, account) {
      if (account !== undefined) current = account;
      const method = request.method ?? 'POST';
      const headers =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.missions, headers, body: request.body },
        deps,
      );
    },
  };
}

const COMMAND_BODY = {
  command:
    'Ship the shift-report export.\nMust not change the ledger schema.\n' +
    '1. Add the export endpoint\n2. Write the regression test',
  route: 'CLAUDE',
  title: 'Shift export',
  project: 'mesob',
};

function missionsOf(response: ControlResponse): MissionView[] {
  return (response.body as { missions: MissionView[] }).missions;
}

describe('a mapped Founder records a mission through the facade', () => {
  it('creates a planned mission whose tasks are needs_approval orders attributed to the mapped principal', () => {
    const h = harness();
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      ok: true,
      state: 'planned',
      deduplicated: false,
      needsClarification: false,
      taskCount: 2,
      constraintCount: 1,
    });
    const tasks = response.body.tasks as { taskId: string; status: string; boundProvider: string; requiresFounderApproval: boolean }[];
    expect(tasks).toHaveLength(2);
    for (const entry of tasks) {
      expect(entry.status).toBe('needs_approval');
      expect(entry.requiresFounderApproval).toBe(true);
      expect(entry.boundProvider).toBe('CLAUDE');
      const task = h.fixture.ops.queue.get(entry.taskId)!;
      expect(task.createdBy).toBe('founder');
      expect(task.payload.actorAuthentication).toBe('authenticated_os_session');
    }
    const mission = h.missions.getMission(response.body.missionId as string)!;
    expect(mission.actorAuthentication).toBe('authenticated_os_session');
    expect(h.audit.at(-1)?.detail).toBe('mission_created');
  });

  it('deduplicates a double-submitted command onto one mission', () => {
    const h = harness();
    const first = h.call({ body: COMMAND_BODY });
    const second = h.call({ body: COMMAND_BODY });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.missionId).toBe(first.body.missionId);
    expect(h.missions.countMissions()).toBe(1);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(2);
  });

  it('records an unreadable order as blocked with zero tasks, and says which rule fired', () => {
    const h = harness();
    const response = h.call({ body: { command: 'Should we ship the export?', route: 'CLAUDE' } });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, state: 'blocked', needsClarification: true, taskCount: 0 });
    expect(response.body.unknowns).toEqual([{ code: 'question_not_order', blocking: true }]);
    expect(response.body.tasks).toEqual([]);
    expect(h.audit.at(-1)?.detail).toBe('mission_recorded_needs_clarification');
    // Zero renders as zero on the read side too.
    const listed = h.call({ method: 'GET' });
    expect(missionsOf(listed)[0]!.taskCount).toBe(0);
    expect(missionsOf(listed)[0]!.impliedState).toBeNull();
  });

  it('refuses a body that names an actor, before anything is resolved', () => {
    const h = harness();
    const response = h.call({ body: { ...COMMAND_BODY, requestedBy: 'coo' } });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'client_identity_supplied' });
    expect(h.missions.countMissions()).toBe(0);
  });

  it('answers 403 for a Founder principal without the originate grant, and advertises no command control', () => {
    const h = harness({ grant: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as Record<string, unknown>).founderCommand).toBe(false);
    expect((session.body.controls as Record<string, unknown>).missionTransition).toBe(true);
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(403);
    expect(h.missions.countMissions()).toBe(0);
  });
});

describe('unauthenticated and non-Founder callers are refused with nothing written', () => {
  it('answers 401 to a browser with no session, on every mission route', () => {
    const h = harness({ account: null });
    expect(h.call({ method: 'GET' }).status).toBe(401);
    expect(h.call({ body: COMMAND_BODY }).status).toBe(401);
    expect(h.call({ path: CONTROL_ROUTES.missionAmend, body: { missionId: 'x', command: 'y z', reason: 'r' } }).status).toBe(401);
    expect(h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId: 'x', to: 'working' } }).status).toBe(401);
    expect(h.missions.countMissions()).toBe(0);
  });

  it('answers 403 to a signed-in account that is not the Founder', () => {
    const h = harness({ account: STAFF_ACCOUNT });
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'not_founder' });
    expect(h.call({ method: 'GET' }).status).toBe(403);
    expect(h.missions.countMissions()).toBe(0);
  });

  it('locks the next read when the session expires between calls', () => {
    const h = harness();
    h.call({ body: COMMAND_BODY });
    expect(h.call({ method: 'GET' }).status).toBe(200);
    // The resolver now answers null: expired, revoked, or signed out.
    const locked = h.call({ method: 'GET' }, null);
    expect(locked.status).toBe(401);
    expect(locked.body.ok).toBe(false);
    expect(JSON.stringify(locked.body)).not.toContain('missions');
  });
});

describe('an absent mission store fails closed', () => {
  it('refuses every mission route with 503 and advertises no mission control', () => {
    const h = harness({ store: false });
    for (const request of [
      { method: 'GET' as const },
      { body: COMMAND_BODY },
      { path: CONTROL_ROUTES.missionAmend, body: { missionId: 'x', command: 'y z', reason: 'r' } },
      { path: CONTROL_ROUTES.missionTransition, body: { missionId: 'x', to: 'working' } },
    ]) {
      const response = h.call(request);
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({ code: 'mission_core_unavailable' });
    }
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>;
    expect(controls.missionCoreAttached).toBe(false);
    expect(controls.founderCommand).toBe(false);
    expect(controls.missionAmend).toBe(false);
    expect(controls.missionTransition).toBe(false);
    // The state document says absence, not zero.
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    const mission = (state.body.rooms as RoomView[]).find((room) => room.roomId === 'mission-room')!;
    expect(mission.metrics.find((metric) => metric.label === 'Mission core')!.value).toBe('not attached');
  });
});

describe('nothing Founder-typed but the title crosses the wire', () => {
  it('publishes no order text, no brief, no payload, and no secret-shaped string', () => {
    const h = harness();
    const created = h.call({
      body: { ...COMMAND_BODY, command: 'SECRET-ORDER-TEXT-DO-NOT-PUBLISH.\n1. SECRET-STEP-ONE\n2. SECRET-STEP-TWO' },
    });
    expect(created.status).toBe(201);
    const listed = h.call({ method: 'GET' });
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    const serialized = JSON.stringify([created.body, listed.body, state.body]);
    // `instruction` as a WORD is legitimately on the wire — the direct-order
    // capability's registry description uses it — so the assertion is on the
    // Founder's text and on the payload key, which is what would carry it.
    for (const forbidden of ['SECRET-ORDER-TEXT', 'SECRET-STEP-ONE', 'SECRET-STEP-TWO', 'payload']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    expect(serialized).toContain('Shift export');
  });

  it('refuses a credential-shaped order before any write', () => {
    const h = harness();
    const response = h.call({ body: { ...COMMAND_BODY, command: 'Use sk-abcdefghijklmnopqrstuvwxyz to fix it.' } });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'unsafe_command' });
    expect(h.missions.countMissions()).toBe(0);
  });
});

describe('the mission list is live state', () => {
  it('lists the mission with its plan, and reflects an approval on the very next read', async () => {
    const h = harness();
    const created = h.call({ body: COMMAND_BODY });
    const before = missionsOf(h.call({ method: 'GET' }));
    expect(before).toHaveLength(1);
    expect(before[0]!.tasks.map((task) => task.presentation)).toEqual(['needs_approval', 'needs_approval']);
    expect(before[0]!.impliedState).toBe('planned');
    // A second human approves the first task through the canonical facade.
    const { taskActionDigest } = await import('../src/operator/approvals.js');
    const taskId = (created.body.tasks as { taskId: string }[])[0]!.taskId;
    const approved = h.fixture.ops.approveTask({
      taskId,
      founderId: 'coo',
      expectedActionDigest: taskActionDigest(h.fixture.ops.queue.get(taskId)!),
    });
    expect(approved.ok).toBe(true);
    const after = missionsOf(h.call({ method: 'GET' }));
    expect(after[0]!.tasks.map((task) => task.presentation)).toEqual(['waiting', 'needs_approval']);
    expect(after[0]!.tasks[0]!.canonicalStatus).toBe('queued');
  });

  it('shows the mission in the Mission Room and lights the Command Room for a blocked one', () => {
    const h = harness();
    h.call({ body: { command: 'Should we ship it?', route: 'CLAUDE', title: 'Unclear order' } });
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    const rooms = state.body.rooms as RoomView[];
    const mission = rooms.find((room) => room.roomId === 'mission-room')!;
    expect(mission.liveness).toBe('attention');
    expect(mission.metrics.find((metric) => metric.label === 'Missions recorded')!.value).toBe(1);
    expect(mission.metrics.find((metric) => metric.label === 'Needing clarification')!.value).toBe(1);
    expect(mission.rows[0]!.primary).toBe('Unclear order');
    expect(mission.rows[0]!.chips.map((chip) => chip.label)).toContain('needs clarification');
    const command = rooms.find((room) => room.roomId === 'command-room')!;
    expect(command.liveness).toBe('attention');
    expect(command.metrics.find((metric) => metric.label === 'Missions needing attention')!.value).toBe(1);
    const home = rooms.find((room) => room.roomId === 'home')!;
    expect(home.liveness).toBe('attention');
    expect(home.metrics.find((metric) => metric.label === 'Missions needing you')!.value).toBe(1);
  });
});

describe('amend and transition over the API', () => {
  it('appends an amendment for the mapped Founder and refuses one without a reason', () => {
    const h = harness();
    const created = h.call({ body: COMMAND_BODY });
    const missionId = created.body.missionId as string;
    const noReason = h.call({ path: CONTROL_ROUTES.missionAmend, body: { missionId, command: 'Ship it faster.' } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatchObject({ code: 'reason_required' });
    const amended = h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: { missionId, command: `${COMMAND_BODY.command}\nMust finish by Friday.`, reason: 'Deadline moved.' },
    });
    expect(amended.status).toBe(200);
    expect(amended.body).toMatchObject({ ok: true, planCreated: false, revision: 2 });
    expect(h.missions.listIntent(missionId)).toHaveLength(2);
    expect(h.missions.listIntent(missionId)[1]!.actor).toBe('founder');
    expect(h.missions.listIntent(missionId)[1]!.actorAuthentication).toBe('authenticated_os_session');
    const listed = missionsOf(h.call({ method: 'GET' }))[0]!;
    expect(listed.intent.revisions).toBe(2);
    expect(listed.intent.latestReason).toBe('Deadline moved.');
    expect(listed.intent.chainIntact).toBe(true);
  });

  it('records a listed transition and refuses an unlisted one with 409', () => {
    const h = harness();
    const missionId = h.call({ body: COMMAND_BODY }).body.missionId as string;
    const illegal = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'complete' } });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error).toMatchObject({ code: 'illegal_mission_transition' });
    const legal = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'working' } });
    expect(legal.status).toBe(200);
    expect(legal.body).toMatchObject({ ok: true, from: 'planned', to: 'working', state: 'working' });
    const listed = missionsOf(h.call({ method: 'GET' }))[0]!;
    expect(listed.state).toBe('working');
    expect(listed.history.map((event) => event.toState)).toEqual(['planned', 'working']);
    // Nothing runs: the tasks are still gated, and the view says the recorded
    // state disagrees with them.
    expect(listed.driftFromTasks).toBe(true);
    expect(listed.impliedState).toBe('planned');
    const unknown = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId: 'nope', to: 'working' } });
    expect(unknown.status).toBe(404);
  });

  it('refuses mission writes when browser mutations are switched off, and says so in the session', () => {
    const h = harness();
    h.deps.mutationsEnabled = false;
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>;
    expect(controls.founderCommand).toBe(false);
    expect(controls.missionTransition).toBe(false);
    expect(h.call({ body: COMMAND_BODY }).status).toBe(403);
    // Reads still answer.
    expect(h.call({ method: 'GET' }).status).toBe(200);
  });
});
