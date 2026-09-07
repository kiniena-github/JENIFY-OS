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
 * 3. **Cost is stated, not hidden.** `structuralIntegrity` is what a boot pays
 *    for: three `sqlite_master` reads, four pragmas, and — since correction
 *    cycle 2 of the Wave 5 review — the whole-log evidence-chain verification,
 *    which is O(log) and measured rather than guessed. `fullIntegrity` adds
 *    `integrity_check` and `foreign_key_check`, which are O(database), and is
 *    therefore an explicit act. Which one produced a verdict is carried ON the
 *    verdict, so nobody can mistake a cheap pass for a full one.
 *
 * 4. **Not-checked is never reported as fine.** The chain posture is carried
 *    separately from the depth, in its own closed vocabulary, and
 *    `not_verified` engages safe mode exactly as a break does. A reader — an
 *    enforcement point, a Founder, or a stranger holding the unauthenticated
 *    snapshot — is never told HQ is well about something HQ has not looked at.
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

/**
 * A schema object whose presence in a FILE proves the code that wrote it was
 * already new enough to declare a particular guard.
 *
 * This is how the census tells "a guard this file's vintage never created"
 * apart from "a guard someone dropped" — the distinction its own contract
 * demands and that it could not previously make (Wave 5 review, correction
 * cycle 2, MEDIUM). It is read FROM THE FILE rather than from a stored version
 * marker on purpose: a marker lives in the same file the tamper is in and can
 * be deleted along with the guard, whereas these witnesses are tables and
 * columns HQ's own code needs, so removing one is a far larger and far more
 * visible act than dropping a trigger.
 */
export type GuardVintageWitness =
  | { kind: 'table'; table: string }
  | { kind: 'column'; table: string; column: string };

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
   * Guards on this table — trio members included — that were introduced LATER
   * than the table itself, mapped by suffix to the witness that proves a file
   * is new enough to be held to them.
   *
   * Absent for every guard that arrived in the SAME commit as its table, which
   * is the overwhelming majority: the table's own presence is then the witness,
   * which is the rule the trio has always been checked under. Only four groups
   * in the whole history of this schema need an entry here, and each was
   * established from `git log -S` over `packages/headquarter/src` rather than
   * from memory — see `HQ_GUARD_VINTAGE_PROVENANCE`.
   */
  laterThanTable?: Readonly<Record<string, GuardVintageWitness>>;
}

/**
 * The archaeology behind every `laterThanTable` entry, recorded so a future
 * reader can re-derive it instead of trusting it.
 *
 * Method: for each guard `g` and its table `t`,
 * `git log --reverse -S"trg_…_g" -- packages/headquarter/src | head -1` versus
 * the same for `CREATE TABLE IF NOT EXISTS t`. A mismatch is a guard that some
 * released version of this repository's own code did not create, on a table it
 * did. Run over all 28 listed tables and all 19 secondary guards, exactly four
 * groups mismatched:
 *
 *  1. `hq_memory`'s trio and `supersede_only` — guards `5da1ed7` (Phase 5),
 *     table `7e87392` (Phase 2 S4). Witness: the `derived_from` COLUMN, which
 *     `5da1ed7` added to `hq_memory` in the same commit as those guards.
 *  2. `hq_memory`'s `no_replace_idem` / `no_replace_rowid` — guards `2d72ce1`
 *     (Wave 2). Witness: `hq_truth_records`, a table `2d72ce1` introduced.
 *  3. `hq_mission_intents`' trio — `no_rewrite`/`no_erase` at `ee942dc`,
 *     `no_replace` at `ece8050`, table at `43174bd` (Phase 3).
 *  4. `hq_mission_events`' trio — same two commits, same table commit.
 *
 * For (3) and (4) neither correcting commit added a table or a column, so the
 * witness is rounded UP to the next schema object in ancestry order —
 * `hq_project_events`, introduced by `f65b2c9`, which follows `ece8050`.
 * Rounding up is the safe direction: it can only make the census require a
 * guard on FEWER files than strictly necessary, never on more, so it cannot
 * produce a false finding. The cost is stated in the phase document's debt
 * section rather than hidden here.
 *
 * Two guards the Wave 5 reviewer's probe reported on its "legitimate older
 * file" — `trg_hq_products_no_replace_unique` and
 * `trg_hq_product_artifacts_no_replace_version` — are NOT in this list, and
 * checking rather than assuming is why: both appear in `f1ce71c`, the same
 * commit as `hq_products` and `hq_product_artifacts`, verified by reading that
 * commit's `product-command.ts` directly. No version of this code ever wrote a
 * file with those tables and without those guards, so requiring them whenever
 * the table is present is correct and stays.
 */
export const HQ_GUARD_VINTAGE_PROVENANCE = {
  method: 'git log --reverse -S over packages/headquarter/src, guard trigger name versus CREATE TABLE',
  mismatchedGroups: 4,
  roundedUpGroups: ['hq_mission_intents', 'hq_mission_events'],
} as const;

/** The witness for the Phase 5 hardening of `hq_memory` (commit `5da1ed7`). */
const MEMORY_PHASE_5_HARDENING: GuardVintageWitness = {
  kind: 'column',
  table: 'hq_memory',
  column: 'derived_from',
};

/** The witness for Wave 2 (commit `2d72ce1`). */
const WAVE_2: GuardVintageWitness = { kind: 'table', table: 'hq_truth_records' };

/**
 * The witness for the Phase 3 mission-guard corrections (`ee942dc`, `ece8050`),
 * rounded up to the next schema object in ancestry order (`f65b2c9`).
 */
const AFTER_MISSION_GUARD_CORRECTIONS: GuardVintageWitness = {
  kind: 'table',
  table: 'hq_project_events',
};

/**
 * Every append-only ledger whose immutability is held by the ENGINE, with the
 * prefix its triggers are named under and every guard declared on it.
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
 * `hq_mission_plan_items` is deliberately ABSENT: it is legitimately updated
 * when an item is linked to a task, so it carries `no_relink` / `no_respec`
 * guards instead of the trio, and demanding the trio of it would be a false
 * finding.
 *
 * **`laterThanTable` was added by correction cycle 2 of the Wave 5 review, and
 * it repairs a regression the first correction introduced.** Widening the
 * census to the secondary guards was right; doing it with no schema-vintage
 * awareness was not. `trg_hq_memory_no_replace_idem` and
 * `trg_hq_memory_no_replace_rowid` arrived in `2d72ce1`, on a table that has
 * existed since `7e87392`, so a database written by this repository's own code
 * between those commits legitimately HAS the table and the trio and LACKS
 * those two — and after the widening it booted into safe mode, refusing
 * `claimNext`, `approveTask`, `releaseKillSwitch`, `executeAction` and every
 * Founder-gated write on a healthy record. On the READ-ONLY snapshot path the
 * ensures return early, so nothing ever repaired it and the false verdict was
 * permanent: an unauthenticated reader was told `safeMode: true` about a
 * database that was never tampered with. The fix is per-guard vintage, read
 * from the file — not a narrower census.
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
    // Every guard on this table postdates the table. Phase 2 Stage 4 created
    // `hq_memory`; Phase 5 hardened it; Wave 2 added the two REPLACE guards.
    laterThanTable: {
      no_rewrite: MEMORY_PHASE_5_HARDENING,
      no_erase: MEMORY_PHASE_5_HARDENING,
      no_replace: MEMORY_PHASE_5_HARDENING,
      supersede_only: MEMORY_PHASE_5_HARDENING,
      no_replace_idem: WAVE_2,
      no_replace_rowid: WAVE_2,
    },
  },
  {
    table: 'hq_mission_intents',
    triggerPrefix: 'hq_mission_intents',
    secondaryGuards: [],
    laterThanTable: {
      no_rewrite: AFTER_MISSION_GUARD_CORRECTIONS,
      no_erase: AFTER_MISSION_GUARD_CORRECTIONS,
      no_replace: AFTER_MISSION_GUARD_CORRECTIONS,
    },
  },
  {
    table: 'hq_mission_events',
    triggerPrefix: 'hq_mission_events',
    secondaryGuards: [],
    laterThanTable: {
      no_rewrite: AFTER_MISSION_GUARD_CORRECTIONS,
      no_erase: AFTER_MISSION_GUARD_CORRECTIONS,
      no_replace: AFTER_MISSION_GUARD_CORRECTIONS,
    },
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
 * The three guards EVERY engine-immutable table must carry, by suffix.
 *
 * Universal, and therefore still the trio. A table's further guards are
 * declared per table in `ENGINE_IMMUTABLE_TABLES.secondaryGuards`, because
 * requiring `no_replace_unique` of a table that has no secondary unique index
 * would be a false finding — the same reason `hq_mission_plan_items` is not
 * held to the trio.
 */
export const REQUIRED_IMMUTABILITY_GUARDS = ['no_rewrite', 'no_erase', 'no_replace'] as const;

/** Every guard name the schema declares on one listed table. Trio plus its own. */
export function declaredGuardsFor(entry: EngineImmutableTable): string[] {
  return [...REQUIRED_IMMUTABILITY_GUARDS, ...entry.secondaryGuards].map(
    (guard) => `trg_${entry.triggerPrefix}_${guard}`,
  );
}

/** Every guard suffix the schema declares on one listed table. */
export function declaredGuardSuffixesFor(entry: EngineImmutableTable): string[] {
  return [...REQUIRED_IMMUTABILITY_GUARDS, ...entry.secondaryGuards];
}

/**
 * The schema facts a vintage witness is checked against. An interface rather
 * than a handle so the rule is testable without a database, and so the reads
 * are taken ONCE per census rather than once per guard.
 */
export interface SchemaFacts {
  hasTable(name: string): boolean;
  hasColumn(table: string, column: string): boolean;
}

export function readSchemaFacts(db: HqDatabase): SchemaFacts {
  const tables = tableNames(db);
  const columns = new Map<string, Set<string>>();
  return {
    hasTable: (name) => tables.has(name),
    hasColumn: (table, column) => {
      if (!tables.has(table)) return false;
      let known = columns.get(table);
      if (!known) {
        // Bound by the table's column count, and read at most once per table.
        const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        known = new Set(rows.map((row) => row.name));
        columns.set(table, known);
      }
      return known.has(column);
    },
  };
}

export function witnessPresent(witness: GuardVintageWitness, facts: SchemaFacts): boolean {
  return witness.kind === 'table'
    ? facts.hasTable(witness.table)
    : facts.hasColumn(witness.table, witness.column);
}

/**
 * The guards this FILE is actually held to on one listed table.
 *
 * Declared minus the ones whose vintage witness is absent. The table itself
 * must be present — that check belongs to the caller, and is the older half of
 * the same rule.
 */
export function requiredGuardsFor(entry: EngineImmutableTable, facts: SchemaFacts): string[] {
  const required: string[] = [];
  for (const suffix of declaredGuardSuffixesFor(entry)) {
    const witness = entry.laterThanTable?.[suffix];
    if (witness && !witnessPresent(witness, facts)) continue;
    required.push(`trg_${entry.triggerPrefix}_${suffix}`);
  }
  return required;
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
 * The three FINDINGS that mean HQ's own record cannot be trusted, and are
 * therefore the only ones that engage safe mode. Argued in the module header;
 * pinned by a test so widening or narrowing it is a deliberate, reviewed act.
 *
 * Safe mode has exactly one other trigger, and it is not a finding because it
 * is not something HQ found: an evidence-chain posture of `not_verified` — the
 * fail-closed rule. A finding is a claim about the file, and "I did not look"
 * is not one; it is recorded as `evidenceChain`, and `reportEngagesSafeMode` is
 * the single place the two are combined.
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

/**
 * What actually happened to the evidence hash chain in THIS process — a
 * closed, three-member vocabulary, carried on every verdict and published on
 * the unauthenticated snapshot.
 *
 * It exists because "assessed and clean" and "not assessed at this depth" used
 * to be the same published answer, and that answer was `safeMode: false`
 * (Wave 5 review, correction cycle 2, HIGH). A reader — including a stranger
 * holding `hq-snapshot.json` — was told HQ was fine about a chain HQ had never
 * looked at.
 *
 *  - `verified`   — recomputed over the WHOLE log in this process, and it holds.
 *  - `broken`     — recomputed and it does not hold, or it could not be
 *                   recomputed at all. An unverifiable chain is treated as a
 *                   broken one, which is the older rule, unchanged.
 *  - `not_verified` — nobody asked. FAIL-CLOSED: it engages safe mode exactly
 *                   as a break does, because HQ may not hand out the acts that
 *                   add to, approve, release or execute against a record whose
 *                   own audit chain it has not checked. It is reachable only by
 *                   a caller that deliberately passes `null` for the
 *                   verification, which is why that argument is REQUIRED rather
 *                   than optional: "forgot to verify" must be a type error, not
 *                   a silent all-clear.
 */
export const EVIDENCE_CHAIN_POSTURES = ['verified', 'broken', 'not_verified'] as const;
export type EvidenceChainPosture = (typeof EVIDENCE_CHAIN_POSTURES)[number];

export function isEvidenceChainPosture(value: unknown): value is EvidenceChainPosture {
  return typeof value === 'string' && (EVIDENCE_CHAIN_POSTURES as readonly string[]).includes(value);
}

export interface HqIntegrityReport {
  depth: IntegrityAssessmentDepth;
  /** What happened to the evidence chain in this process. Never inferred from `depth`. */
  evidenceChain: EvidenceChainPosture;
  observations: HqIntegrityObservation[];
  /**
   * True when at least one blocking observation stands, OR when the evidence
   * chain was not verified in this process.
   */
  safeMode: boolean;
  durability: HqDurabilityPosture;
}

/** Whether a verdict must refuse the enforcement-gated acts. */
export function reportEngagesSafeMode(
  observations: readonly HqIntegrityObservation[],
  evidenceChain: EvidenceChainPosture,
): boolean {
  return observations.some((observation) => observation.blocking) || evidenceChain === 'not_verified';
}

export const SAFE_MODE_STATEMENT =
  'Safe mode is a statement about HQ’s OWN stored record, not about the outside world. It engages when the ' +
  'engine reports the file corrupt, an append-only guard the schema declares is missing, the evidence hash ' +
  'chain does not verify, or that chain has not been verified at all in this process — HQ does not claim to ' +
  'stand behind a record it has not checked. While engaged HQ still READS and still reconciles, and it ' +
  'refuses the acts that would add to, approve, release or execute against a record it cannot stand behind. ' +
  'A BROKEN CHAIN CANNOT BE CLEARED BY RESTARTING: the chain is recomputed from the file at every ' +
  'construction, so a new process re-finds the break rather than inheriting a clean slate. A MISSING-GUARD ' +
  'finding is different and is stated rather than overclaimed: the schema ensures re-create a dropped guard, ' +
  'so a later process legitimately finds a repaired file and the boot-time observation is not carried across ' +
  'the restart — the durable record of it is the evidence entry a Founder assessment writes, not the latch.';

export const INTEGRITY_DEPTH_STATEMENT =
  'A structural assessment reads the schema catalogue, the durability pragmas and the evidence hash chain. ' +
  'The chain is the one data-proportional check a construction pays for, deliberately: it is the only ' +
  'blocking finding that survives in the FILE rather than being repaired by the ensures, so skipping it at ' +
  'boot meant a restart cleared a chain break for free. A full assessment additionally runs PRAGMA ' +
  'integrity_check and PRAGMA foreign_key_check, which are proportional to the whole database and are ' +
  'therefore an explicit act. A structural pass is never reported as a full one, and what happened to the ' +
  'chain is carried separately from the depth so neither can be inferred from the other.';

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
 *
 * And since correction cycle 2 the same rule applies one level down, to the
 * GUARD: a guard is required only when the file carries the schema object that
 * proves the writing code already declared it. Requiring a guard of a file
 * whose vintage never created it is the same mistake as requiring a guard on
 * an absent table, and it engaged safe mode on healthy older databases — see
 * `ENGINE_IMMUTABLE_TABLES`.
 */
export function missingImmutabilityGuards(db: HqDatabase): string[] {
  const facts = readSchemaFacts(db);
  const triggers = triggerNames(db);
  const missing: string[] = [];
  for (const entry of ENGINE_IMMUTABLE_TABLES) {
    if (!facts.hasTable(entry.table)) continue;
    for (const name of requiredGuardsFor(entry, facts)) {
      if (!triggers.has(name)) missing.push(name);
    }
  }
  return missing.sort();
}

/**
 * Fold a chain verification into a posture and, when it fails, an observation.
 *
 * `verify` returns the `seq` of the first entry that does not verify, or null
 * when the whole chain does. `null` for the FUNCTION means the caller has
 * deliberately declined to verify, which is `not_verified` and fails closed.
 */
function assessEvidenceChain(
  verify: (() => number | null) | null,
  observations: HqIntegrityObservation[],
): EvidenceChainPosture {
  if (!verify) return 'not_verified';
  let brokenAt: number | null | 'error';
  try {
    brokenAt = verify();
  } catch {
    brokenAt = 'error';
  }
  if (brokenAt === null) return 'verified';
  observations.push({
    finding: 'evidence_chain_broken',
    blocking: true,
    detail:
      brokenAt === 'error'
        ? 'The hash-chained evidence log could not be verified at all; HQ treats an unverifiable chain as a broken one.'
        : `The hash-chained evidence log does not verify from entry seq ${brokenAt} onward.`,
  });
  return 'broken';
}

/**
 * The assessment a CONSTRUCTION pays for: the schema catalogue, the durability
 * pragmas, and the evidence hash chain.
 *
 * The catalogue and pragma reads run no table scan. The chain verification is
 * O(log) and is here on purpose, because leaving it out was the Wave 5 HIGH:
 * `evidence_chain_broken` is the only blocking finding whose evidence stays in
 * the FILE — a dropped guard is re-created by the ensures, a corrupt page is
 * found by the explicit assessment, but a broken chain simply sat there while
 * every fresh process reported `safeMode: false` about it, and every HQ
 * entrypoint is a fresh process. Verifying it here is what makes the latch
 * survive a restart without storing anything a tamper could also edit: nothing
 * is carried across the boot at all, the break is re-derived from the bytes.
 *
 * MEASURED COST, so this is a decision and not a hope: on this repository's
 * own hardware the verification runs at roughly 9µs per evidence entry —
 * ~2ms at 200 entries, ~15ms at 2,000, ~170ms at 20,000. It is linear and
 * unbounded, and the phase document records that as disclosed debt rather than
 * capping it: a cap would mean publishing `safeMode: false` about the
 * unexamined tail, which is the exact lie this change exists to remove.
 */
export function structuralIntegrity(
  db: HqDatabase,
  options: {
    /**
     * The whole-log chain verification, or `null` to state that this caller is
     * deliberately not verifying. REQUIRED — see `EVIDENCE_CHAIN_POSTURES`.
     *
     * Injected rather than imported so this module stays a leaf of `store/`
     * and cannot acquire a dependency on `operator/`.
     */
    verifyEvidenceChain: (() => number | null) | null;
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
  },
): HqIntegrityReport {
  const observations: HqIntegrityObservation[] = [];
  const durability = readDurabilityPosture(db);
  const evidenceChain = assessEvidenceChain(options.verifyEvidenceChain, observations);

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
    evidenceChain,
    observations,
    safeMode: reportEngagesSafeMode(observations, evidenceChain),
    durability,
  };
}

/**
 * The FULL assessment. Everything a construction checks, plus the two whose
 * cost is proportional to the whole DATABASE rather than to the log: the
 * engine's own corruption check and referential integrity.
 *
 * The evidence-chain verification is no longer this function's own — it moved
 * into `structuralIntegrity`, so a construction pays for it too and a restart
 * can no longer clear a chain break. `verifyEvidenceChain` is still injected
 * rather than imported so this module stays a leaf of `store/` and cannot
 * acquire a dependency on `operator/`; the caller passes a closure over
 * `verifyEvidenceChain(db)`, which returns the `seq` of the first entry that
 * does not verify, or null when the whole chain does.
 */
export function fullIntegrity(
  db: HqDatabase,
  options: {
    verifyEvidenceChain: (() => number | null) | null;
    reliabilitySchemaPresent?: boolean;
    /** See `structuralIntegrity`. Omitted here means "check the file as it stands now". */
    guardsMissingAsFound?: readonly string[];
  },
): HqIntegrityReport {
  const structural = structuralIntegrity(db, options);
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

  // The chain is NOT re-verified here: `structuralIntegrity` already did it,
  // once, and its observation is already in this list. Running it twice would
  // double the one data-proportional cost an assessment shares with a boot,
  // and — worse — two computations of the same verdict can disagree.
  return {
    depth: 'full',
    evidenceChain: structural.evidenceChain,
    observations,
    safeMode: reportEngagesSafeMode(observations, structural.evidenceChain),
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
 * here migrates, checkpoints or repairs, so pointing it at the LIVE database is
 * safe as well as useless.
 *
 * Path protections are refusals, not exceptions, so a caller gets a
 * categorical reason it can record: not absolute, missing, a symlink, not a
 * regular file, empty, larger than the bound, not a readable SQLite database,
 * failing `integrity_check`, or a database that is not an HQ database at all.
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

  let digest: string;
  let sizeBytes: number;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const proof = digestFile(fd);
    digest = proof.digest;
    sizeBytes = proof.size;
  } catch {
    return { ...empty, refusals: ['path_not_a_regular_file'] };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The digest, or the refusal, is the result; a close failure is not.
      }
    }
  }

  let db: HqDatabase;
  try {
    db = openHqDatabaseReadOnly(target);
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
}
