/**
 * Project Command — the canonical Project register (Phase 4, issue #262).
 *
 * A Project is the Founder's register entry for a body of work: identity,
 * name, purpose, an optional stream label, and an `active`/`closed` state.
 * Missions are assigned to projects (`hq_missions.project_id`); tasks reach a
 * project only through their mission's plan items. A project grants nothing,
 * approves nothing, holds no claim, names no provider and executes nothing.
 *
 * Naming reconciliation — "project" already means several things here, and
 * the others stay exactly what they are:
 * - `hq_missions.project` and `hq_op_task_meta.project` are free-text LABELS
 *   ("console labels only — never authority"). They are not foreign keys and
 *   are never string-matched against this register. `hq_missions.project_id`
 *   is the canonical relationship.
 * - `hq_events.detail.project`, archive and memory `project` fields are
 *   label taxonomies over historical records. Untouched.
 *
 * Table adoption: `hq_projects` was created by the foundation DDL
 * (`store/db.ts`) in the foundation wave and wired to nothing. Phase 4 adopts
 * it as THE canonical project table — the alternative, a second table with a
 * worse name forever, is exactly the two-project-systems outcome the Founder
 * brief forbids. This module owns everything about it from here on: the
 * additive column upgrades below, the append-only `hq_project_events`
 * history, and the only write paths (the facade methods on
 * `HeadquarterOperations`). The store's ungated `upsertProject` was deleted
 * in the same change that added this module.
 *
 * Legacy wart, stated: the adopted table has `stream TEXT NOT NULL`, and
 * SQLite cannot drop NOT NULL without a table rebuild. An unstated stream is
 * therefore stored as '' and read back as null — `encodeStream` /
 * `decodeStream` are the single write and read sites of that encoding, and a
 * test pins it. A 12-step rebuild of a foundation-created table from a module
 * was judged more dangerous than a one-line documented encoding.
 *
 * Schema is module-owned and additive; `src/store/db.ts` is not edited.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import { CapabilityRegistry, type Capability, type RiskClass } from '../operator/capabilities.js';
import { isProjectStatus, type ProjectStatus } from '../contracts/project.js';
import type { ActivityStatus } from '../contracts/events.js';
import type { MissionStatus } from '../contracts/mission.js';

// ---- capability (CONFIGURATION vs INVOCATION, the mission-command trio) ----

/**
 * The one capability a Founder project command exercises.
 *
 * NOT registered automatically anywhere. A deployment that wants the Project
 * register calls `registerProjectCommandCapability` explicitly, as a
 * CONFIGURATION action; until then `createProject` fails closed.
 *
 * `sideEffect: false` is honest: commanding a project writes a canonical
 * register record and reaches nothing outside the control plane. The risk
 * class is still `founder_gate` because the ACT — declaring and closing
 * bodies of company work — is a Founder-only act.
 */
export const PROJECT_COMMAND_CAPABILITY = {
  id: 'hq.project_command',
  description:
    'Founder project command — creates and controls canonical project register entries. ' +
    'Organizes missions only; executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/** Register the project-command capability — a CONFIGURATION action. */
export function registerProjectCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...PROJECT_COMMAND_CAPABILITY });
}

/** The definition fields that carry the Founder gate. */
export const PROJECT_COMMAND_RESERVED_CONTRACT = {
  riskClass: PROJECT_COMMAND_CAPABILITY.riskClass,
  sideEffect: PROJECT_COMMAND_CAPABILITY.sideEffect,
  idempotent: PROJECT_COMMAND_CAPABILITY.idempotent,
} as const;

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function projectCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== PROJECT_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== PROJECT_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== PROJECT_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type ProjectCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Classify the registry's current row. Callers supply the row from an
 * ENFORCEMENT-SAFE read, never from `queue.capabilities` (#219). Drift is
 * checked before `enabled`, and detecting drift never repairs it.
 */
export function projectCommandCapabilityState(
  capability: Capability | null,
): ProjectCommandCapabilityState {
  if (!capability) return 'missing';
  if (projectCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_PROJECT_PURPOSE_LENGTH = 500;
export const MAX_PROJECT_STREAM_LENGTH = 120;
export const MAX_PROJECT_NOTE_LENGTH = 500;

// ---- stream '' <-> null encoding (the single write and read sites) ----

/** The adopted column is NOT NULL; an unstated stream is stored as ''. */
export function encodeStream(stream: string | null): string {
  return stream ?? '';
}

/** '' reads back as null: unstated is reported as unstated, never as ''. */
export function decodeStream(raw: string): string | null {
  return raw === '' ? null : raw;
}

// ---- schema ----

/**
 * Additive columns on the ADOPTED `hq_projects` table. Nullable by
 * necessity and honestly: a null `created_by` means "pre-Phase-4 row,
 * creator not recorded", stated wherever it surfaces.
 */
const PROJECT_COLUMN_UPGRADES: readonly { column: string; ddl: string }[] = [
  { column: 'created_by', ddl: `ALTER TABLE hq_projects ADD COLUMN created_by TEXT` },
  { column: 'status_changed_at', ddl: `ALTER TABLE hq_projects ADD COLUMN status_changed_at TEXT` },
  { column: 'status_changed_by', ddl: `ALTER TABLE hq_projects ADD COLUMN status_changed_by TEXT` },
  { column: 'idempotency_key', ddl: `ALTER TABLE hq_projects ADD COLUMN idempotency_key TEXT` },
];

const PROJECT_EVENTS_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_projects_idem
  ON hq_projects(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS hq_project_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_project_events_project ON hq_project_events(project_id, seq);

-- Append-only ENFORCED by the engine, born with the COMPLETE trigger set:
-- BEFORE UPDATE / BEFORE DELETE abort a rewrite, and the BEFORE INSERT guard
-- aborts an insert landing on an existing row BEFORE conflict resolution, so
-- REPLACE, INSERT OR REPLACE and UPSERT abort too (the Phase 4 SG lesson —
-- recursive_triggers is off by default and connection-scoped, so BEFORE
-- DELETE alone never stopped REPLACE).
CREATE TRIGGER IF NOT EXISTS trg_hq_project_events_no_rewrite
BEFORE UPDATE ON hq_project_events
BEGIN SELECT RAISE(ABORT, 'hq_project_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_project_events_no_erase
BEFORE DELETE ON hq_project_events
BEGIN SELECT RAISE(ABORT, 'hq_project_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_hq_project_events_no_replace
BEFORE INSERT ON hq_project_events
WHEN EXISTS (SELECT 1 FROM hq_project_events WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer'
      AND EXISTS (SELECT 1 FROM hq_project_events WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'hq_project_events is append-only'); END;
`;

function tableExists(db: HqDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

function columnExists(db: HqDatabase, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Idempotent; safe to call on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle: `hq:snapshot` legitimately builds
 * the service over `openHqDatabaseReadOnly`, and a pre-Phase-4 file must be
 * OBSERVED truthfully (`projectCommandSchemaPresent`), never migrated by a
 * path that promised to write nothing.
 */
export function ensureProjectCommandSchema(db: HqDatabase): void {
  if (db.readonly) return;
  if (!tableExists(db, 'hq_projects')) {
    // The foundation DDL creates this table on every migrated database; this
    // branch keeps the module self-sufficient over a bare handle without
    // editing store/db.ts. Same column set, deliberately.
    db.exec(`CREATE TABLE hq_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stream TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }
  for (const upgrade of PROJECT_COLUMN_UPGRADES) {
    if (!columnExists(db, 'hq_projects', upgrade.column)) db.exec(upgrade.ddl);
  }
  db.exec(PROJECT_EVENTS_DDL);
}

/**
 * Does this database carry the Phase 4 project schema? False only for a
 * read-only handle over a pre-Phase-4 file — a writable construction just
 * ensured it. Readers answer empty/null truthfully when this is false.
 */
export function projectCommandSchemaPresent(db: HqDatabase): boolean {
  return tableExists(db, 'hq_project_events');
}

// ---- records ----

/**
 * Server-derived authority truth for the project-command act itself — the
 * `MissionAuthorityTruth` shape and reasoning: not a `TaskClassification`
 * echo, unknown stated as null, never invented.
 */
export interface ProjectAuthorityTruth {
  riskClass: RiskClass | null;
  founderOnly: true;
  approvalFlow: 'originate_gated_no_approval_row';
}

export interface ProjectEventRecord {
  seq: number;
  id: string;
  projectId: string;
  at: string;
  actor: string;
  kind: 'created' | 'updated' | 'transitioned';
  fromStatus: ProjectStatus | null;
  toStatus: ProjectStatus | null;
  note: string | null;
}

/** One mission assigned to this project — derived at read time, never stored. */
export interface ProjectMissionRef {
  missionId: string;
  title: string;
  status: MissionStatus;
}

/**
 * Task counts across this project's missions' LINKED plan items — counts by
 * canonical `ActivityStatus` only, derived at read time. Deliberately never a
 * share, percentage or "progress" figure: a count states what is recorded, a
 * ratio would claim to know how much work the unrecorded remainder is.
 */
export interface ProjectTaskCount {
  status: ActivityStatus;
  count: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  purpose: string;
  /** Optional classification label ('' in storage = null here — decodeStream). */
  stream: string | null;
  status: ProjectStatus;
  /** null = pre-Phase-4 row whose creator was never recorded. */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  authority: ProjectAuthorityTruth;
  /** DERIVED: missions with `project_id` = this project. */
  missions: ProjectMissionRef[];
  /** DERIVED: linked-task counts by canonical status across those missions. */
  taskCounts: ProjectTaskCount[];
  history: ProjectEventRecord[];
}

/**
 * The browser-safe project projection, used by BOTH the control API and the
 * snapshot so there is exactly one implementation of "what does the browser
 * see of a project". Absent by shape: the internal `idempotencyKey` (dedupe
 * machinery — deliberately not even on `ProjectRecord`).
 */
export interface ProjectBrowserView {
  id: string;
  name: string;
  purpose: string;
  stream: string | null;
  status: ProjectStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  authority: ProjectAuthorityTruth;
  missions: ProjectMissionRef[];
  taskCounts: ProjectTaskCount[];
  history: ProjectEventRecord[];
}

export function projectBrowserView(project: ProjectRecord): ProjectBrowserView {
  return {
    id: project.id,
    name: project.name,
    purpose: project.purpose,
    stream: project.stream,
    status: project.status,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    statusChangedAt: project.statusChangedAt,
    statusChangedBy: project.statusChangedBy,
    authority: project.authority,
    missions: project.missions,
    taskCounts: project.taskCounts,
    history: project.history,
  };
}

// ---- idempotency ----

/**
 * Derived digest key. The caller's `idempotencyKey` is an INPUT to the
 * digest, never the key itself (the mission/direct-order lesson).
 */
export function projectCommandIdempotencyKey(input: {
  requestedBy: string;
  name: string;
  purpose: string;
  stream: string | null;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        requestedBy: input.requestedBy,
        name: input.name,
        purpose: input.purpose,
        stream: input.stream,
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest('hex');
  return `project:${digest.slice(0, 32)}`;
}

// ---- reads ----

export function readProjectEvents(db: HqDatabase, projectId: string): ProjectEventRecord[] {
  const rows = db
    .prepare(`SELECT * FROM hq_project_events WHERE project_id = ? ORDER BY seq`)
    .all(projectId) as Record<string, unknown>[];
  return rows.map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    projectId: r.project_id as string,
    at: r.at as string,
    actor: r.actor as string,
    kind: r.kind as ProjectEventRecord['kind'],
    fromStatus: (r.from_status as ProjectStatus | null) ?? null,
    toStatus: (r.to_status as ProjectStatus | null) ?? null,
    note: (r.note as string | null) ?? null,
  }));
}

export function readProjectRecord(
  db: HqDatabase,
  id: string,
  capabilityRow: Capability | null,
): ProjectRecord | null {
  const row = db.prepare(`SELECT * FROM hq_projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const missionRows = db
    .prepare(
      `SELECT id, title, status FROM hq_missions WHERE project_id = ? ORDER BY created_at, id`,
    )
    .all(id) as { id: string; title: string; status: string }[];

  // Linked tasks only: an unlinked plan item has no task and therefore no
  // status to count. Counts, never shares — see ProjectTaskCount.
  // DISTINCT canonical tasks: plan-item linkage is deliberately flexible
  // (nothing makes task_id unique across rows), so one real task linked to
  // two plan items must still count ONCE — the figure is "linked tasks",
  // not "linked rows" (Sol M2 on PR #263). Exact within each group because
  // a task has exactly one canonical status row.
  const countRows = db
    .prepare(
      `SELECT t.status AS status, COUNT(DISTINCT t.id) AS n
       FROM hq_mission_plan_items p
       JOIN hq_missions m ON m.id = p.mission_id
       JOIN op_tasks t ON t.id = p.task_id
       WHERE m.project_id = ? AND p.task_id IS NOT NULL
       GROUP BY t.status ORDER BY t.status`,
    )
    .all(id) as { status: string; n: number }[];

  // The adopted column predates the typed vocabulary. Module-only writes
  // guarantee every Phase 4 row is valid; a row with any other status could
  // only come from the deleted store path nothing in production ever called.
  // Refuse to present what cannot be truthfully typed — rewriting it to a
  // vocabulary member would forge a Founder decision (`listProjectIds`
  // filters the same way, so such a row never surfaces half-typed).
  const rawStatus = row.status as string;
  if (!isProjectStatus(rawStatus)) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    purpose: row.summary as string,
    stream: decodeStream(row.stream as string),
    status: rawStatus,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    statusChangedAt: (row.status_changed_at as string | null) ?? null,
    statusChangedBy: (row.status_changed_by as string | null) ?? null,
    authority: {
      riskClass: capabilityRow ? capabilityRow.riskClass : null,
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
    },
    missions: missionRows.map((m) => ({
      missionId: m.id,
      title: m.title,
      status: m.status as MissionStatus,
    })),
    taskCounts: countRows.map((c) => ({ status: c.status as ActivityStatus, count: c.n })),
    history: readProjectEvents(db, id),
  };
}

export function listProjectIds(db: HqDatabase, status?: ProjectStatus): string[] {
  // Fail closed: a supplied-but-unrecognized status filter matches NOTHING
  // (the listMissionIds lesson). The unfiltered list is bounded to the typed
  // vocabulary for the same reason readProjectRecord refuses an untypable
  // row: nothing production ever wrote outside it, and presenting such a row
  // would mean either lying about its status or crashing on it.
  if (status != null && !isProjectStatus(status)) return [];
  const rows = (
    status != null
      ? db.prepare(`SELECT id FROM hq_projects WHERE status = ? ORDER BY created_at, id`).all(status)
      : db
          .prepare(
            `SELECT id FROM hq_projects WHERE status IN ('active', 'closed') ORDER BY created_at, id`,
          )
          .all()
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

export function findProjectIdByIdempotencyKey(db: HqDatabase, key: string): string | null {
  const row = db.prepare(`SELECT id FROM hq_projects WHERE idempotency_key = ?`).get(key) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

// ---- writes (called by the service inside its transaction) ----

/** Append one project audit event. INSERT-only by design. */
export function appendProjectEvent(
  db: HqDatabase,
  input: {
    projectId: string;
    actor: string;
    kind: ProjectEventRecord['kind'];
    fromStatus?: ProjectStatus | null;
    toStatus?: ProjectStatus | null;
    note?: string | null;
    detail?: Record<string, unknown> | null;
  },
): void {
  db.prepare(
    `INSERT INTO hq_project_events (id, project_id, at, actor, kind, from_status, to_status, note, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    input.projectId,
    nowIso(),
    input.actor,
    input.kind,
    input.fromStatus ?? null,
    input.toStatus ?? null,
    input.note ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
  );
}
