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
 *    unauthenticated artifact — is one of seven names.
 *
 * 2. **Blocking is a short, argued list.** Only four findings engage safe
 *    mode: `database_integrity_check_failed` (the engine says the file is
 *    corrupt), `append_only_guard_missing` (a guard the schema declares was
 *    absent from the file, or a declared ledger contradicts HQ's own durable
 *    checkpoint), `append_only_ledger_truncated` (a declared ledger holds
 *    fewer rows than the engine's own high-water mark says it reached) and
 *    `evidence_chain_broken` (the hash chain does not verify, or the log
 *    contradicts a commitment recorded outside it). Each means HQ's own record
 *    cannot be trusted. A referential-integrity violation and a degraded
 *    durability posture are REPORTED and do not engage safe mode — they are
 *    real defects, but neither says the standing record is false, and treating
 *    them as corruption would make safe mode a thing operators route around
 *    instead of a thing they act on.
 *
 *    Both counts above are pinned to the constants they describe by
 *    `integrity-statement-truth.test.ts`, because this docblock said "six" and
 *    "three" for the whole of Wave 5 while `HQ_INTEGRITY_FINDINGS` grew to
 *    seven and `SAFE_MODE_BLOCKING_FINDINGS` to four beneath it.
 *
 * 3. **Cost is stated, not hidden, and it went UP.** `structuralIntegrity` is
 *    the cheap half — the `sqlite_master` reads, four pragmas, one `COUNT(*)`
 *    and one `MAX(rowid)` over EACH of the 33 declared ledgers, one further
 *    `MAX(rowid)` seek for each ledger HQ has committed a mark for, and five
 *    reads of HQ's own commitment ledger: a `COUNT(*)` served by a covering
 *    index, one indexed lookup joined to `op_evidence` by rowid, and three full
 *    SCANs of that ledger which expand every row's marks through `json_each`
 *    and group them in a temporary B-tree.
 *
 *    **This clause has been wrong twice in one wave, in the same direction, and
 *    both corrections are recorded rather than the latest one written as if it
 *    had always been there.** It first said "one `MAX(rowid)` seek per declared
 *    ledger … one `COUNT(*)` plus one indexed lookup", which round ten (Low 1)
 *    disproved in three ways by counting the statements a pass executes and
 *    asking the engine for their plans: the seeks were two per COMMITTED ledger
 *    rather than one per DECLARED one, the third read was a scan with a temp
 *    B-tree rather than a lookup, and the commitment ledger is not fixed in
 *    size — it grows a row per clean boot and per clean assessment. Round
 *    ten's replacement was true of the head it was measured at and false of the
 *    MERGED one, because the concurrent round-seven lane was closing High 2 in
 *    the same wave: reading each declared ledger's row COUNT is what sees a row
 *    removed from the MIDDLE, and a `COUNT(*)` IS proportional to the rows a
 *    ledger holds where a seek is not.
 *
 *    **And a THIRD time, in the same direction, inside the very sentence
 *    written to stop the recurrence** (round eleven, Medium 1). "46 statements
 *    per pass and 0.871 ms averaged over 50 … Pinned in
 *    `integrity-statement-truth.test.ts` rather than estimated" was false in
 *    BOTH halves. The pass executes 48 statements, not 46 — and nothing pinned
 *    either number. That file pinned the SHAPES of the reads rigorously and
 *    neither of the figures beside them, which is exactly how a re-measured
 *    constant drifted a third time while its own test kept passing.
 *
 *    The correction is not a better constant, because a bare total cannot stay
 *    right: two of its three terms are CENSUSES rather than constants. The pass
 *    is one identity read per DECLARED ledger, one further seek per ledger HQ
 *    has COMMITTED a mark for, and eleven catalogue, pragma and
 *    commitment-ledger reads that do not move. Over the 33 ledgers this build
 *    declares, with marks committed for four of them, that is 33 + 4 + 11 = 48
 *    statements. All three terms and the total are asserted in
 *    `integrity-statement-truth.test.ts` against its `warmedFile()` fixture,
 *    and the numbers in the served sentence and in THIS paragraph are parsed
 *    back out and compared to that measurement — so the prose and the pass
 *    cannot drift apart again without failing.
 *
 *    **No time is quoted, here or in the served sentence.** The retired figure
 *    was 0.871 ms; the same measurement re-run at this head gives 0.830 ms on
 *    this machine, and the review that found the error measured 1.023 ms on
 *    another. A duration that moves with the machine is not a property of the
 *    code and no test can pin one, so it is not shipped as though it were.
 *    `fullIntegrity` adds `integrity_check`,
 *    `foreign_key_check` and a whole-log evidence-chain verification, which
 *    are O(database) and O(log), and it is therefore an explicit act. Which
 *    one produced a verdict is carried ON the verdict, so nobody can mistake a
 *    cheap pass for a full one.
 */

import fs from 'node:fs';
import { deepFreeze } from '../contracts/freeze.js';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HqDatabase } from './db.js';
import {
  HQ_SCHEMA_ENSURED_MARK,
  isHqSchemaEnsuredMark,
  openHqDatabaseReadOnly,
  schemaEnsuredMarkBeforeMigration,
  tableNamesBeforeMigration,
} from './db.js';

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
export const HQ_DURABILITY_REQUIREMENT = deepFreeze({
  journalMode: 'wal',
  /** SQLite's numeric `synchronous`: 2 is FULL. */
  synchronous: 2,
} as const);

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
 *
 * **What this posture is a statement ABOUT, exactly.** `journalMode` is a
 * persistent property of the FILE and is read verbatim from it. `synchronous`
 * is a property of the CONNECTION — SQLite stores nothing about it in the file
 * — so what is reported is what THIS handle runs under. Both HQ opens now
 * establish the declared value (`connectHqDatabaseUnmigrated` and
 * `openHqDatabaseReadOnly`), which is why this reads what it does; a read-only
 * handle still cannot speak for the writer's connection, and does not claim to.
 * Until the Wave 5 correction round three the read-only open set nothing, so
 * every unauthenticated snapshot of a healthy store published a
 * `durability_below_requirement` finding about a defect that was not there
 * (Medium A5).
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
   * The BASE guards required of this table, when the universal trio is not the
   * right requirement for it. Omitted means the trio.
   *
   * Exactly one table uses it, and only because the alternative was worse.
   * `hq_mission_plan_items` legitimately UPDATEs its own columns — linking a
   * task, superseding an item, stating a work spec — so a blanket `no_rewrite`
   * would break the real writers. Both Wave 5 correction lanes reached the same
   * finding about it (Medium 3 / Medium 6): until then that was taken as a
   * reason to leave the table out of this list entirely, which made the census
   * blind to the guards it DOES have — `trg_hq_mission_plan_items_no_replace`
   * is what stops an `INSERT OR REPLACE` re-pointing a plan item's task
   * binding — and to the one it was missing. A reduced, declared base is the
   * honest middle: the census checks exactly the guards the schema really
   * declares, and drift is caught by the same live-schema test that binds every
   * other entry.
   *
   * A boolean `holdsUniversalTrio` was the other lane's shape for the same
   * idea. This one survives the reconciliation because it can also express the
   * guard that lane's version could not: `no_erase` IS required of this table,
   * and a boolean can only say "trio" or "nothing".
   */
  requiredGuards?: readonly string[];
}

/**
 * Freeze a declaration ALL THE WAY DOWN — the array, every entry, and every
 * entry's guard list.
 *
 * A shallow `Object.freeze` would leave `entry.secondaryGuards.length = 0`
 * working, which is the same exploit one level in. Nothing here is a
 * convenience: these are the inputs an enforcement census reads.
 *
 * `requiredGuards` is frozen for exactly the same reason, and the two halves
 * came from two different correction lanes — the freeze from one, the reduced
 * base from the other — so this line is the seam between them. Leaving it out
 * would have re-opened the finding the freeze exists to close, one field
 * across: `ENGINE_IMMUTABLE_TABLES[i].requiredGuards.length = 0` would drop
 * `no_erase` and `no_replace` off `hq_mission_plan_items`' declared set and make
 * the census blind to the very guard the other lane added.
 */
function deepFreezeTables(entries: EngineImmutableTable[]): readonly EngineImmutableTable[] {
  for (const entry of entries) {
    Object.freeze(entry.secondaryGuards);
    if (entry.requiredGuards) Object.freeze(entry.requiredGuards);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

/**
 * Every ledger whose guards are held by the ENGINE, with the prefix its
 * triggers are named under and every guard declared on it.
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
 * The other correction lane reached the same finding from the other exploit:
 * with the table unlisted, dropping `trg_hq_mission_plan_items_no_replace` let
 * an `INSERT OR REPLACE` rewrite a plan item's task binding with no
 * `append_only_guard_missing` finding and no safe mode either. The table now
 * carries `no_erase` and is listed with a REDUCED base (`requiredGuards`), so
 * what is checked is exactly what the schema declares — which covers both
 * exploits with one entry.
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
  /**
   * The hash-chained audit log itself (Wave 5 correction round three, High A2).
   *
   * It used to be absent from this list on the argument that "its guarantee is
   * the chain rather than the engine" — which meant `op_evidence` carried no
   * triggers at all, and a raw `DELETE FROM op_evidence WHERE seq > 1` was
   * simply permitted. The chain then verified perfectly over what was left,
   * because the walk had no commitment to where the chain was supposed to end.
   * The guards are installed by `ensureEvidenceGuards`; being LISTED here is
   * what makes their removal a reportable finding rather than a silent one.
   *
   * Membership does NOT, on its own, make a DROP of this table reportable, and
   * the round that added it said it did (Wave 5 correction round four, High
   * H1). `migrateHqDatabase` re-creates `op_evidence` before the facade census
   * runs, so `absentImmutableTables` could never see it absent — see
   * `MIGRATION_CREATED_IMMUTABLE_TABLES` and
   * `migrationRestoredImmutableTables` for the ordering fix, and
   * `contradictedChainCommitment` for the half no ordering can close. (That
   * second reference read `evidenceChainCommitmentBreach` until the round-five
   * reconciliation retired the verdict-row commitment in favour of the
   * checkpoint ledger; the symbol was gone package-wide — one reference, no
   * definition — so the pointer is corrected here rather than left dangling.
   * Both round-six lanes reached this independently.)
   *
   * Trio only: `id` is the sole secondary unique index and the `no_replace`
   * guard already covers it beside `seq`.
   */
  { table: 'op_evidence', triggerPrefix: 'op_evidence', secondaryGuards: [] },
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
    // `no_remission` closes the OTHER end of the task-to-mission link (Wave 5
    // correction round four, High H2): `no_relink` is declared `BEFORE UPDATE
    // OF task_id`, so re-pointing `mission_id` broke the same link and was
    // simply accepted.
    secondaryGuards: ['no_relink', 'no_remission', 'no_respec'],
  },
  {
    // The mission ROW a plan item joins to. Added by the Wave 5 correction
    // round four (High H2): Phase 14's budget derivation reads a task's mission
    // and, through `hq_missions.project_id`, its project — and this table was
    // absent from this list entirely, so `DELETE FROM hq_missions` unbound
    // every task from every mission and project ceiling with no finding
    // anywhere.
    //
    // A REDUCED base, for the same reason `hq_mission_plan_items` has one: a
    // mission's status, project link and `updated_at` legitimately move through
    // the facade, so a blanket `no_rewrite` would break every real writer. What
    // is write-once is the row's EXISTENCE and its identity.
    table: 'hq_missions',
    triggerPrefix: 'hq_missions',
    requiredGuards: ['no_erase', 'no_replace'],
    secondaryGuards: [],
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
  // The verdict ledger (Wave 5 correction of High finding 1). It is what makes
  // the safe-mode latch survive a restart, so it is exactly the table a
  // tamperer would want to rewrite: the trio is the whole guarantee, and there
  // is no secondary identity to guard because every assessment appends a new
  // row.
  //
  // The other correction lane reached the same finding and built the same
  // guarantee as a separate `hq_safe_mode_latch` table. That table is dropped
  // here rather than kept beside this one: two ledgers holding one verdict is a
  // second truth, and the question "is safe mode engaged" must have exactly one
  // place to be answered from.
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
  // The durable INTEGRITY CHECKPOINT ledger (Wave 5 correction round five,
  // High 1 and Medium 1). It is the one commitment that lives OUTSIDE the
  // records it commits to, so it is exactly the table a tamperer would want to
  // drop: the trio is the whole guarantee, and there is no secondary identity
  // to guard because every checkpoint appends a new row. See
  // `recordIntegrityCheckpoint` for what it holds and
  // `contradictedChainCommitment` / `regressedImmutableLedgers` for what it
  // buys.
  {
    table: 'hq_integrity_checkpoints',
    triggerPrefix: 'hq_integrity_checkpoints',
    // `no_overclaim` is a guard, not a convenience (Wave 5 correction round
    // seven, High 3). Appending is the write this ledger's trio deliberately
    // permits, and it was therefore the ONE write that could make HQ condemn its
    // own store on a claim nothing stood behind. The guard refuses a commitment
    // the file does not support at the moment it is written; being DECLARED here
    // is what makes its removal a reportable finding rather than a silent one.
    secondaryGuards: ['no_overclaim'],
  },
]);

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
export const REQUIRED_IMMUTABILITY_GUARDS = Object.freeze([
  'no_rewrite',
  'no_erase',
  'no_replace',
] as const);

/**
 * Every guard name the schema declares on one listed table. The BASE guards —
 * the trio, or the reduced `requiredGuards` set where an entry declares one —
 * plus that entry's own.
 */
export function declaredGuardsFor(entry: EngineImmutableTable): string[] {
  return [...(entry.requiredGuards ?? REQUIRED_IMMUTABILITY_GUARDS), ...entry.secondaryGuards].map(
    (guard) => `trg_${entry.triggerPrefix}_${guard}`,
  );
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

/**
 * The CLOSED finding vocabulary. Seven names, and nothing else may be reported
 * — a finding is what a safe-mode decision is taken on and what a count in the
 * unauthenticated artifact is keyed by, so it can never be a stored string.
 *
 * `append_only_ledger_truncated` was added by the Wave 5 correction round six
 * (High 1 and High 2). It is deliberately NOT folded into
 * `append_only_guard_missing`: in the attack it names, every declared guard is
 * present and correct at the moment the census looks — the trigger was dropped,
 * the rows were deleted and the trigger was put back — so reporting it under
 * "a guard the schema declares is missing" would tell the Founder something
 * that is not true of the file. What IS true is that the ledger holds fewer
 * rows than the engine's own high-water mark says it reached. See
 * `truncatedImmutableLedgers`.
 */
export const HQ_INTEGRITY_FINDINGS = Object.freeze([
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'append_only_ledger_truncated',
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
 * The four findings that mean HQ's own record cannot be trusted, and are
 * therefore the ONLY ones that engage safe mode. Argued in the module header;
 * pinned by a test so widening or narrowing it is a deliberate, reviewed act.
 *
 * `append_only_ledger_truncated` blocks for exactly the reason the other three
 * do: rows that HQ committed to having appended are no longer in the file. That
 * is a statement about HQ's OWN stored record being false, not about the
 * outside world — the test the module header applies.
 */
export const SAFE_MODE_BLOCKING_FINDINGS: readonly HqIntegrityFinding[] = Object.freeze([
  'database_integrity_check_failed',
  'append_only_guard_missing',
  'append_only_ledger_truncated',
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
   *
   * **What TRUE still does not distinguish, stated rather than implied** (Wave
   * 5 correction round four, Low L7). `verifyEvidenceChain` returns null both
   * for a chain whose every link stands and for a log with no entries at all,
   * so "checked and sound" and "there was nothing to check" reach the same
   * verdict. That case is now BOUNDED rather than open-ended: a verdict commits
   * to the chain tip it was reached over, so any database on which an
   * assessment has ever run carries a commitment an empty log cannot satisfy,
   * and the breach is reported. What stays indistinguishable is a database that
   * has never recorded a verdict AND whose log is empty — a file nothing has
   * happened on yet.
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

/**
 * The sentence HQ ships verbatim on every reliability view, in every safe-mode
 * refusal and on the unauthenticated snapshot.
 *
 * Two clauses are CORRECTED here rather than softened elsewhere (Wave 5
 * correction round four, Medium M1 / Low L6).
 *
 *  - it used to say HQ "refuses the acts that would ADD TO … a record it cannot
 *    stand behind". Broader than the code: under an engaged latch `createTask`,
 *    `proposeMission`, `appendSystemEvidence`, `recordVerifiedBackup` and
 *    `engageKillSwitch` all add rows, and each is individually argued and
 *    correct — recording that work was requested, that a recovery point was
 *    verified, or that everything is now stopped is exactly what a store you
 *    cannot vouch for still needs. The sentence now names what is actually
 *    refused: acts that would APPROVE, RELEASE, EXECUTE or grant AUTHORITY;
 *  - it used to say "only a fresh full assessment that finds nothing blocking"
 *    clears it, with no qualification. A corroborating evidence entry now has
 *    to be a genuine LINK in the chain, which closes the forged-row route the
 *    review executed — but a writer holding the file open can still append a
 *    correctly-hashed entry, because HQ holds no key such a writer does not
 *    also have. The sentence says that, in words, instead of asserting a
 *    boundary the code cannot hold.
 */
export const SAFE_MODE_STATEMENT =
  'Safe mode is a statement about HQ’s OWN stored record, not about the outside world. It engages only when ' +
  'the engine reports the file corrupt, an append-only guard the schema declares is missing, a declared ' +
  'append-only ledger reaches a lower row than the engine’s own high-water mark says it reached, or the ' +
  'evidence hash chain does not verify — which includes a chain that no longer reaches the tip HQ recorded ' +
  'for it. ' +
  'While engaged HQ still READS, still reconciles, and still records what happened — a task requested, a ' +
  'backup verified, a kill switch engaged — because a store you cannot vouch for still needs those facts on ' +
  'the record. What it refuses are the acts that would APPROVE, RELEASE, EXECUTE against or grant AUTHORITY ' +
  'over a record it cannot stand behind — including ' +
  'registering a worker or declaring its provider, which would ADD authority. A blocking ' +
  'verdict is APPENDED to HQ’s own verdict ledger and re-read at every construction, so a restart does not ' +
  'clear it — only a fresh full assessment that finds nothing blocking does. A verdict row appended by ' +
  'anything else does not clear it either: a clearing verdict counts only when the hash-chained evidence ' +
  'log carries the entry naming it that an assessment writes beside it, AND that entry is a genuine link in ' +
  'the chain. That is a barrier, not a cryptographic boundary: HQ holds no key a foreign writer does not also ' +
  'have, so a writer that already holds the database file open can append a correctly-hashed entry of its ' +
  'own. It is a barrier against a stray append and a restart, not against that writer. On a database that ' +
  'carries no ' +
  'Phase 13 ledger there is nowhere to record it and the verdict is process-local; the ' +
  'reliability_schema_absent finding says when that is the case. HQ also records what it has committed ' +
  'to about its own append-only records — the evidence chain’s length and the hash at that seq, and, for ' +
  'EVERY declared ledger this file carries, how many rows it holds and the greatest row it reaches — in a ' +
  'separate append-only ledger, and a record that contradicts a commitment recorded outside it is blocking ' +
  'however consistent that record has been made to look. A row removed from the MIDDLE of a ledger is ' +
  'blocking too, and stays blocking however much HQ appends afterwards, because the gap it leaves in the ' +
  'rows is never filled. A commitment that claims more than the file held when it was written is refused ' +
  'where it is written, so appending one cannot make HQ condemn a store that is intact. That ' +
  'commitment ledger is checked against itself too: it is append-only and HQ is its only writer, so the ' +
  'rows it holds and the high-water mark the engine records for it are the same number, and commitments ' +
  'removed from it in place are blocking as well. Destroying that ledger outright, and rolling it back to ' +
  'an earlier part of itself, are blocking too, and ' +
  'that check does not live in any table: HQ stamps into the database header both THAT it has committed ' +
  'on a file and HOW FAR its own commitment ledger has ever reached, a number that only ever goes up. ' +
  'So a commitment ledger that is present and EMPTY on a file HQ has committed on is blocking however it ' +
  'came to be empty — dropped and re-created, or emptied row by row — and so is one that holds FEWER ' +
  'commitments than that header records, however genuine the rows it still holds are: dropping the ledger ' +
  'and replaying a PREFIX of its own real rows rebuilds every reading that lives inside the file, and does ' +
  'not reach the one that does not. What that still does not stop is a rewrite that keeps every row and ' +
  'every rowid and changes what the rows SAY, and a writer that also rewrites the ' +
  'header can put the file back to unwitnessed or back to a lower mark; HQ holds no key over its own file ' +
  'and says so rather than claiming a boundary it does not have.';

/**
 * What each assessment depth actually costs and actually finds — the sentence
 * `hqReliabilityPosture` serves to the Founder as `depthStatement`.
 *
 * It said "reads the schema catalogue and the durability pragmas ONLY" for the
 * whole of Wave 5, and that stopped being true four correction rounds before
 * anybody re-read it (round eight, Medium 1). The cheap pass now also reads the
 * bounded marks HQ keeps about its own append-only records, and reports
 * `append_only_ledger_truncated` and `evidence_chain_broken` on its own. The
 * direction of the error was fail-SAFE — HQ detected more than it said — which
 * is exactly why nothing caught it, and is not a reason to leave it standing.
 *
 * The last sentence is a machine-checkable list, not decoration:
 * `integrity-statement-truth.test.ts` induces every member of
 * `HQ_INTEGRITY_FINDINGS` against a real file, runs BOTH depths over each, and
 * compares the executed full-exclusive set to the names parsed out of this
 * string. The prose therefore cannot drift from the behaviour again without
 * failing a test, which is the only reason it is safe to state it this
 * precisely.
 */
export const INTEGRITY_DEPTH_STATEMENT =
  'A structural assessment reads the schema catalogue, the durability pragmas, and the marks HQ ' +
  'keeps about its own append-only records — one COUNT(*) and one MAX(rowid) over each declared ledger, ' +
  'one further MAX(rowid) seek for each ledger HQ has committed a mark for, and five reads of HQ’s own ' +
  'commitment ledger: a COUNT(*) served by a covering index, one indexed lookup joined to the evidence ' +
  'log by rowid, and three full SCANs of that ledger which expand every row’s marks through json_each ' +
  'and group them in a temporary B-tree. Counting a ledger’s rows IS proportional to the rows it holds, ' +
  'unlike the seek beside it, and that cost is paid deliberately: a seek cannot see a row removed from ' +
  'the MIDDLE of a ledger and a count can. The commitment ledger it scans is HQ’s own and is not fixed ' +
  'in size — it grows a row per clean boot and per clean assessment, so that term grows with HQ’s own ' +
  'history. The whole pass is therefore not a fixed number of statements: it is one identity read per ' +
  'declared ledger, one further seek per committed one, and 11 catalogue, pragma and commitment-ledger ' +
  'reads that do not move. Over the 33 ledgers this build declares, with marks committed for 4 of them, ' +
  'that is 48 statements — a total that moves with HQ’s own census and not with the rows those ledgers ' +
  'hold, which is what keeps it affordable at every construction. No duration is quoted, because a time ' +
  'measured on one machine is not a property of the code and no test can pin one. It is ' +
  'therefore not a ' +
  'catalogue read alone: a declared ledger that has been emptied, and an evidence log that contradicts a ' +
  'commitment HQ recorded outside it, are both found and both blocking at this depth. A full assessment ' +
  'additionally runs PRAGMA integrity_check, PRAGMA foreign_key_check and a whole-log evidence-chain ' +
  'verification, which are proportional to the database and to the log and are therefore an explicit act; ' +
  'only a full assessment can report the chain as verified, and a structural pass is never reported as a ' +
  'full one. Findings only a full assessment can raise: database_integrity_check_failed, ' +
  'foreign_key_violations.';

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
 * Only tables that are actually PRESENT are checked HERE. A pre-Phase-N file
 * that never had `hq_products` is not missing a guard on it — that is absence,
 * not tampering, and conflating the two would engage safe mode on every older
 * database HQ has ever been pointed at.
 *
 * That is a statement about this function's scope and NOT the end of the
 * matter: an absent table used to be skipped by the whole module, which made a
 * `DROP TABLE` invisible at both depths. `absentImmutableTables` and
 * `restoredImmutableTables` answer the part this one deliberately does not —
 * see them, and `structuralIntegrity`'s `immutableTablesAbsentAsFound`.
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
 * Every DECLARED engine-immutable table this file does not currently carry.
 *
 * The companion to `missingImmutabilityGuards`, and the half that was missing
 * (Wave 5 correction round three, High A1). `DROP TABLE` is DDL: no BEFORE
 * trigger refuses it, and the census above deliberately SKIPS a table that is
 * absent — so dropping `hq_action_intents`, `hq_truth_records`, `hq_memory`,
 * `hq_intel_budgets` or, worst of all, `hq_reliability_verdicts` produced no
 * observation at either depth, and the facade's own `ensure*Schema` calls then
 * recreated each one EMPTY. Dropping the verdict ledger erased a latched safe
 * mode outright, and `releaseKillSwitch` was admitted while the evidence chain
 * was still broken.
 *
 * Absence alone is not the finding, because absence alone is genuinely
 * ambiguous — a pre-Phase-N file that never had `hq_products` is not a tampered
 * one. What resolves it is that HQ RE-CREATES the tables its own schema
 * declares: see `restoredImmutableTables`.
 */
export function absentImmutableTables(db: HqDatabase): string[] {
  const tables = tableNames(db);
  return ENGINE_IMMUTABLE_TABLES.filter((entry) => !tables.has(entry.table))
    .map((entry) => entry.table)
    .sort();
}

/**
 * Of the tables that were ABSENT as the file was found, the ones HQ's own
 * schema ensures have since created.
 *
 * This is what turns an ambiguous absence into a categorical finding. Both
 * halves are needed and neither alone is enough:
 *
 *  - absent AS FOUND, observed before any `ensure*Schema` ran, because those
 *    calls are `CREATE TABLE IF NOT EXISTS` and would otherwise launder the
 *    drop — the same boot-order rule the missing-guard observation already
 *    obeys;
 *  - present NOW, because that is HQ saying "my own schema declares this
 *    ledger". A read-only handle over an older file creates nothing, so the
 *    intersection is empty there and an honestly old file reports nothing —
 *    which is the correct answer, since a handle that may not write genuinely
 *    cannot tell an old file from a robbed one.
 *
 * The consequence is deliberately the SAME consequence a newly declared table
 * already has on its first boot: the guards it declares were absent from the
 * file, that is `append_only_guard_missing`, and safe mode engages. HQ can
 * re-create what it declares; it cannot know what was written while it was
 * gone.
 *
 * **What clearing it actually costs, measured rather than assumed** (Wave 5
 * correction round six, Medium 2). This used to end "and a Founder full
 * assessment of the file as it now stands clears it", which was true of a
 * missing GUARD and stopped being true of a missing LEDGER in the round that
 * carried this list into `fullIntegrity`. The process that OBSERVED the absence
 * holds it for its whole lifetime, precisely so a destroyed ledger cannot be
 * laundered by re-creating it empty — so on an established file the first
 * process's assessment reports it again and refuses, and it takes a RESTART and
 * a SECOND Founder full assessment, in a process that opened a file already
 * carrying the ledger. Measured on a file that predates the build declaring
 * `hq_integrity_checkpoints`: `p1 boot=true assess=true release=refused`,
 * `p2 boot=true assess=false release=ADMITTED`. A missing GUARD is still
 * cleared by ONE assessment, because it is not carried: `q1 boot=true
 * assess=false release=ADMITTED`.
 *
 * That asymmetry is deliberate and was not narrowed to "genuine upgrades only",
 * because the discriminator such a narrowing needs does not survive forging.
 * The only durable marks distinguishing "a ledger this build newly declares"
 * from "a ledger destroyed" are `PRAGMA user_version` and the checkpoint
 * commitments; both are ordinary writable content of the same file, so a writer
 * who drops a ledger and stamps an older generation walks straight into the
 * benign branch, and for the checkpoint ledger itself no commitment survives
 * its own destruction to appeal to. Making the code match the old sentence
 * would therefore have made the previous round's residual CHEAPER. The
 * sentence was corrected instead.
 */
export function restoredImmutableTables(db: HqDatabase, absentAsFound: readonly string[]): string[] {
  if (absentAsFound.length === 0) return [];
  const tables = tableNames(db);
  return [...absentAsFound].filter((table) => tables.has(table)).sort();
}

/**
 * The declared engine-immutable tables that `migrateHqDatabase` creates rather
 * than a facade `ensure*Schema` call.
 *
 * Exactly one — `op_evidence` — and it is named here because it is the one
 * table whose PRESENCE says nothing about whether HQ has ever ensured this
 * file's schema. Every other declared ledger arrives with a phase's ensure,
 * inside the facade constructor, which is what makes "at least one of them is
 * already here" a sound reading of "this file has been through an HQ boot
 * before".
 *
 * Until the Wave 5 correction round four (High H1) this constant recorded that
 * fact and did nothing else with it: the census ran AFTER the migration, so a
 * dropped `op_evidence` had already been re-created empty by the time anything
 * looked, and it was excluded from `established` on top of that. The ordering
 * is now answered where the ordering is — `migrateHqDatabase` records what the
 * file carried before it touched it, and `observeImmutabilityAsFound` reads
 * that instead of the post-migration catalogue for exactly these tables.
 */
const MIGRATION_CREATED_IMMUTABLE_TABLES: readonly string[] = Object.freeze(['op_evidence']);

/**
 * The declared engine-immutable ledgers a file ALREADY carries, excluding the
 * one `migrateHqDatabase` creates.
 *
 * One HALF of the discriminator between "a database HQ has never ensured" and
 * "a database that has lost something", and it is needed because absence is
 * otherwise genuinely ambiguous. On a brand-new file every phase's ledger is
 * absent and every guard those phases declare is missing — which is not a
 * finding, it is a file that has not been built yet, and reporting it would put
 * every first construction into safe mode. On a file that already carries even
 * one of these ledgers, HQ has ensured this schema before, and a declared
 * ledger or guard that is now absent is a fact worth reporting.
 *
 * **It is only half, and on its own it failed open on the widest attack**
 * (Wave 5 correction round four, High 1): dropping ALL of the declared ledgers
 * empties this set, which read as a first boot and silenced the whole census
 * while the operational half of the database survived. The other half —
 * `hqSchemaEnsuredMarkPresent` — is what closes that, and
 * `observeImmutabilityAsFound` takes both. This function stays as it is because
 * "which declared ledgers does this file still carry" is a fact worth having on
 * its own; it is just not the whole question.
 *
 * The known and accepted cost: the FIRST boot of a build that declares a new
 * ledger or a new guard observes it as absent on an established file and
 * engages safe mode. Clearing it costs one Founder full assessment for a new
 * GUARD and a restart plus TWO Founder full assessments for a new LEDGER, and
 * the two are not the same number — see `restoredImmutableTables` for the
 * measurement and for why the asymmetry is kept.
 */
export function establishedImmutableTables(db: HqDatabase): string[] {
  const tables = tableNames(db);
  return ENGINE_IMMUTABLE_TABLES.filter(
    (entry) => tables.has(entry.table) && !MIGRATION_CREATED_IMMUTABLE_TABLES.includes(entry.table),
  )
    .map((entry) => entry.table)
    .sort();
}

/**
 * The value HQ stamps into `PRAGMA user_version` once it has ensured a file's
 * schema — the durable "HQ has been here before" mark.
 *
 * **A distinctive value, not "1", and read as an exact member of a closed set**
 * (Wave 5 correction round five, Low 1). `user_version` is the conventional
 * application-schema slot every SQLite application is invited to use, and the
 * previous reading — "any non-zero value" — was fail-closed in one direction
 * and a FALSE ALARM in the other: a file some other application had stamped
 * `user_version = 7`, opened by HQ for the first time, read as a file HQ had
 * ensured before, so the census ran over it with every declared ledger absent
 * and the first boot engaged safe mode on a database nothing had tampered with.
 * Executed both ways before this change: a fresh file with a foreign
 * `user_version = 7` booted `safeMode: true ["append_only_guard_missing"]`
 * while the control fresh file booted clean.
 *
 * `0x48510001` is HQ's own: `0x4851` is "HQ" in ASCII, the low half is the
 * schema generation. Nothing infers a version from it yet — a later build that
 * raises the generation adds the new value to `HQ_SCHEMA_ENSURED_MARKS` beside
 * the old one, which is a deliberate reviewed act rather than an arithmetic
 * comparison that would quietly accept a foreign stamp again.
 *
 * The constants themselves live in `store/db.ts`, because BOTH readings of the
 * mark have to be ONE reading — see `HQ_SCHEMA_ENSURED_MARK` there (Wave 5
 * correction round six, Low 7).
 */

/**
 * Whether a previous HQ construction has ENSURED this file's schema.
 *
 * **This exists because the schema-only discriminator was bypassed by doing
 * MORE damage** (Wave 5 correction round four, High 1).
 * `establishedImmutableTables` asks which declared ledgers a file still
 * carries, so dropping a SUBSET of them was reported and dropping ALL of them —
 * `op_evidence` included — emptied the set, read as a first boot, and reported
 * NOTHING at either assessment depth. Executed against the previous head: the
 * verdict ledger, the evidence log, every Founder budget ceiling, every truth
 * record and every action intent were gone; `hq_specialists`,
 * `op_capabilities`, `op_kill_switch`, `op_tasks`, `hq_approvals` and
 * `hq_human_principals` survived intact; HQ reported `safeMode: false` with an
 * empty observation list and handed back `releaseKillSwitch` — the exact act
 * safe mode exists to refuse. A detector that is silenced by WIDENING the
 * attack is not a detector.
 *
 * `PRAGMA user_version` is the one place in the file that answers the question
 * without depending on any table surviving: it lives in the 100-byte database
 * header, `DROP TABLE` cannot reach it, `VACUUM` preserves it, and SQLite
 * itself never writes it. So "drop everything" no longer buys silence — the
 * mark is still there, the census runs over a file with 30 declared ledgers
 * absent, and safe mode engages.
 *
 * Deliberately NOT a content check over the tables. That was tried and is
 * wrong: HQ's own components legitimately write rows to a fresh file BEFORE the
 * facade is constructed over it (the specialist directory, the capability
 * registry and the member registry all do, and several suites compose exactly
 * that way), so "this file has rows" cannot tell a first boot from an operated
 * file. The mark is written by the facade's own writable construction and by
 * nothing else, which is precisely the fact the discriminator needs.
 *
 * What it does not answer is stated with it: a writer that zeroes
 * `PRAGMA user_version` puts the file back to unmarked. That is a deliberate
 * forgery of HQ's own schema mark rather than a further drop, and it is the
 * same residual class as rewriting `sqlite_sequence` — the file is HQ's, HQ
 * holds no key over it, and a writer that already has it can lie about it. The
 * inversion this closes is the one that mattered: more damage no longer means
 * less detection.
 *
 * **Only HQ's own mark counts** (Wave 5 correction round five, Low 1). Reading
 * "any non-zero value" as HQ's mark made a foreign application's
 * `user_version` a false alarm on a file HQ had never touched; see
 * `HQ_SCHEMA_ENSURED_MARKS`. The fail-closed direction is unchanged — a value
 * HQ does not recognize contributes NO evidence that HQ has been here, and the
 * ledger half of the discriminator still answers.
 */
export function hqSchemaEnsuredMarkPresent(db: HqDatabase): boolean {
  try {
    const row = db.prepare(`PRAGMA user_version`).get() as Record<string, unknown> | undefined;
    const value = Number(Object.values(row ?? {})[0] ?? 0);
    return isHqSchemaEnsuredMark(value);
  } catch {
    // A handle that cannot answer the pragma contributes no evidence either
    // way; the ledger reading still applies.
    return false;
  }
}

/**
 * Stamp the mark `hqSchemaEnsuredMarkPresent` reads. Called by the facade AFTER
 * its ensure pass, so the observation taken BEFORE that pass still describes the
 * file as it was found.
 *
 * Silent on a read-only handle and on any engine refusal: this is a mark, not a
 * guarantee, and a construction may not fail because it could not leave one.
 * The cost of not leaving it is stated where it is read — an unmarked file is
 * read as a first boot, which is the pre-existing read-only residual.
 */
export function recordHqSchemaEnsured(db: HqDatabase): void {
  if (db.readonly) return;
  try {
    db.exec(`PRAGMA user_version = ${HQ_SCHEMA_ENSURED_MARK}`);
  } catch {
    // See the header: never fail a construction over the mark.
  }
}

/**
 * The value HQ stamps into `PRAGMA application_id` once it has appended at
 * least one row to its OWN commitment ledger — the durable witness that the
 * ledger has held commitments on this file.
 *
 * **This exists because every check guarding the commitment ledger read
 * something a TOTAL erasure destroys** (Wave 5 correction round seven, Critical
 * NEW-1 and High NEW-2). `elidedCommitmentLedgerRows` and
 * `truncatedImmutableLedgers` both start from the `sqlite_sequence` row, and
 * `regressedImmutableLedgers` reads `committedLedgerMarks` out of the very
 * table that was emptied. So destroying the ledger outright was CHEAPER than
 * eliding a row from it — the inversion this module has had to close twice
 * before, in a third place:
 *
 *  - `DROP TABLE hq_integrity_checkpoints`, then replay the table's own DDL out
 *    of the `sqlite_master` SQL the drop was read from. The table is PRESENT
 *    and empty: nothing absent for the as-found census, no `sqlite_sequence`
 *    row to compare against, no commitment left to contradict. Executed against
 *    `d97b8a6` on a file carrying a genuinely latched `evidence_chain_broken`:
 *    `FULL assessment safeMode = false []`, `releaseKillSwitch` ADMITTED, and
 *    every later process `boot = false []` — permanently. The same holds with
 *    `op_evidence` or `hq_reliability_verdicts` dropped and replayed beside it;
 *  - `DELETE FROM hq_integrity_checkpoints` plus `DELETE FROM sqlite_sequence
 *    WHERE name = 'hq_integrity_checkpoints'` — two statements, no replacement
 *    row, no `DROP`. Zero restarts, zero Founder acts, silent for ever
 *    (`p2`–`p5` each `boot=false [] full=false [] release=ADMITTED`).
 *
 * `PRAGMA application_id` is the answer for the same reason `PRAGMA
 * user_version` was the answer to the "drop everything" inversion: it lives in
 * the 100-byte database header, `DROP TABLE` cannot reach it, `VACUUM` and
 * `VACUUM INTO` preserve it, SQLite itself never writes it, and it is the one
 * header slot `user_version` is not already using. A commitment ledger that is
 * PRESENT and holds NO rows on a file carrying this witness is therefore
 * blocking, and no restart and no assessment clears it while it is true.
 *
 * **A distinctive value read as an exact member of a closed set**, for the
 * reason `HQ_SCHEMA_ENSURED_MARKS` records: `application_id` is the slot every
 * SQLite application is invited to stamp its own format id into, and reading
 * "any non-zero value" as HQ's own would make a foreign application's file a
 * false alarm at HQ's first boot over it. `0x48514350` is `HQCP` in ASCII.
 *
 * **The header now carries HOW MANY commitments HQ has made, not merely THAT
 * it has made one** (Wave 5 correction round ten, High 1). A yes/no witness
 * closed the TOTAL erasure and left the PARTIAL one open, which is the same
 * inversion in a fourth place: `DROP TABLE hq_integrity_checkpoints`, replay
 * the table's own DDL, and re-insert a PREFIX of its own genuine rows at their
 * own explicit rowids. The ledger is present and non-empty, so the `rows === 0`
 * witness branch never runs; `AUTOINCREMENT` rebuilds `sqlite_sequence` from
 * those explicit rowids, so rows, greatest rowid and high-water mark are one
 * number again and `elidedCommitmentLedgerRows` answered `false`;
 * `truncatedImmutableLedgers` compares against that same rebuilt mark and is
 * satisfied; `regressedImmutableLedgers` reads `ledger_marks` out of the
 * checkpoints that were just erased, and the surviving OLDEST checkpoint's own
 * recorded mark for this table is always at or below its own rowid, so a prefix
 * always satisfies it; and `contradictedChainCommitment` takes the maximum over
 * the SURVIVING commitments, which the attacker chose. No hash is recomputed —
 * the rows replayed are HQ's own — and no header write is needed, because the
 * yes/no witness stayed true. Executed against `6ce93df` on a real file through
 * the real facade: 18 statements took commitments 7 -> 1 and evidence 9 -> 4,
 * and boot, a FULL Founder assessment and two further reboots all read
 * `safeMode = false []` with `releaseKillSwitch` ADMITTED. It cleared a
 * genuinely latched `["append_only_guard_missing","evidence_chain_broken"]`
 * too, and generalised: once the commitment ledger is rolled back this way,
 * rows can be removed from any declared ledger with nothing left to measure
 * them against.
 *
 * What answers it is a number that only ever goes UP and that does not live in
 * any table: the greatest rowid HQ's commitment ledger has ever reached,
 * carried in the low 16 bits of the same header slot. A `DROP TABLE` cannot
 * lower it, a replay cannot raise the ledger to meet it, and HQ itself only
 * ever raises it — so a ledger holding fewer commitments than the header
 * records is blocking, at both depths and across every restart.
 *
 * **The encoding, and the one value it costs.** The high 16 bits are the
 * signature `0x4851` (`HQ` in ASCII); the low 16 bits are the committed mark,
 * at least 1 and saturating at `0xFFFF`. The legacy value `0x48514350` is read
 * as "witnessed, mark unknown" so that a file committed on by a build older
 * than this one raises nothing until its next checkpoint stamps a mark — the
 * ordinary upgrade cost of any new mark, in the fail-open direction. That one
 * special case has a price and it is stated rather than hidden: a genuine mark
 * of 17232 (`0x4350`) encodes to exactly the legacy value and is therefore read
 * back as "unknown", so the check is vacuous for that ONE checkpoint out of
 * 65535 and repairs itself at the next one. Saturation is the other stated
 * cost: past 65535 committed checkpoints the mark stops advancing, so a
 * rollback WITHIN the saturated range is not caught, while any rollback below
 * 65535 still is.
 *
 * **Reading a 16-bit signature is a real change in specificity, in the
 * false-alarm direction, and it is measured rather than waved past.** The
 * closed set was one exact 32-bit value; it is now 65535 values sharing the
 * ASCII prefix `HQ`. The consequence is unchanged in KIND — a foreign file
 * whose `application_id` HQ mistakes for its own is read as witnessed, and HQ
 * would then find its own freshly-ensured commitment ledger empty on it — and
 * that consequence already existed for the single legacy value. It is 65535
 * times more likely than it was and still requires a foreign application to
 * have chosen an id beginning `HQ`. The alternative considered and rejected was
 * to corroborate the witness with `PRAGMA user_version`, which would have made
 * ONE statement against `user_version` defeat both marks at once — a worse
 * trade in the direction that matters.
 *
 * **What it does not answer, stated rather than implied.** A writer that also
 * rewrites `PRAGMA application_id` puts the file back to unwitnessed, or back
 * to a lower mark that matches the prefix it replayed — one further statement
 * on top of the erasure, executed and still silent. That is the same residual
 * class as zeroing `PRAGMA user_version` or rewriting `sqlite_sequence`: the
 * file is HQ's, HQ holds no key over it, and every fact this module rests on
 * lives in the file the attacker is already writing. What is closed is the
 * INVERSION — neither destroying the commitments outright nor rolling them back
 * to a prefix is cheaper than eliding rows from them.
 */
const HQ_COMMITMENT_WITNESS_MARK = 0x48514350;

/** The high 16 bits every `application_id` HQ stamps carries: `HQ` in ASCII. */
const HQ_COMMITMENT_WITNESS_SIGNATURE = 0x4851;

/** The greatest commitment mark the low 16 bits can carry. Saturates here. */
const HQ_COMMITMENT_MARK_CEILING = 0xffff;

/** What HQ's `application_id` says: whether it has committed, and how far. */
export interface CommitmentWitness {
  /** True when this file carries HQ's own signature in the header slot. */
  witnessed: boolean;
  /**
   * The greatest rowid HQ's commitment ledger had reached when the header was
   * last stamped, or 0 for a witnessed file that carries no mark (a legacy
   * stamp, or the one colliding value the encoding gives up).
   */
  mark: number;
}

const UNWITNESSED: CommitmentWitness = Object.freeze({ witnessed: false, mark: 0 });

/** Decode one `application_id` value. Pure, so both directions can be tested. */
export function decodeCommitmentWitness(value: number): CommitmentWitness {
  if (!Number.isInteger(value)) return UNWITNESSED;
  // The legacy stamp: witnessed, mark unknown. Read FIRST, so the build that
  // predates the mark raises nothing and so the one colliding mark value is
  // fail-open rather than a finding true of nothing.
  if (value === HQ_COMMITMENT_WITNESS_MARK) return { witnessed: true, mark: 0 };
  const signature = (value >>> 16) & 0xffff;
  const mark = value & 0xffff;
  if (signature !== HQ_COMMITMENT_WITNESS_SIGNATURE || mark < 1) return UNWITNESSED;
  return { witnessed: true, mark };
}

/** Encode a commitment mark into the header slot. Saturates at the ceiling. */
export function encodeCommitmentWitness(mark: number): number {
  const bounded = Math.min(Math.max(Math.trunc(mark), 1), HQ_COMMITMENT_MARK_CEILING);
  return ((HQ_COMMITMENT_WITNESS_SIGNATURE << 16) | bounded) >>> 0;
}

/** HQ's header witness for this file, read from the header rather than a table. */
export function readCommitmentWitness(db: HqDatabase): CommitmentWitness {
  try {
    const row = db.prepare(`PRAGMA application_id`).get() as Record<string, unknown> | undefined;
    return decodeCommitmentWitness(Number(Object.values(row ?? {})[0] ?? 0));
  } catch {
    // A handle that cannot answer the pragma contributes no evidence either
    // way, exactly like the schema-ensured mark.
    return UNWITNESSED;
  }
}

/**
 * Whether HQ has ever appended a row to its own commitment ledger ON THIS FILE,
 * read from the database header rather than from any table.
 */
export function commitmentWitnessPresent(db: HqDatabase): boolean {
  return readCommitmentWitness(db).witnessed;
}

/**
 * How many commitments HQ's header records that its own ledger has held, or 0
 * when the file carries no mark at all.
 */
export function committedCheckpointMark(db: HqDatabase): number {
  return readCommitmentWitness(db).mark;
}

/**
 * Stamp the witness. Called only AFTER a checkpoint row has actually landed,
 * never before: a witness set beside a failed insert would be a permanent
 * finding true of nothing, which is the forbidden direction.
 *
 * **Monotone, and that is the whole property.** The stored mark is raised and
 * never lowered, so nothing HQ itself does can walk a real finding back: a file
 * whose ledger has been rolled back is blocking, and the next checkpoint HQ
 * would write on it (at a lower rowid) leaves the header alone. HQ does not
 * reach here at all while safe mode is engaged — both callers refuse to commit
 * then — and this guard is the second lock on the same door rather than a
 * substitute for it.
 *
 * A `PRAGMA application_id` write is TRANSACTIONAL in SQLite (verified against
 * this engine, not assumed), so the stamp made beside a checkpoint inside the
 * assessment's reservation is rolled back with it. An inflated mark surviving a
 * rolled-back insert would be exactly the permanent finding true of nothing
 * that `immutableLedgerMarks` had to be re-derived to prevent.
 *
 * Silent on a read-only handle and on any engine refusal, for the reason
 * `recordHqSchemaEnsured` gives: a construction may not fail because it could
 * not leave a mark. The cost of not leaving it is one unwitnessed checkpoint,
 * and the next one that lands stamps it.
 */
function recordCommitmentWitness(db: HqDatabase, mark: number): void {
  if (db.readonly) return;
  try {
    const stamped = encodeCommitmentWitness(mark);
    const current = readCommitmentWitness(db);
    // Only ever UP. A legacy stamp carries no mark, so the first mark of any
    // size replaces it; after that the header is a high-water mark like every
    // other one this module rests on.
    if (current.witnessed && current.mark >= decodeCommitmentWitness(stamped).mark) return;
    db.exec(`PRAGMA application_id = ${stamped}`);
  } catch {
    // See the header: never fail a construction over the mark.
  }
}

/* ------------------------------------------------------------------ */
/* The durable integrity checkpoint                                    */
/* ------------------------------------------------------------------ */

/**
 * The ledger of what HQ has COMMITTED to about its own append-only records.
 *
 * **Why a second ledger exists at all** (Wave 5 correction round five, High 1
 * and Medium 1). Every check in this module before it read the record and
 * asked whether the record is self-consistent, and a writer that holds the file
 * open can make a shortened record perfectly self-consistent:
 *
 *  - `DROP TABLE op_evidence`, re-create it from its own `sqlite_master` SQL,
 *    INSERT a shortened log with explicit seqs rehashed forward from the
 *    genesis value, re-create the three guards. The links verify, the seqs are
 *    contiguous from 1, `sqlite_sequence` is rebuilt from the explicit rowids
 *    so the high-water mark agrees, the guards are back before HQ next
 *    constructs — and no `UPDATE` was executed anywhere. Two committed audit
 *    entries simply stop having happened. Executed against the previous head:
 *    boot clean, full assessment clean;
 *  - the same shape one step cheaper: drop the guards, DELETE the tail, INSERT
 *    replacement rows at the SAME seqs, re-create the guards. Length, high-water
 *    and contiguity all agree because nothing about the length changed;
 *  - `DROP TABLE` every declared ledger, let HQ's own ensure pass re-create
 *    them EMPTY, restart once, and ask the Founder for a full assessment: the
 *    boot-time as-found observation belongs to the process that made it, so a
 *    later process assessing "the file as it now stands" found 31 healthy empty
 *    ledgers and recorded a CLEAN verdict over a store it had told the Founder
 *    was gutted.
 *
 * What all three have in common is that the only witness to what the record
 * USED TO BE lived inside the record. A checkpoint is that witness, moved out:
 * an append-only row saying "at this moment the evidence log reached seq N with
 * tip hash H, and these append-only ledgers had reached these AUTOINCREMENT
 * high-water marks". A forged record must then contradict a row the attacker
 * has to forge SEPARATELY and COHERENTLY, in a ledger that carries the engine's
 * own append-only trio and is in the census.
 *
 * **Monotone by construction.** Every recorded commitment is checked, and the
 * per-ledger comparison takes the MAXIMUM mark ever committed. Appending a
 * checkpoint can therefore only ever ADD a constraint: a row claiming a shorter
 * chain or a lower mark changes nothing, which is what stops "append a fresh
 * checkpoint over the forgery" from being the way out. The same monotonicity
 * `standingIntegrityVerdict` uses, for the same reason.
 *
 * **What it fails open on, executed rather than assumed, and priced at the
 * CHEAPEST path found rather than the one easiest to describe.** A writer that
 * drops THIS table drops the commitments with it; the absence is a census
 * finding at the boot that observes it (the table is declared in
 * `ENGINE_IMMUTABLE_TABLES`) and, once HQ has re-created it empty, a later
 * process has nothing left to contradict. **That is not the cheap way, and the
 * previous round's residual named it as if it were** — both round-six lanes
 * reproduced the cheaper act independently, and it is the same act: the witness
 * did not have to be taken AWAY, its rows could be wiped IN PLACE. Drop the
 * `no_erase` guard (or all three), `DELETE`, optionally INSERT one replacement
 * that agrees with a forged log, re-create the guards. The table is present and
 * its declared guards are complete at the moment the census looks, so the
 * as-found census observes nothing; and both readers of the commitment —
 * `regressedImmutableLedgers` and `contradictedChainCommitment` — read the very
 * rows deleted, so they returned `[]` and `null`. Measured against the previous
 * head: `BOOT safeMode = false []`, `FULL assessment safeMode = false []`,
 * `releaseKillSwitch ADMITTED`, at zero restarts and zero Founder acts. The
 * drop, by contrast, really does cost a restart and a second Founder act.
 *
 * TWO checks close the free version, and both are kept because they are not the
 * same check. `elidedCommitmentLedgerRows` asserts THIS ledger's own identity —
 * row count, greatest rowid and high-water mark are one number — which catches
 * a wipe even when a replacement row restores the greatest rowid.
 * `truncatedImmutableLedgers` asserts the weaker `MAX(rowid) >= high-water`
 * relation over EVERY declared AUTOINCREMENT ledger, which is what closes the
 * identical attack on `hq_reliability_run_events` and the other twenty-odd
 * ledgers this module declares. Neither subsumes the other; both fire at both
 * depths.
 *
 * The honest price of the SURVIVING version is written on
 * `elidedCommitmentLedgerRows`, and the round-seven correction re-measured it
 * there: the `sqlite_sequence` path this paragraph used to name — an explicit
 * `seq` on the replacement row plus one `UPDATE sqlite_sequence` — is NOT the
 * surviving one. Executed on a file carrying three genuine commitments it is
 * CAUGHT, because collapsing three rows to one regresses this ledger's own
 * recorded high-water mark (`boot=true assess=true release=safe_mode_engaged`);
 * it was only ever measured on a single-commitment file, where the collapse is
 * invisible. What survives is cheaper and touches `sqlite_sequence` not at all:
 * keep the row COUNT and rewrite the rows IN PLACE, through the ONE
 * `BEFORE UPDATE` guard of the three. That is still a cost and not a boundary,
 * and it is the same residual class as zeroing `PRAGMA user_version`: HQ holds
 * no key a foreign writer does not also have, and every fact this ledger rests
 * on lives in the same file the attacker is already writing.
 */
export const HQ_INTEGRITY_CHECKPOINT_TABLE = 'hq_integrity_checkpoints';

const INTEGRITY_CHECKPOINT_DDL = `
CREATE TABLE IF NOT EXISTS hq_integrity_checkpoints (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  chain_length INTEGER NOT NULL,
  tip_hash TEXT NOT NULL,
  ledger_marks TEXT NOT NULL,
  ledger_rows TEXT NOT NULL DEFAULT '{}',
  process_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_integrity_checkpoints_length
  ON hq_integrity_checkpoints(chain_length);

CREATE TRIGGER IF NOT EXISTS trg_hq_integrity_checkpoints_no_rewrite
BEFORE UPDATE ON hq_integrity_checkpoints
BEGIN SELECT RAISE(ABORT, 'hq_integrity_checkpoints is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_integrity_checkpoints_no_erase
BEFORE DELETE ON hq_integrity_checkpoints
BEGIN SELECT RAISE(ABORT, 'hq_integrity_checkpoints is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_integrity_checkpoints_no_replace
BEFORE INSERT ON hq_integrity_checkpoints
WHEN EXISTS (SELECT 1 FROM hq_integrity_checkpoints WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_integrity_checkpoints WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_integrity_checkpoints is append-only'); END;
`;

/** The one guard whose text is built from the schema rather than written out. */
const OVERCLAIM_GUARD = 'trg_hq_integrity_checkpoints_no_overclaim';

/**
 * The guard that refuses a commitment the file does not support AT THE MOMENT
 * IT IS WRITTEN (Wave 5 correction round seven, High 3).
 *
 * **The defect it closes.** Every reader of the commitment ledger took the
 * stored columns at their word, and APPENDING to that ledger is the one write
 * its own append-only trio deliberately permits. So a single `INSERT` — no
 * trigger dropped, no restart, no guard touched — could commit that
 * `op_evidence` had once reached rowid 999 or that the chain had reached seq
 * 999999, and HQ then condemned its own store on that claim: at both depths, on
 * every process afterwards, with `releaseKillSwitch` refused for ever and no
 * in-HQ act able to clear it. Executed against `ae4bf90`: `regressed
 * ["hq_reliability_verdicts","op_evidence"]` and `contradictedChainCommitment
 * 999999`, `p2/p3 boot=true assess=true release=refused`. HQ was telling the
 * Founder that named ledgers had been DROPPED when nothing had touched them.
 *
 * **Why the guard, and not a read-time rule.** The obvious read-time repair is
 * to believe a commitment only up to the engine's own high-water mark. It was
 * written, executed, and REJECTED: `sqlite_sequence` is writable, so capping by
 * it hands back an evasion this module already closes — a tail truncation that
 * also writes the mark down is caught today, and under the cap one `UPDATE`
 * would hide it again. Two shipped tests fail on exactly that, and they are the
 * right tests. Trading a false alarm for a false reassurance is not a fix, so
 * nothing any reader believes has changed; what changed is that the forged row
 * no longer lands.
 *
 * **What it asserts, per declared ledger, from the ROWS rather than from
 * `sqlite_sequence`.** A committed mark may not exceed the ledger's current
 * `MAX(rowid)`, and a committed row count may not exceed its current
 * `COUNT(*)` — both of which are exactly what HQ is about to write, so a
 * genuine checkpoint is never refused, while any over-claim is. Reading the
 * rows rather than the engine's mark matters for the same reason
 * `immutableLedgerMarks` reads them: `sqlite_sequence` is writable and has no
 * row at all for the five declared ledgers that are not AUTOINCREMENT, so a
 * bound taken from it would be both forgeable and absent exactly where High 1
 * has just brought five ledgers into scope. And `chain_length` is bounded by the
 * same row's own `op_evidence` mark, which is the identity every genuine
 * checkpoint has (`tip.seq` IS `MAX(rowid)` on that ledger), so it needs no
 * table of its own and cannot be reached by a forger who has not already got
 * past the mark bound.
 *
 * **Built over the tables the file actually carries, and re-created on every
 * construction.** A trigger naming a table this file does not have would throw
 * at INSERT time and silently stop HQ committing anything at all, which is the
 * worst outcome available — so the clause list is generated from
 * `ENGINE_IMMUTABLE_TABLES` filtered to what `sqlite_master` shows, and the
 * guard is dropped and re-created each time the schema is ensured so it tracks
 * a ledger created later by a capability registration. A ledger created AFTER
 * this construction is unbounded until the next one; that window is disclosed
 * rather than described away.
 *
 * **What it costs an attacker, stated at the price it actually is.** Three
 * statements instead of one: `DROP TRIGGER`, the forged `INSERT`, re-create.
 * That is the same price every other tamper in this module pays, and it is the
 * same standing residual — a guard dropped and re-created before the next boot
 * is never observed missing, because the as-found census reads `sqlite_master`
 * at construction time only. What is closed is the INVERSION: fabricating a
 * finding is no longer cheaper than everything else HQ defends against.
 */
function overclaimGuardDdl(db: HqDatabase): string {
  const clauses = [
    `NEW.chain_length > COALESCE(CAST(json_extract(NEW.ledger_marks, '$.op_evidence') AS INTEGER), 0)`,
  ];
  for (const entry of ENGINE_IMMUTABLE_TABLES) {
    if (!tableIsPresent(db, entry.table)) continue;
    // The table name is never interpolated from anything a row carries: this
    // iterates `ENGINE_IMMUTABLE_TABLES`, a frozen literal in this module.
    clauses.push(
      `COALESCE(CAST(json_extract(NEW.ledger_marks, '$.${entry.table}') AS INTEGER), 0) > ` +
        `COALESCE((SELECT MAX(rowid) FROM "${entry.table}"), 0)`,
      `COALESCE(CAST(json_extract(NEW.ledger_rows, '$.${entry.table}') AS INTEGER), 0) > ` +
        `(SELECT COUNT(*) FROM "${entry.table}")`,
    );
  }
  return (
    `CREATE TRIGGER ${OVERCLAIM_GUARD}\n` +
    `BEFORE INSERT ON ${HQ_INTEGRITY_CHECKPOINT_TABLE}\n` +
    `WHEN ${clauses.join('\n  OR ')}\n` +
    `BEGIN SELECT RAISE(ABORT, '${HQ_INTEGRITY_CHECKPOINT_TABLE} may not commit beyond the record'); END;`
  );
}

/** Whether this file carries one table. Observation, never migration. */
function tableIsPresent(db: HqDatabase, table: string): boolean {
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Install the checkpoint ledger and its guards. Idempotent, and never on a
 * read-only handle — a handle that observes a file does not build one.
 *
 * Called from the facade constructor AFTER the as-found census, exactly like
 * `ensureEvidenceGuards` and for the same reason: a dropped ledger must be
 * OBSERVED before it is repaired.
 */
export function ensureIntegrityCheckpoints(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(INTEGRITY_CHECKPOINT_DDL);
  ensureLedgerRowsColumn(db);
  try {
    // Dropped and re-created rather than `IF NOT EXISTS`: its clause list is
    // derived from the ledgers this file carries, and a ledger created since the
    // last construction has to enter the bound — see `overclaimGuardDdl`.
    db.exec(`DROP TRIGGER IF EXISTS ${OVERCLAIM_GUARD}`);
    db.exec(overclaimGuardDdl(db));
  } catch {
    // See `ensureLedgerRowsColumn`: never fail a construction over a guard HQ
    // could not install. Its ABSENCE is then the census's finding, because it is
    // declared in `ENGINE_IMMUTABLE_TABLES`.
  }
}

/**
 * Add `ledger_rows` to a checkpoint ledger created by an older build.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already there, so
 * a file that carried commitments before Wave 5's round-seven correction needs
 * the column added explicitly. `ADD COLUMN` is the one schema change SQLite
 * makes in place, it fires no `BEFORE UPDATE` trigger and therefore does not
 * meet this ledger's own `no_rewrite` guard, and the `DEFAULT '{}'` is what
 * every pre-existing row then reads as — an empty commitment about row counts,
 * which is exactly the truth about a row written before HQ committed any.
 *
 * Silent on any refusal, for the reason `recordCommitmentWitness` gives: a
 * construction may not fail because it could not complete a migration. The cost
 * of not completing it is that the row-count half of the commitment stays empty
 * on this file, which is the pre-existing posture rather than a new failure.
 */
function ensureLedgerRowsColumn(db: HqDatabase): void {
  try {
    const columns = db.prepare(`PRAGMA table_info(${HQ_INTEGRITY_CHECKPOINT_TABLE})`).all() as {
      name: unknown;
    }[];
    if (columns.some((column) => String(column.name) === 'ledger_rows')) return;
    db.exec(
      `ALTER TABLE ${HQ_INTEGRITY_CHECKPOINT_TABLE} ADD COLUMN ledger_rows TEXT NOT NULL DEFAULT '{}'`,
    );
  } catch {
    // See the docstring: never fail a construction over the migration.
  }
}

/**
 * True when this file carries the checkpoint ledger. Observation, never
 * migration.
 *
 * Module-private (Wave 5 correction round six, Low 2). It was exported with no
 * consumer outside this module and no test of its own — dead public surface
 * from the mechanism that replaced the retired one, and this module's own rule
 * is that a second place to ask a question invites a second answer. The one
 * caller is `recordIntegrityCheckpoint`, below.
 */
function integrityCheckpointLedgerPresent(db: HqDatabase): boolean {
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(HQ_INTEGRITY_CHECKPOINT_TABLE) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * What every DECLARED append-only ledger now holds: its row COUNT and its
 * greatest rowid.
 *
 * ## Why this no longer reads `sqlite_sequence`
 *
 * It used to, because of the property `verifyEvidenceChain` already rests on:
 * an AUTOINCREMENT high-water mark goes back to zero for exactly one reason —
 * the table was DROPPED, which takes its `sqlite_sequence` row with it — which
 * is precisely the act this commitment exists to catch. Two independent Wave 5
 * corrections took it away for two different reasons, and this reader now
 * consults `sqlite_sequence` NOT AT ALL. Both reasons are recorded, because
 * either one alone was sufficient.
 *
 * **First: `sqlite_sequence` is an ordinary WRITABLE table** (round six,
 * Low 1). No trigger can guard it — SQLite refuses to put one there — so a raw
 * writer can INFLATE a ledger's high-water mark, let a single HQ boot COMMIT
 * the inflated reading, then restore the true value. What was then created was
 * a `regressedImmutableLedgers` entry TRUE OF NOTHING and clearable by nothing:
 * safe mode latched permanently on a file whose ledgers were intact, and the
 * only escape was a backup restore. Executed against the previous head:
 * `hq_reliability_verdicts` inflated 1 -> 500000, one clean boot, mark
 * restored, and every process afterwards reported
 * `["append_only_guard_missing"]` at both depths for ever. A fabricated finding
 * is forbidden in the FALSE-ALARM direction exactly as it is in the
 * false-reassurance one, so the reading is taken FROM THE ROWS.
 *
 * **The round-six MERGE moved this from `min(seq, MAX(rowid))` to `MAX(rowid)`,
 * and the reason is a fabricated finding the `min` still allowed.** The other
 * lane's `truncatedImmutableLedgers` makes an inflated mark a BLOCKING
 * observation, so the boot that follows the inflation appends its safe-mode
 * verdict row — and SQLite gives that row the inflated rowid. `min` then
 * committed the inflated value after all, and restoring `sqlite_sequence`
 * produced exactly the permanent finding true of nothing that this correction
 * exists to prevent; executed during the merge, and it is why the two lanes'
 * fixes had to be composed rather than laid side by side. Reading `MAX(rowid)`
 * alone is strictly stronger in both directions: it commits a fact about rows
 * that are really there, it cannot be moved by any write to `sqlite_sequence`
 * in EITHER direction, and every detection the `min` gave is unchanged — a
 * dropped ledger contributes no rows and no mark, and rows deleted in place
 * lower `MAX(rowid)` directly.
 *
 * Reading the rows also STRENGTHENS the detector in the direction that matters:
 * because the mark tracks `MAX(rowid)`, rows deleted IN PLACE from the tail of
 * a declared ledger — drop the guards, `DELETE`, re-create the guards, which
 * leaves `sqlite_sequence` untouched — lower the current mark below the
 * committed one and are reported durably. **Mid-log deletions that leave the
 * tail in place used to be exempt from this, and no longer are** (round seven,
 * High 2): every declared ledger's row COUNT and the GAP between its rows and
 * its greatest rowid are committed beside the mark, and a gap that has GROWN is
 * a finding that no later append can heal — see `committedLedgerGaps`. The
 * exemption was not theoretical: deleting one row from the middle of
 * `hq_reliability_verdicts`, the ledger that holds the safe-mode latch, left
 * `truncated []`, `regressed []` and `release=ADMITTED` across restarts.
 *
 * **Second: `sqlite_sequence` MEMBERSHIP is not a census of the declared
 * ledgers.** Two lanes found this independently and fixed it the same way —
 * round seven High 1, and round ten Medium 4 — and the merge keeps both
 * measurements because they are different experiments on the same hole. Five of
 * the 33 entries in `ENGINE_IMMUTABLE_TABLES` are not `INTEGER PRIMARY KEY
 * AUTOINCREMENT` and so have no `sqlite_sequence` row ever: `hq_memory`,
 * `hq_mission_intents`, `hq_mission_plan_items`, `hq_missions` and
 * `hq_orchestration_runs`. They therefore got no committed mark, which meant
 * `regressedImmutableLedgers` was silent about them too — fail-OPEN against the
 * identical attack the other 28 are protected from. Executed against `ae4bf90`
 * on `hq_mission_plan_items`, the ledger through which a task's mission and its
 * project ceiling are derived: drop the guards, `DELETE`, put the guards back,
 * and `boot=false [] assess=false [] release=ADMITTED`, permanently. Measured
 * again as a MATCHED PAIR by the other lane: the same three statements against
 * `hq_missions` gave `safeMode: false, blocking: []` and a full assessment of
 * `{}` with three committed missions gone, while against `op_evidence` — an
 * AUTOINCREMENT ledger — they correctly gave `safeMode: true` with
 * `['append_only_ledger_truncated']`.
 *
 * So the driver is the DECLARATION itself. Every declared ledger contributes
 * its identity, the commitment ledger records it, and `regressedImmutableLedgers`
 * compares it, which brings the five under a real check with a durable witness.
 *
 * It is sound for exactly these tables and no wider: all 33 declare `no_erase`,
 * so no legitimate writer removes a row, and SQLite assigns a new rowid above
 * the greatest in use — so `MAX(rowid)` on a declared ledger only ever rises.
 * `VACUUM` renumbers implicit rowids, and cannot lower this mark on a ledger
 * nothing has ever deleted from, because such a ledger's rowids are already
 * 1..N. Rowids exist for all 33 (none is `WITHOUT ROWID`), and for a ledger HQ
 * only appends to, `rows` and `top` are the same number. Both are read and both
 * are committed, because they fail differently: see `committedLedgerIdentities`.
 *
 * `truncatedImmutableLedgers` still starts from `sqlite_sequence` and still
 * covers only the AUTOINCREMENT ledgers, and that is not a gap this function
 * papers over: that check measures a ledger against the ENGINE's own high-water
 * mark, which genuinely does not exist for the five. Their check is the
 * COMMITMENT one, which needs a prior healthy boot to have recorded an
 * identity — a real difference in when the alarm can first fire, stated here
 * rather than smoothed over.
 */
export function declaredLedgerIdentities(db: HqDatabase): Record<string, LedgerIdentity> {
  const identities: Record<string, LedgerIdentity> = {};
  for (const entry of ENGINE_IMMUTABLE_TABLES) {
    const identity = ledgerIdentity(db, entry.table);
    // A ledger this file does not carry, and an empty one, contribute nothing:
    // an absent DECLARED table is the census's finding, and a commitment to
    // holding zero rows constrains nothing.
    if (identity !== null && (identity.rows > 0 || identity.top > 0)) identities[entry.table] = identity;
  }
  return identities;
}

/**
 * The greatest mark HQ commits for each declared ledger — the `top` half of
 * `declaredLedgerIdentities`, kept as its own exported answer because that is
 * the shape the checkpoint's `ledger_marks` column has always had.
 */
export function immutableLedgerMarks(db: HqDatabase): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const [table, identity] of Object.entries(declaredLedgerIdentities(db))) {
    if (identity.top > 0) marks[table] = identity.top;
  }
  return marks;
}

/** What one declared ledger now holds: how many rows, and the greatest rowid. */
export interface LedgerIdentity {
  /** How many rows the ledger holds. Zero when it holds none. */
  readonly rows: number;
  /** The greatest rowid the ledger holds. Zero when it holds none. */
  readonly top: number;
}

/**
 * One declared ledger's identity, or null when this file does not carry it.
 *
 * `MAX(rowid)` is a single reverse seek on the rowid B-tree — SQLite answers it
 * from the last entry rather than by scanning. `COUNT(*)` is not: it is
 * proportional to the rows the ledger holds, and taking it once per declared
 * ledger on every construction is a REAL cost increase over the seek alone,
 * which the module header now states at the number measured rather than at the
 * one it used to claim. It is taken anyway, because the seek cannot see a row
 * removed from the middle of a ledger and the count can — Wave 5 correction
 * round seven, High 2, where deleting `seq IN (2,3)` from a run-event ledger
 * left `MAX(rowid)` on the high-water mark and re-admitted a spent attempt
 * generation with `boot=false [] assess=false []` for ever.
 *
 * The table name is never interpolated from anything a row carries: every
 * caller iterates `ENGINE_IMMUTABLE_TABLES`, which is a frozen literal in this
 * module.
 */
function ledgerIdentity(db: HqDatabase, table: string): LedgerIdentity | null {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS held, COALESCE(MAX(rowid), 0) AS top FROM "${table}"`)
      .get() as { held: unknown; top: unknown } | undefined;
    const held = Number(row?.held ?? 0);
    const top = Number(row?.top ?? 0);
    return {
      rows: Number.isInteger(held) && held > 0 ? held : 0,
      top: Number.isInteger(top) && top > 0 ? top : 0,
    };
  } catch {
    return null;
  }
}

/** The evidence log's tip, read as stored columns. Null when there is no log or no entry. */
function evidenceChainTip(db: HqDatabase): { seq: number; hash: string } | null {
  try {
    const row = db.prepare(`SELECT seq, hash FROM op_evidence ORDER BY seq DESC LIMIT 1`).get() as
      | { seq: unknown; hash: unknown }
      | undefined;
    if (!row) return null;
    const seq = Number(row.seq);
    if (!Number.isInteger(seq) || seq < 1) return null;
    return { seq, hash: String(row.hash) };
  } catch {
    return null;
  }
}

/** The greatest chain length any checkpoint commits to. Zero when there is none. */
function committedChainLength(db: HqDatabase): number {
  try {
    const row = db
      .prepare(`SELECT MAX(chain_length) AS len FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`)
      .get() as { len: unknown } | undefined;
    const value = Number(row?.len ?? 0);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * The greatest value any checkpoint committed for each declared ledger, per
 * column.
 *
 * Aggregated in the ENGINE over `json_each` rather than by parsing every row in
 * JavaScript, so the cost of a long-lived checkpoint ledger stays a single
 * indexed scan of a small table. `json_valid` guards the extract for the same
 * reason `verdictIsCorroborated` guards its own: these are columns a raw writer
 * can put anything in, and an unparseable row must be inert here rather than an
 * exception. Keys outside the declared set are ignored, so a forged row cannot
 * name a table that was never HQ's and make the census shout about it.
 *
 * The MAXIMUM, exactly as before — a commitment that over-claims is refused
 * where it is WRITTEN now (`overclaimGuardDdl`), so nothing this reader believes
 * had to be weakened to close the fabricated finding (Wave 5 correction round
 * seven, High 3).
 */
function committedGreatest(db: HqDatabase, column: 'ledger_marks' | 'ledger_rows'): Map<string, number> {
  const declared = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
  const greatest = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT j.key AS name, MAX(CAST(j.value AS INTEGER)) AS value
           FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} c, json_each(c.${column}) j
          WHERE json_valid(c.${column})
          GROUP BY j.key`,
      )
      .all() as { name: unknown; value: unknown }[];
    for (const row of rows) {
      const name = String(row.name);
      if (!declared.has(name)) continue;
      const value = Number(row.value);
      if (Number.isInteger(value) && value > 0) greatest.set(name, value);
    }
  } catch {
    // No checkpoint ledger, no such column on this file's version of it, or an
    // engine that cannot read it: no commitment.
  }
  return greatest;
}

/**
 * The greatest GAP any checkpoint has committed for each declared ledger —
 * `MAX(greatest rowid - rows held)`, taken per checkpoint row.
 *
 * **This is what makes a MID-ledger deletion durable** (Wave 5 correction round
 * seven, High 2). A count on its own heals: delete a row from the middle of a
 * ledger HQ keeps appending to, and the very next append puts the count back
 * where the commitment expects it — measured here on `hq_reliability_verdicts`,
 * where the assessment that OBSERVES the deletion is itself the append that
 * hides it, so the finding lasted less than one process. A gap does not heal.
 * For a ledger HQ only ever appends to, rowids run 1..N with no holes, so
 * `top - rows` is zero and STAYS zero however much it grows; removing k rows
 * from anywhere raises it to k for ever, because SQLite hands the next append
 * `MAX(rowid) + 1` and never reissues a rowid a deleted row held.
 *
 * **Taken as a MAXIMUM, which is the direction that cannot fabricate.** A gap
 * only ever grows, so the greatest one ever committed is the right baseline; and
 * a forged checkpoint can only push that baseline UP, which weakens detection
 * rather than manufacturing a finding. That fail-open is one raw write, it is
 * silent, and it is recorded in the phase document's residual list rather than
 * argued away — the same class as every other write to a file HQ holds no key
 * over.
 *
 * **A ledger whose rowids legitimately had a hole before HQ first committed on
 * it is therefore not a false alarm**: the hole is committed as the baseline and
 * only growth beyond it is reported. That the declared ledgers have no such hole
 * is not assumed — `ledger-rowid-contiguity.test.ts` drives every conflicting,
 * deduplicated and refused write path this package has on all 33 of them and
 * asserts that none burns a rowid, so a future path that does fails a test
 * instead of latching a permanent finding on a healthy store.
 */
function committedLedgerGaps(db: HqDatabase): Record<string, number> {
  const declared = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
  const gaps: Record<string, number> = {};
  try {
    const rows = db
      .prepare(
        `SELECT j.key AS name,
                MAX(CAST(json_extract(c.ledger_marks, '$.' || j.key) AS INTEGER) - CAST(j.value AS INTEGER)) AS gap
           FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} c, json_each(c.ledger_rows) j
          WHERE json_valid(c.ledger_rows) AND json_valid(c.ledger_marks)
          GROUP BY j.key`,
      )
      .all() as { name: unknown; gap: unknown }[];
    for (const row of rows) {
      const name = String(row.name);
      if (!declared.has(name)) continue;
      const value = Number(row.gap);
      if (Number.isInteger(value) && value >= 0) gaps[name] = value;
    }
  } catch {
    // No checkpoint ledger, no `ledger_rows` column on this file's version of
    // it, or an engine that cannot read it: no baseline, so no finding.
  }
  return gaps;
}

/**
 * The greatest identity each declared ledger has been committed to hold.
 *
 * BOTH halves, because they answer different questions and the greater rowid
 * alone answered only one (Wave 5 correction round seven, High 2): `top` falls
 * when rows are removed from the TAIL, and `rows` falls when they are removed
 * from anywhere at all — including the middle, which leaves the tail and the
 * engine's high-water mark exactly where they were.
 *
 * The greatest committed value, unreduced. That a commitment cannot over-claim
 * is enforced where it is written (`overclaimGuardDdl`), which is why this
 * reader needed no second opinion and did not acquire one.
 */
function committedLedgerIdentities(db: HqDatabase): Record<string, LedgerIdentity> {
  const marks = committedGreatest(db, 'ledger_marks');
  const rows = committedGreatest(db, 'ledger_rows');
  const committed: Record<string, LedgerIdentity> = {};
  for (const table of new Set([...marks.keys(), ...rows.keys()])) {
    const top = marks.get(table) ?? 0;
    const held = rows.get(table) ?? 0;
    if (top > 0 || held > 0) committed[table] = { top, rows: held };
  }
  return committed;
}

/**
 * Append a checkpoint, if there is anything new to commit to.
 *
 * Returns whether a row was written. Nothing is written when the handle is
 * read-only, when the file carries no checkpoint ledger, when the evidence log
 * is empty, or when neither the chain nor any ledger mark has advanced past
 * what is already committed — a checkpoint per boot of an idle HQ would be
 * noise, and the standing commitment is unchanged by it.
 *
 * A checkpoint is an OBSERVATION of stored columns, never a re-computation:
 * the tip hash is read out of the row the log already holds, so there is no
 * second spelling of the chain's hash formula anywhere (the one spelling lives
 * in `operator/evidence.ts` and stays there). That is also why this module can
 * own the checkpoint without acquiring a dependency on `operator/`.
 *
 * The CALLER decides when a checkpoint is appropriate, and both callers refuse
 * to commit while safe mode is engaged: HQ does not add to a record it has
 * already said it cannot stand behind. The consequence is deliberate — during
 * an engagement the standing commitment stops advancing and the last one HQ
 * made while it still trusted the file is what a later assessment is measured
 * against.
 */
export function recordIntegrityCheckpoint(
  db: HqDatabase,
  input: { id: string; recordedAt: string; processId: string; recordedBy: string },
): boolean {
  if (db.readonly) return false;
  if (!integrityCheckpointLedgerPresent(db)) return false;
  const tip = evidenceChainTip(db);
  const identities = declaredLedgerIdentities(db);
  const marks: Record<string, number> = {};
  const heldRows: Record<string, number> = {};
  for (const [table, identity] of Object.entries(identities)) {
    if (identity.top > 0) marks[table] = identity.top;
    if (identity.rows > 0) heldRows[table] = identity.rows;
  }
  const committedLength = committedChainLength(db);
  const committed = committedLedgerIdentities(db);
  // An empty evidence log is not a reason to skip: the LEDGER MARKS are half of
  // what a checkpoint commits, and a file whose other ledgers have grown is
  // worth committing whether or not anything has been appended to the audit
  // log. `chain_length = 0` commits nothing about the chain and the chain check
  // ignores it.
  const advanced =
    (tip !== null && tip.seq > committedLength) ||
    Object.entries(marks).some(([table, mark]) => mark > (committed[table]?.top ?? 0)) ||
    Object.entries(heldRows).some(([table, held]) => held > (committed[table]?.rows ?? 0));
  if (!advanced) return false;
  try {
    const landed = db
      .prepare(
        `INSERT INTO ${HQ_INTEGRITY_CHECKPOINT_TABLE}
         (id, recorded_at, chain_length, tip_hash, ledger_marks, ledger_rows, process_id, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
      input.id,
      input.recordedAt,
      tip?.seq ?? 0,
      tip?.hash ?? '',
      JSON.stringify(marks),
      JSON.stringify(heldRows),
      input.processId,
      input.recordedBy,
    );
    // The witness is stamped only once the row has LANDED, and it carries the
    // rowid that row actually got — see `HQ_COMMITMENT_WITNESS_MARK`. A crash
    // between the two leaves the file behind by one commitment, which is
    // fail-open for one row and is repaired by the next checkpoint that lands.
    // `lastInsertRowid` rather than a second `MAX(rowid)` read: it is the rowid
    // THIS statement wrote, so no concurrent append can be mistaken for it.
    recordCommitmentWitness(db, Number(landed.lastInsertRowid));
    return true;
  } catch {
    // A checkpoint HQ could not write is a commitment HQ does not hold. It is
    // never a reason to fail the construction or the assessment that tried:
    // the checks below simply have one fewer commitment to measure against,
    // which is the pre-existing posture rather than a new failure.
    return false;
  }
}

/**
 * The FIRST committed evidence-chain length whose committed tip the log no
 * longer carries, or null when every commitment still stands.
 *
 * One indexed query, and the answer has the same shape as every other answer
 * about this log — the seq at which it stops being true — so
 * `verifyEvidenceChain` can return it unchanged.
 *
 * `e.hash IS NOT c.tip_hash` rather than `<>`, because the LEFT JOIN's missing
 * row is exactly the case that matters: a log shortened past a committed length
 * has no row at that seq at all, and `<>` against NULL is NULL, which is not
 * true and would have quietly passed.
 */
export function contradictedChainCommitment(db: HqDatabase): number | null {
  try {
    // NOT bounded here, and that is deliberate (Wave 5 correction round seven,
    // High 3). One `INSERT` claiming `chain_length = 999999` used to condemn
    // this log for ever, and the obvious read-time repair — believe a commitment
    // only up to the engine's own high-water mark for `op_evidence` — was
    // executed and REJECTED, because it hands the evasion back: a tail
    // truncation that also writes `sqlite_sequence` down is caught here today,
    // and capping the commitment by that same number would make one `UPDATE`
    // enough to hide it again. Trading a false alarm for a false reassurance is
    // not a fix. The over-claim is refused where it is WRITTEN instead, by
    // `trg_hq_integrity_checkpoints_no_overclaim`, so nothing this check reads
    // has changed.
    const row = db
      .prepare(
        `SELECT c.chain_length AS len
           FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE} c
           LEFT JOIN op_evidence e ON e.seq = c.chain_length
          WHERE c.chain_length > 0 AND e.hash IS NOT c.tip_hash
          ORDER BY c.chain_length ASC
          LIMIT 1`,
      )
      .get() as { len: unknown } | undefined;
    if (!row) return null;
    const value = Number(row.len);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    // Either ledger absent: there is no commitment to contradict, and the
    // absence of a DECLARED ledger is the census's finding, not this one's.
    return null;
  }
}

/**
 * The declared append-only ledgers that now hold FEWER entries than HQ has
 * committed they held.
 *
 * This is the half that survives a restart, and that is the whole point
 * (Wave 5 correction round five, Medium 1). "Which ledgers were absent when
 * this process opened the file" is an observation belonging to one process; a
 * dropped-and-re-created ledger looks perfectly healthy to the next one. A
 * high-water mark that has gone BACKWARDS is not an observation about a moment,
 * it is a fact about the file as it now stands — so a full assessment reports
 * it however many restarts have happened, and no assessment can clear it while
 * it is true.
 *
 * `DROP TABLE` is what produces it, and since the correction round that
 * corroborated the mark against the ledger's own `MAX(rowid)` so does a tail
 * DELETE executed with the guards temporarily removed — see
 * `immutableLedgerMarks`. No legitimate path produces it: HQ deletes from no
 * declared ledger, the engine guards refuse a DELETE from any writer, `VACUUM`
 * and `VACUUM INTO` carry both `sqlite_sequence` and the rowids across
 * unchanged for an `INTEGER PRIMARY KEY` table, and a byte copy or `.backup()`
 * copies the file.
 */
export function regressedImmutableLedgers(db: HqDatabase): string[] {
  const committed = committedLedgerIdentities(db);
  const gaps = committedLedgerGaps(db);
  const names = [...new Set([...Object.keys(committed), ...Object.keys(gaps)])];
  // NO commitments is deliberately not a finding HERE, and that is not a hole
  // (Wave 5 correction round seven, Critical NEW-1). This function measures
  // ledgers AGAINST the commitments, so a file whose commitments were destroyed
  // has nothing for it to measure and the honest answer is the empty list. That
  // the commitments THEMSELVES are gone is a different finding with a different
  // witness, and `elidedCommitmentLedgerRows` reports it from the database
  // header rather than from the table the erasure emptied.
  if (names.length === 0) return [];
  const current = declaredLedgerIdentities(db);
  return names
    .filter((table) => {
      const now = current[table] ?? { rows: 0, top: 0 };
      const mark = committed[table];
      // Three ways one ledger contradicts what HQ committed about it, because
      // they fail differently (Wave 5 correction round seven, High 1 and High
      // 2). `top` falls when the TAIL is removed. `rows` falls when ANY row is,
      // which is the only half that sees a ledger emptied whose engine
      // high-water mark was never recorded. And the GAP grows when a row is
      // removed from the MIDDLE — the one of the three that does not heal the
      // moment HQ appends to the ledger again.
      if (mark && (now.top < mark.top || now.rows < mark.rows)) return true;
      const gap = gaps[table];
      return gap !== undefined && now.top - now.rows > gap;
    })
    .sort();
}

/**
 * HQ's OWN commitment ledger, checked for rows that have been elided IN PLACE.
 *
 * **The cheapest surviving forgery did not need to drop this table at all**
 * (Wave 5 correction round six, Medium 1). The residual shipped in the round
 * before priced the surviving whole-log forgery at "one extra `DROP TABLE`, one
 * restart and one further Founder act" — a real cost, but not the one an
 * attacker pays. Wiping the commitments' ROWS IN PLACE — drop the three
 * triggers, `DELETE`, INSERT one replacement that agrees with the forged log,
 * re-create the triggers — leaves the table PRESENT, so the as-found census has
 * nothing to observe, no drop is ever reported, and the forgery was silent from
 * the very next boot: zero restarts, zero Founder acts, `releaseKillSwitch`
 * admitted immediately. Measured against the previous head: `BOOT safeMode
 * = false []`, `FULL assessment safeMode = false []`, `releaseKillSwitch
 * ADMITTED? true`.
 *
 * What answers it is an invariant of the table itself rather than a commitment
 * about it. This ledger is `INTEGER PRIMARY KEY AUTOINCREMENT`, HQ appends to
 * it and nothing else ever writes it, and its `no_erase` guard refuses a
 * DELETE — so the number of rows it holds, the greatest rowid it holds and the
 * high-water mark SQLite records for it are the SAME NUMBER, always. Eliding a
 * row breaks that identity, and an elision cannot repair it by removing
 * something else: `sqlite_sequence` keeps the mark the deleted rows reached.
 *
 * **What the in-file identity does NOT answer, and the sentence above used to
 * imply it did** (Wave 5 correction round seven, Low 2). Read on its own it
 * sees an ELISION. A forgery that REWRITES the surviving rows in place
 * preserves the count, the greatest rowid and the high-water mark by
 * construction, so there is no identity to repair and nothing in that reading
 * to detect. That is priced honestly a few paragraphs down rather than left as
 * an implication.
 *
 * **And the identity was satisfiable by REBUILDING it, which is why the header
 * mark had to be read here too** (Wave 5 correction round ten, High 1). The
 * round-seven text said the cheapest surviving forgery elides nothing. That was
 * false when it was written and it is corrected rather than softened: a forgery
 * that DROPS this table and replays a PREFIX of its own genuine rows at their
 * own explicit rowids elides four of seven commitments and satisfies every one
 * of the three in-file readings, because `AUTOINCREMENT` rebuilds
 * `sqlite_sequence` from the rowids the attacker chose. Rows, greatest rowid
 * and high-water mark are one number again — a DIFFERENT number. Executed
 * against `6ce93df` through the real facade: 18 statements, commitments 7 -> 1,
 * evidence 9 -> 4, `boot=false [] full=false [] reboot=false []`,
 * `releaseKillSwitch` ADMITTED, and a genuinely latched
 * `["append_only_guard_missing","evidence_chain_broken"]` cleared. The identity
 * is therefore checked against a number the replay cannot rebuild, because it
 * is not in the file's tables at all: the greatest rowid this ledger has ever
 * reached, in the database header — see `HQ_COMMITMENT_WITNESS_MARK`.
 *
 * **Checked against every legitimate way a sequence value could be burned,
 * before it was relied on.** A statement that fails does NOT advance
 * `sqlite_sequence` in SQLite: a `RAISE(ABORT)` from this table's own
 * `no_replace` guard, a `UNIQUE` violation on `id`, a `NOT NULL` violation, a
 * failed insert inside an explicit transaction that later commits other work, a
 * multi-row `INSERT ... SELECT` whose second row fails, and an explicit
 * `ROLLBACK` of a good insert were each executed against a table with this
 * exact schema, and count, greatest rowid and high-water mark stayed equal
 * through all six. `VACUUM` preserves all three. That mattered: a false
 * permanent alarm here would be worse than the hole, and it is the same
 * fabricated-finding failure the Low of this round corrects elsewhere.
 *
 * **What it costs an attacker, executed rather than asserted, at the cheapest
 * path found rather than the one easiest to describe.** It is more steps, not a
 * boundary — and the price the previous round wrote here was the wrong one, in
 * the reassuring direction, because the version WITHOUT the barrier it named
 * was never executed (Wave 5 correction round seven, Low 2).
 *
 * The round-five text said the durable repair is two statements: insert the
 * replacement at an EXPLICIT `seq = 1`, then `UPDATE sqlite_sequence SET
 * seq = 1` for this table. Executed on a file carrying THREE genuine
 * commitments, that path is not merely expensive, it is CAUGHT — collapsing
 * three rows to one regresses this ledger's own recorded high-water mark, and
 * `p2` came back `boot=true assess=true release=safe_mode_engaged`. It was
 * measured on a single-commitment file, where the collapse is invisible.
 *
 * The path that actually survives needs neither the explicit rowid nor any
 * `sqlite_sequence` write at all: keep the ROW COUNT and rewrite the rows IN
 * PLACE. `DROP TRIGGER` the ONE `BEFORE UPDATE` guard (not all three), one
 * `UPDATE hq_integrity_checkpoints SET chain_length = …, tip_hash = …,
 * ledger_marks = …`, re-create that one trigger. Count, greatest rowid and
 * high-water mark are all untouched, so this function answers `false`.
 * Executed end to end, with `op_evidence` itself rewritten in place and
 * re-chained so the forgery is real rather than notional:
 * `p2/p3/p4 boot=false assess=false release=ADMITTED`, permanently. Zero
 * `sqlite_sequence` writes, zero `DELETE`s, zero `INSERT`s, zero explicit
 * rowids, one trigger of three.
 *
 * The one-statement variant the round-five text also priced — `DELETE FROM
 * sqlite_sequence WHERE name = ...` after an elision — buys LESS than that
 * text said, and the correction is round ten's rather than a re-reading (Medium
 * 4). It used to buy the whole process that follows, because no ledger mark had
 * advanced at that boot and `recordIntegrityCheckpoint` therefore wrote
 * nothing: `p2 boot=false assess=false release=ADMITTED`, then `p3` and `p4`
 * `boot=true assess=true release=refused`. Now that `immutableLedgerMarks`
 * covers every declared ledger rather than only the AUTOINCREMENT ones, that
 * boot's own commitment DOES land and re-creates the mark from the surviving
 * rowid, so the Founder assessment it was aiming to pass is refused in the very
 * process it bought: re-measured at this head, `p2 boot=false assess=TRUE
 * release=refused`, permanently. What it still buys is one clean BOOT
 * reading — `hqReliabilityPosture` alone — and nothing that decides anything.
 *
 * So the honest gain of this check is narrower than it was written to be, and
 * the sentence that used to stand here — "it closes the version that DELETES
 * rows, at every price" — was false of the code in TWO directions and is
 * replaced by the measured statement (round ten, High 1).
 *
 * What it does close: every version that leaves this ledger holding fewer
 * commitments than HQ's header records it once held, whichever way the rows
 * went — deleted in place, deleted with the high-water mark deleted beside
 * them, dropped and replayed empty, or dropped and replayed as a PREFIX of its
 * own genuine rows. All four are blocking at both depths and across restarts,
 * and no assessment clears one while it is true.
 *
 * What it does not close, at its measured price:
 *
 *  - **the in-place REWRITE**, and no row-count invariant can — the count, the
 *    greatest rowid and the header mark are exactly what that version
 *    preserves. Its price is one `BEFORE UPDATE` trigger dropped and re-created
 *    on each engine-guarded ledger the forgery touches. That is the cheapest
 *    surviving forgery: three statements on this ledger, and it elides nothing;
 *  - **any of the four erasures PLUS one `PRAGMA application_id` write** that
 *    puts the header back to a mark matching what was replayed (or to zero,
 *    which returns the file to unwitnessed). Measured at this head: one further
 *    statement, and boot, full assessment and reboot read `false []` again.
 *    HQ holds no key over its own file, and this is the same residual class as
 *    zeroing `PRAGMA user_version`.
 *
 * Both are steps, not boundaries, and they are recorded in the phase document's
 * residual list at those prices.
 *
 * Scoped to this ONE ledger deliberately. The identity holds for it because HQ
 * is its only writer; extending a row COUNT to every other declared ledger would
 * both break `structuralIntegrity`'s stated cost (a `COUNT(*)` is O(rows),
 * unlike the `MAX(rowid)` seek) and assert an invariant over tables this module
 * does not own.
 *
 * **Why this ledger has its own check as well as the general one** (round-six
 * merge; the paragraph is stated here, on the check it is about, rather than on
 * `truncatedImmutableLedgers`, where "below" pointed at the function carrying
 * it and "this ledger" named the other one). `truncatedImmutableLedgers` below
 * asserts `MAX(rowid) >= high-water` over EVERY declared AUTOINCREMENT ledger;
 * the identity asserted here is strictly stronger for this one table, because it
 * also counts the rows. A wipe that INSERTS a replacement carrying the old
 * greatest rowid satisfies the general relation and fails this one. Neither
 * check subsumes the other, so both stand: the general rule is what closes the
 * identical attack on `hq_reliability_run_events` and every other declared
 * ledger, and this one is what closes the replacement-row variant on the
 * commitment ledger itself. Neither closes the in-place REWRITE priced above,
 * which changes no count and no rowid.
 *
 * **And neither of them saw a TOTAL erasure, which was therefore cheaper than a
 * partial one** (Wave 5 correction round seven, Critical NEW-1 and High NEW-2).
 * Both readings above START from the `sqlite_sequence` row, and both of the
 * cheapest destructive acts take that row away with them:
 * `DROP TABLE` + a replay of the table's own DDL out of `sqlite_master`, and
 * `DELETE` every row plus `DELETE FROM sqlite_sequence` for this table. Either
 * leaves the ledger PRESENT and EMPTY, with its three guards back and nothing
 * for the as-found census to observe — and an empty commitment ledger
 * contradicts nothing, so `regressedImmutableLedgers` returns `[]` too.
 * Measured on `d97b8a6`, against a file carrying a genuinely latched
 * `evidence_chain_broken`: `boot=false [] full=false [] release=ADMITTED`, and
 * permanently. The `rows === 0` branch below is what closes both, and it rests
 * on the ONE witness neither act can reach, because it is not in a table at
 * all: see `HQ_COMMITMENT_WITNESS_MARK`.
 */
export function elidedCommitmentLedgerRows(db: HqDatabase): boolean {
  // The ledger is absent from this file: that is the census's finding — the
  // table is a declared `ENGINE_IMMUTABLE_TABLES` member — and inventing a
  // second one here would report the same fact twice.
  if (!integrityCheckpointLedgerPresent(db)) return false;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS top FROM ${HQ_INTEGRITY_CHECKPOINT_TABLE}`,
      )
      .get() as { rows: unknown; top: unknown } | undefined;
    const rows = Number(row?.rows ?? 0);
    const top = Number(row?.top ?? 0);
    if (!Number.isInteger(rows) || !Number.isInteger(top)) return false;
    // TOTAL erasure, measured against the database HEADER rather than against
    // anything the erasure could take with it (round seven, Critical NEW-1 /
    // High NEW-2). A present but EMPTY commitment ledger on a file HQ has
    // committed on is blocking however it came to be empty.
    const witness = readCommitmentWitness(db);
    if (rows === 0) return witness.witnessed;
    // PARTIAL erasure, measured against the same header (round ten, High 1).
    // The header records the greatest rowid this ledger has EVER reached, and
    // that number only goes up, so a ledger now holding fewer commitments than
    // it — a `DROP` and a replay of a PREFIX of its own genuine rows, which
    // rebuilds every in-file reading below from the rowids it chose — is
    // blocking. Both readings are compared because the two ways of shortening
    // the ledger show up in different ones: a prefix lowers the greatest rowid,
    // and a replay that keeps the greatest rowid but drops rows beneath it
    // lowers the count.
    if (witness.mark > 0 && (top < witness.mark || rows < witness.mark)) return true;
    const highWater = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
      .get(HQ_INTEGRITY_CHECKPOINT_TABLE) as { seq: unknown } | undefined;
    const mark = Number(highWater?.seq ?? 0);
    // Rows exist but no high-water mark does: the one-statement repair, whose
    // remaining price is measured above.
    if (!Number.isInteger(mark) || mark <= 0) return false;
    return rows !== mark || top !== mark;
  } catch {
    // An engine that cannot read a table it just reported present contributes
    // no finding here; the census still holds.
    return false;
  }
}

/**
 * The declared append-only ledgers whose ROWS have been removed while the
 * engine's own high-water mark still records that they were there.
 *
 * **This is the general form of the one check that already worked** (Wave 5
 * correction round six, High 1 and High 2). `verifyEvidenceChain` has always
 * ended its walk by comparing `op_evidence`'s last surviving seq against
 * `sqlite_sequence.op_evidence`, and that single comparison is why tail
 * truncation of the audit log is caught. Nothing generalised it, and the
 * consequence was that EVERY other declared ledger could be emptied in three
 * statements with no finding at any depth:
 *
 * ```sql
 * DROP TRIGGER trg_<ledger>_no_erase;
 * DELETE FROM <ledger>;
 * CREATE TRIGGER trg_<ledger>_no_erase BEFORE DELETE ON <ledger>
 *   BEGIN SELECT RAISE(ABORT, '<ledger> is append-only'); END;
 * ```
 *
 * A trigger dropped and re-created before the next boot is never observed
 * missing — the as-found census reads `sqlite_master` at construction time
 * only — so the guard stands again, the table is present, its own guards are
 * complete, and the rows are simply gone. Executed against the previous head,
 * twice:
 *
 *  - on `hq_integrity_checkpoints`, which round five made the SOLE external
 *    witness for the evidence chain. Both readers of that witness read the very
 *    rows deleted: `regressedImmutableLedgers` returns `[]` on an empty
 *    commitment set and `contradictedChainCommitment` returns `null` with no
 *    rows to join against. Boot clean, full Founder assessment clean,
 *    `releaseKillSwitch` handed back over an `op_evidence` rebuilt two
 *    committed entries short;
 *  - on `hq_reliability_run_events`, which carries the cross-process
 *    duplicate-attempt reservation this module calls the single most
 *    load-bearing secondary guard in the schema. Emptying it returned a
 *    correctly-refused second attempt to generation 1 and ADMITTED it, with
 *    boot and full assessment both clean — making `RUN_RETRY_STATEMENT`'s
 *    "an interrupted attempt is NEVER retried automatically" false.
 *
 * `sqlite_sequence` is the right witness for the same reason
 * `verifyEvidenceChain` uses it: a DELETE never lowers it, `VACUUM` and
 * `VACUUM INTO` carry it across, and a byte copy or `.backup()` copies it. It
 * is read against `MAX(rowid)` rather than against a named column because every
 * declared ledger's AUTOINCREMENT key is `INTEGER PRIMARY KEY`, which IS the
 * rowid — so one query shape covers all of them and no per-table column list
 * can drift out of date.
 *
 * **What this does not close, stated rather than glossed.** `sqlite_sequence`
 * is an internal SQLite table: it carries no triggers, `tableNames` excludes it
 * by construction, and a writer that already holds the file open can lower the
 * mark it finds there. Emptying a ledger AND rewriting its `sqlite_sequence`
 * row down to match is still silent here — that is the same residual class as
 * zeroing `PRAGMA user_version`, and it is recorded in the phase document's
 * residual list. It is also, at this head, the one place a raw writer can
 * MANUFACTURE a finding rather than hide one: raising a ledger's
 * `sqlite_sequence` row above its greatest rowid is one `UPDATE` and reports
 * `append_only_ledger_truncated` over a ledger nobody has touched — measured at
 * this head, `p2/p3 boot=true assess=true release=refused`. It is the same class
 * as the commitment over-claim round seven closed with
 * `trg_hq_integrity_checkpoints_no_overclaim`, and it is NOT closed here,
 * because the only bound available is the number being written; it is disclosed
 * in the phase document's residual list at that price rather than described
 * away.
 *
 * A ledger that is not `AUTOINCREMENT` has no `sqlite_sequence` row at all and
 * therefore contributes nothing HERE. That is fail-open for THIS check and is
 * stated rather than covered by a mark that would always read zero — but it is
 * no longer fail-open for the file (Wave 5 correction round seven, High 1):
 * `regressedImmutableLedgers` reads every declared ledger's own rows against
 * HQ's own commitment, so the five ledgers with no engine mark are covered
 * there, and emptying one is blocking at both depths. What changed at round six
 * is that emptying a ledger is no longer FREE; what changed at round seven is
 * that the sentence above stopped being the whole of the story for five of the
 * 33.
 */
export function truncatedImmutableLedgers(db: HqDatabase): string[] {
  const declared = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));
  let marks: { name: string; seq: number }[];
  try {
    marks = (
      db.prepare(`SELECT name, seq FROM sqlite_sequence`).all() as {
        name: unknown;
        seq: unknown;
      }[]
    )
      .map((row) => ({ name: String(row.name), seq: Number(row.seq) }))
      .filter((row) => declared.has(row.name) && Number.isInteger(row.seq) && row.seq > 0);
  } catch {
    // No `sqlite_sequence` in this file at all: nothing has ever been appended
    // to an AUTOINCREMENT ledger, so there is no mark to contradict.
    return [];
  }
  const truncated: string[] = [];
  for (const mark of marks) {
    let highest: number;
    try {
      // `MAX(rowid)` is a single b-tree seek, not a scan, so this stays
      // affordable at the CHEAP depth — the same cost `verifyEvidenceChain`
      // has always paid for `op_evidence` alone.
      const row = db.prepare(`SELECT MAX(rowid) AS top FROM "${mark.name}"`).get() as
        | { top: unknown }
        | undefined;
      const value = Number(row?.top ?? 0);
      highest = Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      // A mark naming a table this file does not carry. A DROP takes the
      // `sqlite_sequence` row with it, so this is a forged row rather than a
      // dropped ledger, and the absence of a DECLARED ledger is the census's
      // finding rather than this one's.
      continue;
    }
    if (highest < mark.seq) truncated.push(mark.name);
  }
  return truncated.sort();
}

/** What the schema-immutability census saw BEFORE this process ensured anything. */
export interface ImmutabilityAsFound {
  /** Declared guards absent from a table that was present. Empty on an unestablished file. */
  guardsMissing: string[];
  /** Declared ledgers absent entirely. Empty on an unestablished file. */
  tablesAbsent: string[];
  /**
   * Whether this file has been through an HQ boot before — read as "it still
   * carries an ensure-created immutable ledger" OR "it carries HQ's own
   * schema-ensured mark". Either alone is enough; see
   * `observeImmutabilityAsFound`.
   */
  established: boolean;
}

/**
 * The single boot-time observation, taken BEFORE any `ensure*Schema` runs.
 *
 * One function rather than three call sites, because the three facts have to be
 * read at the same instant to mean anything: the ensures are `CREATE ... IF NOT
 * EXISTS` throughout, so anything read after them describes the file HQ has
 * just rebuilt rather than the file it was handed.
 *
 * **The discriminator takes TWO independent readings and needs only one of
 * them** (Wave 5 correction round four, High 1). The ledger reading —
 * `establishedImmutableTables` — is the one a first boot must not trip, and it
 * failed open on the widest possible attack: drop EVERY declared ledger and the
 * set is empty, which read as "this file has not been built yet" and returned a
 * silent census over a database whose entire operational half was still there.
 * The MARK reading — `hqSchemaEnsuredMarkPresent` — does not live in a table at
 * all, so no amount of dropping reaches it, and the inversion is closed: more
 * damage no longer means less detection.
 *
 * What a genuine first boot still looks like, and why it is still not a
 * finding: no ensure-created ledger, and no mark. Both readings are false and
 * the census is silent, exactly as before. That includes a fresh file HQ's own
 * components have already written rows to before the facade is constructed over
 * it, which is a supported composition and must not read as tampering.
 */
export function observeImmutabilityAsFound(db: HqDatabase): ImmutabilityAsFound {
  const established = establishedImmutableTables(db).length > 0 || hqSchemaEnsuredMarkPresent(db);
  if (!established) return { guardsMissing: [], tablesAbsent: [], established };
  return {
    guardsMissing: missingImmutabilityGuards(db),
    tablesAbsent: [
      ...new Set([...absentImmutableTables(db), ...migrationRestoredImmutableTables(db)]),
    ].sort(),
    established,
  };
}

/**
 * The migration-created ledgers this file did NOT carry before
 * `migrateHqDatabase` re-created them.
 *
 * `absentImmutableTables` reads the catalogue as it stands, and by the time the
 * facade constructor runs, `openHqDatabase` has already executed the DDL — so
 * for `op_evidence`, and only for it, "absent" is a question that can no longer
 * be asked of the live catalogue. It is asked of the record
 * `migrateHqDatabase` took a moment earlier instead (Wave 5 correction round
 * four, High H1).
 *
 * Null-safe by design: a handle with no recorded pre-migration census — a
 * read-only snapshot handle, or one connected without migrating — contributes
 * nothing here rather than reporting every migration-created ledger as lost.
 * Nothing re-created anything on such a handle, so there is nothing to launder.
 */
export function migrationRestoredImmutableTables(db: HqDatabase): string[] {
  const before = tableNamesBeforeMigration(db);
  if (!before) return [];
  // ESTABLISHED as the file was found, judged on the PRE-migration catalogue —
  // not on the live one. The distinction is the whole correctness of this
  // function. A brand-new database legitimately has no `op_evidence` before
  // `migrateHqDatabase` creates it, and the live catalogue a moment later
  // carries every ledger this process has just ensured; reading `established`
  // from THAT would report the first boot of every fresh store as a lost
  // ledger, and a second facade over the same handle as one too.
  //
  // A file that already carried an ensure-created immutable ledger has been
  // through an HQ boot before, so `op_evidence` missing from it is a fact worth
  // reporting — the same discriminator `establishedImmutableTables` applies,
  // asked of the moment it is still answerable.
  //
  // BOTH readings of that discriminator, not one (Wave 5 round-four
  // reconciliation). This function was written against the ledger reading
  // alone, and the other lane's finding applies to it word for word: dropping
  // EVERY declared ledger empties the ledger reading, so `op_evidence` — the
  // audit log itself, and the widest form of the attack — would have been the
  // one table left out of the census exactly when everything else was gone.
  // The mark reading answers it, and using it here is also what keeps ONE
  // definition of "established" in the module: `observeImmutabilityAsFound`
  // takes both readings, and so must the function whose result it unions in.
  //
  // The mark is read AS OF THE MIGRATION, not as it stands. That distinction is
  // the same one this whole function exists for, and getting it wrong is not
  // theoretical: `recordHqSchemaEnsured` runs at the END of a facade
  // construction, so a SECOND facade over the same handle would see a mark this
  // very process had just written, judge a genuine first boot "established",
  // and report `op_evidence` as a lost ledger on a brand-new store. Executed
  // during this merge, that put nine suites into safe mode.
  const establishedBefore =
    ENGINE_IMMUTABLE_TABLES.some(
      (entry) =>
        before.has(entry.table) && !MIGRATION_CREATED_IMMUTABLE_TABLES.includes(entry.table),
    ) || schemaEnsuredMarkBeforeMigration(db) === true;
  if (!establishedBefore) return [];
  const now = tableNames(db);
  return MIGRATION_CREATED_IMMUTABLE_TABLES.filter(
    (table) => !before.has(table) && now.has(table),
  ).sort();
}

/** Every guard the schema declares on the named engine-immutable tables. */
function guardsDeclaredOnTables(tables: readonly string[]): string[] {
  const names: string[] = [];
  for (const table of tables) {
    const entry = ENGINE_IMMUTABLE_TABLES.find((candidate) => candidate.table === table);
    if (!entry) continue;
    names.push(...declaredGuardsFor(entry));
  }
  return names;
}

/**
 * The CHEAP assessment: the schema catalogue, the durability pragmas and the
 * durable commitments.
 *
 * Runs no scan proportional to the SIZE of a ledger, which is what makes it
 * affordable on every construction of the facade. Stated exactly, because the
 * boundary has moved twice: the catalogue reads and the pragmas are constant;
 * `regressedImmutableLedgers` costs one `MAX(rowid)` reverse seek per declared
 * ledger, which SQLite answers from the last B-tree entry; and
 * `elidedCommitmentLedgerRows` costs one `COUNT(*)` over HQ's OWN commitment
 * ledger, which holds one row per boot or assessment that advanced something
 * and nothing else. `PRAGMA integrity_check`, `foreign_key_check` and the
 * whole-log chain walk are the O(database) checks and stay in `fullIntegrity`.
 *
 * It can detect the one tamper that matters most — an append-only guard removed
 * from a ledger that still exists — because a dropped trigger is a
 * `sqlite_master` fact, not a data fact.
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
     * Engine-immutable tables that were ABSENT as the file was found and that
     * HQ's own schema has since re-created — `restoredImmutableTables`.
     *
     * A dropped ledger is not a dropped trigger and used to be invisible to
     * this whole module (Wave 5 correction round three, High A1): the census
     * skipped an absent table, so a full assessment over a file with seven
     * declared immutable ledgers DROPPED reported a completely clean store.
     * Every guard such a table declares was in fact absent from the file, so
     * that is what is reported, and the tables are named in the detail so the
     * reader is told the ledger went missing rather than three triggers.
     */
    immutableTablesAbsentAsFound?: readonly string[];
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
    /**
     * **There is deliberately no `evidenceCommitmentBreachAt` option**, and its
     * absence is the round-four/round-five reconciliation recorded where a
     * future caller will look for it.
     *
     * The concurrent round-four lane injected the durable chain commitment as a
     * VALUE here, computed by the caller from `evidence_tip_seq` on the verdict
     * ledger, because the verdict ledger belongs to `application/` and this
     * module is a leaf of `store/`. The commitment that survived the
     * reconciliation lives in `hq_integrity_checkpoints`, which is a `store/`
     * table, so it is read DIRECTLY below (`contradictedChainCommitment`) —
     * no injection, nothing patchable in the path, and one place a reader can
     * find the answer. The property the injected version was defended for is
     * unchanged: it is checked at the CHEAP depth, for one indexed lookup,
     * because destroying the audit log and rebuilding it is an attack a BOOT
     * must not read as clean (Wave 5 correction round four, High H1; round
     * five, High 1).
     */
  } = {},
): HqIntegrityReport {
  const observations: HqIntegrityObservation[] = [];
  const durability = readDurabilityPosture(db);

  const absentTables = [...(options.immutableTablesAbsentAsFound ?? [])].sort();
  const missing = [
    ...new Set([
      ...(options.guardsMissingAsFound ?? missingImmutabilityGuards(db)),
      // A ledger that was not there declared guards that were not there. The
      // two observations are one finding, because "the table was gone" is a
      // strictly worse way for its guards to be absent.
      ...guardsDeclaredOnTables(absentTables),
    ]),
  ].sort();
  // The DURABLE half of the same question (Wave 5 correction round five,
  // Medium 1). "Which ledgers were absent when this process opened the file" is
  // an observation belonging to one process, and a dropped-and-re-created
  // ledger looks perfectly healthy to the next one. A high-water mark that has
  // gone BACKWARDS is a fact about the file as it now stands, so it is reported
  // however many restarts have happened — see `regressedImmutableLedgers`.
  const regressed = regressedImmutableLedgers(db);
  const regressionDetail =
    regressed.length > 0
      ? ` ${regressed.length} declared ledger(s) no longer hold what HQ's own durable checkpoint ` +
        `records they held — fewer rows, a lower greatest row, or a gap where a row used to be: ` +
        `${regressed.join(', ')}. None of those can happen while HQ is the only writer and the guards ` +
        `refuse a DELETE, so those tables were DROPPED and are back empty, or rows were removed from ` +
        `them with the guards temporarily gone. A row removed from the MIDDLE leaves the rest of the ` +
        `ledger where it was and is reported here for the gap it leaves, which later appends do not ` +
        `fill. Re-creating a ledger does not bring back what it held.`
      : '';
  // The COMMITMENT LEDGER'S OWN invariant (Wave 5 correction round six,
  // Medium 1). Every check above measures some other ledger AGAINST the
  // commitments, so a writer who wipes the commitments' rows IN PLACE — the
  // table never absent, nothing for the as-found census to see — silenced all
  // of them at zero cost. Rows, greatest rowid and high-water mark are the same
  // number for this ledger or rows were elided from it; see
  // `elidedCommitmentLedgerRows`.
  const commitmentsElided = elidedCommitmentLedgerRows(db);
  const elisionDetail = commitmentsElided
    ? ` HQ's own durable commitment ledger ${HQ_INTEGRITY_CHECKPOINT_TABLE} does not hold what HQ ` +
      `committed to it on this file: the rows it holds, the greatest row it reaches and the high-water ` +
      `mark the engine records for it are one number for a ledger only HQ appends to, and they are not ` +
      `one number here — or it holds nothing at all on a file whose database header records that HQ has ` +
      `appended to it. Nothing but HQ appends to that ledger and its guards refuse a DELETE, so rows ` +
      `were removed from it with the guards temporarily gone, a row was written into it at a position HQ ` +
      `never allocated, or the whole ledger was destroyed and re-created empty. The commitments every ` +
      `other check is measured against are therefore not the ones HQ made.`
    : '';
  // ONE observation per finding, because the counts in the unauthenticated
  // artifact and the wording of the refusal are keyed by the finding name. The
  // three ways a declared ledger's append-only guarantee can be gone — the
  // guard or the table itself, observed at boot; the rows, measured against a
  // commitment; and the commitments themselves, measured against the engine's
  // own high-water mark — are one finding with one detail.
  if (missing.length > 0) {
    observations.push({
      finding: 'append_only_guard_missing',
      blocking: true,
      detail:
        `${missing.length} append-only guard(s) declared by the schema were absent from this file: ` +
        `${missing.join(', ')}.` +
        (absentTables.length > 0
          ? ` ${absentTables.length} of the ledger(s) they guard were absent ENTIRELY and have been ` +
            `re-created empty by HQ's own schema: ${absentTables.join(', ')}. A dropped table is not a ` +
            `migration — whatever those ledgers held is gone.`
          : '') +
        regressionDetail +
        elisionDetail +
        ` HQ re-creates the guards it declares on every boot, so they may stand again ` +
        `now — but it cannot know what was written while they were gone. A missing GUARD is cleared by a ` +
        `full assessment of the file as it then stands, because re-creating a trigger really does repair ` +
        `the file's guard set; a ledger that was ABSENT or that is back EMPTY is not, because re-creating ` +
        `a table does not bring back the rows.`,
    });
  } else if (regressed.length > 0 || commitmentsElided) {
    observations.push({
      finding: 'append_only_guard_missing',
      blocking: true,
      detail:
        `The file's append-only ledgers contradict HQ's own durable checkpoint.${regressionDetail}` +
        `${elisionDetail} ` +
        `This is a fact about the file as it now stands, not an observation about the boot that saw the ` +
        `drop, so it does not go away with a restart and no assessment clears it while it is true.`,
    });
  }

  // The ENGINE's own witness that a declared ledger has been emptied (Wave 5
  // correction round six, High 1 and High 2). This is the general form of the
  // comparison `verifyEvidenceChain` has always made for `op_evidence` alone,
  // and it is what stops "drop the guard, DELETE, put the guard back" from
  // being free on every OTHER declared ledger — including the checkpoint ledger
  // that both commitment readers above depend on, and including the run-event
  // ledger that reserves an attempt generation. A fact about the file as it now
  // stands, so no restart clears it and no assessment clears it while it holds.
  const truncated = truncatedImmutableLedgers(db);
  if (truncated.length > 0) {
    observations.push({
      finding: 'append_only_ledger_truncated',
      blocking: true,
      detail:
        `${truncated.length} declared append-only ledger(s) hold FEWER rows than the engine's own ` +
        `AUTOINCREMENT high-water mark records they reached: ${truncated.join(', ')}. A DELETE never ` +
        `lowers that mark and the declared guards refuse a DELETE at all, so rows that HQ appended have ` +
        `been removed — a guard dropped and re-created before this boot stands again now, and the census ` +
        `that reads the schema catalogue cannot see that it was ever gone. Re-creating a guard does not ` +
        `bring back what the ledger held.`,
    });
  }

  // The evidence log's own DURABLE commitment, cheap enough for a
  // construction-time pass (one indexed lookup) and a fact about the file as it
  // now stands (Wave 5 correction round five, High 1). Every other chain check
  // reads the log and asks whether it is self-consistent, which a coherent
  // whole-log rewrite satisfies.
  const contradictedCommitment = contradictedChainCommitment(db);
  if (contradictedCommitment !== null) {
    observations.push({
      finding: 'evidence_chain_broken',
      blocking: true,
      detail:
        `HQ's durable checkpoint commits the evidence log to an entry at seq ${contradictedCommitment}, ` +
        `and the log no longer carries that entry with that hash. A shortened or re-written log can be ` +
        `made internally consistent; it cannot be made to agree with a commitment recorded outside it.`,
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

  const standingVerdict = carryRecordedVerdict(observations, options.recordedVerdict ?? null);

  return {
    depth: 'structural',
    observations,
    // `standingVerdict` is the fail-closed half: a recorded verdict that says
    // ENGAGED still engages even when not one of its stored finding names could
    // be read back through the closed vocabulary. See `carryRecordedVerdict`.
    safeMode: standingVerdict || observations.some((observation) => observation.blocking),
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
 *
 * Returns whether an ENGAGED verdict stands, which is not the same question as
 * whether a finding was carried. A finding name that is not a member of the
 * closed vocabulary — a raw append into the ledger, or a row from a future
 * version — is deliberately NOT carried into `observations`, because a
 * fabricated finding would reach the unauthenticated artifact's key set and the
 * refusal message. But dropping the ENGAGEMENT with it is the fail-open answer:
 * the row says HQ stopped trusting itself, and "I could not read why" is not a
 * reason to start again. So the engagement stands categorically, no vocabulary
 * member is invented for it, and `#safeModeRefusal` names the situation in
 * words instead (the reconciliation of the two correction lanes: one lane's
 * test pinned the finding NAME being dropped, the other lane's pinned the
 * ENGAGEMENT surviving; both hold here).
 */
function carryRecordedVerdict(
  observations: HqIntegrityObservation[],
  recorded: RecordedIntegrityVerdict | null,
): boolean {
  if (!recorded || !recorded.safeMode) return false;
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
  return true;
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
    /** See `structuralIntegrity`. Omitted here for the same reason. */
    immutableTablesAbsentAsFound?: readonly string[];
    /**
     * **No commitment argument, deliberately** — see `structuralIntegrity`. The
     * durable commitment reaches a FULL assessment by two paths that need no
     * caller cooperation, and that is the property that matters here: this is
     * the only latch-clearing path, so a commitment the log cannot satisfy must
     * be visible HERE or a Founder assessment would clear a verdict about a
     * destroyed audit log. It is visible through the structural pass beneath
     * this one, and again through `verifyEvidenceChain`, which ends on the same
     * check.
     */
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
    immutableTablesAbsentAsFound: options.immutableTablesAbsentAsFound,
  });
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
  // The structural pass already checks the DURABLE commitment and reports the
  // same finding when one is contradicted, and `verifyEvidenceChain` checks it
  // too so that `chainVerified` and the public delegate stay honest. One
  // observation per finding is what the counts in the unauthenticated artifact
  // and the refusal message are keyed by, so the second is folded in here
  // rather than duplicated. The blocking outcome is identical either way, and
  // the detail already on the list is the more specific of the two.
  const commitmentAlreadyReported = observations.some(
    (observation) => observation.finding === 'evidence_chain_broken',
  );
  if (brokenAt === 'error' && !commitmentAlreadyReported) {
    observations.push({
      finding: 'evidence_chain_broken',
      blocking: true,
      detail: 'The hash-chained evidence log could not be verified at all; HQ treats an unverifiable chain as a broken one.',
    });
  } else if (brokenAt !== 'error' && brokenAt !== null && !commitmentAlreadyReported) {
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
    // A commitment the log cannot satisfy is a chain that did not verify, even
    // when every link present holds — which is exactly the state a dropped and
    // rebuilt log is in. `verifyEvidenceChain` ends on
    // `contradictedChainCommitment`, so that state is already inside `brokenAt`
    // and no second term is needed here; the concurrent lane's second term read
    // an injected value that no longer exists.
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
 *    live HQ database is WAL-mode and is therefore refused AT ITS OWN PATH;
 *    see `verifyHqBackupFile` for what that does and does not cover;
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
  /**
   * The candidate is a HARD LINK to another name — most importantly, to the
   * LIVE HQ database.
   *
   * The sidecar refusal is keyed on the resolved PATH, and a hard link is a
   * second name for the same inode with no sidecars beside IT. So
   * `ln data/headquarter.sqlite /tmp/backup.sqlite` verified `true`, and the
   * "verified recovery point" recorded permanently in the append-only register
   * was the live database itself — a file whose committed content was
   * demonstrably NOT all in the bytes that were digested, because the WAL holds
   * the rest (Wave 5 correction round three, Medium A4). `nlink` is taken from
   * the DESCRIPTOR that was actually opened, so it settles the question about
   * the inode rather than about the name.
   *
   * A backup is a snapshot of bytes that stands still. A file some other name
   * can still be written through is not one, whether or not that other name is
   * HQ's own.
   */
  'file_has_multiple_links',
  /**
   * A `-wal`, `-shm` or `-journal` sidecar sits beside the candidate.
   *
   * Both Wave 5 correction lanes reached this refusal from the same exploit
   * (High finding 3 / Medium 3) and named it differently: one refused any
   * sidecar as `sidecar_journal_present`, the other refused a `-wal`/`-journal`
   * carrying BYTES as `file_has_uncheckpointed_wal`. The broader rule is the
   * one kept, because presence — not size — is what makes the main file
   * possibly-not-the-whole-database: SQLite resolves the sidecars together
   * with the path, two candidates could then carry an identical
   * `contentDigest` and an identical recorded size while `integrity_check` and
   * the table count described different databases (executed: 11 tables versus
   * 12), and an operator restoring the DIRECTORY would get content this
   * verification never saw. Checkpoint or `.backup` the database first.
   */
  'sidecar_journal_present',
  /**
   * The candidate IS the database this HQ is running on.
   *
   * `sidecar_journal_present` refuses the live file WHILE a process holds it
   * open, because WAL mode leaves a `-wal` beside it — and that was presented as
   * covering the live database. It does not: SQLite removes the sidecars on a
   * clean close, so `verifyHqBackupFile(<the live db path>)` between runs
   * returned `verified: true, refusals: [], tables: 47`, and a Founder could
   * register the live database as a "verified recovery point" (Wave 5 correction
   * round six, Low 3). The bytes really were those bytes, so nothing false was
   * recorded — but a recovery point that the next write mutates is not one, and
   * the register exists to say which files a restore could be taken from.
   *
   * Answered from the LIVE HANDLE's own path rather than from the candidate's
   * shape, because that is the only thing that actually distinguishes them.
   */
  'candidate_is_the_live_database',
  'verification_copy_failed',
  'not_a_readable_sqlite_database',
  'integrity_check_failed',
  'not_an_hq_database',
  /**
   * The candidate opens, passes `PRAGMA integrity_check` and carries HQ's
   * marker table — and HQ's OWN tamper detection finds it blocking.
   *
   * **This is the refusal that had no check behind it** (Wave 5 correction
   * round ten, High 4). `verifyHqBackupFile` used to run exactly two things
   * against the opened copy — `tableNames` and `PRAGMA integrity_check` — and
   * publish an `integrityVerdict` on that basis. None of `structuralIntegrity`,
   * `truncatedImmutableLedgers`, `missingImmutabilityGuards`,
   * `regressedImmutableLedgers`, `elidedCommitmentLedgerRows` or
   * `contradictedChainCommitment` was consulted. Executed: a backup whose
   * committed `op_evidence` audit row had been erased verified
   * `{ verified: true, refusals: [], integrityVerdict: 'ok' }`, while the SAME
   * BYTES opened live gave `safeMode: true` with
   * `['append_only_guard_missing', 'append_only_ledger_truncated']`.
   *
   * `recordVerifiedBackup` then accepted that file into the append-only
   * `hq_reliability_backups`, and it is one of the two acts deliberately left
   * available DURING safe mode — so the designed workflow steered a Founder to
   * certify a recovery point at exactly the moment HQ had told them the store
   * could not be trusted, and the certification was permanent.
   *
   * `PRAGMA integrity_check` answers "are these B-trees well formed". It has
   * nothing to say about a ledger that was emptied with its guards temporarily
   * dropped, which is well-formed by construction. A file that would latch safe
   * mode is not a recovery point, so it is refused here rather than verified.
   */
  'would_latch_safe_mode',
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
  /**
   * What HQ can say about the file's soundness, in one line.
   *
   * `ok` means BOTH that `PRAGMA integrity_check` returned ok AND that HQ's own
   * append-only census found nothing blocking in the copy. It used to mean only
   * the first, while reading as the second — see `would_latch_safe_mode`.
   */
  integrityVerdict: string | null;
  /**
   * The BLOCKING findings HQ's own census raised against the opened copy, by
   * name, or `[]` when it raised none and `null` when the census never ran
   * (the file was refused before it could be opened).
   *
   * Named rather than counted, so a Founder reading a refusal is told which
   * guarantee the file fails rather than that it "failed a check".
   */
  blockingFindings: HqIntegrityFinding[] | null;
  /**
   * The path HQ actually opened, after resolving symlinked ancestors. Equal to
   * the candidate in the ordinary case; different when the caller named an
   * alias. It is what the register stores, so a backup record names the file
   * that was checked rather than a path that merely points at it.
   */
  resolvedPath: string | null;
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
 * verification never saw.
 *
 * **What that does and does not cover, stated exactly** (Wave 5 correction
 * round three, Medium A4). It refuses the live HQ database AT ITS OWN PATH,
 * because a live HQ database is WAL-mode and its `-wal` sits beside it. It used
 * to be described, here and in the phase document, as refusing "the live
 * database" full stop, and that was wrong in two ways the review executed:
 *
 *  - a HARD LINK to the live inode under a name with no sidecars beside it
 *    passed, because the sidecar check is keyed on the PATH. That is closed
 *    now, from the descriptor, by `file_has_multiple_links`;
 *  - a plain `cp` of a live WAL database may verify, and when it does, nothing
 *    in the bytes says it is missing anything. It is a different inode with no
 *    sidecars, and its content is whatever had been checkpointed into the main
 *    file at the moment it was copied — which can be a valid, integrity-clean
 *    HQ database missing the newest committed rows.
 *
 *    The claim that used to stand here — that such a copy "still verifies, and
 *    it always will" — was too strong in the other direction as well, and the
 *    review executed the counter-example (Wave 5 correction round four, Low
 *    L8): a `cp` of a live but UNCHECKPOINTED store was REFUSED
 *    `not_an_hq_database` with `schemaTables: 0`, because everything including
 *    the schema was still in the `-wal`. Only after
 *    `wal_checkpoint(TRUNCATE)` did the copy verify.
 *
 *    So the honest statement is neither "always verifies" nor "always refuses":
 *    a `cp` of a live WAL database is a copy of an arbitrary prefix of the
 *    truth, and it may read as sound, as empty, or as not a database at all,
 *    depending on where the checkpoint boundary fell. `verified` means "these
 *    bytes are a sound HQ database", and it has never meant "this is the whole
 *    of what was committed at the moment it was taken". Take a backup with
 *    SQLite's own backup API or after a checkpoint; a `cp` of a live database
 *    is not a backup, and this function is not the thing that can tell you so.
 *
 * Path protections are refusals, not exceptions, so a caller gets a
 * categorical reason it can record — see `BACKUP_REFUSAL_REASONS` for the
 * closed list and what each member means.
 *
 * A symlinked PARENT directory is RESOLVED and RECORDED rather than refused.
 * `lstat` and `O_NOFOLLOW` constrain the final component only, so an ancestor
 * link used to be followed silently and the register then named an alias as if
 * it were the file that had been checked. `realpathSync` now settles which file
 * this is; the resolved path is what is opened, what the sidecar check looks
 * beside, and what `resolvedPath` carries into the register. Refusing any
 * divergence was the other option and was rejected as disproportionate AND
 * non-portable — on macOS `os.tmpdir()` itself sits under a symlinked `/var`,
 * so honest backup paths would be refused.
 *
 * NOT covered, and recorded rather than implied: WHICH file an operator is
 * entitled to point at is a question this function does not answer; what it
 * answers is what the bytes at the descriptor it opened actually are. There is
 * deliberately no `file_changed_during_verification` refusal: a candidate
 * mutated mid-verification cannot produce a digest that disagrees with what was
 * checked, because the digest, the copy and the checks all come from one pass
 * over one descriptor. The race is closed by construction rather than detected
 * afterwards.
 */
export function verifyHqBackupFile(
  candidate: string,
  options: {
    /**
     * The path of the database THIS process is running on, when the caller
     * knows it. `recordVerifiedBackup` always passes it; a caller merely asking
     * "are these bytes a sound HQ database" has no live handle to name and
     * omits it. See `candidate_is_the_live_database`.
     */
    liveDatabasePath?: string | null;
  } = {},
): BackupVerification {
  const empty: BackupVerification = {
    verified: false,
    refusals: [],
    digest: null,
    sizeBytes: null,
    schemaTables: null,
    integrityVerdict: null,
    blockingFindings: null,
    resolvedPath: null,
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

  // WHICH file this is, settled once. An ancestor directory may be a symlink
  // even though the final component is not, and the register must name the
  // file HQ actually opened rather than an alias for it.
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    return { ...empty, refusals: ['path_missing'] };
  }

  // The LIVE database, refused on identity rather than on shape. Resolved on
  // both sides, so an alias, a symlinked ancestor or a differently-spelled
  // absolute path names the same file here (Wave 5 correction round six, Low 3).
  if (typeof options.liveDatabasePath === 'string' && options.liveDatabasePath !== '') {
    let live: string | null = null;
    try {
      live = fs.realpathSync(options.liveDatabasePath);
    } catch {
      // An in-memory handle, or a path this process can no longer resolve:
      // there is no live FILE to collide with, so this check contributes
      // nothing rather than refusing on a failed lookup.
    }
    if (live !== null && live === resolved) {
      return { ...empty, refusals: ['candidate_is_the_live_database'], resolvedPath: resolved };
    }
  }

  // BEFORE anything else, and beside the RESOLVED path, which is where SQLite
  // would look for them. SQLite resolves these together with the main file, so
  // their presence means the main file alone may not be the database an
  // operator would restore.
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      fs.lstatSync(`${resolved}${suffix}`);
      return { ...empty, refusals: ['sidecar_journal_present'], resolvedPath: resolved };
    } catch {
      // Absent is the expected case for a consolidated backup file.
    }
  }

  let scratchDir: string;
  try {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-backup-verify-'));
  } catch {
    return { ...empty, refusals: ['verification_copy_failed'], resolvedPath: resolved };
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
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
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
          return { ...empty, refusals: ['path_not_readable'], resolvedPath: resolved };
        }
        return { ...empty, refusals: ['path_not_a_regular_file'], resolvedPath: resolved };
      }
      // Taken from the DESCRIPTOR: from here on the path is never consulted.
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) {
        return { ...empty, refusals: ['path_not_a_regular_file'], resolvedPath: resolved };
      }
      // One inode, one name. See `file_has_multiple_links`: this is what closes
      // the hard link to the live database, which the path-keyed sidecar
      // refusal cannot see.
      if (opened.nlink > 1) {
        return { ...empty, refusals: ['file_has_multiple_links'], resolvedPath: resolved };
      }
      try {
        sinkFd = fs.openSync(scratchPath, 'wx', 0o600);
      } catch {
        return { ...empty, refusals: ['verification_copy_failed'], resolvedPath: resolved };
      }
      let proof: { digest: string; size: number } | 'too_large';
      try {
        proof = digestFile(fd, MAX_VERIFIED_BACKUP_BYTES, sinkFd);
      } catch {
        // A read or write that could not complete is a verification that did
        // not happen. Never a pass.
        return { ...empty, refusals: ['verification_copy_failed'], resolvedPath: resolved };
      }
      if (proof === 'too_large') {
        return { ...empty, refusals: ['file_too_large'], resolvedPath: resolved };
      }
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
      return {
        ...empty,
        refusals: ['not_a_readable_sqlite_database'],
        digest,
        sizeBytes,
        resolvedPath: resolved,
      };
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
        return {
          ...empty,
          refusals: ['not_a_readable_sqlite_database'],
          digest,
          sizeBytes,
          resolvedPath: resolved,
        };
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

      // HQ's OWN tamper detection, over the copy, before any verdict is
      // published (Wave 5 correction round ten, High 4). This is the same
      // `structuralIntegrity` a boot runs against the live file, so the
      // question a backup is asked is the question HQ asks of itself: are the
      // declared append-only guards present, do the ledgers still hold what
      // HQ's own durable commitments say they held, does the commitment ledger
      // satisfy its own identity, and does the evidence log still carry the
      // entry a commitment pins it to.
      //
      // READ-ONLY, and it must stay that way: the handle is
      // `openHqDatabaseReadOnly`, `structuralIntegrity` only reads, and no
      // `ensure*Schema` runs anywhere in this function. A verification that
      // repaired what it was checking would launder the tamper it exists to
      // find — the same boot-order rule `guardsMissingAsFound` exists for.
      //
      // `immutableTablesAbsentAsFound` is deliberately NOT passed. An absent
      // declared ledger is genuinely ambiguous in a BACKUP — an honest older
      // recovery point predates the phase that declared the table — and
      // `absentImmutableTables`' own doc says absence alone is not the
      // finding; what resolves it live is that HQ RE-CREATES what it declares,
      // and nothing is created here. So a backup older than a phase is not
      // refused for being old. Stated rather than glossed: this check catches
      // guards missing from a PRESENT ledger, a ledger emptied against HQ's
      // own marks, an elided commitment ledger and a contradicted chain
      // commitment. It does not catch a ledger the file never had.
      let blockingFindings: HqIntegrityFinding[] = [];
      try {
        const census = structuralIntegrity(db);
        blockingFindings = census.observations
          .filter((observation) => observation.blocking)
          .map((observation) => observation.finding);
      } catch {
        // A census that could not run is not a census that passed. The file
        // opened and answered `integrity_check`, so this is a shape this
        // module did not expect rather than a broken B-tree — either way it is
        // not a verified recovery point.
        blockingFindings = ['append_only_guard_missing'];
      }
      if (blockingFindings.length > 0) refusals.push('would_latch_safe_mode');

      return {
        verified: refusals.length === 0,
        refusals,
        digest,
        sizeBytes,
        schemaTables: tables.size,
        // The published verdict says what was actually established. `ok` used
        // to be printed over a file HQ's own census would have refused to run
        // on; now `ok` means both checks passed and anything else names which
        // one did not.
        integrityVerdict: (blockingFindings.length === 0
          ? integrityVerdict
          : `${integrityVerdict}; HQ append-only census: ${[...new Set(blockingFindings)].sort().join(', ')}`
        ).slice(0, 400),
        blockingFindings,
        resolvedPath: resolved,
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
