/**
 * The backup refusal vocabulary is COUNTED FROM THE CONSTANT, never by hand
 * (Wave 5 correction round eleven, MEDIUM 2).
 *
 * ## What was open
 *
 * `PHASE_13_ADVANCED_RELIABILITY.md` said "Thirteen categorical refusals, never
 * an exception:" and then listed thirteen, while `BACKUP_REFUSAL_REASONS` held
 * SIXTEEN. The three missing from the list — `file_has_multiple_links`,
 * `candidate_is_the_live_database` and `would_latch_safe_mode` — were each
 * added by an earlier round of this same wave, and each left the count behind.
 * Two more sentences carried the same stale denominator ("ten of the thirteen
 * are exercised", "ten of the thirteen backup path protections"), and
 * `grep -rn BACKUP_REFUSAL_REASONS packages/headquarter/test/` returned
 * nothing: no test pinned the count, the enumeration, or the split.
 *
 * ## What this file pins
 *
 * All three, derived. The count word in the document must equal the constant's
 * length; every member must be named in the document; and the exercised /
 * not-exercised split must be the one the test directory actually produces,
 * with the not-exercised members named in the document by their own names.
 *
 * This is deliberately a DOCUMENT test. A count in prose is exactly the kind of
 * claim that stops being true silently, and this wave had shipped a false
 * completeness sentence in eight separate rounds before this one.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_REFUSAL_REASONS, type BackupRefusalReason } from '../src/store/integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = HERE;
const PHASE_13 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_13_ADVANCED_RELIABILITY.md',
);

/** English for the counts this vocabulary can plausibly reach. */
const NUMBER_WORDS: readonly string[] = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

function word(count: number): string {
  const value = NUMBER_WORDS[count];
  if (!value) throw new Error(`no English word recorded for ${count}`);
  return value;
}

/**
 * Every `.ts` file under `test/` EXCEPT this one, so the split is measured
 * rather than claimed — and so this file naming the three unexercised reasons,
 * in order to assert that they are unexercised, cannot make them look
 * exercised.
 */
const SELF = path.basename(fileURLToPath(import.meta.url));

function testSources(): string {
  return fs
    .readdirSync(TEST_DIR)
    .filter((entry) => entry.endsWith('.ts') && entry !== SELF)
    .map((entry) => fs.readFileSync(path.join(TEST_DIR, entry), 'utf8'))
    .join('\n');
}

/**
 * A refusal is EXERCISED when some test names it as a quoted literal.
 *
 * Not a perfect proxy for "a test crosses that branch", and stated as what it
 * is: it is the property the document's own sentence claims ("exercised against
 * real files on disk"), measured the only way a suite can measure itself
 * cheaply, and it is strictly better than a hand count that was wrong three
 * times.
 */
function exercised(): BackupRefusalReason[] {
  const sources = testSources();
  return BACKUP_REFUSAL_REASONS.filter((reason) => sources.includes(`'${reason}'`));
}

describe('the backup refusal vocabulary matches what the phase document says', () => {
  it('is not vacuous: the constant is a non-trivial closed list', () => {
    expect(BACKUP_REFUSAL_REASONS.length).toBeGreaterThan(10);
    expect(new Set(BACKUP_REFUSAL_REASONS).size).toBe(BACKUP_REFUSAL_REASONS.length);
    expect(Object.isFrozen(BACKUP_REFUSAL_REASONS)).toBe(true);
  });

  it('the document COUNTS what the constant holds', () => {
    const doc = fs.readFileSync(PHASE_13, 'utf8');
    expect(doc).toContain(`${word(BACKUP_REFUSAL_REASONS.length)} categorical\nrefusals`);
    // And no stale denominator survives anywhere else in the file.
    for (const stale of NUMBER_WORDS.slice(2)) {
      if (stale === word(BACKUP_REFUSAL_REASONS.length)) continue;
      expect(
        doc.includes(`${stale.toLowerCase()} categorical refusals`) ||
          doc.includes(`${stale} categorical\nrefusals`),
        `the document still says "${stale} categorical refusals"`,
      ).toBe(false);
    }
  });

  it('the document NAMES every member', () => {
    const doc = fs.readFileSync(PHASE_13, 'utf8');
    const missing = BACKUP_REFUSAL_REASONS.filter((reason) => !doc.includes(`\`${reason}\``));
    expect(missing, 'a refusal reason the phase document does not name').toEqual([]);
  });

  it('the exercised / not-exercised split is measured, and the document agrees', () => {
    const doc = fs.readFileSync(PHASE_13, 'utf8');
    const covered = exercised();
    const uncovered = BACKUP_REFUSAL_REASONS.filter((reason) => !covered.includes(reason));
    // The document states the split twice; both must carry the same, real
    // numbers, and both denominators must be the constant's length.
    expect(doc).toContain(
      `${word(covered.length)} of the ${word(BACKUP_REFUSAL_REASONS.length).toLowerCase()} are exercised`,
    );
    expect(doc).toContain(
      `${word(covered.length).toLowerCase()} of the ${word(
        BACKUP_REFUSAL_REASONS.length,
      ).toLowerCase()} backup refusals`,
    );
    // The ones no test names must be exactly the ones the document excuses by
    // name, so "the three that are not" can never quietly become four.
    expect([...uncovered].sort()).toEqual(
      ['file_too_large', 'path_not_readable', 'verification_copy_failed'].sort(),
    );
    for (const reason of uncovered) {
      expect(doc, `${reason} is unexercised and unexcused`).toContain(`\`${reason}\``);
    }
  });
});
