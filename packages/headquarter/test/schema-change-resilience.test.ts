/**
 * An enforcement read survives a concurrent DDL, and does not stop being
 * prototype-free to do it (Wave 5 correction round seventeen, Medium-3).
 *
 * ## What was open
 *
 * Round sixteen's commit subject said "retry a schema-change read" and
 * `integrity.ts`'s docblock presented the class as survived. It was not. The
 * retry was applied to `tableNames`, whose callback re-prepares; the three
 * reads in `specialistDirectoryReads` prepared ONE statement at construction
 * and bound its `get`, so a statement invalidated by another connection's DDL
 * could never be recovered within that instance's life. A hostile review ran
 * `reliability-commitment-prefix-replay.test.ts` 32 times and measured 3
 * failures at a DIFFERENT site from the one that had been fixed:
 *
 * ```
 * AssertionError: assessor-a did not finish cleanly:
 * SqliteError: database schema has changed  { code: 'SQLITE_SCHEMA' }
 *     at row (src/application/ports.ts:171:19)
 *     at Object.isRegistered (src/application/ports.ts:183:41)
 *     at HeadquarterOperations.#resolveRequester (service.ts:17391)
 *     at #resolveFounderGateActor (service.ts:7119) -> #resolveReliabilityCommander
 *     at HeadquarterOperations.assessHqIntegrity (service.ts:9235)
 * ```
 *
 * Reproduced here at this branch's own head, 32 runs, 2 failures, both at
 * `ports.ts:171`. Fail-closed, so never a bypass — but the read's own docblock
 * said "a malformed grant grants NOTHING rather than throwing out of an
 * enforcement decision", and a concurrent DDL made it throw out of exactly
 * such a decision. HQ provokes that DDL itself: `CREATE TABLE IF NOT EXISTS`
 * runs from every process at construction.
 *
 * ## And fixing that one site was not enough, which is the whole lesson
 *
 * With `specialistDirectoryReads` corrected, the next 64 runs produced ONE
 * failure — at a THIRD site:
 *
 * ```
 * SqliteError: database schema has changed
 *     at ensurePrincipalSchema (src/application/principals.ts:79:6)
 *     at new HumanPrincipalRegistry (src/application/principals.ts:98:5)
 *     at new HeadquarterOperations (src/application/service.ts:3097:51)
 * ```
 *
 * A `db.exec` of `CREATE TABLE IF NOT EXISTS`, in a constructor, racing every
 * other process's identical boot DDL. Closing THAT one and stopping would have
 * been the third round in a row of migrating a named line and calling a class
 * closed.
 *
 * ## What is enforced instead
 *
 * Two helpers and one derivation:
 *
 *  1. `bindSchemaResilientGet` re-prepares ONCE and runs again, using a
 *     `prepare` bound at construction and the original
 *     `Statement.prototype.get` captured at construction — so the retry path
 *     introduces no prototype lookup the primary path did not already make.
 *     Both the directory reads and `service.ts`'s `bindGet` (the principal and
 *     grant lookups on the same call path) go through it.
 *  2. `execSchemaDdl` retries a DDL batch once. `exec` re-parses its SQL, so a
 *     plain retry genuinely re-prepares there.
 *  3. THE DERIVATION: exactly ONE `db.exec` may exist in `src/` — the one
 *     inside `execSchemaDdl`. Every other DDL site in the package (47 of them
 *     across 18 files at this head) routes through it, and a bare `db.exec`
 *     added in a future phase fails this file on the day it is written.
 *
 * ## What this does NOT claim
 *
 *  - it is ONE retry, in both helpers. A second `SQLITE_SCHEMA` is thrown,
 *    deliberately: a condition that survives a re-prepare is real and must be
 *    reported rather than spun on;
 *  - the derivation is lexical. It covers `db.exec` spelled on a receiver
 *    named `db`; a handle bound to another local (`handle.exec(…)`) is not
 *    matched, and there is none in `src/` today;
 *  - it says nothing about `prepare(...).run(...)` sites, which are ordinary
 *    DML and re-prepare on every call anyway;
 *  - `registryDirectoryReads` binds a caller-supplied `MemberDirectorySource`'s
 *    methods, not SQLite statements. Whatever that source prepares internally
 *    is outside HQ and is not covered here;
 *  - a schema change that arrives between the re-prepare and the step of the
 *    retry is a third occurrence and throws;
 *  - **"the suite is deterministic" is asserted NOWHERE**, here or anywhere
 *    else. What is asserted is these two helpers' behaviour under a schema
 *    change. The determinism claim is a MEASUREMENT with a run count, recorded
 *    in the phase document, and a green sample is not a proof of absence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindSchemaResilientGet, execSchemaDdl, openMemoryHqDatabase } from '../src/store/db.js';
import { specialistDirectoryReads } from '../src/application/ports.js';
import { HeadquarterStore } from '../src/store/headquarter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');

/** Every `.ts` file under `src/`, so a file added in a future phase is scanned. */
function sourceFiles(directory: string = SRC, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** The engine's own signal, in the shape better-sqlite3 raises it. */
function schemaChange(): Error {
  const error = new Error('database schema has changed');
  (error as unknown as { code: string }).code = 'SQLITE_SCHEMA';
  return error;
}

describe('a bound enforcement read re-prepares when the schema changes under it', () => {
  it('answers correctly after one SQLITE_SCHEMA, and never consults a prototype to do it', () => {
    const db = openMemoryHqDatabase();
    new HeadquarterStore(db).upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    const reads = specialistDirectoryReads(db);
    expect(reads.isRegistered('claude'), 'the baseline read must work').toBe(true);

    // Fail the NEXT step exactly as the engine does, then let it recover. The
    // statement the closure holds is the one that gets replaced, so a read that
    // could not re-prepare would keep throwing forever.
    let thrown = 0;
    const database = db as unknown as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } };
    const realPrepare = database.prepare.bind(db);
    // A statement whose first step raises SQLITE_SCHEMA once — what a
    // concurrent `CREATE TABLE IF NOT EXISTS` does to a prepared statement.
    const stale = specialistDirectoryReads({
      prepare: (sql: string) => {
        const statement = realPrepare(sql);
        const realGet = statement.get.bind(statement);
        return {
          ...statement,
          get: (...params: unknown[]) => {
            if (thrown === 0) {
              thrown += 1;
              throw schemaChange();
            }
            return realGet(...params);
          },
        };
      },
    } as never);
    expect(stale.isRegistered('claude'), 'the read must recover from one schema change').toBe(true);
    expect(thrown, 'and it must have actually hit the failure').toBe(1);
    db.close();
  });

  it('reports a SECOND schema change rather than spinning on it', () => {
    const db = openMemoryHqDatabase();
    let thrown = 0;
    const realPrepare = (db as unknown as { prepare: (sql: string) => unknown }).prepare.bind(db);
    const get = bindSchemaResilientGet(
      {
        prepare: (sql: string) => {
          void realPrepare(sql);
          return {
            get: () => {
              thrown += 1;
              throw schemaChange();
            },
          };
        },
      } as never,
      `SELECT 1`,
    );
    expect(() => get()).toThrowError(/schema has changed/);
    expect(thrown, 'exactly one retry, not a loop').toBe(2);
    db.close();
  });

  it('leaves exactly ONE `db.exec` in src/, so no DDL site can miss the retry', () => {
    // THE DERIVATION, and the reason this finding was not closed by fixing
    // `specialistDirectoryReads` alone. That fix made the measured site green;
    // the next 64 runs of the same file then surfaced a THIRD site,
    // `ensurePrincipalSchema`, one `db.exec` away — the same "fix the named
    // line, leave the class open" failure this wave keeps repeating. Every DDL
    // exec in the package now routes through `execSchemaDdl`, and a bare
    // `db.exec` anywhere else fails HERE on the day it is written rather than
    // in a flaky run months later.
    const bare: string[] = [];
    for (const file of sourceFiles()) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\bdb\s*\.\s*exec\s*\(/.test(line)) return;
        bare.push(`${relative}:${index + 1} ${line.trim()}`);
      });
    }
    // The one inside `execSchemaDdl` itself is the implementation.
    expect(bare.length, `bare db.exec sites: ${bare.join(' | ')}`).toBe(1);
    expect(bare[0]).toContain('src/store/db.ts');
    // And the helper is genuinely used, package-wide, or the rule above would
    // be satisfied by deleting every DDL site instead of routing it.
    const users = sourceFiles().filter((file) =>
      /\bexecSchemaDdl\s*\(/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(users.length, 'the helper must be the package-wide DDL path').toBeGreaterThanOrEqual(15);
  });

  it('retries a DDL batch once when the schema changes under it', () => {
    let attempts = 0;
    execSchemaDdl(
      {
        exec: () => {
          attempts += 1;
          if (attempts === 1) throw schemaChange();
        },
      } as never,
      `CREATE TABLE IF NOT EXISTS x (a TEXT)`,
    );
    expect(attempts, 'one failure, one retry, then done').toBe(2);
    // A second failure is a real condition and is reported.
    let always = 0;
    expect(() =>
      execSchemaDdl(
        {
          exec: () => {
            always += 1;
            throw schemaChange();
          },
        } as never,
        `CREATE TABLE IF NOT EXISTS y (a TEXT)`,
      ),
    ).toThrowError(/schema has changed/);
    expect(always).toBe(2);
  });

  it('passes any OTHER error straight through, so a real fault is not retried into silence', () => {
    let calls = 0;
    const get = bindSchemaResilientGet(
      {
        prepare: () => ({
          get: () => {
            calls += 1;
            throw new Error('no such table: hq_specialists');
          },
        }),
      } as never,
      `SELECT 1`,
    );
    expect(() => get()).toThrowError(/no such table/);
    expect(calls, 'a non-schema error is not retried').toBe(1);
  });
});
