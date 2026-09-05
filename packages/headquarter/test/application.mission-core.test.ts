/**
 * Phase 3 — Founder Command + Mission Core: the facade surface.
 *
 * The mission aggregate is a durable planning record ABOVE tasks. These tests
 * pin the properties issue #254 requires as evidence: Founder-only creation
 * (deny by default), idempotent duplicate commands, the intent lock (original
 * order immutable under amendments), append-only history, the 8-state
 * lifecycle with refusal of invalid transitions, honest deterministic plan
 * generation, and — because Phase 3 is NOT the orchestrator — that missions
 * execute nothing and never touch the approval or task tables.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { HeadquarterOperations } from '../src/application/service.js';
import type { MissionStatus } from '../src/contracts/mission.js';
import {
  MISSION_COMMAND_CAPABILITY,
  MISSION_PLAN_NOT_DECIDED_SUMMARY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';

const FOUNDER = 'mission-founder';
/** Holds the mission grant but NOT approval authority — cannot verify. */
const PLANNER = 'mission-planner';

function missionFixture(): Fixture {
  const fx = setupFixture();
  registerMissionCommandCapability(fx.db);
  fx.principals.register({
    id: FOUNDER,
    displayName: 'Mission Founder',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, CAPS.readStatus],
    approvalAuthority: true,
    active: true,
  });
  fx.principals.register({
    id: PLANNER,
    displayName: 'Mission Planner',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  return fx;
}

function command(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return fx.ops.commandMission({
    title: 'Improve QOS website speed',
    objective: 'Reduce QOS page load times without changing the visual design',
    constraints: ['Do not change the visual design', 'Do not deploy production'],
    requestedBy: FOUNDER,
    ...overrides,
  });
}

function count(fx: Fixture, sql: string): number {
  return (fx.db.prepare(sql).get() as { n: number }).n;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts file under a directory, recursively (the core-boundary walker). */
function missionSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...missionSourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('commanding a mission (Founder-authenticated creation)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = missionFixture();
  });

  it('creates one canonical mission from a Founder order', () => {
    const { mission, deduplicated } = expectOk(
      command(fx, {
        scope: 'QOS public website only',
        acceptanceCriteria: ['Median page load under 2 seconds'],
        planItems: ['Measure current load times', 'Optimize the slowest pages'],
        priority: 'high',
        project: 'qos',
        instruction: 'Improve the QOS website speed without changing the visual design.',
      }),
    );
    expect(deduplicated).toBe(false);
    expect(mission.id).toMatch(/^mission-/);
    expect(mission.status).toBe('planned');
    expect(mission.title).toBe('Improve QOS website speed');
    expect(mission.objective).toBe('Reduce QOS page load times without changing the visual design');
    expect(mission.constraints).toEqual([
      'Do not change the visual design',
      'Do not deploy production',
    ]);
    expect(mission.acceptanceCriteria).toEqual(['Median page load under 2 seconds']);
    expect(mission.scope).toBe('QOS public website only');
    expect(mission.priority).toBe('high');
    expect(mission.project).toBe('qos');
    expect(mission.createdBy).toBe(FOUNDER);
    expect(mission.statusChangedBy).toBe(FOUNDER);
    expect(mission.verification).toBeNull();
    expect(mission.blockReason).toBeNull();
    expect(mission.planItems.map((p) => p.summary)).toEqual([
      'Measure current load times',
      'Optimize the slowest pages',
    ]);
    expect(mission.planItems.every((p) => p.kind === 'work' && p.state === 'waiting')).toBe(true);
    // The intent lock starts at seq 0 — the original order, carrying the
    // structured original state (M3: browser-inspectable) and never the raw
    // instruction text.
    expect(mission.intentHistory).toEqual([
      {
        seq: 0,
        kind: 'founder_order',
        actor: FOUNDER,
        at: expect.any(String),
        objective: 'Reduce QOS page load times without changing the visual design',
        constraints: ['Do not change the visual design', 'Do not deploy production'],
        acceptanceCriteria: ['Median page load under 2 seconds'],
      },
    ]);
  });

  it('derives the risk/approval truth server-side, never from the caller', () => {
    const { mission } = expectOk(command(fx));
    expect(mission.authority).toEqual({
      riskClass: 'founder_gate',
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
    });
  });

  it('records unstated fields as unknown rather than defaulting them', () => {
    const { mission } = expectOk(command(fx));
    expect(mission.acceptanceCriteria).toBeNull(); // not supplied ≠ empty
    expect(mission.priority).toBeNull(); // unstated ≠ normal
    expect(mission.scope).toBeNull();
  });

  it('generates the one honest plan item when no plan was supplied', () => {
    const { mission } = expectOk(command(fx));
    expect(mission.planItems).toHaveLength(1);
    expect(mission.planItems[0]!.kind).toBe('needs_clarification');
    expect(mission.planItems[0]!.state).toBe('needs_clarification');
    expect(mission.planItems[0]!.summary).toBe(MISSION_PLAN_NOT_DECIDED_SUMMARY);
  });

  it('never invents a task breakdown from the objective text', () => {
    const { mission } = expectOk(
      command(fx, {
        objective: 'First measure the site, then optimize images, then add caching layers',
      }),
    );
    // Imperative-looking prose stays prose: still exactly one clarification item.
    expect(mission.planItems).toHaveLength(1);
    expect(mission.planItems[0]!.kind).toBe('needs_clarification');
  });

  it('commanding a mission creates no task, no approval, and nothing claimable', () => {
    expectOk(command(fx, { planItems: ['Measure', 'Optimize'] }));
    expect(count(fx, 'SELECT COUNT(*) AS n FROM op_tasks')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_approvals')).toBe(0);
  });

  it('refuses everyone who is not an active principal holding the grant', () => {
    const cases: { requestedBy: string; code: string }[] = [
      { requestedBy: 'nobody-at-all', code: 'unknown_principal' },
      { requestedBy: 'claude', code: 'not_permitted' }, // registered worker
      { requestedBy: 'system', code: 'not_permitted' },
      { requestedBy: 'founder', code: 'not_permitted' }, // real principal, no mission grant
      { requestedBy: 'former-cto', code: 'unknown_principal' }, // inactive
    ];
    for (const { requestedBy, code } of cases) {
      const result = command(fx, { requestedBy });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_missions')).toBe(0);
  });

  it('fails closed while the capability is unregistered, and never registers it on the way', () => {
    const bare = setupFixture();
    bare.principals.register({
      id: FOUNDER,
      displayName: 'Mission Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const result = command(bare);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_capability');
      expect(result.error.message).toContain('separate, deliberate configuration action');
    }
    expect(
      bare.db.prepare(`SELECT 1 FROM op_capabilities WHERE id = ?`).get(MISSION_COMMAND_CAPABILITY.id),
    ).toBeUndefined();
  });

  it('fails closed on a weakened capability row, naming the drift', () => {
    new CapabilityRegistry(fx.db).register({
      id: MISSION_COMMAND_CAPABILITY.id,
      description: 'weakened',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const result = command(fx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_permitted');
      expect(result.error.message).toContain('riskClass');
    }
  });

  it('fails closed while the capability is disabled', () => {
    new CapabilityRegistry(fx.db).setEnabled(MISSION_COMMAND_CAPABILITY.id, false);
    const result = command(fx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('capability_disabled');
  });

  it('refuses a credential-looking order with nothing written', () => {
    // The facade backstop catches key/secret/password/token assignments; the
    // raw provider-token shapes (ghp_…, sk-…) are the browser boundary's
    // stricter scan, tested with the routes.
    const result = command(fx, {
      instruction: 'Use password: hunter2hunter2 for the deploy account',
    });
    expect(result.ok).toBe(false);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_missions')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents')).toBe(0);
  });

  it('refuses a dependsOn that names an unknown mission', () => {
    const result = command(fx, { dependsOn: ['mission-does-not-exist'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('mission-does-not-exist');
  });

  it('records dependencies between real missions', () => {
    const first = expectOk(command(fx, { title: 'First mission' }));
    const second = expectOk(
      command(fx, { title: 'Second mission', dependsOn: [first.mission.id] }),
    );
    expect(second.mission.dependsOn).toEqual([first.mission.id]);
  });

  it('an ungranted principal gets one identical refusal for a real and an imaginary id — no existence oracle', () => {
    // Authority gates run BEFORE the dependsOn / sourceOrderTaskId existence
    // probes (Opus second-pass finding on `cee771f`: commandMission was the
    // sole method probing first, so a Founder-mapped account without the
    // mission grant could distinguish real ids from imaginary ones).
    const { mission } = expectOk(command(fx));
    fx.principals.register({
      id: 'mission-staff',
      displayName: 'Ungranted Staff',
      originateCapabilities: [CAPS.readStatus],
      approvalAuthority: false,
      active: true,
    });
    const real = command(fx, { requestedBy: 'mission-staff', dependsOn: [mission.id] });
    const fake = command(fx, { requestedBy: 'mission-staff', dependsOn: ['mission-imaginary'] });
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    if (!real.ok && !fake.ok) {
      expect(real.error.code).toBe('not_permitted');
      expect(fake.error.code).toBe(real.error.code);
      expect(fake.error.message).toBe(real.error.message);
    }
    const realTask = command(fx, { requestedBy: 'mission-staff', sourceOrderTaskId: 'task-x' });
    expect(realTask.ok).toBe(false);
    if (!realTask.ok && !real.ok) expect(realTask.error.message).toBe(real.error.message);
  });

  it('an unrecognized status filter matches nothing rather than everything', () => {
    // Fail closed on a read: the old shape silently widened an invalid
    // filter to EVERY mission.
    expectOk(command(fx));
    expect(fx.ops.listMissions()).toHaveLength(1);
    expect(fx.ops.listMissions('planned')).toHaveLength(1);
    expect(fx.ops.listMissions('bogus-status' as MissionStatus)).toHaveLength(0);
  });
});

describe('idempotent duplicate commands', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = missionFixture();
  });

  it('dedupes an identical re-command onto the existing mission, writing nothing', () => {
    const first = expectOk(command(fx));
    const before = {
      missions: count(fx, 'SELECT COUNT(*) AS n FROM hq_missions'),
      intents: count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents'),
      events: count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_events'),
      evidence: count(fx, `SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'mission_commanded'`),
    };
    const second = expectOk(command(fx));
    expect(second.deduplicated).toBe(true);
    expect(second.mission.id).toBe(first.mission.id);
    expect({
      missions: count(fx, 'SELECT COUNT(*) AS n FROM hq_missions'),
      intents: count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents'),
      events: count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_events'),
      evidence: count(fx, `SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'mission_commanded'`),
    }).toEqual(before);
  });

  it('a different order is a different mission', () => {
    const first = expectOk(command(fx));
    const second = expectOk(command(fx, { title: 'A different title' }));
    expect(second.deduplicated).toBe(false);
    expect(second.mission.id).not.toBe(first.mission.id);
  });

  it('a supplied client key is an input to the derived key, never the key itself', () => {
    // Same client key on two DIFFERENT orders must not collide…
    const first = expectOk(command(fx, { idempotencyKey: 'client-key' }));
    const second = expectOk(
      command(fx, { title: 'Different order entirely', idempotencyKey: 'client-key' }),
    );
    expect(second.mission.id).not.toBe(first.mission.id);
    // …and the same order from a different principal is a different command.
    const third = expectOk(command(fx, { idempotencyKey: 'client-key', requestedBy: PLANNER }));
    expect(third.mission.id).not.toBe(first.mission.id);
  });

  it('two orders differing only in the raw instruction are two different missions', () => {
    // The digest binds the raw order text (Opus second-pass finding on
    // `cee771f`): before this, two commands identical in every structured
    // field collapsed onto one mission and the second order's text was
    // stored NOWHERE.
    const first = expectOk(command(fx, { instruction: 'Original wording of the order.' }));
    const second = expectOk(
      command(fx, { instruction: 'Different wording — a genuinely different order.' }),
    );
    expect(second.deduplicated).toBe(false);
    expect(second.mission.id).not.toBe(first.mission.id);
    // Both raw orders are preserved server-side; neither was discarded.
    expect(fx.ops.getMissionIntentHistory(first.mission.id)[0]!.body).toContain(
      'Original wording of the order.',
    );
    expect(fx.ops.getMissionIntentHistory(second.mission.id)[0]!.body).toContain(
      'Different wording — a genuinely different order.',
    );
  });

  it('a service without the privileged grant refuses before any mission row exists', () => {
    // Constructed around an externally supplied queue, the service holds no
    // evidence grant. The refusal must arrive BEFORE the transaction opens:
    // the old shape committed the mission first and threw after, leaving a
    // mission with no evidence row that a retry could never repair (dedupe
    // returns the existing mission and writes nothing).
    const external = new HeadquarterOperations(fx.db, { queue: fx.ops.queue });
    expect(() =>
      external.commandMission({
        title: 'Never recorded',
        objective: 'This must not produce a mission row',
        requestedBy: FOUNDER,
      }),
    ).toThrow(/externally supplied queue/);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_missions')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_events')).toBe(0);
  });
});

describe('the intent lock and append-only amendment history', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = missionFixture();
  });

  it('preserves the original order byte-identical under amendments', () => {
    const { mission } = expectOk(
      command(fx, { instruction: 'The original Founder order, verbatim.' }),
    );
    const original = fx.ops.getMissionIntentHistory(mission.id)[0]!;
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Narrow the objective to the landing page.',
        objective: 'Reduce QOS landing-page load time only',
        requestedBy: FOUNDER,
      }),
    );
    expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Add a constraint.',
        constraints: ['Do not change the visual design', 'No paid CDN services'],
        requestedBy: FOUNDER,
      }),
    );
    const history = fx.ops.getMissionIntentHistory(mission.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toEqual(original); // seq 0 untouched, byte for byte
    expect(history[0]!.body).toContain('The original Founder order, verbatim.');
    // The canonical record reflects the amendments…
    const after = fx.ops.getMission(mission.id)!;
    expect(after.objective).toBe('Reduce QOS landing-page load time only');
    expect(after.constraints).toContain('No paid CDN services');
    // …and the per-seq STRUCTURED history rides on the record (M3: the
    // Founder can audit the original next to every amendment), while the raw
    // body/rationale stays excluded by shape.
    expect(after.intentHistory.map((e) => e.seq)).toEqual([0, 1, 2]);
    for (const entry of after.intentHistory) {
      expect(Object.keys(entry).sort()).toEqual([
        'acceptanceCriteria',
        'actor',
        'at',
        'constraints',
        'kind',
        'objective',
        'seq',
      ]);
    }
    // Seq 0 carries the ORIGINAL structured state, unchanged by amendments.
    expect(after.intentHistory[0]!.objective).toBe(
      'Reduce QOS page load times without changing the visual design',
    );
    // The latest entry carries the current state the amendments produced.
    expect(after.intentHistory[2]!.objective).toBe('Reduce QOS landing-page load time only');
    expect(after.intentHistory[2]!.constraints).toContain('No paid CDN services');
  });

  it('amendments supersede plan items rather than deleting them', () => {
    const { mission } = expectOk(command(fx, { planItems: ['Old approach'] }));
    const amended = expectOk(
      fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'Replace the approach.',
        addPlanItems: ['New approach'],
        supersedePlanItemSeqs: [1],
        requestedBy: FOUNDER,
      }),
    );
    expect(amended.planItems).toHaveLength(2);
    const [old, fresh] = amended.planItems;
    expect(old!.state).toBe('superseded');
    expect(old!.supersededInIntentSeq).toBe(1);
    expect(fresh!.summary).toBe('New approach');
    expect(fresh!.createdInIntentSeq).toBe(1);
    // Superseding the same item twice is refused.
    const again = fx.ops.amendMissionIntent({
      missionId: mission.id,
      amendment: 'Try to supersede again.',
      supersedePlanItemSeqs: [1],
      requestedBy: FOUNDER,
    });
    expect(again.ok).toBe(false);
  });

  it('refuses to amend a terminal mission — closed history stays closed', () => {
    const { mission } = expectOk(command(fx));
    expectOk(
      fx.ops.transitionMission({
        missionId: mission.id,
        to: 'cancelled',
        note: 'Superseded by another direction.',
        requestedBy: FOUNDER,
      }),
    );
    const result = fx.ops.amendMissionIntent({
      missionId: mission.id,
      amendment: 'Too late.',
      requestedBy: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('mission_terminal');
  });

  it('refuses a credential-looking amendment with nothing written', () => {
    const { mission } = expectOk(command(fx));
    const before = count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents');
    const result = fx.ops.amendMissionIntent({
      missionId: mission.id,
      amendment: 'Set api_key = wJalrXUtnFEMIK7MDENG first, then rerun the build',
      requestedBy: FOUNDER,
    });
    expect(result.ok).toBe(false);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_mission_intents')).toBe(before);
    expect(fx.ops.getMission(mission.id)!.objective).toBe(
      'Reduce QOS page load times without changing the visual design',
    );
  });

  it('no source file anywhere contains an UPDATE or DELETE for the history tables', () => {
    // The previous guard scanned only mission-command.ts while every mission
    // UPDATE statement lives in service.ts (Opus second-pass finding on
    // `cee771f`) — it could not see the file where a history rewrite would
    // most naturally be written. Scan all of src/ instead. Tests are excluded
    // deliberately: the tamper test below must be free to ATTEMPT the
    // forbidden statements to prove the engine refuses them.
    for (const file of missionSourceFiles(join(packageRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [
        /UPDATE\s+hq_mission_intents/i,
        /DELETE\s+FROM\s+hq_mission_intents/i,
        /UPDATE\s+hq_mission_events/i,
        /DELETE\s+FROM\s+hq_mission_events/i,
      ]) {
        expect(source, `${file} must not rewrite mission history`).not.toMatch(pattern);
      }
    }
  });

  it('SQLite itself aborts a history rewrite, whoever attempts it', () => {
    // Append-only is enforced by schema triggers, not just by code review:
    // these statements go straight at the database, past every path the
    // module owns, and the ENGINE refuses them.
    const { mission } = expectOk(command(fx));
    expect(() =>
      fx.db
        .prepare(`UPDATE hq_mission_intents SET objective = 'forged' WHERE mission_id = ?`)
        .run(mission.id),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db.prepare(`DELETE FROM hq_mission_intents WHERE mission_id = ?`).run(mission.id),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(`UPDATE hq_mission_events SET actor = 'forged' WHERE mission_id = ?`)
        .run(mission.id),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db.prepare(`DELETE FROM hq_mission_events WHERE mission_id = ?`).run(mission.id),
    ).toThrow(/append-only/);
    // Refused means intact: the history is unchanged afterwards.
    const history = fx.ops.getMissionIntentHistory(mission.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.objective).toBe(
      'Reduce QOS page load times without changing the visual design',
    );
  });

  it('a raced amendment surfaces as a typed conflict with nothing written, never an opaque failure', () => {
    // The sequence reads now sit inside an IMMEDIATE transaction, so an
    // in-process race cannot occur; this injects the UNIQUE violation a
    // cross-process race would produce and locks two behaviors: the caller
    // receives the typed `mission_intent_conflict` refusal (409 at the
    // route), and the whole amendment rolled back.
    const { mission } = expectOk(command(fx));
    const realPrepare = fx.db.prepare.bind(fx.db);
    const dbPatched = fx.db as unknown as { prepare: (sql: string) => unknown };
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
      const result = fx.ops.amendMissionIntent({
        missionId: mission.id,
        amendment: 'This amendment loses the race.',
        objective: 'Never applied',
        requestedBy: FOUNDER,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('mission_intent_conflict');
    } finally {
      dbPatched.prepare = realPrepare;
    }
    // The losing amendment wrote nothing anywhere.
    expect(fx.ops.getMissionIntentHistory(mission.id)).toHaveLength(1);
    expect(fx.ops.getMission(mission.id)!.objective).toBe(
      'Reduce QOS page load times without changing the visual design',
    );
  });
});

describe('the mission lifecycle (8 states, Founder-driven)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = missionFixture();
  });

  function planned(): string {
    return expectOk(command(fx, { title: `Mission ${uniq()}` })).mission.id;
  }
  let n = 0;
  function uniq(): string {
    n += 1;
    return `${n}`;
  }

  it('walks the Founder-driven happy path, recording every step', () => {
    const id = planned();
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'ready_review', requestedBy: FOUNDER }));
    const verified = expectOk(
      fx.ops.transitionMission({
        missionId: id,
        to: 'verified',
        note: 'Reviewed the landing-page timings myself; they meet the target.',
        requestedBy: FOUNDER,
      }),
    );
    expect(verified.verification).toEqual({
      method: 'founder_decision',
      by: FOUNDER,
      at: expect.any(String),
      note: 'Reviewed the landing-page timings myself; they meet the target.',
    });
    const done = expectOk(
      fx.ops.transitionMission({ missionId: id, to: 'complete', requestedBy: FOUNDER }),
    );
    expect(done.status).toBe('complete');
    const events = fx.db
      .prepare(
        `SELECT from_status, to_status FROM hq_mission_events
         WHERE mission_id = ? AND kind = 'transitioned' ORDER BY seq`,
      )
      .all(id);
    expect(events).toEqual([
      { from_status: 'planned', to_status: 'working' },
      { from_status: 'working', to_status: 'ready_review' },
      { from_status: 'ready_review', to_status: 'verified' },
      { from_status: 'verified', to_status: 'complete' },
    ]);
  });

  it('refuses every transition the map does not allow, changing nothing', () => {
    const id = planned();
    for (const to of ['verified', 'complete', 'ready_review'] as const) {
      const result = fx.ops.transitionMission({ missionId: id, to, requestedBy: FOUNDER });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_mission_transition');
    }
    expect(fx.ops.getMission(id)!.status).toBe('planned');
    expect(
      count(fx, `SELECT COUNT(*) AS n FROM hq_mission_events WHERE kind = 'transitioned'`),
    ).toBe(0);
  });

  it('refuses a replayed transition rather than forging a second event', () => {
    const id = planned();
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
    const replay = fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('mission_status_changed');
    expect(
      count(fx, `SELECT COUNT(*) AS n FROM hq_mission_events WHERE kind = 'transitioned'`),
    ).toBe(1);
  });

  it('honours the optimistic guard when the mission moved underneath the caller', () => {
    const id = planned();
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
    const stale = fx.ops.transitionMission({
      missionId: id,
      to: 'cancelled',
      note: 'Decided from a stale view.',
      expectedStatus: 'planned',
      requestedBy: FOUNDER,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('mission_status_changed');
  });

  it('demands a recorded reason for blocked, failed, cancelled and verified', () => {
    for (const [from, to] of [
      ['planned', 'blocked'],
      ['working', 'failed'],
      ['planned', 'cancelled'],
    ] as const) {
      const id = planned();
      if (from === 'working') {
        expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
      }
      const result = fx.ops.transitionMission({ missionId: id, to, requestedBy: FOUNDER });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('requires a note');
    }
  });

  it('verification demands approval authority, not merely the mission grant', () => {
    const id = planned();
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: PLANNER }));
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'ready_review', requestedBy: PLANNER }));
    const refused = fx.ops.transitionMission({
      missionId: id,
      to: 'verified',
      note: 'Looks done to me.',
      requestedBy: PLANNER,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('not_permitted');
  });

  it('blocked carries its reason while blocked, and the history keeps it after', () => {
    const id = planned();
    expectOk(
      fx.ops.transitionMission({
        missionId: id,
        to: 'blocked',
        note: 'Waiting on the QOS hosting decision.',
        requestedBy: FOUNDER,
      }),
    );
    expect(fx.ops.getMission(id)!.blockReason).toBe('Waiting on the QOS hosting decision.');
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
    const after = fx.ops.getMission(id)!;
    expect(after.blockReason).toBeNull();
    expect(after.blockHistory).toEqual([
      { at: expect.any(String), actor: FOUNDER, note: 'Waiting on the QOS hosting decision.' },
    ]);
  });

  it('no transition ever touches the approval table', () => {
    const id = planned();
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER }));
    expectOk(fx.ops.transitionMission({ missionId: id, to: 'ready_review', requestedBy: FOUNDER }));
    expectOk(
      fx.ops.transitionMission({
        missionId: id,
        to: 'verified',
        note: 'Verified by my own review.',
        requestedBy: FOUNDER,
      }),
    );
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_approvals')).toBe(0);
  });

  it('unknown missions are refused as unknown, not invented', () => {
    const result = fx.ops.transitionMission({
      missionId: 'mission-never-existed',
      to: 'working',
      requestedBy: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_mission');
  });
});

describe('mission writes and the kill switch', () => {
  it('recording direction stays possible under an engaged kill switch — and still executes nothing', () => {
    // The switch stops execution from becoming reachable (claims, approvals).
    // Recording Founder direction — including "cancel this" — is exactly what
    // must remain possible during an emergency stop, the same way a direct
    // order may still be PLACED (it parks behind the gate it cannot pass).
    const fx = missionFixture();
    expectOk(fx.ops.engageKillSwitch('*', FOUNDER, 'containment drill'));
    const { mission } = expectOk(command(fx));
    expectOk(
      fx.ops.transitionMission({
        missionId: mission.id,
        to: 'cancelled',
        note: 'Cancelled during the containment drill.',
        requestedBy: FOUNDER,
      }),
    );
    expect(count(fx, 'SELECT COUNT(*) AS n FROM op_tasks')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_approvals')).toBe(0);
  });
});

describe('linking plan items to real operator tasks', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = missionFixture();
  });

  function missionWithPlan(): string {
    return expectOk(command(fx, { planItems: ['Measure current load times'] })).mission.id;
  }

  function realTask(): string {
    return expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { kind: 'measure' },
        requestedBy: FOUNDER,
      }),
    ).task.id;
  }

  it('links once, and the item then reads the task’s canonical state', () => {
    const missionId = missionWithPlan();
    const taskId = realTask();
    const linked = expectOk(
      fx.ops.linkMissionPlanItem({ missionId, planItemSeq: 1, taskId, requestedBy: FOUNDER }),
    );
    const item = linked.planItems[0]!;
    expect(item.taskId).toBe(taskId);
    expect(item.rawTaskStatus).toBe('queued');
    expect(item.state).toBe('waiting'); // derived from the task, in #254 words
    // Written once: a second link is refused.
    const again = fx.ops.linkMissionPlanItem({
      missionId,
      planItemSeq: 1,
      taskId: realTask(),
      requestedBy: FOUNDER,
    });
    expect(again.ok).toBe(false);
  });

  it('refuses to link a task that does not exist', () => {
    const missionId = missionWithPlan();
    const result = fx.ops.linkMissionPlanItem({
      missionId,
      planItemSeq: 1,
      taskId: 'task-never-existed',
      requestedBy: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_task');
  });

  it('refuses to link an open question — clarification is not work', () => {
    const missionId = expectOk(command(fx)).mission.id; // needs_clarification plan
    const result = fx.ops.linkMissionPlanItem({
      missionId,
      planItemSeq: 1,
      taskId: realTask(),
      requestedBy: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('open question');
  });
});

describe('what Phase 3 deliberately does NOT do', () => {
  it('the operator queue never reads mission priority — claiming stays strictly FIFO', () => {
    const source = readFileSync(new URL('../src/operator/queue.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/priority/i);
    expect(source).not.toMatch(/hq_missions/);
  });

  it('mission priority does not change the operator claiming order — proven behaviorally', () => {
    // The source grep above proves a word is absent from one file; this
    // proves the PROPERTY: a CRITICAL mission whose linked task was enqueued
    // second is claimed second. Priority is mission metadata, never queue
    // authority (Opus second-pass finding on `cee771f` asked for exactly
    // this behavioral form).
    const fx = missionFixture();
    const low = expectOk(
      command(fx, { title: 'Low mission', priority: 'low', planItems: ['First work'] }),
    ).mission;
    const critical = expectOk(
      command(fx, { title: 'Critical mission', priority: 'critical', planItems: ['Second work'] }),
    ).mission;

    const task = () =>
      expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.readStatus,
          payload: { kind: 'measure' },
          requestedBy: FOUNDER,
        }),
      ).task.id;
    const firstTask = task();
    // Distinct created_at (millisecond ISO text), so FIFO is unambiguous.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin for at most one millisecond */
    }
    const secondTask = task();
    expectOk(
      fx.ops.linkMissionPlanItem({
        missionId: low.id,
        planItemSeq: 1,
        taskId: firstTask,
        requestedBy: FOUNDER,
      }),
    );
    expectOk(
      fx.ops.linkMissionPlanItem({
        missionId: critical.id,
        planItemSeq: 1,
        taskId: secondTask,
        requestedBy: FOUNDER,
      }),
    );

    // The LOW mission's task went in first, so it comes out first — the
    // critical mission moves nothing ahead in the queue.
    expect(expectOk(fx.ops.claimNext('claude', CAPS.readStatus)).id).toBe(firstTask);
    expect(expectOk(fx.ops.claimNext('claude', CAPS.readStatus)).id).toBe(secondTask);
  });

  it('the mission module reaches no operator internals — it plans, it never executes', () => {
    const source = readFileSync(
      new URL('../src/application/mission-command.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from '\.\.\/operator\/queue\.js'/);
    expect(source).not.toMatch(/INSERT INTO op_tasks/i);
    expect(source).not.toMatch(/INSERT INTO hq_approvals/i);
  });
});
