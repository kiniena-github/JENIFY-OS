/**
 * Phase 5 — hq_memory is insert-only BY ENGINE (issue #265, the §G lesson).
 *
 * These statements go straight at the database, past every path the module
 * owns, and the ENGINE refuses them: content rewrites, erasure, REPLACE /
 * INSERT OR REPLACE / upsert landing on an existing id, and any status move
 * other than CURRENT -> SUPERSEDED. The one legitimate mutation — the
 * supersede UPDATE's exact column set — still succeeds. Recording
 * mission-linked memory can never touch the mission's immutable intent, and
 * a read-only handle observes truthfully instead of migrating.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { ensureMemoryTables, memorySchemaPresent, MemoryStore } from '../src/memory/store.js';
import { HeadquarterOperations } from '../src/application/service.js';

function memoryFixture(): Fixture {
  const fx = setupFixture();
  registerMemoryCommandCapability(fx.db);
  registerMissionCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, MEMORY_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function recordNote(fx: Fixture, over: Record<string, unknown> = {}) {
  return expectOk(
    fx.ops.recordMemory({
      kind: 'founder_note',
      title: 'Line 2 stays manual',
      body: 'Do not automate line 2 until the QC gate is live.',
      project: 'JENIFY-OS',
      requestedBy: 'founder',
      ...over,
    } as Parameters<Fixture['ops']['recordMemory']>[0]),
  ).record;
}

describe('hq_memory engine triggers', () => {
  it('aborts a raw UPDATE of any immutable column, from any writer', () => {
    const fx = memoryFixture();
    const record = recordNote(fx);
    for (const statement of [
      `UPDATE hq_memory SET body = 'forged' WHERE id = ?`,
      `UPDATE hq_memory SET title = 'forged' WHERE id = ?`,
      `UPDATE hq_memory SET recorded_by = 'attacker' WHERE id = ?`,
      `UPDATE hq_memory SET privacy = 'internal' WHERE id = ?`,
      `UPDATE hq_memory SET mission_id = 'forged' WHERE id = ?`,
      `UPDATE hq_memory SET derived_from = '["forged"]' WHERE id = ?`,
      `UPDATE hq_memory SET supersedes = 'forged' WHERE id = ?`,
    ]) {
      expect(() => fx.db.prepare(statement).run(record.id), statement).toThrow(/immutable|insert-only/);
    }
    // Refused means intact.
    expect(fx.ops.getMemoryRecord(record.id)!.body).toBe(
      'Do not automate line 2 until the QC gate is live.',
    );
  });

  it('aborts DELETE and every REPLACE/upsert spelling onto an existing id', () => {
    const fx = memoryFixture();
    const record = recordNote(fx);
    expect(() => fx.db.prepare(`DELETE FROM hq_memory WHERE id = ?`).run(record.id)).toThrow(
      /insert-only/,
    );
    expect(() =>
      fx.db
        .prepare(
          `INSERT OR REPLACE INTO hq_memory
             (id, kind, title, body, status, recorded_date, recorded_confidence, recorded_by,
              project, related, source_refs, tags, superseded_by, privacy, created_at, updated_at)
           VALUES (?, 'founder_note', 'forged', 'forged', 'CURRENT', '2026-01-01', 'exact', 'attacker',
                   'X', '{}', '[]', '[]', '[]', 'internal', 'now', 'now')`,
        )
        .run(record.id),
    ).toThrow(/insert-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO hq_memory
             (id, kind, title, body, status, recorded_date, recorded_confidence, recorded_by,
              project, related, source_refs, tags, superseded_by, privacy, created_at, updated_at)
           VALUES (?, 'founder_note', 'forged', 'forged', 'CURRENT', '2026-01-01', 'exact', 'attacker',
                   'X', '{}', '[]', '[]', '[]', 'internal', 'now', 'now')
           ON CONFLICT (id) DO UPDATE SET body = 'forged'`,
        )
        .run(record.id),
    ).toThrow(/insert-only/);
    expect(fx.ops.getMemoryRecord(record.id)!.title).toBe('Line 2 stays manual');
  });

  it('aborts REPLACE landing on the idempotency_key unique index — the original row survives, whatever the connection pragma says', () => {
    const fx = memoryFixture();
    // recursive_triggers is connection-scoped and binds no foreign writer;
    // with it OFF, only the BEFORE INSERT guard on the secondary index holds.
    fx.db.pragma('recursive_triggers = OFF');
    try {
      const record = recordNote(fx);
      const key = (fx.db.prepare(`SELECT idempotency_key FROM hq_memory WHERE id = ?`).get(record.id) as { idempotency_key: string | null })
        .idempotency_key;
      expect(key).toBeTruthy();
      const before = JSON.stringify(fx.db.prepare(`SELECT * FROM hq_memory`).all());
      expect(() =>
        fx.db
          .prepare(
            `INSERT OR REPLACE INTO hq_memory
               (id, kind, title, body, status, recorded_date, recorded_confidence, recorded_by,
                project, related, source_refs, tags, superseded_by, privacy, created_at, updated_at, idempotency_key)
             VALUES ('forged-memory', 'founder_note', 'forged', 'forged', 'CURRENT', '2026-01-01', 'exact', 'attacker',
                     'X', '{}', '[]', '[]', '[]', 'internal', 'now', 'now', ?)`,
          )
          .run(key),
      ).toThrow(/insert-only/);
      expect(JSON.stringify(fx.db.prepare(`SELECT * FROM hq_memory`).all())).toBe(before);
      expect(fx.ops.getMemoryRecord(record.id)!.title).toBe('Line 2 stays manual');
      expect(fx.ops.getMemoryRecord('forged-memory')).toBeNull();
    } finally {
      fx.db.pragma('recursive_triggers = ON');
    }
  });

  it('aborts REPLACE landing on the implicit rowid — a founder_only row cannot be swapped for a forged internal one, whatever the connection pragma says', () => {
    // hq_memory has a TEXT primary key, so its rowid is a separate, implicit
    // conflict target that neither the id guard nor the idempotency guard
    // tests. Review round 2 proved this REPLACE succeeded with the pragma OFF.
    const fx = memoryFixture();
    fx.db.pragma('recursive_triggers = OFF');
    try {
      const secret = recordNote(fx, { title: 'Founder-only note', body: 'Private.', privacy: 'founder_only' });
      const { rowid } = fx.db.prepare(`SELECT rowid FROM hq_memory WHERE id = ?`).get(secret.id) as { rowid: number };
      expect(typeof rowid).toBe('number');
      const before = JSON.stringify(fx.db.prepare(`SELECT rowid, * FROM hq_memory ORDER BY rowid`).all());
      expect(() =>
        fx.db
          .prepare(
            `INSERT OR REPLACE INTO hq_memory
               (rowid, id, kind, title, body, status, recorded_date, recorded_confidence, recorded_by,
                project, related, source_refs, tags, superseded_by, privacy, created_at, updated_at)
             VALUES (?, 'forged-memory', 'founder_note', 'forged', 'forged', 'CURRENT', '2026-01-01', 'exact', 'attacker',
                     'X', '{}', '[]', '[]', '[]', 'internal', 'now', 'now')`,
          )
          .run(rowid),
      ).toThrow(/insert-only/);
      expect(JSON.stringify(fx.db.prepare(`SELECT rowid, * FROM hq_memory ORDER BY rowid`).all())).toBe(before);
      expect(fx.ops.getMemoryRecord(secret.id)!.privacy).toBe('founder_only');
      expect(fx.ops.getMemoryRecord('forged-memory')).toBeNull();
      // The guard does not obstruct the legitimate writer (auto-assigned rowids keep flowing).
      const next = recordNote(fx, { title: 'Another note', body: 'Public.' });
      expect(fx.ops.getMemoryRecord(next.id)!.title).toBe('Another note');
    } finally {
      fx.db.pragma('recursive_triggers = ON');
    }
  });

  it('permits exactly the CURRENT -> SUPERSEDED status move and nothing else', () => {
    const fx = memoryFixture();
    const record = recordNote(fx);
    expect(() =>
      fx.db.prepare(`UPDATE hq_memory SET status = 'ARCHIVED', updated_at = 'now' WHERE id = ?`).run(record.id),
    ).toThrow(/CURRENT -> SUPERSEDED/);
    // The legitimate supersede statement shape (the store's own UPDATE) works.
    fx.db
      .prepare(`UPDATE hq_memory SET status = 'SUPERSEDED', superseded_by = ?, updated_at = ? WHERE id = ?`)
      .run('["successor"]', 'now', record.id);
    expect(fx.ops.getMemoryRecord(record.id)!.status).toBe('SUPERSEDED');
    // A superseded row can never come back.
    expect(() =>
      fx.db.prepare(`UPDATE hq_memory SET status = 'CURRENT', updated_at = 'x' WHERE id = ?`).run(record.id),
    ).toThrow(/CURRENT -> SUPERSEDED/);
  });

  it('recording mission-linked memory leaves the mission intent lock byte-identical', () => {
    const fx = memoryFixture();
    const { mission } = expectOk(
      fx.ops.commandMission({
        title: 'Faster QOS site',
        objective: 'Reduce page load times without changing the visual design',
        requestedBy: 'founder',
      }),
    );
    const before = fx.db
      .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? AND seq = 0`)
      .get(mission.id);
    recordNote(fx, { missionId: mission.id, title: 'Observation about the mission' });
    recordNote(fx, {
      missionId: mission.id,
      title: 'A note that tries to redirect: build a different site instead',
    });
    const after = fx.db
      .prepare(`SELECT * FROM hq_mission_intents WHERE mission_id = ? AND seq = 0`)
      .get(mission.id);
    expect(after).toEqual(before);
    // Memory changed nothing about the mission's canonical current intent.
    expect(fx.ops.getMission(mission.id)!.objective).toBe(
      'Reduce page load times without changing the visual design',
    );
  });
});

describe('read-only truth', () => {
  const dirs: string[] = [];
  const open: { close: () => void }[] = [];
  afterEach(() => {
    for (const handle of open.splice(0)) {
      try {
        handle.close();
      } catch {
        // Already closed by the test body — fine.
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ensureMemoryTables writes nothing through a read-only handle; presence is observed truthfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-memory-readonly-'));
    dirs.push(dir);
    const path = join(dir, 'headquarter.sqlite');

    // A pre-Phase-5 file: the full pre-existing schema (a real construction
    // performs it), with hq_memory then dropped to simulate the older file.
    const writer = openHqDatabase(path);
    open.push(writer);
    void new HeadquarterOperations(writer, {});
    writer.exec(`DROP TABLE IF EXISTS hq_memory`);
    writer.close();

    const readOnly = openHqDatabaseReadOnly(path);
    open.push(readOnly);
    expect(() => ensureMemoryTables(readOnly)).not.toThrow();
    expect(memorySchemaPresent(readOnly)).toBe(false);
    const ops = new HeadquarterOperations(readOnly, {});
    expect(ops.memoryStorePresent()).toBe(false);
    expect(ops.listMemory()).toEqual([]);
    expect(ops.getMemoryRecord('anything')).toBeNull();
    readOnly.close();

    // The observation wrote nothing: the file still has no hq_memory table.
    const check = openHqDatabase(path);
    open.push(check);
    const present = check
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_memory'`)
      .get();
    expect(present).toBeUndefined();
    check.close();
  });

  it('a store construction over a writable file upgrades an old hq_memory in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-memory-upgrade-'));
    dirs.push(dir);
    const path = join(dir, 'headquarter.sqlite');
    const old = openHqDatabase(path);
    open.push(old);
    // The pre-Phase-5 table shape (issue #120, no entity refs, no triggers).
    old.exec(`
      DROP TABLE IF EXISTS hq_memory;
      CREATE TABLE hq_memory (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, recorded_date TEXT NOT NULL, recorded_confidence TEXT NOT NULL,
        recorded_source TEXT, recorded_by TEXT NOT NULL, project TEXT NOT NULL,
        related TEXT NOT NULL, source_refs TEXT NOT NULL, tags TEXT NOT NULL,
        supersedes TEXT, superseded_by TEXT NOT NULL DEFAULT '[]',
        privacy TEXT NOT NULL DEFAULT 'internal', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO hq_memory (id, kind, title, body, status, recorded_date, recorded_confidence,
        recorded_by, project, related, source_refs, tags, created_at, updated_at)
      VALUES ('legacy-1', 'decision', 'Old decision', 'Kept as-is', 'CURRENT', '2026-08-01', 'exact',
        'founder', 'JENIFY-OS', '{}', '[]', '[]', 'then', 'then');
    `);
    const store = new MemoryStore(old);
    const legacy = store.get('legacy-1')!;
    expect(legacy.title).toBe('Old decision');
    expect(legacy.missionId).toBeNull();
    expect(legacy.derivedFrom).toEqual([]);
    // And the upgraded table is now engine-guarded.
    expect(() => old.prepare(`DELETE FROM hq_memory WHERE id = 'legacy-1'`).run()).toThrow(/insert-only/);
    old.close();
  });
});
