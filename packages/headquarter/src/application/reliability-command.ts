/**
 * Phase 13 — Advanced Reliability: the RUN LEDGER, the recovery classification
 * and the verified-backup register.
 *
 * HQ has to survive crashes, restarts, duplicate calls, two processes, partial
 * provider failures and stale workers **without lying about what happened**.
 * That is one property, and it decomposes into five laws. Every function below
 * exists to keep one of them.
 *
 * 1. **A run is EXECUTION AUDIT; it is never task truth.** `op_tasks` plus
 *    `ActivityStatus` stay the only answer to "what is the state of this
 *    work"; `hq_missions` stays the only answer for a mission; the Phase 8
 *    `hq_action_intents` / `hq_action_events` ledger stays the only answer for
 *    an external action. A run row REFERENCES a canonical task (and optionally
 *    a mission and an action) and holds what none of them holds: which PROCESS
 *    was carrying the work, how many attempts it made, which correlation each
 *    attempt used, and what category of failure ended it. Nothing in HQ reads
 *    a run to decide eligibility, claiming, dispatch, approval, execution,
 *    release or a kill switch — pinned behaviourally in both directions and by
 *    a source scan of the four modules that decide whether work may run.
 *
 * 2. **An uncertain outcome is never retried automatically.** The whole point
 *    of the phase. A run whose attempt was interrupted while it could have
 *    reached the outside world becomes `needs_reconciliation` with outcome
 *    `outcome_unknown`, and `runAdmitsAttempt` returns false for it forever.
 *    Only a HUMAN reconciliation of `confirmed_not_executed` — a statement
 *    that somebody checked the real world and nothing happened — opens a new
 *    attempt generation. The rule is enforced twice: by this pure function and
 *    by a UNIQUE index on the attempt key, so two processes cannot both open
 *    the same generation even if one of them never ran this code.
 *
 * 3. **Fail closed on what HQ does not know.** A run whose capability cannot
 *    be read is treated as side-effecting, so an interrupted attempt on it is
 *    uncertain rather than conveniently "nothing happened". The safe answer is
 *    the one that costs a human a phone call, never the one that costs a
 *    duplicate external action.
 *
 * 4. **Recovery classifies; it never repairs and never reaches across
 *    ledgers.** Restart recovery closes or flags THIS ledger's runs, and
 *    REPORTS — as counts — the canonical work other ledgers already own and
 *    already know how to resolve: Phase 8 actions standing at `attempted` or
 *    `outcome_unknown`, tasks the queue moved to `outcome_unknown`, and tasks
 *    holding an expired lease. It writes not one row into any of them. A
 *    second writer into the action ledger is exactly the "second dispatch
 *    authority" the architecture forbids.
 *
 * 5. **Nothing here executes anything.** There is no adapter handle, no
 *    provider parameter, no target, no payload and no dispatch seam in this
 *    module. A run records that an attempt happened; the attempt itself is
 *    made by the canonical lane that owns it.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import {
  INTEGRITY_ASSESSMENT_DEPTHS,
  isHqIntegrityFinding,
  type IntegrityAssessmentDepth,
  type RecordedIntegrityVerdict,
} from '../store/integrity.js';
import {
  ACTION_RECONCILE_DECISIONS,
  isActionReconcileDecision,
  type ActionReconcileDecision,
} from './action-gateway.js';

/* ------------------------------------------------------------------ */
/* Vocabulary (categorical only)                                       */
/* ------------------------------------------------------------------ */

/**
 * What kind of work a run is carrying. Three, because these are the three
 * lanes HQ actually has that can be interrupted mid-flight. Metadata: the kind
 * selects nothing and authorizes nothing.
 */
export const RUN_KINDS = deepFreeze(['orchestration', 'external_action', 'dispatch'] as const);
export type RunKind = (typeof RUN_KINDS)[number];

export function isRunKind(value: unknown): value is RunKind {
  return typeof value === 'string' && (RUN_KINDS as readonly string[]).includes(value);
}

/**
 * What a STORED run kind can be once it has been read back — the same shape,
 * and the same reason, as `StoredRunEventKind` below. An append-only table
 * admits an APPEND, so a row carrying a kind outside the vocabulary is
 * representable even though no facade path produces one. It is carried as
 * `unrecognized` rather than quietly coerced into a real kind, because a count
 * that silently reported a forged string as `orchestration` would be a wrong
 * count published to an unauthenticated reader.
 */
export const STORED_RUN_KIND_UNRECOGNIZED = 'unrecognized' as const;
export type StoredRunKind = RunKind | typeof STORED_RUN_KIND_UNRECOGNIZED;

/**
 * The run's own categorical state, DERIVED from its append-only events.
 *
 * Deliberately disjoint from `ActivityStatus` (the canonical task vocabulary),
 * from `MissionStatus` and from `ActionState` — no member is shared, so no
 * reader and no code path can mistake one for another, and a test pins the
 * disjointness directly.
 */
export const RUN_STATES = deepFreeze(['open', 'attempting', 'needs_reconciliation', 'concluded'] as const);
export type RunState = (typeof RUN_STATES)[number];

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}

/**
 * What actually happened, as far as HQ can honestly say.
 *
 * `outcome_unknown` is a first-class member rather than an error case, and
 * `not_executed` means somebody established that nothing happened — it is
 * never assumed from silence.
 */
export const RUN_OUTCOMES = deepFreeze(['none', 'succeeded', 'failed', 'not_executed', 'outcome_unknown'] as const);
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === 'string' && (RUN_OUTCOMES as readonly string[]).includes(value);
}

/** The outcomes a worker may REPORT. `none` is the absence of a report, so it is not reportable. */
export const REPORTABLE_RUN_OUTCOMES: readonly RunOutcome[] = deepFreeze([
  'succeeded',
  'failed',
  'not_executed',
  'outcome_unknown',
]);

export function isReportableRunOutcome(value: unknown): value is RunOutcome {
  return isRunOutcome(value) && REPORTABLE_RUN_OUTCOMES.includes(value);
}

/**
 * WHY a run ended the way it did. Categorical, and there is deliberately no
 * numeric confidence, probability or severity anywhere beside it.
 */
export const RUN_FAILURE_CATEGORIES = deepFreeze([
  'none',
  'provider_unavailable',
  'provider_rejected',
  'process_interrupted',
  'stale_lease',
  'stale_fence',
  'duplicate_suppressed',
  'integrity_safe_mode',
  'cancelled',
  'unknown',
] as const);
export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];

export function isRunFailureCategory(value: unknown): value is RunFailureCategory {
  return typeof value === 'string' && (RUN_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The five interruption paths the phase is required to have an explicit answer
 * for. Each names a real way HQ loses sight of work, and each maps to a
 * classification rather than to a retry.
 */
export const RUN_INTERRUPTION_REASONS = deepFreeze([
  'process_interrupted',
  'stale_lease',
  'provider_outage',
  'partial_attempt',
  'stale_fence',
] as const);
export type RunInterruptionReason = (typeof RUN_INTERRUPTION_REASONS)[number];

export function isRunInterruptionReason(value: unknown): value is RunInterruptionReason {
  return typeof value === 'string' && (RUN_INTERRUPTION_REASONS as readonly string[]).includes(value);
}

/**
 * The append-only history of one run.
 *
 * `worker_report` is the LATE statement — the correction to the Wave 5
 * correction. A worker whose live attempt was classified `interrupted` by a
 * concurrent recovery still holds the live fenced claim and is still the only
 * entity that saw what happened, so it must be able to say so. What it must
 * NOT be able to do is CLOSE the run: closing a `needs_reconciliation` run is
 * `reconcileRun`'s job, and that path demands an independent principal, a
 * step-up, and an idempotent capability before it will reopen anything. A
 * `worker_report` is therefore folded into the record as testimony and moves
 * no state; `outcome_recorded` stays what it always was, the close of an OPEN
 * attempt.
 */
export const RUN_EVENT_KINDS = deepFreeze([
  'opened',
  'attempt_started',
  'outcome_recorded',
  'worker_report',
  'interrupted',
  'reconciled',
] as const);
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/**
 * What a STORED event kind can be once it has been read back.
 *
 * `unrecognized` is not writable and is not a kind of event — it is the
 * reading HQ gives to a row whose `kind` is outside the closed vocabulary.
 * `hq_reliability_run_events` is append-only, and an APPEND is the write its
 * triggers deliberately permit, so a forged kind is representable in the file
 * even though no facade path can produce one. Carrying it as a distinct
 * reading rather than silently coercing it to a real kind is what lets the
 * derivation FAIL CLOSED on it: an event HQ cannot interpret means HQ does not
 * know what happened, which is `needs_reconciliation`, not a conclusion.
 */
export const STORED_RUN_EVENT_UNRECOGNIZED = 'unrecognized' as const;
export type StoredRunEventKind = RunEventKind | typeof STORED_RUN_EVENT_UNRECOGNIZED;

/**
 * Reconciliation reuses the Phase 8 vocabulary VERBATIM rather than defining a
 * near-identical one. Same judgement, same three answers, same authority — a
 * second spelling of "somebody checked the real world" is precisely the kind
 * of drift this phase exists to prevent.
 */
export const RUN_RECONCILE_DECISIONS = ACTION_RECONCILE_DECISIONS;
export type RunReconcileDecision = ActionReconcileDecision;
export const isRunReconcileDecision = isActionReconcileDecision;

export const RUN_LEDGER_STATEMENT =
  'A run is EXECUTION AUDIT. The canonical answer to “what is the state of this work” is the op_tasks row it ' +
  'references; for a mission it is hq_missions; for an external action it is the Phase 8 action ledger. ' +
  'Nothing in HQ reads a run state to decide eligibility, claiming, dispatch, approval, execution, release or ' +
  'a kill switch, and no run path can execute anything.';

export const RUN_RETRY_STATEMENT =
  'An interrupted attempt that could have reached the outside world is recorded as outcome_unknown and is ' +
  'NEVER retried automatically. Only a human reconciliation of confirmed_not_executed — a statement that the ' +
  'real world was checked and nothing happened — opens a further attempt generation, and only for an ' +
  'idempotent capability. A worker that still holds the live fenced claim may REPORT what it observed against ' +
  'such a run; that report is recorded as testimony beside the interruption and closes nothing, because the ' +
  'entity whose own attempt is in doubt is not the one that gets to end the doubt.';

export const RECOVERY_SCOPE_STATEMENT =
  'Restart recovery classifies runs in THIS ledger and writes nothing into any other. Interrupted canonical ' +
  'work owned elsewhere — Phase 8 actions awaiting reconciliation, tasks the queue moved to outcome_unknown, ' +
  'tasks holding an expired lease — is REPORTED as counts, with the canonical path that resolves each, and is ' +
  'left exactly where it stands.';

/* ------------------------------------------------------------------ */
/* Capability (the CONFIGURATION vs INVOCATION trio)                   */
/* ------------------------------------------------------------------ */

/**
 * The capability behind the two FOUNDER acts of this phase: assessing the
 * store's integrity, and recording a verified backup.
 *
 * NOT registered automatically: a deployment that wants them calls
 * `registerReliabilityCommandCapability` as a deliberate configuration
 * action, and until then both fail closed.
 *
 * `sideEffect: false` is honest — an assessment reads pragmas and the schema
 * catalogue, and recording a backup reads a file and appends a row. Neither
 * reaches anything outside HQ. The risk class is `founder_gate` because
 * declaring the store healthy, or declaring a file a valid recovery point, is
 * a Founder statement.
 *
 * Recovery and reconciliation deliberately do NOT sit behind this capability:
 * they sit behind approval authority plus independence, exactly like
 * `reconcileAction`, because they are judgements about what happened rather
 * than grants to do something.
 */
export const RELIABILITY_COMMAND_CAPABILITY = deepFreeze({
  id: 'hq.reliability_command',
  description:
    'Founder reliability command — assesses HQ store integrity and durability, and records a verified ' +
    'backup as a recovery point. Reads and appends only; repairs nothing, restores nothing, executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the reliability-command capability — a CONFIGURATION action. */
export function registerReliabilityCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...RELIABILITY_COMMAND_CAPABILITY });
}

export const RELIABILITY_COMMAND_RESERVED_CONTRACT = deepFreeze({
  riskClass: RELIABILITY_COMMAND_CAPABILITY.riskClass,
  sideEffect: RELIABILITY_COMMAND_CAPABILITY.sideEffect,
  idempotent: RELIABILITY_COMMAND_CAPABILITY.idempotent,
} as const);

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function reliabilityCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== RELIABILITY_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== RELIABILITY_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== RELIABILITY_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type ReliabilityCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry's current row from an ENFORCEMENT-SAFE read; never repairs. */
export function reliabilityCommandCapabilityState(
  capability: Capability | null,
): ReliabilityCommandCapabilityState {
  if (!capability) return 'missing';
  if (reliabilityCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

export const MAX_RUN_NOTE_LENGTH = 500;
export const MAX_RUN_LABEL_LENGTH = 120;
export const MAX_BACKUP_PATH_LENGTH = 1000;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const RUN_READ_LIMIT = 50;
export const BACKUP_READ_LIMIT = 25;
/** Runs carried in the unauthenticated snapshot section: none (counts only). */
export const RUN_SNAPSHOT_LIMIT = 0;

/* ------------------------------------------------------------------ */
/* Schema — three tables, all INSERT-only BY ENGINE                    */
/* ------------------------------------------------------------------ */

/**
 * The full Phase 7/8/12 trigger set on all three tables: no UPDATE of any
 * column, no DELETE, a BEFORE INSERT guard on `id`/`seq` that closes REPLACE
 * and UPSERT, and a second BEFORE INSERT guard on every SECONDARY unique
 * index.
 *
 * That second guard is load-bearing HERE in a way it is nowhere else. The
 * unique index on `hq_reliability_run_events.attempt_key` IS the cross-process
 * duplicate-attempt guard: a REPLACE colliding on it would delete the standing
 * reservation without any BEFORE DELETE firing (`recursive_triggers` is off by
 * default and connection-scoped), freeing an attempt generation for a second
 * real execution of the same work. The same reasoning applies to
 * `hq_reliability_runs.run_key`, which is the duplicate-run guard.
 */
const RELIABILITY_DDL = `
CREATE TABLE IF NOT EXISTS hq_reliability_runs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  action_id TEXT,
  capability_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  claim_fence INTEGER NOT NULL,
  claim_nonce TEXT,
  process_id TEXT NOT NULL,
  label TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  run_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_reliability_runs_task ON hq_reliability_runs(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_hq_reliability_runs_process ON hq_reliability_runs(process_id, seq);

CREATE TABLE IF NOT EXISTS hq_reliability_run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  process_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  attempt_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_reliability_run_events_run ON hq_reliability_run_events(run_id, seq);
-- ONE attempt per generation, enforced by the engine across processes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_reliability_run_events_attempt
  ON hq_reliability_run_events(attempt_key) WHERE attempt_key IS NOT NULL;

-- The VERDICT ledger: what HQ has said about its own integrity, appended once
-- per full assessment and re-read at every construction. Without it the
-- safe-mode latch lived only in one process's memory, and a plain restart
-- cleared an evidence_chain_broken verdict (Wave 5 review, High finding 1).
-- Trio only: every assessment is a NEW row, so there is no secondary identity
-- a REPLACE could collide on, and requiring a no_replace_unique guard of a
-- table with no secondary unique index would be a false finding.
CREATE TABLE IF NOT EXISTS hq_reliability_verdicts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  assessed_at TEXT NOT NULL,
  depth TEXT NOT NULL,
  safe_mode INTEGER NOT NULL,
  findings TEXT NOT NULL,
  process_id TEXT NOT NULL,
  assessed_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_reliability_verdicts_seq ON hq_reliability_verdicts(seq);

CREATE TABLE IF NOT EXISTS hq_reliability_backups (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  backup_path TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  schema_tables INTEGER NOT NULL,
  verified_at TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  process_id TEXT NOT NULL,
  note TEXT,
  record_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_reliability_backups_digest ON hq_reliability_backups(content_digest, seq);

CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_runs_no_rewrite
BEFORE UPDATE ON hq_reliability_runs
BEGIN SELECT RAISE(ABORT, 'hq_reliability_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_runs_no_erase
BEFORE DELETE ON hq_reliability_runs
BEGIN SELECT RAISE(ABORT, 'hq_reliability_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_runs_no_replace
BEFORE INSERT ON hq_reliability_runs
WHEN EXISTS (SELECT 1 FROM hq_reliability_runs WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_reliability_runs WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_reliability_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_runs_no_replace_unique
BEFORE INSERT ON hq_reliability_runs
WHEN EXISTS (SELECT 1 FROM hq_reliability_runs WHERE run_key = NEW.run_key)
BEGIN SELECT RAISE(ABORT, 'hq_reliability_runs is append-only (unique run_key already held)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_run_events_no_rewrite
BEFORE UPDATE ON hq_reliability_run_events
BEGIN SELECT RAISE(ABORT, 'hq_reliability_run_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_run_events_no_erase
BEFORE DELETE ON hq_reliability_run_events
BEGIN SELECT RAISE(ABORT, 'hq_reliability_run_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_run_events_no_replace
BEFORE INSERT ON hq_reliability_run_events
WHEN EXISTS (SELECT 1 FROM hq_reliability_run_events WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_reliability_run_events WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_reliability_run_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_run_events_no_replace_attempt
BEFORE INSERT ON hq_reliability_run_events
WHEN NEW.attempt_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM hq_reliability_run_events WHERE attempt_key = NEW.attempt_key)
BEGIN SELECT RAISE(ABORT, 'hq_reliability_run_events is append-only (UNIQUE attempt_key already reserved)'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_verdicts_no_rewrite
BEFORE UPDATE ON hq_reliability_verdicts
BEGIN SELECT RAISE(ABORT, 'hq_reliability_verdicts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_verdicts_no_erase
BEFORE DELETE ON hq_reliability_verdicts
BEGIN SELECT RAISE(ABORT, 'hq_reliability_verdicts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_verdicts_no_replace
BEFORE INSERT ON hq_reliability_verdicts
WHEN EXISTS (SELECT 1 FROM hq_reliability_verdicts WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_reliability_verdicts WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_reliability_verdicts is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_backups_no_rewrite
BEFORE UPDATE ON hq_reliability_backups
BEGIN SELECT RAISE(ABORT, 'hq_reliability_backups is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_backups_no_erase
BEFORE DELETE ON hq_reliability_backups
BEGIN SELECT RAISE(ABORT, 'hq_reliability_backups is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_backups_no_replace
BEFORE INSERT ON hq_reliability_backups
WHEN EXISTS (SELECT 1 FROM hq_reliability_backups WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_reliability_backups WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_reliability_backups is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_reliability_backups_no_replace_unique
BEFORE INSERT ON hq_reliability_backups
WHEN EXISTS (SELECT 1 FROM hq_reliability_backups WHERE record_key = NEW.record_key)
BEGIN SELECT RAISE(ABORT, 'hq_reliability_backups is append-only (unique record_key already held)'); END;

`;

/**
 * Idempotent; safe on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle: `hq:snapshot` legitimately builds
 * the service over `openHqDatabaseReadOnly`, and a pre-Phase-13 file must be
 * OBSERVED truthfully (`reliabilitySchemaPresent`), never migrated by a path
 * that promised to write nothing.
 */
export function ensureReliabilitySchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(RELIABILITY_DDL);
}

/** True when this file carries the Phase 13 ledger — observation, never migration. */
export function reliabilitySchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_reliability_runs'`)
      .get() !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * The derived dedupe key for a RUN.
 *
 * The caller's `idempotencyKey` is an INPUT to the digest, never the key
 * itself — the mission/project/memory/truth/product rule — so an identical
 * open dedupes to the standing run and a deliberately fresh one is possible.
 *
 * The claim fence is deliberately NOT an input. A run belongs to the WORK, not
 * to one claim of it: if a worker crashes and the task is claimed again, the
 * second open must find the first run and inherit its unresolved outcome
 * rather than silently starting a clean one beside it. That is the whole
 * cross-restart duplicate guard, and putting the fence in the key would defeat
 * it.
 *
 * **The free-text `label` is not an input either, and used to be** (Wave 5
 * review, Medium finding 4). A label is display text, not identity, so
 * including it meant re-opening the same work under a different wording
 * produced a DIFFERENT key, a second run beside the first, and an attempt
 * admitted on it — while the first run stood at `needs_reconciliation` with an
 * unknown outcome. That is precisely the duplicate irreversible act the phase
 * exists to prevent, reachable by renaming. Identity is now the canonical
 * facts alone; the facade refuses the second open outright when the task
 * already carries an unreconciled run, so the two halves close it in both
 * directions.
 *
 * The other correction lane found the same defect and reproduced it at the
 * smallest possible scale: changing `'publish the thing'` to `'publish the
 * thing.'` opened a SECOND run on the same task, same worker and same live
 * fence, with a fresh admitted attempt, beside a run standing at
 * `needs_reconciliation` / `outcome_unknown` for that very work. A law that
 * says "never retried" cannot be keyed on a description. The label remains a
 * stored, bounded, secret-scanned human note on the run; it identifies nothing.
 *
 * That left a collision the correction did not state, and `openRun` now closes
 * it (Wave 5 Medium 4). `idempotencyKey` is optional, so the DEFAULT shape of
 * two different runs on one task derives one key — and the second open was
 * silently deduplicated onto the first, returning `ok` with the other work's
 * label. `openRun` compares the stored label before deduplicating and refuses
 * a mismatch as `run_key_conflict`; a caller with genuinely separate work on
 * one task passes a distinct `idempotencyKey`. Dedupe still happens for the
 * case the key exists for: the same work opened again after a crash and a
 * re-claim, where the label is the same because the work is.
 */
export function runIdempotencyKey(input: {
  taskId: string;
  runKind: RunKind;
  actionId: string | null;
  missionId: string | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        taskId: input.taskId,
        runKind: input.runKind,
        actionId: input.actionId,
        missionId: input.missionId,
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest('hex');
  return `run:${digest.slice(0, 32)}`;
}

/**
 * The durable per-generation attempt reservation. Backed by a UNIQUE partial
 * index, so the ENGINE refuses a second attempt of the same generation even
 * when the two callers are different processes that never shared memory.
 */
export function runAttemptKey(runKey: string, generation: number): string {
  return `${runKey}#${generation}`;
}

/** The derived dedupe key for a backup record: one record per (path, digest). */
export function backupRecordKey(input: { backupPath: string; contentDigest: string }): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `backup:${digest.slice(0, 32)}`;
}

/* ------------------------------------------------------------------ */
/* Stored rows                                                         */
/* ------------------------------------------------------------------ */

export interface RunRow {
  seq: number;
  id: string;
  runKind: StoredRunKind;
  taskId: string;
  missionId: string | null;
  actionId: string | null;
  capabilityId: string;
  workerId: string;
  claimFence: number;
  claimNonce: string | null;
  processId: string;
  label: string;
  openedAt: string;
  runKey: string;
}

export interface RunEventRow {
  seq: number;
  id: string;
  runId: string;
  kind: StoredRunEventKind;
  actor: string;
  at: string;
  processId: string;
  detail: Record<string, unknown>;
  attemptKey: string | null;
}

export interface BackupRow {
  seq: number;
  id: string;
  backupPath: string;
  contentDigest: string;
  sizeBytes: number;
  schemaTables: number;
  verifiedAt: string;
  verifiedBy: string;
  processId: string;
  note: string | null;
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    // Read through the vocabulary check: a legal APPEND carrying a string
    // outside the closed set must not become a typed member by assertion, and
    // must not be coerced into a real kind either — see
    // `STORED_RUN_KIND_UNRECOGNIZED`.
    runKind: (isRunKind(r.run_kind) ? r.run_kind : STORED_RUN_KIND_UNRECOGNIZED) as StoredRunKind,
    taskId: r.task_id as string,
    missionId: (r.mission_id as string | null) ?? null,
    actionId: (r.action_id as string | null) ?? null,
    capabilityId: r.capability_id as string,
    workerId: r.worker_id as string,
    claimFence: Number(r.claim_fence),
    claimNonce: (r.claim_nonce as string | null) ?? null,
    processId: r.process_id as string,
    label: r.label as string,
    openedAt: r.opened_at as string,
    runKey: r.run_key as string,
  };
}

function rowToRunEvent(r: Record<string, unknown>): RunEventRow {
  const kind = String(r.kind);
  return {
    seq: r.seq as number,
    id: r.id as string,
    runId: r.run_id as string,
    // Read through the vocabulary, never asserted into it. See
    // `STORED_RUN_EVENT_UNRECOGNIZED` for why an unreadable kind is carried as
    // such rather than coerced into a real one.
    kind: ((RUN_EVENT_KINDS as readonly string[]).includes(kind)
      ? kind
      : STORED_RUN_EVENT_UNRECOGNIZED) as StoredRunEventKind,
    actor: r.actor as string,
    at: r.at as string,
    processId: r.process_id as string,
    detail: safeDetail(r.detail),
    attemptKey: (r.attempt_key as string | null) ?? null,
  };
}

function safeDetail(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToBackup(r: Record<string, unknown>): BackupRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    backupPath: r.backup_path as string,
    contentDigest: r.content_digest as string,
    sizeBytes: Number(r.size_bytes),
    schemaTables: Number(r.schema_tables),
    verifiedAt: r.verified_at as string,
    verifiedBy: r.verified_by as string,
    processId: r.process_id as string,
    note: (r.note as string | null) ?? null,
  };
}

export function loadRun(db: HqDatabase, id: string): RunRow | null {
  const row = db.prepare(`SELECT * FROM hq_reliability_runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

export function loadRunByKey(db: HqDatabase, runKey: string): RunRow | null {
  const row = db.prepare(`SELECT * FROM hq_reliability_runs WHERE run_key = ?`).get(runKey) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

export function loadRuns(db: HqDatabase): RunRow[] {
  return (
    db.prepare(`SELECT * FROM hq_reliability_runs ORDER BY seq`).all() as Record<string, unknown>[]
  ).map(rowToRun);
}

export function loadRunEvents(db: HqDatabase, runId: string): RunEventRow[] {
  return (
    db
      .prepare(`SELECT * FROM hq_reliability_run_events WHERE run_id = ? ORDER BY seq`)
      .all(runId) as Record<string, unknown>[]
  ).map(rowToRunEvent);
}

export function loadBackupRecords(db: HqDatabase): BackupRow[] {
  return (
    db.prepare(`SELECT * FROM hq_reliability_backups ORDER BY seq`).all() as Record<string, unknown>[]
  ).map(rowToBackup);
}

/* ------------------------------------------------------------------ */
/* The verdict ledger — the safe-mode latch, made durable               */
/* ------------------------------------------------------------------ */

/**
 * True when this file carries the verdict ledger.
 *
 * Checked separately from `reliabilitySchemaPresent`, because a database
 * written by a build BEFORE the Wave 5 correction carries the Phase 13 run
 * ledger and not this table. Observation, never migration: a read-only handle
 * over such a file reports the absence and the verdict is process-local there,
 * which `SAFE_MODE_STATEMENT` says in words rather than glossing over.
 */
export function integrityVerdictLedgerPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_reliability_verdicts'`)
      .get() !== undefined
  );
}

/**
 * The kind of evidence entry an assessment appends beside the verdict it
 * records. One spelling, read by the corroboration check below and written by
 * the two places that record a verdict.
 */
export const INTEGRITY_ASSESSED_EVIDENCE_KIND = 'hq_integrity_assessed';

/**
 * Is this verdict row CORROBORATED by the hash-chained evidence log?
 *
 * `assessHqIntegrity` and the construction-time observation each write the
 * verdict row and an `hq_integrity_assessed` evidence entry naming that row's
 * id, inside ONE reservation, so the pair lands together or not at all. A
 * verdict row that arrived any other way has no such entry.
 *
 * `json_valid` guards the extract, because `op_evidence.payload` is an
 * append-only column a raw writer can put anything in and an unparseable row
 * must be inert here rather than an exception.
 */
function verdictIsCorroborated(db: HqDatabase, verdictId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM op_evidence
          WHERE kind = ?
            AND json_valid(payload)
            AND json_extract(payload, '$.verdictId') = ?
          LIMIT 1`,
      )
      .get(INTEGRITY_ASSESSED_EVIDENCE_KIND, verdictId) as { ok: number } | undefined;
    return row !== undefined;
  } catch {
    // No evidence log to corroborate against is not corroboration. Fail closed:
    // an uncorroborated CLEAR does not clear.
    return false;
  }
}

function rowToRecordedVerdict(row: Record<string, unknown>): RecordedIntegrityVerdict {
  const depth = String(row.depth);
  return {
    assessedAt: String(row.assessed_at),
    // Read through the vocabulary, never asserted into it. An unreadable depth
    // is reported as the CHEAP one, so a forged row can never make a structural
    // pass look like a full assessment.
    depth: (INTEGRITY_ASSESSMENT_DEPTHS as readonly string[]).includes(depth)
      ? (depth as IntegrityAssessmentDepth)
      : 'structural',
    safeMode: Number(row.safe_mode) === 1,
    // Every finding is read through `isHqIntegrityFinding`, so a row appended by
    // a raw writer can never introduce a finding name outside the closed
    // vocabulary — a forged string is dropped rather than carried, exactly as
    // the snapshot folds it to `unrecognized` rather than publishing it.
    findings: jsonStringArray(row.findings).filter(isHqIntegrityFinding),
  };
}

/**
 * The verdict that STANDS about this database, or null.
 *
 * Not simply the last row, and the difference is the whole point (Wave 5
 * correction round three, Medium A7). An APPEND is exactly the write this
 * table's triggers deliberately permit, so one raw
 * `INSERT INTO hq_reliability_verdicts ... safe_mode = 0` used to clear a
 * latched safe mode outright — and the boot's own pass is STRUCTURAL, which by
 * design cannot see a broken evidence chain, so an `evidence_chain_broken`
 * engagement was not re-derived either. `releaseKillSwitch` and `claimNext`
 * were handed straight back out. Meanwhile `SAFE_MODE_STATEMENT`, shipped
 * verbatim on every reliability view, in every refusal and in the
 * unauthenticated snapshot, asserted that "only a fresh full assessment that
 * finds nothing blocking" clears it. The sentence is now true rather than
 * softened:
 *
 *  - a verdict that says ENGAGED stands, whoever appended it. Appending one is
 *    the fail-safe direction (a denial of service at worst), so it needs no
 *    corroboration;
 *  - a verdict that says CLEAR clears only if the hash-chained evidence log
 *    carries the entry that names it. Both writers of a verdict append that
 *    entry inside the same reservation; nothing else can produce the pair
 *    without also writing into the evidence chain.
 *
 * An uncorroborated clear is not an error and is not a finding — it is simply
 * not a verdict, so the walk continues to the row behind it. That keeps the
 * rule monotone: appending noise can never lower the standing verdict, and can
 * only ever raise it.
 *
 * **The residual, stated rather than glossed.** HQ holds no key a foreign
 * writer does not also have, so a writer that already holds the file open can
 * forge the evidence entry too — at the cost of appending to the hash chain,
 * which is itself now guarded by the engine and by a durable length commitment
 * (see `verifyEvidenceChain`). Against that writer this is a real barrier and
 * not a cryptographic boundary, which is the same residual recorded for
 * `hq_reliability_run_events`. What it closes completely is the thing it was
 * built for: one appended row, and a plain restart, silently lowering a verdict
 * HQ had already reached.
 *
 * **The upgrade consequence, recorded honestly.** A verdict written by a build
 * before this change carries no paired evidence entry, so a CLEAR from such a
 * build no longer clears. If an older blocking verdict stands behind it, that
 * database boots into safe mode once and a Founder full assessment clears it.
 * That is the fail-closed direction and the documented cost of the mechanism.
 */
export function standingIntegrityVerdict(db: HqDatabase): RecordedIntegrityVerdict | null {
  if (!integrityVerdictLedgerPresent(db)) return null;
  const rows = db
    .prepare(`SELECT * FROM hq_reliability_verdicts ORDER BY seq DESC`)
    .all() as Record<string, unknown>[];
  for (const row of rows) {
    const verdict = rowToRecordedVerdict(row);
    if (verdict.safeMode) return verdict;
    if (verdictIsCorroborated(db, String(row.id))) return verdict;
  }
  return null;
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Append one verdict. Called from inside the assessment's own reservation. */
export function appendIntegrityVerdict(
  db: HqDatabase,
  input: {
    id: string;
    assessedAt: string;
    depth: IntegrityAssessmentDepth;
    safeMode: boolean;
    findings: readonly string[];
    processId: string;
    assessedBy: string;
  },
): void {
  db.prepare(
    `INSERT INTO hq_reliability_verdicts
       (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.assessedAt,
    input.depth,
    input.safeMode ? 1 : 0,
    // Categorical names only. The same closed vocabulary the snapshot uses.
    JSON.stringify(input.findings.filter(isHqIntegrityFinding)),
    input.processId,
    input.assessedBy,
  );
}

/* ------------------------------------------------------------------ */
/* The pure derivation core                                            */
/* ------------------------------------------------------------------ */

export interface RunEventView {
  kind: StoredRunEventKind;
  actor: string;
  at: string;
  processId: string;
  detail: Record<string, unknown>;
}

/**
 * The ONE browser-safe projection of a run, shared by the control route and
 * every facade read so the two can never disagree.
 *
 * Absent by shape: the derived `run_key` and `attempt_key` (a durable
 * reservation identity is not a thing a reader needs and not a thing a caller
 * should be able to echo back), and the claim nonce.
 */
export interface RunRecord {
  id: string;
  seq: number;
  runKind: StoredRunKind;
  taskId: string;
  missionId: string | null;
  actionId: string | null;
  capabilityId: string;
  workerId: string;
  claimFence: number;
  /** The process that OPENED the run. A restart is visible as a different one. */
  processId: string;
  label: string;
  openedAt: string;
  /** DERIVED from the append-only events; never a stored column. */
  state: RunState;
  outcome: RunOutcome;
  failureCategory: RunFailureCategory;
  /** How many attempts were STARTED. A count of reservations, not of successes. */
  attempts: number;
  /** The generation a further attempt would take, if one were admitted at all. */
  nextGeneration: number;
  lastCorrelationId: string | null;
  interruption: { reason: RunInterruptionReason; at: string; uncertain: boolean } | null;
  reconciliation: { by: string; at: string; decision: RunReconcileDecision; note: string } | null;
  /**
   * True while a further attempt is REFUSED. `false` for every state except an
   * unopened run and one reopened by a `confirmed_not_executed` reconciliation
   * — the "never retry an uncertain side effect" law, in the projection.
   */
  admitsAttempt: boolean;
  needsReconciliation: boolean;
  /**
   * True when the run's MOST RECENT event is an `interrupted` one — a recovery
   * pass classified it and nothing has been reported or reconciled since.
   *
   * It exists because `process_id` proves "not the process running the
   * recovery", never "dead" (Wave 5 Medium 1). A live worker mid-attempt whose
   * run is classified by a concurrent recovery would otherwise be permanently
   * unable to say what actually happened: its truthful `recordRunOutcome` was
   * refused `run_state_conflict`, and only a human guess could close the run.
   * A worker still holding the LIVE FENCED CLAIM — which a genuinely dead
   * process cannot — may make ONE late statement about a run in this position.
   *
   * That statement is `worker_report`, and the distinction is the whole
   * correction: the first attempt at this let the worker append
   * `outcome_recorded`, which concluded the run, cleared
   * `needsReconciliation`, and thereby lifted the `openRun` guard that refuses
   * a second run on a task whose last word is "HQ does not know" — so the
   * worker whose own attempt was in doubt could re-admit a duplicate
   * irreversible act with no human anywhere in the loop. A `worker_report`
   * records what the worker saw and moves nothing.
   */
  interruptedWithoutReport: boolean;
  /**
   * The late statement a worker made about a run standing at
   * `needs_reconciliation` — testimony, never a verdict.
   *
   * Present only when a `worker_report` event was appended (or when a stored
   * `outcome_recorded` landed on a run already standing at
   * `needs_reconciliation`, which no facade path produces but a raw append
   * can). It is carried BESIDE `state` and `outcome`, which stay
   * `needs_reconciliation` / `outcome_unknown`: HQ still does not know what
   * happened, it knows what the worker says happened. `reconcileRun` — an
   * independent principal, a step-up, and the idempotency rule — remains the
   * only thing that closes the run.
   */
  workerReport: RunWorkerReport | null;
  events: RunEventView[];
}

/** One late worker statement about an interrupted run. Categorical plus a bounded note. */
export interface RunWorkerReport {
  by: string;
  at: string;
  outcome: RunOutcome;
  failureCategory: RunFailureCategory;
  note: string;
}

function str(detail: Record<string, unknown>, key: string): string | null {
  return typeof detail[key] === 'string' ? (detail[key] as string) : null;
}

/**
 * How many times this run was reconciled as NOT executed. The next attempt's
 * generation is one more — the `sideEffectGeneration` shape, deliberately, so
 * the two ledgers count attempts the same way.
 */
export function runAttemptGeneration(events: readonly RunEventRow[]): number {
  return (
    events.filter(
      (event) => event.kind === 'reconciled' && str(event.detail, 'decision') === 'confirmed_not_executed',
    ).length + 1
  );
}

/** Derive one run's view from its ledger. PURE: no I/O, no clock, no randomness. */
export function deriveRunRecord(row: RunRow, events: readonly RunEventRow[]): RunRecord {
  let state: RunState = 'open';
  let outcome: RunOutcome = 'none';
  let failureCategory: RunFailureCategory = 'none';
  let attempts = 0;
  let lastCorrelationId: string | null = null;
  let interruption: RunRecord['interruption'] = null;
  let reconciliation: RunRecord['reconciliation'] = null;
  let workerReport: RunWorkerReport | null = null;
  let reopened = false;

  /**
   * Fold a worker's statement in WITHOUT moving the run. Shared by the
   * `worker_report` kind and by an `outcome_recorded` that landed on a run
   * already standing at `needs_reconciliation` — the raw-append shape of the
   * same thing.
   */
  const foldWorkerReport = (event: RunEventRow): void => {
    const reported = str(event.detail, 'outcome');
    const category = str(event.detail, 'failureCategory');
    workerReport = {
      by: event.actor,
      at: event.at,
      // Fail closed on both, exactly as the concluding branch does.
      outcome: isReportableRunOutcome(reported) ? reported : 'outcome_unknown',
      failureCategory: isRunFailureCategory(category) ? category : 'unknown',
      note: str(event.detail, 'note') ?? '',
    };
  };

  for (const event of events) {
    switch (event.kind) {
      case 'opened':
        state = 'open';
        break;
      case 'attempt_started': {
        attempts += 1;
        state = 'attempting';
        reopened = false;
        lastCorrelationId = str(event.detail, 'correlationId') ?? lastCorrelationId;
        break;
      }
      case 'worker_report': {
        // TESTIMONY. It records what the carrier says it saw and moves no
        // state, no outcome and no attempt generation — see the kind's own
        // note and `RunRecord.workerReport`.
        foldWorkerReport(event);
        break;
      }
      case 'outcome_recorded': {
        // A run standing at `needs_reconciliation` is NOT concluded by an
        // outcome report, whoever appended it. No facade path produces this
        // shape any more — the late path appends `worker_report` — but
        // `hq_reliability_run_events` is append-only and an APPEND is exactly
        // the write its triggers permit, so a raw writer can still put an
        // `outcome_recorded` row on top of an interruption. Concluding on it
        // would clear `needsReconciliation`, lift the `openRun` guard, and let
        // a second run (and a second attempt) start on work whose last honest
        // word was "HQ does not know". Folded in as testimony instead.
        if (state === 'needs_reconciliation') {
          foldWorkerReport(event);
          break;
        }
        const reported = str(event.detail, 'outcome');
        // Fail closed: an outcome outside the closed vocabulary is read as
        // unknown, which demands a human rather than concluding the run.
        const value: RunOutcome = isReportableRunOutcome(reported) ? reported : 'outcome_unknown';
        outcome = value;
        const category = str(event.detail, 'failureCategory');
        // Fail closed like every sibling default. `'none'` asserts "there was
        // no failure category", which is a positive claim HQ cannot make about
        // a detail blob it could not read; `'unknown'` is already a member of
        // the closed vocabulary and says exactly what is true (Wave 5 Low).
        failureCategory = isRunFailureCategory(category) ? category : 'unknown';
        state = value === 'outcome_unknown' ? 'needs_reconciliation' : 'concluded';
        reopened = false;
        break;
      }
      case 'interrupted': {
        const reason = str(event.detail, 'reason');
        // FAIL CLOSED on the flag that decides whether a human is needed.
        // This read used to be `=== true`, so an absent, corrupt or
        // non-boolean `uncertain` produced `false` — and `false` here means
        // `not_executed` / `concluded`, i.e. "nothing happened", which is the
        // exact opposite of what an unreadable detail blob supports and the
        // opposite of the documented rule (Wave 5 Medium 4). Only an EXPLICIT
        // `false`, which the recovery pass writes when it can prove no attempt
        // was ever reserved or that the capability cannot reach outside HQ,
        // closes a run without a human.
        const uncertain = event.detail.uncertain !== false;
        interruption = {
          reason: isRunInterruptionReason(reason) ? reason : 'process_interrupted',
          at: event.at,
          uncertain,
        };
        outcome = uncertain ? 'outcome_unknown' : 'not_executed';
        // The reason a recovery recorded doubles as the failure category when
        // it is one; otherwise the interruption itself is the category.
        const category = str(event.detail, 'failureCategory');
        failureCategory = isRunFailureCategory(category) ? category : 'process_interrupted';
        state = uncertain ? 'needs_reconciliation' : 'concluded';
        reopened = false;
        break;
      }
      case 'reconciled': {
        const decision = str(event.detail, 'decision');
        const value: RunReconcileDecision = isRunReconcileDecision(decision)
          ? decision
          : // Fail closed: an unreadable decision concludes nothing and reopens
            // nothing; it is treated as the strictest of the three.
            'confirmed_failed';
        reconciliation = {
          by: event.actor,
          at: event.at,
          decision: value,
          note: str(event.detail, 'note') ?? '',
        };
        outcome =
          value === 'confirmed_succeeded'
            ? 'succeeded'
            : value === 'confirmed_failed'
              ? 'failed'
              : 'not_executed';
        state = 'concluded';
        reopened = value === 'confirmed_not_executed';
        break;
      }
      default: {
        // FAIL CLOSED. An event HQ cannot interpret is not an attempt, is not
        // a conclusion, and is emphatically not permission to try again: it
        // means HQ does not know what happened, which is exactly what
        // `needs_reconciliation` says and what a human then resolves.
        outcome = 'outcome_unknown';
        failureCategory = 'unknown';
        state = 'needs_reconciliation';
        reopened = false;
        break;
      }
    }
  }

  return {
    id: row.id,
    seq: row.seq,
    runKind: row.runKind,
    taskId: row.taskId,
    missionId: row.missionId,
    actionId: row.actionId,
    capabilityId: row.capabilityId,
    workerId: row.workerId,
    claimFence: row.claimFence,
    processId: row.processId,
    label: row.label,
    openedAt: row.openedAt,
    state,
    outcome,
    failureCategory,
    attempts,
    nextGeneration: runAttemptGeneration(events),
    lastCorrelationId,
    interruption,
    reconciliation,
    admitsAttempt: state === 'open' || reopened,
    needsReconciliation: state === 'needs_reconciliation',
    interruptedWithoutReport: events[events.length - 1]?.kind === 'interrupted',
    workerReport,
    events: events.map((event) => ({
      kind: event.kind,
      actor: event.actor,
      at: event.at,
      processId: event.processId,
      detail: event.detail,
    })),
  };
}

/**
 * May a further attempt be started at all?
 *
 * The law of the phase in one function. `attempting` is refused because an
 * attempt is already open; `needs_reconciliation` is refused because HQ does
 * not know what the last one did; a `concluded` run is refused unless the
 * thing that concluded it was a human saying `confirmed_not_executed`.
 */
export function runAdmitsAttempt(record: RunRecord): boolean {
  return record.admitsAttempt;
}

/**
 * How an interrupted run is classified at restart — the crash-recovery core.
 * PURE, so the rule can be exercised without a process, a file or a clock.
 *
 * `capabilitySideEffect` is FAIL-CLOSED at the call site: a capability row
 * that cannot be read must be passed as `true`, so an interrupted attempt on
 * an unreadable capability is uncertain rather than conveniently harmless.
 */
export function classifyInterruptedRun(
  record: RunRecord,
  input: { capabilitySideEffect: boolean; reason?: RunInterruptionReason },
): { interrupted: boolean; uncertain: boolean; reason: RunInterruptionReason; outcome: RunOutcome } | null {
  if (record.state !== 'open' && record.state !== 'attempting') return null;
  const reason = input.reason ?? 'process_interrupted';
  if (record.state === 'open') {
    // No attempt was ever RESERVED in this ledger, so as far as HQ's own
    // record goes nothing external happened — which is why this is the only
    // case allowed to conclude without a human. It is a statement about the
    // record and not about the world: `openRun`/`startRunAttempt` are opt-in,
    // so a lane that never opened a run leaves nothing here to classify. The
    // ledger proves what HQ was told, never what the world did (Wave 5 review,
    // Low finding 11).
    return { interrupted: true, uncertain: false, reason, outcome: 'not_executed' };
  }
  if (!input.capabilitySideEffect) {
    // An attempt of a capability that CANNOT reach outside HQ leaves nothing to
    // be uncertain about. `sideEffect` is the canonical column the queue itself
    // uses to decide the same question at lease expiry.
    return { interrupted: true, uncertain: false, reason, outcome: 'not_executed' };
  }
  return { interrupted: true, uncertain: true, reason, outcome: 'outcome_unknown' };
}

/* ------------------------------------------------------------------ */
/* Views the facade returns                                            */
/* ------------------------------------------------------------------ */

/** One verified recovery point, as a reader sees it. */
export interface BackupRecordView {
  id: string;
  seq: number;
  backupPath: string;
  /** sha256 HQ computed itself over the bytes it checked — never a declared one. */
  contentDigest: string;
  sizeBytes: number;
  schemaTables: number;
  verifiedAt: string;
  verifiedBy: string;
  processId: string;
  note: string | null;
  statement: string;
}

export const BACKUP_RECORD_STATEMENT =
  'contentDigest is computed BY HQ over the exact bytes it opened and checked, so it pins what was verified. ' +
  'Those are the same bytes throughout, by construction: the candidate is opened once, and its bytes are ' +
  'hashed and copied to a scratch file in one pass, and integrity_check and the schema census then run ' +
  'against that copy — so the path is never resolved a second time. A candidate carrying a -wal, -shm or ' +
  '-journal sidecar is refused rather than verified, because SQLite would read the sidecar together with ' +
  'the main file and the digest covers only the file; so is one that is a hard link to another name, ' +
  'because a file some other name can still be written through is not a snapshot. verified means these ' +
  'bytes are a sound HQ database — never that they are the whole of what was committed when they were ' +
  'copied, which is a question no reading of the bytes can answer. HQ did not take this backup and cannot restore it: ' +
  'taking one safely ' +
  'belongs to the durable persistence owner, and restoring is a deliberate operator act against a stopped ' +
  'process. This row says a file was checked, by whom, and what it hashed to — nothing more.';

export function backupRowToView(row: BackupRow): BackupRecordView {
  return {
    id: row.id,
    seq: row.seq,
    backupPath: row.backupPath,
    contentDigest: row.contentDigest,
    sizeBytes: row.sizeBytes,
    schemaTables: row.schemaTables,
    verifiedAt: row.verifiedAt,
    verifiedBy: row.verifiedBy,
    processId: row.processId,
    note: row.note,
    statement: BACKUP_RECORD_STATEMENT,
  };
}

/** One run this recovery pass classified. Ids and categorical facts only. */
export interface HqRecoveryClassification {
  runId: string;
  taskId: string;
  openedByProcess: string;
  reason: RunInterruptionReason;
  uncertain: boolean;
  outcome: RunOutcome;
}

/** Interrupted canonical work owned by OTHER ledgers — counted, never touched. */
export interface HqCanonicalInterruptions {
  actionsAwaitingReconciliation: number;
  tasksOutcomeUnknown: number;
  tasksWithExpiredLease: number;
  resolvedBy: {
    actionsAwaitingReconciliation: string;
    tasksOutcomeUnknown: string;
    tasksWithExpiredLease: string;
  };
  statement: string;
}

export interface HqRecoveryReport {
  /** The process that PERFORMED the recovery; runs it opened are left alone. */
  processIdentity: string;
  classified: HqRecoveryClassification[];
  interruptedTotal: number;
  nowNeedingReconciliation: number;
  canonical: HqCanonicalInterruptions;
  safeMode: boolean;
  retryStatement: string;
}

export interface HqIntegrityObservationView {
  finding: string;
  blocking: boolean;
  detail: string;
}

export interface HqIntegrityView {
  safeMode: boolean;
  depth: 'structural' | 'full';
  observations: HqIntegrityObservationView[];
  durability: {
    journalMode: string;
    synchronous: number;
    foreignKeys: boolean;
    walAutocheckpoint: number;
    readonly: boolean;
    inMemory: boolean;
    meetsRequirement: boolean;
  };
  safeModeStatement: string;
  depthStatement: string;
}

export interface HqReliabilityPosture {
  processIdentity: string;
  storePresent: boolean;
  integrity: HqIntegrityView;
  runs: {
    total: number;
    needsReconciliation: number;
    openOrAttempting: number;
    /** Runs opened by a process that is not this one — the restart signal. */
    openedByOtherProcesses: number;
  };
  verifiedBackups: number;
  canonical: HqCanonicalInterruptions;
  ledgerStatement: string;
  retryStatement: string;
}

/* ------------------------------------------------------------------ */
/* Snapshot summary — counts over closed vocabularies, and nothing else */
/* ------------------------------------------------------------------ */

/**
 * The extra bucket every map carries.
 *
 * `hq_reliability_runs` and `hq_reliability_run_events` are append-only
 * ledgers on which an APPEND is the write the triggers deliberately permit, so
 * a stored `run_kind`, state or outcome could be a string outside the closed
 * vocabulary. It is counted as what HQ actually knows about it — that it is not
 * one of these — and its TEXT never becomes a key. A truthful bucket, not a
 * category of run.
 */
export const UNRECOGNIZED_BUCKET = 'unrecognized' as const;

export type RunKindCounts = Record<RunKind | typeof UNRECOGNIZED_BUCKET, number>;
export type RunStateCounts = Record<RunState | typeof UNRECOGNIZED_BUCKET, number>;
export type RunOutcomeCounts = Record<RunOutcome | typeof UNRECOGNIZED_BUCKET, number>;

export interface ReliabilitySnapshotView {
  storePresent: boolean;
  runs: number;
  byKind: RunKindCounts;
  byState: RunStateCounts;
  byOutcome: RunOutcomeCounts;
  needsReconciliation: number;
  verifiedBackups: number;
  /** Whether HQ is currently in safe mode, and how deep the assessment behind that was. */
  safeMode: boolean;
  assessmentDepth: 'structural' | 'full';
  /** Counts keyed by the closed integrity-finding vocabulary; no detail text crosses. */
  findings: Record<string, number>;
  durabilityMeetsRequirement: boolean;
  note: string;
}

function zeroed<T extends string>(members: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = { [UNRECOGNIZED_BUCKET]: 0 };
  for (const member of members) counts[member] = 0;
  return counts;
}

/**
 * The snapshot for a handle that carries NO run ledger.
 *
 * The run counts are genuinely zero — there is no ledger to count — but the
 * INTEGRITY half is not: `#integrityReport` is latched at construction
 * independently of the reliability store, and the snapshot CLI opens read-only,
 * which is exactly the store-absent branch. This used to hard-code
 * `safeMode: false`, `findings: {}` and `durabilityMeetsRequirement: true`, so
 * a world-readable artifact published "everything is fine" while HQ had latched
 * safe mode with blocking findings — and published
 * `durabilityMeetsRequirement: true` on EVERY read-only pre-Phase-13 snapshot
 * with no tampering at all (Wave 5 High 5, executed).
 *
 * The integrity facts are therefore a REQUIRED argument: there is no way to
 * build this view without stating what HQ actually knows about itself. The
 * privacy shape is unchanged — the finding map is keyed through the closed
 * vocabulary by `summarizeReliability`, and no detail text crosses.
 */
export function emptyReliabilitySnapshot(
  storePresent: boolean,
  integrity: {
    safeMode: boolean;
    assessmentDepth: 'structural' | 'full';
    findings: readonly string[];
    durabilityMeetsRequirement: boolean;
  },
): ReliabilitySnapshotView {
  return summarizeReliability({
    storePresent,
    runs: [],
    verifiedBackups: 0,
    safeMode: integrity.safeMode,
    assessmentDepth: integrity.assessmentDepth,
    findings: integrity.findings,
    durabilityMeetsRequirement: integrity.durabilityMeetsRequirement,
  });
}

export const RELIABILITY_SNAPSHOT_NOTE =
  'Counts over closed vocabularies only. No run label, task/mission/action id, worker id, correlation id, ' +
  'backup path, digest or finding detail crosses to an unauthenticated reader. A concluded count is a count ' +
  'of RECORDS, not evidence that anything reached the outside world — no reliability path can perform an ' +
  'external action. safeMode true means HQ has said so about itself; it is never inferred here. ' +
  'durabilityMeetsRequirement is a statement about a FILE-backed database: an in-memory handle reports it ' +
  'true because there is nothing durable to require of a database with no file, not because it is durable.';

/**
 * Fold the register into counts. Every increment passes a membership check and
 * the CHECKED value — never the caller's string — becomes the key.
 */
export function summarizeReliability(input: {
  storePresent: boolean;
  runs: readonly RunRecord[];
  verifiedBackups: number;
  safeMode: boolean;
  assessmentDepth: 'structural' | 'full';
  findings: readonly string[];
  durabilityMeetsRequirement: boolean;
}): ReliabilitySnapshotView {
  const byKind = zeroed(RUN_KINDS);
  const byState = zeroed(RUN_STATES);
  const byOutcome = zeroed(RUN_OUTCOMES);
  let needsReconciliation = 0;
  for (const run of input.runs) {
    // The CHECKED value is the key, never the stored string.
    byKind[isRunKind(run.runKind) ? run.runKind : UNRECOGNIZED_BUCKET] += 1;
    byState[isRunState(run.state) ? run.state : UNRECOGNIZED_BUCKET] += 1;
    byOutcome[isRunOutcome(run.outcome) ? run.outcome : UNRECOGNIZED_BUCKET] += 1;
    if (run.needsReconciliation) needsReconciliation += 1;
  }
  const findings: Record<string, number> = {};
  for (const finding of input.findings) {
    // The CHECKED value is the key, never the caller's string. A finding name
    // outside the closed vocabulary is counted as `unrecognized` and its text
    // is dropped — the Phase 12 snapshot-safety rule, applied to a map whose
    // keys would otherwise come from a caller.
    const key = isHqIntegrityFinding(finding) ? finding : UNRECOGNIZED_BUCKET;
    findings[key] = (findings[key] ?? 0) + 1;
  }
  return {
    storePresent: input.storePresent,
    runs: input.runs.length,
    byKind: byKind as RunKindCounts,
    byState: byState as RunStateCounts,
    byOutcome: byOutcome as RunOutcomeCounts,
    needsReconciliation,
    verifiedBackups: input.verifiedBackups,
    safeMode: input.safeMode,
    assessmentDepth: input.assessmentDepth,
    findings,
    durabilityMeetsRequirement: input.durabilityMeetsRequirement,
    note: RELIABILITY_SNAPSHOT_NOTE,
  };
}
