/**
 * Mission Orchestrate — the `hq.mission_orchestrate` capability trio and the
 * orchestration decision core (Phase 6, issue #265).
 *
 * The first REAL Mission Orchestrator, scoped exactly: a Founder-commanded,
 * bounded, deterministic cycle that turns a mission's EXPLICITLY SPECIFIED
 * plan items into canonical Operator tasks through the approved origination
 * path, and reports truthful categorical execution state. No daemon, no
 * timer, no schedule — a cycle runs when the Founder invokes it, and it is
 * safe to run again.
 *
 * What the orchestrator deliberately is NOT:
 * - not task truth — `op_tasks` + ActivityStatus stay the ONLY task state;
 *   the run records below are derived audit, and nothing reads them to
 *   decide anything;
 * - not an approval, claim or review right — orchestrated tasks stop at the
 *   same canonical gates as manually created ones, and no orchestrate path
 *   calls approveTask/claimNext (test-pinned);
 * - not a mission-lifecycle right — the cycle never transitions a mission;
 *   readiness is reported as a recommendation the Founder may act on;
 * - not an inference engine — an item without a Founder work spec is
 *   truthfully "not actionable"; no text is ever parsed into capabilities,
 *   payloads or providers (the Phase 3 law).
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../contracts/freeze.js';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { v4 as uuid } from 'uuid';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import { canonicalJson } from '../operator/approvals.js';
import type { ActivityStatus } from '../contracts/events.js';

export const MISSION_ORCHESTRATE_CAPABILITY = deepFreeze({
  id: 'hq.mission_orchestrate',
  description:
    'Founder mission orchestration — derives real gated tasks from a mission’s ' +
    'Founder-specified plan through the approved origination path. Creates and links only; ' +
    'approves nothing, claims nothing, transitions nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const);

/** Register the mission-orchestrate capability — a CONFIGURATION action. */
export function registerMissionOrchestrateCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...MISSION_ORCHESTRATE_CAPABILITY });
}

export const MISSION_ORCHESTRATE_RESERVED_CONTRACT = deepFreeze({
  riskClass: MISSION_ORCHESTRATE_CAPABILITY.riskClass,
  sideEffect: MISSION_ORCHESTRATE_CAPABILITY.sideEffect,
  idempotent: MISSION_ORCHESTRATE_CAPABILITY.idempotent,
} as const);

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function missionOrchestrateContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== MISSION_ORCHESTRATE_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== MISSION_ORCHESTRATE_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== MISSION_ORCHESTRATE_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type MissionOrchestrateCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry row — enforcement-safe read, drift before enabled, never repairs. */
export function missionOrchestrateCapabilityState(
  capability: Capability | null,
): MissionOrchestrateCapabilityState {
  if (!capability) return 'missing';
  if (missionOrchestrateContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

export const MAX_MISSION_SPEC_CAPABILITY_LENGTH = 120;
export const MAX_MISSION_SPEC_PAYLOAD_LENGTH = 4000;

// ---- idempotency ----

/**
 * The derived task idempotency key for one (mission, plan item, spec). Same
 * inputs, same key — which is the whole crash/rerun-safety story: the queue
 * dedupes on (capability_id, idempotency_key), so a re-applied cycle adopts
 * the task the earlier apply created instead of duplicating it, and the
 * write-once plan-item link finishes the reconciliation.
 */
export function orchestrationTaskIdempotencyKey(input: {
  missionId: string;
  planItemSeq: number;
  capabilityId: string;
  /** Canonical-JSON spec payload, verbatim from the stored spec. */
  payload: string;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `mission-task:${digest.slice(0, 32)}`;
}

// ---- run records (derived audit truth, INSERT-only BY ENGINE) ----

const ORCHESTRATOR_DDL = `
CREATE TABLE IF NOT EXISTS hq_orchestration_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  at TEXT NOT NULL,
  observed_digest TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_orch_runs_mission ON hq_orchestration_runs(mission_id, at);

CREATE TABLE IF NOT EXISTS hq_orchestration_run_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  plan_item_seq INTEGER,
  decision TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_orch_run_items_run ON hq_orchestration_run_items(run_id, seq);

-- The full SG trigger set (the hq_project_events recipe): run records are an
-- append-only audit of what a cycle observed and did — never rewritten,
-- never erased, and the BEFORE INSERT guard closes the REPLACE/UPSERT path
-- that skips BEFORE DELETE triggers while recursive_triggers is off.
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_runs_no_rewrite
BEFORE UPDATE ON hq_orchestration_runs
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_runs_no_erase
BEFORE DELETE ON hq_orchestration_runs
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_runs_no_replace
BEFORE INSERT ON hq_orchestration_runs
WHEN EXISTS (SELECT 1 FROM hq_orchestration_runs WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_runs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_run_items_no_rewrite
BEFORE UPDATE ON hq_orchestration_run_items
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_run_items is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_run_items_no_erase
BEFORE DELETE ON hq_orchestration_run_items
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_run_items is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_orch_run_items_no_replace
BEFORE INSERT ON hq_orchestration_run_items
WHEN EXISTS (SELECT 1 FROM hq_orchestration_run_items WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer'
      AND EXISTS (SELECT 1 FROM hq_orchestration_run_items WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_orchestration_run_items is append-only'); END;
`;

/** Idempotent; readonly-safe (the post-Phase-3 ensure*Schema pattern). */
export function ensureOrchestratorSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(ORCHESTRATOR_DDL);
}

export function orchestratorSchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_orchestration_runs'`)
      .get() !== undefined
  );
}

/**
 * The CLOSED decision vocabulary. Preview decisions describe what a cycle
 * WOULD do; apply decisions describe what one DID. Nothing outside this list
 * can be recorded, so a new behavior is a reviewed vocabulary change here.
 */
export const ORCHESTRATION_DECISION_KINDS = deepFreeze([
  // observations (both modes)
  'observed_linked',
  'skipped_superseded',
  'not_actionable_needs_clarification',
  'not_actionable_unspecified',
  'capability_unknown',
  'capability_disabled',
  'originate_not_granted',
  'kill_switch_scope_engaged',
  // preview verdict for an actionable item
  'ready',
  // apply outcomes
  'task_created',
  'task_deduplicated',
  'item_linked',
  'link_refused',
  'enqueue_refused',
  'eligibility_evaluated',
] as const);

export type OrchestrationDecisionKind = (typeof ORCHESTRATION_DECISION_KINDS)[number];

export interface OrchestrationDecision {
  planItemSeq: number | null;
  decision: OrchestrationDecisionKind;
  /** Browser-safe facts: task/capability ids, refusal codes, eligible worker ids. Never payloads, never idempotency keys. */
  detail: Record<string, unknown>;
}

/** What one plan item looks like to the decision function — observed facts only. */
export interface ObservedPlanItem {
  seq: number;
  kind: 'work' | 'needs_clarification';
  superseded: boolean;
  taskId: string | null;
  taskStatus: ActivityStatus | null;
  reviewPending: boolean;
  claimedBy: string | null;
  specCapabilityId: string | null;
  specPayload: string | null;
  /** Registry state of the spec capability — null when no spec exists. */
  specCapabilityState: 'missing' | 'altered' | 'disabled' | 'enabled' | null;
  /** Does the ACTING principal hold the originate grant for the spec capability? */
  founderHoldsOriginate: boolean;
  /** Is the kill switch engaged for the spec capability's own scope? */
  specScopeKillSwitchEngaged: boolean;
}

/**
 * Classify every plan item into exactly one decision, in seq order — the
 * PURE deterministic core of the cycle. No I/O, no clock, no randomness:
 * callers observe, this decides, callers act. Precedence per item, stated:
 * superseded > needs_clarification > already-linked > unspecified >
 * capability facts > kill-switch scope > READY.
 */
export function planOrchestration(items: readonly ObservedPlanItem[]): OrchestrationDecision[] {
  const decisions: OrchestrationDecision[] = [];
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (item.superseded) {
      decisions.push({ planItemSeq: item.seq, decision: 'skipped_superseded', detail: {} });
      continue;
    }
    if (item.kind === 'needs_clarification') {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'not_actionable_needs_clarification',
        detail: {},
      });
      continue;
    }
    if (item.taskId != null) {
      // Canonical truth reported VERBATIM — including a blocked task with a
      // retained claimant (the accepted hostile-rejection posture) and an
      // outcome_unknown task, which stays unknown: the orchestrator never
      // requeues, retries or reconciles a side effect whose outcome it does
      // not know.
      decisions.push({
        planItemSeq: item.seq,
        decision: 'observed_linked',
        detail: {
          taskId: item.taskId,
          taskStatus: item.taskStatus,
          reviewPending: item.reviewPending,
          claimedBy: item.claimedBy,
        },
      });
      continue;
    }
    if (item.specCapabilityId == null || item.specPayload == null) {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'not_actionable_unspecified',
        detail: { reason: 'No Founder work spec exists for this item; nothing is inferred from its text.' },
      });
      continue;
    }
    if (item.specCapabilityState === 'missing' || item.specCapabilityState === 'altered') {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'capability_unknown',
        detail: { capabilityId: item.specCapabilityId, state: item.specCapabilityState },
      });
      continue;
    }
    if (item.specCapabilityState === 'disabled') {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'capability_disabled',
        detail: { capabilityId: item.specCapabilityId },
      });
      continue;
    }
    if (!item.founderHoldsOriginate) {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'originate_not_granted',
        detail: { capabilityId: item.specCapabilityId },
      });
      continue;
    }
    if (item.specScopeKillSwitchEngaged) {
      decisions.push({
        planItemSeq: item.seq,
        decision: 'kill_switch_scope_engaged',
        detail: { capabilityId: item.specCapabilityId },
      });
      continue;
    }
    decisions.push({
      planItemSeq: item.seq,
      decision: 'ready',
      detail: { capabilityId: item.specCapabilityId },
    });
  }
  return decisions;
}

/**
 * Digest over what the cycle observed — the preview/apply fingerprint. An
 * apply carrying a stale fingerprint (the mission moved since the preview)
 * refuses instead of acting on a picture the Founder no longer has.
 */
export function orchestrationObservedDigest(observed: {
  missionId: string;
  missionStatus: string;
  items: readonly ObservedPlanItem[];
}): string {
  const digest = createHash('sha256').update(canonicalJson(observed)).digest('hex');
  return `orch-observed:${digest.slice(0, 32)}`;
}

// ---- run record writers (INSERT-only; called inside the apply transaction) ----

export function insertOrchestrationRun(
  db: HqDatabase,
  input: {
    id: string;
    missionId: string;
    requestedBy: string;
    observedDigest: string;
    /** Canonical-JSON categorical counts. Counts, never percentages. */
    summary: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO hq_orchestration_runs (id, mission_id, requested_by, at, observed_digest, summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.missionId, input.requestedBy, nowIso(), input.observedDigest, canonicalJson(input.summary));
}

export function insertOrchestrationRunItem(
  db: HqDatabase,
  input: {
    runId: string;
    missionId: string;
    planItemSeq: number | null;
    decision: OrchestrationDecisionKind;
    detail: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO hq_orchestration_run_items (id, run_id, mission_id, plan_item_seq, decision, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), input.runId, input.missionId, input.planItemSeq, input.decision, canonicalJson(input.detail));
}

export interface OrchestrationRunRecord {
  id: string;
  missionId: string;
  requestedBy: string;
  at: string;
  observedDigest: string;
  summary: Record<string, unknown>;
}

export function listOrchestrationRuns(db: HqDatabase, missionId: string): OrchestrationRunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM hq_orchestration_runs WHERE mission_id = ? ORDER BY at, id`)
    .all(missionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    missionId: r.mission_id as string,
    requestedBy: r.requested_by as string,
    at: r.at as string,
    observedDigest: r.observed_digest as string,
    summary: JSON.parse(r.summary as string) as Record<string, unknown>,
  }));
}
