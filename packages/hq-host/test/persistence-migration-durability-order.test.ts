import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Regression for Stage 3 durable first-boot/migration ordering.
 *
 * openHqDatabase() is the migrating open used by hosted persistence. Both the
 * first-boot DDL and ensureColumns() upgrades must run only after FULL has been
 * selected on that same SQLite connection. This source-order assertion is
 * intentionally narrow: it guards the ordering property directly without
 * depending on crash timing or filesystem behavior.
 */
describe('HQ migrating-open durability ordering', () => {
  it('enables synchronous FULL before first-boot DDL and column migrations', () => {
    const source = readFileSync(
      new URL('../../headquarter/src/store/db.ts', import.meta.url),
      'utf8',
    );
    const openStart = source.indexOf('export function openHqDatabase(');
    const readOnlyStart = source.indexOf('export function openHqDatabaseReadOnly(');
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(readOnlyStart).toBeGreaterThan(openStart);

    const migratingOpen = source.slice(openStart, readOnlyStart);
    const full = migratingOpen.indexOf("db.pragma('synchronous = FULL')");
    const ddl = migratingOpen.indexOf('db.exec(DDL)');
    const migrations = migratingOpen.indexOf('ensureColumns(db)');

    expect(full).toBeGreaterThanOrEqual(0);
    expect(ddl).toBeGreaterThan(full);
    expect(migrations).toBeGreaterThan(full);
  });
});
