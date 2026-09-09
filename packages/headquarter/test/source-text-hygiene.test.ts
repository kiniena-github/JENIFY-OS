/**
 * Wave 5, correction round seven — LOW NEW-7: a source file the repository's own
 * text tooling could not read.
 *
 * `test/connectors.github.test.ts` carried a raw U+0007 BEL at byte 4903 and a
 * raw U+202E RIGHT-TO-LEFT OVERRIDE beside it, so `git diff` rendered the file
 * as `Bin 9424 -> 9429 bytes` — invisible to review, to `grep`, and to every
 * other text tool the repository relies on. That is the exact hazard the NUL in
 * the same string literal was escaped to avoid, left in place two characters
 * later.
 *
 * Both are escaped now, which is the same STRING and a readable FILE: `git
 * diff` renders that change as one line out, one line in.
 *
 * This test is the derived assertion that keeps it that way. No source file in
 * the package may carry a raw control character or a raw bidi control, whatever
 * a future test needs to exercise — a test that needs one spells it as an
 * escape, exactly as that one now does. This file obeys its own rule: every
 * hostile code point below is named as a NUMBER, never typed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** Every `.ts` file in the package's own source and test trees. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The characters that make a text file unreadable to text tooling, or that
 * reorder what a reviewer sees without changing what the compiler reads.
 *
 * TAB (9), LF (10) and CR (13) are ordinary source whitespace and are
 * deliberately not in the set. Everything else in C0/C1 is, and so are the bidi
 * marks, embeddings, overrides and isolates.
 *
 * Given as inclusive numeric ranges rather than as a character class, because a
 * character class would have to CONTAIN the characters this file exists to keep
 * out of source.
 */
const HOSTILE_RANGES: readonly [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isHostile(code: number): boolean {
  return HOSTILE_RANGES.some(([low, high]) => code >= low && code <= high);
}

describe('the package’s own source is readable by the tools the repository uses', () => {
  it('carries no raw control character and no raw bidi control in any .ts file', () => {
    const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'test'))];
    // A floor, so a narrowing of the walk is visible rather than passing over
    // an empty set.
    expect(files.length).toBeGreaterThanOrEqual(250);
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (!isHostile(code)) continue;
        offenders.push(
          `${path.relative(ROOT, file)}:${index} U+${code
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still exercises the characters it needs to, spelled as escapes', () => {
    // The point is the SPELLING, not the coverage: the test that carried the
    // raw bytes asserts exactly what it asserted before, on the same string.
    const source = fs.readFileSync(path.join(ROOT, 'test', 'connectors.github.test.ts'), 'utf8');
    // The escape SPELLING that must appear in that file, written here without
    // typing one of the characters it denotes.
    const spelling = "'a\\u0000b\\u202Ec\\u0007d'";
    expect(source).toContain(spelling);
    // And the string that spelling denotes is the same seven characters the raw
    // bytes used to be. JSON understands the same `\uXXXX` escapes JavaScript
    // does, so this DECODES the spelling rather than restating it.
    const denoted = [0x61, 0x00, 0x62, 0x202e, 0x63, 0x07, 0x64]
      .map((code) => String.fromCodePoint(code))
      .join('');
    expect(JSON.parse(`"${spelling.slice(1, -1)}"`)).toBe(denoted);
  });
});
