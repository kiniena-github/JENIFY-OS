/**
 * Wave 5, correction round twelve — Medium 2: the test file that was CITED as
 * the evidence for a permanent-condemnation detector, and had never existed.
 *
 * `committedLedgerGaps` latches a baseline gap per declared ledger and reports
 * any growth beyond it for ever. That is only safe if no legitimate write path
 * ever burns a rowid on a declared ledger, because a burn would raise the gap on
 * a perfectly healthy store and no in-HQ act clears it. The sentence at
 * `committedLedgerGaps` said that property "is not assumed —
 * `ledger-rowid-contiguity.test.ts` drives every conflicting, deduplicated and
 * refused write path this package has on all 33 of them". `git ls-files` and
 * `git log --all --diff-filter=A` both came back empty for that name: the file
 * had never existed on any commit, and the property's sole stated basis was a
 * citation of nothing.
 *
 * The property itself survived every attempt to disprove it. So this file is
 * written rather than the sentence merely softened — but it is written to do
 * what the sentence needs, which is NOT what the sentence claimed. Driving
 * "every write path on all 33 ledgers" is not something a test can honestly
 * assert: the sibling block in `ledger-identity.test.ts` drives a handful of
 * paths, and only about eight of the 33 ledgers carry any rows in its fixture,
 * so the other 25 pass trivially. Enumerating paths can only ever sample.
 *
 * What generalizes is the other direction, and it is what this file pins:
 *
 *  1. **which engine behaviours burn a rowid at all** — established against the
 *     engine itself rather than assumed, including the one that DOES burn; and
 *  2. **that no burning construct in this package's source targets a declared
 *     ledger** — read off the source, so a future write path that would burn one
 *     fails here whether or not anybody thinks to drive it.
 *
 * (1) bounds the risk and (2) covers all 33 without pretending to have executed
 * 33 fixtures. The executed sampling stays where it is, in
 * `ledger-identity.test.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ENGINE_IMMUTABLE_TABLES, declaredLedgerIdentities } from '../src/store/integrity.js';
import { fileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const DECLARED = new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table));

/** Every `.ts` file under `src/`, with its text. */
function sourceFiles(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push({ file: full, text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return found;
}

/**
 * The source with comments removed — JavaScript's, and SQL's.
 *
 * Every one of the constructs below is DISCUSSED at length in this package's
 * docblocks — `integrity.ts` alone explains `INSERT OR REPLACE` a dozen times —
 * so a search over raw text would match prose and prove nothing. The SQL `--`
 * form matters as much as the JS ones, because the DDL these modules embed in
 * template literals is commented in SQL: `mission-command.ts` explains in a
 * `--` comment that nothing deletes a mission, and a sweep that could not tell
 * that from a `DELETE` would report the very sentence promising the opposite.
 * Only code counts here.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^[^\S\n]*--[^\n]*$/gm, ' ');
}

describe('which engine behaviours burn a rowid, established against the engine', () => {
  /**
   * A scratch AUTOINCREMENT table with a UNIQUE column and an aborting guard —
   * the three shapes a declared ledger really has.
   */
  function scratch(): {
    db: Database.Database;
    insert: (value: string) => 'accepted' | 'refused';
    state: () => { top: number; rows: number; sequence: number };
  } {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT UNIQUE)`);
    db.exec(
      `CREATE TRIGGER ledger_guard BEFORE INSERT ON ledger WHEN NEW.v = 'refused'
       BEGIN SELECT RAISE(ABORT, 'refused'); END;`,
    );
    return {
      db,
      insert: (value: string) => {
        try {
          db.prepare(`INSERT INTO ledger (v) VALUES (?)`).run(value);
          return 'accepted';
        } catch {
          return 'refused';
        }
      },
      state: () => {
        const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS top, COUNT(*) AS rows FROM ledger`).get() as {
          top: number;
          rows: number;
        };
        const mark = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'ledger'`).get() as
          | { seq: number }
          | undefined;
        return { top: row.top, rows: row.rows, sequence: mark?.seq ?? 0 };
      },
    };
  }

  it('burns nothing on a UNIQUE violation, a trigger ABORT or a rolled-back SAVEPOINT', () => {
    const { db, insert, state } = scratch();
    try {
      expect(insert('one')).toBe('accepted');
      expect(state()).toEqual({ top: 1, rows: 1, sequence: 1 });

      // A duplicate refused by the UNIQUE index.
      expect(insert('one')).toBe('refused');
      expect(state()).toEqual({ top: 1, rows: 1, sequence: 1 });

      // A row refused by a BEFORE INSERT trigger — how every declared ledger's
      // append-only guards refuse.
      expect(insert('refused')).toBe('refused');
      expect(state()).toEqual({ top: 1, rows: 1, sequence: 1 });

      // A SAVEPOINT that inserts and rolls back.
      db.exec('SAVEPOINT probe');
      db.prepare(`INSERT INTO ledger (v) VALUES ('rolled-back')`).run();
      db.exec('ROLLBACK TO probe');
      db.exec('RELEASE probe');
      expect(state()).toEqual({ top: 1, rows: 1, sequence: 1 });

      // The next genuine append is CONTIGUOUS, which is the whole point: none of
      // the three above moved the counter, so no hole opens.
      expect(insert('two')).toBe('accepted');
      expect(state()).toEqual({ top: 2, rows: 2, sequence: 2 });
    } finally {
      db.close();
    }
  });

  /**
   * The one that DOES burn, executed rather than left to be discovered later.
   *
   * `INSERT … ON CONFLICT … DO UPDATE` raises `sqlite_sequence` even when it
   * takes the UPDATE branch and inserts no row. It leaves `MAX(rowid)` and
   * `COUNT(*)` equal, so it opens no gap by itself — but the NEXT append then
   * skips a rowid, which does. On a declared ledger that would raise
   * `committedLedgerGaps` permanently AND make `truncatedImmutableLedgers` read
   * `MAX(rowid) < sqlite_sequence`. Neither is reachable today, and the test
   * below is what keeps it that way.
   */
  it('DOES burn on an upsert that takes the UPDATE branch, and the next append then skips', () => {
    const { db, insert, state } = scratch();
    try {
      expect(insert('one')).toBe('accepted');
      db.prepare(`INSERT INTO ledger (v) VALUES ('one') ON CONFLICT(v) DO UPDATE SET v = excluded.v`).run();
      // No row added, no hole yet — but the counter moved.
      const afterUpsert = state();
      expect(afterUpsert.rows).toBe(1);
      expect(afterUpsert.top).toBe(1);
      expect(afterUpsert.sequence, 'the upsert raised the AUTOINCREMENT counter').toBeGreaterThan(
        afterUpsert.top,
      );

      // And that is what turns into a permanent gap on the next genuine append.
      expect(insert('two')).toBe('accepted');
      const after = state();
      expect(after.rows).toBe(2);
      expect(after.top - after.rows, 'the burn became a rowid hole').toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe('no burning construct in this package targets a declared ledger', () => {
  /**
   * `INSERT … ON CONFLICT` is the only burning construct this package uses, and
   * this is the assertion that covers all 33 ledgers rather than sampling them:
   * every upsert target is read off the source and checked against the declared
   * set.
   */
  it('sends every ON CONFLICT upsert to a table that is not a declared ledger', () => {
    const targets: { file: string; table: string }[] = [];
    for (const { file, text } of sourceFiles()) {
      const body = code(text);
      for (const match of body.matchAll(
        /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)[\s\S]{0,2000}?ON\s+CONFLICT/gi,
      )) {
        targets.push({ file, table: match[1]! });
      }
    }
    expect(targets.length, 'the sweep must find the upserts this package really has').toBeGreaterThan(0);
    const offending = targets.filter((entry) => DECLARED.has(entry.table));
    expect(
      offending.map((entry) => `${entry.table} in ${path.relative(SRC, entry.file)}`),
      'an upsert on a declared ledger would burn a rowid and latch a permanent gap',
    ).toEqual([]);
  });

  it('spells no INSERT OR REPLACE / OR IGNORE / REPLACE INTO in any executed statement', () => {
    // These would burn or renumber outright. The package documents at length
    // that it does not use them; this is that claim read off the code.
    const offending: string[] = [];
    for (const { file, text } of sourceFiles()) {
      const body = code(text);
      for (const match of body.matchAll(/\b(INSERT\s+OR\s+(?:REPLACE|IGNORE)|REPLACE\s+INTO)\b/gi)) {
        // A trigger body that RAISEs on such a statement is a refusal of it, not
        // a use of it, and the guards are written as SQL string literals too.
        offending.push(`${path.relative(SRC, file)}: ${match[1]}`);
      }
    }
    expect(offending).toEqual([]);
  });

  it('sends every DELETE FROM to a table that is not a declared ledger', () => {
    const targets: { file: string; table: string }[] = [];
    for (const { file, text } of sourceFiles()) {
      const body = code(text);
      for (const match of body.matchAll(/DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        targets.push({ file, table: match[1]! });
      }
    }
    expect(targets.length, 'the sweep must find the deletes this package really has').toBeGreaterThan(0);
    const offending = targets.filter((entry) => DECLARED.has(entry.table));
    expect(
      offending.map((entry) => `${entry.table} in ${path.relative(SRC, entry.file)}`),
      'a declared ledger is append-only; deleting from one is what the gap rule exists to catch',
    ).toEqual([]);
  });

  it('reads the declared set from the schema rather than from a list written here', () => {
    // The hole this wave opened twice was a hand-written enumeration standing in
    // for the real set, so the sweeps above take theirs from
    // `ENGINE_IMMUTABLE_TABLES` and this asserts that is what they got.
    expect(DECLARED.size).toBe(ENGINE_IMMUTABLE_TABLES.length);
    expect(DECLARED.has('op_evidence')).toBe(true);
  });
});

describe('a real file carries no rowid hole on any declared ledger it holds', () => {
  it('holds top === rows on every declared ledger a booted store has written', () => {
    // The executed half, kept honest about its own reach: this asserts the
    // property on the ledgers a real store actually populates, and says how many
    // that was rather than implying it covered all 33.
    const fx = fileFixture();
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      }
      const identities = declaredLedgerIdentities(fx.db as HqDatabase);
      const populated = Object.entries(identities).filter(([, identity]) => identity.rows > 0);
      expect(populated.length, 'the fixture must populate some declared ledgers').toBeGreaterThan(0);
      for (const [table, identity] of populated) {
        expect(identity.top, `${table} must have no rowid hole`).toBe(identity.rows);
      }
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * The sweep that would have caught this defect at the moment it was written.
 *
 * The sentence at `committedLedgerGaps` cited a test file by name as the sole
 * evidence for a permanent-condemnation detector, and the file had never existed
 * on any commit. Nothing in the suite could notice, because nothing compared the
 * names this package cites to the files it has. That is the general shape of the
 * defect — a citation to nothing — and it is closed generally rather than by
 * creating the one file and moving on.
 */
describe('every test file this package cites in its own source exists', () => {
  it('resolves every `*.test.ts` named in a src/ docblock to a real file', () => {
    const cited = new Set<string>();
    for (const { text } of sourceFiles()) {
      for (const match of text.matchAll(/`([a-z0-9][a-z0-9.-]*\.test\.ts)`/g)) cited.add(match[1]!);
    }
    expect(cited.size, 'the sweep must find the citations this package really makes').toBeGreaterThan(0);
    const testDir = path.join(SRC, '..', 'test');
    const missing = [...cited].filter((name) => !fs.existsSync(path.join(testDir, name))).sort();
    expect(missing, 'a docblock cites a test file that does not exist').toEqual([]);
  });
});
