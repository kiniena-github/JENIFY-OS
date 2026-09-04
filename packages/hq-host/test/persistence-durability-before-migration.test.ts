/**
 * Stage 3: hosted durability must be proven BEFORE any schema write commits.
 *
 * `openHqDatabase` in @factoryos/headquarter/store is a *migrating* open — it
 * runs the DDL and the column upgrades inside the open itself. Hosted
 * durable-volume mode used to call it and only afterwards set and verify
 * WAL + `synchronous=FULL`, so first-boot schema creation and every later
 * migration committed under whatever `synchronous` the SQLite build defaults
 * to, and the durability verification trailed the writes it was meant to
 * cover. The current build happens to default to FULL, which is exactly why
 * this needs a regression test rather than a comment: the ordering, not the
 * build's default, is the guarantee.
 *
 * These tests observe the real ordering at the module boundary: the durable
 * owner must have committed WAL + FULL, and proven the opened inode, before
 * `migrateHqDatabase` is allowed to touch the volume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { attestDurableMountBoundary } from './support/durable-mount.js';

/**
 * Pragma state captured at the instant migration was invoked, plus the tables
 * that already existed at that instant. Populated by the module mock below.
 */
interface MigrationObservation {
  journalMode: string;
  synchronous: number;
  tablesBeforeMigration: string[];
}

const observations: MigrationObservation[] = [];

vi.mock('@factoryos/headquarter/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@factoryos/headquarter/store')>();
  return {
    ...actual,
    migrateHqDatabase: (db: Parameters<typeof actual.migrateHqDatabase>[0]) => {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[];
      observations.push({
        journalMode: String(db.pragma('journal_mode', { simple: true })).toLowerCase(),
        synchronous: Number(db.pragma('synchronous', { simple: true })),
        tablesBeforeMigration: tables.map((row) => row.name),
      });
      return actual.migrateHqDatabase(db);
    },
  };
});

// Imported after the mock is declared so the module under test binds to it.
const { openHqPersistence } = await import('../src/index.js');

const roots: string[] = [];

function durableRoot(): string {
  // Deliberately NOT os.tmpdir(): hosted durability rejects the OS temp tree.
  const root = mkdtempSync(join(process.cwd(), '.hq-durability-order-'));
  roots.push(root);
  return root;
}

function hostedEnv(root: string, dbPath: string): Record<string, string> {
  attestDurableMountBoundary(root);
  return {
    FACTORYOS_HQ_DB: dbPath,
    FACTORYOS_HQ_RUNTIME: 'hosted',
    FACTORYOS_HQ_PERSISTENCE: 'durable-volume',
    FACTORYOS_HQ_DURABLE_ROOT: root,
    FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE: 'operator:test-durable-volume',
  };
}

beforeEach(() => {
  observations.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('hosted durability is established before schema writes', () => {
  it('has WAL + synchronous=FULL active before first-boot schema creation', () => {
    const root = durableRoot();
    const dbPath = join(root, 'hq.sqlite');
    // The mounted-volume operator pre-creates an EMPTY regular file; every
    // table in it is therefore created by the migration this test observes.
    writeFileSync(dbPath, '');

    const persistence = openHqPersistence(hostedEnv(root, dbPath), () => {});

    expect(persistence).not.toBeNull();
    expect(observations).toHaveLength(1);
    const [observed] = observations;
    expect(observed.journalMode).toBe('wal');
    // 2 === FULL. Anything less means schema creation could commit without the
    // fsync guarantee the hosted contract reports to the operator.
    expect(observed.synchronous).toBe(2);
    // Proof this really was a first boot: the schema did not exist yet.
    expect(observed.tablesBeforeMigration).not.toContain('op_tasks');

    // ...and the migration still did its job under those modes.
    const tables = persistence!.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'op_tasks'`)
      .all();
    expect(tables).toHaveLength(1);
    persistence!.close();
  });

  it('has WAL + synchronous=FULL active before a migration boot adds columns', () => {
    const root = durableRoot();
    const dbPath = join(root, 'hq.sqlite');

    // An older-shaped store: op_tasks exists but predates the review columns,
    // so opening it must run a real ALTER TABLE ... ADD COLUMN migration.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE op_capabilities (id TEXT PRIMARY KEY);
      CREATE TABLE op_tasks (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL REFERENCES op_capabilities(id),
        payload TEXT NOT NULL,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        fence INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        lease_expires_at TEXT,
        approval_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        block_reason TEXT
      );
    `);
    const seededColumns = (seed.prepare(`PRAGMA table_info(op_tasks)`).all() as { name: string }[])
      .map((column) => column.name);
    expect(seededColumns).not.toContain('review_state');
    seed.close();

    const persistence = openHqPersistence(hostedEnv(root, dbPath), () => {});

    expect(persistence).not.toBeNull();
    expect(observations).toHaveLength(1);
    const [observed] = observations;
    expect(observed.journalMode).toBe('wal');
    expect(observed.synchronous).toBe(2);
    // Proof this really was a migration boot: the old table was already there,
    // so the columns below were added by a write under the verified modes.
    expect(observed.tablesBeforeMigration).toContain('op_tasks');

    const migratedColumns = (
      persistence!.db.prepare(`PRAGMA table_info(op_tasks)`).all() as { name: string }[]
    ).map((column) => column.name);
    expect(migratedColumns).toContain('review_state');
    expect(migratedColumns).toContain('claim_nonce');
    persistence!.close();
  });

  it('never reaches migration when the hosted volume fails its provenance gate', () => {
    const root = durableRoot();
    const dbPath = join(root, 'hq.sqlite');
    writeFileSync(dbPath, '');
    const env = hostedEnv(root, dbPath);
    delete env.FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE;

    const persistence = openHqPersistence(env, () => {});

    expect(persistence).toBeNull();
    // A refused hosted boot must not have written schema to the volume.
    expect(observations).toHaveLength(0);
    expect(fs.readFileSync(dbPath).byteLength).toBe(0);
  });
});
