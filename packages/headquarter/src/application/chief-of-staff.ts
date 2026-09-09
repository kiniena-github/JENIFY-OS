/**
 * Chief of Staff + Company Command Center — the DERIVED command layer
 * (Phase 10).
 *
 * The Founder receives ONE truthful, derived view over canonical company
 * state: what needs them, what is blocked, what changed, what is verified,
 * what is unknown, and what HQ can safely do next. This module owns the
 * vocabulary (categorical only), the one capability trio, the append-only
 * brief ledger schema, the idempotency/digest derivations and the PURE
 * derivation core. The facade (`service.ts`) owns the one write
 * (`issueBrief`) and gathers the canonical facts the core derives from —
 * through `#db` and its private derivations, never through a public
 * projection.
 *
 * What the Chief of Staff deliberately is NOT:
 * - not a superuser — it reads, coordinates and recommends under EXISTING
 *   authority. It holds no grant of its own beyond the Founder-gated act of
 *   issuing a brief receipt, and nothing it produces is consulted by any
 *   gate, claim, dispatch, approval or execution path;
 * - not a second authority store — the Founder Inbox, the briefing, the
 *   recommendations and the department projections are DERIVED at read
 *   time from `hq_missions`, `op_tasks`, `hq_approvals`, `op_kill_switch`,
 *   the truth graph, the action ledger, the collaboration record, the
 *   evidence chain and the registries. Every attention item REFERENCES the
 *   canonical row it came from (table + id) and copies no authority. Nothing
 *   here stores an item; an item exists exactly while its source predicate
 *   holds, and vanishes the moment the source is decided elsewhere;
 * - not an executor — a recommendation carries `executable: false`, names
 *   the authority the act would take and the canonical act that would take
 *   it, and has NO path to execution. There is no method that accepts a
 *   recommendation id;
 * - not a scorer — there is no priority number, score, confidence, ETA,
 *   percentage, urgency or weight anywhere. Items are GROUPED by attention
 *   kind in the vocabulary's stated order and, within a kind, listed oldest
 *   canonical timestamp first. That is a display grouping, not a ranking;
 * - not a notification channel — the brief ledger records that a brief was
 *   issued (by whom, when, over which canonical watermarks, with which
 *   categorical counts and a content digest). No timer issues one and
 *   nothing sends anything anywhere.
 *
 * Staleness and unknowns are stated, never resolved: a fact whose canonical
 * subject moved is MARKED `stale`; a superseded truth record is excluded
 * from "verified"; an `outcome_unknown` task, an open or unknown external
 * attempt, and a dispatch attempt with no terminal stay unknown and are
 * listed under WHAT IS UNKNOWN until an explicit human act elsewhere
 * settles them. A count here is the size of a set HQ just enumerated —
 * never an estimate.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import { canonicalJson } from '../operator/approvals.js';
import type { ActivityStatus } from '../contracts/events.js';
import type { MissionStatus } from '../contracts/mission.js';
import type { ActionRiskLevel, ActionState } from './action-gateway.js';
import type { SubjectDrift, TruthEntityKind, TruthState, TruthVerificationSummary } from './truth-command.js';
import type { CollaborationPrivacy, CollaborationRole, SessionStanding } from './collaboration-command.js';

// ---- vocabulary (categorical only) ----

/**
 * The attention kinds of the Founder Inbox, in the ORDER the inbox groups
 * them. The order is the vocabulary's stated order — a grouping the Founder
 * reads top to bottom — and is NOT a priority score; no number is attached
 * to any kind and nothing reorders within a kind except the source record's
 * own canonical timestamp (oldest first, so nothing waits behind a newer
 * item).
 */
export const ATTENTION_KINDS = deepFreeze([
  'approval',
  'review',
  'contradiction',
  'blocked',
  'risk',
  'external_action',
  'incident',
  'decision',
  'stale_mission',
] as const);
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * Why an item is in the inbox — the NAME of the predicate that put it there,
 * stated in code (see `deriveFounderInbox`). Every reason is a fact about a
 * canonical row; none is a judgement.
 */
export const ATTENTION_REASONS = deepFreeze([
  'task_awaiting_approval',
  'approval_expired_unconsumed',
  'review_pending',
  'contradiction_unresolved',
  'task_blocked',
  'task_review_failed',
  'mission_blocked',
  'mission_dependency_terminal',
  'action_high_risk_open',
  'action_awaiting_reconciliation',
  'dispatch_outcome_unknown',
  'kill_switch_engaged',
  'task_outcome_unknown',
  'mission_ready_review',
  'mission_verified_awaiting_close',
  'mission_execution_ready_review',
  'mission_plan_needs_founder',
  'truth_awaiting_acceptance',
  'handoff_requested',
  'disagreement_open',
  'mission_working_nothing_in_motion',
] as const);
export type InboxAttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * The authority an item or a recommendation TAKES — named from the existing
 * gates, never invented.
 *
 * Every id here is REACHED by some derivation (pinned in
 * `chief-of-staff-core.test.ts`): an authority nobody can be sent to would be
 * vocabulary claiming a rule that does not exist. Two names an earlier draft
 * carried — a bare `truth_verify` and a `worker_claim` — were removed for
 * exactly that reason: contradictions resolve under `truth_record_or_verify`
 * (either act settles one), and a claimable task is listed with its eligible
 * workers rather than with an authority the Founder would exercise.
 */
export const REQUIRED_AUTHORITIES = deepFreeze([
  'approval_authority',
  'approval_authority_step_up',
  'independent_review',
  'reconciliation_authority',
  'mission_command',
  'mission_command_and_approval_authority',
  'mission_orchestrate_step_up',
  'workforce_assign',
  'truth_record_or_verify',
  'founder_decision',
  'founder_brief',
  'none_read_only',
] as const);
export type RequiredAuthority = (typeof REQUIRED_AUTHORITIES)[number];

/** Whether a fact is current against its canonical subject. Never a tie-breaker. */
export type Staleness = 'current' | 'stale' | 'not_evaluated';

/**
 * The canonical tables an attention item may reference. Enumerated as a value
 * so a test can prove every one of them is genuinely reached — a table named
 * here that no derivation sources from would be a claim about where HQ looks
 * that is not true.
 */
export const SOURCE_TABLES = deepFreeze([
  'hq_approvals',
  'op_tasks',
  'hq_missions',
  'hq_mission_plan_items',
  'hq_truth_relations',
  'hq_truth_records',
  'hq_action_intents',
  'op_evidence',
  'op_kill_switch',
  'hq_collab_contributions',
  'hq_collab_relations',
] as const);
export type SourceTable = (typeof SOURCE_TABLES)[number];

export type EntityRefKind =
  | 'mission'
  | 'task'
  | 'approval'
  | 'truth'
  | 'action'
  | 'worker'
  | 'capability'
  | 'kill_switch'
  | 'session'
  | 'contribution'
  | 'project'
  | 'memory';

export interface EntityRef {
  kind: EntityRefKind;
  id: string;
}

/**
 * The entity a truth record (or a contradiction between two of them) is
 * ABOUT, as an inbox entity reference.
 *
 * Every `TruthEntityKind` has an `EntityRefKind` of the same name, so this is
 * a total, lossless mapping and never relabels one kind as another. The
 * earlier draft of this module collapsed `memory` onto `truth`, which made an
 * item claim a memory id was a truth id — a small lie, but exactly the kind
 * this phase exists to refuse.
 */
export function truthSubjectRef(entityKind: TruthEntityKind, entityId: string): EntityRef {
  return { kind: entityKind, id: entityId };
}

export const RECOMMENDATION_KINDS = deepFreeze([
  'decide_pending_approval',
  'renew_expired_approval',
  'review_submitted_result',
  'resolve_contradiction',
  'accept_verified_truth',
  'reconcile_external_action',
  'reconcile_dispatch_outcome',
  'reconcile_task_outcome',
  'decide_kill_switch',
  'unblock_task',
  'unblock_mission',
  'verify_mission_ready_for_review',
  'close_verified_mission',
  'move_mission_to_review',
  'specify_or_clarify_plan',
  'decide_handoff',
  'settle_disagreement',
  'revisit_stale_mission',
  'decide_high_risk_action',
] as const);
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/** The acts HQ can perform or offer NOW that are reads or records under existing authority. */
export const SAFE_ACT_KINDS = deepFreeze(['orchestration_preview', 'issue_founder_brief', 'assemble_collaboration_context'] as const);
export type SafeActKind = (typeof SAFE_ACT_KINDS)[number];

/**
 * The department projections. Each is a PROJECTION over canonical truth —
 * or an honest `not_recorded` statement where HQ records nothing that would
 * make the department real (the room-binding rule: a department with no
 * canonical source renders as one with no canonical source).
 */
/**
 * The `op_evidence` kinds that record a REFUSAL — enumerated, not pattern
 * matched, so the Cybersecurity projection's count is the size of a set HQ
 * can name rather than whatever a substring search happened to hit. Every id
 * here is a kind some enforcement path genuinely appends today; a kind never
 * written simply contributes 0, which is the honest answer for a deployment
 * that has never refused anything of that shape.
 */
export const REFUSAL_EVIDENCE_KINDS = deepFreeze([
  'action_refused',
  'approval_authority_refused',
  'approval_refused_action_changed',
  'approval_rejected_at_execution',
  'denial_digest_divergence',
  'enqueue_denied',
  'founder_denied',
  'human_execution_refused',
  'mission_proposal_rejected',
  'nomination_source_failed',
  'principal_rejected',
  'provider_binding_rejected',
  'truth_acceptance_refused_basis_changed',
  'worker_not_assignable',
] as const);
export type RefusalEvidenceKind = (typeof REFUSAL_EVIDENCE_KINDS)[number];

export const DEPARTMENTS = deepFreeze([
  'development',
  'ops',
  'cybersecurity',
  'research',
  'product',
  'finance',
  'business',
  'memory',
  'ai_workforce',
] as const);
export type CommandCenterDepartment = (typeof DEPARTMENTS)[number];

// ---- the one capability trio ----

/**
 * The Founder act: issuing a brief RECEIPT. `founder_gate` because a brief
 * states, under the Founder's name, what the company record held at a
 * watermark; `sideEffect: false` because it writes one ledger row and
 * reaches nothing outside. Reading the command layer takes no capability —
 * the routes sit behind the Founder gate exactly as the Mission Room does.
 */
export const FOUNDER_BRIEF_CAPABILITY = deepFreeze({
  id: 'hq.founder_brief',
  description:
    'Founder brief — issues one durable brief receipt over the derived command layer: who, when, ' +
    'the canonical watermarks it observed, categorical counts and a content digest. Records only; ' +
    'executes nothing, notifies nobody, decides nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the founder-brief capability — a CONFIGURATION action. */
export function registerFounderBriefCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...FOUNDER_BRIEF_CAPABILITY });
}

export function founderBriefContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== FOUNDER_BRIEF_CAPABILITY.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== FOUNDER_BRIEF_CAPABILITY.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== FOUNDER_BRIEF_CAPABILITY.idempotent) drift.push('idempotent');
  return drift;
}

export type FounderBriefCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry row — enforcement-safe read, drift before enabled, never repairs. */
export function founderBriefCapabilityState(capability: Capability | null): FounderBriefCapabilityState {
  if (!capability) return 'missing';
  if (founderBriefContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

/** Bounded reads: the true total is always stated beside a bounded list. */
export const INBOX_READ_LIMIT = 50;
/** Per-section cap on the briefing's lists. */
export const BRIEFING_SECTION_LIMIT = 20;
/** How many canonical events the "what changed" section carries (newest first). */
export const CHANGED_EVENT_LIMIT = 20;
/** How many issued briefs a list read carries (newest first). */
export const BRIEF_READ_LIMIT = 20;
/** How many attention items the snapshot section carries. */
export const COMMAND_CENTER_SNAPSHOT_LIMIT = 20;

// ---- idempotency and digests ----

/** The canonical position a brief observed: the newest `hq_events` and `op_evidence` sequence numbers. */
export interface CanonicalWatermark {
  eventSeq: number;
  evidenceSeq: number;
}

/**
 * Derived dedupe key for a brief: the same Founder issuing over the same
 * watermarks is the same brief (nothing changed, nothing new to receipt).
 * The caller's `idempotencyKey` is an INPUT to the digest (the mission
 * rule), never the key.
 */
export function briefIdempotencyKey(input: {
  requestedBy: string;
  watermark: CanonicalWatermark;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `founder-brief:${digest.slice(0, 32)}`;
}

/** SHA-256 over the canonical JSON of a derived document, so a receipt can be checked against a re-derivation. */
export function contentDigest(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

// ---- schema: the brief ledger, INSERT-only BY ENGINE ----

/**
 * One row per issued brief. The full §G trigger set (the hq_collab_* recipe):
 * no UPDATE, no DELETE, a BEFORE INSERT guard on `id`/`seq` AND the secondary
 * unique index (`idempotency_key`), so REPLACE / UPSERT is closed on every
 * conflict target for every writer regardless of `recursive_triggers`.
 * `seq INTEGER PRIMARY KEY`: the implicit rowid IS `seq`.
 *
 * A brief row is a RECEIPT — who, when, the watermarks, categorical counts
 * and a content digest. It stores no attention item, no recommendation and
 * no document body: those are re-derived on every read, so a stale receipt
 * can never be mistaken for current truth.
 */
const BRIEF_DDL = `
CREATE TABLE IF NOT EXISTS hq_briefs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  evidence_seq INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  counts TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS trg_hq_briefs_no_rewrite
BEFORE UPDATE ON hq_briefs
BEGIN SELECT RAISE(ABORT, 'hq_briefs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_briefs_no_erase
BEFORE DELETE ON hq_briefs
BEGIN SELECT RAISE(ABORT, 'hq_briefs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_briefs_no_replace
BEFORE INSERT ON hq_briefs
WHEN EXISTS (SELECT 1 FROM hq_briefs WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_briefs WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM hq_briefs WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_briefs is append-only'); END;
`;

/** Idempotent; readonly-safe (the post-Phase-3 ensure*Schema pattern). */
export function ensureBriefSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(BRIEF_DDL);
}

/** True when the brief ledger exists in this file — observation, never migration. */
export function briefSchemaPresent(db: HqDatabase): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_briefs'`).get() !== undefined;
}

export interface BriefCounts {
  attention: { total: number; byKind: Record<AttentionKind, number> };
  unknown: { total: number };
  blocked: { total: number };
  recommendations: { total: number };
}

export interface BriefRow {
  seq: number;
  id: string;
  issuedBy: string;
  issuedAt: string;
  watermark: CanonicalWatermark;
  contentDigest: string;
  counts: BriefCounts;
}

function rowToBrief(r: Record<string, unknown>): BriefRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    issuedBy: r.issued_by as string,
    issuedAt: r.issued_at as string,
    watermark: { eventSeq: r.event_seq as number, evidenceSeq: r.evidence_seq as number },
    contentDigest: r.content_digest as string,
    counts: JSON.parse(r.counts as string) as BriefCounts,
  };
}

export function loadBrief(db: HqDatabase, id: string): BriefRow | null {
  const row = db.prepare(`SELECT * FROM hq_briefs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToBrief(row) : null;
}

/** Every brief, newest first. */
export function loadBriefs(db: HqDatabase): BriefRow[] {
  return (db.prepare(`SELECT * FROM hq_briefs ORDER BY seq DESC`).all() as Record<string, unknown>[]).map(rowToBrief);
}

export function loadLatestBrief(db: HqDatabase): BriefRow | null {
  const row = db.prepare(`SELECT * FROM hq_briefs ORDER BY seq DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
  return row ? rowToBrief(row) : null;
}

/** The browser-safe view of a brief receipt — the row, verbatim, minus the idempotency key. */
export interface BriefView {
  id: string;
  seq: number;
  issuedBy: string;
  issuedAt: string;
  watermark: CanonicalWatermark;
  contentDigest: string;
  counts: BriefCounts;
}

export function briefView(row: BriefRow): BriefView {
  return {
    id: row.id,
    seq: row.seq,
    issuedBy: row.issuedBy,
    issuedAt: row.issuedAt,
    watermark: { ...row.watermark },
    contentDigest: row.contentDigest,
    counts: JSON.parse(JSON.stringify(row.counts)) as BriefCounts,
  };
}

// ---- the canonical facts the core derives from ----

/**
 * What the facade gathers through `#db` and hands to the pure core. Every
 * field is a copy of a canonical row (or a derivation the accepted phases
 * already make: a truth record's derived view, an action's ledger state).
 * The core reads nothing else.
 */
export interface MissionFact {
  id: string;
  title: string;
  status: MissionStatus;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  /** False when the Founder stated no acceptance criteria (an explicit unknown). */
  acceptanceCriteriaStated: boolean;
  dependsOn: { missionId: string; status: MissionStatus | null }[];
  /** Live plan items only (superseded ones are history, not work). */
  planItems: { seq: number; kind: 'work' | 'needs_clarification'; taskId: string | null; specCapabilityId: string | null }[];
  linkedTasks: { taskId: string; status: ActivityStatus; reviewPending: boolean; claimedBy: string | null }[];
  /** The Phase 6 spec-scope kill switches engaged for this mission's specified items, read canonically. */
  engagedSpecScopes: string[];
  /** Whether the orchestrate capability row is registered and enabled — read canonically. */
  specCapabilitiesUnavailable: string[];
}

export interface TaskFact {
  id: string;
  capabilityId: string;
  status: ActivityStatus;
  reviewPending: boolean;
  claimedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  blockReason: string | null;
  submittedBy: string | null;
  title: string | null;
  /** Registered, assignable workers granted the capability and not denied by policy — the evidence-free eligibility read. */
  eligibleWorkers: string[];
}

export interface ApprovalFact {
  id: string;
  taskId: string | null;
  riskClass: string;
  requestedBy: string;
  requestedAt: string;
  decision: string;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
}

export interface KillSwitchFact {
  scope: string;
  reason: string | null;
  engagedBy: string | null;
  engagedAt: string | null;
}

export interface TruthFact {
  id: string;
  seq: number;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  state: TruthState;
  lifecycle: 'current' | 'superseded';
  verification: TruthVerificationSummary;
  contested: boolean;
  recordedBy: string;
  recordedAt: string;
  evidenceRefs: string[];
  privacy: 'internal' | 'founder_only';
  subjectDrift: SubjectDrift;
  /** Present exactly while the record is verified, current and uncontested. */
  acceptanceDigest: string | null;
  /** Stated limitations of the confirming verifications, verbatim (the verifier's own words). */
  verificationLimitations: string[];
}

export interface ContradictionFact {
  a: string;
  b: string;
  entityKind: TruthEntityKind;
  entityId: string;
  resolution: string;
  statedBy: string;
  statedAt: string;
}

export interface ActionFact {
  id: string;
  taskId: string;
  missionId: string | null;
  adapterId: string;
  actionType: string;
  riskLevel: ActionRiskLevel;
  state: ActionState;
  requestedBy: string;
  requestedAt: string;
  /** When the attempt was opened, if one was. */
  attemptedAt: string | null;
}

/**
 * The Phase 9 collaboration record as facts.
 *
 * `privacy` is carried on EVERY entry, not looked up from the session list:
 * a disagreement and a handoff each name the room they were recorded in, and
 * what a reading layer may disclose about them is decided by that room's own
 * classification. Carrying it per entry means no derivation can accidentally
 * default a private room's activity to `internal` by failing a lookup
 * (Phase 10 correction, M1).
 */
export interface CollaborationFact {
  sessions: {
    id: string;
    missionId: string;
    missionStatus: MissionStatus | null;
    standing: SessionStanding;
    title: string;
    /** The session's own classification, verbatim from `hq_collab_sessions.privacy`. */
    privacy: CollaborationPrivacy;
  }[];
  disagreements: {
    sessionId: string;
    missionId: string;
    contributionId: string;
    workerId: string;
    role: CollaborationRole;
    disputesId: string;
    disputedWorkerId: string;
    at: string;
    /** The privacy of the session this stance was recorded in. */
    privacy: CollaborationPrivacy;
  }[];
  handoffs: {
    contributionId: string;
    sessionId: string;
    missionId: string;
    taskId: string;
    fromWorkerId: string;
    toWorkerId: string;
    at: string;
    canonical: { status: ActivityStatus; claimedBy: string | null; assignedWorkerId: string | null } | null;
    /** The privacy of the session this request was recorded in. */
    privacy: CollaborationPrivacy;
  }[];
}

/**
 * One task's Claude GitHub dispatch lane, as the hash-chained evidence rows
 * left it.
 *
 * The lane state is not a fact of its own: it is a fold over `op_evidence`,
 * and exactly ONE row establishes the state a reader is shown — the attempt
 * row with no terminal after it (`unknown`), or the success row (`dispatched`).
 * That row's canonical identity is carried here, because an attention item
 * derived from this lane must reference the row it exists because of.
 *
 * Recorded deliberately (Phase 10 correction, M2): the draft carried the task
 * id only, and the `dispatch_outcome_unknown` item published
 * `{ table: 'op_evidence', id: <task id> }` — a source reference that named
 * the evidence log while carrying an `op_tasks` id, so nothing could resolve
 * it against `op_evidence` and the false pair propagated into the derived
 * recommendation's `sourceFacts`. The evidence identity now travels with the
 * lane and the task id stays where it belongs, in `entities`.
 */
export interface DispatchLaneFact {
  taskId: string;
  state: 'unknown' | 'dispatched';
  /** The `at` of the evidence row that established this state. */
  at: string;
  /** `op_evidence.id` of that row — the canonical row identity an item references. */
  evidenceId: string;
  /** `op_evidence.seq` of that row — its position in the append-only hash chain. */
  evidenceSeq: number;
}

export interface WorkerFact {
  id: string;
  displayName: string;
  active: boolean;
  providerDeclared: string | null;
  memberIdentityKey: string | null;
  liveClaims: number;
}

export interface ProjectFact {
  id: string;
  name: string;
  status: string;
  missionIds: string[];
}

export interface CommandFacts {
  now: string;
  missions: MissionFact[];
  tasks: TaskFact[];
  approvals: ApprovalFact[];
  killSwitches: KillSwitchFact[];
  truth: TruthFact[];
  contradictions: ContradictionFact[];
  actions: ActionFact[];
  collaboration: CollaborationFact;
  dispatchLane: DispatchLaneFact[];
  workers: WorkerFact[];
  projects: ProjectFact[];
  memory: { total: number; current: number; founderOnly: number; byKind: Record<string, number> };
  capabilities: { id: string; riskClass: string; sideEffect: boolean; enabled: boolean }[];
  orchestrationRuns: number;
  /** Counts of security-refusal evidence kinds ever recorded (the chain is append-only, so "ever" is exact). */
  refusalEvidence: Record<string, number>;
  /** Whether each store exists on this handle; an absent store is stated, never read as empty. */
  stores: {
    missions: boolean;
    projects: boolean;
    memory: boolean;
    truth: boolean;
    actions: boolean;
    collaboration: boolean;
    briefs: boolean;
  };
}

// ---- the Founder Inbox: a DERIVED attention queue ----

/**
 * One inbox item. A REFERENCE to a canonical record plus the categorical
 * facts that put it here — never a copy of the authority it points at, and
 * never a number HQ did not count.
 */
export interface InboxAttentionItem {
  /** Deterministic: `<kind>:<reason>:<source id>` — the same source derives the same id on every read. */
  id: string;
  kind: AttentionKind;
  reason: InboxAttentionReason;
  /** The canonical row this item exists because of. */
  source: { table: SourceTable; id: string };
  /** Every canonical entity the item touches, for tracing. */
  entities: EntityRef[];
  /** One line composed from canonical fields. */
  summary: string;
  /** The source record's own canonical timestamp, or null when it carries none (never invented). */
  since: string | null;
  staleness: Staleness;
  /** The existing gate the resolving act would pass. */
  requiredAuthority: RequiredAuthority;
  /** Provenance: which derivation and which canonical store answered. */
  provenance: string;
  /**
   * True when the item derives from FOUNDER-PRIVATE MATERIAL — withheld from
   * the unauthenticated artifact and from every count beside it.
   *
   * Two canonical classifications feed this, both using the same
   * `internal | founder_only` vocabulary:
   * - `hq_truth_records.privacy` — the record the item is about;
   * - `hq_collab_sessions.privacy` — the room the contribution or stance the
   *   item is about was recorded in (Phase 10 correction, M1: a private
   *   room's existence, participants and activity are Founder-private, so an
   *   item narrating them is too).
   *
   * Deliberately ONE flag rather than a parallel `privateSource`: every
   * reading layer already honours this one, and a second flag would need
   * every layer to remember to honour it — the failure mode this correction
   * exists to close.
   */
  founderOnly: boolean;
}

const KIND_INDEX = new Map<AttentionKind, number>(ATTENTION_KINDS.map((kind, index) => [kind, index]));

/** Group by kind (vocabulary order), then oldest canonical timestamp first, then id — a stated grouping, never a score. */
export function orderAttentionItems(items: readonly InboxAttentionItem[]): InboxAttentionItem[] {
  return [...items].sort((a, b) => {
    const kind = KIND_INDEX.get(a.kind)! - KIND_INDEX.get(b.kind)!;
    if (kind !== 0) return kind;
    if (a.since !== b.since) {
      if (a.since === null) return 1;
      if (b.since === null) return -1;
      return a.since.localeCompare(b.since);
    }
    return a.id.localeCompare(b.id);
  });
}

const TERMINAL_MISSION: readonly MissionStatus[] = ['complete', 'failed', 'cancelled'];
const ATTENTION_TASK_MOTION: readonly ActivityStatus[] = [
  'queued',
  'assigned',
  'running',
  'needs_approval',
  'blocked',
  'review_failed',
  'outcome_unknown',
];

function itemId(kind: AttentionKind, reason: InboxAttentionReason, sourceId: string): string {
  return `${kind}:${reason}:${sourceId}`;
}

/**
 * The ONE canonical predicate for "this is waiting on a Founder decision".
 *
 * Recorded deliberately, because the obvious predicate is wrong in this
 * codebase: HQ writes an `hq_approvals` row when a decision is MADE
 * (`approveTask` and `denyTask` each insert one, `approved` or `denied`), not
 * when one is requested. A task waiting on the Founder therefore has no
 * approval row at all, and `hq_approvals.decision = 'pending'` is a state the
 * canonical facade never writes. `op_tasks.status = 'needs_approval'` is the
 * one canonical "this needs the Founder" fact.
 *
 * Every reader of that fact — the Founder Inbox item, WHAT IS BLOCKED's
 * `heldForApproval`, and the ops department's executive metric (Phase 10
 * correction, M1: it counted `hq_approvals.decision = 'pending'` and so
 * reported 0 while the queue held real work) — goes through this function, so
 * the three can never disagree about what is at the gate.
 */
export function tasksHeldAtFounderGate(facts: CommandFacts): TaskFact[] {
  return facts.tasks.filter((task) => task.status === 'needs_approval');
}

function truthStaleness(drift: SubjectDrift): Staleness {
  if (drift === 'not_evaluated') return 'not_evaluated';
  return drift === 'none' ? 'current' : 'stale';
}

/**
 * The derivation rules, as predicates over canonical rows. Each `if` below IS
 * the rule; the reason code names it. Nothing here reads a timestamp to
 * decide anything except `approval_expired_unconsumed`, which compares the
 * canonical `expires_at` against the supplied clock.
 */
export function deriveFounderInbox(facts: CommandFacts): InboxAttentionItem[] {
  const items: InboxAttentionItem[] = [];
  const taskById = new Map(facts.tasks.map((t) => [t.id, t]));
  const missionById = new Map(facts.missions.map((m) => [m.id, m]));
  const truthById = new Map(facts.truth.map((t) => [t.id, t]));
  const taskLabel = (id: string) => {
    const task = taskById.get(id);
    return task?.title ? `${task.title} (${id})` : id;
  };

  // approval: the canonical task status IS the Founder gate holding the task,
  // read through the shared predicate (`tasksHeldAtFounderGate`) so this item
  // and every other reader of the gate count the same rows.
  for (const task of tasksHeldAtFounderGate(facts)) {
    items.push({
      id: itemId('approval', 'task_awaiting_approval', task.id),
      kind: 'approval',
      reason: 'task_awaiting_approval',
      source: { table: 'op_tasks', id: task.id },
      entities: [{ kind: 'task', id: task.id }, { kind: 'capability', id: task.capabilityId }],
      summary: `Task ${taskLabel(task.id)} (${task.capabilityId}) is held at the Founder gate and executes nothing until the Founder decides it, requested by ${task.createdBy}.`,
      since: task.updatedAt,
      staleness: 'current',
      requiredAuthority: 'approval_authority',
      provenance: 'op_tasks.status = needs_approval',
      founderOnly: false,
    });
  }
  for (const approval of facts.approvals) {
    // approval: approved, never consumed, and past its expiry → the task cannot run on it.
    if (
      approval.decision === 'approved' &&
      approval.consumedAt === null &&
      approval.expiresAt !== null &&
      approval.expiresAt < facts.now &&
      approval.taskId !== null &&
      taskById.get(approval.taskId)?.status !== 'completed'
    ) {
      items.push({
        id: itemId('approval', 'approval_expired_unconsumed', approval.id),
        kind: 'approval',
        reason: 'approval_expired_unconsumed',
        source: { table: 'hq_approvals', id: approval.id },
        entities: [
          { kind: 'approval', id: approval.id },
          { kind: 'task', id: approval.taskId },
        ],
        summary: `Approval ${approval.id} on task ${taskLabel(approval.taskId)} expired at ${approval.expiresAt} without being consumed; the task cannot execute on it.`,
        since: approval.expiresAt,
        staleness: 'stale',
        requiredAuthority: 'approval_authority',
        provenance: 'hq_approvals.decision = approved AND consumed_at IS NULL AND expires_at < now',
        founderOnly: false,
      });
    }
  }

  // review: review_state = 'pending' → an independent reviewer decides.
  for (const task of facts.tasks) {
    if (task.reviewPending) {
      items.push({
        id: itemId('review', 'review_pending', task.id),
        kind: 'review',
        reason: 'review_pending',
        source: { table: 'op_tasks', id: task.id },
        entities: [{ kind: 'task', id: task.id }],
        summary: `Task ${taskLabel(task.id)} awaits independent review${task.submittedBy ? ` (submitted by ${task.submittedBy})` : ''}.`,
        since: task.updatedAt,
        staleness: 'current',
        requiredAuthority: 'independent_review',
        provenance: 'op_tasks.review_state = pending',
        founderOnly: false,
      });
    }
  }

  // contradiction: resolution = 'unresolved' → explicit act elsewhere, never recency.
  for (const pair of facts.contradictions) {
    if (pair.resolution !== 'unresolved') continue;
    const a = truthById.get(pair.a);
    const b = truthById.get(pair.b);
    const drifted = [a, b].some((r) => r && r.subjectDrift !== 'none' && r.subjectDrift !== 'not_evaluated');
    const notEvaluated = [a, b].every((r) => !r || r.subjectDrift === 'not_evaluated');
    items.push({
      id: itemId('contradiction', 'contradiction_unresolved', `${pair.a}~${pair.b}`),
      kind: 'contradiction',
      reason: 'contradiction_unresolved',
      source: { table: 'hq_truth_relations', id: `${pair.a}~${pair.b}` },
      entities: [
        { kind: 'truth', id: pair.a },
        { kind: 'truth', id: pair.b },
        truthSubjectRef(pair.entityKind, pair.entityId),
      ],
      summary: `Truth ${pair.a} contradicts ${pair.b} about ${pair.entityKind} ${pair.entityId} (stated by ${pair.statedBy}); neither side is preferred by recency.`,
      since: pair.statedAt,
      staleness: drifted ? 'stale' : notEvaluated ? 'not_evaluated' : 'current',
      requiredAuthority: 'truth_record_or_verify',
      provenance: 'hq_truth_relations kind = contradicts, judged unresolved by the Phase 7 derivation',
      founderOnly: a?.privacy === 'founder_only' || b?.privacy === 'founder_only',
    });
  }

  // blocked: task blocked / review_failed; mission blocked; mission dependency terminal-not-complete.
  for (const task of facts.tasks) {
    if (task.status === 'blocked' || task.status === 'review_failed') {
      const reason: InboxAttentionReason = task.status === 'blocked' ? 'task_blocked' : 'task_review_failed';
      items.push({
        id: itemId('blocked', reason, task.id),
        kind: 'blocked',
        reason,
        source: { table: 'op_tasks', id: task.id },
        entities: [{ kind: 'task', id: task.id }],
        summary: `Task ${taskLabel(task.id)} is ${task.status}${task.blockReason ? `: ${task.blockReason}` : ''}.`,
        since: task.updatedAt,
        staleness: 'current',
        requiredAuthority: 'founder_decision',
        provenance: `op_tasks.status = ${task.status}`,
        founderOnly: false,
      });
    }
  }
  for (const mission of facts.missions) {
    if (mission.status === 'blocked') {
      items.push({
        id: itemId('blocked', 'mission_blocked', mission.id),
        kind: 'blocked',
        reason: 'mission_blocked',
        source: { table: 'hq_missions', id: mission.id },
        entities: [{ kind: 'mission', id: mission.id }],
        summary: `Mission ${mission.title} (${mission.id}) is blocked${mission.blockReason ? `: ${mission.blockReason}` : ''}.`,
        since: mission.statusChangedAt,
        staleness: 'current',
        requiredAuthority: 'mission_command',
        provenance: 'hq_missions.status = blocked',
        founderOnly: false,
      });
    }
    if (TERMINAL_MISSION.includes(mission.status)) continue;
    for (const dependency of mission.dependsOn) {
      if (dependency.status === 'failed' || dependency.status === 'cancelled') {
        items.push({
          id: itemId('blocked', 'mission_dependency_terminal', `${mission.id}~${dependency.missionId}`),
          kind: 'blocked',
          reason: 'mission_dependency_terminal',
          source: { table: 'hq_missions', id: mission.id },
          entities: [
            { kind: 'mission', id: mission.id },
            { kind: 'mission', id: dependency.missionId },
          ],
          summary: `Mission ${mission.title} (${mission.id}) depends on mission ${dependency.missionId}, which is ${dependency.status}.`,
          since: mission.updatedAt,
          staleness: 'current',
          requiredAuthority: 'mission_command',
          provenance: 'hq_missions.depends_on names a mission whose hq_missions.status is failed or cancelled (advisory dependency)',
          founderOnly: false,
        });
      }
    }
  }

  // risk: high/critical action still open (proposed/authorized) → it needs a Founder approval to execute at all.
  for (const action of facts.actions) {
    if ((action.riskLevel === 'high' || action.riskLevel === 'critical') && (action.state === 'proposed' || action.state === 'authorized')) {
      items.push({
        id: itemId('risk', 'action_high_risk_open', action.id),
        kind: 'risk',
        reason: 'action_high_risk_open',
        source: { table: 'hq_action_intents', id: action.id },
        entities: [
          { kind: 'action', id: action.id },
          { kind: 'task', id: action.taskId },
          ...(action.missionId ? [{ kind: 'mission' as const, id: action.missionId }] : []),
        ],
        summary: `External action ${action.id} (${action.adapterId}/${action.actionType}) is ${action.riskLevel} risk and ${action.state}; the gateway executes it only under a bound Founder approval.`,
        since: action.requestedAt,
        staleness: 'current',
        requiredAuthority: 'approval_authority',
        provenance: 'hq_action_intents.risk_level in (high, critical) AND derived state in (proposed, authorized)',
        founderOnly: false,
      });
    }
    // external_action: attempted (open or lost) / outcome_unknown → human reconciliation, never auto-retry.
    if (action.state === 'attempted' || action.state === 'outcome_unknown') {
      items.push({
        id: itemId('external_action', 'action_awaiting_reconciliation', action.id),
        kind: 'external_action',
        reason: 'action_awaiting_reconciliation',
        source: { table: 'hq_action_intents', id: action.id },
        entities: [
          { kind: 'action', id: action.id },
          { kind: 'task', id: action.taskId },
        ],
        summary: `External action ${action.id} (${action.adapterId}/${action.actionType}) is ${action.state}; its outcome is unknown until a human reconciles it, and it is never retried automatically.`,
        since: action.attemptedAt ?? action.requestedAt,
        staleness: 'current',
        requiredAuthority: 'approval_authority_step_up',
        provenance: 'hq_action_events last state in (attempted, outcome_unknown)',
        founderOnly: false,
      });
    }
  }
  for (const lane of facts.dispatchLane) {
    if (lane.state !== 'unknown') continue;
    // The source is the `op_evidence` ATTEMPT ROW that left this lane
    // unknown, by its own canonical id — resolvable against the evidence log
    // it names. The task is an affected entity, not the source row.
    items.push({
      id: itemId('external_action', 'dispatch_outcome_unknown', lane.evidenceId),
      kind: 'external_action',
      reason: 'dispatch_outcome_unknown',
      source: { table: 'op_evidence', id: lane.evidenceId },
      entities: [{ kind: 'task', id: lane.taskId }],
      summary: `The Claude GitHub dispatch for task ${taskLabel(lane.taskId)} was attempted (op_evidence entry ${lane.evidenceId}, seq ${lane.evidenceSeq}) and has no terminal record; whether an issue was published is unknown.`,
      since: lane.at,
      staleness: 'current',
      requiredAuthority: 'reconciliation_authority',
      provenance: 'op_evidence: claude_github_dispatch_attempted with no succeeded/failed after it',
      founderOnly: false,
    });
  }

  // incident: an engaged kill switch; a task whose outcome is unknown.
  for (const stop of facts.killSwitches) {
    items.push({
      id: itemId('incident', 'kill_switch_engaged', stop.scope),
      kind: 'incident',
      reason: 'kill_switch_engaged',
      source: { table: 'op_kill_switch', id: stop.scope },
      entities: [{ kind: 'kill_switch', id: stop.scope }],
      // The Founder's free-text `reason` is deliberately NOT composed into
      // this summary. An inbox item rides the UNAUTHENTICATED artifact, and
      // the pre-existing artifact kill-switch surface (`operations.killSwitch`)
      // publishes scopes only and never the reason — Phase 10 must not be the
      // thing that puts it there. Whether a reason was recorded is a
      // categorical fact and IS stated; the text itself is carried verbatim
      // on the Founder-gated briefing's `blocked.killSwitches`.
      summary:
        `Kill switch engaged for scope ${stop.scope}${stop.engagedBy ? ` (by ${stop.engagedBy})` : ''}. ` +
        `${stop.reason ? 'A reason is recorded' : 'No reason was recorded'}; the reason text is read behind the Founder gate, not here.`,
      since: stop.engagedAt,
      staleness: 'not_evaluated',
      requiredAuthority: 'approval_authority',
      provenance: 'op_kill_switch.engaged = 1',
      founderOnly: false,
    });
  }
  for (const task of facts.tasks) {
    if (task.status === 'outcome_unknown') {
      items.push({
        id: itemId('incident', 'task_outcome_unknown', task.id),
        kind: 'incident',
        reason: 'task_outcome_unknown',
        source: { table: 'op_tasks', id: task.id },
        entities: [{ kind: 'task', id: task.id }],
        summary: `Task ${taskLabel(task.id)} is outcome_unknown; it leaves that state only by an explicit reconciliation and is never retried blindly.`,
        since: task.updatedAt,
        staleness: 'current',
        requiredAuthority: 'reconciliation_authority',
        provenance: 'op_tasks.status = outcome_unknown',
        founderOnly: false,
      });
    }
  }

  // decision: the Founder's own lifecycle and plan decisions, verified truth awaiting acceptance, room decisions.
  for (const mission of facts.missions) {
    if (mission.status === 'ready_review') {
      items.push({
        id: itemId('decision', 'mission_ready_review', mission.id),
        kind: 'decision',
        reason: 'mission_ready_review',
        source: { table: 'hq_missions', id: mission.id },
        entities: [{ kind: 'mission', id: mission.id }],
        summary: `Mission ${mission.title} (${mission.id}) is ready_review; verifying it is an explicit Founder decision with a note.`,
        since: mission.statusChangedAt,
        staleness: 'current',
        requiredAuthority: 'mission_command_and_approval_authority',
        provenance: 'hq_missions.status = ready_review',
        founderOnly: false,
      });
    }
    if (mission.status === 'verified') {
      items.push({
        id: itemId('decision', 'mission_verified_awaiting_close', mission.id),
        kind: 'decision',
        reason: 'mission_verified_awaiting_close',
        source: { table: 'hq_missions', id: mission.id },
        entities: [{ kind: 'mission', id: mission.id }],
        summary: `Mission ${mission.title} (${mission.id}) is verified and not yet closed.`,
        since: mission.statusChangedAt,
        staleness: 'current',
        requiredAuthority: 'mission_command',
        provenance: 'hq_missions.status = verified',
        founderOnly: false,
      });
    }
    if (TERMINAL_MISSION.includes(mission.status)) continue;
    const work = mission.planItems.filter((item) => item.kind === 'work');
    const clarification = mission.planItems.filter((item) => item.kind === 'needs_clarification');
    const unspecified = work.filter((item) => item.taskId === null && item.specCapabilityId === null);
    if (clarification.length > 0 || unspecified.length > 0) {
      items.push({
        id: itemId('decision', 'mission_plan_needs_founder', mission.id),
        kind: 'decision',
        reason: 'mission_plan_needs_founder',
        source: { table: 'hq_mission_plan_items', id: mission.id },
        entities: [{ kind: 'mission', id: mission.id }],
        summary: `Mission ${mission.title} (${mission.id}) has ${clarification.length} item(s) needing clarification and ${unspecified.length} work item(s) with no Founder spec; nothing can orchestrate them.`,
        since: mission.updatedAt,
        staleness: 'current',
        requiredAuthority: 'mission_command',
        provenance: 'hq_mission_plan_items live rows: kind = needs_clarification, or kind = work with no task and no spec',
        founderOnly: false,
      });
    }
    if (mission.status === 'working') {
      const allLinked = work.length > 0 && work.every((item) => item.taskId !== null);
      const allComplete = mission.linkedTasks.length > 0 && mission.linkedTasks.every((task) => task.status === 'completed');
      const inMotion = mission.linkedTasks.some((task) => ATTENTION_TASK_MOTION.includes(task.status) || task.reviewPending);
      if (allLinked && allComplete && clarification.length === 0) {
        items.push({
          id: itemId('decision', 'mission_execution_ready_review', mission.id),
          kind: 'decision',
          reason: 'mission_execution_ready_review',
          source: { table: 'hq_missions', id: mission.id },
          entities: [{ kind: 'mission', id: mission.id }, ...mission.linkedTasks.map((t) => ({ kind: 'task' as const, id: t.taskId }))],
          summary: `Mission ${mission.title} (${mission.id}) is working and every linked task is completed; the Phase 6 derivation recommends ready_review, which only the Founder moves.`,
          since: mission.updatedAt,
          staleness: 'current',
          requiredAuthority: 'mission_command',
          provenance: 'hq_missions.status = working AND every live work item linked AND every op_tasks row completed',
          founderOnly: false,
        });
      } else if (!inMotion) {
        // stale_mission: working, and nothing linked is in motion or awaiting anyone — the mission says working while nothing works.
        items.push({
          id: itemId('stale_mission', 'mission_working_nothing_in_motion', mission.id),
          kind: 'stale_mission',
          reason: 'mission_working_nothing_in_motion',
          source: { table: 'hq_missions', id: mission.id },
          entities: [{ kind: 'mission', id: mission.id }],
          summary: `Mission ${mission.title} (${mission.id}) is working, but no linked task is queued, claimed, running, held or awaiting review (${mission.linkedTasks.length} linked task(s)); the status may no longer describe anything.`,
          since: mission.statusChangedAt,
          staleness: 'stale',
          requiredAuthority: 'mission_command',
          provenance: 'hq_missions.status = working AND no linked op_tasks row in a non-terminal, non-passed status',
          founderOnly: false,
        });
      }
    }
  }
  for (const record of facts.truth) {
    if (record.acceptanceDigest === null) continue;
    items.push({
      id: itemId('decision', 'truth_awaiting_acceptance', record.id),
      kind: 'decision',
      reason: 'truth_awaiting_acceptance',
      source: { table: 'hq_truth_records', id: record.id },
      entities: [
        { kind: 'truth', id: record.id },
        truthSubjectRef(record.entityKind, record.entityId),
      ],
      summary: `Truth ${record.id} about ${record.entityKind} ${record.entityId} is verified, current and uncontested; acceptance is the Founder's explicit signature behind step-up.`,
      since: record.recordedAt,
      staleness: truthStaleness(record.subjectDrift),
      requiredAuthority: 'approval_authority_step_up',
      provenance: 'hq_truth_records derived state = verified with an issued acceptance digest',
      founderOnly: record.privacy === 'founder_only',
    });
  }
  for (const handoff of facts.collaboration.handoffs) {
    const mission = missionById.get(handoff.missionId);
    if (!mission || TERMINAL_MISSION.includes(mission.status)) continue;
    if (handoff.canonical?.assignedWorkerId === handoff.toWorkerId) continue;
    items.push({
      id: itemId('decision', 'handoff_requested', handoff.contributionId),
      kind: 'decision',
      reason: 'handoff_requested',
      source: { table: 'hq_collab_contributions', id: handoff.contributionId },
      entities: [
        { kind: 'contribution', id: handoff.contributionId },
        { kind: 'task', id: handoff.taskId },
        { kind: 'worker', id: handoff.toWorkerId },
        { kind: 'session', id: handoff.sessionId },
      ],
      summary: `${handoff.fromWorkerId} requested handoff of task ${taskLabel(handoff.taskId)} to ${handoff.toWorkerId}; the canonical task is ${handoff.canonical ? `${handoff.canonical.status}, claimed by ${handoff.canonical.claimedBy ?? 'nobody'}, Founder assignment ${handoff.canonical.assignedWorkerId ?? 'none'}` : 'absent'}. Advisory only.`,
      since: handoff.at,
      staleness: 'current',
      requiredAuthority: 'workforce_assign',
      provenance: 'hq_collab_contributions kind = handoff_request in a session whose mission is non-terminal, not already assigned as requested',
      // The room's own classification. The summary names the session, both
      // workers and the canonical task, so a founder_only room's handoff is
      // Founder-private material.
      founderOnly: handoff.privacy === 'founder_only',
    });
  }
  for (const disagreement of facts.collaboration.disagreements) {
    const mission = missionById.get(disagreement.missionId);
    if (!mission || TERMINAL_MISSION.includes(mission.status)) continue;
    items.push({
      id: itemId('decision', 'disagreement_open', disagreement.contributionId),
      kind: 'decision',
      reason: 'disagreement_open',
      source: { table: 'hq_collab_relations', id: `${disagreement.contributionId}~${disagreement.disputesId}` },
      entities: [
        { kind: 'contribution', id: disagreement.contributionId },
        { kind: 'contribution', id: disagreement.disputesId },
        { kind: 'session', id: disagreement.sessionId },
        { kind: 'mission', id: disagreement.missionId },
      ],
      summary: `${disagreement.workerId} (${disagreement.role}) disagrees with ${disagreement.disputedWorkerId} on mission ${disagreement.missionId}; explicit and unsettled by count or recency.`,
      since: disagreement.at,
      staleness: 'current',
      requiredAuthority: 'founder_decision',
      provenance: 'hq_collab_relations kind = disagrees_with in a session whose mission is non-terminal',
      // Same rule as the handoff above: the summary names the session, the
      // disputing worker and its role, and the mission.
      founderOnly: disagreement.privacy === 'founder_only',
    });
  }

  return orderAttentionItems(items);
}

export function countByKind(items: readonly InboxAttentionItem[]): Record<AttentionKind, number> {
  const out = Object.fromEntries(ATTENTION_KINDS.map((kind) => [kind, 0])) as Record<AttentionKind, number>;
  for (const item of items) out[item.kind] += 1;
  return out;
}

// ---- recommendations: a record that cannot execute ----

/**
 * A recommendation. Source facts, rationale, limitations, affected entities
 * and the authority the act takes — and `executable: false`, structurally:
 * there is no field a caller could hand to any facade method, and no facade
 * method accepts a recommendation. `actPath` names the EXISTING gated act
 * (for the reader), which runs only under its own gate.
 */
export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  summary: string;
  sourceFacts: { table: SourceTable; id: string; fact: string }[];
  affectedEntities: EntityRef[];
  rationale: string;
  limitations: string[];
  requiredAuthority: RequiredAuthority;
  actPath: string;
  /** The inbox items this recommendation answers, for tracing. */
  attentionIds: string[];
  executable: false;
}

const ATTENTION_TO_RECOMMENDATION: Readonly<
  Record<InboxAttentionReason, { kind: RecommendationKind; actPath: string; limitations: string[] }>
> = {
  task_awaiting_approval: {
    kind: 'decide_pending_approval',
    actPath: 'approveTask / denyTask (POST /api/hq/control/approvals/approve | /deny) — approval authority, digest echo',
    limitations: ['HQ does not assess whether the action is desirable; the digest on screen must match the digest decided.', 'The requester cannot decide it.'],
  },
  approval_expired_unconsumed: {
    kind: 'renew_expired_approval',
    actPath: 'returnForFreshApproval, then approveTask — approval authority',
    limitations: ['A fresh decision is a new act; the expired row is history and is not extended.'],
  },
  review_pending: {
    kind: 'review_submitted_result',
    actPath: 'reviewTask — an actor other than the submitter',
    limitations: ['HQ does not judge the result; an independent reviewer does.'],
  },
  contradiction_unresolved: {
    kind: 'resolve_contradiction',
    actPath: 'verifyTruth (refute one side) or recordTruth (supersede one side) — truth_verify / truth_record',
    limitations: ['HQ prefers neither side and never resolves by recency.', 'A refutation must cite existing evidence and state its limitations.'],
  },
  task_blocked: {
    kind: 'unblock_task',
    actPath: 'the canonical task paths (fresh approval, requeue or reconciliation) — Founder decision',
    limitations: ['The block reason is the canonical text; HQ does not infer a cause beyond it.'],
  },
  task_review_failed: {
    kind: 'unblock_task',
    actPath: 'the canonical task paths (requeue for rework) — Founder decision',
    limitations: ['The failing review note is the canonical text; HQ does not infer a fix.'],
  },
  mission_blocked: {
    kind: 'unblock_mission',
    actPath: 'transitionMission blocked → working | failed | cancelled (POST /api/hq/control/missions/transition) — mission_command',
    limitations: ['Whether the block reason is resolved is not something HQ can observe.'],
  },
  mission_dependency_terminal: {
    kind: 'unblock_mission',
    actPath: 'amendMissionIntent or transitionMission — mission_command',
    limitations: ['Dependencies are advisory; nothing scheduled on them and nothing here decides the mission should stop.'],
  },
  action_high_risk_open: {
    kind: 'decide_high_risk_action',
    actPath: 'approveTask on the bound task (risk-required approval) — approval authority; execution stays a worker act under a fenced claim',
    limitations: ['The risk level is categorical, from the capability row, the adapter contract and the proposer’s escalations; it is not a probability.'],
  },
  action_awaiting_reconciliation: {
    kind: 'reconcile_external_action',
    actPath: 'reconcileAction (POST /api/hq/control/actions/reconcile) — approval authority + step-up, not the proposer',
    limitations: ['HQ cannot observe the external outcome; a human checks the remote and records what happened.', 'Never retried automatically.'],
  },
  dispatch_outcome_unknown: {
    kind: 'reconcile_dispatch_outcome',
    actPath: 'resolveUnknownDispatch — reconciliation authority',
    limitations: ['Whether the public issue was published is unknown to HQ until a human checks the remote.'],
  },
  kill_switch_engaged: {
    kind: 'decide_kill_switch',
    actPath: 'releaseKillSwitch or keep it engaged — approval authority',
    limitations: ['HQ cannot tell whether the cause of the stop is resolved; releasing is a judgement, not a derivation.'],
  },
  task_outcome_unknown: {
    kind: 'reconcile_task_outcome',
    actPath: 'reconcileTask (confirmed_done | confirmed_failed | confirmed_not_executed) — an actor other than the task creator',
    limitations: ['Unknown stays unknown until a human observes the real outcome.'],
  },
  mission_ready_review: {
    kind: 'verify_mission_ready_for_review',
    actPath: 'transitionMission ready_review → verified with a note — mission_command + approval authority',
    limitations: ['Verification is an explicit Founder decision; HQ records no machine verification of a mission.'],
  },
  mission_verified_awaiting_close: {
    kind: 'close_verified_mission',
    actPath: 'transitionMission verified → complete — mission_command',
    limitations: ['Closing is a separate decision from verifying, by design.'],
  },
  mission_execution_ready_review: {
    kind: 'move_mission_to_review',
    actPath: 'transitionMission working → ready_review — mission_command',
    limitations: ['Every linked task completed does not mean the objective was met; the Founder reviews.'],
  },
  mission_plan_needs_founder: {
    kind: 'specify_or_clarify_plan',
    actPath: 'amendMissionIntent (specifyPlanItems / supersede + re-add) — mission_command',
    limitations: ['No text is ever parsed into a spec; the Founder states the capability and payload explicitly.'],
  },
  truth_awaiting_acceptance: {
    kind: 'accept_verified_truth',
    actPath: 'acceptTruth (POST /api/hq/control/truth/accept) — approval authority + step-up, digest echo, not the author or a verifier',
    limitations: ['Acceptance is the Founder’s signature; the verifier’s stated limitations are carried verbatim and not resolved by HQ.'],
  },
  handoff_requested: {
    kind: 'decide_handoff',
    actPath: 'assignTaskAsFounder (POST /api/hq/control/workforce/assign) — workforce_assign; advisory narrowing only',
    limitations: ['A handoff request changes no claim, fence or assignment; an assignment intent only narrows future claiming.'],
  },
  disagreement_open: {
    kind: 'settle_disagreement',
    actPath: 'an explicit act elsewhere — a verification, a supersession, a mission amendment — never a vote',
    limitations: ['Agreement counts are shown, never acted on; HQ does not pick a side.'],
  },
  mission_working_nothing_in_motion: {
    kind: 'revisit_stale_mission',
    actPath: 'transitionMission or amendMissionIntent — mission_command; orchestrateMission preview is a safe read first',
    limitations: ['"Nothing in motion" is a fact about op_tasks now; HQ does not know whether work is happening outside its record.'],
  },
};

/** One recommendation per inbox item — derived, deterministic, never persisted, never executable. */
export function deriveRecommendations(items: readonly InboxAttentionItem[]): Recommendation[] {
  return items.map((item) => {
    const rule = ATTENTION_TO_RECOMMENDATION[item.reason];
    return {
      id: `rec:${item.id}`,
      kind: rule.kind,
      summary: item.summary,
      sourceFacts: [{ table: item.source.table, id: item.source.id, fact: item.provenance }],
      affectedEntities: [...item.entities],
      rationale: `The inbox item ${item.id} exists because ${item.provenance}. It leaves the inbox only when that predicate stops holding on the canonical row, which happens only through the named act under its own gate.`,
      limitations: [...rule.limitations, ...(item.staleness === 'stale' ? ['The source fact is marked stale against its subject; read the subject first.'] : [])],
      requiredAuthority: item.requiredAuthority,
      actPath: rule.actPath,
      attentionIds: [item.id],
      executable: false,
    };
  });
}

// ---- the six questions ----

export interface BoundedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/**
 * What every section derivation takes: how many entries a bounded list may
 * carry, and whether the READER is past the Founder gate.
 *
 * `includeFounderOnly` is the reading layer's disclosure decision, made
 * exactly as `truthSummary` and `collaborationSummary` make it, and it
 * defaults to the LESS disclosing answer. When it is false, every count in
 * the section spans only the set the reader may see and the omission is
 * stated in `withheldFounderOnly` — so arithmetic on a published section
 * discloses no categorical fact about a founder_only record.
 */
export interface SectionOptions {
  limit?: number;
  includeFounderOnly?: boolean;
}

export function bounded<T>(all: readonly T[], limit: number): BoundedList<T> {
  return { items: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export interface MissionRef {
  id: string;
  title: string;
  status: MissionStatus;
  blockReason: string | null;
  statusChangedAt: string;
}

export interface BlockedView {
  missions: BoundedList<MissionRef>;
  tasks: BoundedList<{ taskId: string; title: string | null; status: ActivityStatus; blockReason: string | null; updatedAt: string }>;
  /**
   * Tasks the Founder gate is holding. There is no approval id to name: HQ
   * writes the `hq_approvals` row when the decision is MADE, so a task that
   * is still waiting has none. `since` is the canonical `op_tasks.updated_at`
   * of the row that is waiting.
   */
  heldForApproval: BoundedList<{ taskId: string; title: string | null; capabilityId: string; since: string }>;
  killSwitches: KillSwitchFact[];
  /** Missions whose plan the orchestrator cannot act on, with the count of unactionable live items. */
  plansNeedingFounder: BoundedList<{ missionId: string; title: string; needsClarification: number; unspecifiedWork: number }>;
}

export function deriveBlocked(facts: CommandFacts, options: SectionOptions = {}): BlockedView {
  const limit = options.limit ?? BRIEFING_SECTION_LIMIT;
  const blockedTasks = facts.tasks
    .filter((task) => task.status === 'blocked' || task.status === 'review_failed')
    .map((task) => ({ taskId: task.id, title: task.title, status: task.status, blockReason: task.blockReason, updatedAt: task.updatedAt }));
  const held = tasksHeldAtFounderGate(facts).map((task) => ({
    taskId: task.id,
    title: task.title,
    capabilityId: task.capabilityId,
    since: task.updatedAt,
  }));
  const plans = facts.missions
    .filter((mission) => !TERMINAL_MISSION.includes(mission.status))
    .map((mission) => ({
      missionId: mission.id,
      title: mission.title,
      needsClarification: mission.planItems.filter((item) => item.kind === 'needs_clarification').length,
      unspecifiedWork: mission.planItems.filter((item) => item.kind === 'work' && item.taskId === null && item.specCapabilityId === null).length,
    }))
    .filter((entry) => entry.needsClarification > 0 || entry.unspecifiedWork > 0);
  return {
    missions: bounded(
      facts.missions.filter((m) => m.status === 'blocked').map(missionRef),
      limit,
    ),
    tasks: bounded(blockedTasks, limit),
    heldForApproval: bounded(held, limit),
    killSwitches: [...facts.killSwitches],
    plansNeedingFounder: bounded(plans, limit),
  };
}

function missionRef(mission: MissionFact): MissionRef {
  return { id: mission.id, title: mission.title, status: mission.status, blockReason: mission.blockReason, statusChangedAt: mission.statusChangedAt };
}

export interface VerifiedTruthRef {
  id: string;
  entityKind: TruthEntityKind;
  entityId: string;
  statement: string;
  state: TruthState;
  recordedBy: string;
  recordedAt: string;
  /** `stale` when the canonical subject moved since the record; never a tie-breaker. */
  staleness: Staleness;
  subjectDrift: SubjectDrift;
  /** True when the record cites no evidence — a bare claim whose provenance is missing, shown as such. */
  provenanceMissing: boolean;
  verificationLimitations: string[];
  founderOnly: boolean;
}

export interface VerifiedView {
  /** Current (never superseded) records deriving `verified` or `accepted` now, newest first. */
  truth: BoundedList<VerifiedTruthRef>;
  accepted: number;
  verified: number;
  /** Excluded from the list above because they are superseded — stated, not hidden. */
  supersededExcluded: number;
  /**
   * Records this reader may not see, excluded from `truth`, `accepted`,
   * `verified` and `supersededExcluded` alike. 0 past the Founder gate.
   */
  withheldFounderOnly: number;
  missions: BoundedList<MissionRef>;
}

export function deriveVerified(facts: CommandFacts, options: SectionOptions = {}): VerifiedView {
  const limit = options.limit ?? BRIEFING_SECTION_LIMIT;
  const isEstablished = (record: TruthFact) => record.state === 'verified' || record.state === 'accepted';
  const readable = options.includeFounderOnly === true
    ? facts.truth
    : facts.truth.filter((record) => record.privacy !== 'founder_only');
  const established = readable.filter(isEstablished);
  const current = established.filter((record) => record.lifecycle === 'current').sort((a, b) => b.seq - a.seq);
  return {
    // Exactly the records this section would otherwise have carried or
    // counted — not every founder_only record in the graph, which would be a
    // different (and larger) claim than the one this field makes.
    withheldFounderOnly: facts.truth.filter(isEstablished).length - established.length,
    truth: bounded(
      current.map((record) => ({
        id: record.id,
        entityKind: record.entityKind,
        entityId: record.entityId,
        statement: record.statement,
        state: record.state,
        recordedBy: record.recordedBy,
        recordedAt: record.recordedAt,
        staleness: truthStaleness(record.subjectDrift),
        subjectDrift: record.subjectDrift,
        provenanceMissing: record.evidenceRefs.length === 0,
        verificationLimitations: [...record.verificationLimitations],
        founderOnly: record.privacy === 'founder_only',
      })),
      limit,
    ),
    accepted: current.filter((record) => record.state === 'accepted').length,
    verified: current.filter((record) => record.state === 'verified').length,
    supersededExcluded: established.length - current.length,
    missions: bounded(
      facts.missions.filter((mission) => mission.status === 'verified' || mission.status === 'complete').map(missionRef),
      limit,
    ),
  };
}

export interface UnknownView {
  tasksOutcomeUnknown: BoundedList<{ taskId: string; title: string | null; updatedAt: string }>;
  actionsOutcomeUnknown: BoundedList<{ actionId: string; taskId: string; state: ActionState; since: string }>;
  dispatchOutcomeUnknown: BoundedList<{ taskId: string; at: string }>;
  missionsWithoutAcceptanceCriteria: BoundedList<MissionRef>;
  truthInconclusive: BoundedList<{ id: string; entityKind: TruthEntityKind; entityId: string; founderOnly: boolean }>;
  /** Claims with no evidence reference at all — their provenance is missing and is shown as missing. */
  truthWithoutEvidence: BoundedList<{ id: string; entityKind: TruthEntityKind; entityId: string; state: TruthState; founderOnly: boolean }>;
  workersUndeclaredProvider: BoundedList<{ workerId: string; displayName: string }>;
  /** Stores this handle does not carry — absence is stated, never read as an empty answer. */
  storesAbsent: string[];
  /** Entries this reader may not see. They are in NO other number here. 0 past the Founder gate. */
  withheldFounderOnly: number;
  total: number;
  note: string;
}

export function deriveUnknown(facts: CommandFacts, options: SectionOptions = {}): UnknownView {
  const limit = options.limit ?? BRIEFING_SECTION_LIMIT;
  const tasks = facts.tasks.filter((t) => t.status === 'outcome_unknown').map((t) => ({ taskId: t.id, title: t.title, updatedAt: t.updatedAt }));
  const actions = facts.actions
    .filter((a) => a.state === 'attempted' || a.state === 'outcome_unknown')
    .map((a) => ({ actionId: a.id, taskId: a.taskId, state: a.state, since: a.attemptedAt ?? a.requestedAt }));
  const dispatch = facts.dispatchLane.filter((d) => d.state === 'unknown').map((d) => ({ taskId: d.taskId, at: d.at }));
  const missions = facts.missions.filter((m) => !TERMINAL_MISSION.includes(m.status) && !m.acceptanceCriteriaStated).map(missionRef);
  const allInconclusive = facts.truth.filter((t) => t.lifecycle === 'current' && t.verification === 'inconclusive');
  const allBare = facts.truth.filter((t) => t.lifecycle === 'current' && t.evidenceRefs.length === 0);
  const readable = <T extends { privacy: 'internal' | 'founder_only' }>(records: readonly T[]): T[] =>
    options.includeFounderOnly === true ? [...records] : records.filter((t) => t.privacy !== 'founder_only');
  const inconclusiveRecords = readable(allInconclusive);
  const bareRecords = readable(allBare);
  const inconclusive = inconclusiveRecords.map((t) => ({
    id: t.id,
    entityKind: t.entityKind,
    entityId: t.entityId,
    founderOnly: t.privacy === 'founder_only',
  }));
  const bare = bareRecords.map((t) => ({
    id: t.id,
    entityKind: t.entityKind,
    entityId: t.entityId,
    state: t.state,
    founderOnly: t.privacy === 'founder_only',
  }));
  const undeclared = facts.workers.filter((w) => w.active && w.providerDeclared === null).map((w) => ({ workerId: w.id, displayName: w.displayName }));
  const storesAbsent = (Object.entries(facts.stores) as [string, boolean][]).filter(([, present]) => !present).map(([name]) => name);
  return {
    tasksOutcomeUnknown: bounded(tasks, limit),
    actionsOutcomeUnknown: bounded(actions, limit),
    dispatchOutcomeUnknown: bounded(dispatch, limit),
    missionsWithoutAcceptanceCriteria: bounded(missions, limit),
    truthInconclusive: bounded(inconclusive, limit),
    truthWithoutEvidence: bounded(bare, limit),
    workersUndeclaredProvider: bounded(undeclared, limit),
    storesAbsent,
    withheldFounderOnly:
      allInconclusive.length - inconclusiveRecords.length + (allBare.length - bareRecords.length),
    total: tasks.length + actions.length + dispatch.length + missions.length + inconclusive.length + bare.length + undeclared.length,
    note:
      'Every entry is an explicit unknown HQ recorded as unknown. Nothing here is resolved, estimated or defaulted; each leaves this list only through an explicit act on its source record.',
  };
}

export interface SafeAct {
  act: SafeActKind;
  nature: 'read' | 'record';
  /**
   * Whether THIS act's own preconditions hold now. Always exactly
   * `blockers.length === 0` — an invariant, not a second opinion.
   */
  safe: boolean;
  /** What stops THIS act right now. Empty for a pure read that nothing gates. */
  blockers: string[];
  /**
   * For a PREVIEW act only: what the gated act the preview precedes
   * (`orchestrateMission` with `apply`) would refuse on today, read from the
   * canonical rows. Empty for every act that has no such follow-on.
   *
   * Split out deliberately. The earlier draft put these strings in `blockers`
   * beside `safe: true`, so the record said in one field that the act was
   * safe and in the next that it was blocked. They are facts about a
   * DIFFERENT act, and are labelled as such.
   */
  applyWouldRefuse: string[];
  requiredAuthority: RequiredAuthority;
  targets: EntityRef[];
  note: string;
}

export interface SafeNextView {
  acts: SafeAct[];
  /** Queued canonical tasks with at least one eligible registered worker and no engaged stop — claimable by a worker, dispatched by nothing here. */
  claimableTasks: BoundedList<{ taskId: string; capabilityId: string; title: string | null; eligibleWorkers: string[] }>;
  note: string;
}

export function deriveSafeNext(facts: CommandFacts, options: SectionOptions = {}): SafeNextView {
  const limit = options.limit ?? BRIEFING_SECTION_LIMIT;
  const acts: SafeAct[] = [];
  const globalStop = facts.killSwitches.some((k) => k.scope === '*');
  const orchestrateStop = facts.killSwitches.some((k) => k.scope === 'hq.mission_orchestrate');
  const orchestrateRow = facts.capabilities.find((c) => c.id === 'hq.mission_orchestrate');
  for (const mission of facts.missions) {
    if (TERMINAL_MISSION.includes(mission.status)) continue;
    const specified = mission.planItems.filter((item) => item.kind === 'work' && item.taskId === null && item.specCapabilityId !== null);
    if (specified.length === 0) continue;
    const applyWouldRefuse: string[] = [];
    if (mission.status === 'blocked') applyWouldRefuse.push('mission is blocked (a Founder stop)');
    if (mission.status === 'ready_review' || mission.status === 'verified') applyWouldRefuse.push(`mission is ${mission.status} (past building)`);
    if (globalStop) applyWouldRefuse.push('global kill switch engaged');
    if (orchestrateStop) applyWouldRefuse.push('orchestrate-scope kill switch engaged');
    if (!orchestrateRow) applyWouldRefuse.push('hq.mission_orchestrate is not registered');
    else if (!orchestrateRow.enabled) applyWouldRefuse.push('hq.mission_orchestrate is disabled');
    for (const scope of mission.engagedSpecScopes) applyWouldRefuse.push(`kill switch engaged for spec capability ${scope}`);
    for (const capabilityId of mission.specCapabilitiesUnavailable) applyWouldRefuse.push(`spec capability ${capabilityId} is not registered and enabled`);
    acts.push({
      act: 'orchestration_preview',
      nature: 'read',
      safe: true,
      blockers: [],
      applyWouldRefuse,
      requiredAuthority: 'mission_orchestrate_step_up',
      targets: [{ kind: 'mission', id: mission.id }],
      note:
        `${specified.length} specified, unlinked work item(s). A preview is a pure read and nothing gates it; apply creates canonical tasks and takes the orchestrate gate, the mission gate and step-up` +
        (applyWouldRefuse.length > 0 ? ', and would currently refuse: ' + applyWouldRefuse.join('; ') : '') +
        '.',
    });
  }
  acts.push({
    act: 'issue_founder_brief',
    nature: 'record',
    safe: facts.stores.briefs,
    blockers: facts.stores.briefs ? [] : ['the brief ledger is absent on this database handle'],
    applyWouldRefuse: [],
    requiredAuthority: 'founder_brief',
    targets: [],
    note: 'Writes one receipt row (who, when, watermarks, counts, digest). Executes nothing and notifies nobody.',
  });
  for (const session of facts.collaboration.sessions) {
    if (session.standing !== 'active') continue;
    // A founder_only room's ID and mission are Founder-private material: an
    // act entry naming them would disclose the room's existence to a reader
    // who may not see it (Phase 10 correction, M1). This section is not on
    // the unauthenticated artifact today; it honours the same rule anyway so
    // that publishing it later cannot reopen the leak.
    if (session.privacy === 'founder_only' && options.includeFounderOnly !== true) continue;
    acts.push({
      act: 'assemble_collaboration_context',
      nature: 'read',
      safe: true,
      blockers: [],
      applyWouldRefuse: [],
      requiredAuthority: 'none_read_only',
      targets: [
        { kind: 'session', id: session.id },
        { kind: 'mission', id: session.missionId },
      ],
      note: 'A bounded, role-scoped bundle; persists nothing and never carries founder_only material to a worker.',
    });
  }
  const claimable = facts.tasks
    .filter((task) => task.status === 'queued' && task.eligibleWorkers.length > 0)
    .filter((task) => !globalStop && !facts.killSwitches.some((k) => k.scope === task.capabilityId))
    .map((task) => ({ taskId: task.id, capabilityId: task.capabilityId, title: task.title, eligibleWorkers: [...task.eligibleWorkers] }));
  return {
    acts,
    claimableTasks: bounded(claimable, limit),
    note:
      'Every act here is a read or a record under an existing gate. Nothing in this section executes, claims, dispatches or approves; a claimable task is claimed by a registered worker through claimNext, never by this layer.',
  };
}

export interface ChangedEventRef {
  seq: number;
  at: string;
  subjectKind: string;
  subjectId: string;
  status: string | null;
  actor: string;
  summary: string;
}

export interface ChangedView {
  /** The brief the delta is measured from, or null when no brief was ever issued. */
  since: { briefId: string; issuedAt: string; watermark: CanonicalWatermark } | null;
  /**
   * Rows appended to `hq_events` — HQ's activity log, which is NARROWER than
   * the whole record: approvals, truth, external actions, memory,
   * collaboration and brief receipts land here, while mission lifecycle
   * events live in `hq_mission_events` and task transitions in `op_tasks`.
   * Stated rather than implied, because a reader who assumed this was every
   * change would read an empty list as "nothing happened".
   */
  events: BoundedList<ChangedEventRef>;
  /**
   * Entries appended to the hash-chained `op_evidence` log, by kind. THIS is
   * the comprehensive half: every canonical write in HQ appends evidence, so
   * a change that leaves no `hq_events` row still shows up here.
   */
  evidenceByKind: { kind: string; count: number }[];
  note: string;
}

/** Said once, in both branches of the note, so the two halves are never confused. */
const CHANGED_SOURCES =
  'The events list is the hq_events activity log, which does not carry every canonical write (mission ' +
  'lifecycle events live in hq_mission_events and task transitions in op_tasks); the evidence counts are ' +
  'the hash-chained op_evidence log, which does.';

/**
 * What the watermark and the delta deliberately leave out.
 *
 * Issuing a brief appends one `hq_events` row and one `op_evidence` entry, as
 * every write in HQ does. Counting them would move the watermark on every
 * issue — so a second brief could never deduplicate — and would report the
 * last brief as the news since the last brief. Neither is true of the COMPANY
 * record, so both are excluded and the exclusion is stated here rather than
 * left for a reader to discover.
 */
export const BRIEF_ROWS_EXCLUDED =
  'The brief ledger\u2019s own audit rows are excluded from both the watermark and this delta: writing a ' +
  'brief is not something to brief about.';

/**
 * The canonical events appended after the watermark. Without an issued
 * brief there is no watermark, so the section carries the newest events
 * and SAYS it is not a delta.
 */
export function deriveChanged(input: {
  since: BriefRow | null;
  eventsAfter: ChangedEventRef[];
  eventsTotal: number;
  evidenceByKind: { kind: string; count: number }[];
  limit?: number;
}): ChangedView {
  const limit = input.limit ?? CHANGED_EVENT_LIMIT;
  return {
    since: input.since ? { briefId: input.since.id, issuedAt: input.since.issuedAt, watermark: { ...input.since.watermark } } : null,
    events: { items: input.eventsAfter.slice(0, limit), total: input.eventsTotal, truncated: input.eventsTotal > limit },
    evidenceByKind: [...input.evidenceByKind].sort((a, b) => a.kind.localeCompare(b.kind)),
    note: input.since
      ? `Canonical hq_events rows appended after brief ${input.since.id} (event seq > ${input.since.watermark.eventSeq}) and op_evidence entries after evidence seq ${input.since.watermark.evidenceSeq}, by kind. A delta over the append-only record; nothing is summarised. ${CHANGED_SOURCES} ${BRIEF_ROWS_EXCLUDED}`
      : `No brief has been issued, so there is no watermark to measure from: this section carries the newest canonical events and evidence kinds overall, and is NOT a delta. ${CHANGED_SOURCES} ${BRIEF_ROWS_EXCLUDED}`,
  };
}

// ---- department projections ----

export interface DepartmentMetric {
  label: string;
  /** A count HQ made, or a short copied categorical string. */
  value: number | string;
}

export interface DepartmentProjection {
  department: CommandCenterDepartment;
  /** `canonical`: metrics below are counts over named canonical stores. `not_recorded`: HQ records nothing that would make this real. */
  basis: 'canonical' | 'not_recorded';
  sources: string[];
  metrics: DepartmentMetric[];
  /** Inbox items touching this department's canonical entities — the same items, grouped, never re-scored. */
  attention: number;
  note: string;
}

const LIVE_CLAIM: readonly ActivityStatus[] = ['assigned', 'running', 'outcome_unknown'];

export function deriveDepartments(facts: CommandFacts, inbox: readonly InboxAttentionItem[]): DepartmentProjection[] {
  const byStatus = (statuses: readonly ActivityStatus[]) => facts.tasks.filter((t) => statuses.includes(t.status)).length;
  const kinds = (...selected: AttentionKind[]) => inbox.filter((item) => selected.includes(item.kind)).length;
  const refusals = Object.values(facts.refusalEvidence).reduce((sum, n) => sum + n, 0);
  const highRisk = facts.actions.filter((a) => a.riskLevel === 'high' || a.riskLevel === 'critical').length;
  const activeWorkers = facts.workers.filter((w) => w.active);
  return [
    {
      department: 'development',
      basis: 'canonical',
      sources: ['op_tasks', 'hq_missions'],
      metrics: [
        { label: 'Tasks queued', value: byStatus(['queued']) },
        { label: 'Tasks in flight', value: byStatus(['assigned', 'running']) },
        { label: 'Tasks completed', value: byStatus(['completed', 'review_passed']) },
        { label: 'Missions working', value: facts.missions.filter((m) => m.status === 'working').length },
        { label: 'Missions planned', value: facts.missions.filter((m) => m.status === 'planned').length },
      ],
      attention: kinds('review', 'blocked', 'stale_mission'),
      note: 'Counts over the one task truth and the canonical mission aggregate. No velocity, duration or completion share is computed.',
    },
    {
      department: 'ops',
      basis: 'canonical',
      sources: ['op_tasks', 'op_kill_switch', 'hq_orchestration_runs', 'hq_approvals'],
      metrics: [
        // The SAME predicate the Founder Inbox and WHAT IS BLOCKED read
        // (`tasksHeldAtFounderGate`), so this executive number and the queue
        // it summarises can never disagree. It counted
        // `hq_approvals.decision = 'pending'` before — a state HQ never
        // writes, because an approval row is inserted when the decision is
        // MADE — and so reported 0 over a queue of genuinely held work
        // (Phase 10 correction, M1).
        { label: 'Approvals pending', value: tasksHeldAtFounderGate(facts).length },
        { label: 'Reviews pending', value: facts.tasks.filter((t) => t.reviewPending).length },
        { label: 'Outcome unknown', value: byStatus(['outcome_unknown']) },
        { label: 'Kill switches engaged', value: facts.killSwitches.length },
        { label: 'Orchestration runs recorded', value: facts.orchestrationRuns },
      ],
      attention: kinds('approval', 'incident', 'external_action'),
      note:
        'What is held, what is stopped and what was orchestrated — recorded acts only. "Approvals pending" ' +
        'counts tasks at the Founder gate (op_tasks.status = needs_approval), which is the canonical fact ' +
        'that work is waiting; hq_approvals records decisions already made, and reaches this department ' +
        'only through the attention count (an approved approval that expired unconsumed).',
    },
    {
      department: 'cybersecurity',
      basis: 'canonical',
      sources: ['op_kill_switch', 'hq_truth_relations', 'hq_action_intents', 'op_evidence'],
      metrics: [
        { label: 'Kill switches engaged', value: facts.killSwitches.length },
        { label: 'Unresolved contradictions', value: facts.contradictions.filter((c) => c.resolution === 'unresolved').length },
        { label: 'High/critical actions on the ledger', value: highRisk },
        { label: 'Refusal evidence entries (all time)', value: refusals },
      ],
      attention: kinds('incident', 'contradiction', 'risk'),
      note:
        'Posture facts from the canonical record: stops, disputes, risk-classed external actions and the ' +
        `refusal entries the hash-chained evidence log kept, counted over the ${REFUSAL_EVIDENCE_KINDS.length} enumerated ` +
        'refusal kinds (op_evidence is append-only, so "all time" is exact). No threat score, no severity ' +
        'rating and no secret value ever crosses here.',
    },
    {
      department: 'research',
      basis: 'not_recorded',
      sources: [],
      metrics: [],
      attention: 0,
      note: 'HQ records tasks, not task classes: nothing canonical distinguishes research work from delivery work, so any split shown here would be invented.',
    },
    {
      department: 'product',
      basis: 'not_recorded',
      sources: [],
      metrics: [],
      attention: 0,
      note: 'No product-assembly capability is registered and no canonical subject kind records product builds (the Product Factory room’s later_phase statement).',
    },
    {
      department: 'finance',
      basis: 'not_recorded',
      sources: [],
      metrics: [],
      attention: 0,
      note: 'HQ records no cost, spend, token usage, budget or invoice; the wire format refuses those fields. A finance figure here would be fabricated.',
    },
    {
      department: 'business',
      basis: facts.stores.projects ? 'canonical' : 'not_recorded',
      sources: facts.stores.projects ? ['hq_projects', 'hq_missions'] : [],
      metrics: facts.stores.projects
        ? [
            { label: 'Projects active', value: facts.projects.filter((p) => p.status === 'active').length },
            { label: 'Projects closed', value: facts.projects.filter((p) => p.status === 'closed').length },
            { label: 'Missions assigned to a project', value: facts.projects.reduce((sum, p) => sum + p.missionIds.length, 0) },
            { label: 'Missions with no project', value: facts.missions.filter((m) => !facts.projects.some((p) => p.missionIds.includes(m.id))).length },
          ]
        : [],
      attention: kinds('decision'),
      note: facts.stores.projects
        ? 'The canonical Founder project register and the missions it carries. No revenue, pipeline or customer record exists in HQ.'
        : 'This handle carries no project register; absence is stated, not read as zero.',
    },
    {
      department: 'memory',
      basis: facts.stores.memory || facts.stores.truth ? 'canonical' : 'not_recorded',
      sources: [...(facts.stores.memory ? ['hq_memory'] : []), ...(facts.stores.truth ? ['hq_truth_records'] : [])],
      metrics: [
        ...(facts.stores.memory
          ? [
              { label: 'Memory records', value: facts.memory.total },
              { label: 'Current', value: facts.memory.current },
              { label: 'Founder-only', value: facts.memory.founderOnly },
            ]
          : []),
        ...(facts.stores.truth
          ? [
              { label: 'Truth records', value: facts.truth.length },
              { label: 'Verified (current)', value: facts.truth.filter((t) => t.lifecycle === 'current' && t.state === 'verified').length },
              { label: 'Accepted (standing)', value: facts.truth.filter((t) => t.lifecycle === 'current' && t.state === 'accepted').length },
            ]
          : []),
      ],
      attention: kinds('contradiction'),
      note: 'Memory informs and never grants; truth is what was claimed, observed, verified and Founder-accepted about it.',
    },
    {
      department: 'ai_workforce',
      basis: 'canonical',
      sources: ['hq_specialists', 'op_worker_providers', 'hq_ai_members', 'op_tasks'],
      metrics: [
        { label: 'Registered workers active', value: activeWorkers.length },
        { label: 'Provider declared', value: activeWorkers.filter((w) => w.providerDeclared !== null).length },
        { label: 'Model identity registered', value: activeWorkers.filter((w) => w.memberIdentityKey !== null).length },
        { label: 'Live claims held', value: facts.tasks.filter((t) => t.claimedBy !== null && LIVE_CLAIM.includes(t.status)).length },
      ],
      attention: inbox.filter((item) => item.reason === 'handoff_requested' || item.reason === 'disagreement_open').length,
      note: 'Registered workers and the binding HQ recorded for each — declared, never inferred from a vendor string. A live claim is a task genuinely held now; no activity is invented.',
    },
  ];
}

// ---- the assembled documents ----

export interface FounderInboxView {
  assembledAt: string;
  items: InboxAttentionItem[];
  total: number;
  truncated: boolean;
  byKind: Record<AttentionKind, number>;
  /** Items derived from Founder-private material (a founder_only truth record or collaboration session) and withheld from this reader. 0 past the Founder gate. */
  withheldFounderOnly: number;
  ordering: string;
  provenance: { mode: 'live'; source: string; asOf: string };
}

export const INBOX_ORDERING_STATEMENT =
  'Grouped by attention kind in vocabulary order (approval, review, contradiction, blocked, risk, external_action, incident, decision, stale_mission); within a kind, oldest canonical timestamp first. A grouping, not a ranking: no priority, score or weight exists.';

export interface FounderBriefingView {
  assembledAt: string;
  needsMe: FounderInboxView;
  blocked: BlockedView;
  changed: ChangedView;
  verified: VerifiedView;
  unknown: UnknownView;
  safeNext: SafeNextView;
  recommendations: BoundedList<Recommendation>;
  departments: DepartmentProjection[];
  briefs: { total: number; latest: BriefView | null };
  provenance: { mode: 'live'; source: string; asOf: string };
}

/**
 * How many things are blocked: the sum of the five TRUE totals the blocked
 * section enumerated (not the bounded page sizes). Stated once so the brief
 * receipt, the snapshot section and any test agree on the arithmetic.
 */
export function blockedTotalOf(blocked: BlockedView): number {
  return (
    blocked.missions.total +
    blocked.tasks.total +
    blocked.heldForApproval.total +
    blocked.killSwitches.length +
    blocked.plansNeedingFounder.total
  );
}

/** The categorical counts a brief receipt records — sizes of the sets the briefing enumerated. */
export function briefCountsOf(briefing: {
  needsMe: { total: number; byKind: Record<AttentionKind, number> };
  unknown: { total: number };
  blocked: BlockedView;
  recommendations: { total: number };
}): BriefCounts {
  return {
    attention: { total: briefing.needsMe.total, byKind: { ...briefing.needsMe.byKind } },
    unknown: { total: briefing.unknown.total },
    blocked: { total: blockedTotalOf(briefing.blocked) },
    recommendations: { total: briefing.recommendations.total },
  };
}

/**
 * The snapshot section: counts over the set the reader may see, the newest
 * attention items, the unknown and blocked counts, and the latest receipt.
 * Items derived from Founder-private material — a `founder_only` truth
 * record OR a `founder_only` collaboration session — are withheld from the
 * unauthenticated artifact and counted, and NO other number here aggregates
 * over them.
 *
 * Deliberately absent: the department projections and the recommendation
 * bodies. Both are Founder-gated reads; the artifact carries only the counts
 * it can state without disclosing a private record's contents.
 */
export interface CommandCenterSnapshotView {
  attention: { total: number; byKind: Record<AttentionKind, number>; withheldFounderOnly: number; items: InboxAttentionItem[] };
  unknown: { total: number; withheldFounderOnly: number };
  blocked: { total: number };
  recommendations: { total: number };
  briefs: { total: number; latest: BriefView | null };
  /** Whether the brief ledger exists on the database handle that produced this. */
  storePresent: boolean;
}

// ---- assembly (pure; the facade supplies the facts) ----

/**
 * What every derived document says about where it came from. One string, so
 * the inbox, the briefing and the snapshot section can never claim different
 * origins for the same derivation.
 */
export const COMMAND_CENTER_PROVENANCE =
  'hq_missions / hq_mission_plan_items / op_tasks / hq_op_task_meta / hq_approvals / op_kill_switch / ' +
  'hq_truth_* / hq_action_* / hq_collab_* / op_evidence / hq_specialists / op_worker_providers / ' +
  'hq_ai_members / hq_memory / hq_projects / op_capabilities / hq_orchestration_runs / hq_briefs via ' +
  'HeadquarterOperations — every item, count and recommendation is DERIVED at read time from those ' +
  'canonical rows and nothing here is stored: an item exists exactly while its source predicate holds';

/**
 * Split the derived inbox into what this reader may see and what is withheld.
 * The only privacy input an attention item carries is `founderOnly`, set by
 * the derivation from the canonical classification of the material the item
 * is about — `hq_truth_records.privacy` for a truth item, and
 * `hq_collab_sessions.privacy` for a handoff or disagreement item.
 */
function readableItems(
  items: readonly InboxAttentionItem[],
  includeFounderOnly: boolean,
): { visible: InboxAttentionItem[]; withheld: number } {
  if (includeFounderOnly) return { visible: [...items], withheld: 0 };
  const visible = items.filter((item) => !item.founderOnly);
  return { visible, withheld: items.length - visible.length };
}

/**
 * The Founder Inbox as a document: the ordered items this reader may see,
 * bounded, with the true total, the per-kind counts over exactly that set,
 * and the number withheld stated rather than silently dropped.
 */
export function assembleFounderInbox(input: {
  items: readonly InboxAttentionItem[];
  at: string;
  includeFounderOnly?: boolean;
  limit?: number;
}): FounderInboxView {
  const limit = input.limit ?? INBOX_READ_LIMIT;
  const { visible, withheld } = readableItems(input.items, input.includeFounderOnly === true);
  return {
    assembledAt: input.at,
    items: visible.slice(0, limit),
    total: visible.length,
    truncated: visible.length > limit,
    byKind: countByKind(visible),
    withheldFounderOnly: withheld,
    ordering: INBOX_ORDERING_STATEMENT,
    provenance: { mode: 'live', source: COMMAND_CENTER_PROVENANCE, asOf: input.at },
  };
}

/**
 * The whole briefing — the six questions, the recommendations that answer the
 * inbox, the department projections and the brief ledger's own state.
 *
 * Pure: the facade gathers `facts` (and the changed-section inputs, which
 * need the ledger watermark) and this composes them. Same inputs, same bytes,
 * so `contentDigest` over the result is checkable by re-derivation.
 */
export function assembleBriefing(input: {
  facts: CommandFacts;
  changed: ChangedView;
  briefs: { total: number; latest: BriefView | null };
  includeFounderOnly?: boolean;
  limit?: number;
}): FounderBriefingView {
  const includeFounderOnly = input.includeFounderOnly === true;
  const limit = input.limit ?? BRIEFING_SECTION_LIMIT;
  const at = input.facts.now;
  const all = deriveFounderInbox(input.facts);
  const needsMe = assembleFounderInbox({ items: all, at, includeFounderOnly, limit: INBOX_READ_LIMIT });
  // Recommendations answer the items this reader can actually see. Deriving
  // them from the full set would hand back the summary of a withheld item
  // through the recommendation's own `summary` field.
  const visible = readableItems(all, includeFounderOnly).visible;
  const recommendations = deriveRecommendations(visible);
  return {
    assembledAt: at,
    needsMe,
    blocked: deriveBlocked(input.facts, { limit }),
    changed: input.changed,
    verified: deriveVerified(input.facts, { limit, includeFounderOnly }),
    unknown: deriveUnknown(input.facts, { limit, includeFounderOnly }),
    safeNext: deriveSafeNext(input.facts, { limit, includeFounderOnly }),
    recommendations: bounded(recommendations, limit),
    // Over the whole visible SET, not the bounded page: a department's
    // attention count is the size of a set, and a page size is not one.
    departments: deriveDepartments(input.facts, visible),
    briefs: input.briefs,
    provenance: { mode: 'live', source: COMMAND_CENTER_PROVENANCE, asOf: at },
  };
}

/**
 * The snapshot section. The reading layer's disclosure decision is the
 * caller's (`includeFounderOnly`) and defaults to the less disclosing answer,
 * exactly as `truthSummary` and `collaborationSummary` do it: every count
 * below spans the set the reader may see, and the withheld entries are
 * counted separately in `attention.withheldFounderOnly` and
 * `unknown.withheldFounderOnly`.
 */
export function assembleCommandCenterSnapshot(input: {
  facts: CommandFacts;
  briefs: { total: number; latest: BriefView | null };
  includeFounderOnly?: boolean;
  limit?: number;
}): CommandCenterSnapshotView {
  const includeFounderOnly = input.includeFounderOnly === true;
  const limit = input.limit ?? COMMAND_CENTER_SNAPSHOT_LIMIT;
  const { visible, withheld } = readableItems(deriveFounderInbox(input.facts), includeFounderOnly);
  const blocked = deriveBlocked(input.facts, { limit });
  const unknown = deriveUnknown(input.facts, { limit, includeFounderOnly });
  return {
    attention: {
      total: visible.length,
      byKind: countByKind(visible),
      withheldFounderOnly: withheld,
      items: visible.slice(0, limit),
    },
    unknown: { total: unknown.total, withheldFounderOnly: unknown.withheldFounderOnly },
    blocked: { total: blockedTotalOf(blocked) },
    // One recommendation per visible item, by construction of
    // `deriveRecommendations` — the count is the size of that set.
    recommendations: { total: visible.length },
    briefs: input.briefs,
    storePresent: input.facts.stores.briefs,
  };
}
