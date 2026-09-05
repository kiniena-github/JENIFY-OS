/**
 * Headquarter storage. Deliberately a SEPARATE SQLite database from the
 * FactoryOS tenant database — Headquarter must never touch
 * data/factoryos.sqlite (Founder data is sacred, CLAUDE.md rule 8).
 *
 * Plain better-sqlite3 with explicit DDL for the foundation wave; a move to
 * drizzle migrations is a follow-up decision recorded in the architecture
 * doc.
 */

import Database from 'better-sqlite3';

export type HqDatabase = Database.Database;

export const DEFAULT_HQ_DB_PATH = 'data/headquarter.sqlite';

const DDL = `
CREATE TABLE IF NOT EXISTS hq_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  refs TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_events_subject ON hq_events(subject_kind, subject_id, seq);

CREATE TABLE IF NOT EXISTS op_capabilities (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  side_effect INTEGER NOT NULL,
  idempotent INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS op_tasks (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES op_capabilities(id),
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  fence INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_expires_at TEXT,
  claim_nonce TEXT,
  approval_id TEXT,
  review_state TEXT NOT NULL DEFAULT 'none',
  submitted_by TEXT,
  submitted_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  result TEXT,
  block_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_op_tasks_idem
  ON op_tasks(capability_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_op_tasks_status ON op_tasks(status);

-- Which provider a worker id genuinely executes as (issue #200, Codex P1 #1).
-- Deliberately EXPLICIT and empty by default: nothing infers a worker's
-- provider from a vendor string, a display name or a registry descriptor, and
-- a worker with no row here can never claim a provider-bound task.
CREATE TABLE IF NOT EXISTS op_worker_providers (
  worker_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS op_evidence (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  task_id TEXT,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS op_kill_switch (
  scope TEXT PRIMARY KEY,
  engaged INTEGER NOT NULL,
  reason TEXT,
  engaged_by TEXT,
  engaged_at TEXT
);

CREATE TABLE IF NOT EXISTS hq_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stream TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hq_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  project_id TEXT,
  ask TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  action_digest TEXT,
  expires_at TEXT,
  consumed_at TEXT,
  consumed_by TEXT,
  consumed_task_id TEXT,
  consumed_fence INTEGER,
  consumed_claim_nonce TEXT
);

CREATE TABLE IF NOT EXISTS hq_chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_chat_thread ON hq_chat_messages(thread_id, at);

CREATE TABLE IF NOT EXISTS hq_specialists (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  role TEXT NOT NULL,
  allowed_capabilities TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hq_archive_refs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  locator TEXT NOT NULL,
  project_id TEXT,
  added_at TEXT NOT NULL
);

-- Founder Command + Mission Core (Phase 3, issue #254).
--
-- A MISSION is the durable record of one Founder order: what was asked, what
-- must not be violated, what it was decomposed into, and where it stands. It
-- is NOT a second task queue. Every unit of work a mission carries is an
-- ordinary canonical row in op_tasks, created through the same Founder-gated
-- direct-order path as any other order, and hq_mission_tasks only LINKS a
-- mission to those rows — it duplicates no task state, so the truth about a
-- task can only ever be read from op_tasks. Nothing in these four tables is
-- authority: they grant no capability, approve no action and change no task
-- status; the Operator never reads them.
CREATE TABLE IF NOT EXISTS hq_missions (
  id TEXT PRIMARY KEY,
  -- Derived by the mission module from everything that makes an order THE
  -- SAME ORDER, exactly as op_tasks.idempotency_key is for a direct order. A
  -- caller-supplied key is mixed in, never used verbatim.
  idempotency_key TEXT NOT NULL UNIQUE,
  -- The ONE Founder-typed field that is published to the browser. Bounded and
  -- browser-safety-scanned before the write; the order text itself lives only
  -- in hq_mission_intent.
  title TEXT NOT NULL,
  project TEXT,
  state TEXT NOT NULL,
  -- Why the mission is blocked, when it is. A reason CODE for a block the
  -- mission core itself imposed (needs_clarification), or a Founder-typed
  -- reason for an explicit transition — bounded and scanned like a denial.
  block_reason TEXT,
  requested_by TEXT NOT NULL,
  actor_authentication TEXT NOT NULL,
  requested_route TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_missions_state ON hq_missions(state, created_at);

CREATE TABLE IF NOT EXISTS hq_mission_tasks (
  mission_id TEXT NOT NULL REFERENCES hq_missions(id),
  task_id TEXT NOT NULL REFERENCES op_tasks(id),
  -- 1-based position in the task plan. Presentation order only.
  ordinal INTEGER NOT NULL,
  -- The intent record whose plan created this task, so a plan can be traced
  -- to the exact (original or amended) wording that produced it.
  intent_id TEXT NOT NULL,
  PRIMARY KEY (mission_id, task_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hq_mission_tasks_ordinal
  ON hq_mission_tasks(mission_id, ordinal);

-- The Intent Lock. APPEND-ONLY BY CONSTRUCTION: the mission module only ever
-- INSERTs here, every row is hash-chained to the one before it within its
-- mission, and there is no UPDATE or DELETE statement against this table
-- anywhere in the codebase (test/mission-intent.test.ts scans for one). The
-- first row of a mission is the original order; every later row is an
-- amendment carrying its own actor, timestamp and reason. The original is
-- never mutated — an amendment is a new fact beside it, not a correction of it.
CREATE TABLE IF NOT EXISTS hq_mission_intent (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES hq_missions(id),
  kind TEXT NOT NULL,
  -- The Founder's words, verbatim. SERVER-SIDE ONLY, exactly like a direct
  -- order's instruction: no projection publishes this column.
  command TEXT NOT NULL,
  objective TEXT NOT NULL,
  constraints TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  unknowns TEXT NOT NULL,
  needs_clarification INTEGER NOT NULL,
  step_count INTEGER NOT NULL,
  actor TEXT NOT NULL,
  actor_authentication TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_mission_intent_mission ON hq_mission_intent(mission_id, seq);

-- Every explicit mission state change, in order, with who made it and why.
-- Append-only like the intent log; the mission row's state column is the
-- CURRENT value and this table is its history.
CREATE TABLE IF NOT EXISTS hq_mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES hq_missions(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_mission_events_mission ON hq_mission_events(mission_id, seq);
`;

/**
 * Columns added after the first foundation commit (issue #53 corrections).
 * CREATE TABLE IF NOT EXISTS does not extend an existing table, so a database
 * file created from the earlier DDL gets them via idempotent ALTERs here.
 */
const COLUMN_UPGRADES: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'op_tasks', column: 'review_state', ddl: `TEXT NOT NULL DEFAULT 'none'` },
  { table: 'op_tasks', column: 'submitted_by', ddl: 'TEXT' },
  { table: 'op_tasks', column: 'submitted_at', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'decided_by', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'action_digest', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'expires_at', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'consumed_at', ddl: 'TEXT' },
  // Issue #77: approval consumption binds to the legitimate claim.
  { table: 'op_tasks', column: 'claim_nonce', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'consumed_by', ddl: 'TEXT' },
  { table: 'hq_approvals', column: 'consumed_fence', ddl: 'INTEGER' },
  { table: 'hq_approvals', column: 'consumed_claim_nonce', ddl: 'TEXT' },
  // Issue #79: the consumption record also pins the exact task, so a consumed
  // approval cannot ride another task even behind a forged action digest.
  { table: 'hq_approvals', column: 'consumed_task_id', ddl: 'TEXT' },
];

function ensureColumns(db: HqDatabase): void {
  for (const up of COLUMN_UPGRADES) {
    const cols = db.prepare(`PRAGMA table_info(${up.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === up.column)) {
      db.exec(`ALTER TABLE ${up.table} ADD COLUMN ${up.column} ${up.ddl}`);
    }
  }
}

/**
 * Connect to the Headquarter database WITHOUT creating or upgrading schema.
 *
 * `openHqDatabase` below is the ordinary migrating open and stays the default
 * for every caller that just wants a usable store. Hosted durable-volume mode
 * cannot use it as-is: the DDL and column upgrades are real write transactions,
 * and running them inside the open commits them under whatever `synchronous`
 * setting the SQLite build happens to default to — before the durable-volume
 * owner has set and *verified* WAL + `synchronous=FULL`. The current build
 * defaults to FULL, so this is a latent ordering dependency rather than a live
 * data-loss bug, but a module whose whole job is proving durability must not
 * rest on an unverified compile-time default: a build with a different
 * `SQLITE_DEFAULT_SYNCHRONOUS` would silently commit first-boot schema and
 * migrations at NORMAL and only afterwards report FULL as active.
 *
 * Splitting the open lets the durable owner order it correctly: connect,
 * establish and verify the durability modes, prove the opened inode, and only
 * then migrate. See `openHqPersistence` in `@factoryos/hq-host`.
 */
export function connectHqDatabaseUnmigrated(path: string = DEFAULT_HQ_DB_PATH): HqDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Durability must be active before first-boot DDL or any column migration.
  // Hosted Stage 3 verifies this effective setting again after the migrating
  // open, but setting FULL here closes the initialization crash window itself.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Apply the schema and column upgrades to an already-connected database.
 *
 * Idempotent: the DDL is `CREATE TABLE IF NOT EXISTS` throughout and
 * `ensureColumns` adds only genuinely missing columns, so a migrating open and
 * an explicit later migration produce the same schema.
 */
export function migrateHqDatabase(db: HqDatabase): HqDatabase {
  db.exec(DDL);
  ensureColumns(db);
  return db;
}

export function openHqDatabase(path: string = DEFAULT_HQ_DB_PATH): HqDatabase {
  return migrateHqDatabase(connectHqDatabaseUnmigrated(path));
}

/**
 * Open the Headquarter database for READING ONLY (issue #200, Codex finding
 * on the snapshot tool).
 *
 * `openHqDatabase` is a migrating open: it creates the file if it is missing,
 * switches the journal to WAL, runs the full DDL and adds any missing columns.
 * That is right for a process that owns the store, and wrong for one that only
 * projects it — the snapshot CLI described itself as read-only while every run
 * altered the Founder's schema, and pointing it at a typo'd path silently
 * created an empty database and then reported it as LIVE HQ state.
 *
 * This open takes nothing on itself: SQLite refuses writes at the connection,
 * so the guarantee is enforced by the engine rather than by the caller's good
 * intentions, and a missing file is an error instead of a new empty database.
 * Schema migration stays exclusively with the process that owns the store, so a
 * database this connection cannot read is reported, never repaired.
 */
export function openHqDatabaseReadOnly(path: string = DEFAULT_HQ_DB_PATH): HqDatabase {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  // A connection-scoped read setting; it writes nothing to the file.
  db.pragma('foreign_keys = ON');
  return db;
}

/** In-memory database for tests. */
export function openMemoryHqDatabase(): HqDatabase {
  return openHqDatabase(':memory:');
}

export function nowIso(): string {
  return new Date().toISOString();
}
