/**
 * Company memory store (issue #120, HQ special lane D).
 *
 * Owns its own DDL (hq_memory), applied idempotently via
 * ensureMemoryTables() — this module does NOT touch store/db.ts's DDL.
 *
 * Immutability rule (mirrors JENIFY-OS CLAUDE.md rule 5 for posted
 * transactions): superseded/rejected memory is never deleted or edited in
 * place. record() only ever INSERTs a new row and, when superseding,
 * flips the predecessor's `status` column (CURRENT -> SUPERSEDED) and
 * appends to its `superseded_by` list — both in the same transaction.
 *
 * Searchability: memory records are made searchable through the EXISTING
 * archive/search.ts engine via the asArchiveRecord()/searchMemory()
 * projection below — this module does not implement a second index.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { NewActivityEvent } from '../contracts/events.js';
import { assertNoSecretLikeContent } from '../operator/evidence.js';
import type { ArchiveRecord, DateConfidence } from '../archive/schema.js';
import { buildIndex, search, type SearchHit, type SearchQuery } from '../archive/search.js';
import { type MemoryKind, type MemoryPrivacy, type MemoryRecord, validateMemoryRecord } from './schema.js';

const DDL = `
CREATE TABLE IF NOT EXISTS hq_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  recorded_date TEXT NOT NULL,
  recorded_confidence TEXT NOT NULL,
  recorded_source TEXT,
  recorded_by TEXT NOT NULL,
  project TEXT NOT NULL,
  related TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  tags TEXT NOT NULL,
  supersedes TEXT,
  superseded_by TEXT NOT NULL DEFAULT '[]',
  privacy TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_memory_project_kind ON hq_memory(project, kind);
CREATE INDEX IF NOT EXISTS idx_hq_memory_status ON hq_memory(status);
`;

/**
 * Phase 5 additive columns (issue #265): canonical entity references, the
 * derivation list for summaries, and the facade-derived idempotency key.
 * Applied via PRAGMA table_info so an already-upgraded file is untouched —
 * the project-command.ts column-upgrade pattern.
 */
const COLUMN_UPGRADES: readonly { column: string; ddl: string }[] = [
  { column: 'mission_id', ddl: `ALTER TABLE hq_memory ADD COLUMN mission_id TEXT` },
  { column: 'project_id', ddl: `ALTER TABLE hq_memory ADD COLUMN project_id TEXT` },
  { column: 'task_id', ddl: `ALTER TABLE hq_memory ADD COLUMN task_id TEXT` },
  { column: 'derived_from', ddl: `ALTER TABLE hq_memory ADD COLUMN derived_from TEXT NOT NULL DEFAULT '[]'` },
  { column: 'idempotency_key', ddl: `ALTER TABLE hq_memory ADD COLUMN idempotency_key TEXT` },
];

/**
 * Phase 5 engine hardening (issue #265) — the §G lesson applied to memory.
 *
 * hq_memory is insert-only BY ENGINE with exactly one legitimate mutation:
 * the supersede UPDATE in record(), which touches only status /
 * superseded_by / updated_at. So:
 *  - DELETE always aborts;
 *  - an UPDATE naming any OTHER column in its SET clause aborts
 *    (trg_hq_memory_no_rewrite — SQLite's UPDATE OF fires on SET-clause
 *    membership, which is exactly the "outside the supersede path" claim);
 *  - the one legal status move is CURRENT -> SUPERSEDED, held by the engine
 *    for every writer, not just this module;
 *  - BEFORE INSERT guards close the REPLACE / INSERT OR REPLACE / UPSERT
 *    path that skips BEFORE DELETE triggers while recursive_triggers is off
 *    (the Phase 4 §G finding — that pragma is connection-scoped and cannot
 *    bind a foreign writer) on EVERY conflict target of this table: the `id`
 *    primary key (trg_hq_memory_no_replace), the `idx_hq_memory_idem` unique
 *    index (trg_hq_memory_no_replace_idem, review round 1) and — because the
 *    primary key is TEXT, so the table keeps a separate implicit rowid — the
 *    rowid itself (trg_hq_memory_no_replace_rowid, review round 2). Until
 *    round 2 the id guard alone was described as closing the path; it did
 *    not: a REPLACE naming an existing rowid deleted the standing row with
 *    no BEFORE DELETE firing.
 *
 * Documented residual: superseded_by and updated_at stay engine-mutable
 * because the legitimate supersede rides one UPDATE. The immutable forward
 * pointer (`supersedes` on the successor) plus history()'s backward walk keep
 * every chain reconstructable even if a hostile writer corrupted a
 * superseded_by list.
 */
const HARDENING_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_memory_idem ON hq_memory(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hq_memory_mission ON hq_memory(mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hq_memory_project_ref ON hq_memory(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hq_memory_task ON hq_memory(task_id) WHERE task_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_hq_memory_no_erase
BEFORE DELETE ON hq_memory
BEGIN SELECT RAISE(ABORT, 'hq_memory is insert-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_memory_no_rewrite
BEFORE UPDATE OF id, kind, title, body, recorded_date, recorded_confidence, recorded_source,
  recorded_by, project, related, source_refs, tags, supersedes, privacy, created_at,
  mission_id, project_id, task_id, derived_from, idempotency_key
ON hq_memory
BEGIN SELECT RAISE(ABORT, 'hq_memory rows are immutable outside the supersede path'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_memory_supersede_only
BEFORE UPDATE OF status ON hq_memory
WHEN NOT (OLD.status = 'CURRENT' AND NEW.status = 'SUPERSEDED')
BEGIN SELECT RAISE(ABORT, 'hq_memory status may only move CURRENT -> SUPERSEDED'); END;

CREATE TRIGGER IF NOT EXISTS trg_hq_memory_no_replace
BEFORE INSERT ON hq_memory
WHEN EXISTS (SELECT 1 FROM hq_memory WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'hq_memory is insert-only'); END;

-- Phase 7/8 correction, carried back as pure hardening: the guard above
-- tests only the id, but idx_hq_memory_idem is a second unique index, and a
-- REPLACE colliding on it deletes the standing row with no BEFORE DELETE
-- firing (recursive_triggers off / connection-scoped). Additive trigger, new
-- name, so an existing file gains it on the next ensure; the legitimate
-- writer dedupes by key BEFORE inserting (findIdByIdempotencyKey), so no
-- accepted path ever reaches this guard.
CREATE TRIGGER IF NOT EXISTS trg_hq_memory_no_replace_idem
BEFORE INSERT ON hq_memory
WHEN NEW.idempotency_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM hq_memory WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'hq_memory is insert-only (unique idempotency_key already held)'); END;

-- Review round 2: hq_memory's primary key is TEXT, so the table has a
-- separate implicit rowid — a third conflict target neither guard above
-- tests. A REPLACE naming an existing rowid deleted a founder_only row and
-- landed a forged internal one in its place with recursive_triggers OFF.
-- In a BEFORE INSERT trigger an auto-assigned rowid reads as -1, so the
-- legitimate writer (which never names a rowid) never matches an existing
-- row; only an explicit rowid collision aborts. Additive, new name.
CREATE TRIGGER IF NOT EXISTS trg_hq_memory_no_replace_rowid
BEFORE INSERT ON hq_memory
WHEN TYPEOF(NEW.rowid) = 'integer'
  AND EXISTS (SELECT 1 FROM hq_memory WHERE rowid = NEW.rowid)
BEGIN SELECT RAISE(ABORT, 'hq_memory is insert-only (rowid already held)'); END;
`;

/**
 * Idempotent — safe to call on every MemoryStore construction.
 *
 * Readonly-safe since Phase 5: a read-only handle (hq:snapshot over an old
 * file) observes the schema truthfully via memorySchemaPresent() instead of
 * attempting DDL — the post-Phase-3 ensure*Schema pattern.
 */
export function ensureMemoryTables(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(DDL);
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(hq_memory)`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const upgrade of COLUMN_UPGRADES) {
    if (!existing.has(upgrade.column)) db.exec(upgrade.ddl);
  }
  db.exec(HARDENING_DDL);
}

/** True when the hq_memory table exists in this file — observation, never migration. */
export function memorySchemaPresent(db: HqDatabase): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_memory'`)
    .get() as { name: string } | undefined;
  return row !== undefined;
}

export type MemoryRecordInput = Omit<
  MemoryRecord,
  'id' | 'supersededBy' | 'related' | 'sourceRefs' | 'tags' | 'privacy' | 'missionId' | 'projectId' | 'taskId' | 'derivedFrom'
> & {
  id?: string;
  related?: MemoryRecord['related'];
  sourceRefs?: string[];
  tags?: string[];
  privacy?: MemoryPrivacy;
  /** Canonical entity refs — existence is the FACADE's job; the store only persists. */
  missionId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  derivedFrom?: string[];
  /** Facade-derived dedupe key; a unique partial index refuses a raced duplicate. */
  idempotencyKey?: string | null;
};

function rowToMemory(r: Record<string, unknown>): MemoryRecord {
  return {
    id: r.id as string,
    kind: r.kind as MemoryKind,
    title: r.title as string,
    body: r.body as string,
    status: r.status as MemoryRecord['status'],
    recorded: {
      date: r.recorded_date as string,
      confidence: r.recorded_confidence as DateConfidence,
      source: (r.recorded_source as string | null) ?? undefined,
    },
    recordedBy: r.recorded_by as string,
    project: r.project as string,
    related: JSON.parse(r.related as string),
    sourceRefs: JSON.parse(r.source_refs as string),
    tags: JSON.parse(r.tags as string),
    supersedes: (r.supersedes as string | null) ?? null,
    supersededBy: JSON.parse((r.superseded_by as string | null) ?? '[]'),
    privacy: r.privacy as MemoryPrivacy,
    missionId: (r.mission_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    derivedFrom: JSON.parse((r.derived_from as string | null) ?? '[]'),
  };
}

export class MemoryStore {
  constructor(
    private db: HqDatabase,
    /** Optional audit hook — when provided, supersede/record events are also appended to hq_events (subjectKind 'system'). */
    private onEvent?: (e: NewActivityEvent) => void,
  ) {
    ensureMemoryTables(db);
  }

  /**
   * Records a new memory entry. Never mutates an existing row except the
   * one supersede-linked side effect documented below.
   *
   * - Rejects secret-like content in title/body/refs (issue #120: "no
   *   copying secrets into memory") via operator/evidence.ts's existing
   *   assertNoSecretLikeContent — this module does not implement its own
   *   secret detector.
   * - Duplicate guard: recording a second CURRENT record with the same
   *   kind+project+title (without going through `supersedes`) throws,
   *   forcing an explicit supersede instead of a silent duplicate.
   * - supersede: the predecessor must exist and be CURRENT; its status
   *   flips to SUPERSEDED and its supersededBy list gains this record's id,
   *   atomically with the insert (single db.transaction).
   */
  record(input: MemoryRecordInput): MemoryRecord {
    assertNoSecretLikeContent({
      title: input.title,
      body: input.body,
      sourceRefs: input.sourceRefs ?? [],
      related: input.related ?? {},
    });

    const id = input.id ?? uuid();
    const candidate: MemoryRecord = {
      id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      status: input.status,
      recorded: input.recorded,
      recordedBy: input.recordedBy,
      project: input.project,
      related: input.related ?? {},
      sourceRefs: input.sourceRefs ?? [],
      tags: input.tags ?? [],
      supersedes: input.supersedes ?? null,
      supersededBy: [],
      privacy: input.privacy ?? 'internal',
      missionId: input.missionId ?? null,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      derivedFrom: input.derivedFrom ?? [],
    };
    const errors = validateMemoryRecord(candidate);
    if (errors.length > 0) {
      throw new Error(`Invalid memory record: ${errors.join('; ')}`);
    }
    if (this.get(id)) {
      throw new Error(`Memory record ${id} already exists`);
    }

    // Every derivation source must be a real memory record (defense in depth
    // beside the facade's checks — a summary naming a phantom source would be
    // an invented provenance chain).
    for (const sourceId of candidate.derivedFrom ?? []) {
      if (!this.get(sourceId)) {
        throw new Error(`Cannot derive from unknown memory record: ${sourceId}`);
      }
    }

    let predecessor: MemoryRecord | null = null;
    if (candidate.supersedes) {
      predecessor = this.get(candidate.supersedes);
      if (!predecessor) {
        throw new Error(`Cannot supersede unknown memory record: ${candidate.supersedes}`);
      }
      if (predecessor.status !== 'CURRENT') {
        throw new Error(
          `Cannot supersede memory record ${predecessor.id}: it is ${predecessor.status}, not CURRENT`,
        );
      }
    } else if (candidate.status === 'CURRENT') {
      const dup = this.db
        .prepare(
          `SELECT id FROM hq_memory WHERE kind = ? AND project = ? AND title = ? AND status = 'CURRENT'`,
        )
        .get(candidate.kind, candidate.project, candidate.title) as { id: string } | undefined;
      if (dup) {
        throw new Error(
          `An identical CURRENT ${candidate.kind} memory already exists for ${candidate.project}/"${candidate.title}" ` +
            `(id: ${dup.id}). Supersede it explicitly via \`supersedes\` instead of recording a duplicate (issue #120).`,
        );
      }
    }

    const at = nowIso();
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO hq_memory (id, kind, title, body, status, recorded_date, recorded_confidence,
             recorded_source, recorded_by, project, related, source_refs, tags, supersedes, superseded_by,
             privacy, created_at, updated_at, mission_id, project_id, task_id, derived_from, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.id,
          candidate.kind,
          candidate.title,
          candidate.body,
          candidate.status,
          candidate.recorded.date,
          candidate.recorded.confidence,
          candidate.recorded.source ?? null,
          candidate.recordedBy,
          candidate.project,
          JSON.stringify(candidate.related),
          JSON.stringify(candidate.sourceRefs),
          JSON.stringify(candidate.tags),
          candidate.supersedes,
          JSON.stringify([]),
          candidate.privacy,
          at,
          at,
          candidate.missionId,
          candidate.projectId,
          candidate.taskId,
          JSON.stringify(candidate.derivedFrom ?? []),
          input.idempotencyKey ?? null,
        );

      if (predecessor) {
        const nextSupersededBy = [...(predecessor.supersededBy ?? []), candidate.id];
        this.db
          .prepare(`UPDATE hq_memory SET status = 'SUPERSEDED', superseded_by = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(nextSupersededBy), at, predecessor.id);
      }
    });
    insert();

    if (predecessor) {
      this.onEvent?.({
        subjectKind: 'system',
        subjectId: `memory:${predecessor.id}`,
        status: null,
        actor: candidate.recordedBy,
        summary: `Memory ${predecessor.id} superseded by ${candidate.id} (issue #120)`,
        detail: { supersededBy: candidate.id, kind: candidate.kind, project: candidate.project },
      });
    }
    this.onEvent?.({
      subjectKind: 'system',
      subjectId: `memory:${candidate.id}`,
      status: null,
      actor: candidate.recordedBy,
      summary: `Memory recorded: ${candidate.kind} "${candidate.title}" (${candidate.project})`,
      detail: { kind: candidate.kind, project: candidate.project, supersedes: candidate.supersedes ?? null },
    });

    return this.get(id)!;
  }

  get(id: string): MemoryRecord | null {
    const row = this.db.prepare(`SELECT * FROM hq_memory WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToMemory(row) : null;
  }

  listByProject(project: string): MemoryRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_memory WHERE project = ? ORDER BY recorded_date, id`)
      .all(project) as Record<string, unknown>[];
    return rows.map(rowToMemory);
  }

  listCurrent(kind?: MemoryKind): MemoryRecord[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT * FROM hq_memory WHERE status = 'CURRENT' AND kind = ? ORDER BY recorded_date, id`).all(kind)
        : this.db.prepare(`SELECT * FROM hq_memory WHERE status = 'CURRENT' ORDER BY recorded_date, id`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToMemory);
  }

  /** Every record, for feeding into searchMemory() or a handover package. */
  listAll(): MemoryRecord[] {
    const rows = this.db.prepare(`SELECT * FROM hq_memory ORDER BY recorded_date, id`).all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToMemory);
  }

  /** The record previously written with this facade-derived dedupe key, if any. */
  findIdByIdempotencyKey(key: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM hq_memory WHERE idempotency_key = ?`)
      .get(key) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Entity-scoped reads (Phase 5 retrieval): CURRENT records first, then
   * newest recorded first — the deterministic relevance order the context
   * assembler documents. Indexed; no text matching here.
   */
  listByMissionId(missionId: string): MemoryRecord[] {
    return this.#listByEntity('mission_id', missionId);
  }

  listByProjectRef(projectId: string): MemoryRecord[] {
    return this.#listByEntity('project_id', projectId);
  }

  listByTaskId(taskId: string): MemoryRecord[] {
    return this.#listByEntity('task_id', taskId);
  }

  #listByEntity(column: 'mission_id' | 'project_id' | 'task_id', value: string): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hq_memory WHERE ${column} = ?
         ORDER BY CASE WHEN status = 'CURRENT' THEN 0 ELSE 1 END, recorded_date DESC, id`,
      )
      .all(value) as Record<string, unknown>[];
    return rows.map(rowToMemory);
  }

  /**
   * Follows the supersedes chain both directions from `id`: walks backward
   * to the earliest predecessor, then forward via supersededBy (tolerating
   * branches) collecting every reachable record, oldest first.
   */
  history(id: string): MemoryRecord[] {
    const start = this.get(id);
    if (!start) throw new Error(`Unknown memory record: ${id}`);

    let root = start;
    const backward = new Set<string>([root.id]);
    while (root.supersedes && !backward.has(root.supersedes)) {
      const prev = this.get(root.supersedes);
      if (!prev) break;
      backward.add(prev.id);
      root = prev;
    }

    const chain: MemoryRecord[] = [];
    const enqueued = new Set<string>([root.id]);
    const queue: MemoryRecord[] = [root];
    while (queue.length > 0) {
      const rec = queue.shift()!;
      chain.push(rec);
      for (const nextId of rec.supersededBy ?? []) {
        if (enqueued.has(nextId)) continue;
        const next = this.get(nextId);
        if (!next) continue;
        enqueued.add(nextId);
        queue.push(next);
      }
    }
    return chain.sort((a, b) => a.recorded.date.localeCompare(b.recorded.date) || a.id.localeCompare(b.id));
  }
}

/**
 * Projects a MemoryRecord into the existing ArchiveRecord shape so
 * buildIndex()/search() from archive/search.ts work unchanged over memory,
 * with no second index implementation.
 *
 * `version` deliberately does not walk the supersedes chain (this is a pure,
 * db-free projection): it uses a lightweight CURRENT/SUPERSEDED marker
 * rather than a true chain depth. Callers that need exact revision depth
 * should use MemoryStore.history(id).length instead.
 */
export function asArchiveRecord(memory: MemoryRecord): ArchiveRecord {
  return {
    id: `memory-${memory.id}`,
    title: memory.title,
    project: memory.project,
    category: memory.kind,
    created: memory.recorded,
    evidence: memory.recorded,
    version: memory.supersedes ? 'revision' : 'v1',
    status: memory.status,
    predecessorId: memory.supersedes ?? null,
    successorIds: memory.supersededBy ?? [],
    related: memory.related,
    sourceRef: memory.sourceRefs[0] ?? `hq://memory/${memory.id}`,
    summary: memory.body,
    tags: memory.tags,
  };
}

/** Thin wrapper: projects the given records, then delegates to the existing archive search engine. */
export function searchMemory(records: MemoryRecord[], query: SearchQuery): SearchHit[] {
  const index = buildIndex(records.map(asArchiveRecord));
  return search(index, query);
}
