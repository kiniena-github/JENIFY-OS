/**
 * Sol M1 (PR #266 review 5124774932) — the cross-connection authority /
 * kill-switch TOCTOU on `orchestrateMission` apply, proven closed with REAL
 * two-connection races.
 *
 * The defect: apply's authority, capability, Mission-gate and kill-switch
 * checks ran BEFORE the outer IMMEDIATE transaction. A second connection
 * could commit a revocation or engage the orchestrate kill switch after the
 * precheck observed them clear and before the apply acquired its write lock,
 * and the locked cycle then created real tasks on stale authority — including
 * the narrower race where `createTask` succeeded before `linkMissionPlanItem`
 * observed a concurrently revoked Mission gate, leaving a real UNLINKED task.
 *
 * The proof shape, per test (no production hook simulates anything — the race
 * is the real SQLite write lock):
 *
 *   1. A revoker WORKER THREAD opens its own connection to the same WAL file,
 *      takes `BEGIN IMMEDIATE` (the real write lock) and executes the
 *      revocation UNCOMMITTED — so the apply's precheck, which reads
 *      committed state, is guaranteed to still observe the old, valid world.
 *   2. The main thread invokes apply. Prechecks pass; the apply then blocks
 *      inside its own `BEGIN IMMEDIATE` on the revoker's held lock.
 *   3. The revoker commits after a wide margin and releases the lock. SQLite
 *      itself guarantees the ordering Sol demands: the revocation commit
 *      happens strictly BEFORE the apply obtains the write lock, because the
 *      commit is what releases it.
 *   4. The apply acquires the lock, revalidates from current canonical truth,
 *      and refuses — with `revalidation: 'post_lock'` in the refusal details,
 *      which is the proof the precheck had passed (a precheck refusal never
 *      carries it). The elapsed-time assertion proves the apply genuinely
 *      blocked on the lock rather than refusing early. If scheduling ever
 *      degenerated so far that the precheck read post-commit state, these
 *      assertions fail LOUDLY — the test can flake toward failure, never
 *      toward a vacuous pass.
 *   5. Zero orchestration mutations survive: no op_tasks row, no plan-item
 *      link, no orchestration run or run item, no orchestrated mission event,
 *      no mission_orchestrated evidence — and no orphan/unlinked task.
 *
 * The revoker writes the same canonical rows the real configuration acts
 * write (`hq_human_principals`, `op_capabilities`, `op_kill_switch`), because
 * canonical store truth is exactly what the locked revalidation must consult.
 * It deliberately appends no evidence — the flat `op_evidence` count is part
 * of the zero-write proof.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';

const SPEC_CAPABILITY = 'repo.read_status';
const SPEC_PAYLOAD = { intent: 'measure load times', target: 'landing-page' };

/**
 * How long the revoker holds the lock after the apply has been invoked before
 * committing. The precheck is a handful of prepared SELECTs (microseconds);
 * this margin only needs to outlast the gap between `Atomics.store` and those
 * reads on the same thread.
 */
const COMMIT_DELAY_MS = 400;

/** The revoker thread. CommonJS source for `new Worker(…, { eval: true })`. */
const REVOKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const Database = require(workerData.betterSqlitePath);
const state = new Int32Array(workerData.sab);
const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
// The real write lock, held from BEFORE the apply starts. The revocation is
// executed but NOT committed, so the apply's precheck (committed-state reads)
// still sees the old, valid world no matter how threads schedule.
db.exec('BEGIN IMMEDIATE');
for (const s of workerData.statements) db.prepare(s.sql).run(...s.params);
Atomics.store(state, 0, 1);
Atomics.notify(state, 0);
// Wait for "the apply is being invoked NOW", then give its synchronous
// precheck a wide margin before committing. The commit releases the lock —
// SQLite orders it strictly before the apply's own BEGIN IMMEDIATE succeeds.
Atomics.wait(state, 1, 0, 15000);
Atomics.wait(state, 2, 0, workerData.commitDelayMs);
db.exec('COMMIT');
db.close();
`;

interface RaceFixture {
  db: HqDatabase;
  dbPath: string;
  ops: HeadquarterOperations;
  missionId: string;
  dir: string;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A FILE-backed fixture — the whole point is two real connections. */
function raceFixture(): RaceFixture {
  const dir = mkdtempSync(join(tmpdir(), 'hq-orch-race-'));
  const dbPath = join(dir, 'race.sqlite');
  const db = openHqDatabase(dbPath);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const ops = new HeadquarterOperations(db, {
    policyCtx: { preApprovedCapabilities: new Set<string>() },
  });
  new CapabilityRegistry(db).register({
    id: SPEC_CAPABILITY,
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  registerMissionCommandCapability(db);
  registerMissionOrchestrateCapability(db);
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      MISSION_COMMAND_CAPABILITY.id,
      MISSION_ORCHESTRATE_CAPABILITY.id,
      SPEC_CAPABILITY,
    ],
    approvalAuthority: true,
    active: true,
  });
  const commanded = ops.commandMission({
    title: 'Faster QOS site',
    objective: 'Reduce page load times without changing the visual design',
    constraints: ['Do not change the visual design'],
    plan: [{ summary: 'Measure current load times', capabilityId: SPEC_CAPABILITY, payload: SPEC_PAYLOAD }],
    requestedBy: 'founder',
  });
  if (!commanded.ok) throw new Error(`fixture: commandMission refused: ${JSON.stringify(commanded.error)}`);
  const missionId = commanded.data.mission.id;
  // The world is valid before the race: preview classifies the item READY.
  const preview = ops.orchestrateMission({ missionId, mode: 'preview', requestedBy: 'founder' });
  if (!preview.ok) throw new Error(`fixture: preview refused: ${JSON.stringify(preview.error)}`);
  if (preview.data.decisions[0]?.decision !== 'ready') {
    throw new Error(`fixture: expected a ready item, got ${JSON.stringify(preview.data.decisions)}`);
  }
  return { db, dbPath, ops, missionId, dir };
}

const COUNTED_TABLES = [
  'op_tasks',
  'op_evidence',
  'hq_events',
  'hq_mission_events',
  'hq_orchestration_runs',
  'hq_orchestration_run_items',
  'hq_approvals',
] as const;

function orchestrationCounts(fx: RaceFixture): number[] {
  return COUNTED_TABLES.map(
    (table) => (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

function linkedPlanItems(fx: RaceFixture): number {
  return (
    fx.db
      .prepare(`SELECT COUNT(*) AS n FROM hq_mission_plan_items WHERE mission_id = ? AND task_id IS NOT NULL`)
      .get(fx.missionId) as { n: number }
  ).n;
}

interface Revocation {
  sql: string;
  params: unknown[];
}

/** Run one deterministic race: revoker holds the lock, apply blocks, revoker commits, apply revalidates. */
async function raceApply(
  fx: RaceFixture,
  statements: Revocation[],
): Promise<{ result: ReturnType<HeadquarterOperations['orchestrateMission']>; elapsedMs: number }> {
  const sab = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(sab);
  const worker = new Worker(REVOKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath: fx.dbPath,
      betterSqlitePath: createRequire(import.meta.url).resolve('better-sqlite3'),
      sab,
      statements,
      commitDelayMs: COMMIT_DELAY_MS,
    },
  });
  const workerDone = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`revoker exited ${code}`))));
  });
  // Block until the revoker genuinely holds the write lock with its
  // uncommitted revocation. ('not-equal' means it got there first.)
  expect(Atomics.wait(state, 0, 0, 15000)).not.toBe('timed-out');
  const startedAt = Date.now();
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
  const result = fx.ops.orchestrateMission({ missionId: fx.missionId, mode: 'apply', requestedBy: 'founder' });
  const elapsedMs = Date.now() - startedAt;
  await workerDone;
  return { result, elapsedMs };
}

/** The shared post-race proof: raced in-lock refusal, zero surviving orchestration writes. */
function expectRacedRefusal(
  fx: RaceFixture,
  before: number[],
  raced: { result: ReturnType<HeadquarterOperations['orchestrateMission']>; elapsedMs: number },
  code: string,
): { code: string; message: string; details?: Record<string, unknown> } {
  expect(raced.result.ok).toBe(false);
  if (raced.result.ok) throw new Error('unreachable');
  const error = raced.result.error;
  expect(error.code).toBe(code);
  // The proof the precheck PASSED: only the locked revalidation marks its
  // refusals. And the apply genuinely waited out the held lock — a precheck
  // refusal would have returned in milliseconds.
  expect(error.details?.revalidation).toBe('post_lock');
  expect(raced.elapsedMs).toBeGreaterThanOrEqual(COMMIT_DELAY_MS - 100);
  // ZERO orchestration mutations survive, orphans included.
  expect(orchestrationCounts(fx)).toEqual(before);
  expect(linkedPlanItems(fx)).toBe(0);
  expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  return error;
}

describe('Test A — orchestrate authority revoked between precheck and lock', () => {
  it('a raced principal-grant revocation of hq.mission_orchestrate fails closed with zero writes', async () => {
    const fx = raceFixture();
    const before = orchestrationCounts(fx);
    const raced = await raceApply(fx, [
      {
        sql: `UPDATE hq_human_principals SET originate_capabilities = ? WHERE id = 'founder'`,
        params: [JSON.stringify([MISSION_COMMAND_CAPABILITY.id, SPEC_CAPABILITY])],
      },
    ]);
    const error = expectRacedRefusal(fx, before, raced, 'not_permitted');
    expect(error.message).toContain(MISSION_ORCHESTRATE_CAPABILITY.id);
  });

  it('a raced disable of the canonical hq.mission_orchestrate capability row fails closed with zero writes', async () => {
    const fx = raceFixture();
    const before = orchestrationCounts(fx);
    const raced = await raceApply(fx, [
      {
        sql: `UPDATE op_capabilities SET enabled = 0 WHERE id = ?`,
        params: [MISSION_ORCHESTRATE_CAPABILITY.id],
      },
    ]);
    const error = expectRacedRefusal(fx, before, raced, 'capability_disabled');
    expect(error.message).toContain(MISSION_ORCHESTRATE_CAPABILITY.id);
  });
});

describe('Test B — kill switch engaged between precheck and lock', () => {
  // The canonical row the queue's #engageKillSwitch writes, committed by the
  // second connection. No evidence append, deliberately — the flat
  // op_evidence count is part of the zero-write proof.
  const engage = (scope: string): Revocation => ({
    sql: `INSERT INTO op_kill_switch (scope, engaged, reason, engaged_by, engaged_at)
          VALUES (?, 1, ?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET engaged = 1, reason = excluded.reason,
            engaged_by = excluded.engaged_by, engaged_at = excluded.engaged_at`,
    params: [scope, 'raced emergency stop', 'founder', new Date().toISOString()],
  });

  it('a raced hq.mission_orchestrate-scope engagement fails closed with zero writes', async () => {
    const fx = raceFixture();
    const before = orchestrationCounts(fx);
    const raced = await raceApply(fx, [engage(MISSION_ORCHESTRATE_CAPABILITY.id)]);
    expectRacedRefusal(fx, before, raced, 'kill_switch_engaged');
  });

  it('a raced GLOBAL engagement fails closed with zero writes', async () => {
    const fx = raceFixture();
    const before = orchestrationCounts(fx);
    const raced = await raceApply(fx, [engage('*')]);
    expectRacedRefusal(fx, before, raced, 'kill_switch_engaged');
  });
});

describe('Test C — Mission-command gate revoked between precheck and lock', () => {
  it('a raced hq.mission_command revocation fails closed — no task, no orphan, no run, no event, no evidence', async () => {
    const fx = raceFixture();
    const before = orchestrationCounts(fx);
    const raced = await raceApply(fx, [
      {
        sql: `UPDATE hq_human_principals SET originate_capabilities = ? WHERE id = 'founder'`,
        params: [JSON.stringify([MISSION_ORCHESTRATE_CAPABILITY.id, SPEC_CAPABILITY])],
      },
    ]);
    const error = expectRacedRefusal(fx, before, raced, 'not_permitted');
    expect(error.message).toContain(MISSION_COMMAND_CAPABILITY.id);
    // The narrower Sol M1 hazard, stated: createTask must not have won the
    // race against the link's Mission-gate observation. No unlinked task —
    // no task AT ALL — survives.
    const orphanTasks = fx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM op_tasks WHERE id NOT IN
           (SELECT task_id FROM hq_mission_plan_items WHERE task_id IS NOT NULL)`,
      )
      .get() as { n: number };
    expect(orphanTasks.n).toBe(0);
  });
});

describe('the revalidation admits an undisturbed apply', () => {
  it('with the lock contended but nothing revoked, the apply proceeds and creates its task', async () => {
    const fx = raceFixture();
    // A revoker that changes NOTHING — pure lock contention. The apply must
    // wait out the lock, revalidate, and then act normally: the correction
    // refuses stale authority, not concurrency itself.
    const raced = await raceApply(fx, [
      { sql: `UPDATE hq_human_principals SET display_name = 'Founder' WHERE id = 'founder'`, params: [] },
    ]);
    expect(raced.result.ok).toBe(true);
    if (!raced.result.ok) throw new Error('unreachable');
    expect(raced.result.data.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
    expect(linkedPlanItems(fx)).toBe(1);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
  });
});
