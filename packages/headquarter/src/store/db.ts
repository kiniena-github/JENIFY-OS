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
      execSchemaDdl(db, `ALTER TABLE ${up.table} ADD COLUMN ${up.column} ${up.ddl}`);
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
  // Belt to the triggers' braces: with recursive triggers on, a REPLACE that
  // resolves a unique-index conflict by deleting the standing row also fires
  // that table's BEFORE DELETE guard on THIS connection. It is connection-
  // scoped and writes nothing to the file, so it binds no foreign writer —
  // the engine-held guarantee stays the BEFORE INSERT guards on every unique
  // index of each append-only table. No trigger in the schema writes, so
  // nothing recurses; no source path spells REPLACE INTO / INSERT OR REPLACE
  // (the src-wide spelling guards), and UPSERT is unaffected by this setting.
  db.pragma('recursive_triggers = ON');
  return db;
}

/**
 * The table names a handle carried BEFORE `migrateHqDatabase` ran on it.
 *
 * Keyed by the handle, so it cannot be reached, replayed or forged through any
 * exported surface, and it disappears with the connection.
 */
const TABLES_BEFORE_MIGRATION = new WeakMap<HqDatabase, ReadonlySet<string>>();

/**
 * HQ's own `user_version` stamp, and the CLOSED set of values that mean "HQ
 * ensured this file".
 *
 * It lives HERE rather than in `integrity.ts` because BOTH readings of the mark
 * have to be the same reading (Wave 5 correction round six, Low 7).
 * `migrateHqDatabase` recorded "any non-zero value" while
 * `hqSchemaEnsuredMarkPresent` read the closed set, so a foreign application's
 * `user_version = 7` made `schemaEnsuredMarkBeforeMigration` TRUE and
 * `hqSchemaEnsuredMarkPresent` FALSE — two spellings of "HQ has been here" that
 * disagreed. The outer `established` gate absorbed it, so it was not
 * exploitable at that head; it was one refactor from being so, and a mark with
 * two meanings is not a mark. `integrity.ts` imports these rather than
 * declaring its own.
 *
 * `0x48510001` is HQ's own: `0x4851` is "HQ" in ASCII, the low half is the
 * schema generation. A later build that raises the generation adds the new
 * value to the set beside the old one — a deliberate reviewed act, never an
 * arithmetic comparison that would quietly accept a foreign stamp again.
 *
 * The cost, stated: a file stamped by an EARLIER build of this wave carries
 * `user_version = 1`, which is not a member, so such a file reads as unmarked.
 * The ledger half of the discriminator still answers for it, and the first
 * writable construction re-stamps it.
 */
export const HQ_SCHEMA_ENSURED_MARK = 0x48510001;
export const HQ_SCHEMA_ENSURED_MARKS: readonly number[] = Object.freeze([HQ_SCHEMA_ENSURED_MARK]);

/** True when `value` is a `user_version` HQ itself stamped. One spelling, two readers. */
export function isHqSchemaEnsuredMark(value: number): boolean {
  return Number.isInteger(value) && HQ_SCHEMA_ENSURED_MARKS.includes(value);
}

/**
 * The same, for HQ's own schema-ensured mark in `PRAGMA user_version`. Same
 * WeakMap discipline, same reason, same instant — see
 * `schemaEnsuredMarkBeforeMigration`.
 */
const MARK_BEFORE_MIGRATION = new WeakMap<HqDatabase, boolean>();

/**
 * What this handle's file carried before HQ's own migration touched it, or null
 * when this handle has not been migrated in this process.
 *
 * **This exists because of a boot-ORDER hole, and the hole was in the one
 * ledger that matters most** (Wave 5 correction round four, High H1).
 * `op_evidence` — the hash-chained audit log — is created by
 * `migrateHqDatabase`, which runs BEFORE the facade constructor takes its
 * boot-time immutability census. So the census, which correctly reports a
 * DROPPED ledger for the other declared tables, could never see `op_evidence`
 * absent: by the time it looked, the migration had already re-created it,
 * empty. Executed: raw-view `absentImmutableTables` returned
 * `["op_evidence"]`, and after `openHqDatabase()` it returned `[]`.
 *
 * The consequence was categorical. `DROP TABLE op_evidence` read clean at BOTH
 * depths — `safeMode: false`, `observations: []`, `chainVerified: true` — over
 * an audit log that had been destroyed and rebuilt empty, and the same act
 * CLEARED an already-latched safe mode and re-admitted `releaseKillSwitch`.
 *
 * Observing here is the ordering fix: the fact is captured at the only instant
 * it is still true. The census reads it through
 * `observeImmutabilityAsFound`. A handle opened read-only, or connected without
 * migrating, records nothing and the census falls back to reading the file as
 * it stands — which is correct, because nothing has re-created anything on it.
 */
export function tableNamesBeforeMigration(db: HqDatabase): ReadonlySet<string> | null {
  return TABLES_BEFORE_MIGRATION.get(db) ?? null;
}

/**
 * The same WeakMap discipline for HQ's own schema-ensured MARK: what
 * `PRAGMA user_version` said before this handle's migration ran.
 *
 * Added by the Wave 5 round-four RECONCILIATION, because the two lanes' fixes
 * only compose with it. One lane made the first-boot discriminator read the
 * mark as well as the ledger catalogue, so that dropping EVERY declared ledger
 * no longer reads as a fresh file. The other made `op_evidence`'s absence a
 * question asked of the PRE-migration catalogue, because the migration
 * re-creates that one table before the census looks. Put together without this,
 * the widest attack — drop every declared ledger — reports all the others and stays
 * silent about the audit log itself, which is the one it destroyed.
 *
 * The mark has to be read at the same instant as the catalogue, and for exactly
 * the same reason: the facade STAMPS it at the end of its construction, so a
 * second facade over the same handle would otherwise see a mark this process
 * had just written and read a genuine first boot as an established file with
 * `op_evidence` lost. Recorded here, that cannot happen — this is what the file
 * said before HQ touched it.
 *
 * Null when this handle has not been migrated in this process, on the same
 * fail-safe reading as `tableNamesBeforeMigration`: "I could not look" is not
 * "nothing was there".
 */
export function schemaEnsuredMarkBeforeMigration(db: HqDatabase): boolean | null {
  return MARK_BEFORE_MIGRATION.get(db) ?? null;
}

/**
 * Apply the schema and column upgrades to an already-connected database.
 *
 * Idempotent: the DDL is `CREATE TABLE IF NOT EXISTS` throughout and
 * `ensureColumns` adds only genuinely missing columns, so a migrating open and
 * an explicit later migration produce the same schema.
 *
 * The pre-migration table census is taken FIRST and recorded against the
 * handle — see `tableNamesBeforeMigration` for why that ordering is
 * load-bearing. It is a read of `sqlite_master`, so it costs one statement and
 * changes nothing.
 */
export function migrateHqDatabase(db: HqDatabase): HqDatabase {
  try {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    TABLES_BEFORE_MIGRATION.set(db, new Set(rows.map((row) => row.name)));
    // HQ's own schema-ensured mark, read at the SAME instant and for the same
    // reason — see `schemaEnsuredMarkBeforeMigration`. Only a value HQ ITSELF
    // stamps counts (Wave 5 correction round six, Low 7): this used to accept
    // any non-zero value on the argument that it was the fail-closed reading,
    // and it was not — it made a FOREIGN application's `user_version` evidence
    // that HQ had been here, which is the false-alarm direction, and it
    // disagreed with `hqSchemaEnsuredMarkPresent`, which has always read the
    // closed set. `isHqSchemaEnsuredMark` is now the one spelling both use.
    const version = db.prepare(`PRAGMA user_version`).get() as Record<string, unknown> | undefined;
    const value = Number(Object.values(version ?? {})[0] ?? 0);
    MARK_BEFORE_MIGRATION.set(db, isHqSchemaEnsuredMark(value));
  } catch {
    // A handle that cannot even read its own catalogue records nothing rather
    // than an empty set: "I could not look" must not read as "nothing was
    // there", which would make every declared ledger look dropped. The mark is
    // recorded in the same try for the same reason — either both facts are
    // observed at that instant or neither is.
  }
  execSchemaDdl(db, DDL);
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
  // The SAME durability posture the writing open establishes, and for the same
  // reason it is set there: `synchronous` is a property of the CONNECTION, not
  // of the file, so a handle that never sets it reports whatever the SQLite
  // build happens to default to.
  //
  // Leaving it unset was a fabricated defect claim (Wave 5 correction round
  // three, Medium A5). `hq:snapshot` is this open, and this open reported
  // `synchronous = 1` where the writer reports 2 — so EVERY unauthenticated
  // snapshot of a perfectly healthy WAL + FULL store published
  // `durabilityMeetsRequirement: false` and a `durability_below_requirement`
  // finding about a store that met the requirement, and a genuine degradation
  // was permanently indistinguishable from that noise.
  //
  // Setting it writes nothing (executed: a read-only handle accepts the pragma
  // and the file is untouched) and claims nothing the handle cannot see: WAL is
  // a real, persistent property of the FILE and is read verbatim, while
  // `synchronous` is this connection's own and is now the declared one. What a
  // read-only handle still cannot speak for is the WRITER's connection —
  // `readDurabilityPosture` says so on the posture itself.
  // Spelled exactly as `connectHqDatabaseUnmigrated` spells it, so the two HQ
  // opens cannot drift into establishing different postures.
  db.pragma('synchronous = FULL');
  return db;
}

/** In-memory database for tests. */
export function openMemoryHqDatabase(): HqDatabase {
  return openHqDatabase(':memory:');
}

/**
 * Run one read, retrying ONCE if SQLite reports that the schema changed under
 * it (Wave 5 correction round sixteen; moved here and made re-preparing in
 * round seventeen, Medium-3).
 *
 * `SQLITE_SCHEMA` is not corruption and it is not a defect in the caller: it is
 * what the engine says when another connection ran DDL between the time a
 * statement was prepared and the time it was stepped, and the documented
 * handling is to prepare again. HQ's own boot path runs `CREATE TABLE IF NOT
 * EXISTS` from every process at construction, so this is a race the package
 * deliberately creates and must survive.
 *
 * ONE retry, not a loop: a second failure is a real condition and must be
 * reported rather than spun on. Nothing about what is observed changes.
 *
 * **This helper only helps a caller whose `read` can PREPARE AGAIN.** Wrapping
 * it around a call to an already-bound statement retries the same stale
 * statement and fails identically — which is exactly the defect round
 * seventeen found: the round-sixteen retry was applied to `tableNames`, whose
 * callback re-prepares, while `specialistDirectoryReads` prepared once at
 * construction and could never recover. For a bound `get`, use
 * `bindSchemaResilientGet` below rather than this.
 */
export function retryOnSchemaChange<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (!isSchemaChangeError(error)) throw error;
    return read();
  }
}

/** Is this the engine's "another connection changed the schema" signal? */
export function isSchemaChangeError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SQLITE_SCHEMA';
}

/**
 * Run one DDL batch, retrying ONCE if the schema changed under it (Wave 5
 * correction round seventeen, Medium-3).
 *
 * THE ONE SPELLING of `db.exec` in `src/`, and that is the point rather than a
 * tidiness preference. HQ's boot path runs `CREATE TABLE IF NOT EXISTS` from
 * every process at construction, so every `ensure*Schema` pass races every
 * other process's. The round-seventeen fix to `specialistDirectoryReads` closed
 * the site a 32-run measurement had caught and the NEXT 64 runs surfaced a
 * third site — `ensurePrincipalSchema`, one `db.exec` away — which is the same
 * "fix the named line, leave the class open" failure this wave keeps repeating.
 * Routing every DDL exec through here makes a site added in a future phase
 * covered by construction; `schema-change-resilience.test.ts` derives that no
 * bare `db.exec` survives in `src/`.
 *
 * `exec` re-parses its SQL on every call, so a plain retry genuinely
 * re-prepares here — unlike a bound `get`, which needs
 * `bindSchemaResilientGet`.
 *
 * It deliberately does NOT check `db.readonly`: the read-only guards stay
 * exactly where their own callers put them, so this changes nothing but the
 * retry.
 */
export function execSchemaDdl(db: HqDatabase, sql: string): void {
  retryOnSchemaChange(() => {
    // The ONE remaining `db.exec` in `src/`. Every other DDL site routes here;
    // `schema-change-resilience.test.ts` derives that and fails if a second
    // one appears.
    db.exec(sql);
  });
}

/**
 * Is this the engine saying the table is NOT THERE, as opposed to any other
 * failure to read it (Wave 5 correction round seventeen, Medium-4)?
 *
 * The distinction is load-bearing wherever an absent table is treated as "there
 * is nothing to enforce": absence is a fact about a database that never ran a
 * later phase's schema, and every other error is a failure to obtain an answer.
 * Conflating the two turns a gate into a fail-open one, which is exactly what
 * `#assignmentIntentOf` and its twin in `service.ts` used to do.
 *
 * Matched on better-sqlite3's own message (`no such table: <name>`), because
 * the engine reports it with the generic `SQLITE_ERROR` code — the code alone
 * cannot distinguish it from a syntax error or a patched `prepare`. The
 * message is the only signal available, so it is the one used, and a message
 * this does not recognise is NOT treated as absence: unrecognised means
 * rethrown, which is the fail-closed direction.
 */
export function isMissingTableError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /\bno such table\b/i.test(message);
}

/**
 * Prepare a statement once, return its `get` already bound, and RE-PREPARE it
 * once if the engine reports the schema changed under it (Wave 5 correction
 * round seventeen, Medium-3).
 *
 * ## The two properties this has to hold at the same time
 *
 * 1. **No mutable prototype on the call path.** Enforcement calls a closure
 *    directly: `db.prepare` is bound at construction, `Statement.prototype.get`
 *    is captured at construction, and `Function.prototype.call` is bound to it
 *    at construction — so the RETRY path introduces no lookup the primary path
 *    did not already make. That is the `bindGet` recipe, unchanged in
 *    substance.
 *
 * 2. **Survivable across a concurrent DDL.** The previous shape bound
 *    `statement.get` once and kept it forever, so a schema change under it was
 *    permanently fatal to that instance. Measured on `85b720d` over 32 runs of
 *    `reliability-commitment-prefix-replay.test.ts`: 2 failures, both
 *    `SqliteError: database schema has changed` out of `row` in
 *    `specialistDirectoryReads` — inside `#resolveRequester`, i.e. thrown out
 *    of an ENFORCEMENT decision by a read whose own docblock said "a malformed
 *    grant grants NOTHING rather than throwing out of an enforcement
 *    decision". Fail-closed, so never a bypass; but the class was described as
 *    survived and it was not.
 *
 * The retry re-prepares and re-binds, then runs once more. A second
 * `SQLITE_SCHEMA` is a real condition and is thrown.
 */
export function bindSchemaResilientGet(
  db: HqDatabase,
  sql: string,
): (...params: unknown[]) => unknown {
  const prepare = db.prepare.bind(db);
  let statement = prepare(sql);
  // The ORIGINAL `Statement.prototype.get`, captured now, so re-preparing later
  // never consults a prototype a caller could have replaced in between.
  const rawGet = statement.get as (...params: unknown[]) => unknown;
  const invoke = Function.prototype.call.bind(rawGet) as (
    target: unknown,
    ...params: unknown[]
  ) => unknown;
  return (...params: unknown[]): unknown => {
    try {
      return invoke(statement, ...params);
    } catch (error) {
      if (!isSchemaChangeError(error)) throw error;
      statement = prepare(sql);
      return invoke(statement, ...params);
    }
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
