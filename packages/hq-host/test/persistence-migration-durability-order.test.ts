import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectHqDatabaseUnmigrated,
  migrateHqDatabase,
  openHqDatabase,
} from '@factoryos/headquarter/store';

/**
 * Regression for Stage 3 durable first-boot/migration ordering.
 *
 * openHqDatabase() is the migrating open. Both the first-boot DDL and the
 * ensureColumns() upgrades must run only after FULL has been selected on that
 * same SQLite connection, so an initialization crash cannot lose schema the
 * caller was told had committed durably.
 *
 * This started as a source-text ordering assertion against a single inline
 * function body. The migrating open has since been split into
 * connectHqDatabaseUnmigrated() + migrateHqDatabase() so hosted mode can also
 * interpose its WAL/FULL verification and opened-inode attestation between the
 * two (see persistence-durability-before-migration.test.ts, which covers the
 * hosted path end to end). The ordering property is unchanged; the assertions
 * were re-pointed at the split.
 *
 * Two kinds of check on purpose, because neither alone is sufficient here:
 * the behavioural ones exercise real connections, but this SQLite build already
 * defaults to FULL, so on its own a live `synchronous === 2` reading would still
 * pass if the explicit pragma were deleted. The narrow source-level check is
 * what makes the guarantee independent of the build's compiled default.
 */
describe('HQ migrating-open durability ordering', () => {
  const roots: string[] = [];

  function dbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'hq-migrating-open-'));
    roots.push(root);
    return join(root, 'hq.sqlite');
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('selects synchronous FULL on the connection before any schema exists', () => {
    const db = connectHqDatabaseUnmigrated(dbPath());

    // 2 === FULL, active before the first DDL statement can run.
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    // Connecting alone must not have created schema; migration is a separate step.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(0);

    db.close();
  });

  it('still has FULL active while the DDL and the column migrations run', () => {
    const db = connectHqDatabaseUnmigrated(dbPath());
    let synchronousDuringMigration = -1;

    // Observed from inside the migration itself: better-sqlite3 is synchronous,
    // so a pragma read taken here reflects the setting the DDL commits under.
    const original = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (synchronousDuringMigration === -1) {
        synchronousDuringMigration = Number(db.pragma('synchronous', { simple: true }));
      }
      return original(sql);
    }) as typeof db.exec;

    migrateHqDatabase(db);

    expect(synchronousDuringMigration).toBe(2);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'op_tasks'").all(),
    ).toHaveLength(1);
    db.close();
  });

  it('selects FULL explicitly rather than inheriting a build default', () => {
    // Kept as a source-level assertion on purpose. The behavioural checks above
    // read `synchronous` off a live connection, and this SQLite build already
    // defaults to FULL — so they would still pass if the explicit pragma were
    // deleted, and a build compiled with a different SQLITE_DEFAULT_SYNCHRONOUS
    // would then commit schema at NORMAL. Only asserting that the code selects
    // FULL itself is independent of the build's default.
    const source = readFileSync(
      new URL('../../headquarter/src/store/db.ts', import.meta.url),
      'utf8',
    );
    const connectStart = source.indexOf('export function connectHqDatabaseUnmigrated(');
    const migrateStart = source.indexOf('export function migrateHqDatabase(');
    expect(connectStart).toBeGreaterThanOrEqual(0);
    expect(migrateStart).toBeGreaterThan(connectStart);

    // The connection is where durability is selected...
    const connectBody = source.slice(connectStart, migrateStart);
    expect(connectBody).toContain("db.pragma('synchronous = FULL')");
    expect(connectBody).not.toContain('db.exec(DDL)');
    expect(connectBody).not.toContain('ensureColumns(db)');

    // ...and migration, which carries every schema write, is a separate step
    // the caller runs afterwards.
    const migrateBody = source.slice(migrateStart);
    expect(migrateBody).toContain('db.exec(DDL)');
    expect(migrateBody).toContain('ensureColumns(db)');
  });

  it('keeps the ordinary migrating open equivalent to connect-then-migrate', () => {
    const db = openHqDatabase(dbPath());

    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2);
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    const columns = (db.prepare('PRAGMA table_info(op_tasks)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns).toContain('review_state');
    expect(columns).toContain('claim_nonce');
    db.close();
  });
});
