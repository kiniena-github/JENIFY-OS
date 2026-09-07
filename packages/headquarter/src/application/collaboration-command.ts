/**
 * Mission Room + Multi-AI Collaboration — the collaboration RECORD (Phase 9).
 *
 * Several real AI workers may collaborate on ONE canonical mission without
 * becoming an uncontrolled swarm and without creating a second mission, task,
 * worker, approval, evidence or memory truth. This module owns the
 * vocabulary (categorical only), the two capability trios, the append-only
 * schema, the idempotency derivations, the PURE derivation core, the browser
 * projections and the bounded context-bundle policy. The facade
 * (`service.ts`) owns every authority decision and every write.
 *
 * What a collaboration session deliberately is NOT:
 * - not a second mission lifecycle — a session REFERENCES exactly one
 *   canonical `hq_missions` row and has no status column of its own; its
 *   `standing` (`active | closed`) is DERIVED from the mission's canonical
 *   status on every read (terminal mission ⇒ closed session);
 * - not a second task or assignment truth — a contribution may reference a
 *   canonical `op_tasks` row that the mission's plan links, and a
 *   `handoff_request` is a RECOMMENDATION: canonical assignment
 *   (`hq_op_task_meta.assignment`, Founder-gated), claim and fencing stay
 *   exactly where they are and read nothing here;
 * - not authority — a collaboration ROLE (`planner`, `builder`, ...) is
 *   assignment/capability metadata about what a worker was admitted to DO in
 *   the room. It grants no capability, approves nothing, verifies nothing and
 *   is consulted by no gate outside this module's own membership check;
 * - not truth — agreement between any number of workers changes no truth
 *   state. `agrees_with` / `disagrees_with` are stored explicitly as stances
 *   on contributions; a claim becomes verified or accepted ONLY through the
 *   Phase 7 acts (`verifyTruth`, `acceptTruth`) by their own authority rules;
 * - not a memory dump — a context bundle is a bounded, role/task/mission
 *   scoped, read-time composition that excludes founder_only memory and
 *   truth, raw intent bodies, task payloads and every other session;
 * - not a score — every field is a categorical fact, a count HQ made, or a
 *   reference. There is no confidence, progress or activity number anywhere.
 *
 * Provider/model truth: a contribution records the worker's CANONICAL
 * binding read from the database at write time — the operator's declared
 * execution provider (`op_worker_providers`, routing vocabulary `CLAUDE` /
 * `CODEX` / ...) and, when the deployment configured the AI member registry,
 * the registered model identity (`hq_ai_members.identity_key`, registry
 * vocabulary `anthropic:claude-...`). The two vocabularies are DISJOINT and
 * are recorded side by side, never compared to each other and never inferred
 * from a vendor string. A contribution that DECLARES a binding must match the
 * canonical one exactly, or it is refused; nothing is substituted.
 */

import { createHash } from 'node:crypto';
import type { HqDatabase } from '../store/db.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import { canonicalJson } from '../operator/approvals.js';
import type { ActivityStatus } from '../contracts/events.js';
import type { MissionStatus } from '../contracts/mission.js';
import { MEMORY_PRIVACY_LEVELS, isMemoryPrivacy, type MemoryPrivacy } from '../memory/schema.js';
import type { TruthState } from './truth-command.js';

// ---- vocabulary (categorical only) ----

/**
 * The bounded collaboration roles. Capability/assignment METADATA about what
 * a worker was admitted to do in one session — never a personality and never
 * an authority. A worker may hold several in one session (one row each).
 */
export const COLLABORATION_ROLES = ['planner', 'builder', 'researcher', 'reviewer', 'verifier', 'critic'] as const;
export type CollaborationRole = (typeof COLLABORATION_ROLES)[number];

export function isCollaborationRole(value: unknown): value is CollaborationRole {
  return typeof value === 'string' && (COLLABORATION_ROLES as readonly string[]).includes(value);
}

/** What a contribution IS. `handoff_request` carries a structured handoff and is advisory by construction. */
export const CONTRIBUTION_KINDS = [
  'plan',
  'finding',
  'proposal',
  'review',
  'critique',
  'question',
  'answer',
  'status_report',
  'handoff_request',
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export function isContributionKind(value: unknown): value is ContributionKind {
  return typeof value === 'string' && (CONTRIBUTION_KINDS as readonly string[]).includes(value);
}

/**
 * Stances between contributions, stated by the contributing worker at birth
 * and immutable. Disagreement is stored EXPLICITLY — never inferred from
 * text, never resolved by recency, never a vote.
 */
export const CONTRIBUTION_RELATION_KINDS = ['agrees_with', 'disagrees_with', 'responds_to'] as const;
export type ContributionRelationKind = (typeof CONTRIBUTION_RELATION_KINDS)[number];

/** A session's standing is DERIVED from its mission's canonical status; nothing stores it. */
export type SessionStanding = 'active' | 'closed';

/**
 * The privacy classification of a war-room session's own material (its title
 * and purpose text). It is the EXISTING privacy vocabulary — literally
 * `MEMORY_PRIVACY_LEVELS`, the same two levels truth and memory use — not a
 * second privacy system and not a second authority store: the classification
 * is metadata on the session row, and each reading layer enforces its own
 * disclosure exactly as `hq_memory` / `hq_truth_records` do.
 *
 * Why it exists (Phase 9 correction, Low L5): `collaborationSummary` feeds the
 * UNAUTHENTICATED `hq-snapshot.json` artifact, and a session's free-text
 * purpose rode it verbatim. There is no `public` level in this vocabulary, so
 * nothing is ever classified FOR verbatim publication on that artifact: the
 * snapshot withholds every purpose text, and a `founder_only` session's
 * material is not carried at all. `internal` is the conservative default —
 * a session opened without naming a classification is internal, never public.
 */
export const COLLABORATION_PRIVACIES = MEMORY_PRIVACY_LEVELS;
export type CollaborationPrivacy = MemoryPrivacy;

export function isCollaborationPrivacy(value: unknown): value is CollaborationPrivacy {
  return isMemoryPrivacy(value);
}

/** What a session opened without an explicit classification is: internal, never public. */
export const DEFAULT_COLLABORATION_PRIVACY: CollaborationPrivacy = 'internal';

/**
 * The categorical agreement picture of one contribution, derived from the
 * explicit stances OTHER contributions took on it. Informational only: no
 * value here verifies, accepts, assigns or executes anything.
 */
export type ContributionStanding = 'unchallenged' | 'agreed' | 'disputed' | 'mixed';

/**
 * Where a contribution's recorded binding came from. `undeclared` is an
 * honest statement that HQ holds no provider declaration for the worker —
 * never a guess from its vendor string.
 */
export const BINDING_SOURCES = ['declared_provider_and_registered_model', 'declared_provider', 'undeclared'] as const;
export type BindingSource = (typeof BINDING_SOURCES)[number];

// ---- capabilities: the two trios ----

/**
 * The Founder act: opening a session on a mission and admitting a worker to
 * it under a role. `founder_gate` because admitting a worker to a mission's
 * room is company direction; `sideEffect: false` because it writes a control-
 * plane record and reaches nothing outside.
 */
export const COLLABORATION_COMMAND_CAPABILITY = {
  id: 'hq.collaboration_command',
  description:
    'Collaboration command — opens a collaboration session on one canonical mission and admits ' +
    'registered workers to it under bounded roles. Records only; executes nothing and assigns no task.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/**
 * The worker act: recording a contribution into a session the worker was
 * admitted to. A WORKER may hold this through its directory grant (the
 * truth-record precedent); humans direct missions through mission command
 * and never contribute here; `system` is refused outright.
 */
export const COLLABORATION_CONTRIBUTE_CAPABILITY = {
  id: 'hq.collaboration_contribute',
  description:
    'Collaboration contribution — records one attributed contribution (plan, finding, review, ' +
    'critique, handoff request, ...) from an admitted worker into a collaboration session. ' +
    'Writes the collaboration record only; verifies nothing, assigns nothing, executes nothing.',
  riskClass: 'reversible',
  sideEffect: false,
  idempotent: true,
} as const;

/** Register the collaboration-command capability — a CONFIGURATION action. */
export function registerCollaborationCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...COLLABORATION_COMMAND_CAPABILITY });
}

/** Register the collaboration-contribute capability — a CONFIGURATION action. */
export function registerCollaborationContributeCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...COLLABORATION_CONTRIBUTE_CAPABILITY });
}

type ReservedContract = { riskClass: string; sideEffect: boolean; idempotent: boolean };

function contractDrift(capability: Capability, reserved: ReservedContract): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== reserved.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== reserved.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== reserved.idempotent) drift.push('idempotent');
  return drift;
}

export function collaborationCommandContractDrift(capability: Capability): string[] {
  return contractDrift(capability, COLLABORATION_COMMAND_CAPABILITY);
}

export function collaborationContributeContractDrift(capability: Capability): string[] {
  return contractDrift(capability, COLLABORATION_CONTRIBUTE_CAPABILITY);
}

export type CollaborationCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/** Classify the registry row — enforcement-safe read, drift before enabled, never repairs. */
export function collaborationCommandCapabilityState(capability: Capability | null): CollaborationCapabilityState {
  if (!capability) return 'missing';
  if (collaborationCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

export function collaborationContributeCapabilityState(capability: Capability | null): CollaborationCapabilityState {
  if (!capability) return 'missing';
  if (collaborationContributeContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

export const MAX_COLLABORATION_TITLE_LENGTH = 120;
export const MAX_COLLABORATION_PURPOSE_LENGTH = 500;
export const MAX_CONTRIBUTION_CONTENT_LENGTH = 4000;
export const MAX_HANDOFF_REASON_LENGTH = 500;
export const MAX_COLLABORATION_REF_ENTRIES = 20;
export const MAX_COLLABORATION_REF_LENGTH = 200;
/** Bounded reads: the true total is always stated beside a bounded list. */
export const COLLABORATION_READ_LIMIT = 50;
/** How many contributions a Mission Room view carries (newest first). */
export const MISSION_ROOM_CONTRIBUTION_LIMIT = 50;
/** How many recent orchestration runs / external actions a Mission Room view carries. */
export const MISSION_ROOM_RUN_LIMIT = 10;
/** Per-section cap on a context bundle. */
export const COLLABORATION_CONTEXT_LIMIT = 20;
/** How many sessions the snapshot section carries (newest first). */
export const COLLABORATION_SNAPSHOT_LIMIT = 20;

// ---- idempotency ----

/**
 * Derived dedupe key for a session. The caller's `idempotencyKey` is an INPUT
 * to the digest (the mission rule).
 *
 * `privacy` participates ONLY when it is not the default, deliberately: two
 * opens that differ only in classification must not dedupe onto each other
 * (the second one's classification would be silently discarded), while an
 * `internal` open still digests byte-identically to the pre-classification
 * derivation — so a session recorded before this correction still deduplicates
 * a repeat afterwards instead of silently opening a second room.
 */
export function collaborationSessionIdempotencyKey(input: {
  requestedBy: string;
  missionId: string;
  title: string;
  purpose: string | null;
  privacy?: CollaborationPrivacy;
  idempotencyKey: string | null;
}): string {
  // `canonicalJson` drops `undefined` entries, so the default classification
  // contributes nothing to the digest.
  const digested = {
    ...input,
    privacy: input.privacy === DEFAULT_COLLABORATION_PRIVACY ? undefined : input.privacy,
  };
  const digest = createHash('sha256').update(canonicalJson(digested)).digest('hex');
  return `collab-session:${digest.slice(0, 32)}`;
}

export function contributionIdempotencyKey(input: {
  workerId: string;
  sessionId: string;
  role: CollaborationRole;
  kind: ContributionKind;
  taskId: string | null;
  content: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  truthRefs: string[];
  agreesWith: string[];
  disagreesWith: string[];
  respondsTo: string[];
  handoff: { taskId: string; toWorkerId: string; reason: string } | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `collab-contribution:${digest.slice(0, 32)}`;
}

// ---- schema: four tables, all INSERT-only BY ENGINE ----

/**
 * The full §G trigger set on every table (the hq_truth_* / hq_action_*
 * recipe): no UPDATE of any column, no DELETE, a BEFORE INSERT guard on the
 * primary target (`id`, `seq`) AND on every secondary unique index, so
 * REPLACE / INSERT OR REPLACE / UPSERT is closed on every conflict target for
 * every writer regardless of that writer's `recursive_triggers` setting.
 * Every table uses `seq INTEGER PRIMARY KEY`, so the implicit rowid IS `seq`
 * and the carried-forward implicit-rowid shape (Phase 8 Known limitations)
 * does not arise here.
 *
 * There is NO legitimate mutation anywhere: a session's standing is derived
 * from its mission, a contribution's standing from later contributions'
 * stances, a handoff's canonical picture from the task row at read time.
 */
const COLLABORATION_DDL = `
CREATE TABLE IF NOT EXISTS hq_collab_sessions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT,
  -- The session's own privacy classification (the memory/truth vocabulary).
  -- Conservative default so a pre-classification row reads as internal.
  privacy TEXT NOT NULL DEFAULT 'internal',
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_collab_sessions_mission ON hq_collab_sessions(mission_id, seq);

CREATE TABLE IF NOT EXISTS hq_collab_participants (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  role TEXT NOT NULL,
  provider_id TEXT,
  member_identity_key TEXT,
  admitted_by TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);
-- One admission per (session, worker, role): the same triple deduplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_collab_participants_once
  ON hq_collab_participants(session_id, worker_id, role);

CREATE TABLE IF NOT EXISTS hq_collab_contributions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT,
  worker_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  artifact_refs TEXT NOT NULL,
  evidence_refs TEXT NOT NULL,
  truth_refs TEXT NOT NULL,
  provider_id TEXT,
  member_identity_key TEXT,
  binding_source TEXT NOT NULL,
  handoff_task_id TEXT,
  handoff_to_worker_id TEXT,
  handoff_reason TEXT,
  at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_hq_collab_contributions_session ON hq_collab_contributions(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_hq_collab_contributions_mission ON hq_collab_contributions(mission_id, seq);

CREATE TABLE IF NOT EXISTS hq_collab_relations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_collab_relations_from ON hq_collab_relations(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_hq_collab_relations_to ON hq_collab_relations(to_id, kind);

CREATE TRIGGER IF NOT EXISTS trg_hq_collab_sessions_no_rewrite
BEFORE UPDATE ON hq_collab_sessions
BEGIN SELECT RAISE(ABORT, 'hq_collab_sessions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_sessions_no_erase
BEFORE DELETE ON hq_collab_sessions
BEGIN SELECT RAISE(ABORT, 'hq_collab_sessions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_sessions_no_replace
BEFORE INSERT ON hq_collab_sessions
WHEN EXISTS (SELECT 1 FROM hq_collab_sessions WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_collab_sessions WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM hq_collab_sessions WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_collab_sessions is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_collab_participants_no_rewrite
BEFORE UPDATE ON hq_collab_participants
BEGIN SELECT RAISE(ABORT, 'hq_collab_participants is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_participants_no_erase
BEFORE DELETE ON hq_collab_participants
BEGIN SELECT RAISE(ABORT, 'hq_collab_participants is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_participants_no_replace
BEFORE INSERT ON hq_collab_participants
WHEN EXISTS (SELECT 1 FROM hq_collab_participants WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_collab_participants WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM hq_collab_participants
             WHERE session_id = NEW.session_id AND worker_id = NEW.worker_id AND role = NEW.role)
BEGIN SELECT RAISE(ABORT, 'hq_collab_participants is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_collab_contributions_no_rewrite
BEFORE UPDATE ON hq_collab_contributions
BEGIN SELECT RAISE(ABORT, 'hq_collab_contributions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_contributions_no_erase
BEFORE DELETE ON hq_collab_contributions
BEGIN SELECT RAISE(ABORT, 'hq_collab_contributions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_contributions_no_replace
BEFORE INSERT ON hq_collab_contributions
WHEN EXISTS (SELECT 1 FROM hq_collab_contributions WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_collab_contributions WHERE seq = NEW.seq))
  OR EXISTS (SELECT 1 FROM hq_collab_contributions WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_collab_contributions is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_collab_relations_no_rewrite
BEFORE UPDATE ON hq_collab_relations
BEGIN SELECT RAISE(ABORT, 'hq_collab_relations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_relations_no_erase
BEFORE DELETE ON hq_collab_relations
BEGIN SELECT RAISE(ABORT, 'hq_collab_relations is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_collab_relations_no_replace
BEFORE INSERT ON hq_collab_relations
WHEN EXISTS (SELECT 1 FROM hq_collab_relations WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM hq_collab_relations WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_collab_relations is append-only'); END;
`;

/**
 * Idempotent; readonly-safe (the post-Phase-3 ensure*Schema pattern).
 *
 * The `privacy` column is additive for a file whose `hq_collab_sessions` was
 * created before the classification existed (`CREATE TABLE IF NOT EXISTS`
 * never revisits an existing table). `ADD COLUMN ... DEFAULT 'internal'`
 * writes no row and fires no trigger, so the append-only guarantee is
 * untouched and every pre-existing session reads as `internal` — the
 * conservative classification, never `public`.
 */
export function ensureCollaborationSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(COLLABORATION_DDL);
  const columns = db.prepare(`PRAGMA table_info(hq_collab_sessions)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === 'privacy')) {
    db.exec(`ALTER TABLE hq_collab_sessions ADD COLUMN privacy TEXT NOT NULL DEFAULT 'internal'`);
  }
}

/** True when the collaboration tables exist in this file — observation, never migration. */
export function collaborationSchemaPresent(db: HqDatabase): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_collab_sessions'`)
      .get() !== undefined
  );
}

// ---- stored rows ----

export interface CollaborationSessionRow {
  seq: number;
  id: string;
  missionId: string;
  title: string;
  purpose: string | null;
  /** Stored classification of this session's own material. Metadata; each reader enforces its own disclosure. */
  privacy: CollaborationPrivacy;
  openedBy: string;
  openedAt: string;
}

export interface ParticipantRow {
  seq: number;
  id: string;
  sessionId: string;
  workerId: string;
  role: CollaborationRole;
  providerId: string | null;
  memberIdentityKey: string | null;
  admittedBy: string;
  admittedAt: string;
}

export interface ContributionRow {
  seq: number;
  id: string;
  sessionId: string;
  missionId: string;
  taskId: string | null;
  workerId: string;
  role: CollaborationRole;
  kind: ContributionKind;
  content: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  truthRefs: string[];
  providerId: string | null;
  memberIdentityKey: string | null;
  bindingSource: BindingSource;
  handoff: { taskId: string; toWorkerId: string; reason: string } | null;
  at: string;
}

export interface ContributionRelationRow {
  seq: number;
  id: string;
  fromId: string;
  kind: ContributionRelationKind;
  toId: string;
  recordedBy: string;
  recordedAt: string;
}

function rowToSession(r: Record<string, unknown>): CollaborationSessionRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    missionId: r.mission_id as string,
    title: r.title as string,
    purpose: (r.purpose as string | null) ?? null,
    // Absent column = a read-only file created before the classification
    // existed; it reads as exactly what `ADD COLUMN ... DEFAULT` would have
    // written. A PRESENT but unrecognised value is corruption and reads as the
    // MORE private level — a broken classification never opens a session up.
    privacy:
      r.privacy === undefined || r.privacy === null
        ? DEFAULT_COLLABORATION_PRIVACY
        : isCollaborationPrivacy(r.privacy)
          ? r.privacy
          : 'founder_only',
    openedBy: r.opened_by as string,
    openedAt: r.opened_at as string,
  };
}

function rowToParticipant(r: Record<string, unknown>): ParticipantRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    sessionId: r.session_id as string,
    workerId: r.worker_id as string,
    role: r.role as CollaborationRole,
    providerId: (r.provider_id as string | null) ?? null,
    memberIdentityKey: (r.member_identity_key as string | null) ?? null,
    admittedBy: r.admitted_by as string,
    admittedAt: r.admitted_at as string,
  };
}

function rowToContribution(r: Record<string, unknown>): ContributionRow {
  const handoffTaskId = (r.handoff_task_id as string | null) ?? null;
  return {
    seq: r.seq as number,
    id: r.id as string,
    sessionId: r.session_id as string,
    missionId: r.mission_id as string,
    taskId: (r.task_id as string | null) ?? null,
    workerId: r.worker_id as string,
    role: r.role as CollaborationRole,
    kind: r.kind as ContributionKind,
    content: r.content as string,
    artifactRefs: JSON.parse(r.artifact_refs as string) as string[],
    evidenceRefs: JSON.parse(r.evidence_refs as string) as string[],
    truthRefs: JSON.parse(r.truth_refs as string) as string[],
    providerId: (r.provider_id as string | null) ?? null,
    memberIdentityKey: (r.member_identity_key as string | null) ?? null,
    bindingSource: r.binding_source as BindingSource,
    handoff: handoffTaskId
      ? {
          taskId: handoffTaskId,
          toWorkerId: r.handoff_to_worker_id as string,
          reason: (r.handoff_reason as string | null) ?? '',
        }
      : null,
    at: r.at as string,
  };
}

function rowToRelation(r: Record<string, unknown>): ContributionRelationRow {
  return {
    seq: r.seq as number,
    id: r.id as string,
    fromId: r.from_id as string,
    kind: r.kind as ContributionRelationKind,
    toId: r.to_id as string,
    recordedBy: r.recorded_by as string,
    recordedAt: r.recorded_at as string,
  };
}

export function loadCollaborationSession(db: HqDatabase, id: string): CollaborationSessionRow | null {
  const row = db.prepare(`SELECT * FROM hq_collab_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

/** Every session, newest first, optionally narrowed to one mission. */
export function loadCollaborationSessions(db: HqDatabase, missionId?: string): CollaborationSessionRow[] {
  const rows = missionId
    ? (db.prepare(`SELECT * FROM hq_collab_sessions WHERE mission_id = ? ORDER BY seq DESC`).all(missionId) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM hq_collab_sessions ORDER BY seq DESC`).all() as Record<string, unknown>[]);
  return rows.map(rowToSession);
}

export function loadParticipants(db: HqDatabase, sessionId: string): ParticipantRow[] {
  return (
    db.prepare(`SELECT * FROM hq_collab_participants WHERE session_id = ? ORDER BY seq`).all(sessionId) as Record<
      string,
      unknown
    >[]
  ).map(rowToParticipant);
}

/** A session's contributions in chain order (oldest first). */
export function loadContributions(db: HqDatabase, sessionId: string): ContributionRow[] {
  return (
    db.prepare(`SELECT * FROM hq_collab_contributions WHERE session_id = ? ORDER BY seq`).all(sessionId) as Record<
      string,
      unknown
    >[]
  ).map(rowToContribution);
}

export function loadContribution(db: HqDatabase, id: string): ContributionRow | null {
  const row = db.prepare(`SELECT * FROM hq_collab_contributions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToContribution(row) : null;
}

/** Every stance touching any contribution of one session, in chain order. */
export function loadSessionRelations(db: HqDatabase, sessionId: string): ContributionRelationRow[] {
  return (
    db
      .prepare(
        `SELECT r.* FROM hq_collab_relations r
         JOIN hq_collab_contributions c ON c.id = r.from_id
         WHERE c.session_id = ? ORDER BY r.seq`,
      )
      .all(sessionId) as Record<string, unknown>[]
  ).map(rowToRelation);
}

// ---- the pure derivation core ----

export interface ParticipantView {
  id: string;
  sessionId: string;
  workerId: string;
  role: CollaborationRole;
  /** The operator's declared execution provider at admission (routing vocabulary), or null = undeclared. */
  providerId: string | null;
  /** The registered model identity at admission (registry vocabulary), or null = no registered member. */
  memberIdentityKey: string | null;
  admittedBy: string;
  admittedAt: string;
}

export interface ContributionStance {
  contributionId: string;
  workerId: string;
  role: CollaborationRole;
}

/** The canonical task picture beside a handoff request — read at derivation time, never stored. */
export interface HandoffCanonicalTaskState {
  status: ActivityStatus;
  claimedBy: string | null;
  assignedWorkerId: string | null;
  assignedBy: string | null;
}

/**
 * The ONE browser-safe projection of a contribution, shared by the routes,
 * the Mission Room view and the context bundle. Every field is a categorical
 * fact, a reference, or something HQ counted.
 */
export interface ContributionView {
  id: string;
  seq: number;
  sessionId: string;
  missionId: string;
  taskId: string | null;
  workerId: string;
  role: CollaborationRole;
  kind: ContributionKind;
  content: string;
  artifactRefs: string[];
  /** `op_evidence` ids — references, never copies. */
  evidenceRefs: string[];
  /**
   * `hq_truth_records` ids with the truth state each derives NOW through
   * the Phase 7 derivation — so the reader can see that agreement in the
   * room moved none of them. `null` state = the record is not visible to
   * this reader (or no longer exists); the id is still a reference only.
   */
  truthRefs: { id: string; state: TruthState | null }[];
  binding: { providerId: string | null; memberIdentityKey: string | null; source: BindingSource };
  at: string;
  /** Stances THIS contribution stated at birth. */
  agreesWith: string[];
  disagreesWith: string[];
  respondsTo: string[];
  /** Stances OTHER contributions stated about this one. */
  agreedBy: ContributionStance[];
  disputedBy: ContributionStance[];
  /** DERIVED from the stances above. Informs the reader; grants nothing. */
  standing: ContributionStanding;
  handoff: {
    taskId: string;
    toWorkerId: string;
    reason: string;
    /** What the canonical task row says NOW. A request changes none of it. */
    canonical: HandoffCanonicalTaskState | null;
    advisory: true;
  } | null;
}

export interface ContributionDerivationContext {
  /** The truth state a truth id derives now, or null when not visible/absent. */
  truthStateOf: (truthId: string) => TruthState | null;
  /** The canonical task row a handoff names, or null when absent. */
  taskStateOf: (taskId: string) => HandoffCanonicalTaskState | null;
}

export function contributionStanding(agreedBy: number, disputedBy: number): ContributionStanding {
  if (agreedBy > 0 && disputedBy > 0) return 'mixed';
  if (disputedBy > 0) return 'disputed';
  if (agreedBy > 0) return 'agreed';
  return 'unchallenged';
}

/** Derive one contribution's view from the session's rows. PURE over its inputs and the supplied lookups. */
export function deriveContributionView(
  row: ContributionRow,
  contributions: readonly ContributionRow[],
  relations: readonly ContributionRelationRow[],
  ctx: ContributionDerivationContext,
): ContributionView {
  const byId = new Map(contributions.map((c) => [c.id, c]));
  const out = (kind: ContributionRelationKind) => relations.filter((r) => r.fromId === row.id && r.kind === kind).map((r) => r.toId);
  const inbound = (kind: ContributionRelationKind): ContributionStance[] =>
    relations
      .filter((r) => r.toId === row.id && r.kind === kind)
      .map((r) => {
        const from = byId.get(r.fromId);
        return { contributionId: r.fromId, workerId: from?.workerId ?? r.recordedBy, role: from?.role ?? row.role };
      });
  const agreedBy = inbound('agrees_with');
  const disputedBy = inbound('disagrees_with');
  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.sessionId,
    missionId: row.missionId,
    taskId: row.taskId,
    workerId: row.workerId,
    role: row.role,
    kind: row.kind,
    content: row.content,
    artifactRefs: [...row.artifactRefs],
    evidenceRefs: [...row.evidenceRefs],
    truthRefs: row.truthRefs.map((id) => ({ id, state: ctx.truthStateOf(id) })),
    binding: { providerId: row.providerId, memberIdentityKey: row.memberIdentityKey, source: row.bindingSource },
    at: row.at,
    agreesWith: out('agrees_with'),
    disagreesWith: out('disagrees_with'),
    respondsTo: out('responds_to'),
    agreedBy,
    disputedBy,
    standing: contributionStanding(agreedBy.length, disputedBy.length),
    handoff: row.handoff
      ? {
          taskId: row.handoff.taskId,
          toWorkerId: row.handoff.toWorkerId,
          reason: row.handoff.reason,
          canonical: ctx.taskStateOf(row.handoff.taskId),
          advisory: true,
        }
      : null,
  };
}

/** One explicit, stored disagreement, listed until the reader resolves it by their own act. */
export interface DisagreementView {
  sessionId: string;
  missionId: string;
  /** The contribution that stated the disagreement. */
  contributionId: string;
  workerId: string;
  role: CollaborationRole;
  /** The contribution disagreed with. */
  disputesId: string;
  disputedWorkerId: string;
  disputedRole: CollaborationRole;
  at: string;
}

export function deriveDisagreements(
  contributions: readonly ContributionRow[],
  relations: readonly ContributionRelationRow[],
): DisagreementView[] {
  const byId = new Map(contributions.map((c) => [c.id, c]));
  const out: DisagreementView[] = [];
  for (const relation of relations) {
    if (relation.kind !== 'disagrees_with') continue;
    const from = byId.get(relation.fromId);
    const to = byId.get(relation.toId);
    if (!from || !to) continue;
    out.push({
      sessionId: from.sessionId,
      missionId: from.missionId,
      contributionId: from.id,
      workerId: from.workerId,
      role: from.role,
      disputesId: to.id,
      disputedWorkerId: to.workerId,
      disputedRole: to.role,
      at: from.at,
    });
  }
  return out;
}

/** A handoff RECOMMENDATION beside the canonical task truth it did not change. */
export interface HandoffRequestView {
  contributionId: string;
  sessionId: string;
  missionId: string;
  taskId: string;
  fromWorkerId: string;
  toWorkerId: string;
  reason: string;
  at: string;
  canonical: HandoffCanonicalTaskState | null;
  advisory: true;
}

export function deriveHandoffRequests(
  contributions: readonly ContributionRow[],
  taskStateOf: ContributionDerivationContext['taskStateOf'],
): HandoffRequestView[] {
  return contributions
    .filter((c) => c.kind === 'handoff_request' && c.handoff != null)
    .map((c) => ({
      contributionId: c.id,
      sessionId: c.sessionId,
      missionId: c.missionId,
      taskId: c.handoff!.taskId,
      fromWorkerId: c.workerId,
      toWorkerId: c.handoff!.toWorkerId,
      reason: c.handoff!.reason,
      at: c.at,
      canonical: taskStateOf(c.handoff!.taskId),
      advisory: true,
    }));
}

/** The standing a session derives from its mission's canonical status. Nothing stores it. */
export function sessionStandingFor(missionStatus: MissionStatus | null): SessionStanding {
  if (missionStatus === null) return 'closed';
  return missionStatus === 'complete' || missionStatus === 'failed' || missionStatus === 'cancelled' ? 'closed' : 'active';
}

export interface CollaborationSessionView {
  id: string;
  seq: number;
  missionId: string;
  /** The mission's canonical status at read time; null = the mission row is gone. */
  missionStatus: MissionStatus | null;
  /** DERIVED from `missionStatus`. */
  standing: SessionStanding;
  title: string;
  /**
   * The session's free-text purpose — or `null` where the reading layer
   * withheld it (the unauthenticated snapshot artifact always does; see
   * `snapshotSessionView`). Never a rewritten or invented string.
   */
  purpose: string | null;
  /** This session's own privacy classification. Metadata; the reader enforces. */
  privacy: CollaborationPrivacy;
  openedBy: string;
  openedAt: string;
  participants: ParticipantView[];
  contributionCount: number;
  disagreementCount: number;
  handoffRequestCount: number;
}

export function participantView(row: ParticipantRow): ParticipantView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workerId: row.workerId,
    role: row.role,
    providerId: row.providerId,
    memberIdentityKey: row.memberIdentityKey,
    admittedBy: row.admittedBy,
    admittedAt: row.admittedAt,
  };
}

export function deriveSessionView(
  row: CollaborationSessionRow,
  missionStatus: MissionStatus | null,
  participants: readonly ParticipantRow[],
  contributions: readonly ContributionRow[],
  relations: readonly ContributionRelationRow[],
): CollaborationSessionView {
  return {
    id: row.id,
    seq: row.seq,
    missionId: row.missionId,
    missionStatus,
    standing: sessionStandingFor(missionStatus),
    title: row.title,
    purpose: row.purpose,
    privacy: row.privacy,
    openedBy: row.openedBy,
    openedAt: row.openedAt,
    participants: participants.map(participantView),
    contributionCount: contributions.length,
    disagreementCount: deriveDisagreements(contributions, relations).length,
    handoffRequestCount: contributions.filter((c) => c.kind === 'handoff_request').length,
  };
}

// ---- the bounded context-bundle policy ----

export const CONTEXT_SECTIONS = ['mission', 'task', 'participants', 'contributions', 'truth', 'memory'] as const;
export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

/**
 * Which bounded sections each role's bundle assembles. A stated, categorical
 * policy — not an inference about what a role "needs": builders get the task
 * ref and entity-linked memory but not the truth graph; reviewers, verifiers
 * and critics get the truth records about the mission and its tasks but not
 * memory; planners and researchers get both; nobody gets founder_only
 * anything, raw intent bodies, task payloads, or another session's room.
 * Changing a row here is a reviewed edit, never configuration.
 */
export const CONTEXT_SECTIONS_BY_ROLE: Readonly<Record<CollaborationRole, readonly ContextSection[]>> = {
  planner: ['mission', 'participants', 'contributions', 'truth', 'memory'],
  builder: ['mission', 'task', 'participants', 'contributions', 'memory'],
  researcher: ['mission', 'participants', 'contributions', 'truth', 'memory'],
  reviewer: ['mission', 'task', 'participants', 'contributions', 'truth'],
  verifier: ['mission', 'task', 'participants', 'contributions', 'truth'],
  critic: ['mission', 'participants', 'contributions', 'truth'],
};

// ---- the snapshot view ----

/**
 * The bounded snapshot section: counts HQ made over EVERY session plus the
 * newest `COLLABORATION_SNAPSHOT_LIMIT` session views. No participant
 * activity is invented: a session with no contribution counts zero.
 */
export interface CollaborationSnapshotView {
  /** Every session, `founder_only`-classified ones INCLUDED — the true count, never a shortened one. */
  sessions: number;
  /**
   * `founder_only`-classified sessions counted in `sessions` but not carried
   * and not aggregated over. Every other number below spans the set this
   * reader may see, so arithmetic on the artifact discloses no categorical
   * fact about a withheld session (the `truthSummary` rule).
   */
  withheldFounderOnly: number;
  /**
   * Carried sessions whose free-text `purpose` was withheld. The privacy
   * vocabulary has no `public` level, so nothing is classified FOR verbatim
   * publication on an unauthenticated artifact and this equals the number of
   * carried sessions that HAVE a purpose. Stated rather than silently nulled.
   */
  withheldPurposes: number;
  activeSessions: number;
  /** Distinct admitted worker ids across the sessions this reader may see. */
  workersAdmitted: number;
  contributions: number;
  /** Explicit `disagrees_with` stances — every one is open until the reader resolves it by an act elsewhere. */
  disagreements: number;
  handoffRequests: number;
  recent: CollaborationSessionView[];
}

/**
 * One session as an UNAUTHENTICATED artifact may carry it: the free-text
 * purpose is dropped, because the privacy vocabulary has no level that
 * classifies text for publication to an unauthenticated reader. Counts,
 * categorical fields, worker ids and bindings are unchanged — the session is
 * still visibly there, it just does not narrate itself.
 *
 * Callers hand this only sessions they have already decided the reader may
 * see; it withholds text, it does not decide who reads.
 */
export function snapshotSessionView(view: CollaborationSessionView): CollaborationSessionView {
  return view.purpose === null ? view : { ...view, purpose: null };
}
