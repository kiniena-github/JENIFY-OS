/**
 * Founder Command + Mission Core, against the real canonical machinery
 * (issue #254).
 *
 * The properties the issue asks to be proved, each with a test that fails
 * loudly if the seam regresses:
 *
 *   Founder creates a mission        every task is a canonical Founder-gated order
 *   refusal                          unknown / inactive / ungranted / worker ids
 *   idempotent duplicate             the same command returns the same mission
 *   atomicity                        a refused task rolls back the whole mission
 *   durability                       a reopened SQLite file holds the mission
 *   intent preserved                 the original order, verbatim, never mutated
 *   append-only amendments           a new row beside the old; the chain verifies
 *   transitions                      listed edges move, unlisted edges refuse
 *   zero means zero                  an unreadable order records zero tasks
 *   no raw writes                    the store touches only the mission tables
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { EXECUTION_PROVIDER_KEY } from '../src/operator/provider-binding.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import { BrowserSafetyError } from '../src/live/redaction.js';
import {
  amendMission,
  isRecordedMissionEdgeLegal,
  missionAttention,
  missionIdempotencyKey,
  missionListing,
  missionView,
  missionViews,
  MissionStore,
  submitFounderCommand,
  transitionMission,
  MAX_COMMAND_LENGTH,
  MAX_MISSIONS_LISTED,
  MAX_MISSION_REASON_LENGTH,
  NEEDS_CLARIFICATION_REASON,
  MAX_MISSION_TITLE_LENGTH,
  WITHHELD_MISSION_TITLE,
} from '../src/mission/index.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

interface Core {
  fixture: Fixture;
  missions: MissionStore;
}

function core(): Core {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return { fixture, missions: new MissionStore(fixture.db) };
}

const STEPPED = {
  command:
    'Ship the shift-report export.\nMust not change the ledger schema.\nDone when the export opens in Excel.\n' +
    '1. Add the export endpoint\n2. Add the download control\n3. Write the regression test',
  title: 'Shift export',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

const SINGLE = {
  command: 'Draft the Q3 maintenance plan for the Mesob line.',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

describe('a Founder command becomes a mission whose tasks are canonical Founder-gated orders', () => {
  it('records the mission as planned with one needs_approval task per step', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deduplicated).toBe(false);
    expect(result.data.needsClarification).toBe(false);
    expect(result.data.mission.state).toBe('planned');
    expect(result.data.mission.title).toBe('Shift export');
    expect(result.data.tasks).toHaveLength(3);
    for (const [index, receipt] of result.data.tasks.entries()) {
      const task = fixture.ops.queue.get(receipt.task.id)!;
      expect(task.status).toBe('needs_approval');
      expect(task.capabilityId).toBe(DIRECT_ORDER_CAPABILITY.id);
      expect(task.createdBy).toBe('founder');
      expect(task.payload[EXECUTION_PROVIDER_KEY]).toBe('CLAUDE');
      expect(receipt.classification.riskClass).toBe('founder_gate');
      // The published task title is the mission title plus a step marker.
      expect(fixture.ops.readMeta(task.id)?.title).toBe(`Shift export · step 0${index + 1}/03`);
      // The brief carries the step AND the constraints, so a worker reading
      // one task still sees what must not be violated.
      const instruction = task.payload.instruction as string;
      expect(instruction).toContain(`Step ${index + 1} of 3`);
      expect(instruction).toContain('Must not change the ledger schema.');
    }
    expect(missions.listTaskLinks(result.data.mission.id).map((link) => link.ordinal)).toEqual([1, 2, 3]);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(3);
    expect(fixture.ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('records a steps-free order as a mission with exactly one task', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(fixture.ops, missions, SINGLE, CLAUDE_ONLY);
    expect(result.ok && result.data.tasks.length).toBe(1);
    if (!result.ok) return;
    // No Founder text in the default title.
    expect(result.data.mission.title).toMatch(/^Founder mission [0-9a-f]{8}$/);
    expect(result.data.mission.title).not.toContain('Q3');
  });

  it('records the original intent verbatim, chained from genesis', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!result.ok) throw new Error(result.error.message);
    const [original] = missions.listIntent(result.data.mission.id);
    expect(original!.kind).toBe('original');
    expect(original!.command).toBe(STEPPED.command);
    expect(original!.objective).toBe('Ship the shift-report export.');
    expect(original!.constraints).toEqual(['Must not change the ledger schema.']);
    expect(original!.acceptanceCriteria).toEqual(['the export opens in Excel.']);
    expect(original!.stepCount).toBe(3);
    expect(original!.prevHash).toBe('0'.repeat(64));
    expect(missions.verifyIntentChain(result.data.mission.id)).toBe(true);
    expect(missions.listEvents(result.data.mission.id).map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'planned'],
    ]);
  });

  it('records an unreadable order as blocked for clarification with ZERO tasks', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(
      fixture.ops,
      missions,
      { command: 'Should we move the warehouse to Adama?', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.needsClarification).toBe(true);
    expect(result.data.tasks).toEqual([]);
    expect(result.data.mission.state).toBe('blocked');
    expect(result.data.mission.blockReason).toBe(`${NEEDS_CLARIFICATION_REASON}: question_not_order`);
    // Nothing invented: no canonical task exists at all.
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    const view = missionView(fixture.ops, missions, result.data.mission);
    expect(view.taskCount).toBe(0);
    expect(view.impliedState).toBeNull();
    expect(view.needsClarification).toBe(true);
    expect(view.intent.unknowns).toEqual([
      { code: 'question_not_order', blocking: true, description: expect.stringContaining('question') },
    ]);
  });

  it('derives the risk class from the registry row, never from the request', () => {
    // A request cannot say it is safe: there is no field for it. What it
    // gets is whatever hq.direct_order is registered as — and if that row
    // has been weakened, the mission is refused rather than recorded against
    // a weaker gate.
    const { fixture, missions } = core();
    new CapabilityRegistry(fixture.db).register({ ...DIRECT_ORDER_CAPABILITY, riskClass: 'reversible' });
    const result = submitFounderCommand(fixture.ops, missions, SINGLE, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('capability_definition_altered');
    expect(missions.countMissions()).toBe(0);
  });
});

describe('refusals fail closed, and write nothing', () => {
  const refused = (input: Parameters<typeof submitFounderCommand>[2], code: string, setup?: (c: Core) => void) => {
    const c = core();
    setup?.(c);
    const result = submitFounderCommand(c.fixture.ops, c.missions, input, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(c.missions.countMissions()).toBe(0);
    expect(c.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  };

  it('refuses an unregistered principal', () => refused({ ...SINGLE, requestedBy: 'nobody' }, 'unknown_principal'));
  it('refuses an inactive principal', () => refused({ ...SINGLE, requestedBy: 'former-cto' }, 'unknown_principal'));
  it('refuses a registered worker — worker identity never places a mission', () =>
    refused({ ...SINGLE, requestedBy: 'claude' }, 'not_permitted'));
  it('refuses a human without the direct-order grant', () => refused({ ...SINGLE, requestedBy: 'coo' }, 'not_permitted'));
  it('refuses system', () => refused({ ...SINGLE, requestedBy: 'system' }, 'invalid_input'));
  it('refuses an empty order', () => refused({ ...SINGLE, command: '   ' }, 'empty_command'));
  it('refuses an order longer than MAX_COMMAND_LENGTH — a document is not an order', () =>
    // Mutation-testing pass on `b3f72d1`: `command_too_long` had no test at
    // all. Built from short words so it is inside every OTHER bound and over
    // this one alone — by a clear margin, since the trim drops the trailing
    // space and a repeat count that lands exactly on the bound is accepted.
    refused({ ...SINGLE, command: 'Ship it. '.repeat(Math.ceil(MAX_COMMAND_LENGTH / 9) + 2) }, 'command_too_long'));
  it('refuses a too-long title', () =>
    refused({ ...SINGLE, title: 'x'.repeat(MAX_MISSION_TITLE_LENGTH + 1) }, 'title_too_long'));
  it('refuses a credential-shaped order before any write', () =>
    refused({ ...SINGLE, command: 'Use token ghp_abcdefghijklmnopqrstuvwxyz1234 to fix it.' }, 'unsafe_command'));
  it('refuses when the capability is not registered', () =>
    refused(SINGLE, 'capability_not_registered', (c) => {
      c.fixture.db.prepare(`DELETE FROM op_capabilities WHERE id = ?`).run(DIRECT_ORDER_CAPABILITY.id);
    }));
  it('refuses when the capability is disabled, and does not re-enable it', () =>
    refused(SINGLE, 'capability_disabled', (c) => {
      new CapabilityRegistry(c.fixture.db).setEnabled(DIRECT_ORDER_CAPABILITY.id, false);
    }));
  it('refuses an earned trust marker asserted by the caller', () =>
    refused({ ...SINGLE, actorAuthentication: 'authenticated_os_session' as never }, 'invalid_input'));

  it('refuses an unreadable order from an ungranted principal too — zero tasks is not a loophole', () => {
    // A clarification-needed mission creates no task, so createTask's own
    // grant check never runs. The command path checks the grant itself.
    refused({ command: 'Should we?', route: 'CLAUDE', requestedBy: 'coo' }, 'not_permitted');
  });
});

describe('a repeated command is the same mission', () => {
  it('deduplicates onto the existing mission and creates nothing', () => {
    const { fixture, missions } = core();
    const first = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    const second = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.mission.id).toBe(first.data.mission.id);
    expect(second.data.tasks.map((task) => task.task.id)).toEqual(first.data.tasks.map((task) => task.task.id));
    expect(second.data.tasks.every((task) => task.deduplicated)).toBe(true);
    expect(missions.countMissions()).toBe(1);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(3);
  });

  it('treats a different title, project, route or caller key as a different mission', () => {
    const base = { requestedBy: 'founder', route: 'CLAUDE' as const, actorAuthentication: 'unauthenticated' as const, command: 'x' };
    const key = missionIdempotencyKey(base);
    expect(missionIdempotencyKey({ ...base, title: 'A' })).not.toBe(key);
    expect(missionIdempotencyKey({ ...base, project: 'p' })).not.toBe(key);
    expect(missionIdempotencyKey({ ...base, route: 'CODEX' })).not.toBe(key);
    expect(missionIdempotencyKey({ ...base, idempotencyKey: 'again' })).not.toBe(key);
    expect(missionIdempotencyKey({ ...base, actorAuthentication: 'authenticated_os_session' })).not.toBe(key);
    // And a NUL cannot shift a field boundary.
    expect(missionIdempotencyKey({ ...base, project: 'p q', command: 'r' })).not.toBe(
      missionIdempotencyKey({ ...base, project: 'p', command: 'q r' }),
    );
  });

  it('treats a different COMMAND as a different mission — the one direction of dedupe that loses data', () => {
    // Mutation-testing pass on `b3f72d1`, P1.2. The test above varies every
    // key input except the command itself; replacing `input.command.trim()`
    // with `''` in `missionIdempotencyKey` broke nothing. The failure that
    // mutation stands for: two DIFFERENT Founder orders sharing a title,
    // project and route collapse onto the first — the second returns
    // `{ok: true, deduplicated: true}` carrying the FIRST mission's task ids,
    // and the second order is never recorded anywhere. Every other key input
    // going wrong makes a duplicate; this one makes a silent loss.
    const base = { requestedBy: 'founder', route: 'CLAUDE' as const, actorAuthentication: 'unauthenticated' as const, command: 'x' };
    expect(missionIdempotencyKey({ ...base, command: 'y' })).not.toBe(missionIdempotencyKey(base));
    expect(missionIdempotencyKey({ ...base, requestedBy: 'founder-2' })).not.toBe(missionIdempotencyKey(base));

    // End to end, through the real path: same title, project and route, the
    // order text alone differs. Two missions, two disjoint task sets, neither
    // deduplicated.
    const { fixture, missions } = core();
    const first = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    const second = submitFounderCommand(
      fixture.ops,
      missions,
      { ...STEPPED, command: 'Ship the shift-report IMPORT.\n1. Add the import endpoint\n2. Write the regression test' },
      CLAUDE_ONLY,
    );
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(second.data.deduplicated).toBe(false);
    expect(second.data.mission.id).not.toBe(first.data.mission.id);
    const firstIds = new Set(first.data.tasks.map((task) => task.task.id));
    expect(second.data.tasks).toHaveLength(2);
    expect(second.data.tasks.some((task) => firstIds.has(task.task.id))).toBe(false);
    expect(missions.countMissions()).toBe(2);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(5);
    // The second order's words are in ITS intent lock, not the first's.
    expect(missions.listIntent(second.data.mission.id)[0]!.command).toContain('IMPORT');
    expect(missions.listIntent(first.data.mission.id)[0]!.command).not.toContain('IMPORT');
  });

  it('records a second mission for every other key input too, end to end', () => {
    // The same property for each remaining input, through the real path
    // rather than the key function alone: a change in any one of them must
    // yield a second mission, not a dedupe onto the first.
    const { fixture, missions } = core();
    fixture.principals.register({
      id: 'founder-2',
      displayName: 'Second Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const first = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!first.ok) throw new Error(first.error.message);
    const variants: [string, Parameters<typeof submitFounderCommand>[2]][] = [
      ['title', { ...STEPPED, title: 'Shift export v2' }],
      ['project', { ...STEPPED, project: 'qos' }],
      ['route', { ...STEPPED, route: 'AUTO' }],
      ['requestedBy', { ...STEPPED, requestedBy: 'founder-2' }],
      ['idempotencyKey', { ...STEPPED, idempotencyKey: 'client-key-2' }],
    ];
    const seen = new Set([first.data.mission.id]);
    for (const [label, input] of variants) {
      const result = submitFounderCommand(fixture.ops, missions, input, CLAUDE_ONLY);
      expect(result.ok, label).toBe(true);
      if (!result.ok) continue;
      expect(result.data.deduplicated, label).toBe(false);
      expect(seen.has(result.data.mission.id), label).toBe(false);
      seen.add(result.data.mission.id);
    }
    expect(missions.countMissions()).toBe(1 + variants.length);
    // And the unchanged order still dedupes, so the property is not "always new".
    const again = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(again.ok && again.data.deduplicated).toBe(true);
    expect(missions.countMissions()).toBe(1 + variants.length);
  });
});

describe('a mission and its tasks commit together or not at all', () => {
  it('rolls back the mission when a later task is refused', () => {
    const { fixture, missions } = core();
    // Refuse the second createTask only: the first task is already written
    // when the refusal happens, so a non-atomic creation would leave a
    // mission with one task and an orphan.
    const original = fixture.ops.createTask.bind(fixture.ops);
    let calls = 0;
    fixture.ops.createTask = (input) => {
      calls += 1;
      if (calls === 2) return { ok: false, error: { code: 'kill_switch_engaged', message: 'simulated' } };
      return original(input);
    };
    const result = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('kill_switch_engaged');
    expect(missions.countMissions()).toBe(0);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_mission_intent`).get()).toEqual({ n: 0 });
    expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM hq_mission_tasks`).get()).toEqual({ n: 0 });
  });
});

describe('a mission survives a restart', () => {
  it('is read back from a reopened SQLite file with its intent, links and history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-mission-'));
    const path = join(dir, 'hq.sqlite');
    let missionId: string;
    let taskIds: string[];
    try {
      {
        const db = openHqDatabase(path);
        const ops = new HeadquarterOperations(db);
        registerDirectOrderCapability(db);
        db.prepare(
          `INSERT INTO hq_human_principals (id, display_name, originate_capabilities, approval_authority, active)
           VALUES ('founder', 'Founder', ?, 1, 1)`,
        ).run(JSON.stringify([DIRECT_ORDER_CAPABILITY.id]));
        const missions = new MissionStore(db);
        const result = submitFounderCommand(ops, missions, STEPPED, CLAUDE_ONLY);
        if (!result.ok) throw new Error(result.error.message);
        missionId = result.data.mission.id;
        taskIds = result.data.tasks.map((task) => task.task.id);
        db.close();
      }
      {
        const db = openHqDatabase(path);
        const ops = new HeadquarterOperations(db);
        const missions = new MissionStore(db);
        const mission = missions.getMission(missionId)!;
        expect(mission.state).toBe('planned');
        expect(mission.title).toBe('Shift export');
        expect(missions.listTaskLinks(missionId).map((link) => link.taskId)).toEqual(taskIds);
        expect(missions.listIntent(missionId)[0]!.command).toBe(STEPPED.command);
        expect(missions.verifyIntentChain(missionId)).toBe(true);
        const view = missionView(ops, missions, mission);
        expect(view.taskCount).toBe(3);
        expect(view.tasks.every((task) => task.presentation === 'needs_approval')).toBe(true);
        expect(view.impliedState).toBe('planned');
        expect(view.driftFromTasks).toBe(false);
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a database file that predates the anchor columns, and reads its missions as unanchored — not as failures', () => {
    // Mutation-testing pass on `b3f72d1`, P1.3, the migration half. A file
    // written before `intent_head_hash` / `intent_count` existed gets both
    // columns from `COLUMN_UPGRADES` on the next open, NULL for every
    // existing row. The store must read NULL as "recorded before anchoring"
    // and report intact-but-unanchored, never `head_mismatch` against an
    // anchor that was never written. The pre-upgrade file is made by
    // dropping the two columns from a fresh one.
    const dir = mkdtempSync(join(tmpdir(), 'hq-mission-upgrade-'));
    const path = join(dir, 'hq.sqlite');
    try {
      let missionId: string;
      {
        const db = openHqDatabase(path);
        const ops = new HeadquarterOperations(db);
        registerDirectOrderCapability(db);
        db.prepare(
          `INSERT INTO hq_human_principals (id, display_name, originate_capabilities, approval_authority, active)
           VALUES ('founder', 'Founder', ?, 1, 1)`,
        ).run(JSON.stringify([DIRECT_ORDER_CAPABILITY.id]));
        const result = submitFounderCommand(ops, new MissionStore(db), STEPPED, CLAUDE_ONLY);
        if (!result.ok) throw new Error(result.error.message);
        missionId = result.data.mission.id;
        db.exec(`ALTER TABLE hq_missions DROP COLUMN intent_head_hash`);
        db.exec(`ALTER TABLE hq_missions DROP COLUMN intent_count`);
        expect((db.prepare(`PRAGMA table_info(hq_missions)`).all() as { name: string }[]).map((c) => c.name)).not.toContain('intent_count');
        db.close();
      }
      {
        const db = openHqDatabase(path);
        const columns = (db.prepare(`PRAGMA table_info(hq_missions)`).all() as { name: string }[]).map((c) => c.name);
        expect(columns).toContain('intent_head_hash');
        expect(columns).toContain('intent_count');
        const missions = new MissionStore(db);
        expect(missions.getMission(missionId)).toMatchObject({ intentHeadHash: null, intentCount: null });
        expect(missions.intentChainVerdict(missionId)).toEqual({ intact: true, anchored: false, reason: null });
        const view = missionView(new HeadquarterOperations(db), missions, missions.getMission(missionId)!);
        expect(view.intent).toMatchObject({ revisions: 1, chainIntact: true, chainAnchored: false });
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('amendments append; the original is never mutated', () => {
  it('adds a chained revision with actor, timestamp and reason, leaving row one byte-for-byte', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const before = missions.listIntent(created.data.mission.id)[0]!;
    const amended = amendMission(
      fixture.ops,
      missions,
      {
        missionId: created.data.mission.id,
        command: `${STEPPED.command}\nMust not run during the day shift.`,
        reason: 'Operations asked for a night-only window.',
        actor: 'founder',
      },
      CLAUDE_ONLY,
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    const rows = missions.listIntent(created.data.mission.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    expect(rows[1]!.kind).toBe('amendment');
    expect(rows[1]!.reason).toBe('Operations asked for a night-only window.');
    expect(rows[1]!.actor).toBe('founder');
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[1]!.constraints).toContain('Must not run during the day shift.');
    expect(missions.verifyIntentChain(created.data.mission.id)).toBe(true);
    // Existing tasks are NOT rewritten: their briefs sit inside approved digests.
    expect(amended.data.planCreated).toBe(false);
    expect(amended.data.tasks).toEqual([]);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(3);
    expect(fixture.ops.queue.get(created.data.tasks[0]!.task.id)!.payload.instruction).not.toContain('night-only');
  });

  it('gives a clarification-blocked mission its first plan and moves it blocked → planned', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(
      fixture.ops,
      missions,
      { command: 'Should we ship the export?', route: 'CLAUDE', requestedBy: 'founder', title: 'Export' },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error(created.error.message);
    expect(created.data.mission.state).toBe('blocked');
    const amended = amendMission(
      fixture.ops,
      missions,
      {
        missionId: created.data.mission.id,
        command: 'Ship the export.\n1. Add the endpoint\n2. Add the test',
        reason: 'Decided: yes.',
        actor: 'founder',
      },
      CLAUDE_ONLY,
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.data.planCreated).toBe(true);
    expect(amended.data.tasks).toHaveLength(2);
    expect(amended.data.mission.state).toBe('planned');
    expect(amended.data.mission.blockReason).toBeNull();
    expect(missions.listEvents(created.data.mission.id).map((event) => event.toState)).toEqual(['blocked', 'planned']);
    expect(missions.listTaskLinks(created.data.mission.id).every((link) => link.intentId === amended.data.intent.id)).toBe(true);
  });

  it('detects a tampered historical row', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    amendMission(
      fixture.ops,
      missions,
      { missionId: created.data.mission.id, command: `${STEPPED.command}\nMust be done by Friday.`, reason: 'deadline', actor: 'founder' },
      CLAUDE_ONLY,
    );
    expect(missions.verifyIntentChain(created.data.mission.id)).toBe(true);
    // Something with raw database access edits the original in place.
    fixture.db
      .prepare(`UPDATE hq_mission_intent SET command = ? WHERE mission_id = ? AND kind = 'original'`)
      .run('Ship something else entirely.', created.data.mission.id);
    expect(missions.verifyIntentChain(created.data.mission.id)).toBe(false);
    expect(missionView(fixture.ops, missions, missions.getMission(created.data.mission.id)!).intent.chainIntact).toBe(false);
  });

  it('detects a truncated TAIL: the newest amendment deleted, the head anchor disagrees', () => {
    // Mutation-testing pass on `b3f72d1`, P1.3. Proven before the fix: after
    // `DELETE FROM hq_mission_intent WHERE mission_id=? AND kind='amendment'`,
    // `verifyIntentChain` returned TRUE and the view reported
    // `chainIntact: true, revisions: 1` — a forward walk from genesis has no
    // anchored head, so dropping the newest row(s) was invisible, and anyone
    // with raw database access could erase the latest Founder amendment and
    // leave a pristine-looking mission. The head hash and the row count are
    // now anchored on the mission row by `appendIntent`; this is the
    // reviewer's exact scenario, and it must report NOT intact.
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    amendMission(fixture.ops, missions, { missionId: id, command: `${STEPPED.command}\nMust be done by Friday.`, reason: 'deadline', actor: 'founder' }, CLAUDE_ONLY);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: true, anchored: true, reason: null });
    expect(missions.getMission(id)!.intentCount).toBe(2);
    expect(missions.getMission(id)!.intentHeadHash).toBe(missions.listIntent(id)[1]!.hash);

    fixture.db.prepare(`DELETE FROM hq_mission_intent WHERE mission_id = ? AND kind = 'amendment'`).run(id);
    expect(missions.listIntent(id)).toHaveLength(1);
    expect(missions.verifyIntentChain(id)).toBe(false);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: false, anchored: true, reason: 'head_mismatch' });
    const view = missionView(fixture.ops, missions, missions.getMission(id)!);
    expect(view.intent.chainIntact).toBe(false);
    expect(view.intent.chainAnchored).toBe(true);
    expect(view.intent.revisions).toBe(1);
  });

  it('detects a deleted MIDDLE row, and reports an untampered chain as intact and anchored', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    for (const extra of ['Must be done by Friday.', 'Must not touch the ledger.']) {
      const amended = amendMission(fixture.ops, missions, { missionId: id, command: `${STEPPED.command}\n${extra}`, reason: extra, actor: 'founder' }, CLAUDE_ONLY);
      expect(amended.ok).toBe(true);
    }
    // Untampered: three rows, the anchor names the third.
    expect(missions.listIntent(id)).toHaveLength(3);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: true, anchored: true, reason: null });
    expect(missionView(fixture.ops, missions, missions.getMission(id)!).intent).toMatchObject({
      revisions: 3,
      chainIntact: true,
      chainAnchored: true,
    });
    // Delete the middle row: the third row's prev_hash names a hash no
    // remaining row carries. Caught by the forward walk, before the anchor.
    const middle = missions.listIntent(id)[1]!;
    fixture.db.prepare(`DELETE FROM hq_mission_intent WHERE id = ?`).run(middle.id);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: false, anchored: true, reason: 'link_broken' });
    expect(missions.verifyIntentChain(id)).toBe(false);
  });

  it('names an edited row as rehashed, and counts a count mismatch separately', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    fixture.db.prepare(`UPDATE hq_mission_intent SET objective = 'Something else.' WHERE mission_id = ?`).run(id);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: false, anchored: true, reason: 'row_rehashed' });
    // Restore the row's content exactly and corrupt only the anchor's count.
    fixture.db.prepare(`UPDATE hq_mission_intent SET objective = ? WHERE mission_id = ?`).run('Ship the shift-report export.', id);
    expect(missions.intentChainVerdict(id).intact).toBe(true);
    fixture.db.prepare(`UPDATE hq_missions SET intent_count = 2 WHERE id = ?`).run(id);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: false, anchored: true, reason: 'count_mismatch' });
    expect(missions.intentChainVerdict('no-such-mission')).toEqual({ intact: false, anchored: false, reason: 'unknown_mission' });
  });

  it('degrades honestly for a mission recorded before the anchor existed: intact but UNANCHORED, until the next append', () => {
    // A database upgraded in place holds NULL in both anchor columns for
    // every existing mission. That is not a tamper report — the forward walk
    // still runs and still passes — but it is not the full check either, and
    // the verdict must say so rather than round it to "intact". No backfill:
    // anchoring whatever rows happen to be present at upgrade time would
    // bless a truncation that may already have happened. The next append
    // writes a real anchor.
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    fixture.db.prepare(`UPDATE hq_missions SET intent_head_hash = NULL, intent_count = NULL WHERE id = ?`).run(id);
    expect(missions.getMission(id)).toMatchObject({ intentHeadHash: null, intentCount: null });
    expect(missions.verifyIntentChain(id)).toBe(true);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: true, anchored: false, reason: null });
    const before = missionView(fixture.ops, missions, missions.getMission(id)!);
    expect(before.intent.chainIntact).toBe(true);
    expect(before.intent.chainAnchored).toBe(false);
    // A forward-walk failure is still a failure for an unanchored chain.
    fixture.db.prepare(`UPDATE hq_mission_intent SET objective = 'edited' WHERE mission_id = ?`).run(id);
    expect(missions.intentChainVerdict(id)).toEqual({ intact: false, anchored: false, reason: 'row_rehashed' });
    fixture.db.prepare(`UPDATE hq_mission_intent SET objective = ? WHERE mission_id = ?`).run('Ship the shift-report export.', id);
    // The next append anchors it: count from the table, not NULL + 1.
    const amended = amendMission(fixture.ops, missions, { missionId: id, command: `${STEPPED.command}\nMust be done by Friday.`, reason: 'deadline', actor: 'founder' }, CLAUDE_ONLY);
    expect(amended.ok).toBe(true);
    expect(missions.getMission(id)).toMatchObject({ intentCount: 2, intentHeadHash: missions.listIntent(id)[1]!.hash });
    expect(missions.intentChainVerdict(id)).toEqual({ intact: true, anchored: true, reason: null });
    expect(missionView(fixture.ops, missions, missions.getMission(id)!).intent.chainAnchored).toBe(true);
  });

  it('reports the whole fallback, unanchored, for a mission with no intent row at all', () => {
    // The `intents.length === 0` branch of the view, asserted field by field
    // rather than by `chainIntact` alone (mutation-testing pass on `b3f72d1`).
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    fixture.db.prepare(`DELETE FROM hq_mission_intent WHERE mission_id = ?`).run(created.data.mission.id);
    const mission = missions.getMission(created.data.mission.id)!;
    expect(missionView(fixture.ops, missions, mission).intent).toEqual({
      revisions: 0,
      latestKind: 'original',
      latestAt: mission.createdAt,
      latestActor: 'founder',
      latestActorAuthentication: mission.actorAuthentication,
      latestReason: null,
      constraintCount: 0,
      acceptanceCriteriaCount: 0,
      stepCount: 0,
      needsClarification: false,
      unknowns: [],
      chainIntact: false,
      chainAnchored: false,
    });
    // The store agrees: zero rows against an anchor that says one.
    expect(missions.intentChainVerdict(mission.id)).toEqual({ intact: false, anchored: true, reason: 'head_mismatch' });
  });

  it('refuses an amendment without a reason, on a terminal mission, or from an ungranted actor', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    const noReason = amendMission(fixture.ops, missions, { missionId: id, command: 'x y z', reason: '', actor: 'founder' }, CLAUDE_ONLY);
    expect(!noReason.ok && noReason.error.code).toBe('reason_required');
    const ungranted = amendMission(fixture.ops, missions, { missionId: id, command: 'x y z', reason: 'r', actor: 'coo' }, CLAUDE_ONLY);
    expect(!ungranted.ok && ungranted.error.code).toBe('not_permitted');
    transitionMission(fixture.ops, missions, { missionId: id, to: 'cancelled', actor: 'founder', reason: 'dropped' });
    const terminal = amendMission(fixture.ops, missions, { missionId: id, command: 'x y z', reason: 'r', actor: 'founder' }, CLAUDE_ONLY);
    expect(!terminal.ok && terminal.error.code).toBe('mission_terminal');
    expect(missions.listIntent(id)).toHaveLength(1);
  });
});

describe('recorded transitions follow the table, and only a decision-maker records one', () => {
  function planned(): Core & { id: string } {
    const c = core();
    const created = submitFounderCommand(c.fixture.ops, c.missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    return { ...c, id: created.data.mission.id };
  }

  it('moves along listed edges and records each with actor and reason', () => {
    const { fixture, missions, id } = planned();
    for (const [to, reason] of [
      ['working', undefined],
      ['ready_review', undefined],
      ['verified', 'Checked the export by hand.'],
      ['complete', undefined],
    ] as const) {
      const result = transitionMission(fixture.ops, missions, { missionId: id, to, actor: 'founder', reason });
      expect(result.ok, to).toBe(true);
    }
    expect(missions.getMission(id)!.state).toBe('complete');
    const history = missions.listEvents(id);
    expect(history.map((event) => event.toState)).toEqual(['planned', 'working', 'ready_review', 'verified', 'complete']);
    expect(history[3]!.reason).toBe('Checked the export by hand.');
    expect(history.every((event) => event.actor === 'founder')).toBe(true);
  });

  it('refuses an unlisted edge and leaves the state untouched', () => {
    const { fixture, missions, id } = planned();
    const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'complete', actor: 'founder' });
    expect(!result.ok && result.error.code).toBe('illegal_mission_transition');
    expect(missions.getMission(id)!.state).toBe('planned');
    expect(missions.listEvents(id)).toHaveLength(1);
  });

  it('refuses to leave a terminal state', () => {
    const { fixture, missions, id } = planned();
    transitionMission(fixture.ops, missions, { missionId: id, to: 'cancelled', actor: 'founder', reason: 'dropped' });
    const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'planned', actor: 'founder' });
    expect(!result.ok && result.error.code).toBe('illegal_mission_transition');
    expect(!result.ok && result.error.message).toContain('terminal');
  });

  it('demands a reason for a stop, and refuses the reserved clarification prefix', () => {
    const { fixture, missions, id } = planned();
    const silent = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder' });
    expect(!silent.ok && silent.error.code).toBe('reason_required');
    const reserved = transitionMission(fixture.ops, missions, {
      missionId: id,
      to: 'blocked',
      actor: 'founder',
      reason: `${NEEDS_CLARIFICATION_REASON}: forged`,
    });
    expect(!reserved.ok && reserved.error.code).toBe('invalid_input');
    const stated = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder', reason: 'Waiting on the auditor.' });
    expect(stated.ok).toBe(true);
    expect(missions.getMission(id)!.blockReason).toBe('Waiting on the auditor.');
  });

  it('REFUSES a credential-shaped reason with unsafe_reason, and an over-long one with reason_too_long, writing nothing', () => {
    // Mutation-testing pass on `b3f72d1`, P1.4(a). Both error codes existed
    // with zero coverage: removing the credential scan from `checkReason`
    // broke no test, because the leak tests only asserted that PLANTED
    // strings were absent from a serialized body — which is true whether or
    // not the scanner ever runs. These tests exercise the guard itself: the
    // refusal code is asserted, and so is the absence of any write.
    const { fixture, missions, id } = planned();
    const TOKEN_REASON = 'Waiting on token ghp_abcdefghijklmnopqrstuvwxyz1234 from the auditor.';
    const LONG_REASON = 'r'.repeat(MAX_MISSION_REASON_LENGTH + 1);

    const unsafeStop = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder', reason: TOKEN_REASON });
    expect(!unsafeStop.ok && unsafeStop.error.code).toBe('unsafe_reason');
    // An optional reason on an advancing edge is scanned too.
    const unsafeAdvance = transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor: 'founder', reason: TOKEN_REASON });
    expect(!unsafeAdvance.ok && unsafeAdvance.error.code).toBe('unsafe_reason');
    const tooLong = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder', reason: LONG_REASON });
    expect(!tooLong.ok && tooLong.error.code).toBe('reason_too_long');
    expect(!tooLong.ok && tooLong.error.details).toEqual({ length: MAX_MISSION_REASON_LENGTH + 1 });
    expect(missions.getMission(id)!.state).toBe('planned');
    expect(missions.getMission(id)!.blockReason).toBeNull();
    expect(missions.listEvents(id)).toHaveLength(1);

    // The amendment reason goes through the same guard.
    const unsafeAmend = amendMission(fixture.ops, missions, { missionId: id, command: `${STEPPED.command}\nMust finish by Friday.`, reason: TOKEN_REASON, actor: 'founder' }, CLAUDE_ONLY);
    expect(!unsafeAmend.ok && unsafeAmend.error.code).toBe('unsafe_reason');
    const longAmend = amendMission(fixture.ops, missions, { missionId: id, command: `${STEPPED.command}\nMust finish by Friday.`, reason: LONG_REASON, actor: 'founder' }, CLAUDE_ONLY);
    expect(!longAmend.ok && longAmend.error.code).toBe('reason_too_long');
    expect(missions.listIntent(id)).toHaveLength(1);
    // Nothing credential-shaped reached any published surface.
    expect(JSON.stringify(missionViews(fixture.ops, missions))).not.toContain('ghp_');
    // A reason of exactly the bound is accepted, so the bound is the bound.
    const atBound = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder', reason: 'r'.repeat(MAX_MISSION_REASON_LENGTH) });
    expect(atBound.ok).toBe(true);
  });

  it('refuses a principal without approval authority, a worker, and an unknown id', () => {
    const { fixture, missions, id } = planned();
    for (const [actor, code] of [
      ['analyst', 'not_permitted'],
      ['claude', 'not_permitted'],
      ['ghost', 'unknown_principal'],
      ['system', 'invalid_input'],
    ] as const) {
      const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor });
      expect(!result.ok && result.error.code, actor).toBe(code);
    }
    expect(missions.getMission(id)!.state).toBe('planned');
  });

  it('refuses to record a plan-claiming state for a mission with no task', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(
      fixture.ops,
      missions,
      { command: 'Should we?', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error(created.error.message);
    const result = transitionMission(fixture.ops, missions, { missionId: created.data.mission.id, to: 'planned', actor: 'founder' });
    expect(!result.ok && result.error.code).toBe('mission_has_no_plan');
    // Cancelling it is fine: that claims nothing about a plan.
    const cancel = transitionMission(fixture.ops, missions, { missionId: created.data.mission.id, to: 'cancelled', actor: 'founder', reason: 'never mind' });
    expect(cancel.ok).toBe(true);
  });
});

describe('the kill switch halts mission transitions that record work moving or done', () => {
  /**
   * Opus second pass on `a849af8`. `transitionMission` checked the mission,
   * the target, the actor, the table and the reason — and never the kill
   * switch. With `engageKillSwitch('*')` in force, a mission could be walked
   * `planned → working → ready_review → verified → complete` and the Mission
   * Room would have shown a mission completing while HQ was halted.
   *
   * The switch is read the way `approveTask` and the claim path read it:
   * `ops.queue.killSwitchEngaged(capabilityId)`, against `hq.direct_order`,
   * because every mission task is created under that capability. Which edges
   * it gates follows the facade's own precedent — under the switch
   * `approveTask` refuses and `denyTask` does not — so the four targets that
   * assert work is running or accepted are refused and a stop stays
   * recordable. Both halves are asserted, engaged and released.
   */
  function planned(): Core & { id: string } {
    const c = core();
    const created = submitFounderCommand(c.fixture.ops, c.missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    return { ...c, id: created.data.mission.id };
  }

  it('refuses every advancing target while the global switch is engaged, and writes nothing', () => {
    const { fixture, missions, id } = planned();
    const engaged = fixture.ops.engageKillSwitch('*', 'founder', 'incident: halt everything');
    expect(engaged.ok).toBe(true);
    const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor: 'founder' });
    expect(!result.ok && result.error.code).toBe('kill_switch_engaged');
    expect(!result.ok && result.error.message).toContain('halted');
    expect(!result.ok && result.error.message).toContain(DIRECT_ORDER_CAPABILITY.id);
    expect(missions.getMission(id)!.state).toBe('planned');
    expect(missions.listEvents(id)).toHaveLength(1);
    // The other three advancing targets are refused on the same ground, not
    // merely because the table lacks the edge: the switch is consulted
    // BEFORE the table, so the code names the real cause.
    for (const to of ['ready_review', 'verified', 'complete'] as const) {
      const refused = transitionMission(fixture.ops, missions, { missionId: id, to, actor: 'founder' });
      expect(!refused.ok && refused.error.code, to).toBe('kill_switch_engaged');
    }
  });

  it('refuses under a switch scoped to the direct-order capability alone', () => {
    const { fixture, missions, id } = planned();
    expect(fixture.ops.engageKillSwitch(DIRECT_ORDER_CAPABILITY.id, 'founder', 'orders paused').ok).toBe(true);
    const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor: 'founder' });
    expect(!result.ok && result.error.code).toBe('kill_switch_engaged');
    expect(missions.getMission(id)!.state).toBe('planned');
  });

  it('still records a stop while engaged — a halt is not a reason to refuse a Founder’s stop', () => {
    const { fixture, missions, id } = planned();
    expect(fixture.ops.engageKillSwitch('*', 'founder', 'incident').ok).toBe(true);
    const stopped = transitionMission(fixture.ops, missions, { missionId: id, to: 'blocked', actor: 'founder', reason: 'Halted during the incident.' });
    expect(stopped.ok).toBe(true);
    expect(missions.getMission(id)!.state).toBe('blocked');
    const cancelled = transitionMission(fixture.ops, missions, { missionId: id, to: 'cancelled', actor: 'founder', reason: 'Dropped.' });
    expect(cancelled.ok).toBe(true);
    expect(missions.getMission(id)!.state).toBe('cancelled');
  });

  it('records the same advancing transition once the switch is released', () => {
    const { fixture, missions, id } = planned();
    expect(fixture.ops.engageKillSwitch('*', 'founder', 'incident').ok).toBe(true);
    expect(transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor: 'founder' }).ok).toBe(false);
    expect(fixture.ops.releaseKillSwitch('*', 'founder').ok).toBe(true);
    const result = transitionMission(fixture.ops, missions, { missionId: id, to: 'working', actor: 'founder' });
    expect(result.ok).toBe(true);
    expect(missions.getMission(id)!.state).toBe('working');
    expect(missions.listEvents(id).map((event) => event.toState)).toEqual(['planned', 'working']);
  });
});

describe('one poisoned row is withheld; the rest of the list still answers (mutation-testing pass on b3f72d1, P1.4b)', () => {
  /**
   * Measured before the fix: a credential-shaped `block_reason` written by
   * any path bypassing `checkReason` (raw database access here) made
   * `missionListing` throw on its whole-list scan, and the route turned that
   * into a 500 for `GET /control/missions` — one poisoned reason bricked
   * every mission read. Each view is now proven safe on its own and a failing
   * one is replaced by a withheld substitute that carries the id, the recorded
   * state, and the PATH of the offending field — never its value.
   */
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz1234';

  it('replaces the poisoned mission with a withheld view and leaves its neighbour intact', () => {
    const { fixture, missions } = core();
    const clean = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    const poisoned = submitFounderCommand(fixture.ops, missions, { ...SINGLE, title: 'Poisoned' }, CLAUDE_ONLY);
    if (!clean.ok || !poisoned.ok) throw new Error('expected ok');
    // Written past the write-time scan, the way only raw access can.
    fixture.db
      .prepare(`UPDATE hq_missions SET state = 'blocked', block_reason = ? WHERE id = ?`)
      .run(`Waiting on token ${TOKEN} from the auditor.`, poisoned.data.mission.id);

    const listing = missionListing(fixture.ops, missions, { env: CLAUDE_ONLY });
    expect(listing.missions).toHaveLength(2);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('ghp_');

    const withheld = listing.missions.find((view) => view.missionId === poisoned.data.mission.id)!;
    expect(withheld.withheld).toEqual({ path: `missions.${poisoned.data.mission.id}.blockReason` });
    expect(withheld.title).toBe(WITHHELD_MISSION_TITLE);
    expect(withheld.title).not.toBe('Poisoned');
    expect(withheld.state).toBe('blocked');
    expect(withheld.blockReason).toBeNull();
    expect(withheld.tasks).toEqual([]);
    expect(withheld.taskCount).toBe(0);
    expect(withheld.intent.chainIntact).toBe(false);
    expect(withheld.requestedBy).toBe('withheld');

    const intact = listing.missions.find((view) => view.missionId === clean.data.mission.id)!;
    expect(intact.withheld).toBeNull();
    expect(intact.title).toBe('Shift export');
    expect(intact.taskCount).toBe(3);
    expect(intact.intent.chainIntact).toBe(true);
    // The store-wide facts are unaffected: the poisoned row is still a
    // blocked mission, counted from the column.
    expect(listing.byState.blocked).toBe(1);
    expect(missionAttention(listing.missions, listing).blocked).toBe(1);
  });

  it('still fails closed when the substitute itself cannot be made safe — an identifier that is credential-shaped', () => {
    // The whole-list scan stays as the last line. A withheld view is built
    // from constants plus the id; if the ID is the poisoned field there is
    // no safe substitute for an identifier, and the listing throws as it
    // always did. This pins that final guard, which the per-mission
    // containment would otherwise leave unexercised.
    const { fixture, missions } = core();
    missions.insertMission({
      id: TOKEN,
      idempotencyKey: 'mission:poisoned-id',
      title: 'Id poisoned',
      project: null,
      state: 'planned',
      blockReason: null,
      requestedBy: 'founder',
      actorAuthentication: 'authenticated_os_session',
      requestedRoute: 'CLAUDE',
      at: new Date().toISOString(),
    });
    expect(() => missionListing(fixture.ops, missions)).toThrow(BrowserSafetyError);
    expect(() => missionViews(fixture.ops, missions)).toThrow(/credential shape/);
  });
});

describe('the history holds only stated edges (mutation-testing pass on b3f72d1)', () => {
  /**
   * `amendMission` writes `blocked → blocked` when an amendment leaves a
   * plan-less mission still unreadable — a reason refresh with its own
   * attributed history row — and that branch had no test while the table's
   * test asserted "never a self-edge". The exception is now stated in
   * `isRecordedMissionEdgeLegal`; this covers the branch, asserts the
   * invariant over every history row the suite's scenarios write, and proves
   * `recordTransition` refuses any OTHER self-edge.
   */
  const unreadable = (question: string) => ({ command: question, route: 'CLAUDE' as const, requestedBy: 'founder' });

  it('refreshes the block reason of a still-unreadable mission through a blocked → blocked history row', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, unreadable('Should we move the warehouse to Adama?'), CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    expect(created.data.mission.blockReason).toBe(`${NEEDS_CLARIFICATION_REASON}: question_not_order`);
    // Another unreadable order: a placeholder-style TODO the rules refuse.
    const amended = amendMission(
      fixture.ops,
      missions,
      { missionId: id, command: 'Move the warehouse to TBD.', reason: 'Trying again.', actor: 'founder' },
      CLAUDE_ONLY,
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.data.needsClarification).toBe(true);
    expect(amended.data.planCreated).toBe(false);
    expect(amended.data.tasks).toEqual([]);
    expect(amended.data.mission.state).toBe('blocked');
    // The reason now names THIS amendment's unknowns, not the original's.
    expect(amended.data.mission.blockReason).toMatch(new RegExp(`^${NEEDS_CLARIFICATION_REASON}: `));
    expect(amended.data.mission.blockReason).not.toContain('question_not_order');
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    const events = missions.listEvents(id);
    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'blocked'],
      ['blocked', 'blocked'],
    ]);
    expect(events[1]!.reason).toBe('Amendment recorded; the order still needs clarification and no task was created.');
    expect(events[1]!.actor).toBe('founder');
    expect(missions.listIntent(id)).toHaveLength(2);
  });

  it('every history row is genesis, a table edge, or the documented reason refresh — across a full lifecycle', () => {
    const { fixture, missions } = core();
    // Scenario 1: unreadable, refreshed, then clarified into a plan, then walked to complete.
    const unclear = submitFounderCommand(fixture.ops, missions, unreadable('Should we ship the export?'), CLAUDE_ONLY);
    if (!unclear.ok) throw new Error(unclear.error.message);
    amendMission(fixture.ops, missions, { missionId: unclear.data.mission.id, command: 'Ship TBD.', reason: 'r', actor: 'founder' }, CLAUDE_ONLY);
    amendMission(fixture.ops, missions, { missionId: unclear.data.mission.id, command: 'Ship the export.\n1. Add the endpoint', reason: 'Decided.', actor: 'founder' }, CLAUDE_ONLY);
    for (const to of ['working', 'ready_review', 'verified', 'complete'] as const) {
      expect(transitionMission(fixture.ops, missions, { missionId: unclear.data.mission.id, to, actor: 'founder' }).ok, to).toBe(true);
    }
    // Scenario 2: planned, blocked by the Founder, failed, re-planned, cancelled.
    const stepped = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!stepped.ok) throw new Error(stepped.error.message);
    for (const [to, reason] of [['blocked', 'auditor'], ['failed', 'gave up'], ['planned', undefined], ['cancelled', 'dropped']] as const) {
      expect(transitionMission(fixture.ops, missions, { missionId: stepped.data.mission.id, to, actor: 'founder', reason }).ok, to).toBe(true);
    }
    const rows = fixture.db
      .prepare(`SELECT mission_id, from_state, to_state, reason FROM hq_mission_events ORDER BY seq`)
      .all() as { mission_id: string; from_state: string | null; to_state: string; reason: string | null }[];
    expect(rows.length).toBe(1 + 1 + 1 + 4 + 1 + 4);
    for (const row of rows) {
      const from = row.from_state as 'planned' | null;
      const to = row.to_state as 'planned';
      expect(isRecordedMissionEdgeLegal(from, to), `${String(from)} -> ${to}`).toBe(true);
      // The exception, stated: the ONLY self-edge is blocked → blocked, and
      // it carries the refresh sentence — never a Founder-typed reason.
      if (from === to) {
        expect(from).toBe('blocked');
        expect(row.reason).toBe('Amendment recorded; the order still needs clarification and no task was created.');
      }
    }
    expect(rows.filter((row) => row.from_state === row.to_state)).toHaveLength(1);
  });

  it('refuses, at the store, to record any self-edge other than the refresh', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    for (const state of ['planned', 'working', 'ready_review', 'verified', 'complete', 'failed', 'cancelled'] as const) {
      expect(
        () => missions.recordTransition({ missionId: id, fromState: state, toState: state, blockReason: null, actor: 'founder', reason: null }),
        state,
      ).toThrow(/Refusing to record mission history edge/);
    }
    // And an unlisted non-self edge, in case a future caller skips the table.
    expect(() =>
      missions.recordTransition({ missionId: id, fromState: 'planned', toState: 'complete', blockReason: null, actor: 'founder', reason: null }),
    ).toThrow(/planned -> complete/);
    expect(missions.getMission(id)!.state).toBe('planned');
    expect(missions.listEvents(id)).toHaveLength(1);
  });
});

describe('a mission with no intent row is refused as a broken record, never thrown as a 500', () => {
  /**
   * Opus second pass on `a849af8`, nit 2. `existingReceipt` dereferenced the
   * latest intent row with `!`; on a mission that holds none it threw, and
   * the route turned that into an opaque 500 saying nothing about what was
   * wrong. `missionView` already handles the same case explicitly and reports
   * `chainIntact: false`. A receipt cannot carry "no intent" — its `intent` IS
   * the record that was written — so the honest answer is a typed refusal
   * naming the mission, with nothing created beside the damaged row.
   *
   * The creation transaction writes the mission row and the intent row
   * together, so this state is reachable only by damage or a hand-edited
   * table; the test makes it by deleting the intent row underneath a real
   * mission.
   */
  it('returns mission_intent_missing for the deduplicated resubmission and creates nothing', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    fixture.db.prepare(`DELETE FROM hq_mission_intent WHERE mission_id = ?`).run(created.data.mission.id);
    expect(missions.listIntent(created.data.mission.id)).toHaveLength(0);
    const again = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('mission_intent_missing');
    expect(again.error.message).toContain(created.data.mission.id);
    expect(again.error.message).toContain('NOT intact');
    expect(missions.countMissions()).toBe(1);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(3);
    // And the view says the same thing about the same mission.
    expect(missionView(fixture.ops, missions, missions.getMission(created.data.mission.id)!).intent.chainIntact).toBe(false);
  });
});

describe('a deduplicated receipt lists the plan links it could not carry (mutation-testing pass on b3f72d1)', () => {
  /**
   * `existingReceipt` was rewritten to stop a deduplicated receipt
   * under-reporting its plan — and then did the same thing one line lower
   * with two silent `continue`s: a link whose task row was gone, or whose
   * capability no longer classified, simply vanished from `tasks`. Both
   * branches now record the link in `omitted` with the reason, and both are
   * covered here, so `tasks.length + omitted.length` is the plan's size.
   */
  it('names a link whose canonical task row is gone as task_missing', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const gone = created.data.tasks[1]!.task.id;
    fixture.db.pragma('foreign_keys = OFF');
    fixture.db.prepare(`DELETE FROM op_tasks WHERE id = ?`).run(gone);
    fixture.db.pragma('foreign_keys = ON');
    const again = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.tasks.map((task) => task.task.id)).toEqual([created.data.tasks[0]!.task.id, created.data.tasks[2]!.task.id]);
    expect(again.data.omitted).toEqual([{ taskId: gone, ordinal: 2, reason: 'task_missing' }]);
    expect(again.data.tasks.length + again.data.omitted.length).toBe(3);
  });

  it('names a link whose task no longer classifies as unclassifiable', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const edited = created.data.tasks[2]!.task.id;
    // The capability gate on the command path checks hq.direct_order itself,
    // so the only way a linked task fails to classify is its OWN capability
    // id having been changed underneath it.
    fixture.db.pragma('foreign_keys = OFF');
    fixture.db.prepare(`UPDATE op_tasks SET capability_id = 'gone.capability' WHERE id = ?`).run(edited);
    fixture.db.pragma('foreign_keys = ON');
    const again = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.tasks).toHaveLength(2);
    expect(again.data.omitted).toEqual([{ taskId: edited, ordinal: 3, reason: 'unclassifiable' }]);
  });

  it('carries an empty omitted list on creation and on an undamaged dedupe', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    const again = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(created.ok && created.data.omitted).toEqual([]);
    expect(again.ok && again.data.omitted).toEqual([]);
  });
});

describe('amendment authorization comes before body validation', () => {
  /**
   * Opus second pass on `a849af8`, nit 4. `amendMission` validated the
   * command and the reason before asking who was amending, which inverted the
   * order `transitionMission` uses: an ungranted caller was told
   * `reason_required` or `unsafe_command` — learning whether its text was
   * well-formed — before being told it may not amend at all. The identity of
   * the actor is the first question, and its answer does not depend on what
   * they typed.
   */
  it('answers an ungranted actor with not_permitted whatever the body looks like', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.data.mission.id;
    for (const [label, body] of [
      ['empty reason', { command: 'Ship it faster.', reason: '' }],
      ['empty command', { command: '   ', reason: 'r' }],
      ['credential-shaped command', { command: 'Use sk-abcdefghijklmnopqrstuvwxyz to fix it.', reason: 'r' }],
    ] as const) {
      const result = amendMission(fixture.ops, missions, { missionId: id, actor: 'coo', ...body }, CLAUDE_ONLY);
      expect(!result.ok && result.error.code, label).toBe('not_permitted');
    }
    // A granted actor still gets the body refusals, in the same words as before.
    const noReason = amendMission(fixture.ops, missions, { missionId: id, command: 'x y z', reason: '', actor: 'founder' }, CLAUDE_ONLY);
    expect(!noReason.ok && noReason.error.code).toBe('reason_required');
    expect(missions.listIntent(id)).toHaveLength(1);
  });
});

describe('the listing says how much of the store the window is', () => {
  /**
   * Opus second pass on `a849af8`, P1. `missionViews` capped the list at
   * `MAX_MISSIONS_LISTED` and nothing downstream knew a cap had applied:
   * `missionAttention` counted the window and every consumer printed the
   * result as a fact about the store. `missionListing` now carries the
   * store-wide total, whether the cap applied, and store-wide tallies by
   * recorded state from `countMissionsByState` — a column count over every
   * row — so a blocked mission outside the window is still counted. Drift is
   * the one count that stays window-scoped (it needs the task projection),
   * and `missionAttention` says so on its type.
   */
  function seed(missions: MissionStore, count: number, blockedOldest: number): void {
    for (let i = 0; i < count; i += 1) {
      const blocked = i < blockedOldest;
      missions.insertMission({
        id: `m-${String(i).padStart(3, '0')}`,
        idempotencyKey: `mission:seed-${i}`,
        title: `Seeded mission ${i}`,
        project: null,
        state: blocked ? 'blocked' : 'planned',
        // Alternate the two block reasons so the clarification subset is a
        // strict subset and the tally can be checked against the view rule.
        blockReason: blocked ? (i % 2 === 0 ? `${NEEDS_CLARIFICATION_REASON}: question_not_order` : 'Waiting on the auditor.') : null,
        requestedBy: 'founder',
        actorAuthentication: 'authenticated_os_session',
        requestedRoute: 'CLAUDE',
        at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      });
    }
  }

  it('reports total 55, a truncated window of 50, and 5 blocked that the window does not contain', () => {
    const { fixture, missions } = core();
    seed(missions, 55, 5);
    const listing = missionListing(fixture.ops, missions);
    expect(listing.total).toBe(55);
    expect(listing.listed).toBe(50);
    expect(listing.limit).toBe(MAX_MISSIONS_LISTED);
    expect(listing.truncated).toBe(true);
    expect(listing.missions).toHaveLength(50);
    // The window is the NEWEST 50, and the 5 blocked are the OLDEST: none of
    // them is listed, which is exactly the case that used to read "0 blocked".
    expect(listing.missions.filter((view) => view.state === 'blocked')).toHaveLength(0);
    expect(listing.byState.blocked).toBe(5);
    expect(listing.byState.planned).toBe(50);
    expect(listing.needsClarification).toBe(3);
    const counts = missionAttention(listing.missions, listing);
    expect(counts).toMatchObject({ total: 55, listed: 50, truncated: true, blocked: 5, needsClarification: 3, planned: 50, drift: 0 });
    // The bare window is still available for callers that want only rows.
    expect(missionViews(fixture.ops, missions)).toHaveLength(50);
  });

  it('is not truncated when the store fits, and the tallies agree with the views', () => {
    const { fixture, missions } = core();
    seed(missions, 7, 2);
    const listing = missionListing(fixture.ops, missions);
    expect(listing).toMatchObject({ total: 7, listed: 7, truncated: false });
    expect(listing.byState.blocked).toBe(listing.missions.filter((view) => view.state === 'blocked').length);
    expect(listing.needsClarification).toBe(listing.missions.filter((view) => view.needsClarification).length);
  });

  it('counts the clarification subset by the reserved prefix exactly, not by a LIKE wildcard', () => {
    // `needs_clarification` contains an underscore, which LIKE reads as a
    // single-character wildcard; a reason of `needsXclarification…` would
    // have matched. The tally uses substr and must agree with the view rule.
    const { fixture, missions } = core();
    missions.insertMission({
      id: 'm-lookalike',
      idempotencyKey: 'mission:lookalike',
      title: 'Lookalike',
      project: null,
      state: 'blocked',
      blockReason: 'needsXclarification: not the reserved prefix',
      requestedBy: 'founder',
      actorAuthentication: 'authenticated_os_session',
      requestedRoute: 'CLAUDE',
      at: new Date().toISOString(),
    });
    const listing = missionListing(fixture.ops, missions);
    expect(listing.byState.blocked).toBe(1);
    expect(listing.needsClarification).toBe(0);
    expect(listing.missions[0]!.needsClarification).toBe(false);
  });
});

describe('the view copies canonical truth and publishes no Founder text', () => {
  it('shows approval truth per task, and drift when the recorded state lags the tasks', async () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, SINGLE, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const task = created.data.tasks[0]!.task;
    // Before approval: needs_approval, implied planned, no drift.
    let view = missionView(fixture.ops, missions, created.data.mission);
    expect(view.tasks[0]!.presentation).toBe('needs_approval');
    expect(view.tasks[0]!.canonicalStatus).toBe('needs_approval');
    expect(view.tasks[0]!.boundProvider).toBe('CLAUDE');
    expect(view.driftFromTasks).toBe(false);
    // The COO approves (the Founder may not approve their own order).
    const approved = fixture.ops.approveTask({
      taskId: task.id,
      founderId: 'coo',
      expectedActionDigest: (await import('../src/operator/approvals.js')).taskActionDigest(task),
    });
    expect(approved.ok).toBe(true);
    view = missionView(fixture.ops, missions, missions.getMission(created.data.mission.id)!);
    expect(view.tasks[0]!.presentation).toBe('waiting');
    expect(view.tasks[0]!.canonicalStatus).toBe('queued');
    expect(view.impliedState).toBe('planned');
    // Then a Founder records `working` while nothing runs: the tasks disagree,
    // and the view says so rather than resolving it.
    transitionMission(fixture.ops, missions, { missionId: created.data.mission.id, to: 'working', actor: 'founder' });
    view = missionView(fixture.ops, missions, missions.getMission(created.data.mission.id)!);
    expect(view.state).toBe('working');
    expect(view.impliedState).toBe('planned');
    expect(view.driftFromTasks).toBe(true);
  });

  it('reports a link whose canonical task is gone as a BLOCKED task that implies blocked, with drift', () => {
    // The `missing: true` branch (mutation-testing pass on `b3f72d1`). Before:
    // the missing task was counted (`taskCount 1`, `blocked 1`) but excluded
    // from the implied-state computation, so a mission whose entire plan had
    // vanished reported `impliedState null` and `driftFromTasks false` — a
    // damaged plan with no drift. A link with no row behind it now presents
    // as blocked AND implies blocked, so the counts and the implication agree
    // and the recorded `planned` is shown to disagree with them.
    const { fixture, missions } = core();
    const created = submitFounderCommand(fixture.ops, missions, SINGLE, CLAUDE_ONLY);
    if (!created.ok) throw new Error(created.error.message);
    const taskId = created.data.tasks[0]!.task.id;
    // Foreign keys are ON, so this is exactly the damage a raw write can do
    // only by switching them off first — which is what the test does.
    fixture.db.pragma('foreign_keys = OFF');
    fixture.db.prepare(`DELETE FROM op_tasks WHERE id = ?`).run(taskId);
    fixture.db.pragma('foreign_keys = ON');
    expect(fixture.ops.queue.get(taskId)).toBeNull();

    const view = missionView(fixture.ops, missions, missions.getMission(created.data.mission.id)!);
    expect(view.taskCount).toBe(1);
    expect(view.tasks[0]).toMatchObject({
      taskId,
      missing: true,
      title: null,
      canonicalStatus: 'missing',
      presentation: 'blocked',
      presentationNote: expect.stringContaining('no longer holds'),
    });
    expect(view.taskCounts.blocked).toBe(1);
    expect(view.impliedState).toBe('blocked');
    expect(view.impliedStateLabel).toBe('Blocked');
    expect(view.state).toBe('planned');
    expect(view.driftFromTasks).toBe(true);
    // Through the listing, the drift is counted where the rooms read it.
    const listing = missionListing(fixture.ops, missions, { env: CLAUDE_ONLY });
    expect(missionAttention(listing.missions, listing).drift).toBe(1);
  });

  it('never carries the order text, the objective, a constraint or a step across the boundary', () => {
    const { fixture, missions } = core();
    const created = submitFounderCommand(
      fixture.ops,
      missions,
      { ...STEPPED, command: STEPPED.command.replace('Ship the shift-report export.', 'SECRET-OBJECTIVE-TEXT.') },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error(created.error.message);
    const serialized = JSON.stringify(missionViews(fixture.ops, missions, { env: CLAUDE_ONLY }));
    expect(serialized).not.toContain('SECRET-OBJECTIVE-TEXT');
    expect(serialized).not.toContain('ledger schema');
    expect(serialized).not.toContain('Add the export endpoint');
    expect(serialized).not.toContain('payload');
    // The title — the chosen, published field — does travel, as do the counts.
    expect(serialized).toContain('Shift export');
    expect(serialized).toContain('"constraintCount":1');
  });
});

describe('the store never touches a canonical table', () => {
  it('names only the four mission tables in its code, comments aside', () => {
    const raw = readFileSync(fileURLToPath(new URL('../src/mission/store.ts', import.meta.url)), 'utf8');
    // The docstring is allowed to NAME the tables it promises never to touch;
    // the code is not allowed to touch them.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const tables = new Set([...code.matchAll(/\b((?:hq|op)_\w+)\b/g)].map((m) => m[1]!));
    expect([...tables].sort()).toEqual(['hq_mission_events', 'hq_mission_intent', 'hq_mission_tasks', 'hq_missions']);
  });
});

describe('a plan whose composed briefs would not fit is refused before anything is written', () => {
  /**
   * Opus second pass on `f98fbfd`. `MAX_COMMAND_LENGTH` (3500) was documented
   * as guaranteeing that a composed brief fits `MAX_INSTRUCTION_LENGTH`
   * (4000). It does not: `composeBrief` repeats the objective, every
   * constraint and every criterion into EACH step's brief, so a short order
   * with many short constraints composes to a longer brief than the order.
   *
   * The order below is inside every documented bound — 3,079 characters, 11
   * lines, 1 step, a real objective, no placeholder, no open choice — and used
   * to compose to a 4,248-character brief. The mission was then refused deep
   * inside the creation transaction with `instruction_too_long`, quoting a
   * 4,000-character limit against an order the Founder had written to 3,079.
   */
  const OVERSIZED = {
    command: [
      'Improve the QOS website speed.',
      '1. Profile the homepage.',
      ...Array.from({ length: 9 }, () => 'no a. '.repeat(56).trim()),
    ].join('\n'),
    route: 'CLAUDE' as const,
    requestedBy: 'founder',
  };

  it('is genuinely inside every bound the order path documents', () => {
    expect(OVERSIZED.command.length).toBeLessThan(3500);
    expect(OVERSIZED.command.split('\n')).toHaveLength(11);
  });

  it('refuses with the mission-level reason, not the task-level one', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(fixture.ops, missions, OVERSIZED, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('plan_brief_too_long');
    // Names the real cause rather than a limit the Founder did not exceed.
    expect(result.error.code).not.toBe('instruction_too_long');
    expect(result.error.details?.largestLength).toBeGreaterThan(4000);
    expect(result.error.message).toContain('split this into more than one mission');
  });

  it('writes nothing at all — no mission, no intent, no task', () => {
    const { fixture, missions } = core();
    submitFounderCommand(fixture.ops, missions, OVERSIZED, CLAUDE_ONLY);
    expect(missions.countMissions()).toBe(0);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(fixture.ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('refuses an amendment that would give a plan-less mission oversized briefs', () => {
    const { fixture, missions } = core();
    // A mission recorded with no plan: an unreadable order.
    const created = submitFounderCommand(
      fixture.ops,
      missions,
      { command: 'What should we do about the website?', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.tasks).toHaveLength(0);

    const amended = amendMission(
      fixture.ops,
      missions,
      {
        missionId: created.data.mission.id,
        command: OVERSIZED.command,
        reason: 'Clarified into an instruction.',
        actor: 'founder',
      },
      CLAUDE_ONLY,
    );
    expect(amended.ok).toBe(false);
    if (amended.ok) return;
    expect(amended.error.code).toBe('plan_brief_too_long');
    // The refused amendment appended nothing: the intent lock still holds only
    // the original order.
    expect(missions.listIntent(created.data.mission.id)).toHaveLength(1);
    expect(missions.verifyIntentChain(created.data.mission.id)).toBe(true);
  });

  it('still accepts an order whose briefs do fit', () => {
    const { fixture, missions } = core();
    const result = submitFounderCommand(fixture.ops, missions, STEPPED, CLAUDE_ONLY);
    expect(result.ok).toBe(true);
  });
});
