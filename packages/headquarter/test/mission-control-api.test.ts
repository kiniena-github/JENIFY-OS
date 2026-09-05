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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { CONTROL_GRANT_JS } from '../src/ui/control-console.js';
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

  it('refuses a credential-shaped transition or amendment reason with 400 unsafe_reason, and an over-long one with reason_too_long', () => {
    // Mutation-testing pass on `b3f72d1`, P1.4(a), at the wire: the two
    // codes are asserted as the answer a browser gets, with the recorded
    // state and the intent lock untouched afterwards.
    const h = harness();
    const missionId = h.call({ body: COMMAND_BODY }).body.missionId as string;
    const TOKEN_REASON = 'Waiting on token ghp_abcdefghijklmnopqrstuvwxyz1234 from the auditor.';
    const unsafe = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'blocked', reason: TOKEN_REASON } });
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.error).toMatchObject({ code: 'unsafe_reason' });
    expect(h.audit.at(-1)?.detail).toBe('unsafe_reason');
    const long = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'blocked', reason: 'r'.repeat(501) } });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatchObject({ code: 'reason_too_long' });
    const unsafeAmend = h.call({ path: CONTROL_ROUTES.missionAmend, body: { missionId, command: 'Ship it faster.', reason: TOKEN_REASON } });
    expect(unsafeAmend.status).toBe(400);
    expect(unsafeAmend.body.error).toMatchObject({ code: 'unsafe_reason' });
    expect(h.missions.getMission(missionId)!.state).toBe('planned');
    expect(h.missions.listIntent(missionId)).toHaveLength(1);
    expect(JSON.stringify(h.call({ method: 'GET' }).body)).not.toContain('ghp_');
  });
});

describe('one poisoned row does not brick the list (mutation-testing pass on b3f72d1, P1.4b)', () => {
  /**
   * Measured before the fix: a credential-shaped `block_reason` written by
   * any path bypassing `checkReason` made `missionListing` throw OUTSIDE the
   * `safe()` wrapper, and `GET /control/missions` answered 500 for the ENTIRE
   * list — one poisoned reason made every mission unreadable. Now the
   * poisoned mission alone is withheld, with the field named and the value
   * absent, and the list answers 200 with the others intact.
   */
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234';

  it('answers 200 with the poisoned mission withheld and its neighbour untouched', () => {
    const h = harness();
    const clean = h.call({ body: COMMAND_BODY }).body.missionId as string;
    const poisoned = h.call({ body: { ...COMMAND_BODY, title: 'Poisoned', command: 'Draft the Q3 maintenance plan.' } }).body.missionId as string;
    h.fixture.db
      .prepare(`UPDATE hq_missions SET state = 'blocked', block_reason = ? WHERE id = ?`)
      .run(`Waiting on token ${TOKEN} from the auditor.`, poisoned);

    const listed = h.call({ method: 'GET' });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect(JSON.stringify(listed.body)).not.toContain('ghp_');
    const views = missionsOf(listed);
    expect(views).toHaveLength(2);
    const withheld = views.find((view) => view.missionId === poisoned)!;
    expect(withheld.withheld).toEqual({ path: `missions.${poisoned}.blockReason` });
    expect(withheld.title).not.toBe('Poisoned');
    expect(withheld.blockReason).toBeNull();
    const intact = views.find((view) => view.missionId === clean)!;
    expect(intact.withheld).toBeNull();
    expect(intact.title).toBe('Shift export');
    expect(intact.taskCount).toBe(2);
    // The store-wide facts still count the row as blocked.
    expect(listed.body.counts).toMatchObject({ total: 2, blocked: 1 });
    // The state document is served the same way, and the Mission Room names
    // the withheld row rather than losing it.
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.body)).not.toContain(TOKEN);
    const room = (state.body.rooms as RoomView[]).find((room) => room.roomId === 'mission-room')!;
    const row = room.rows.find((row) => row.id === `mission:${poisoned}`)!;
    expect(row.chips.map((chip) => chip.label)).toContainEqual(expect.stringContaining('withheld'));
  });

  it('still refuses the whole list, by name, when the substitute cannot be made safe', () => {
    // An identifier that is credential-shaped has no safe substitute; the
    // listing throws and the route answers the same refusal `safe()` gives,
    // audited as `unsafe_mission_listing` rather than falling through to the
    // anonymous catch-all.
    const h = harness();
    h.missions.insertMission({
      id: TOKEN,
      idempotencyKey: 'mission:poisoned-id',
      title: 'Id poisoned',
      project: null,
      state: 'planned',
      blockReason: null,
      requestedBy: 'founder',
      actorAuthentication: 'authenticated_os_session',
      requestedRoute: 'CLAUDE',
      at: FRESH,
    });
    const listed = h.call({ method: 'GET' });
    expect(listed.status).toBe(500);
    expect(listed.body.error).toMatchObject({ code: 'internal', message: 'The response could not be produced safely.' });
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    expect(h.audit.at(-1)?.detail).toBe('unsafe_mission_listing');
  });
});

describe('a deduplicated receipt names the plan links it could not carry, on the wire', () => {
  it('lists omittedTasks with the reason, and an empty list on creation', () => {
    const h = harness();
    const created = h.call({ body: COMMAND_BODY });
    expect(created.body.omittedTasks).toEqual([]);
    const gone = (created.body.tasks as { taskId: string }[])[1]!.taskId;
    h.fixture.db.pragma('foreign_keys = OFF');
    h.fixture.db.prepare(`DELETE FROM op_tasks WHERE id = ?`).run(gone);
    h.fixture.db.pragma('foreign_keys = ON');
    const again = h.call({ body: COMMAND_BODY });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ deduplicated: true, taskCount: 1 });
    expect(again.body.omittedTasks).toEqual([{ taskId: gone, ordinal: 2, reason: 'task_missing' }]);
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

  it('refuses an advancing transition with 403 while the kill switch is engaged, and records it after release', () => {
    // Opus second pass on `a849af8`. Verified before the fix: with
    // `engageKillSwitch('*')` in force, this exact request answered 200 and
    // the recorded state moved. The route maps `kill_switch_engaged` to 403
    // already — the order path has used that code since #200 — so once the
    // command layer consults the switch, the browser is told "refused, and
    // nothing in this request will change that", which is the truth.
    const h = harness();
    const missionId = h.call({ body: COMMAND_BODY }).body.missionId as string;
    expect(h.fixture.ops.engageKillSwitch('*', 'founder', 'incident').ok).toBe(true);
    const halted = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'working' } });
    expect(halted.status).toBe(403);
    expect(halted.body.error).toMatchObject({ code: 'kill_switch_engaged' });
    expect(h.missions.getMission(missionId)!.state).toBe('planned');
    expect(h.audit.at(-1)?.detail).toBe('kill_switch_engaged');
    expect(h.fixture.ops.releaseKillSwitch('*', 'founder').ok).toBe(true);
    const moved = h.call({ path: CONTROL_ROUTES.missionTransition, body: { missionId, to: 'working' } });
    expect(moved.status).toBe(200);
    expect(h.missions.getMission(missionId)!.state).toBe('working');
  });

  it('answers 409 mission_intent_missing, not an opaque 500, for a mission whose intent row is gone', () => {
    // Opus second pass on `a849af8`, nit 2. `existingReceipt` used to throw on
    // a mission with no intent row and the route turned it into `internal`.
    const h = harness();
    const created = h.call({ body: COMMAND_BODY });
    h.fixture.db.prepare(`DELETE FROM hq_mission_intent WHERE mission_id = ?`).run(created.body.missionId);
    const again = h.call({ body: COMMAND_BODY });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'mission_intent_missing' });
    expect(h.missions.countMissions()).toBe(1);
    // The list still answers, and reports the chain as not intact.
    expect(missionsOf(h.call({ method: 'GET' }))[0]!.intent.chainIntact).toBe(false);
  });
});

describe('the list is explicit about being a window (Opus second pass on a849af8, P1)', () => {
  /**
   * Reproduced before the fix, with 55 missions of which the 5 oldest were
   * blocked: `GET /control/missions` reported `counts.total 50, blocked 0`;
   * the Mission Room showed "Missions recorded 50" with the hint "Founder
   * missions the mission core holds, in any state"; the Command Room showed
   * "Missions needing attention 0"; and because `missionAttention` also feeds
   * `livenessFrom`, the room rendered quiet over five blocked missions.
   *
   * The missions are inserted straight into the store rather than through
   * the command path — 55 real orders would create 55 gated tasks the test
   * does not need — and given ascending timestamps so the window is the
   * newest 50 and the blocked five are exactly the ones it leaves out.
   */
  function seeded(): Harness {
    const h = harness();
    for (let i = 0; i < 55; i += 1) {
      const blocked = i < 5;
      h.missions.insertMission({
        id: `m-${String(i).padStart(3, '0')}`,
        idempotencyKey: `mission:seed-${i}`,
        title: `Seeded mission ${i}`,
        project: null,
        state: blocked ? 'blocked' : 'planned',
        blockReason: blocked ? 'Waiting on the auditor.' : null,
        requestedBy: 'founder',
        actorAuthentication: 'authenticated_os_session',
        requestedRoute: 'CLAUDE',
        at: new Date(NOW.getTime() - (55 - i) * 60_000).toISOString(),
      });
    }
    return h;
  }

  it('carries total, listed, limit and truncated, and counts the blocked five the window omits', () => {
    const listed = seeded().call({ method: 'GET' });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ recorded: 55, listed: 50, limit: 50, truncated: true });
    expect(missionsOf(listed)).toHaveLength(50);
    expect(missionsOf(listed).filter((view) => view.state === 'blocked')).toHaveLength(0);
    // Store-wide, not the window: this is the line that used to read 50 / 0.
    expect(listed.body.counts).toMatchObject({ total: 55, listed: 50, truncated: true, blocked: 5, planned: 50, drift: 0 });
  });

  it('labels every room metric by what it was counted over, and lights the rooms for the omitted blocked missions', () => {
    const state = seeded().call({ method: 'GET', path: CONTROL_ROUTES.state });
    const rooms = state.body.rooms as RoomView[];
    const byLabel = (room: RoomView, label: string) => room.metrics.find((metric) => metric.label === label);

    const mission = rooms.find((room) => room.roomId === 'mission-room')!;
    expect(byLabel(mission, 'Missions recorded')!.value).toBe(55);
    expect(byLabel(mission, 'Missions recorded')!.hint).toContain('whole store');
    // The precedent two sections away — "Events in window" — applied to
    // missions: the window's size is a metric of its own, and the one
    // window-scoped count is labelled as one, in label AND hint.
    expect(byLabel(mission, 'Missions in window')!.value).toBe(50);
    expect(byLabel(mission, 'Missions in window')!.hint).toContain('5 older mission(s)');
    expect(byLabel(mission, 'Missions blocked')!.value).toBe(5);
    expect(byLabel(mission, 'Missions blocked')!.hint).toContain('Store-wide');
    expect(byLabel(mission, 'Recorded state disagrees with tasks')).toBeUndefined();
    const drift = byLabel(mission, 'Recorded state disagrees with tasks — in window')!;
    expect(drift.value).toBe(0);
    expect(drift.hint).toContain('the 50 most recent of 55');
    expect(mission.liveness).toBe('attention');

    const command = rooms.find((room) => room.roomId === 'command-room')!;
    const attention = byLabel(command, 'Missions needing attention')!;
    expect(attention.value).toBe(5);
    // The count says which part is store-wide and which is window-scoped,
    // because it is a sum of both.
    expect(attention.hint).toContain('anywhere in the store (5)');
    expect(attention.hint).toContain('among the 50 most recent of 55 listed');
    expect(attention.hint).toContain('Drift is known only for listed missions');
    expect(command.liveness).toBe('attention');

    const home = rooms.find((room) => room.roomId === 'home')!;
    expect(byLabel(home, 'Missions needing you')!.value).toBe(5);
    expect(home.liveness).toBe('attention');

    const analytics = rooms.find((room) => room.roomId === 'analytics')!;
    expect(byLabel(analytics, 'Missions recorded')!.value).toBe(55);
    expect(byLabel(analytics, 'Missions recorded')!.hint).toContain('not the listed window');
  });

  it('draws no window metric and no window suffix when the store fits in one read', () => {
    const h = harness();
    h.call({ body: COMMAND_BODY });
    const listed = h.call({ method: 'GET' });
    expect(listed.body).toMatchObject({ recorded: 1, listed: 1, truncated: false });
    const rooms = h.call({ method: 'GET', path: CONTROL_ROUTES.state }).body.rooms as RoomView[];
    const mission = rooms.find((room) => room.roomId === 'mission-room')!;
    expect(mission.metrics.some((metric) => metric.label === 'Missions in window')).toBe(false);
    expect(mission.metrics.some((metric) => metric.label === 'Recorded state disagrees with tasks')).toBe(true);
    const command = rooms.find((room) => room.roomId === 'command-room')!;
    expect(command.metrics.find((metric) => metric.label === 'Missions needing attention')!.hint).not.toContain('store');
  });
});

describe('the route table and the module docstring say only what is true (Opus second pass on a849af8)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/live/control-api.ts', import.meta.url)), 'utf8');

  it('matches the transition path literally and 404s after it — no fallthrough default', () => {
    // Nit 1. `return transition(...)` was the unguarded last line of the
    // mission dispatch: a fifth mission path added to `known` without a branch
    // would have silently executed a transition. Every `return transition(`
    // in the file must now sit behind a literal match on its route.
    // Comments aside — the fix's own comment quotes the old line.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const calls = [...code.matchAll(/^.*return transition\(.*$/gm)].map((match) => match[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      expect(line).toContain('if (path === CONTROL_ROUTES.missionTransition) return transition(');
    }
  });

  it('no longer claims the mission routes add no mutation the order/approval writes could reach', () => {
    // The overclaim: a mission state transition is a mutation class with no
    // order/approval equivalent, and a clarification-needed POST commits three
    // rows on a path that never reaches createTask. The docstring now says
    // what is true — no new unit of WORK — and names what is genuinely new.
    expect(source).not.toContain('add no mutation the three');
    expect(source).toContain('create no new unit of WORK');
    expect(source).toContain('a mission state transition is a mutation class');
    expect(source).toContain('never reaches `createTask`');
  });
});

describe('an absent mission store is named as the cause in the browser (Opus second pass on a849af8, P2)', () => {
  it('gives the console a mission reason that names the store, not the principal or the registry', () => {
    // The session route published `missionCoreAttached: false` and nothing
    // consumed it: the grant rule fell through to a sentence blaming the
    // principal's authority or the capability registry, both of which are
    // fine here. This feeds the REAL session body to the REAL embedded grant
    // rule and reads the reason the console would draw.
    const grantedControls = new Function(`${CONTROL_GRANT_JS}; return grantedControls;`)() as (
      session: unknown,
    ) => { founderCommand: boolean; reason: string; missionReason: string };
    const h = harness({ store: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body;
    const grant = grantedControls(session);
    expect(grant.founderCommand).toBe(false);
    expect(grant.missionReason).toContain('No mission store is attached');
    expect(grant.missionReason).toContain('not what withheld it');
    expect(grant.missionReason).not.toContain('principal may not hold');
    // The order control on the same deployment IS granted, and its reason is
    // untouched: an absent mission store says nothing about direct orders.
    expect((session.controls as Record<string, unknown>).directOrder).toBe(true);
    expect(grant.reason).not.toContain('mission store');
  });
});
