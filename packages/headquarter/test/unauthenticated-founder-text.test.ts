/**
 * The unauthenticated artifact IS a Founder-text publication surface —
 * disclosed rather than changed (Wave 5 correction round ten, NEW LOW; the
 * disclosure and the pin both CORRECTED in round fourteen, High 4).
 *
 * `hq-snapshot.json` is served with no authentication at all, and
 * `src/cli/snapshot.ts` writes the whole object `liveSnapshotFromOperations`
 * returns — not a subset of it. The round-ten review named ONE field. Round ten
 * measured FOUR and wrote "four fields, not one" into
 * `PHASE_13_ADVANCED_RELIABILITY.md`, and this file pinned exactly two of them
 * by planting canaries in two methods.
 *
 * **A fresh hostile review at `f348f9a` planted canaries across the whole
 * Founder-writable facade and found the real number is far higher. Re-measured
 * at the merged head with every plant executed rather than assumed — every
 * facade call below is asserted to have RETURNED OK, because a canary that was
 * never written proves nothing — it is 20 of 34.** The under-disclosure was the
 * defect: the publication is intended, no credential can reach any of these
 * fields (each is scanned at its facade write), and nothing about the behaviour
 * is changed here.
 *
 * ## What this file now derives rather than lists
 *
 * The old pin planted canaries in two methods and asserted three `toContain`
 * paths. A field added beside them published silently. This version:
 *
 *  - plants a distinct canary in EVERY Founder-writable text parameter of every
 *    method the scenario exercises, and asserts the plant SUCCEEDED;
 *  - asserts the crossing set EXACTLY, in both directions, so a new published
 *    field and a newly-withheld one each fail;
 *  - DERIVES the completeness of the plant from `service.ts` itself: every name
 *    in each exercised method's own `callerTextRefusal(input, [...])` list must
 *    be planted here or exempted with a reason, so a parameter added to one of
 *    those methods fails this file rather than being published quietly;
 *  - checks the phase document's table against the measured crossing set, so
 *    the prose cannot drift from the behaviour in either direction.
 *
 * **The scope, stated rather than implied.** The derivation is complete for the
 * METHODS the scenario exercises, which are the Founder-driven writes whose
 * rows the snapshot's sections are built from. It is not a claim about every
 * method on the facade: `facade-write-scan.test.ts` owns that enumeration, over
 * the call graph, for the credential scan. A method added to a snapshot section
 * in a future phase has to be added to `EXERCISED` here, and nothing in this
 * file can force that — which is why it is written down instead of implied.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { intelligenceFixture } from './intelligence.fixture.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  MISSION_COMMAND_CAPABILITY,
} from '../src/application/mission-command.js';
import { PROJECT_COMMAND_CAPABILITY } from '../src/application/project-command.js';
import { INTELLIGENCE_COMMAND_CAPABILITY } from '../src/application/intelligence-command.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  registerReliabilityCommandCapability,
} from '../src/application/reliability-command.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');
const PHASE_13 = path.join(HERE, '..', '..', '..', 'docs', 'HEADQUARTER', 'PHASE_13_ADVANCED_RELIABILITY.md');
const NOW = new Date('2026-09-08T09:00:00.000Z');

/** Every path in a snapshot at which `needle` appears inside a string. */
function pathsCarrying(value: unknown, needle: string, at = 'snapshot', out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes(needle)) out.push(at);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => pathsCarrying(entry, needle, `${at}[${index}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) pathsCarrying(entry, needle, `${at}.${key}`, out);
  }
  return out;
}

/**
 * The measured answer, as one table: `method.parameter` -> does the canary reach
 * the unauthenticated artifact, and if so at one path that proves it.
 *
 * `crosses: true` rows ARE the disclosure. `crosses: false` rows are just as
 * load-bearing: they are what makes the payload carve-out from the credential
 * scan defensible, and what would fail if a future phase started publishing one
 * of them.
 */
interface Canary {
  /** `method.parameter`, and the canary text is derived from it. */
  field: string;
  crosses: boolean;
  /** One measured path, for a `crosses: true` row. Not the only one. */
  at?: string;
}

const CANARIES: readonly Canary[] = [
  { field: 'createProject.name', crosses: true, at: 'snapshot.projects.data[0].name' },
  { field: 'createProject.purpose', crosses: true, at: 'snapshot.projects.data[0].purpose' },
  { field: 'createProject.stream', crosses: true, at: 'snapshot.projects.data[0].stream' },
  { field: 'commandMission.title', crosses: true, at: 'snapshot.missions.data[0].title' },
  { field: 'commandMission.objective', crosses: true, at: 'snapshot.missions.data[0].intentHistory[0].objective' },
  { field: 'commandMission.scope', crosses: true, at: 'snapshot.missions.data[0].scope' },
  { field: 'commandMission.constraints', crosses: true, at: 'snapshot.missions.data[0].intentHistory[0].constraints[0]' },
  { field: 'commandMission.acceptanceCriteria', crosses: true, at: 'snapshot.missions.data[0].intentHistory[0].acceptanceCriteria[0]' },
  { field: 'commandMission.planItems', crosses: true, at: 'snapshot.missions.data[0].planItems[0].summary' },
  { field: 'commandMission.project', crosses: true, at: 'snapshot.missions.data[0].project' },
  { field: 'commandMission.instruction', crosses: false },
  { field: 'amendMissionIntent.amendment', crosses: false },
  { field: 'amendMissionIntent.objective', crosses: true, at: 'snapshot.missions.data[0].objective' },
  { field: 'amendMissionIntent.constraints', crosses: true, at: 'snapshot.missions.data[0].constraints[0]' },
  { field: 'amendMissionIntent.acceptanceCriteria', crosses: true, at: 'snapshot.missions.data[0].acceptanceCriteria[0]' },
  { field: 'amendMissionIntent.addPlanItems', crosses: true, at: 'snapshot.missions.data[0].planItems[1].summary' },
  { field: 'createTask.title', crosses: true, at: 'snapshot.operations.data.blocked[0].title' },
  { field: 'createTask.project', crosses: true, at: 'snapshot.operations.data.blocked[0].project' },
  { field: 'createTask.payload', crosses: false },
  { field: 'denyTask.reason', crosses: true, at: 'snapshot.operations.data.blocked[0].blockReason' },
  { field: 'failTask.reason', crosses: true, at: 'snapshot.activity.data[1].summary' },
  { field: 'engageKillSwitch.reason', crosses: true, at: 'snapshot.operations.data.killSwitch.engagedScopes[0].reason' },
  { field: 'engageKillSwitch.scope', crosses: true, at: 'snapshot.operations.data.killSwitch.engagedScopes[0].scope' },
  { field: 'engageKillSwitch.founderId', crosses: true, at: 'snapshot.operations.data.killSwitch.engagedScopes[0].engagedBy' },
  { field: 'registerExecutionWorker.displayName', crosses: true, at: 'snapshot.workforce.data[0].displayName' },
  { field: 'registerExecutionWorker.vendor', crosses: true, at: 'snapshot.workforce.data[0].vendor' },
  { field: 'setIntelligenceBudget.note', crosses: false },
  { field: 'recordModelObservation.unitCostBasis', crosses: false },
  { field: 'recordModelObservation.note', crosses: false },
  { field: 'recordVerifiedBackup.backupPath', crosses: false },
  { field: 'recordVerifiedBackup.note', crosses: false },
  { field: 'postMissionMessage.body', crosses: false },
  { field: 'postMissionMessage.refs', crosses: false },
  { field: 'recordIntelligenceDecision.label', crosses: false },
  { field: 'recordIntelligenceCost.basis', crosses: false },
  { field: 'recordIntelligenceCost.note', crosses: false },
];

/** The canary text for one field — distinct per field, and searchable. */
function canaryFor(field: string): string {
  return `CANARY-${field.replace(/\./g, '-')}`;
}

/**
 * The methods this scenario exercises, and the caller-text parameters of each
 * that are deliberately NOT planted, with the reason.
 *
 * A name here is a claim that the parameter cannot carry Founder free text, and
 * each is checkable against the method's own validation:
 *
 *  - `recordIntelligenceCost.providerId` and `.modelId` are bounded to a
 *    registered provider and to an observed model id; a canary in either is
 *    refused before any write, so planting one would measure the validator
 *    rather than the artifact.
 *  - `amendMissionIntent.specifyPlanItems` is a structured object list (seq,
 *    capabilityId, payload) with no free-text member; its summary text comes
 *    from `addPlanItems`, which IS planted.
 */
const NOT_PLANTED: Record<string, readonly string[]> = {
  recordIntelligenceCost: ['providerId', 'modelId'],
  amendMissionIntent: ['specifyPlanItems'],
};

interface Planted {
  snapshot: unknown;
  /** Every facade call the scenario made, and whether it returned ok. */
  calls: { name: string; ok: boolean; error: string }[];
  /**
   * Every canary text that is actually IN THE STORE at the instant the
   * snapshot is taken, found by sweeping every text column of every table
   * (Wave 5 correction round fifteen, High 4).
   *
   * The docblock above warns that a canary which was never WRITTEN reads as
   * "does not cross", and the first test checks every facade call returned ok.
   * That was not enough, and the gap shipped: `engageKillSwitch.reason` was
   * written successfully — and then the very next line of the scenario
   * RELEASED the switch, so the state carrying it was gone before the
   * snapshot. The row read `crosses: false`, and the shipped census told a
   * reader that the Founder's stop-everything reason does not reach an
   * unauthenticated file. It does.
   *
   * "Written ok" and "still in the store" are different properties, and only
   * the second one makes a `crosses: false` verdict mean anything. This is the
   * second one, swept from `sqlite_master` so a table added in a future phase
   * is included without being named.
   */
  storedCanaries: Set<string>;
  cleanup: () => void;
}

/**
 * Every canary text present in any TEXT-ish column of any table in the file.
 *
 * Derived from `sqlite_master` and `PRAGMA table_info`, so it covers ledgers
 * this file has never heard of. Values are compared as strings because SQLite
 * columns are dynamically typed and HQ stores JSON blobs in TEXT columns.
 */
function canariesStillInStore(db: {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
}, needles: readonly string[]): Set<string> {
  const found = new Set<string>();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  for (const { name } of tables) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    } catch {
      // A view or virtual table that will not plainly select is not a store of
      // canary text; skipping it cannot hide one, because the canary would
      // still have to have been written to a real table to get there.
      continue;
    }
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        for (const needle of needles) if (value.includes(needle)) found.add(needle);
      }
    }
  }
  return found;
}

/**
 * One scenario that writes a distinct canary into every field of `CANARIES`.
 *
 * Every call is recorded with its outcome, and the first test asserts they all
 * returned ok — a canary that was never written would otherwise read as "does
 * not cross" and quietly widen the disclosure's silence.
 */
function plantEveryCanary(): Planted {
  const fx = intelligenceFixture();
  const calls: { name: string; ok: boolean; error: string }[] = [];
  const record = <T>(name: string, result: T): T => {
    const outcome = result as { ok?: boolean; error?: unknown };
    calls.push({
      name,
      ok: outcome?.ok === true,
      error: outcome?.ok === true ? '' : JSON.stringify(outcome?.error ?? null),
    });
    return result;
  };
  const c = canaryFor;

  registerReliabilityCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      CAPS.indexDoc,
      MISSION_COMMAND_CAPABILITY.id,
      PROJECT_COMMAND_CAPABILITY.id,
      INTELLIGENCE_COMMAND_CAPABILITY.id,
      RELIABILITY_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });

  const project = expectOk(
    record(
      'createProject',
      fx.ops.createProject({
        name: c('createProject.name'),
        purpose: c('createProject.purpose'),
        stream: c('createProject.stream'),
        requestedBy: 'founder',
      }),
    ),
  ).project;

  const mission = expectOk(
    record(
      'commandMission',
      fx.ops.commandMission({
        title: c('commandMission.title'),
        objective: c('commandMission.objective'),
        scope: c('commandMission.scope'),
        constraints: [c('commandMission.constraints')],
        acceptanceCriteria: [c('commandMission.acceptanceCriteria')],
        planItems: [c('commandMission.planItems')],
        project: c('commandMission.project'),
        projectId: project.id,
        instruction: c('commandMission.instruction'),
        requestedBy: 'founder',
      }),
    ),
  ).mission;

  record(
    'amendMissionIntent',
    fx.ops.amendMissionIntent({
      missionId: mission.id,
      amendment: c('amendMissionIntent.amendment'),
      objective: c('amendMissionIntent.objective'),
      constraints: [c('amendMissionIntent.constraints')],
      acceptanceCriteria: [c('amendMissionIntent.acceptanceCriteria')],
      addPlanItems: [c('amendMissionIntent.addPlanItems')],
      requestedBy: 'founder',
    }),
  );

  const blocked = expectOk(
    record(
      'createTask',
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'main', instruction: c('createTask.payload') },
        idempotencyKey: 'canary-blocked',
        requestedBy: 'claude',
        title: c('createTask.title'),
        project: c('createTask.project'),
      }),
    ),
  );
  record(
    'denyTask',
    fx.ops.denyTask({
      taskId: blocked.task.id,
      founderId: 'founder',
      reason: c('denyTask.reason'),
    }),
  );

  const failing = expectOk(
    record(
      'createTask (the failing one)',
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'second' },
        idempotencyKey: 'canary-failing',
        requestedBy: 'claude',
        title: 'an ordinary second task',
      }),
    ),
  );
  const claimed = expectOk(
    record('claimNext', fx.ops.claimNext('claude', CAPS.openPr, undefined, failing.task.id)),
  );
  record('startTask', fx.ops.startTask(claimed.id, 'claude', claimed.fence));
  record('failTask', fx.ops.failTask(claimed.id, 'claude', claimed.fence, c('failTask.reason')));

  record('engageKillSwitch', fx.ops.engageKillSwitch('global', 'founder', c('engageKillSwitch.reason')));
  record('releaseKillSwitch', fx.ops.releaseKillSwitch('global', 'founder'));
  // A SECOND scope, engaged and DELIBERATELY LEFT ENGAGED (Wave 5 correction
  // round fifteen, High 4).
  //
  // The scenario used to engage the global scope at the line above and release
  // it at the line below, and then snapshot — measuring the one state in which
  // there is provably nothing to publish. `engageKillSwitch.reason` therefore
  // read `crosses: false`, and the shipped census said the Founder's
  // stop-everything reason does not reach the unauthenticated artifact. It
  // does: `snapshot.operations.data.killSwitch.engagedScopes[]` carries the
  // reason, the scope and the engaging principal for every scope that is still
  // engaged. The engaging PRINCIPAL is planted by registering one whose id is
  // the canary, because `founderId` must resolve to a registered principal
  // holding approval authority — a canary that the validator refuses would
  // measure the validator, which is exactly the false-exemption pattern
  // Medium 4 of the same review reported one file over.
  fx.principals.register({
    id: c('engageKillSwitch.founderId'),
    displayName: 'Canary Founder',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  record(
    'engageKillSwitch (left engaged)',
    fx.ops.engageKillSwitch(
      c('engageKillSwitch.scope'),
      c('engageKillSwitch.founderId'),
      c('engageKillSwitch.reason'),
    ),
  );

  record(
    'registerExecutionWorker',
    fx.ops.registerExecutionWorker({
      workerId: 'canary-worker',
      displayName: c('registerExecutionWorker.displayName'),
      vendor: c('registerExecutionWorker.vendor'),
      role: 'parallel_implementer',
      allowedCapabilities: [CAPS.openPr],
      founderId: 'founder',
    }),
  );

  record(
    'setIntelligenceBudget',
    fx.ops.setIntelligenceBudget({
      scopeKind: 'deployment',
      scopeId: 'deployment',
      window: 'total',
      ceilingMinorUnits: 100000,
      currency: 'USD',
      permittedTiers: ['deterministic_local', 'low_cost', 'standard', 'high', 'critical_review'],
      setBy: 'founder',
      note: c('setIntelligenceBudget.note'),
    }),
  );

  record(
    'recordModelObservation',
    fx.ops.recordModelObservation({
      providerId: 'anthropic',
      modelId: 'canary-model',
      locality: 'cloud',
      availability: 'healthy',
      unitCostProvenance: 'estimated',
      unitCostMinorUnits: 25,
      unitCostCurrency: 'USD',
      unitCostUnitKind: 'requests',
      unitCostBasis: c('recordModelObservation.unitCostBasis'),
      source: 'founder_declared',
      observedBy: 'founder',
      note: c('recordModelObservation.note'),
    }),
  );

  // A real HQ file, because `recordVerifiedBackup` verifies rather than trusts:
  // the canary rides in the FILE NAME, which is the caller text it stores.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-canary-'));
  const backupPath = path.join(dir, `${canaryFor('recordVerifiedBackup.backupPath')}.sqlite`);
  const backup = openHqDatabase(backupPath);
  void new HeadquarterOperations(backup);
  backup.close();
  record(
    'recordVerifiedBackup',
    fx.ops.recordVerifiedBackup({
      backupPath,
      requestedBy: 'founder',
      note: c('recordVerifiedBackup.note'),
    }),
  );

  record(
    'postMissionMessage',
    fx.ops.postMissionMessage({
      threadId: mission.id,
      author: 'founder',
      body: c('postMissionMessage.body'),
      refs: [c('postMissionMessage.refs')],
    }),
  );

  const spending = expectOk(
    record(
      'createTask (the spending one)',
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'third' },
        idempotencyKey: 'canary-spending',
        requestedBy: 'claude',
        title: 'an ordinary third task',
      }),
    ),
  );
  const claimedSpender = expectOk(
    record(
      'claimNext (the spending one)',
      fx.ops.claimNext('claude', CAPS.openPr, undefined, spending.task.id),
    ),
  );
  record(
    'recordIntelligenceDecision',
    fx.ops.recordIntelligenceDecision({
      taskId: claimedSpender.id,
      workerId: 'claude',
      fence: claimedSpender.fence,
      tier: 'critical_review',
      label: c('recordIntelligenceDecision.label'),
      complexity: 'routine',
      contextSize: 'medium',
      workKind: 'coding',
      idempotencyKey: 'canary-decision',
    }),
  );
  record(
    'recordIntelligenceCost',
    fx.ops.recordIntelligenceCost({
      taskId: claimedSpender.id,
      workerId: 'claude',
      fence: claimedSpender.fence,
      providerId: 'anthropic',
      provenance: 'estimated',
      amountMinorUnits: 10,
      currency: 'USD',
      unitKind: 'requests',
      basis: c('recordIntelligenceCost.basis'),
      note: c('recordIntelligenceCost.note'),
      idempotencyKey: 'canary-cost',
    }),
  );

  return {
    snapshot: liveSnapshotFromOperations(fx.ops, { now: NOW.toISOString() }),
    calls,
    storedCanaries: canariesStillInStore(fx.db, CANARIES.map((canary) => canaryFor(canary.field))),
    cleanup: () => {
      fx.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Every method body in `service.ts`, sliced from its declaration to the next. */
function methodBodies(): Map<string, string> {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(classStart).toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]!);
    if (match && !['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try'].includes(match[1]!)) {
      starts.push({ name: match[1]!, line: i });
    }
  }
  const bodies = new Map<string, string>();
  starts.forEach((start, k) => {
    const body = lines
      .slice(start.line, k + 1 < starts.length ? starts[k + 1]!.line : lines.length)
      .join('\n');
    bodies.set(start.name, (bodies.get(start.name) ?? '') + body);
  });
  return bodies;
}

/** The names in one method's own `callerTextRefusal(…, [ … ])` declared list. */
function declaredCallerText(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/callerTextRefusal\([^,]+,\s*\[([^\]]*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const name = /'([A-Za-z_][A-Za-z0-9_]*)'/.exec(part);
      if (name) names.add(name[1]!);
    }
  }
  return [...names].sort();
}

describe('what Founder-typed text crosses to the unauthenticated artifact', () => {
  it('plants every canary through the real facade, and every plant succeeds', () => {
    const planted = plantEveryCanary();
    try {
      const refused = planted.calls.filter((call) => !call.ok);
      expect(
        refused.map((call) => `${call.name}: ${call.error}`),
        'a canary that was never written would read as "does not cross"',
      ).toEqual([]);
      expect(planted.calls.length).toBeGreaterThanOrEqual(CANARIES.length / 2);

      // ...AND every canary is still in the store when the snapshot is taken
      // (Wave 5 correction round fifteen, High 4). "The facade accepted it" and
      // "it is there to be published" are different properties, and the census
      // shipped a `crosses: false` that rested on the first: the scenario
      // engaged the kill switch, released it on the next line, and then
      // measured. A canary the store no longer holds measures NOTHING about
      // the artifact, so it is a failure here rather than a quiet `false`.
      const missing = CANARIES.map((canary) => canary.field).filter(
        (field) => !planted.storedCanaries.has(canaryFor(field)),
      );
      expect(
        missing,
        'a canary that is not in the store at snapshot time cannot be read as "does not cross"',
      ).toEqual([]);
    } finally {
      planted.cleanup();
    }
  });

  it('crosses EXACTLY the fields the disclosure names, in both directions', () => {
    const planted = plantEveryCanary();
    try {
      const measured = CANARIES.filter(
        (canary) => pathsCarrying(planted.snapshot, canaryFor(canary.field)).length > 0,
      ).map((canary) => canary.field);
      const declared = CANARIES.filter((canary) => canary.crosses).map((canary) => canary.field);
      // Exact, not `toContain`: a field that starts publishing and a field that
      // stops both fail here, which is what "in either direction" means.
      expect(measured.sort()).toEqual(declared.sort());
      // And the measured totals, so the phase document's numbers are taken from
      // an execution rather than from a sentence.
      expect(CANARIES.length).toBe(36);
      expect(declared.length).toBe(23);
    } finally {
      planted.cleanup();
    }
  });

  it('lands each published field at the path the disclosure names', () => {
    const planted = plantEveryCanary();
    try {
      for (const canary of CANARIES) {
        const paths = pathsCarrying(planted.snapshot, canaryFor(canary.field));
        if (!canary.crosses) {
          expect(paths, `${canary.field} must not cross`).toEqual([]);
          continue;
        }
        expect(canary.at, `${canary.field} must name a measured path`).toBeTruthy();
        expect(paths, `${canary.field}`).toContain(canary.at);
      }
    } finally {
      planted.cleanup();
    }
  });

  /**
   * The completeness half. Every name a method's OWN `callerTextRefusal` list
   * declares is Founder-writable text by that method's own reckoning, so it
   * must either carry a canary here or be exempted with a reason. A parameter
   * added to one of these methods therefore fails this file on the day it is
   * added, rather than being published quietly beside the others.
   */
  it('plants a canary in every caller-text parameter the exercised methods declare', () => {
    const bodies = methodBodies();
    const planted = new Set(CANARIES.map((canary) => canary.field));
    const exercised = [...new Set(CANARIES.map((canary) => canary.field.split('.')[0]!))];
    expect(exercised.length).toBeGreaterThan(10);
    const unplanted: string[] = [];
    for (const method of exercised) {
      const body = bodies.get(method);
      expect(body, `${method} must exist on the facade`).toBeDefined();
      for (const parameter of declaredCallerText(body!)) {
        if ((NOT_PLANTED[method] ?? []).includes(parameter)) continue;
        if (!planted.has(`${method}.${parameter}`)) unplanted.push(`${method}.${parameter}`);
      }
    }
    expect(unplanted, 'a caller-text parameter reaches the artifact unmeasured').toEqual([]);
    // And the exemptions are real parameters, not stale names: each must still
    // be declared by its method, or the reason is describing something gone.
    for (const [method, parameters] of Object.entries(NOT_PLANTED)) {
      const declared = declaredCallerText(bodies.get(method) ?? '');
      for (const parameter of parameters) {
        expect(declared, `${method}.${parameter} is exempted but no longer declared`).toContain(
          parameter,
        );
      }
    }
  });

  it('the phase document says so, in the section a reader would look in', () => {
    // The disclosure is only worth having if it is written down where the
    // privacy claim is made, and it is only worth having ACCURATE if the
    // measurement is what is written. Both are checked.
    const text = fs.readFileSync(PHASE_13, 'utf8');
    expect(text).toContain('The unauthenticated artifact IS a Founder-text publication surface');
    expect(text).toContain('twenty-three fields, not four');
    expect(text).toContain('unauthenticated-founder-text.test.ts');
    for (const canary of CANARIES) {
      if (!canary.crosses) continue;
      expect(text, `${canary.field} is published and must be disclosed`).toContain(
        `\`${canary.field}\``,
      );
    }
  });
});
