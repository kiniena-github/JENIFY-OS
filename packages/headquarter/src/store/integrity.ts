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
 * `journal_mode = memory` and are flagged as such rather than pretended over —
 * an in-memory database is not durable and HQ says so instead of claiming WAL.
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

/** One engine-immutable ledger, and every guard the schema declares on it. */
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
   * The BASE guards required of this table, when the universal trio is not the
   * right requirement for it.
   *
   * Exactly one table uses it, and only because the alternative was worse.
   * `hq_mission_plan_items` legitimately UPDATEs its own columns — linking a
   * task, superseding an item, stating a work spec — so a blanket `no_rewrite`
   * would break the real writers. Until Wave 5 Medium 3 that was taken as a
   * reason to leave the table out of this list entirely, which made the census
   * blind to the guards it DOES have and to the one it was missing. A reduced,
   * declared base is the honest middle: the census checks exactly the guards
   * the schema really declares, and drift is caught by the same live-schema
   * test that binds every other entry.
   */
  requiredGuards?: readonly string[];
}

/**
 * Every append-only ledger whose immutability is held by the ENGINE, with the
 * prefix its triggers are named under and every guard declared on it.
 *
 * The trio required of each is the one that carries the primary guarantee: no
 * UPDATE of any column, no DELETE of any row, and a BEFORE INSERT guard that
 * closes REPLACE / UPSERT on the primary identity.
 *
 * **`secondaryGuards` was added by the Wave 5 correction (both review lanes
 * reached this finding independently), and the argument it replaces was
 * wrong.** Until then this list carried the trio only, on the reasoning that a
 * table's further guards "are that module's business" and that re-stating them
 * here would drift. That reasoning was wrong in the one direction that matters:
 * the secondary guards are the ones that close REPLACE on a SECONDARY unique
 * index, where the primary-identity guard never fires. `recursive_triggers` is
 * off by default and connection-scoped, so an `INSERT OR REPLACE` colliding on
 * such an index DELETES the standing row without any BEFORE DELETE running.
 *
 * The consequence was that the census could not SEE those guards. Dropping
 * `trg_hq_intel_budgets_no_replace_unique` produced no
 * `append_only_guard_missing` finding, engaged no safe mode at either depth,
 * and left an `INSERT OR REPLACE` on `hq_intel_budgets.budget_key` free to swap
 * a Founder's spend ceiling — demonstrated, 1000 to 999999999. The same held
 * for `trg_hq_reliability_run_events_no_replace_attempt`, the cross-process
 * duplicate-attempt guard this module itself calls load-bearing: a committed
 * append-only row could be erased and a forged one substituted, with no
 * finding. A guard nothing checks is a guard that can go missing quietly, and
 * "it belongs to another module" is not a reason for the integrity check to be
 * blind to it.
 *
 * The drift concern is real and is answered where it belongs: tests pin this
 * whole declaration against the LIVE schema — the FULL trigger-name set for
 * every listed prefix — so a phase that adds a guard and forgets to declare it
 * fails there rather than escaping the check forever.
 *
 * `hq_mission_plan_items` used to be deliberately ABSENT, on the reasoning
 * that it is legitimately UPDATEd (linking a task, superseding an item,
 * stating a work spec) and that demanding the trio of it would be a false
 * finding. The premise was right and the conclusion was wrong (Wave 5 Medium
 * 3). Being outside this list did not merely excuse it from `no_rewrite` — it
 * made the census blind to the table entirely, including to the fact that it
 * carried no `no_erase` guard at all. That mattered because
 * `hq_mission_plan_items.task_id` is the ONLY link from a task to its mission,
 * and Phase 14 derives a task's budget scope through it: the older readers
 * check that a row EXISTS and so fail closed on a delete, but the budget
 * derivation reads absence as "belongs to no mission" and fails OPEN. One
 * DELETE unbound a task from an exhausted mission ceiling — `blocked` became
 * `within_ceiling` with the full tier set — and the census reported nothing.
 * The table now carries `no_erase` and is listed with a REDUCED base
 * (`requiredGuards`), so what is checked is exactly what the schema declares.
 */
export const ENGINE_IMMUTABLE_TABLES: readonly EngineImmutableTable[] = [
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
  {
    table: 'hq_mission_plan_items',
    triggerPrefix: 'hq_mission_plan_items',
    // NO `no_rewrite`: the link, supersede and work-spec writers legitimately
    // UPDATE their own columns, and each of those columns is write-once by its
    // own guard below. `no_erase` IS required — see the header.
    requiredGuards: ['no_erase', 'no_replace'],
    secondaryGuards: ['no_relink', 'no_respec'],
  },
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
    // `run_key` is the duplicate-RUN guard.
    secondaryGuards: ['no_replace_unique'],
  },
  {
    table: 'hq_reliability_run_events',
    triggerPrefix: 'hq_reliability_run_events',
    // `attempt_key` is the cross-process duplicate-ATTEMPT guard — the single
    // most load-bearing secondary guard in the schema. Without it two
    // processes can both open the same generation of the same run — the
    // duplicate-irreversible-act path Phase 13 exists to close.
    secondaryGuards: ['no_replace_attempt'],
  },
  {
    table: 'hq_reliability_backups',
    triggerPrefix: 'hq_reliability_backups',
    // `record_key` is the duplicate-BACKUP-RECORD guard.
    secondaryGuards: ['no_replace_unique'],
  },
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
];

/**
 * The three guards every engine-immutable table must carry, by suffix — the
 * DEFAULT base, and the base for every entry but one.
 *
 * A table's further guards are declared per table in
 * `ENGINE_IMMUTABLE_TABLES.secondaryGuards`, because requiring
 * `no_replace_unique` of a table that has no secondary unique index would be a
 * false finding. A table whose columns are legitimately updated declares a
 * reduced base in `requiredGuards` for the same reason —
 * `hq_mission_plan_items`, and only it.
 */
export const REQUIRED_IMMUTABILITY_GUARDS = ['no_rewrite', 'no_erase', 'no_replace'] as const;

/** Every guard name the schema declares on one listed table. Base plus its own. */
export function declaredGuardsFor(entry: EngineImmutableTable): string[] {
  return [...(entry.requiredGuards ?? REQUIRED_IMMUTABILITY_GUARDS), ...entry.secondaryGuards].map(
    (guard) => `trg_${entry.triggerPrefix}_${guard}`,
  );
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The CLOSED finding vocabulary. Six names, and nothing else may be reported —
 * a finding is what a safe-mode decision is taken on and what a count in the
 * unauthenticated artifact is keyed by, so it can never be a stored string.
 */
export const HQ_INTEGRITY_FINDINGS = [
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
  'foreign_key_violations',
  'durability_below_requirement',
  'reliability_schema_absent',
] as const;
export type HqIntegrityFinding = (typeof HQ_INTEGRITY_FINDINGS)[number];

export function isHqIntegrityFinding(value: unknown): value is HqIntegrityFinding {
  return typeof value === 'string' && (HQ_INTEGRITY_FINDINGS as readonly string[]).includes(value);
}

/**
 * The three findings that mean HQ's own record cannot be trusted, and are
 * therefore the ONLY ones that engage safe mode. Argued in the module header;
 * pinned by a test so widening or narrowing it is a deliberate, reviewed act.
 */
export const SAFE_MODE_BLOCKING_FINDINGS: readonly HqIntegrityFinding[] = [
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'evidence_chain_broken',
];

export function findingIsBlocking(finding: HqIntegrityFinding): boolean {
  return SAFE_MODE_BLOCKING_FINDINGS.includes(finding);
}

export interface HqIntegrityObservation {
  finding: HqIntegrityFinding;
  blocking: boolean;
  /**
   * A human-readable detail. Deliberately composed from schema object names,
   * pragma values and counts — never from a row's stored content — so an
   * observation cannot become a channel for record text.
   */
  detail: string;
}

/** How thorough the assessment behind a verdict was. Carried, never inferred. */
export const INTEGRITY_ASSESSMENT_DEPTHS = ['structural', 'full'] as const;
export type IntegrityAssessmentDepth = (typeof INTEGRITY_ASSESSMENT_DEPTHS)[number];

export interface HqIntegrityReport {
  depth: IntegrityAssessmentDepth;
  observations: HqIntegrityObservation[];
  /** True when at least one blocking observation stands. */
  safeMode: boolean;
  durability: HqDurabilityPosture;
}

export const SAFE_MODE_STATEMENT =
  'Safe mode is a statement about HQ’s OWN stored record, not about the outside world. It engages only when ' +
  'the engine reports the file corrupt, an append-only guard the schema declares is missing, or the evidence ' +
  'hash chain does not verify. While engaged HQ still READS and still reconciles, and it refuses the acts ' +
  'that would add to, approve, release or execute against a record it cannot stand behind. It is never ' +
  'cleared by a boot: only a fresh assessment that finds nothing blocking clears it.';

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
    // The trio AND the declared secondary guards. The secondaries close
    // REPLACE on a secondary unique index, where the primary-identity guard
    // never fires — see `ENGINE_IMMUTABLE_TABLES`.
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

  return {
    depth: 'structural',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    durability,
  };
}

/**
 * The FULL assessment. Everything structural, plus the three checks whose cost
 * is proportional to the data: the engine's own corruption check, referential
 * integrity, and a whole-log verification of the hash-chained evidence.
 *
 * `verifyEvidenceChain` is injected rather than imported so this module stays a
 * leaf of `store/` and cannot acquire a dependency on `operator/`. The caller
 * passes `EvidenceLog.verifyChain`, which returns the `seq` of the first entry
 * that does not verify, or null when the whole chain does.
 */
export function fullIntegrity(
  db: HqDatabase,
  options: {
    verifyEvidenceChain?: () => number | null;
    reliabilitySchemaPresent?: boolean;
    /** See `structuralIntegrity`. Omitted here means "check the file as it stands now". */
    guardsMissingAsFound?: readonly string[];
  } = {},
): HqIntegrityReport {
  const structural = structuralIntegrity(db, options);
  const observations = [...structural.observations];

  let integrityVerdict: string;
  try {
    const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
    const values = rows.map((row) => String(Object.values(row)[0] ?? '')).filter((value) => value !== '');
    integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
  } catch (error) {
    // A CATEGORICAL phrase, not the engine's own message (Wave 5 Low). An
    // `HqIntegrityObservation.detail` reaches the Founder browser, and this
    // module's own rule is that a detail is composed from schema object names,
    // pragma values and counts — never from anything a row or a third-party
    // error string might carry. An unrunnable check is a check that did not
    // pass, which is the whole finding; the engine's wording adds nothing a
    // reader can act on.
    void error;
    integrityVerdict = 'integrity_check could not run on this database handle';
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

  if (options.verifyEvidenceChain) {
    let brokenAt: number | null | 'error' = null;
    try {
      brokenAt = options.verifyEvidenceChain();
    } catch {
      brokenAt = 'error';
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
  }

  return {
    depth: 'full',
    observations,
    safeMode: observations.some((observation) => observation.blocking),
    durability: structural.durability,
  };
}

/* ------------------------------------------------------------------ */
/* Backup file verification                                            */
/* ------------------------------------------------------------------ */

/** Why a candidate backup file was refused. Closed, categorical. */
export const BACKUP_REFUSAL_REASONS = [
  'path_not_absolute',
  'path_missing',
  'path_is_symlink',
  'path_not_a_regular_file',
  'file_empty',
  'file_too_large',
  /**
   * The candidate carries a `-wal` or `-journal` sidecar with bytes in it
   * (Wave 5 Medium 3).
   *
   * The recorded digest covers the MAIN FILE only, but the verifying open
   * reads main PLUS any sidecar — so with an un-checkpointed WAL beside it,
   * two candidates could carry an identical `contentDigest` and an identical
   * recorded size while `integrity_check` and the table count described
   * different databases (executed: 11 tables versus 12). A recovery point
   * whose digest does not pin what was checked is not a recovery point, and
   * HQ refuses it rather than recording a digest that means less than it
   * looks like it means. Checkpoint or copy the database first.
   */
  'file_has_uncheckpointed_wal',
  /**
   * The bytes moved between the digest and the check (Wave 5 Medium 3).
   *
   * The digest read and the SQLite open are two reads of the same path. The
   * digest fd is now held across the open and the file is re-digested through
   * that same fd afterwards, so digest and verdict provably describe one
   * inode and one content — and a file that changed underneath is refused
   * instead of being recorded under a digest it no longer has.
   */
  'file_changed_during_verification',
  'not_a_readable_sqlite_database',
  'integrity_check_failed',
  'not_an_hq_database',
] as const;
export type BackupRefusalReason = (typeof BACKUP_REFUSAL_REASONS)[number];

/**
 * The largest file this verification will hash and open. A bound, not a
 * policy: verification reads the whole file twice (once to digest, once as a
 * database), and an unbounded path argument must not become an unbounded read.
 */
export const MAX_VERIFIED_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

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
  /**
   * The path HQ actually opened, after resolving symlinked ancestors. Equal to
   * the candidate in the ordinary case; different when the caller named an
   * alias. It is what the register stores, so a backup record names the file
   * that was checked rather than a path that merely points at it.
   */
  resolvedPath: string | null;
}

const VERIFY_CHUNK_BYTES = 1024 * 1024;

function digestFile(fd: number): { digest: string; size: number } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(VERIFY_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return { digest: hash.digest('hex'), size: position };
}

/**
 * Verify that a path holds a readable, uncorrupted HQ database — the check a
 * restore is worth nothing without.
 *
 * READ-ONLY in the strongest available sense: the file is opened `O_NOFOLLOW`
 * for digesting and through `openHqDatabaseReadOnly` for checking, which asks
 * SQLite itself to refuse writes and refuses to create a missing file. Nothing
 * here migrates, checkpoints or repairs.
 *
 * Path protections are refusals, not exceptions, so a caller gets a
 * categorical reason it can record — eleven of them, listed on
 * `BACKUP_REFUSAL_REASONS`.
 *
 * Three of those protections are corrections rather than design (Wave 5):
 *
 *  - `lstat` + `O_NOFOLLOW` cover the FINAL path component only, so a
 *    symlinked PARENT directory was followed silently. The path is resolved
 *    with `realpathSync` and a divergence is refused as `path_is_symlink`,
 *    which is what it is.
 *  - a `-wal`/`-journal` sidecar is refused, because the digest covers the
 *    main file and the verifying open reads main PLUS sidecar — see
 *    `file_has_uncheckpointed_wal`. Pointing this at a LIVE WAL database is
 *    therefore now refused rather than "safe as well as useless": it was never
 *    unsafe, but the digest it produced did not pin what SQLite checked.
 *  - the digest fd is HELD across the SQLite open and the file is re-digested
 *    through it afterwards, so the digest and the verdict provably describe
 *    one inode and one content.
 */
export function verifyHqBackupFile(candidate: string): BackupVerification {
  const empty: BackupVerification = {
    verified: false,
    refusals: [],
    digest: null,
    sizeBytes: null,
    schemaTables: null,
    integrityVerdict: null,
    resolvedPath: null,
  };
  const target = typeof candidate === 'string' ? candidate.trim() : '';
  if (!target || !path.isAbsolute(target)) {
    return { ...empty, refusals: ['path_not_absolute'] };
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

  // The FINAL component is not a symlink — `lstat` just said so — but a PARENT
  // directory may be, and `O_NOFOLLOW` does not look at parents either
  // (Wave 5 Low; verified true with a directory symlink).
  //
  // RECORDED rather than refused, deliberately. A symlinked parent does not
  // substitute the file: the digest and the `integrity_check` still describe
  // whatever inode the path resolves to. What it breaks is BOOKKEEPING — the
  // register would name a path that is an alias for somewhere else. So the
  // resolved path is carried on the verification and is what
  // `recordVerifiedBackup` stores, and the register names the file HQ actually
  // opened. Refusing outright was the other option the review offered and was
  // rejected as disproportionate AND non-portable: on macOS `os.tmpdir()`
  // itself sits under a symlinked `/var`, so a refusal on any divergence would
  // reject ordinary, honest backup paths.
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return { ...empty, refusals: ['path_missing'] };
  }

  // A sidecar with bytes in it means the database's committed content is not
  // all in the file about to be digested. Checked before anything is read, and
  // against the RESOLVED path, which is where SQLite will look for it.
  for (const suffix of ['-wal', '-journal']) {
    try {
      const sidecar = fs.statSync(`${resolved}${suffix}`);
      if (sidecar.isFile() && sidecar.size > 0) {
        return { ...empty, refusals: ['file_has_uncheckpointed_wal'], resolvedPath: resolved };
      }
    } catch {
      // No sidecar is the normal case.
    }
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  } catch {
    return { ...empty, refusals: ['path_not_a_regular_file'] };
  }
  try {
    const proof = digestFile(fd);
    const digest = proof.digest;
    const sizeBytes = proof.size;

    let db: HqDatabase;
    try {
      db = openHqDatabaseReadOnly(resolved);
    } catch {
      return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes, resolvedPath: resolved };
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
        return { ...empty, refusals: ['not_a_readable_sqlite_database'], digest, sizeBytes, resolvedPath: resolved };
      }

      let integrityVerdict: string;
      try {
        const rows = db.prepare(`PRAGMA integrity_check`).all() as Record<string, unknown>[];
        const values = rows
          .map((row) => String(Object.values(row)[0] ?? ''))
          .filter((value) => value !== '');
        integrityVerdict = values.length === 1 && values[0] === 'ok' ? 'ok' : values.join('; ');
      } catch (error) {
        // A check that could not run is not a check that passed. The engine's
        // own message is deliberately NOT interpolated: this string reaches a
        // Founder browser, and this module composes detail from schema names,
        // pragma values and counts only.
        void error;
        integrityVerdict = 'integrity_check could not run on this file';
      }
      const refusals: BackupRefusalReason[] = [];
      if (integrityVerdict !== 'ok') refusals.push('integrity_check_failed');
      if (!tables.has(HQ_MARKER_TABLE)) refusals.push('not_an_hq_database');

      // Re-digest through the SAME descriptor the first digest used, after
      // SQLite has had its look. Equal digests mean the digest recorded beside
      // the verdict describes the exact bytes the verdict was reached on.
      const after = digestFile(fd);
      if (after.digest !== digest || after.size !== sizeBytes) {
        return { ...empty, refusals: ['file_changed_during_verification'], digest, sizeBytes, resolvedPath: resolved };
      }

      return {
        verified: refusals.length === 0,
        refusals,
        digest,
        sizeBytes,
        schemaTables: tables.size,
        integrityVerdict: integrityVerdict.slice(0, 400),
        resolvedPath: resolved,
      };
    } finally {
      try {
        db.close();
      } catch {
        // Never trade the verification result for a close failure.
      }
    }
  } catch {
    return { ...empty, refusals: ['path_not_a_regular_file'] };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The digest, or the refusal, is the result; a close failure is not.
    }
  }
}
