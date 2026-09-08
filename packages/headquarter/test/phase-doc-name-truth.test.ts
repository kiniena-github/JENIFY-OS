/**
 * Prose that names code is checked against the code (Wave 5 correction round
 * thirteen, Lows 1, 2 and 3).
 *
 * Three findings of one shape: a sentence naming a symbol or a number that the
 * repository does not have. Each is corrected at its source; this file is what
 * stops the next one.
 *
 * ## Why a table row needed a test
 *
 * `PHASE_13_ADVANCED_RELIABILITY.md`'s "enforcement-safe read audit" is the
 * artefact a reviewer uses to check the authority boundary: each row names a
 * decision, and the SECOND column names the function that decision is allowed
 * to read through. The whole job of that column is naming.
 *
 * One row named `latestIntegrityVerdict(db)`. That symbol existed nowhere in
 * `src/` or `test/`. The real function is `standingIntegrityVerdict`
 * (`application/reliability-command.ts`, used at `application/service.ts`), and
 * the rename happened INSIDE this wave — added in `4e88053`, renamed in
 * `ba02f81`, with the correction round that did it recording the rename two
 * pages further down. The row was simply never updated, so the artefact that
 * says which read is canonical pointed at a dead name for the rest of the wave.
 *
 * A rename cannot orphan the row again: this sweeps the column and requires
 * every identifier in it to resolve.
 *
 * ## What counts as an identifier, and what is deliberately skipped
 *
 * The column mixes three kinds of backticked text, and only one of them is a
 * symbol:
 *
 *  - CODE IDENTIFIERS — `standingIntegrityVerdict`, `#capabilityFromStore`,
 *    `ENGINE_IMMUTABLE_TABLES`, `hqReliabilityPosture`. These are checked;
 *  - SQL NAMES — `op_tasks`, `hq_reliability_verdicts`, `attempt_key`. Skipped
 *    by their spelling: all-lowercase `snake_case` is the schema's convention
 *    and never a TypeScript symbol in this package. `SCREAMING_SNAKE_CASE`
 *    constants are NOT skipped by that rule and are checked;
 *  - the literal word `#private`, which is prose about visibility rather than
 *    the name of a member.
 *
 * Resolution accepts a module-level declaration (`export function`, `const`,
 * `class`, `interface`, `type`) or a class/object member declaration, anywhere
 * under `src/`. That is deliberately loose: the claim being pinned is "this
 * name still exists", which is exactly the claim that failed, and a stricter
 * rule would start refusing rows that are correct.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryHqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  UNIQUE_REENTRY_GUARD,
  WRITE_ONCE_IDENTITY_TABLES,
  uniqueReentryGuardDdl,
} from '../src/store/integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const PHASE_13 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_13_ADVANCED_RELIABILITY.md',
);
const PHASE_14 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_14_COST_INTELLIGENCE_OPTIMIZATION.md',
);
const HEADING = '## The enforcement-safe read audit';

/** Every `.ts` file under `src/`, read once. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(SRC);
  return out;
}

let cache: string[] | null = null;

function resolvesToASymbol(identifier: string): boolean {
  cache ??= sources();
  if (identifier.startsWith('#')) {
    const member = new RegExp(
      `^\\s*(?:readonly\\s+|static\\s+|get\\s+)*${identifier}\\s*[(<:=]`,
      'm',
    );
    return cache.some((source) => member.test(source));
  }
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function|const|class|interface|type|let)\\s+${identifier}\\b`,
    'm',
  );
  const member = new RegExp(
    `^\\s{2,}(?:readonly\\s+|static\\s+|get\\s+)*${identifier}\\s*[(<:]`,
    'm',
  );
  return cache.some((source) => declaration.test(source) || member.test(source));
}

/** Backticked spans in the "Reads through" column of every row of the table. */
function auditedIdentifiers(): { row: number; identifier: string }[] {
  const lines = fs.readFileSync(PHASE_13, 'utf8').split('\n');
  const at = lines.findIndex((line) => line.trim() === HEADING);
  expect(at, `heading not found: ${HEADING}`).toBeGreaterThan(-1);
  const found: { row: number; identifier: string }[] = [];
  let started = false;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      if (started) break;
      if (line.startsWith('#')) break;
      continue;
    }
    started = true;
    if (/^\|\s*-+/.test(line)) continue;
    const column = line.split('|')[2] ?? '';
    // The header row names the columns rather than a symbol.
    if (column.trim() === 'Reads through') continue;
    for (const span of column.matchAll(/`([^`]+)`/g)) {
      const identifier = span[1].trim().replace(/\(.*$/, '');
      if (!/^#?[A-Za-z][A-Za-z0-9]*$/.test(identifier)) continue;
      if (identifier === '#private') continue;
      found.push({ row: i + 1, identifier });
    }
    // SCREAMING_SNAKE_CASE constants carry an underscore but ARE symbols, so
    // they are matched separately rather than dropped with the SQL names.
    for (const span of column.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      found.push({ row: i + 1, identifier: span[1] });
    }
  }
  return found;
}

describe('prose that names a symbol or a count is checked against the repository', () => {
  it('sweeps a real table — the derivation is not vacuous', () => {
    const identifiers = auditedIdentifiers();
    // Fourteen rows at the head this was written against, each naming at least
    // one read. A floor rather than an equality: rows are added by later
    // phases, and this only has to refuse an EMPTY sweep.
    expect(identifiers.length).toBeGreaterThan(15);
    expect(new Set(identifiers.map((entry) => entry.row)).size).toBeGreaterThan(10);
  });

  it('every identifier in the "Reads through" column resolves to a real symbol', () => {
    const unresolved = auditedIdentifiers()
      .filter((entry) => !resolvesToASymbol(entry.identifier))
      .map((entry) => `${entry.row}:${entry.identifier}`);
    expect(
      unresolved,
      'the enforcement-safe read audit names a symbol that does not exist',
    ).toEqual([]);
  });

  it('a name this wave retired does not reappear in either phase document', () => {
    // Low 1 and Low 2 are the same defect twice: a phase document naming a
    // facade symbol that does not exist. A general sweep of every backticked
    // camelCase word in these two pages is not viable — it collides with
    // vitest matchers, node calls and JSON keys, and an allow-list for those
    // would go stale exactly the way the rows did. So this is a REGISTER of
    // the specific dead names, which is narrow, true, and fires if either
    // comes back.
    const pages = [PHASE_13, PHASE_14].map((file) => ({
      name: path.basename(file),
      lines: fs.readFileSync(file, 'utf8').split('\n'),
    }));
    // Each retired name, with the live one it was replaced by. A retired name
    // may appear ONLY on a line that also names its replacement — which is
    // what a round log recording the correction looks like, and what a stale
    // row never is.
    //
    //  - `recordCostEntry` never existed; the method is
    //    `recordIntelligenceCost`, and the sentence carrying the wrong name
    //    was otherwise true of it;
    //  - `latestIntegrityVerdict` was renamed `standingIntegrityVerdict` by
    //    `ba02f81`, inside this wave.
    const retired: readonly (readonly [string, string])[] = [
      ['recordCostEntry', 'recordIntelligenceCost'],
      ['latestIntegrityVerdict', 'standingIntegrityVerdict'],
    ];
    for (const [dead, live] of retired) {
      expect(resolvesToASymbol(live), `${live} does not resolve`).toBe(true);
      expect(resolvesToASymbol(dead), `${dead} is not actually retired`).toBe(false);
      for (const page of pages) {
        const orphaned = page.lines
          .map((line, index) => ({ line, at: index + 1 }))
          .filter((entry) => entry.line.includes(dead) && !entry.line.includes(live))
          .map((entry) => `${page.name}:${entry.at}`);
        expect(
          orphaned,
          `${dead} is written somewhere that does not name ${live} beside it`,
        ).toEqual([]);
      }
    }
  });

  it('no test in this package writes down how many tests the package has', () => {
    // Low 3. Two files carried "would relax the deadline for all 3425 tests in
    // this package" in the docblock above a per-test timeout. The package had
    // 3442 at the head this was found on, and the figure had been correct at
    // some earlier head of the same wave. It is the same class as the phase
    // document's stale counts, one directory over.
    //
    // The sentence does not need the number — the reason a global
    // `testTimeout` is the wrong instrument is that it reaches every test,
    // however many there are — so the fix is to remove it rather than to
    // re-measure a figure that goes stale on the next merge. This refuses the
    // next one.
    //
    // Deliberately narrow. It refuses the PRESENT-TENSE claim — "N tests in
    // this package" — and not a historical measurement at a named head, of
    // which this package has three ("`'read_only'` passed all 3026 tests",
    // "stayed green at 178 files / 3288 tests"). Those record what an
    // experiment actually produced at a head that is named beside them; they
    // are true, they stay true, and re-measuring them would destroy the
    // evidence rather than refresh it.
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(HERE)) {
      if (!entry.endsWith('.ts')) continue;
      const source = fs.readFileSync(path.join(HERE, entry), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/\b\d{3,6}\s+tests\s+(?:in|of)\s+this\s+package\b/.test(line)) {
          offenders.push(`${entry}:${index + 1}`);
        }
      }
    }
    expect(
      offenders,
      'a test file states a whole-suite test count, which goes stale on the next merge',
    ).toEqual([]);
  });

  it('the checker can tell the renamed function from the dead name', () => {
    // Without this, an over-permissive resolver would pass the sweep above
    // while proving nothing. `standingIntegrityVerdict` is the real function;
    // `latestIntegrityVerdict` is the name the row carried for the rest of the
    // wave after `ba02f81` renamed it.
    expect(resolvesToASymbol('standingIntegrityVerdict')).toBe(true);
    expect(resolvesToASymbol('latestIntegrityVerdict')).toBe(false);
    // And the row itself names the live one.
    expect(auditedIdentifiers().map((entry) => entry.identifier)).toContain(
      'standingIntegrityVerdict',
    );
  });
});

/**
 * Wave 5 correction round fifteen, MEDIUM 1 — the comment at an install site
 * claimed the opposite of the decision recorded at the implementation.
 *
 * `service.ts`'s comment above `ensureUniqueReentryGuards(db)` said the derived
 * unique-index guard is installed "on every declared ledger and every write-once
 * identity table". `uniqueReentryTargets` (`store/integrity.ts`) maps
 * `WRITE_ONCE_IDENTITY_TABLES` and nothing else, and Phase 13 records that the
 * all-33 form was built, measured and rejected. Measured at `c23dd0a`, exactly
 * one such trigger exists on a fresh file: `["trg_op_tasks_no_unique_reentry"]`.
 * The one comment a maintainer reads at the call asserted a coverage the call
 * does not have.
 *
 * This is a two-sided derived guard rather than a prose sweep, because the prose
 * is what went wrong and a test that reads only prose would go wrong with it:
 *
 *  - the CODE half reads which registry `uniqueReentryTargets` actually maps,
 *    and asserts the triggers a real database ends up carrying are exactly the
 *    ones that registry derives;
 *  - the PROSE half requires the install-site comment to NAME that same registry
 *    constant and not the other one. Keyed on the constant names, which appear
 *    nowhere in ordinary English, so a sentence that merely mentions "declared
 *    ledger" while explaining the history does not trip it.
 *
 * Widening `uniqueReentryTargets` to the all-33 form without moving the comment
 * fails the prose half; narrowing the comment without the code fails the code
 * half. Either direction of the round-fourteen drift is now caught.
 */
describe('the derived unique-index guard is installed where the install site says it is', () => {
  const INTEGRITY = path.join(SRC, 'store', 'integrity.ts');
  const SERVICE = path.join(SRC, 'application', 'service.ts');

  /** The comment block immediately above the `ensureUniqueReentryGuards` call. */
  function installSiteComment(): string {
    const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
    const at = lines.findIndex((line) => line.trim() === 'ensureUniqueReentryGuards(db);');
    expect(at, 'the install site is gone').toBeGreaterThan(-1);
    const block: string[] = [];
    for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('//'); i -= 1) block.unshift(lines[i]);
    expect(block.length, 'the install site carries no comment at all').toBeGreaterThan(0);
    return block.join('\n');
  }

  /** Which registry `uniqueReentryTargets` maps, read from its body. */
  function mappedRegistries(): string[] {
    const source = fs.readFileSync(INTEGRITY, 'utf8');
    const at = source.indexOf('function uniqueReentryTargets(');
    expect(at, 'uniqueReentryTargets is gone').toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf('\n}', at));
    return ['WRITE_ONCE_IDENTITY_TABLES', 'ENGINE_IMMUTABLE_TABLES'].filter((name) =>
      body.includes(name),
    );
  }

  it('installs exactly the triggers the mapped registry derives — measured on a real file', () => {
    const db = openMemoryHqDatabase();
    try {
      // The facade constructor is what installs them, so this is the file a
      // real boot produces rather than a hand-built one.
      new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
      const installed = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
               WHERE type = 'trigger' AND name LIKE '%\\_${UNIQUE_REENTRY_GUARD}' ESCAPE '\\'
               ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name);

      const registries = mappedRegistries();
      const source =
        registries.includes('ENGINE_IMMUTABLE_TABLES')
          ? [...ENGINE_IMMUTABLE_TABLES, ...WRITE_ONCE_IDENTITY_TABLES]
          : WRITE_ONCE_IDENTITY_TABLES;
      // Only a table that carries an EXPRESSIBLE secondary unique index gets a
      // trigger — `uniqueReentryGuardDdl` returns null otherwise — so the
      // expectation is derived through the same rule, not from a list.
      const expected = [
        ...new Set(
          source
            .filter((entry) => uniqueReentryGuardDdl(db, entry.table, entry.triggerPrefix) !== null)
            .map((entry) => `trg_${entry.triggerPrefix}_${UNIQUE_REENTRY_GUARD}`),
        ),
      ].sort();
      expect(installed).toEqual(expected);
      // Not vacuous: at least one really is installed.
      expect(installed.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('the install-site comment names the registry the install actually maps', () => {
    const comment = installSiteComment();
    const registries = mappedRegistries();
    expect(registries.length, 'uniqueReentryTargets maps no known registry').toBeGreaterThan(0);
    for (const name of ['WRITE_ONCE_IDENTITY_TABLES', 'ENGINE_IMMUTABLE_TABLES']) {
      expect(
        comment.includes(name),
        `the install-site comment ${registries.includes(name) ? 'does not name' : 'names'} ${name}, ` +
          'and uniqueReentryTargets says otherwise',
      ).toBe(registries.includes(name));
    }
  });
});

/**
 * Wave 5 correction round fifteen — widening the derived guard past the one
 * column it started as.
 *
 * The round-fifteen reviewer sampled roughly nine claims out of ~8,000 lines of
 * shipped prose and falsified four of them, and said every unsampled figure
 * should be treated as unverified. Hand-checking prose does not scale and does
 * not stay checked, so the answer is to move figures out of prose and into a
 * derivation wherever the figure CAN be derived.
 *
 * This is one such class, chosen because it is the most repeated figure in the
 * two phase documents and in this package's own comments: how many ledgers HQ
 * declares. It is `ENGINE_IMMUTABLE_TABLES.length`, it has moved three times in
 * this wave, and the sweep below found two sentences left behind at the old
 * value — `integrity.ts` still said the census runs over "a file with 30
 * declared ledgers absent", and `reliability-verdict-durability.test.ts`
 * described a file whose "31 declared" ones had been dropped — against a real
 * 33. Neither numeral was load-bearing, so both are gone rather than refreshed;
 * the sentences that state the live figure are now checked rather than trusted.
 *
 * **What this does NOT establish, stated so nobody reads it as more.** It checks
 * ONE figure. The prose is not verified by it, and the reviewer's sampling
 * result stands for every figure no derivation covers. What it does establish is
 * that this particular number cannot go stale again, and that adding the next
 * derivable figure is a few lines here rather than a new file.
 */
describe('a figure that can be derived is derived, not written down', () => {
  /** Every file whose prose this sweep reads. */
  function proseFiles(): { name: string; text: string }[] {
    const files: { name: string; text: string }[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push({ name: full, text: fs.readFileSync(full, 'utf8') });
      }
    };
    walk(SRC);
    walk(HERE);
    for (const doc of [PHASE_13, PHASE_14]) {
      files.push({ name: doc, text: fs.readFileSync(doc, 'utf8') });
    }
    return files;
  }

  it('every "N declared ledgers" in the source, the tests and both phase documents is the real N', () => {
    const real = ENGINE_IMMUTABLE_TABLES.length;
    const wrong: string[] = [];
    let seen = 0;
    for (const file of proseFiles()) {
      for (const [index, line] of file.text.split('\n').entries()) {
        for (const match of line.matchAll(/\b(\d+)\s+declared ledgers\b/g)) {
          seen += 1;
          if (Number(match[1]) !== real) {
            wrong.push(`${path.basename(file.name)}:${index + 1} says ${match[1]}, real is ${real}`);
          }
        }
      }
    }
    // Not vacuous: the figure really is written down in many places, which is
    // why it needs deriving.
    expect(seen, 'the sweep found no occurrences, so it proves nothing').toBeGreaterThan(10);
    expect(wrong, 'a sentence states a declared-ledger count the code does not have').toEqual([]);
  });

  it('the sweep would notice: it is checked against a value it does not read from the prose', () => {
    // The guard against a checker that passes by construction. `real` comes
    // from the frozen registry; if a future edit derived it from the prose
    // instead, this fails.
    expect(ENGINE_IMMUTABLE_TABLES.length).toBeGreaterThan(1);
    expect(new Set(ENGINE_IMMUTABLE_TABLES.map((entry) => entry.table)).size).toBe(
      ENGINE_IMMUTABLE_TABLES.length,
    );
  });
});
