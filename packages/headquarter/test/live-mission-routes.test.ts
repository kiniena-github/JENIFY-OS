/**
 * Phase 3 mission routes, end to end against the real canonical machinery.
 *
 * The three mission writes and the mission read join the control API behind
 * the SAME pipeline as every other route — origin/content-type gate,
 * client-identity scan, Founder resolution, `safe()` on every response. This
 * suite proves the wiring: the acting principal is always the mapped one, the
 * raw order text never crosses the boundary, refusals carry one status per
 * cause, and an engaged kill switch stops execution — never the recording of
 * Founder direction.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-05T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

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
    mutationsEnabled?: boolean;
    /** Grant the Founder principal the mission-command capability. */
    grant?: boolean;
    /** Register the mission-command capability (the configuration act). */
    register?: boolean;
  } = {},
): Harness {
  const fixture = setupFixture();
  if (options.register !== false) registerMissionCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: options.grant === false ? [] : [MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });

  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
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
    call(request, account) {
      if (account !== undefined) current = account;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.missions, headers, body: request.body },
        deps,
      );
    },
  };
}

const RAW_ORDER = 'Improve the QOS website speed without changing the visual design.';
const COMMAND_BODY = {
  title: 'Improve QOS website speed',
  objective: 'Reduce QOS page load times without changing the visual design',
  constraints: ['Do not change the visual design', 'Do not deploy production'],
  instruction: RAW_ORDER,
};

function commanded(h: Harness): string {
  const response = h.call({ body: COMMAND_BODY });
  expect(response.status).toBe(201);
  return (response.body.mission as { id: string }).id;
}

describe('the write surface is stated, not inferred', () => {
  it('names every state-changing route, the mission writes included', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.orders);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.approve);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.deny);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.missions);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.missionTransition);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.missionAmend);
    expect(CONTROL_WRITE_ROUTES).toHaveLength(6);
  });
});

describe('a mapped Founder commands a canonical mission through the facade', () => {
  it('creates the mission attributed to the mapped principal, 201 with the view', () => {
    const h = harness();
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.deduplicated).toBe(false);
    const mission = response.body.mission as Record<string, unknown>;
    expect(mission.status).toBe('planned');
    expect(mission.createdBy).toBe('founder');
    expect(mission.title).toBe(COMMAND_BODY.title);
    // The canonical record agrees.
    const record = h.fixture.ops.getMission(mission.id as string)!;
    expect(record.createdBy).toBe('founder');
  });

  it('dedupes an identical re-command with 200 and the same mission', () => {
    const h = harness();
    const first = h.call({ body: COMMAND_BODY });
    const second = h.call({ body: COMMAND_BODY });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect((second.body.mission as { id: string }).id).toBe(
      (first.body.mission as { id: string }).id,
    );
  });

  it('refuses a body that names an actor rather than re-attributing it', () => {
    const h = harness();
    const response = h.call({ body: { ...COMMAND_BODY, requestedBy: 'someone-else' } });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('client_identity_supplied');
  });

  it('refuses a principal without the mission grant — mapped is not granted', () => {
    const h = harness({ grant: false });
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('not_permitted');
  });

  it('fails closed while the capability is unregistered — 403, and no repair', () => {
    const h = harness({ register: false });
    const response = h.call({ body: COMMAND_BODY });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('unknown_capability');
    expect(
      h.fixture.db
        .prepare(`SELECT 1 FROM op_capabilities WHERE id = ?`)
        .get(MISSION_COMMAND_CAPABILITY.id),
    ).toBeUndefined();
  });
});

describe('the shared pipeline holds for every mission route', () => {
  it('refuses anonymous callers with 401 on all four routes', () => {
    const h = harness({ account: null });
    for (const [method, path] of [
      ['GET', CONTROL_ROUTES.missions],
      ['POST', CONTROL_ROUTES.missions],
      ['POST', CONTROL_ROUTES.missionTransition],
      ['POST', CONTROL_ROUTES.missionAmend],
    ] as const) {
      const response = h.call({ method, path, body: {} });
      expect(response.status).toBe(401);
    }
  });

  it('refuses a signed-in non-Founder with 403 and no mission oracle', () => {
    const h = harness();
    commanded(h);
    const read = h.call({ method: 'GET', path: CONTROL_ROUTES.missions, body: undefined }, STAFF_ACCOUNT);
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain('mission-');
  });

  it('refuses a mission write without origin evidence, before anything else runs', () => {
    const h = harness();
    const response = h.call({
      body: COMMAND_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('origin_missing');
  });

  it('refuses a mission write whose content type an HTML form could produce', () => {
    const h = harness();
    const response = h.call({
      body: COMMAND_BODY,
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.status).toBe(403);
    expect((response.body.error as { code: string }).code).toBe('content_type_not_json');
  });

  it('honours the mutations flag on writes while the mission read stays served', () => {
    const h = harness({ mutationsEnabled: false });
    const write = h.call({ body: COMMAND_BODY });
    expect(write.status).toBe(403);
    expect((write.body.error as { code: string }).code).toBe('mutations_disabled');
    const read = h.call({ method: 'GET', path: CONTROL_ROUTES.missions, body: undefined });
    expect(read.status).toBe(200);
    expect(read.body.missions).toEqual([]);
  });

  it('still answers 404 for anything that is not an exact route', () => {
    const h = harness();
    for (const path of [
      `${CONTROL_ROUTES.missions}/`,
      `${CONTROL_ROUTES.missions}/mission-123`,
      `${CONTROL_ROUTES.missions}/transition/extra`,
    ]) {
      const response = h.call({ path, body: {} });
      expect(response.status).toBe(404);
    }
  });
});

describe('raw instruction material stays server-side', () => {
  it('never returns the raw order or any intent body through any mission response', () => {
    const h = harness();
    const created = h.call({ body: COMMAND_BODY });
    const id = (created.body.mission as { id: string }).id;
    h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: { missionId: id, amendment: 'A private rationale for the change.' },
    });
    for (const response of [
      created,
      h.call({ method: 'GET', path: CONTROL_ROUTES.missions, body: undefined }),
    ]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(RAW_ORDER);
      expect(text).not.toContain('A private rationale');
      expect(text).not.toContain('"body"');
      expect(text).not.toContain('idempotencyKey');
    }
    // The server-side record still holds both, for audit.
    const history = h.fixture.ops.getMissionIntentHistory(id);
    expect(history[0]!.body).toContain(RAW_ORDER);
    expect(history[1]!.body).toContain('A private rationale');
  });

  it('exposes the STRUCTURED original intent for audit while the raw text stays server-side (M3)', () => {
    // The Founder Intent Lock is inspectable in-product: after an amendment
    // replaces the canonical fields, the browser can still read the original
    // structured objective/constraints per sequence — without ever seeing
    // the raw order text or the amendment rationale.
    const h = harness();
    const id = (h.call({ body: COMMAND_BODY }).body.mission as { id: string }).id;
    h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: {
        missionId: id,
        amendment: 'A private rationale for narrowing the objective.',
        objective: 'Reduce QOS landing-page load time only',
        constraints: ['Do not change the visual design'],
      },
    });
    const listed = h.call({ method: 'GET', path: CONTROL_ROUTES.missions, body: undefined });
    const mission = (listed.body.missions as Record<string, unknown>[]).find(
      (m) => m.id === id,
    )! as {
      objective: string;
      intentHistory: {
        seq: number;
        kind: string;
        actor: string;
        at: string;
        objective: string;
        constraints: string[];
        acceptanceCriteria: string[] | null;
      }[];
    };
    // The current record changed truthfully…
    expect(mission.objective).toBe('Reduce QOS landing-page load time only');
    // …the ORIGINAL structured intent (seq 0) is visible and unchanged…
    expect(mission.intentHistory).toHaveLength(2);
    const original = mission.intentHistory[0]!;
    expect(original.seq).toBe(0);
    expect(original.kind).toBe('founder_order');
    expect(original.actor).toBe('founder');
    expect(original.objective).toBe(
      'Reduce QOS page load times without changing the visual design',
    );
    expect(original.constraints).toEqual([
      'Do not change the visual design',
      'Do not deploy production',
    ]);
    // …and the amendment entry carries the state it produced.
    expect(mission.intentHistory[1]!.objective).toBe('Reduce QOS landing-page load time only');
    // Raw material still never crosses: checked field by field above via the
    // exact key pin (mission-core) and here over the whole wire body.
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain(RAW_ORDER);
    expect(text).not.toContain('A private rationale');
    expect(text).not.toContain('"body"');
  });

  it('a raced amendment answers 409 with a typed conflict, not an opaque 500', () => {
    // Injects the UNIQUE violation a cross-process race would produce (the
    // in-process window is closed by the IMMEDIATE transaction) and pins the
    // wire contract for it.
    const h = harness();
    const id = commanded(h);
    const realPrepare = h.fixture.db.prepare.bind(h.fixture.db);
    const dbPatched = h.fixture.db as unknown as { prepare: (sql: string) => unknown };
    dbPatched.prepare = (sql: string) => {
      if (/INSERT INTO hq_mission_intents/.test(sql)) {
        const collision = new Error(
          'UNIQUE constraint failed: hq_mission_intents.mission_id, hq_mission_intents.seq',
        ) as Error & { code: string };
        collision.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw collision;
      }
      return realPrepare(sql);
    };
    try {
      const response = h.call({
        path: CONTROL_ROUTES.missionAmend,
        body: { missionId: id, amendment: 'Loses the race.' },
      });
      expect(response.status).toBe(409);
      expect((response.body.error as { code: string }).code).toBe('mission_intent_conflict');
    } finally {
      dbPatched.prepare = realPrepare;
    }
    expect(h.fixture.ops.getMissionIntentHistory(id)).toHaveLength(1);
  });

  it('refuses credential-shaped mission text with the boundary scan, storing nothing', () => {
    const h = harness();
    const response = h.call({
      body: {
        ...COMMAND_BODY,
        instruction: 'Push using ghp_0123456789abcdef0123456789abcdef012345',
      },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unsafe_mission_content');
    expect(
      (h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('mission lifecycle over the wire', () => {
  it('transitions with one status per refusal cause', () => {
    const h = harness();
    const id = commanded(h);

    const moved = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'working' },
    });
    expect(moved.status).toBe(200);
    expect((moved.body.mission as { status: string }).status).toBe('working');

    const illegal = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'complete' },
    });
    expect(illegal.status).toBe(409);
    expect((illegal.body.error as { code: string }).code).toBe('invalid_mission_transition');

    const replay = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'working' },
    });
    expect(replay.status).toBe(409);
    expect((replay.body.error as { code: string }).code).toBe('mission_status_changed');

    const unknown = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: 'mission-never-existed', to: 'working' },
    });
    expect(unknown.status).toBe(404);

    const noteless = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'cancelled' },
    });
    expect(noteless.status).toBe(400);
    expect((noteless.body.error as { message: string }).message).toContain('requires a note');
  });

  it('amends append-only and refuses a terminal mission with 409', () => {
    const h = harness();
    const id = commanded(h);
    const amended = h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: {
        missionId: id,
        amendment: 'Focus on the landing page first.',
        addPlanItems: ['Profile the landing page'],
      },
    });
    expect(amended.status).toBe(200);
    const items = (amended.body.mission as { planItems: { summary: string }[] }).planItems;
    expect(items.some((item) => item.summary === 'Profile the landing page')).toBe(true);

    h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'cancelled', note: 'Direction changed.' },
    });
    const late = h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: { missionId: id, amendment: 'Too late.' },
    });
    expect(late.status).toBe(409);
    expect((late.body.error as { code: string }).code).toBe('mission_terminal');
  });

  it('keeps recording Founder direction while the kill switch is engaged', () => {
    const h = harness();
    h.fixture.ops.engageKillSwitch('*', 'founder', 'containment drill');
    const id = commanded(h);
    const cancelled = h.call({
      path: CONTROL_ROUTES.missionTransition,
      body: { missionId: id, to: 'cancelled', note: 'Cancelled during the drill.' },
    });
    expect(cancelled.status).toBe(200);
    // …and still nothing executable came into existence.
    expect(
      (h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('the session route advertises mission command from the deciding conditions', () => {
  it('advertises true exactly when granted, registered and writable', () => {
    const h = harness();
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session, body: undefined });
    expect((session.body.controls as { missionCommand: boolean }).missionCommand).toBe(true);
  });

  it('advertises false without the grant', () => {
    const h = harness({ grant: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session, body: undefined });
    expect((session.body.controls as { missionCommand: boolean }).missionCommand).toBe(false);
  });

  it('advertises false while the capability is unregistered', () => {
    const h = harness({ register: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session, body: undefined });
    expect((session.body.controls as { missionCommand: boolean }).missionCommand).toBe(false);
  });

  it('advertises false while mutations are disabled', () => {
    const h = harness({ mutationsEnabled: false });
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session, body: undefined });
    expect((session.body.controls as { missionCommand: boolean }).missionCommand).toBe(false);
  });
});
