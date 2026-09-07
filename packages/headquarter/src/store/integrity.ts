/**
 * Phase 13 — HQ store integrity, durability posture and the SAFE-MODE verdict.
 *
 * This module answers exactly one question, categorically: **can HQ still
 * stand behind its own stored truth?** It reads; it never repairs, never
 * migrates and never writes. Repair is a Founder decision made against a
 * verified backup, not something a boot path does on its own.
 *
 * Three deliberate boundaries, because each one is a place a reliability layer
 * usually starts lying:
 *
 * 1. **A finding is a closed vocabulary member, never free text.** Every
 *    finding carries a `detail` string for a human, but the FINDING itself —
 *    the thing a decision is taken on and the only thing that reaches an
 *    unauthenticated artifact — is one of six names.
 *
 * 2. **Blocking is a short, argued list.** Only three findings engage safe
 *    mode: the engine says the file is corrupt, an append-only guard that the
 *    schema declares is missing, or the evidence hash chain does not verify.
 *    Each means HQ's own record cannot be trusted. A referential-integrity
 *    violation and a degraded durability posture are REPORTED and do not
 *    engage safe mode — they are real defects, but neither says the standing
 *    record is false, and treating them as corruption would make safe mode a
 *    thing operators route around instead of a thing they act on.
 *
 * 3. **Cost is stated, not hidden.** `structuralIntegrity` is the cheap half
 *    (three `sqlite_master` reads and four pragmas) and is what a boot can
 *    afford on every construction. `fullIntegrity` adds `integrity_check`,
 *    `foreign_key_check` and a whole-log evidence-chain verification, which
 *    are O(database) and O(log), and it is therefore an explicit act. Which
 *    one produced a verdict is carried ON the verdict, so nobody can mistake a
 *    cheap pass for a full one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HqDatabase } from './db.js';
import { openHqDatabaseReadOnly } from './db.js';

/* ------------------------------------------------------------------ */
/* Durability requirements                                             */
/* ------------------------------------------------------------------ */

/**
 * What a FILE-backed HQ database is required to run under. WAL plus
 * `synchronous = FULL` is what `connectHqDatabaseUnmigrated` establishes and
 * what the hosted durable owner (`openHqPersistence` in `@factoryos/hq-host`)
 * verifies before it will let a schema write touch the volume.
 *
 * Stated as a requirement HERE too, so the posture can be reported by any
 * process holding a handle — including a local workstation run and the
 * read-only snapshot CLI, neither of which goes through the hosted owner.
 */
export const HQ_DURABILITY_REQUIREMENT = {
  journalMode: 'wal',
  /** SQLite's numeric `synchronous`: 2 is FULL. */
  synchronous: 2,
} as const;

/**
 * The pragma facts, read verbatim. `:memory:` databases legitimately report
 * `journal_mode = memory`, and `inMemory` carries that fact rather than
 * pretending WAL.
 *
 * `meetsRequirement` is TRUE for an in-memory handle, and that is a scoped
 * statement rather than a durability claim: `HQ_DURABILITY_REQUIREMENT` is a
 * requirement on a FILE-backed database, and there is nothing durable to
 * require of a database that has no file. The honest reading of the pair is
 * "`inMemory` true means durability is not applicable here", which is why
 * `inMemory` travels beside it on every authenticated view — and why the
 * unauthenticated snapshot's note says so in words, since that artifact
 * carries `durabilityMeetsRequirement` alone (Wave 5 review, Low finding 10).
 */
export interface HqDurabilityPosture {
  journalMode: string;
  synchronous: number;
  foreignKeys: boolean;
  walAutocheckpoint: number;
  readonly: boolean;
  /** True when this handle is an in-memory database, where durability is not applicable. */
  inMemory: boolean;
  /** True when a FILE-backed handle meets `HQ_DURABILITY_REQUIREMENT`. */
  meetsRequirement: boolean;
}

function pragmaNumber(db: HqDatabase, name: string): number {
  const value = db.pragma(name, { simple: true });
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function readDurabilityPosture(db: HqDatabase): HqDurabilityPosture {
  const journalMode = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
  const synchronous = pragmaNumber(db, 'synchronous');
  const foreignKeys = pragmaNumber(db, 'foreign_keys') === 1;
  const walAutocheckpoint = pragmaNumber(db, 'wal_autocheckpoint');
  // `journal_mode = memory` is what SQLite reports for a `:memory:` database;
  // it cannot be switched to WAL and there is nothing durable to require.
  const inMemory = journalMode === 'memory';
  return {
    journalMode,
    synchronous,
    foreignKeys,
    walAutocheckpoint,
    readonly: db.readonly,
    inMemory,
    meetsRequirement:
      inMemory ||
      (journalMode === HQ_DURABILITY_REQUIREMENT.journalMode &&
        synchronous === HQ_DURABILITY_REQUIREMENT.synchronous),
  };
}

/* ------------------------------------------------------------------ */
/* The engine-immutable tables                                         */
/* ------------------------------------------------------------------ */

/** One engine-guarded ledger, and every guard the schema declares on it. */
export interface EngineImmutableTable {
  table: string;
  triggerPrefix: string;
  /**
   * Guards BEYOND the universal trio, by suffix — the secondary-unique-index
   * guards and `hq_memory`'s supersede rule. Empty for a table that carries
   * only the trio.
   */
  secondaryGuards: readonly string[];
  /**
   * False for a table that is NOT append-only as a whole and therefore does
   * not carry `no_rewrite` / `no_erase` / `no_replace`, but whose own guards
   * the census must still see. `hq_mission_plan_items` is the one such table:
   * supersede and link legitimately UPDATE its columns, so demanding the trio
   * of it would be a false finding — but `trg_hq_mission_plan_items_no_replace`
   * is what stops an `INSERT OR REPLACE` re-pointing a plan item's task
   * binding, and a census blind to it is a census that cannot report the
   * tamper (Wave 5 review, Medium finding 6).
   *
   * Omitted means true.
   */
  holdsUniversalTrio?: boolean;
}

/**
 * Freeze a declaration ALL THE WAY DOWN — the array, every entry, and every
 * entry's guard list.
 *
 * A shallow `Object.freeze` would leave `entry.secondaryGuards.length = 0`
 * working, which is the same exploit one level in. Nothing here is a
 * convenience: these are the inputs an enforcement census reads.
 */
function deepFreezeTables(entries: EngineImmutableTable[]): readonly EngineImmutableTable[] {
  for (const entry of entries) {
    Object.freeze(entry.secondaryGuards);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

/**
 * Every ledger whose guards are held by the ENGINE, with the prefix its
 * triggers are named under and every guard declared on it.
 *
 * The trio required of each is the one that carries the guarantee: no UPDATE
 * of any column, no DELETE of any row, and a BEFORE INSERT guard that closes
 * REPLACE / UPSERT on the primary identity.
 *
 * **`secondaryGuards` was added by the Wave 5 review (Medium finding 2), and
 * the argument it replaces was wrong.** Until then this list carried the trio
 * only, on the reasoning that a table's further guards "are that module's
 * business" and that re-stating them here would drift. The consequence was
 * that the census could not SEE them: dropping
 * `trg_hq_intel_budgets_no_replace_unique` produced no
 * `append_only_guard_missing` finding, engaged no safe mode, and left an
 * `INSERT OR REPLACE` on `hq_intel_budgets.budget_key` free to swap a
 * Founder's spend ceiling — which the reviewer demonstrated, 1000 to
 * 999999999. A guard nothing checks is a guard that can go missing quietly,
 * and "it belongs to another module" is not a reason for the integrity check
 * to be blind to it. The drift concern is real and is answered where it
 * belongs: a test pins this whole declaration against the LIVE schema, so a
 * phase that adds a guard and forgets to declare it fails there rather than
 * escaping the check forever.
 *
 * `hq_mission_plan_items` was deliberately ABSENT until the Wave 5 review's
 * Medium finding 6, on the reasoning that it is legitimately updated when an
 * item is linked to a task and therefore cannot be held to the trio. The first
 * half of that is true and the conclusion was wrong: it carries three real
 * guards of its own, and while the table was unlisted the census could not see
 * them at all — dropping `trg_hq_mission_plan_items_no_replace` let an
 * `INSERT OR REPLACE` rewrite a plan item's task binding with no
 * `append_only_guard_missing` finding and no safe mode. It is listed now with
 * `holdsUniversalTrio: false`, so its own guards are checked and the trio is
 * not demanded of it.
 *
 * **Frozen at module scope**, entries and guard arrays included (Wave 5
 * review, High finding 2). This array is on the enforcement path of
 * `append_only_guard_missing`, and `store/index.ts` re-exports it as public
 * package API: `readonly` erases at runtime, so before the freeze a single
 * `ENGINE_IMMUTABLE_TABLES.length = 0` emptied the census and made a genuinely
 * tampered file report `safeMode: false` on a freshly constructed facade. That
 * is permanent architectural law 3 — a patchable convenience surface is never
 * execution authority — reached through an exported constant rather than
 * through a method. Under ESM (always strict) the assignment now THROWS.
 */
export const ENGINE_IMMUTABLE_TABLES: readonly EngineImmutableTable[] = deepFreezeTables([
  { table: 'hq_action_intents', triggerPrefix: 'hq_action_intents', secondaryGuards: ['no_replace_unique'] },
  { table: 'hq_action_events', triggerPrefix: 'hq_action_events', secondaryGuards: ['no_replace_unique'] },
  { table: 'hq_briefs', triggerPrefix: 'hq_briefs', secondaryGuards: [] },
  { table: 'hq_collab_sessions', triggerPrefix: 'hq_collab_sessions', secondaryGuards: [] },
  { table: 'hq_collab_participants', triggerPrefix: 'hq_collab_participants', secondaryGuards: [] },
  { table: 'hq_collab_contributions', triggerPrefix: 'hq_collab_contributions', secondaryGuards: [] },
  { table: 'hq_collab_relations', triggerPrefix: 'hq_collab_relations', secondaryGuards: [] },
  {
    table: 'hq_memory',
    triggerPrefix: 'hq_memory',
    // `supersede_only` is a guard, not a convenience: it is what holds the one
    // legal status move (CURRENT -> SUPERSEDED) for EVERY writer, and its
    // absence would let a raw connection move a superseded memory back.
    secondaryGuards: ['no_replace_idem', 'no_replace_rowid', 'supersede_only'],
  },
  { table: 'hq_mission_intents', triggerPrefix: 'hq_mission_intents', secondaryGuards: [] },
  { table: 'hq_mission_events', triggerPrefix: 'hq_mission_events', secondaryGuards: [] },
  { table: 'hq_orchestration_runs', triggerPrefix: 'hq_orch_runs', secondaryGuards: [] },
  { table: 'hq_orchestration_run_items', triggerPrefix: 'hq_orch_run_items', secondaryGuards: [] },
  { table: 'hq_project_events', triggerPrefix: 'hq_project_events', secondaryGuards: [] },
  { table: 'hq_truth_records', triggerPrefix: 'hq_truth_records', secondaryGuards: ['no_replace_unique'] },
  {
    table: 'hq_truth_verifications',
    triggerPrefix: 'hq_truth_verifications',
    secondaryGuards: ['no_replace_unique'],
  },
  {
    table: 'hq_truth_acceptances',
    triggerPrefix: 'hq_truth_acceptances',
    secondaryGuards: ['no_replace_unique'],
  },
  { table: 'hq_truth_relations', triggerPrefix: 'hq_truth_relations', secondaryGuards: [] },
  { table: 'hq_products', triggerPrefix: 'hq_products', secondaryGuards: ['no_replace_unique'] },
  { table: 'hq_product_events', triggerPrefix: 'hq_product_events', secondaryGuards: [] },
  {
    table: 'hq_product_artifacts',
    triggerPrefix: 'hq_product_artifacts',
    secondaryGuards: ['no_replace_unique', 'no_replace_version'],
  },
  {
    table: 'hq_reliability_runs',
    triggerPrefix: 'hq_reliability_runs',
    secondaryGuards: ['no_replace_unique'],
  },
  {
    table: 'hq_reliability_run_events',
    triggerPrefix: 'hq_reliability_run_events',
    // The attempt reservation. Without it two processes can both open the same
    // generation of the same run — the duplicate-irreversible-act path Phase 13
    // exists to close.
    secondaryGuards: ['no_replace_attempt'],
  },
  {
    table: 'hq_reliability_backups',
    triggerPrefix: 'hq_reliability_backups',
    secondaryGuards: ['no_replace_unique'],
  },
  // The verdict ledger (Wave 5 correction of High finding 1). It is what makes
  // the safe-mode latch survive a restart, so it is exactly the table a
  // tamperer would want to rewrite: the trio is the whole guarantee, and there
  // is no secondary identity to guard because every assessment appends a new
  // row.
  { table: 'hq_reliability_verdicts', triggerPrefix: 'hq_reliability_verdicts', secondaryGuards: [] },
  // Phase 14. All five carry the trio plus a secondary-unique guard, and the
  // secondary guard is load-bearing on two of them: a REPLACE colliding on
  // `hq_intel_budgets.budget_key` would silently swap a Founder's spending
  // ceiling for a looser one, and one on `hq_intel_cost_entries.entry_key`
  // would erase a recorded amount and free the same one to be recorded again —
  // which is how a spend total quietly shrinks.
  {
    table: 'hq_intel_model_observations',
    triggerPrefix: 'hq_intel_obs',
    secondaryGuards: ['no_replace_unique'],
  },
  { table: 'hq_intel_budgets', triggerPrefix: 'hq_intel_budgets', secondaryGuards: ['no_replace_unique'] },
  {
    table: 'hq_intel_decisions',
    triggerPrefix: 'hq_intel_decisions',
    secondaryGuards: ['no_replace_unique'],
  },
  {
    table: 'hq_intel_decision_outcomes',
    triggerPrefix: 'hq_intel_outcomes',
    secondaryGuards: ['no_replace_unique'],
  },
  { table: 'hq_intel_cost_entries', triggerPrefix: 'hq_intel_costs', secondaryGuards: ['no_replace_unique'] },
  // NOT append-only as a table, and therefore not held to the trio — but its
  // three own guards are real, and the census was blind to them. See the note
  // above and `holdsUniversalTrio`.
  {
    table: 'hq_mission_plan_items',
    triggerPrefix: 'hq_mission_plan_items',
    holdsUniversalTrio: false,
    secondaryGuards: ['no_replace', 'no_relink', 'no_respec'],
  },
]);

/**
 * The three guards EVERY engine-immutable table must carry, by suffix.
 *
 * Universal, and therefore still the trio. A table's further guards are
 * declared per table in `ENGINE_IMMUTABLE_TABLES.secondaryGuards`, because
 * requiring `no_replace_unique` of a table that has no secondary unique index
 * would be a false finding — the same reason `hq_mission_plan_items` is not
 * held to the trio.
 */
export const REQUIRED_IMMUTABILITY_GUARDS = Object.freeze([
  'no_rewrite',
  'no_erase',
  'no_replace',
] as const);

/**
 * Every guard name the schema declares on one listed table. Trio plus its own,
 * or — for an entry with `holdsUniversalTrio: false` — its own alone.
 */
export function declaredGuardsFor(entry: EngineImmutableTable): string[] {
  const suffixes =
    entry.holdsUniversalTrio === false
      ? [...entry.secondaryGuards]
      : [...REQUIRED_IMMUTABILITY_GUARDS, ...entry.secondaryGuards];
  return suffixes.map((guard) => `trg_${entry.triggerPrefix}_${guard}`);
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The CLOSED finding vocabulary. Six names, and nothing else may be reported —
 * a finding is what a safe-mode decision is taken on and what a count in the
 * unauthenticated artifact is keyed by, so it can never be a stored string.
 */
export const HQ_INTEGRITY_FINDINGS = Object.freeze([
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
  'foreign_key_violations',
  'durability_below_requirement',
  'reliability_schema_absent',
] as const);
export type HqIntegrityFinding = (typeof HQ_INTEGRITY_FINDINGS)[number];

export function isHqIntegrityFinding(value: unknown): value is HqIntegrityFinding {
  return typeof value === 'string' && (HQ_INTEGRITY_FINDINGS as readonly string[]).includes(value);
}

/**
 * The three findings that mean HQ's own record cannot be trusted, and are
 * therefore the ONLY ones that engage safe mode. Argued in the module header;
 * pinned by a test so widening or narrowing it is a deliberate, reviewed act.
 */
export const SAFE_MODE_BLOCKING_FINDINGS: readonly HqIntegrityFinding[] = Object.freeze([
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
] as const);

export function findingIsBlocking(finding: HqIntegrityFinding): boolean {
  return SAFE_MODE_BLOCKING_FINDINGS.includes(finding);
}

export interface HqIntegrityObservation {
  finding: HqIntegrityFinding;
  blocking: boolean;
  /**
   * A human-readable detail. Composed from schema object names, pragma values,
   * counts and — for the two engine checks — a BOUNDED slice of the engine's
   * own verdict text (`PRAGMA integrity_check`'s message, or the message of the
   * error that stopped it running). Never from a row's stored content, which is
   * the property that matters: an observation cannot become a channel for
   * record text. The engine's own text is not record content and is truncated
   * to 400 characters; only `observation.finding` — a closed-vocabulary name —
   * reaches the unauthenticated artifact, and the Founder route passes the
   * detail through the browser-safety scan (Wave 5 review, Low finding C-3,
   * which corrected this comment's earlier "never from engine output" claim).
   */
  detail: string;
}

/** How thorough the assessment behind a verdict was. Carried, never inferred. */
export const INTEGRITY_ASSESSMENT_DEPTHS = Object.freeze(['structural', 'full'] as const);
export type IntegrityAssessmentDepth = (typeof INTEGRITY_ASSESSMENT_DEPTHS)[number];

export interface HqIntegrityReport {
  depth: IntegrityAssessmentDepth;
  observations: HqIntegrityObservation[];
  /** True when at least one blocking observation stands. */
  safeMode: boolean;
  /**
   * Did a whole-log evidence-chain verification actually RUN and pass in this
   * assessment?
   *
   * Carried rather than inferred from `depth`, because the absence of the
   * verification used to be indistinguishable from a pass: `fullIntegrity`
   * took the verifier as an optional argument, and a call that omitted it
   * returned `depth: 'full'` with no `evidence_chain_broken` finding (Wave 5
   * review, Medium finding 5). It is false on every structural assessment,
   * because a structural assessment does not run the check — false means "not
   * verified here", never "verified and broken".
   */
  chainVerified: boolean;
  durability: HqDurabilityPosture;
}

/**
 * A verdict HQ previously RECORDED about itself, read back at construction.
 *
 * This is what makes the safe-mode latch survive a restart. See
 * `SAFE_MODE_STATEMENT` and `structuralIntegrity`'s `recordedVerdict` option.
 */
export interface RecordedIntegrityVerdict {
  assessedAt: string;
  depth: IntegrityAssessmentDepth;
  safeMode: boolean;
  findings: readonly HqIntegrityFinding[];
}

export const SAFE_MODE_STATEMENT =
  'Safe mode is a statement about HQ’s OWN stored record, not about the outside world. It engages only when ' +
  'the engine reports the file corrupt, an append-only guard the schema declares is missing, or the evidence ' +
  'hash chain does not verify. While engaged HQ still READS and still reconciles, and it refuses the acts ' +
  'that would add to, approve, release or execute against a record it cannot stand behind. A blocking ' +
  'verdict is APPENDED to HQ’s own verdict ledger and re-read at every construction, so a restart does not ' +
  'clear it — only a fresh full assessment that finds nothing blocking does. On a database that carries no ' +
  'Phase 13 ledger there is nowhere to record it and the verdict is process-local; the ' +
  'reliability_schema_absent finding says when that is the case.';

export const INTEGRITY_DEPTH_STATEMENT =
  'A structural assessment reads the schema catalogue and the durability pragmas only — cheap enough to run ' +
  'at every construction. A full assessment additionally runs PRAGMA integrity_check, PRAGMA ' +
  'foreign_key_check and a whole-log evidence-chain verification, which are proportional to the database and ' +
  'to the log and are therefore an explicit act. A structural pass is never reported as a full one.';

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

function tableNames(db: HqDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function triggerNames(db: HqDatabase): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Every append-only guard that the schema DECLARES and the file does not have.
 *
 * Only tables that are actually PRESENT are checked. A pre-Phase-N file that
 * never had `hq_products` is not missing a guard on it — that is absence, not
 * tampering, and conflating the two would engage safe mode on every older
 * database HQ has ever been pointed at.
 *
 * Since the Wave 5 review this covers the SECONDARY guards too — the
 * unique-index guards and `hq_memory`'s supersede rule — because a census that
 * matched `_no_rewrite`-style suffixes only could not report a dropped
 * `trg_hq_intel_budgets_no_replace_unique`, and that guard is the whole reason
 * an `INSERT OR REPLACE` cannot swap a Founder's spend ceiling.
 */
export function missingImmutabilityGuards(db: HqDatabase): string[] {
  const tables = tableNames(db);
  const triggers = triggerNames(db);
  const missing: string[] = [];
  for (const entry of ENGINE_IMMUTABLE_TABLES) {
    if (!tables.has(entry.table)) continue;
    for (const name of declaredGuardsFor(entry)) {
      if (!triggers.has(name)) missing.push(name);
    }
  }
  return missing.sort();
}

/**
 * The CHEAP assessment: the schema catalogue and the durability pragmas.
 *
 * Runs no table scan, so it is affordable on every construction of the
 * facade. It can detect the one tamper that matters most — an append-only
 * guard removed from a ledger that still exists — because a dropped trigger is
 * a `sqlite_master` fact, not a data fact.
 */
export function structuralIntegrity(
  db: HqDatabase,
  options: {
    reliabilitySchemaPresent?: boolean;
    /**
     * The missing-guard list AS THE FILE WAS FOUND, observed before this
     * process re-ensured any schema.
     *
     * This matters because the ensure functions are `CREATE TRIGGER IF NOT
     * EXISTS` and therefore RESTORE a dropped guard on every construction. A
     * check run after them would find a healthy file and report one — HQ would
     * silently repair the tamper and then say nothing about it. So the
     * observation is taken first and passed in here, and safe mode engages on
     * what was found rather than on what was subsequently repaired: HQ can
     * re-create the guards it declares, but it cannot know what was done to
     * the file while they were absent.
     */
    guardsMissingAsFound?: readonly string[];
    /**
     * The last verdict HQ RECORDED about this database, read back from the
     * append-only verdict ledger before this assessment ran.
     *
     * A structural pass cannot detect a broken evidence chain and cannot see a
     * guard a previous boot has since re-created, so without this a plain
     * restart cleared a blocking verdict — every finding in it, including
     * `evidence_chain_broken`, simply went away, and the acts safe mode exists
     * to refuse were handed back out (Wave 5 review, High finding 1). Each
     * blocking finding it carries is re-raised as an observation here, so the
     * latch is a property of the RECORD rather than of one process's memory.
     * Only a fresh full assessment that finds nothing blocking records a
     * clean verdict and therefore clears it.
     */
    recordedVerdict?: RecordedIntegrityVerdict | null;
  } = {},
): HqIntegrityReport {
  const observations: HqIntegrityObservation[] = [];
  const durability = readDurabilityPosture(db);

  const missing = options.guardsMissingAsFound
    ? [...options.guardsMissingAsFound]
    : missingImmutabilityGuards(db);
  if (missing.length > 0) {
    observations.push({
      finding: 'append_only_guard_missing',
      blocking: true,
      detail:
        `${missing.length} append-only guard(s) declared by the schema were absent from this file: ` +
        `${missing.join(', ')}. HQ re-creates the guards it declares on every boot, so they may stand again ` +
        `now — but it cannot know what was written while they were gone, so the finding stands until a full ` +
        `assessment says otherwise.`,
    });
  }

  if (!durability.meetsRequirement) {
    observations.push({
      finding: 'durability_below_requirement',
      blocking: false,
      detail:
        `journal_mode=${durability.journalMode}, synchronous=${durability.synchronous}; ` +
        `a file-backed HQ database is required to run WAL + FULL. Reported, not blocking: a degraded ` +
        `durability posture risks the NEXT crash, it does not make the standing record false.`,
    });
  }

  if (options.reliabilitySchemaPresent === false) {
    observations.push({
      finding: 'reliability_schema_absent',
      blocking: false,
      detail:
        'This database carries no Phase 13 run ledger. Observed, never migrated: a read-only handle over an ' +
        'older file reports the absence instead of inventing an empty ledger.',
    });
  }

  carryRecordedVerdict(observations, options.recordedVerdict ?? null);

  return {
    depth: 'structural',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    // A structural pass never runs the whole-log verification. False here means
    // "not verified in this assessment", never "verified and broken".
    chainVerified: false,
    durability,
  };
}

/**
 * Re-raise every BLOCKING finding a previously recorded verdict still holds.
 *
 * Non-blocking findings are deliberately NOT carried: they are observations
 * about the file as it stood then, and re-reporting a stale
 * `durability_below_requirement` or `foreign_key_violations` would be HQ
 * asserting something it has not just checked. A blocking finding is different
 * in kind — it is the standing statement that HQ cannot vouch for its own
 * record, and it stands until an assessment says otherwise.
 */
function carryRecordedVerdict(
  observations: HqIntegrityObservation[],
  recorded: RecordedIntegrityVerdict | null,
): void {
  if (!recorded || !recorded.safeMode) return;
  const alreadyObserved = new Set(observations.map((observation) => observation.finding));
  for (const finding of recorded.findings) {
    if (!isHqIntegrityFinding(finding)) continue;
    if (!findingIsBlocking(finding)) continue;
    if (alreadyObserved.has(finding)) continue;
    alreadyObserved.add(finding);
    observations.push({
      finding,
      blocking: true,
      detail:
        `Carried from the verdict HQ recorded at ${recorded.assessedAt} (depth ${recorded.depth}). ` +
        `Safe mode is not cleared by a boot: this finding stands until a full assessment of the file as ` +
        `it now stands finds nothing blocking.`,
    });
  }
}

/**
 * The FULL assessment. Everything structural, plus the three checks whose cost
 * is proportional to the data: the engine's own corruption check, referential
 * integrity, and a whole-log verification of the hash-chained evidence.
 *
 * `verifyEvidenceChain` is injected rather than imported so this module stays a
 * leaf of `store/` and cannot acquire a dependency on `operator/`. It is
 * REQUIRED, and a call that omits it anyway does not read clean: the chain is
 * treated as unverifiable, which is a blocking `evidence_chain_broken`.
 *
 * It was optional until the Wave 5 review's Medium finding 5, and the absence
 * of the verifier was then indistinguishable from a pass — `fullIntegrity(db,
 * {})` returned `depth: 'full'` with no findings over a genuinely broken chain.
 * That is the same defect class as the High this wave already corrected: a
 * missing enforcement input silently reading clean. This module is public
 * package API (`store/index.ts`), so the type alone was not enough.
 *
 * The caller must NOT pass `EvidenceLog.verifyChain` or any other delegate
 * reachable from a public surface. `HeadquarterOperations` passes
 * `#verifyEvidenceChainFromStore`, a `#private` closure over its own handle;
 * `evidence_chain_broken` engages safe mode, so the read behind it is
 * enforcement and may not travel through a patchable convenience object. The
 * function returns the `seq` of the first entry that does not verify, or null
 * when the whole chain does.
 */
export function fullIntegrity(
  db: HqDatabase,
  options: {
    verifyEvidenceChain: () => number | null;
    reliabilitySchemaPresent?: boolean;
    /** See `structuralIntegrity`. Omitted here means "check the file as it stands now". */
    guardsMissingAsFound?: readonly string[];
  },
): HqIntegrityReport {
  // Deliberately WITHOUT a recorded verdict: a full assessment of the file as
  // it now stands is the one thing that SUPERSEDES the record, which is how a
  // latched safe mode is ever cleared. Carrying the old verdict in here would
  // make it unclearable; carrying it in `structuralIntegrity` is what makes a
  // restart unable to clear it.
  const structural = structuralIntegrity(db, {
    reliabilitySchemaPresent: options.reliabilitySchemaPresent,
    guardsMissingAsFound: options.guardsMissingAsFound,
  });
  const observations = [...structural.observations];

  let integrityVerdict: string;
  try {
    const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
    const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter((value) => value !== '');
    integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
  } catch (error) {
    integrityVerdict = `integrity_check could not run: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  if (integrityVerdict !== 'ok') {
    observations.push({
      finding: 'database_integrity_check_failed',
      blocking: true,
      detail: `PRAGMA integrity_check did not return ok: ${integrityVerdict.slice(0, 400)}`,
    });
  }

  try {
    const violations = db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
    if (violations.length > 0) {
      observations.push({
        finding: 'foreign_key_violations',
        blocking: false,
        detail:
          `PRAGMA foreign_key_check reported ${violations.length} violation(s). Reported, not blocking: a ` +
          `dangling reference is a defect in a relationship, not evidence that a recorded fact is false.`,
      });
    }
  } catch {
    // A handle that cannot run foreign_key_check reports nothing rather than a
    // finding it did not make: an absent check is not a passed one, and it is
    // not a failure either. The depth on the verdict already says what ran.
  }

  // A missing verifier is treated exactly like one that threw. An absent
  // BLOCKING check is not a passed one, and this is public API a JS caller can
  // reach with no arguments at all.
  let brokenAt: number | null | 'error' =
    typeof options.verifyEvidenceChain === 'function' ? null : 'error';
  if (brokenAt !== 'error') {
    try {
      brokenAt = options.verifyEvidenceChain();
    } catch {
      brokenAt = 'error';
    }
  }
  if (brokenAt === 'error') {
    observations.push({
      finding: 'evidence_chain_broken',
      blocking: true,
      detail: 'The hash-chained evidence log could not be verified at all; HQ treats an unverifiable chain as a broken one.',
    });
  } else if (brokenAt !== null) {
    observations.push({
      finding: 'evidence_chain_broken',
      blocking: true,
      detail: `The hash-chained evidence log does not verify from entry seq ${brokenAt} onward.`,
    });
  }

  return {
    depth: 'full',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    chainVerified: brokenAt === null,
    durability: structural.durability,
  };
}

/* ------------------------------------------------------------------ */
/* Backup file verification                                            */
/* ------------------------------------------------------------------ */

/**
 * Why a candidate backup file was refused. Closed, categorical.
 *
 * Four members were added by the Wave 5 review (High finding 3, Low finding
 * 12), and each names a distinct real refusal rather than being folded into
 * `path_not_a_regular_file`, which every `openSync` failure used to collapse
 * into regardless of cause:
 *
 *  - `path_not_normalized` — the absolute path still contains `.` or `..`
 *    segments, so what it names depends on resolution rather than on the text;
 *  - `path_not_readable` — the file exists and is a regular file, but this
 *    process may not open it (EACCES/EPERM/EMFILE). "Not permitted to read"
 *    is a different fact from "not a file";
 *  - `sidecar_journal_present` — a `-wal`, `-shm` or `-journal` sidecar sits
 *    beside the candidate. SQLite resolves those together with the main file,
 *    so the main file alone may not be the whole database, and an operator who
 *    restored the directory would get content this verification never saw. The
 *    live HQ database is WAL-mode and is therefore refused here, which is the
 *    honest answer for it;
 *  - `verification_copy_failed` — HQ could not take the scratch copy it checks
 *    (see `verifyHqBackupFile`). A verification that could not be performed is
 *    reported as such, never as a pass.
 */
export const BACKUP_REFUSAL_REASONS = Object.freeze([
  'path_not_absolute',
  'path_not_normalized',
  'path_missing',
  'path_is_symlink',
  'path_not_a_regular_file',
  'path_not_readable',
  'file_empty',
  'file_too_large',
  'sidecar_journal_present',
  'verification_copy_failed',
  'not_a_readable_sqlite_database',
  'integrity_check_failed',
  'not_an_hq_database',
] as const);
export type BackupRefusalReason = (typeof BACKUP_REFUSAL_REASONS)[number];

/**
 * The largest file this verification will hash and open. A REAL bound on the
 * read, not only on the `lstat`: `digestFile` stops and reports
 * `file_too_large` when the bytes it has read exceed it, so a file that grows
 * between the stat and the read cannot become an unbounded read (Wave 5
 * review, Low finding 12). The sidecar refusal bounds the other half — SQLite's
 * own read of a `-wal` was previously unbounded by anything at all.
 */
export const MAX_VERIFIED_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

/** The journal sidecars SQLite resolves together with a database path. */
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['-wal', '-shm', '-journal'] as const);

/**
 * The table every HQ database has carried since the foundation wave. Its
 * presence is what makes a valid SQLite file an HQ database rather than some
 * other database that happens to open.
 */
const HQ_MARKER_TABLE = 'hq_events';

export interface BackupVerification {
  verified: boolean;
  refusals: BackupRefusalReason[];
  /** sha256 over the file's bytes. Present only when the bytes were read. */
  digest: string | null;
  sizeBytes: number | null;
  /** How many non-internal tables the opened database carries. */
  schemaTables: number | null;
  integrityVerdict: string | null;
}

const VERIFY_CHUNK_BYTES = 1024 * 1024;

/**
 * Hash the descriptor's bytes and write the SAME bytes to `sinkFd` as it goes.
 *
 * One pass, so the digest and the copy cannot disagree: what the database
 * checks then open is, byte for byte, what this digest is of.
 */
function digestFile(
  fd: number,
  limitBytes: number,
  sinkFd: number,
): { digest: string; size: number } | 'too_large' {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    const chunk = buffer.subarray(0, read);
    hash.update(chunk);
    fs.writeSync(sinkFd, chunk, 0, read, position);
    position += read;
    // The bound applies to what is actually READ, not only to what the
    // pre-open `lstat` reported.
    if (position > limitBytes) return 'too_large';
  }
  return { digest: hash.digest('hex'), size: position };
}

/**
 * Verify that a path holds a readable, uncorrupted HQ database — the check a
 * restore is worth nothing without.
 *
 * **The digest and the checks are pinned to the SAME bytes.** They were not,
 * and the gap was exploitable (Wave 5 review, High finding 3): `digestFile`
 * hashed the main file through a descriptor while `integrity_check`, the schema
 * census and the `hq_events` marker were evaluated by a SECOND open of the
 * PATH — and SQLite resolves a path together with its `-wal`/`-shm` sidecars.
 * A plain `cp` of a live WAL-mode HQ database therefore verified as `true`,
 * with 45 tables read out of a `-wal` the digest never covered, a `sizeBytes`
 * counting the main file only, and the pristine file's digest recorded
 * permanently in an append-only register. The same block was TOCTOU besides:
 * `lstat` -> `openSync(O_NOFOLLOW)` -> open-by-path, where the third step
 * re-resolved the path WITHOUT `O_NOFOLLOW`, making `path_is_symlink` advisory
 * for exactly the half that decided `verified`.
 *
 * Both are closed the same way: after the `O_NOFOLLOW` open, this function
 * never touches the candidate path again. The descriptor's bytes are hashed and
 * copied to a SCRATCH file in one pass, and the database checks run against the
 * scratch copy. So what `integrity_check` read, what `schemaTables` counted and
 * what `digest` is of are the same bytes by construction rather than by
 * argument; no sidecar of the candidate is read; and nothing that happens to
 * the path between the steps can change the answer.
 *
 * READ-ONLY with respect to the CANDIDATE, in the strongest available sense:
 * it is opened `O_RDONLY | O_NOFOLLOW` and never written, and no `-wal`/`-shm`
 * is created beside it — which the previous version did create, by opening it
 * with SQLite. The scratch copy is HQ's own space under the OS temp directory
 * and is removed before this function returns. Nothing migrates, checkpoints
 * or repairs anything.
 *
 * A sidecar beside the candidate is still a categorical REFUSAL rather than
 * something to check around, because the main file alone may then not be the
 * whole database and an operator restoring the directory would get content this
 * verification never saw. Pointing this at the LIVE HQ database is therefore
 * refused — a live HQ database is WAL-mode — which is a more honest answer than
 * the "safe as well as useless" pass it used to give.
 *
 * Path protections are refusals, not exceptions, so a caller gets a
 * categorical reason it can record — see `BACKUP_REFUSAL_REASONS` for the
 * closed list and what each member means.
 *
 * NOT covered, and recorded rather than implied: a path whose PARENT
 * directories are symlinks is accepted. `O_NOFOLLOW` constrains the final
 * component only, and resolving the whole path with `realpath` would refuse
 * legitimate layouts (a symlinked backup volume, `/var` on macOS). WHICH file
 * an operator is entitled to point at is a question this function does not
 * answer; what it answers is what the bytes at the descriptor it opened
 * actually are.
 */
export function verifyHqBackupFile(candidate: string): BackupVerification {
  const empty: BackupVerification = {
    verified: false,
    refusals: [],
    digest: null,
    sizeBytes: null,
    schemaTables: null,
    integrityVerdict: null,
  };
  const target = typeof candidate === 'string' ? candidate.trim() : '';
  if (!target || !path.isAbsolute(target)) {
    return { ...empty, refusals: ['path_not_absolute'] };
  }
  // An absolute path carrying `.` or `..` names a file only after resolution.
  // Refused as its own category rather than normalized on the caller's behalf:
  // the recorded path must be the path that was checked.
  if (path.normalize(target) !== target) {
    return { ...empty, refusals: ['path_not_normalized'] };
  }

  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(target);
  } catch {
    return { ...empty, refusals: ['path_missing'] };
  }
  if (entry.isSymbolicLink()) return { ...empty, refusals: ['path_is_symlink'] };
  if (!entry.isFile()) return { ...empty, refusals: ['path_not_a_regular_file'] };
  if (entry.size === 0) return { ...empty, refusals: ['file_empty'] };
  if (entry.size > MAX_VERIFIED_BACKUP_BYTES) return { ...empty, refusals: ['file_too_large'] };

  // BEFORE anything else. SQLite would resolve these together with the main
  // file, so their presence means the main file alone may not be the database
  // an operator would restore.
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      fs.lstatSync(`${target}${suffix}`);
      return { ...empty, refusals: ['sidecar_journal_present'] };
    } catch {
      // Absent is the expected case for a consolidated backup file.
    }
  }

  let scratchDir: string;
  try {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-backup-verify-'));
  } catch {
    return { ...empty, refusals: ['verification_copy_failed'] };
  }
  const scratchPath = path.join(scratchDir, 'candidate.sqlite');

  try {
    let digest: string;
    let sizeBytes: number;
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    let fd: number | undefined;
    let sinkFd: number | undefined;
    try {
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
      } catch (error) {
        // One `openSync` failure is not one refusal. ELOOP is the final
        // component turning out to be a symlink after all (the O_NOFOLLOW
        // race), and EACCES/EPERM/EMFILE are "this process may not read it",
        // which is a different fact from "it is not a file" (Wave 5 review,
        // Low finding 12).
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ELOOP') return { ...empty, refusals: ['path_is_symlink'] };
        if (code === 'ENOENT') return { ...empty, refusals: ['path_missing'] };
        if (code === 'EACCES' || code === 'EPERM' || code === 'EMFILE' || code === 'ENFILE') {
          return { ...empty, refusals: ['path_not_readable'] };
        }
        return { ...empty, refusals: ['path_not_a_regular_file'] };
      }
      // Taken from the DESCRIPTOR: from here on the path is never consulted.
      if (!fs.fstatSync(fd).isFile()) return { ...empty, refusals: ['path_not_a_regular_file'] };
      try {
        sinkFd = fs.openSync(scratchPath, 'wx', 0o600);
      } catch {
        return { ...empty, refusals: ['verification_copy_failed'] };
      }
      let proof: { digest: string; size: number } | 'too_large';
      try {
        proof = digestFile(fd, MAX_VERIFIED_BACKUP_BYTES, sinkFd);
      } catch {
        // A read or write that could not complete is a verification that did
        // not happen. Never a pass.
        return { ...empty, refusals: ['verification_copy_failed'] };
      }
      if (proof === 'too_large') return { ...empty, refusals: ['file_too_large'] };
      digest = proof.digest;
      sizeBytes = proof.size;
    } finally {
      for (const handle of [fd, sinkFd]) {
        if (handle == null) continue;
        try {
          fs.closeSync(handle);
        } catch {
          // The digest, or the refusal, is the result; a close failure is not.
        }
      }
    }

    let db: HqDatabase;
    try {
      db = openHqDatabaseReadOnly(scratchPath);
    } catch {
      return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes };
    }
    try {
      // Readability FIRST, and as a real query rather than as an assumption:
      // better-sqlite3 opens lazily, so a file of poetry becomes an error at the
      // first statement rather than at `new Database`. Distinguishing "not a
      // database at all" from "a database that fails its integrity check" is the
      // difference between a wrong path and a lost backup, so the two refusals
      // stay separate.
      let tables: Set<string>;
      try {
        tables = tableNames(db);
      } catch {
        return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes };
      }

      let integrityVerdict: string;
      try {
        const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
        const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter((value) => value !== '');
        integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
      } catch (error) {
        // A check that could not run is not a check that passed.
        integrityVerdict = `integrity_check could not run: ${error instanceof Error ? error.message : 'unknown error'}`;
      }
      const refusals: BackupRefusalReason[] = [];
      if (integrityVerdict !== 'ok') refusals.push('integrity_check_failed');
      if (!tables.has(HQ_MARKER_TABLE)) refusals.push('not_an_hq_database');
      return {
        verified: refusals.length === 0,
        refusals,
        digest,
        sizeBytes,
        schemaTables: tables.size,
        integrityVerdict: integrityVerdict.slice(0, 400),
      };
    } finally {
      try {
        db.close();
      } catch {
        // Never trade the verification result for a close failure.
      }
    }
  } finally {
    // The scratch copy is HQ's own; it never outlives the verification.
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // A temp-directory cleanup failure is not a verification result.
    }
  }
}
