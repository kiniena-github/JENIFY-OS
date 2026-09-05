/**
 * The Phase 3 mission routes on the HQ control API, end to end against the
 * real canonical machinery (issue #253).
 *
 * `mission-core.test.ts` proves the authority layer. This suite proves the
 * things that are only true once a browser is in front of it: the acting
 * principal is the server-resolved Founder and never a body field; every
 * hostile case the existing routes fail closed on — no session, non-Founder,
 * bad origin, wrong content type, client-supplied identity, mutations off —
 * fails closed on the new routes too; the read model that reaches the browser
 * carries the normalized intent and NOT the raw command; an empty HQ reports
 * zero missions as zero; and the state route's Mission Room projects the same
 * missions the list route returns.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { hydrateRooms } from '../src/client/hydrate.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { assertNoFabricatedFields } from '../src/live/redaction.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  MAX_MISSION_CANCEL_REASON_LENGTH,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { FOUNDER_COMMAND_CAPABILITY, registerFounderCommandCapability, type MissionView } from '../src/application/mission-core.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';
import type { RoomView } from '../src/client/contracts.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-05T09:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
const COMMAND = 'Improve the QOS website speed without changing the design or deploying production.';
const RAW_MARKER = 'RAW-COMMAND-MARKER-4471';

const FOUNDER_ACCOUNT: AuthenticatedAccount = { realmId: 'tenant-1', accountId: 'user-founder', displayName: 'Founder', authenticatedAt: FRESH };
const STAFF_ACCOUNT: AuthenticatedAccount = { realmId: 'tenant-1', accountId: 'user-staff', displayName: 'Warehouse Lead', authenticatedAt: FRESH };
const MAP = [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }];

interface Harness {
  fixture: Fixture;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
  command(body: Record<string, unknown>): ControlResponse;
  list(): MissionView[];
}

function harness(options: { grant?: boolean; approvalAuthority?: boolean; origins?: string[]; mutationsEnabled?: boolean; account?: AuthenticatedAccount | null } = {}): Harness {
  const fixture = setupFixture();
  registerFounderCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: options.grant === false ? [] : [FOUNDER_COMMAND_CAPABILITY.id],
    approvalAuthority: options.approvalAuthority ?? true,
    active: true,
  });
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null = options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: options.origins ?? [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    mutationsEnabled: options.mutationsEnabled,
    now: () => NOW,
  };
  const call: Harness['call'] = (request, account) => {
    if (account !== undefined) current = account;
    const method = request.method ?? 'POST';
    const headers =
      request.headers ??
      (method === 'GET' ? { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' } : { origin: ORIGIN, 'content-type': 'application/json' });
    return handleControlRequest({ method, path: request.path ?? CONTROL_ROUTES.missions, headers, body: request.body }, deps);
  };
  return {
    fixture,
    audit,
    deps,
    call,
    command: (body) => call({ method: 'POST', path: CONTROL_ROUTES.missions, body }),
    list: () => (call({ method: 'GET', path: CONTROL_ROUTES.missions }).body as { missions: MissionView[] }).missions,
  };
}

describe('POST /missions — a Founder command becomes a canonical mission through the browser', () => {
  it('creates the mission as the server-resolved principal, and dedupes an identical retry', () => {
    const h = harness();
    const created = h.command({ instruction: COMMAND, project: 'qos', priority: 'p1', idempotencyKey: 'c1' });
    expect(created.status).toBe(201);
    const body = created.body as { ok: boolean; missionId: string; status: string; deduplicated: boolean; intentVersion: number; mission: MissionView };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('planned');
    expect(body.deduplicated).toBe(false);
    expect(body.intentVersion).toBe(1);
    expect(body.mission.createdBy).toBe('founder');
    // Earned, not asserted: the interface that authenticated the session says so.
    expect(body.mission.actorAuthentication).toBe('authenticated_os_session');
    expect(body.mission.priority).toBe('p1');
    expect(body.mission.intent.doNot).toEqual(['changing the design', 'deploying production']);

    const again = h.command({ instruction: COMMAND, project: 'qos', priority: 'p1', idempotencyKey: 'c1' });
    expect(again.status).toBe(200);
    expect((again.body as { deduplicated: boolean; missionId: string }).deduplicated).toBe(true);
    expect((again.body as { missionId: string }).missionId).toBe(body.missionId);
    expect(h.list()).toHaveLength(1);
    expect(h.audit.map((event) => event.detail)).toEqual(['mission_created', 'mission_deduplicated', 'list_missions']);
  });

  it('refuses a body that names an actor, rather than re-attributing it', () => {
    const h = harness();
    for (const key of ['requestedBy', 'founderId', 'principalId', 'actorAuthentication']) {
      const response = h.command({ instruction: COMMAND, [key]: 'coo' });
      expect(response.status, key).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe('client_identity_supplied');
    }
    expect(h.list()).toEqual([]);
  });

  it('refuses a structured plan from the browser: the browser is not a planner', () => {
    const h = harness();
    const response = h.command({ instruction: COMMAND, plan: { planner: 'browser', tasks: [] } });
    expect(response.status).toBe(400);
    expect((response.body as { error: { message: string } }).error.message).toContain('not accepted from the browser');
    expect(h.list()).toEqual([]);
  });

  it('refuses a bad priority, an empty command and a credential-shaped command as 400, and creates nothing', () => {
    const h = harness();
    expect(h.command({ instruction: COMMAND, priority: 'urgent' }).status).toBe(400);
    expect(h.command({ instruction: '   ' }).status).toBe(400);
    const unsafe = h.command({ instruction: 'Rotate nothing; api_key: sk-abcdefghijklmnopqrstuvwxyz' });
    expect(unsafe.status).toBe(400);
    expect((unsafe.body as { error: { code: string } }).error.code).toBe('unsafe_command');
    expect(h.list()).toEqual([]);
  });

  it('records a Founder-gate command as BLOCKED with an open decision, not as a plan around it', () => {
    const h = harness();
    const created = h.command({ instruction: 'Fix the header and deploy it to production.' });
    expect(created.status).toBe(201);
    const mission = (created.body as { mission: MissionView }).mission;
    expect(mission.status).toBe('blocked');
    expect(mission.decisions.map((decision) => decision.kind)).toEqual(['founder_gate']);
  });
});

describe('the new routes fail closed on every hostile case the old ones do', () => {
  it('refuses an unauthenticated caller on read and both writes', () => {
    const h = harness({ account: null });
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.missions }).status).toBe(401);
    expect(h.command({ instruction: COMMAND }).status).toBe(401);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId: 'x', reason: 'y', expectedIntentVersion: 1 } }).status).toBe(401);
    expect(h.fixture.ops.missions.list()).toEqual([]);
  });

  it('refuses a signed-in non-Founder on read and both writes, revealing nothing', () => {
    const h = harness({ account: STAFF_ACCOUNT });
    const read = h.call({ method: 'GET', path: CONTROL_ROUTES.missions });
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain('missions"');
    expect(h.command({ instruction: COMMAND }).status).toBe(403);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId: 'x', reason: 'y', expectedIntentVersion: 1 } }).status).toBe(403);
    expect(h.fixture.ops.missions.list()).toEqual([]);
  });

  it('refuses a mapped Founder who does not hold the originate grant (403, nothing created)', () => {
    const h = harness({ grant: false });
    const response = h.command({ instruction: COMMAND });
    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('not_permitted');
    expect(h.list()).toEqual([]);
    // The read still works: seeing missions needs a Founder session, not the grant.
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.missions }).status).toBe(200);
  });

  it('refuses a cross-site or malformed write before identity is even resolved', () => {
    const h = harness();
    const foreign = h.call({ method: 'POST', path: CONTROL_ROUTES.missions, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: { instruction: COMMAND } });
    expect(foreign.status).toBe(403);
    expect((foreign.body as { error: { code: string } }).error.code).toBe('origin_not_allowed');
    const missing = h.call({ method: 'POST', path: CONTROL_ROUTES.missions, headers: { 'content-type': 'application/json' }, body: { instruction: COMMAND } });
    expect(missing.status).toBe(403);
    const form = h.call({ method: 'POST', path: CONTROL_ROUTES.missions, headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: { instruction: COMMAND } });
    expect(form.status).toBe(403);
    expect((form.body as { error: { code: string } }).error.code).toBe('content_type_not_json');
    const noOrigins = harness({ origins: [] });
    expect(noOrigins.command({ instruction: COMMAND }).status).toBe(403);
    expect(h.list()).toEqual([]);
  });

  it('refuses writes where browser mutations are switched off, and still serves the read', () => {
    const h = harness({ mutationsEnabled: false });
    expect(h.command({ instruction: COMMAND }).status).toBe(403);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId: 'x', reason: 'y', expectedIntentVersion: 1 } }).status).toBe(403);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.missions }).status).toBe(200);
  });

  it('is exact-match: a verb the table does not list is a 404 that reveals nothing', () => {
    const h = harness();
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.missionCancel }).status).toBe(404);
    expect(h.call({ method: 'DELETE', path: CONTROL_ROUTES.missions }).status).toBe(404);
    expect(h.call({ method: 'GET', path: `${CONTROL_ROUTES.missions}/some-id` }).status).toBe(404);
    expect(h.call({ method: 'POST', path: `${CONTROL_ROUTES.missions}/revise` }).status).toBe(404);
  });

  it('advertises the command and cancel controls on exactly the conditions that decide the writes', () => {
    const session = (h: Harness) => (h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body as { controls: Record<string, unknown> }).controls;
    expect(session(harness())).toMatchObject({ founderCommand: true, cancelMission: true });
    expect(session(harness({ grant: false }))).toMatchObject({ founderCommand: false, cancelMission: true });
    expect(session(harness({ approvalAuthority: false }))).toMatchObject({ founderCommand: true, cancelMission: false });
    expect(session(harness({ mutationsEnabled: false }))).toMatchObject({ founderCommand: false, cancelMission: false });
    expect(session(harness({ origins: ['https://elsewhere.example'] }))).toMatchObject({ founderCommand: false, cancelMission: false });
    // A capability row the registry does not hold withdraws the composer.
    const unregistered = setupFixture();
    unregistered.principals.register({ id: 'founder', displayName: 'Founder', originateCapabilities: [FOUNDER_COMMAND_CAPABILITY.id], approvalAuthority: true, active: true });
    const h = harness();
    const body = handleControlRequest(
      { method: 'GET', path: CONTROL_ROUTES.session, headers: { referer: `${ORIGIN}/hq/index.html` } },
      { ...h.deps, ops: unregistered.ops },
    ).body as { controls: Record<string, unknown> };
    expect(body.controls.founderCommand).toBe(false);
  });
});

describe('what the browser is told about a mission', () => {
  it('carries the normalized intent and the command digest, and never the raw command text', () => {
    const h = harness();
    const created = h.command({ instruction: `Speed up the checkout page. Internal context ${RAW_MARKER} for the team. Keep the design.`, title: 'Checkout speed' });
    expect(created.status).toBe(201);
    const list = h.call({ method: 'GET', path: CONTROL_ROUTES.missions });
    expect(list.status).toBe(200);
    const serialized = JSON.stringify([created.body, list.body]);
    expect(serialized).not.toContain(RAW_MARKER);
    expect(serialized).not.toContain('originalInstruction');
    expect(serialized).not.toContain('original_instruction');
    const mission = (list.body as { missions: MissionView[] }).missions[0]!;
    expect(mission.title).toBe('Checkout speed');
    expect(mission.intent.objective).toBe('Speed up the checkout page');
    expect(mission.commandDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(mission.commandLength).toBeGreaterThan(0);
    // The state route — what the rooms are hydrated from — is equally silent.
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.body)).not.toContain(RAW_MARKER);
  });

  it('publishes no fabricated metric on any mission surface', () => {
    const h = harness();
    h.command({ instruction: COMMAND });
    for (const path of [CONTROL_ROUTES.missions, CONTROL_ROUTES.state]) {
      const body = h.call({ method: 'GET', path }).body;
      expect(() => assertNoFabricatedFields(body)).not.toThrow();
      const serialized = JSON.stringify(body).toLowerCase();
      for (const forbidden of ['"cost', '"tokens', '"eta', '"progress', '"percentcomplete', '"sentiment', '"workersactive']) {
        expect(serialized, `${path} ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('reports an empty HQ as an empty list, with provenance, and the Mission Room dark', () => {
    const h = harness();
    const list = h.call({ method: 'GET', path: CONTROL_ROUTES.missions }).body as { ok: boolean; missions: unknown[]; provenance: string; generatedAt: string };
    expect(list.ok).toBe(true);
    expect(list.missions).toEqual([]);
    expect(list.provenance).toContain('MissionCore.list');
    expect(list.generatedAt).toBe(NOW.toISOString());
    const rooms = (h.call({ method: 'GET', path: CONTROL_ROUTES.state }).body as { rooms: RoomView[] }).rooms;
    const missionRoom = rooms.find((room) => room.roomId === 'mission-room')!;
    expect(missionRoom.status).toBe('live');
    expect(missionRoom.liveness).toBe('dark');
    expect(missionRoom.rows).toEqual([]);
    expect(missionRoom.metrics.find((metric) => metric.label === 'Missions recorded')!.value).toBe(0);
    expect(missionRoom.emptyMessage).toContain('No Founder mission is recorded');
  });

  it('projects the same missions into the Mission Room that the list route returns', () => {
    const h = harness();
    h.command({ instruction: COMMAND, title: 'QOS speed', project: 'qos' });
    h.command({ instruction: 'Fix the header and deploy it to production.', title: 'Header + deploy' });
    const listed = h.list();
    expect(listed.map((mission) => mission.title).sort()).toEqual(['Header + deploy', 'QOS speed']);
    const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
    expect(snapshot.missions.data.map((mission) => mission.id).sort()).toEqual(listed.map((mission) => mission.id).sort());
    expect(snapshot.missions.provenance.source).toContain('hq_missions');
    const room = hydrateRooms(snapshot, null).find((view) => view.roomId === 'mission-room')!;
    expect(room.metrics.find((metric) => metric.label === 'Missions recorded')!.value).toBe(2);
    expect(room.metrics.find((metric) => metric.label === 'mission blocked')!.value).toBe(1);
    expect(room.metrics.find((metric) => metric.label === 'mission planned')!.value).toBe(1);
    // A blocked mission lights the room for attention; the rows carry the
    // normalized objective and the block reason, never the command.
    expect(room.liveness).toBe('attention');
    const blockedRow = room.rows.find((row) => row.primary === 'Header + deploy')!;
    expect(blockedRow.secondary).toContain('BLOCKED');
    expect(blockedRow.chips.map((chip) => chip.label)).toContain('1 decision(s) need you');
    expect(JSON.stringify(room)).not.toContain('deploy it to production.');
  });
});

describe('POST /missions/cancel — the honest cancellation path through the browser', () => {
  it('cancels with a reason, fenced on the displayed intent version', () => {
    const h = harness();
    const missionId = (h.command({ instruction: COMMAND }).body as { missionId: string }).missionId;
    const stale = h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'Superseded', expectedIntentVersion: 2 } });
    expect(stale.status).toBe(409);
    expect((stale.body as { error: { code: string } }).error.code).toBe('stale_intent_version');
    expect(h.list()[0]!.status).toBe('planned');

    const cancelled = h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'Superseded', expectedIntentVersion: 1 } });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { status: string }).status).toBe('cancelled');
    expect(h.list()[0]!.status).toBe('cancelled');
    expect(h.list()[0]!.outcome).toMatchObject({ decision: 'cancelled', by: 'founder', note: 'Superseded' });
    // Twice is a 409, not a silent success.
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'again', expectedIntentVersion: 1 } }).status).toBe(409);
  });

  it('validates the body: id, reason, integer version, bounded and credential-free reason', () => {
    const h = harness();
    const missionId = (h.command({ instruction: COMMAND }).body as { missionId: string }).missionId;
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'x' } }).status).toBe(400);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'x', expectedIntentVersion: '1' } }).status).toBe(400);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: '  ', expectedIntentVersion: 1 } }).status).toBe(400);
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'r'.repeat(MAX_MISSION_CANCEL_REASON_LENGTH + 1), expectedIntentVersion: 1 } }).status).toBe(400);
    const unsafe = h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'token: ghp_abcdefghijklmnopqrstuvwxyz1234', expectedIntentVersion: 1 } });
    expect(unsafe.status).toBe(400);
    expect((unsafe.body as { error: { code: string } }).error.code).toBe('unsafe_reason');
    expect(h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId: 'no-such-mission', reason: 'x', expectedIntentVersion: 1 } }).status).toBe(404);
    expect(h.list()[0]!.status).toBe('planned');
  });

  it('refuses a mapped Founder without approval authority', () => {
    const h = harness({ approvalAuthority: false });
    const missionId = (h.command({ instruction: COMMAND }).body as { missionId: string }).missionId;
    const response = h.call({ method: 'POST', path: CONTROL_ROUTES.missionCancel, body: { missionId, reason: 'x', expectedIntentVersion: 1 } });
    expect(response.status).toBe(403);
    expect(h.list()[0]!.status).toBe('planned');
  });
});
