/**
 * Authority + Risk + External Action Gateway — the action/run LEDGER (Phase 8).
 *
 * Meaningful external actions go through ONE canonical gateway instead of
 * provider-specific ad hoc execution paths. This module owns the vocabulary
 * (categorical only), the adapter contract, the deterministic risk engine, the
 * append-only ledger schema, the idempotency/digest derivations and the PURE
 * state derivation. The facade (`service.ts`) owns every authority decision,
 * every write and the Intent Guard that re-validates CURRENT canonical truth
 * immediately before an external call.
 *
 * What this ledger deliberately is NOT:
 * - not a second task truth — every action intent is bound to ONE canonical
 *   `op_tasks` row and executes only under that task's live fenced claim; the
 *   task lifecycle, approvals (`hq_approvals`), claims, leases and kill
 *   switches stay exactly where they are;
 * - not a second approval system — authorization reuses the canonical approval
 *   row bound to the task (digest, expiry, single-use claim binding) and adds
 *   only STRICTER preconditions (risk-required approval, proposer ≠ approver);
 * - not a second dispatch authority — the existing Claude/GitHub dispatch lane
 *   (`providers/claude/dispatch.ts`) is untouched; a task that lane has already
 *   handed off is refused here, and a task with a gateway attempt in flight is
 *   refused there, so one canonical task has ONE external execution path;
 * - not a score — risk is `low | medium | high | critical` and nothing else;
 *   there is no confidence number, no probability and no ETA anywhere here,
 *   by design and by the wire guard;
 * - not self-declaring — the proposer's risk inputs can only ESCALATE. The
 *   base level comes from the canonical capability row and the adapter's
 *   declared action contract; nothing a proposer says can lower it.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import type { RiskClass } from '../operator/capabilities.js';

// ---- vocabulary (categorical only) ----

/** The seven ledger states. Categorical; audit/execution truth, never a task lifecycle. */
export const ACTION_STATES = deepFreeze([
  'proposed',
  'authorized',
  'attempted',
  'succeeded',
  'failed',
  'outcome_unknown',
  'reconciled',
] as const);
export type ActionState = (typeof ACTION_STATES)[number];

export function isActionState(value: unknown): value is ActionState {
  return typeof value === 'string' && (ACTION_STATES as readonly string[]).includes(value);
}

/** The four risk levels. There is no number behind any of them. */
export const ACTION_RISK_LEVELS = deepFreeze(['low', 'medium', 'high', 'critical'] as const);
export type ActionRiskLevel = (typeof ACTION_RISK_LEVELS)[number];

export function isActionRiskLevel(value: unknown): value is ActionRiskLevel {
  return typeof value === 'string' && (ACTION_RISK_LEVELS as readonly string[]).includes(value);
}

export const ACTION_VISIBILITIES = deepFreeze(['internal', 'external', 'public'] as const);
export type ActionVisibility = (typeof ACTION_VISIBILITIES)[number];

export const ACTION_REVERSIBILITIES = deepFreeze(['reversible', 'compensable', 'irreversible'] as const);
export type ActionReversibility = (typeof ACTION_REVERSIBILITIES)[number];

export const ACTION_BLAST_RADII = deepFreeze(['single', 'many', 'system'] as const);
export type ActionBlastRadius = (typeof ACTION_BLAST_RADII)[number];

export function isActionBlastRadius(value: unknown): value is ActionBlastRadius {
  return typeof value === 'string' && (ACTION_BLAST_RADII as readonly string[]).includes(value);
}

/**
 * How an `attempted` / `outcome_unknown` action is closed by a HUMAN who
 * checked the real world. Mirrors the queue's `ReconcileDecision` vocabulary
 * on purpose — same shape of judgement, same authority (approval authority).
 */
export const ACTION_RECONCILE_DECISIONS = deepFreeze([
  'confirmed_succeeded',
  'confirmed_failed',
  'confirmed_not_executed',
] as const);
export type ActionReconcileDecision = (typeof ACTION_RECONCILE_DECISIONS)[number];

export function isActionReconcileDecision(value: unknown): value is ActionReconcileDecision {
  return typeof value === 'string' && (ACTION_RECONCILE_DECISIONS as readonly string[]).includes(value);
}

// ---- kill-switch scopes the gateway honours ----

/** Every gateway execution stops when this scope is engaged, whatever the capability or provider. */
export const EXTERNAL_ACTION_KILL_SCOPE = 'external_action';

/** Per-provider stop: `provider:CLAUDE` stops every adapter executing as CLAUDE. */
export function providerKillSwitchScope(providerId: string): string {
  return `provider:${providerId}`;
}

/** Per-adapter stop: `adapter:<id>`. */
export function adapterKillSwitchScope(adapterId: string): string {
  return `adapter:${adapterId}`;
}

// ---- adapter contract ----

export const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const ACTION_TYPE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * Declarative compensation. Present ONLY where the provider genuinely supports
 * undoing the action; `null` means "this cannot be undone through HQ" and the
 * ledger says so. Never a promise of reversibility that does not exist.
 */
export interface ActionCompensation {
  supported: true;
  /** The adapter action type that performs the compensation. Informational; nothing here executes it. */
  method: string;
  description: string;
}

export interface ActionTypeContract {
  description: string;
  visibility: ActionVisibility;
  reversibility: ActionReversibility;
  compensation: ActionCompensation | null;
}

export interface ActionExecutionRequest {
  actionId: string;
  taskId: string;
  actionType: string;
  target: string;
  payload: Record<string, unknown>;
  /** `<actionId>#<generation>` — unique per external attempt. */
  correlationId: string;
  /** The durable side-effect idempotency key the ledger reserved for this attempt. */
  sideEffectKey: string;
}

/**
 * What an adapter may report. Three shapes, because collapsing them is how a
 * duplicate side effect happens: `rejected`/`unavailable` mean NOTHING happened
 * externally (terminal `failed`); `unknown` means it may have (terminal
 * `outcome_unknown`, never retried automatically).
 */
export type AdapterOutcome =
  | { ok: true; externalRef: Record<string, unknown> | null }
  | { ok: false; kind: 'rejected' | 'unavailable'; message: string }
  | { ok: false; kind: 'unknown'; message: string };

export interface ExternalActionAdapter {
  id: string;
  /**
   * The routing provider identity this adapter executes AS (`CLAUDE`,
   * `CODEX`, ...), or null for a provider-neutral local adapter. A bound task
   * executes only through an adapter of its bound provider; a provider adapter
   * executes only for a worker DECLARED as that provider. No substitution.
   */
  provider: string | null;
  actions: Readonly<Record<string, ActionTypeContract>>;
  execute(request: ActionExecutionRequest): AdapterOutcome;
}

/** Problems with an adapter's declaration. Empty when the contract is usable. */
export function adapterContractProblems(adapter: ExternalActionAdapter): string[] {
  const problems: string[] = [];
  if (!ADAPTER_ID_PATTERN.test(adapter.id ?? '')) problems.push('adapter id is malformed');
  if (adapter.provider !== null && (typeof adapter.provider !== 'string' || adapter.provider.trim() === '')) {
    problems.push('adapter provider must be a provider id or null');
  }
  if (typeof adapter.execute !== 'function') problems.push('adapter has no execute function');
  const types = Object.keys(adapter.actions ?? {});
  if (types.length === 0) problems.push('adapter declares no action types');
  for (const type of types) {
    const contract = adapter.actions[type]!;
    if (!ACTION_TYPE_PATTERN.test(type)) problems.push(`action type ${type} is malformed`);
    if (!(ACTION_VISIBILITIES as readonly string[]).includes(contract.visibility)) {
      problems.push(`action type ${type}: unknown visibility`);
    }
    if (!(ACTION_REVERSIBILITIES as readonly string[]).includes(contract.reversibility)) {
      problems.push(`action type ${type}: unknown reversibility`);
    }
    if (contract.reversibility !== 'irreversible' && contract.compensation == null) {
      problems.push(
        `action type ${type}: declares ${contract.reversibility} without a compensation — reversibility is never promised without a declared method`,
      );
    }
    if (contract.reversibility === 'irreversible' && contract.compensation != null) {
      problems.push(`action type ${type}: irreversible actions cannot declare a compensation`);
    }
    if (contract.compensation && (contract.compensation.supported !== true || !contract.compensation.method?.trim())) {
      problems.push(`action type ${type}: compensation must be supported with a named method`);
    }
  }
  return problems;
}

// ---- risk engine: deterministic, categorical, monotone ----

/**
 * What a PROPOSER may add to the risk picture. Every field can only RAISE the
 * level; there is no input that lowers it (workers may not self-declare an
 * action safe — war room #41).
 */
export interface ActionRiskEscalations {
  productionScope?: boolean;
  spend?: boolean;
  credentialSensitivity?: boolean;
  legalCompliance?: boolean;
  blastRadius?: ActionBlastRadius;
}

export interface ActionRiskInputs {
  capability: { riskClass: RiskClass; sideEffect: boolean };
  contract: Pick<ActionTypeContract, 'visibility' | 'reversibility'>;
  escalations: ActionRiskEscalations;
}

export interface ActionRiskAssessment {
  level: ActionRiskLevel;
  /** Categorical reasons, stable names — never weights. */
  factors: string[];
}

const RISK_RANK: Record<ActionRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskRank(level: ActionRiskLevel): number {
  return RISK_RANK[level];
}

/**
 * The one risk function. PURE and deterministic: same inputs, same level.
 * `critical` wins over `high` wins over `medium`; the floor is `low`. Each
 * rule names its factor so the ledger can say WHY, categorically.
 */
export function assessActionRisk(inputs: ActionRiskInputs): ActionRiskAssessment {
  const factors: string[] = [];
  let level: ActionRiskLevel = 'low';
  const raise = (to: ActionRiskLevel, factor: string): void => {
    factors.push(factor);
    if (RISK_RANK[to] > RISK_RANK[level]) level = to;
  };
  const { capability, contract, escalations } = inputs;

  if (capability.sideEffect) raise('medium', 'side_effect');
  if (capability.riskClass === 'external_side_effect') raise('medium', 'capability_external_side_effect');
  if (contract.visibility === 'external') raise('medium', 'external_visibility');
  if (contract.reversibility === 'compensable') raise('medium', 'compensable_only');

  if (contract.visibility === 'public') raise('high', 'public_visibility');
  if (contract.reversibility === 'irreversible') raise('high', 'irreversible');
  if (capability.riskClass === 'destructive') raise('high', 'capability_destructive');
  if (capability.riskClass === 'founder_gate') raise('high', 'capability_founder_gate');
  if (escalations.blastRadius === 'many') raise('high', 'blast_radius_many');

  if (contract.visibility === 'public' && contract.reversibility === 'irreversible') {
    raise('critical', 'public_and_irreversible');
  }
  if (escalations.spend) raise('critical', 'money_spend');
  if (escalations.productionScope) raise('critical', 'production_scope');
  if (escalations.credentialSensitivity) raise('critical', 'credential_sensitivity');
  if (escalations.legalCompliance) raise('critical', 'legal_compliance');
  if (escalations.blastRadius === 'system') raise('critical', 'blast_radius_system');

  return { level, factors: [...new Set(factors)] };
}

/**
 * The categorical risk POLICY: `high` and `critical` actions require a bound,
 * valid Founder approval on the canonical task — even where the capability's
 * standing policy would let it run unapproved. A stricter precondition, never
 * a looser one: risk escalation can add an approval requirement and can never
 * remove one the capability policy already imposes.
 */
export function riskRequiresApproval(level: ActionRiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK.high;
}

// ---- bounds ----

export const MAX_ACTION_TARGET_LENGTH = 500;
export const MAX_ACTION_PAYLOAD_CHARS = 16_000;
export const MAX_ACTION_CONTEXT_REFS = 20;
export const MAX_ACTION_NOTE_LENGTH = 500;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const ACTION_READ_LIMIT = 50;

// ---- digests and keys ----

export function actionPayloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Derived dedupe key for a PROPOSAL. The client's `idempotencyKey` is an input
 * to the digest, never the key itself (the mission/memory/truth rule), so an
 * identical proposal dedupes and a deliberate fresh one is possible.
 */
export function actionIdempotencyKey(input: {
  requestedBy: string;
  taskId: string;
  adapterId: string;
  actionType: string;
  target: string;
  payloadDigest: string;
  missionId: string | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `action:${digest.slice(0, 32)}`;
}

/**
 * The durable side-effect identity: task + adapter + action type + target +
 * payload digest. Two DIFFERENT action intents with the same base name the
 * same external side effect, and the ledger admits ONE attempt per generation
 * of it — by unique index, so the engine refuses the duplicate even under two
 * processes.
 */
export function sideEffectKeyBase(input: {
  taskId: string;
  adapterId: string;
  actionType: string;
  target: string;
  payloadDigest: string;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `effect:${digest.slice(0, 32)}`;
}

export function sideEffectKey(base: string, generation: number): string {
  return `${base}#${generation}`;
}

/**
 * The snapshot the Intent Guard compares. Everything an authorization rests on
 * that can MOVE without the action row changing: the task's approved action
 * digest, the approval row identity and decider, the claim (worker/fence/
 * nonce) that consumed it, the provider/adapter pair, the mission's intent
 * version and status, the capability's canonical risk class and the assessed
 * level. `at` is deliberately excluded from the digest.
 */
export interface AuthorizedSnapshot {
  taskActionDigest: string;
  payloadDigest: string;
  approvalId: string | null;
  approvalDecidedBy: string | null;
  workerId: string;
  fence: number;
  claimNonce: string | null;
  providerId: string | null;
  adapterId: string;
  missionIntentSeq: number | null;
  missionStatus: string | null;
  capabilityRiskClass: RiskClass;
  riskLevel: ActionRiskLevel;
}

export function authorizationDigest(snapshot: AuthorizedSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** Which snapshot fields differ — categorical, so a refusal can say what moved. */
export function snapshotDrift(authorized: AuthorizedSnapshot, current: AuthorizedSnapshot): (keyof AuthorizedSnapshot)[] {
  const keys = Object.keys(authorized) as (keyof AuthorizedSnapshot)[];
  return keys.filter((key) => authorized[key] !== current[key]);
}

// ---- schema: two tables, both INSERT-only BY ENGINE ----

/**
 * The full §G trigger set (the hq_truth_* recipe): no UPDATE of any column, no
 * DELETE, and a BEFORE INSERT guard that closes REPLACE / UPSERT. State is
 * DERIVED from the event ledger, so the intent row never changes; a unique
 * partial index on `side_effect_key` makes the engine itself refuse a second
 * attempt of the same external side effect.
 */
const ACTION_DDL = `
CREATE TABLE IF NOT EXISTS hq_action_intents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  capability_id TEXT NOT NULL,
  provider_id TEXT,
  adapter_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  risk_factors TEXT NOT NULL,
  visibility TEXT NOT NULL,
  reversibility TEXT NOT NULL,
  compensation TEXT,
  context_evidence_refs TEXT NOT NULL,
  context_truth_refs TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  side_effect_key_base TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_action_intents_task ON hq_action_intents(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_hq_action_intents_effect ON hq_action_intents(side_effect_key_base, seq);

CREATE TABLE IF NOT EXISTS hq_action_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL,
  state TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL,
  side_effect_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_action_events_action ON hq_action_events(action_id, seq);
-- ONE attempt per side-effect generation, enforced by the engine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_action_events_effect
  ON hq_action_events(side_effect_key) WHERE side_effect_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_hq_action_intents_no_rewrite
BEFORE UPDATE ON hq_action_intents
BEGIN SELECT RAISE(ABORT, 'hq_action_intents is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_action_intents_no_erase
BEFORE DELETE ON hq_action_intents
BEGIN SELECT RAISE(ABORT, 'hq_action_intents is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_action_intents_no_replace
BEFORE INSERT ON hq_action_intents
WHEN EXISTS (SELECT 1 FROM hq_action_intents WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_action_intents WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_action_intents is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_action_events_no_rewrite
BEFORE UPDATE ON hq_action_events
BEGIN SELECT RAISE(ABORT, 'hq_action_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_action_events_no_erase
BEFORE DELETE ON hq_action_events
BEGIN SELECT RAISE(ABORT, 'hq_action_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_action_events_no_replace
BEFORE INSERT ON hq_action_events
WHEN EXISTS (SELECT 1 FROM hq_action_events WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_action_events WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_action_events is append-only'); END;

-- The secondary unique indexes (the hq_truth_* correction): REPLACE colliding
-- on an intent's idempotency_key or on an event's side_effect_key deletes the
-- standing row without a BEFORE DELETE firing (recursive_triggers is off by
-- default and connection-scoped). On hq_action_events that row IS the durable
-- attempt reservation — erasing it and landing a forged
-- "reconciled: confirmed_not_executed" would free the side effect for a second
-- real execution. Additive trigger names so an existing file gains them.
CREATE TRIGGER IF NOT EXISTS trg_hq_action_intents_no_replace_unique
BEFORE INSERT ON hq_action_intents
WHEN EXISTS (SELECT 1 FROM hq_action_intents WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_action_intents is append-only (unique idempotency_key already held)'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_action_events_no_replace_unique
BEFORE INSERT ON hq_action_events
WHEN NEW.side_effect_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM hq_action_events WHERE side_effect_key = NEW.side_effect_key)
BEGIN SELECT RAISE(ABORT, 'hq_action_events is append-only (UNIQUE side_effect_key already reserved)'); END;
`;

/** Idempotent; readonly-safe (the post-Phase-3 ensure*Schema pattern). */
export function ensureActionGatewaySchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(ACTION_DDL);
}

/** True when the ledger tables exist in this file — observation, never migration. */
export function actionGatewaySchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_action_intents'`)
      .get() !== undefined
  );
}

// ---- stored rows ----

export interface ActionIntentRow {
  seq: number;
  id: string;
  taskId: string;
  missionId: string | null;
  capabilityId: string;
  providerId: string | null;
  adapterId: string;
  actionType: string;
  target: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  riskLevel: ActionRiskLevel;
  riskFactors: string[];
  visibility: ActionVisibility;
  reversibility: ActionReversibility;
  compensation: ActionCompensation | null;
  contextEvidenceRefs: string[];
  contextTruthRefs: string[];
  requestedBy: string;
  requestedAt: string;
  sideEffectKeyBase: string;
}

export interface ActionEventRow {
  seq: number;
  id: string;
  actionId: string;
  state: ActionState;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
  sideEffectKey: string | null;
}

function rowToIntent(r: Record<string, unknown>): ActionIntentRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    taskId: r.task_id as string,
    missionId: (r.mission_id as string | null) ?? null,
    capabilityId: r.capability_id as string,
    providerId: (r.provider_id as string | null) ?? null,
    adapterId: r.adapter_id as string,
    actionType: r.action_type as string,
    target: r.target as string,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    payloadDigest: r.payload_digest as string,
    riskLevel: r.risk_level as ActionRiskLevel,
    riskFactors: JSON.parse(r.risk_factors as string) as string[],
    visibility: r.visibility as ActionVisibility,
    reversibility: r.reversibility as ActionReversibility,
    compensation: r.compensation ? (JSON.parse(r.compensation as string) as ActionCompensation) : null,
    contextEvidenceRefs: JSON.parse(r.context_evidence_refs as string) as string[],
    contextTruthRefs: JSON.parse(r.context_truth_refs as string) as string[],
    requestedBy: r.requested_by as string,
    requestedAt: r.requested_at as string,
    sideEffectKeyBase: r.side_effect_key_base as string,
  };
}

function rowToEvent(r: Record<string, unknown>): ActionEventRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    actionId: r.action_id as string,
    state: r.state as ActionState,
    actor: r.actor as string,
    at: r.at as string,
    detail: JSON.parse(r.detail as string) as Record<string, unknown>,
    sideEffectKey: (r.side_effect_key as string | null) ?? null,
  };
}

export function loadActionIntent(db: HqDatabase, id: string): ActionIntentRow | null {
  const row = db.prepare(`SELECT * FROM hq_action_intents WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToIntent(row) : null;
}

export function loadActionIntents(db: HqDatabase): ActionIntentRow[] {
  return (db.prepare(`SELECT * FROM hq_action_intents ORDER BY seq DESC`).all() as Record<string, unknown>[]).map(
    rowToIntent,
  );
}

export function loadActionEvents(db: HqDatabase, actionId: string): ActionEventRow[] {
  return (
    db.prepare(`SELECT * FROM hq_action_events WHERE action_id = ? ORDER BY seq`).all(actionId) as Record<
      string,
      unknown
    >[]
  ).map(rowToEvent);
}

/**
 * How many times this side effect was reconciled as NOT executed, across
 * every action sharing the base — the next attempt's generation is one more.
 * A `confirmed_not_executed` is the ONLY thing that opens a new generation;
 * an unknown or lost attempt never does.
 */
export function sideEffectGeneration(db: HqDatabase, base: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM hq_action_events e
       JOIN hq_action_intents i ON i.id = e.action_id
       WHERE i.side_effect_key_base = ? AND e.state = 'reconciled'
         AND json_extract(e.detail, '$.decision') = 'confirmed_not_executed'`,
    )
    .get(base) as { n: number };
  return row.n + 1;
}

/** The action (if any) whose attempt currently holds this side-effect key. */
export function sideEffectHolder(db: HqDatabase, key: string): { actionId: string; at: string } | null {
  const row = db
    .prepare(`SELECT action_id, at FROM hq_action_events WHERE side_effect_key = ?`)
    .get(key) as { action_id: string; at: string } | undefined;
  return row ? { actionId: row.action_id, at: row.at } : null;
}

// ---- the pure derivation core ----

export interface ActionEventView {
  id: string;
  state: ActionState;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

/**
 * The ONE browser-safe projection of an action, shared by the control routes
 * and every facade read so the two can never disagree. Absent by shape: the
 * payload BODY (an instruction may live in it; the digest is what an
 * authorization binds), the derived idempotency key and side-effect key base.
 */
export interface ActionView {
  id: string;
  seq: number;
  taskId: string;
  missionId: string | null;
  capabilityId: string;
  providerId: string | null;
  adapterId: string;
  actionType: string;
  target: string;
  payloadDigest: string;
  riskLevel: ActionRiskLevel;
  riskFactors: string[];
  visibility: ActionVisibility;
  reversibility: ActionReversibility;
  compensation: ActionCompensation | null;
  contextEvidenceRefs: string[];
  contextTruthRefs: string[];
  requestedBy: string;
  requestedAt: string;
  /** DERIVED from the ledger — the state of the LAST event. */
  state: ActionState;
  /** The authorization this action rests on, or null before one exists. */
  authorization: { by: string; at: string; digest: string; approvalId: string | null } | null;
  /** The external attempt, or null before one. `correlationId` is unique per attempt. */
  attempt: { by: string; at: string; correlationId: string; generation: number } | null;
  /**
   * The recorded external result, or null. Secret-like refs AND secret-like
   * messages are withheld before storage, never stored: both ledger tables are
   * engine-immutable and `op_evidence` is hash-chained, so a credential that
   * landed there could never be removed. A withheld field is flagged, so the
   * omission is visible rather than silent.
   */
  outcome: {
    state: 'succeeded' | 'failed' | 'outcome_unknown';
    at: string;
    externalRef: Record<string, unknown> | null;
    externalRefWithheld: boolean;
    message: string | null;
    messageWithheld: boolean;
  } | null;
  reconciliation: { by: string; at: string; decision: ActionReconcileDecision; note: string } | null;
  /**
   * True while a new external attempt is REFUSED by the ledger — an attempt is
   * open, unknown or already terminal. Only a `confirmed_not_executed`
   * reconciliation (on an idempotent capability) opens a fresh generation,
   * and that is a NEW proposal, never a retry of this row.
   */
  retryBlocked: boolean;
  events: ActionEventView[];
}

/** Derive one action's view from its ledger. PURE: no I/O, no clock. */
export function deriveActionView(row: ActionIntentRow, events: readonly ActionEventRow[]): ActionView {
  const last = events[events.length - 1];
  const state: ActionState = last?.state ?? 'proposed';
  const authorizedEvent = events.find((e) => e.state === 'authorized') ?? null;
  const attemptedEvent = events.find((e) => e.state === 'attempted') ?? null;
  const outcomeEvent =
    events.find((e) => e.state === 'succeeded' || e.state === 'failed' || e.state === 'outcome_unknown') ?? null;
  const reconciledEvent = events.find((e) => e.state === 'reconciled') ?? null;
  const str = (detail: Record<string, unknown>, key: string): string | null =>
    typeof detail[key] === 'string' ? (detail[key] as string) : null;
  return {
    id: row.id,
    seq: row.seq,
    taskId: row.taskId,
    missionId: row.missionId,
    capabilityId: row.capabilityId,
    providerId: row.providerId,
    adapterId: row.adapterId,
    actionType: row.actionType,
    target: row.target,
    payloadDigest: row.payloadDigest,
    riskLevel: row.riskLevel,
    riskFactors: [...row.riskFactors],
    visibility: row.visibility,
    reversibility: row.reversibility,
    compensation: row.compensation,
    contextEvidenceRefs: [...row.contextEvidenceRefs],
    contextTruthRefs: [...row.contextTruthRefs],
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    state,
    authorization: authorizedEvent
      ? {
          by: authorizedEvent.actor,
          at: authorizedEvent.at,
          digest: str(authorizedEvent.detail, 'digest') ?? '',
          approvalId: str(authorizedEvent.detail, 'approvalId'),
        }
      : null,
    attempt: attemptedEvent
      ? {
          by: attemptedEvent.actor,
          at: attemptedEvent.at,
          correlationId: str(attemptedEvent.detail, 'correlationId') ?? '',
          generation:
            typeof attemptedEvent.detail.generation === 'number' ? (attemptedEvent.detail.generation as number) : 1,
        }
      : null,
    outcome: outcomeEvent
      ? {
          state: outcomeEvent.state as 'succeeded' | 'failed' | 'outcome_unknown',
          at: outcomeEvent.at,
          externalRef:
            outcomeEvent.detail.externalRef != null && typeof outcomeEvent.detail.externalRef === 'object'
              ? (outcomeEvent.detail.externalRef as Record<string, unknown>)
              : null,
          externalRefWithheld: outcomeEvent.detail.externalRefWithheld === true,
          message: str(outcomeEvent.detail, 'message'),
          messageWithheld: outcomeEvent.detail.messageWithheld === true,
        }
      : null,
    reconciliation: reconciledEvent
      ? {
          by: reconciledEvent.actor,
          at: reconciledEvent.at,
          decision: str(reconciledEvent.detail, 'decision') as ActionReconcileDecision,
          note: str(reconciledEvent.detail, 'note') ?? '',
        }
      : null,
    retryBlocked: attemptedEvent !== null,
    events: events.map((e) => ({ id: e.id, state: e.state, actor: e.actor, at: e.at, detail: e.detail })),
  };
}

/** The ledger states from which an external attempt may be RECORDED at all. */
export function stateAdmitsAttempt(state: ActionState): boolean {
  return state === 'authorized';
}

/** The ledger states a human may reconcile: an open or unknown attempt. */
export function stateAdmitsReconciliation(state: ActionState): boolean {
  return state === 'attempted' || state === 'outcome_unknown';
}
