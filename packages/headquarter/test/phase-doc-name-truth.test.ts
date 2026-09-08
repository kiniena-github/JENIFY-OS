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
