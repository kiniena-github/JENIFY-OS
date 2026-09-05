/**
 * Mission Core — the command-level Mission aggregate (Phase 3, issue #254).
 *
 * A Mission is the durable canonical record of a Founder order: title,
 * objective, scope, constraints, acceptance criteria, priority, plan,
 * blockers, lifecycle. It sits ABOVE tasks. In Phase 3 a mission executes
 * NOTHING: no worker, orchestrator or watchdog reads mission state, no task
 * is created by commanding one, and every lifecycle transition is a
 * Founder-driven act through the actor-checked facade. Later phases add
 * consumers; they do not get to inherit this module's assumptions silently.
 *
 * Naming reconciliation — "mission" already means two other things here, and
 * both stay untouched:
 * - `application/missions.ts` / `hq_mission_proposals`: the chat-lane
 *   proposal-for-a-task flow. A proposal proposes ONE task; a Mission is the
 *   command-level aggregate above all of them. Different concept, different
 *   tables, both kept.
 * - `application/mission-watchdog.ts`: an UNWIRED dispatch-decision rule
 *   library. It remains unwired (`MISSION_WATCHDOG_RUNTIME_CONSUMERS` is
 *   empty, policed by its wiring-truth test) and this module deliberately
 *   consumes nothing from it.
 *
 * SECURITY NOTE — what these tables are and are not:
 * - Nothing here is authority. A mission grants no capability, approves no
 *   action, holds no claim, names no provider and reorders nothing in the
 *   operator queue (which stays strictly FIFO).
 * - `hq_mission_intents` and `hq_mission_events` are APPEND-ONLY: this
 *   module contains INSERT statements for them and nothing else, and the
 *   schema carries BEFORE UPDATE / BEFORE DELETE triggers that make SQLite
 *   itself abort a history rewrite from ANY writer. Amendments append; the
 *   original Founder order (intent seq 0) is immutable.
 * - `hq_mission_intents.body` is the canonical JSON of the full submitted
 *   command/amendment, INCLUDING optional free-text instruction and
 *   amendment rationale. It is SERVER-SIDE ONLY: no route response and no
 *   snapshot may carry it (the direct-order-instruction precedent).
 * - Schema is module-owned and additive; `src/store/db.ts` is not edited.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import { CapabilityRegistry, type Capability, type RiskClass } from '../operator/capabilities.js';
import {
  isMissionStatus,
  planItemStateFromTask,
  type MissionPlanItemState,
  type MissionPriority,
  type MissionStatus,
  type MissionVerificationMethod,
} from '../contracts/mission.js';
import type { ActivityStatus } from '../contracts/events.js';

// ---- capability (CONFIGURATION vs INVOCATION, the direct-order trio) ----

/**
 * The one capability a Founder mission command exercises.
 *
 * NOT registered automatically anywhere. A deployment that wants Founder
 * Command calls `registerMissionCommandCapability` explicitly, as a
 * CONFIGURATION action; until then `commandMission` fails closed.
 *
 * `sideEffect: false` is honest and deliberate: commanding a mission writes
 * a canonical planning record and reaches nothing outside the control plane.
 * The risk class is still `founder_gate` because the ACT — binding company
 * direction to a durable record — is a Founder-only act, and the policy
 * engine refuses standing pre-approvals for this class.
 */
export const MISSION_COMMAND_CAPABILITY = {
  id: 'hq.mission_command',
  description:
    'Founder mission command — turns a Founder order into a canonical durable mission record. ' +
    'Creates and controls missions only; executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/** Register the mission-command capability — a CONFIGURATION action. */
export function registerMissionCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...MISSION_COMMAND_CAPABILITY });
}

/** The definition fields that carry the Founder gate. */
export const MISSION_COMMAND_RESERVED_CONTRACT = {
  riskClass: MISSION_COMMAND_CAPABILITY.riskClass,
  sideEffect: MISSION_COMMAND_CAPABILITY.sideEffect,
  idempotent: MISSION_COMMAND_CAPABILITY.idempotent,
} as const;

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function missionCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== MISSION_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== MISSION_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== MISSION_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type MissionCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Classify the registry's current row. Callers supply the row from an
 * ENFORCEMENT-SAFE read (`capabilityRowFor` / the service's private store
 * read), never from `queue.capabilities` — the direct-order lesson (#219).
 * Drift is checked before `enabled` so a weakened-but-disabled row reports
 * `altered`, and detecting drift never repairs it: registration stays a
 * separate explicit act.
 */
export function missionCommandCapabilityState(
  capability: Capability | null,
): MissionCommandCapabilityState {
  if (!capability) return 'missing';
  if (missionCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds (published fields are scanned AND capped at intake) ----

export const MAX_MISSION_TITLE_LENGTH = 120;
export const MAX_MISSION_OBJECTIVE_LENGTH = 500;
export const MAX_MISSION_SCOPE_LENGTH = 500;
/** Constraints, acceptance criteria and plan-item summaries. */
export const MAX_MISSION_ITEM_LENGTH = 240;
export const MAX_MISSION_LIST_ITEMS = 50;
export const MAX_MISSION_PROJECT_LENGTH = 120;
/** Server-side free text (instruction / amendment rationale / notes). */
export const MAX_MISSION_INSTRUCTION_LENGTH = 4000;
export const MAX_MISSION_NOTE_LENGTH = 500;

/** The one honest plan item when the Founder supplied none. */
export const MISSION_PLAN_NOT_DECIDED_SUMMARY =
  'Task breakdown not yet decided — amend the mission to add plan items.';

// ---- schema ----

const MISSION_COMMAND_DDL = `
CREATE TABLE IF NOT EXISTS hq_missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  scope TEXT,
  constraints TEXT NOT NULL,
  acceptance_criteria TEXT,
  project TEXT,
  priority TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  block_reason TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  source_order_task_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  status_changed_by TEXT NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  verified_note TEXT,
  verification_method TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_missions_status ON hq_missions(status, created_at);

CREATE TABLE IF NOT EXISTS hq_mission_intents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  objective TEXT NOT NULL,
  constraints TEXT NOT NULL,
  acceptance_criteria TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (mission_id, seq)
);

CREATE TABLE IF NOT EXISTS hq_mission_plan_items (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  created_in_intent_seq INTEGER NOT NULL,
  superseded_in_intent_seq INTEGER,
  linked_by TEXT,
  linked_at TEXT,
  UNIQUE (mission_id, seq)
);

CREATE TABLE IF NOT EXISTS hq_mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_mission_events_mission ON hq_mission_events(mission_id, seq);

-- Append-only ENFORCED by the engine, not just by code convention: the two
-- history tables abort any rewrite attempt from ANY writer, present or
-- future, however it reached the database.
CREATE TRIGGER IF NOT EXISTS trg_hq_mission_intents_no_rewrite
BEFORE UPDATE ON hq_mission_intents
BEGIN SELECT RAISE(ABORT, 'hq_mission_intents is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_mission_intents_no_erase
BEFORE DELETE ON hq_mission_intents
BEGIN SELECT RAISE(ABORT, 'hq_mission_intents is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_mission_events_no_rewrite
BEFORE UPDATE ON hq_mission_events
BEGIN SELECT RAISE(ABORT, 'hq_mission_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_mission_events_no_erase
BEFORE DELETE ON hq_mission_events
BEGIN SELECT RAISE(ABORT, 'hq_mission_events is append-only'); END;
`;

/**
 * Idempotent; safe to call on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle: `hq:snapshot` legitimately builds
 * the service over `openHqDatabaseReadOnly`, and a pre-Phase-3 file lacking
 * these tables must be OBSERVED truthfully (`missionSchemaPresent`), never
 * migrated by a path that promised to write nothing.
 */
export function ensureMissionCommandSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(MISSION_COMMAND_DDL);
}

/**
 * Does this database carry the Phase 3 mission tables? False only for a
 * read-only handle over a pre-Phase-3 file — a writable construction just
 * ensured them. Readers answer empty/null truthfully when this is false.
 */
export function missionSchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_missions'`)
      .get() !== undefined
  );
}

// ---- records ----

export interface MissionPlanItem {
  seq: number;
  summary: string;
  kind: 'work' | 'needs_clarification';
  /** Real op_tasks id once linked; null = no real task exists for this item. */
  taskId: string | null;
  createdInIntentSeq: number;
  supersededInIntentSeq: number | null;
  linkedBy: string | null;
  linkedAt: string | null;
  /** Derived display state (presentation only — see contracts/mission.ts). */
  state: MissionPlanItemState;
  /** The linked task's canonical status, so compression never hides. */
  rawTaskStatus: ActivityStatus | null;
}

/**
 * Per-sequence intent history the browser MAY see: the audit spine
 * (seq/kind/actor/at) plus the intake-scanned STRUCTURED state after each
 * intent — so the Founder can inspect the ORIGINAL objective, constraints and
 * acceptance criteria (seq 0, immutable) next to every later amendment
 * without database access. Absent by shape: the raw `body` (original order
 * text + amendment rationale), which stays server-side on
 * `MissionIntentEntry` / `getMissionIntentHistory`.
 */
export interface MissionIntentRef {
  seq: number;
  kind: 'founder_order' | 'amendment';
  actor: string;
  at: string;
  /** Canonical objective AFTER this intent. Seq 0 holds the original, forever. */
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[] | null;
}

/** A full intent entry INCLUDING the server-side body. Never routed to a browser. */
export interface MissionIntentEntry extends MissionIntentRef {
  missionId: string;
  body: string;
}

export interface MissionBlockRecord {
  at: string;
  actor: string;
  note: string | null;
}

/**
 * Server-derived risk/approval truth for the mission-command act itself.
 * Deliberately NOT a `TaskClassification` echo: that shape's
 * `requiresApproval` describes the task approval flow, and a mission command
 * has no approval row — claiming one either way would be false. Unknown is
 * stated, never invented: `riskClass` is null when the registry row is
 * absent.
 */
export interface MissionAuthorityTruth {
  riskClass: RiskClass | null;
  founderOnly: true;
  approvalFlow: 'originate_gated_no_approval_row';
}

export interface MissionRecord {
  id: string;
  title: string;
  objective: string;
  scope: string | null;
  constraints: string[];
  /** null = honestly not supplied (an explicit unknown, not an empty list). */
  acceptanceCriteria: string[] | null;
  project: string | null;
  priority: MissionPriority | null;
  status: MissionStatus;
  blockReason: string | null;
  dependsOn: string[];
  sourceOrderTaskId: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  statusChangedBy: string;
  verification: {
    method: MissionVerificationMethod;
    by: string;
    at: string;
    note: string;
  } | null;
  authority: MissionAuthorityTruth;
  planItems: MissionPlanItem[];
  intentHistory: MissionIntentRef[];
  blockHistory: MissionBlockRecord[];
}

/**
 * The browser-safe mission projection, used by BOTH the control API's mission
 * responses and the snapshot's missions section so there is exactly one
 * implementation of "what does the browser see of a mission".
 *
 * Note what is absent: the intent BODIES (raw Founder order + amendment
 * rationale — server-side audit material) and the derived `idempotencyKey`
 * (internal dedupe machinery). Everything present was scanned and bounded at
 * intake, and every response/snapshot that carries it passes the browser
 * guards again on the way out.
 */
export interface MissionBrowserView {
  id: string;
  title: string;
  objective: string;
  scope: string | null;
  constraints: string[];
  acceptanceCriteria: string[] | null;
  project: string | null;
  priority: MissionPriority | null;
  status: MissionStatus;
  blockReason: string | null;
  dependsOn: string[];
  sourceOrderTaskId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  statusChangedBy: string;
  verification: MissionRecord['verification'];
  authority: MissionAuthorityTruth;
  planItems: {
    seq: number;
    summary: string;
    kind: MissionPlanItem['kind'];
    taskId: string | null;
    state: MissionPlanItemState;
    rawTaskStatus: ActivityStatus | null;
    createdInIntentSeq: number;
    supersededInIntentSeq: number | null;
    linkedBy: string | null;
    linkedAt: string | null;
  }[];
  intentHistory: MissionIntentRef[];
  blockHistory: MissionBlockRecord[];
}

export function missionBrowserView(mission: MissionRecord): MissionBrowserView {
  return {
    id: mission.id,
    title: mission.title,
    objective: mission.objective,
    scope: mission.scope,
    constraints: mission.constraints,
    acceptanceCriteria: mission.acceptanceCriteria,
    project: mission.project,
    priority: mission.priority,
    status: mission.status,
    blockReason: mission.blockReason,
    dependsOn: mission.dependsOn,
    sourceOrderTaskId: mission.sourceOrderTaskId,
    createdBy: mission.createdBy,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    statusChangedAt: mission.statusChangedAt,
    statusChangedBy: mission.statusChangedBy,
    verification: mission.verification,
    authority: mission.authority,
    planItems: mission.planItems.map((item) => ({
      seq: item.seq,
      summary: item.summary,
      kind: item.kind,
      taskId: item.taskId,
      state: item.state,
      rawTaskStatus: item.rawTaskStatus,
      createdInIntentSeq: item.createdInIntentSeq,
      supersededInIntentSeq: item.supersededInIntentSeq,
      linkedBy: item.linkedBy,
      linkedAt: item.linkedAt,
    })),
    intentHistory: mission.intentHistory,
    blockHistory: mission.blockHistory,
  };
}

export interface MissionEventRecord {
  seq: number;
  id: string;
  missionId: string;
  at: string;
  actor: string;
  kind: 'commanded' | 'transitioned' | 'intent_amended' | 'plan_item_linked';
  fromStatus: MissionStatus | null;
  toStatus: MissionStatus | null;
  note: string | null;
}

// ---- idempotency ----

/**
 * Derived digest key. The caller's `idempotencyKey` is an INPUT to the
 * digest, never the key itself (the direct-order lesson: a caller-supplied
 * key made the dedup table caller-addressable). Canonical JSON gives every
 * field an unambiguous encoding, so no field content can imitate a field
 * boundary.
 */
export function missionCommandIdempotencyKey(input: {
  requestedBy: string;
  title: string;
  objective: string;
  scope: string | null;
  constraints: string[];
  acceptanceCriteria: string[] | null;
  project: string | null;
  priority: MissionPriority | null;
  sourceOrderTaskId: string | null;
  dependsOn: string[];
  planItems: string[];
  /**
   * The RAW order text is part of the command's identity: two orders that
   * differ only in their instruction are two different Founder orders, and
   * collapsing them would silently discard the second order's text (Opus
   * second-pass finding on `cee771f`). The instruction itself still never
   * leaves the server — only its digest participates here.
   */
  instruction: string | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        requestedBy: input.requestedBy,
        title: input.title,
        objective: input.objective,
        scope: input.scope,
        constraints: input.constraints,
        acceptanceCriteria: input.acceptanceCriteria,
        project: input.project,
        priority: input.priority,
        sourceOrderTaskId: input.sourceOrderTaskId,
        dependsOn: input.dependsOn,
        planItems: input.planItems,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest('hex');
  return `mission:${digest.slice(0, 32)}`;
}

// ---- reads ----

/** Lookup a linked task's display inputs. Supplied by the service layer. */
export type LinkedTaskLookup = (
  taskId: string,
) => { status: ActivityStatus; reviewPending: boolean } | null;

function parseStringArray(raw: string | null): string[] {
  if (raw == null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function planItemState(
  row: {
    kind: string;
    task_id: string | null;
    superseded_in_intent_seq: number | null;
  },
  linked: { status: ActivityStatus; reviewPending: boolean } | null,
): { state: MissionPlanItemState; rawTaskStatus: ActivityStatus | null } {
  if (row.superseded_in_intent_seq != null) return { state: 'superseded', rawTaskStatus: null };
  if (row.kind === 'needs_clarification') return { state: 'needs_clarification', rawTaskStatus: null };
  if (row.task_id && linked) {
    return {
      state: planItemStateFromTask(linked.status, linked.reviewPending),
      rawTaskStatus: linked.status,
    };
  }
  // Unlinked work item — no real task exists yet, so it is honestly waiting.
  // (A linked id whose row cannot be read reports the same, with a null raw
  // status making the gap visible; op_tasks rows are never hard-deleted.)
  return { state: 'waiting', rawTaskStatus: null };
}

export function readMissionRecord(
  db: HqDatabase,
  id: string,
  linkedTask: LinkedTaskLookup,
  capabilityRow: Capability | null,
): MissionRecord | null {
  const row = db.prepare(`SELECT * FROM hq_missions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const itemRows = db
    .prepare(`SELECT * FROM hq_mission_plan_items WHERE mission_id = ? ORDER BY seq`)
    .all(id) as Record<string, unknown>[];
  const planItems: MissionPlanItem[] = itemRows.map((r) => {
    const taskId = (r.task_id as string | null) ?? null;
    const derived = planItemState(
      {
        kind: r.kind as string,
        task_id: taskId,
        superseded_in_intent_seq: (r.superseded_in_intent_seq as number | null) ?? null,
      },
      taskId ? linkedTask(taskId) : null,
    );
    return {
      seq: r.seq as number,
      summary: r.summary as string,
      kind: r.kind as MissionPlanItem['kind'],
      taskId,
      createdInIntentSeq: r.created_in_intent_seq as number,
      supersededInIntentSeq: (r.superseded_in_intent_seq as number | null) ?? null,
      linkedBy: (r.linked_by as string | null) ?? null,
      linkedAt: (r.linked_at as string | null) ?? null,
      state: derived.state,
      rawTaskStatus: derived.rawTaskStatus,
    };
  });

  // The structured columns ride along; the raw `body` deliberately does NOT —
  // it is selected only by `readMissionIntentEntries` (server-side).
  const intentRows = db
    .prepare(
      `SELECT seq, kind, actor, at, objective, constraints, acceptance_criteria
       FROM hq_mission_intents WHERE mission_id = ? ORDER BY seq`,
    )
    .all(id) as Record<string, unknown>[];

  const blockRows = db
    .prepare(
      `SELECT at, actor, note FROM hq_mission_events
       WHERE mission_id = ? AND to_status = 'blocked' ORDER BY seq`,
    )
    .all(id) as Record<string, unknown>[];

  const verificationMethod = (row.verification_method as string | null) ?? null;

  return {
    id: row.id as string,
    title: row.title as string,
    objective: row.objective as string,
    scope: (row.scope as string | null) ?? null,
    constraints: parseStringArray(row.constraints as string),
    acceptanceCriteria:
      row.acceptance_criteria == null ? null : parseStringArray(row.acceptance_criteria as string),
    project: (row.project as string | null) ?? null,
    priority: (row.priority as MissionPriority | null) ?? null,
    status: row.status as MissionStatus,
    blockReason: (row.block_reason as string | null) ?? null,
    dependsOn: parseStringArray(row.depends_on as string),
    sourceOrderTaskId: (row.source_order_task_id as string | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    statusChangedAt: row.status_changed_at as string,
    statusChangedBy: row.status_changed_by as string,
    verification:
      verificationMethod === 'founder_decision'
        ? {
            method: 'founder_decision',
            by: row.verified_by as string,
            at: row.verified_at as string,
            note: row.verified_note as string,
          }
        : null,
    authority: {
      riskClass: capabilityRow ? capabilityRow.riskClass : null,
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
    },
    planItems,
    intentHistory: intentRows.map((r) => ({
      seq: r.seq as number,
      kind: r.kind as MissionIntentRef['kind'],
      actor: r.actor as string,
      at: r.at as string,
      objective: r.objective as string,
      constraints: parseStringArray(r.constraints as string),
      acceptanceCriteria:
        r.acceptance_criteria == null ? null : parseStringArray(r.acceptance_criteria as string),
    })),
    blockHistory: blockRows.map((r) => ({
      at: r.at as string,
      actor: r.actor as string,
      note: (r.note as string | null) ?? null,
    })),
  };
}

export function listMissionIds(db: HqDatabase, status?: MissionStatus): string[] {
  // Fail closed: a supplied-but-unrecognized status filter matches NOTHING.
  // The previous shape silently widened it to every mission — the wrong
  // direction for a read path in this codebase.
  if (status != null && !isMissionStatus(status)) return [];
  const rows = (
    status != null
      ? db.prepare(`SELECT id FROM hq_missions WHERE status = ? ORDER BY created_at, id`).all(status)
      : db.prepare(`SELECT id FROM hq_missions ORDER BY created_at, id`).all()
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

export function findMissionIdByIdempotencyKey(db: HqDatabase, key: string): string | null {
  const row = db.prepare(`SELECT id FROM hq_missions WHERE idempotency_key = ?`).get(key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/** Full intent entries, bodies included. SERVER-SIDE ONLY — never routed. */
export function readMissionIntentEntries(db: HqDatabase, missionId: string): MissionIntentEntry[] {
  const rows = db
    .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? ORDER BY seq`)
    .all(missionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    missionId: r.mission_id as string,
    seq: r.seq as number,
    kind: r.kind as MissionIntentRef['kind'],
    actor: r.actor as string,
    at: r.at as string,
    body: r.body as string,
    objective: r.objective as string,
    constraints: parseStringArray(r.constraints as string),
    acceptanceCriteria:
      r.acceptance_criteria == null ? null : parseStringArray(r.acceptance_criteria as string),
  }));
}

export function readMissionEvents(db: HqDatabase, missionId: string): MissionEventRecord[] {
  const rows = db
    .prepare(`SELECT * FROM hq_mission_events WHERE mission_id = ? ORDER BY seq`)
    .all(missionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    missionId: r.mission_id as string,
    at: r.at as string,
    actor: r.actor as string,
    kind: r.kind as MissionEventRecord['kind'],
    fromStatus: (r.from_status as MissionStatus | null) ?? null,
    toStatus: (r.to_status as MissionStatus | null) ?? null,
    note: (r.note as string | null) ?? null,
  }));
}

// ---- writes (called by the service inside its transaction) ----

/** Append one mission audit event. INSERT-only by design. */
export function appendMissionEvent(
  db: HqDatabase,
  input: {
    missionId: string;
    actor: string;
    kind: MissionEventRecord['kind'];
    fromStatus?: MissionStatus | null;
    toStatus?: MissionStatus | null;
    note?: string | null;
    detail?: Record<string, unknown> | null;
  },
): void {
  db.prepare(
    `INSERT INTO hq_mission_events (id, mission_id, at, actor, kind, from_status, to_status, note, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    input.missionId,
    nowIso(),
    input.actor,
    input.kind,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.note ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
  );
}

/** Append one intent entry. INSERT-only by design; seq 0 is the original order. */
export function appendMissionIntent(
  db: HqDatabase,
  input: {
    missionId: string;
    seq: number;
    kind: 'founder_order' | 'amendment';
    body: string;
    objective: string;
    constraints: string[];
    acceptanceCriteria: string[] | null;
    actor: string;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO hq_mission_intents
       (id, mission_id, seq, kind, body, objective, constraints, acceptance_criteria, actor, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    input.missionId,
    input.seq,
    input.kind,
    input.body,
    input.objective,
    JSON.stringify(input.constraints),
    input.acceptanceCriteria == null ? null : JSON.stringify(input.acceptanceCriteria),
    input.actor,
    input.at,
  );
}

export function insertMissionPlanItem(
  db: HqDatabase,
  input: {
    missionId: string;
    seq: number;
    summary: string;
    kind: 'work' | 'needs_clarification';
    createdInIntentSeq: number;
  },
): void {
  db.prepare(
    `INSERT INTO hq_mission_plan_items (id, mission_id, seq, summary, kind, created_in_intent_seq)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), input.missionId, input.seq, input.summary, input.kind, input.createdInIntentSeq);
}
