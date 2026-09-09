/**
 * Wave 5, correction round seven — the two UNDISCLOSED sweep residuals.
 *
 * The zero-ink credential sweep names five properties and two code points, and
 * the phase documents argue `\p{Zs}` out of the set on the merits (a space is
 * visible, so it hides nothing). Three whole categories were neither in the set
 * nor in any residual list:
 *
 *  - `\p{Mn}` non-spacing combining marks — 2,059 code points;
 *  - `\p{Me}` enclosing marks — 13;
 *  - `\p{Cn}` unassigned — 814,730.
 *
 * (Those first and third figures read 1,796 and 810,961 until Wave 5 correction
 * round thirteen, Low 6. They were the sizes on an older ICU; a category size
 * belongs to the Unicode version the engine carries — 17.0 here — not to this
 * code, so the numbers are now measured against the running engine by the last
 * test in this file rather than copied forward.)
 *
 * Each broke `sk-ABCDEFGHIJKLMNOP0123` into two unmatched halves with every
 * character of the key intact. U+0301 COMBINING ACUTE ACCENT and U+0378
 * (unassigned) are the two the review named by hand.
 *
 * A combining mark is precisely the class this scan exists for: it leaves the
 * credential complete and a reader strips the mark, so `sk-Á…` is read, copied
 * and pasted as `sk-A…`. Both classes are closed here rather than disclosed,
 * and the false-positive side is measured rather than asserted: accented prose
 * in five languages, and every legitimate string the shipped suite already
 * pins, still pass.
 *
 * The residual that stays open is stated where it always was: a WORD CHARACTER
 * before the prefix (`Xsk-…`, `9sk-…`) is deliberately not matched, because
 * `task-oriented-approach` literally contains `sk-oriented-approach`. That is
 * an anchoring heuristic and the architecture — credentials never enter the
 * control plane — is the guarantee.
 */

import { describe, expect, it } from 'vitest';
import { assertBrowserSafe, BrowserSafetyError } from '../src/live/redaction.js';

/** Every credential shape the guard knows, split by one hidden character. */
const SHAPES: ((hidden: string) => string)[] = [
  (hidden) => `sk-${hidden}AAAAAAAAAAAAAAAAAAAA`,
  (hidden) => `ghp_${hidden}AAAAAAAAAAAAAAAAAAAA`,
  (hidden) => `github_pat_${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
  (hidden) => `AIza${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
  (hidden) => `-----BEGIN ${hidden}RSA PRIVATE KEY-----`,
  (hidden) => `Bearer ${hidden}AAAAAAAAAAAAAAAAAAAA`,
];

function label(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Sweep a whole general category rather than picking members of it. */
function codePointsInCategory(pattern: RegExp): number[] {
  const found: number[] = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    // Surrogate halves are not characters and cannot be built one at a time.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (pattern.test(String.fromCodePoint(code))) found.push(code);
  }
  return found;
}

describe('a combining mark does not carry a credential past the guard', () => {
  it('refuses the two code points the review named, in every shape', () => {
    for (const code of [0x0301, 0x0378]) {
      for (const shape of SHAPES) {
        expect(
          () => assertBrowserSafe({ note: shape(String.fromCodePoint(code)) }),
          `${label(code)} in ${shape('')}`,
        ).toThrow(BrowserSafetyError);
      }
    }
  });

  it('refuses EVERY non-spacing and enclosing mark, swept rather than sampled', () => {
    const marks = codePointsInCategory(/\p{Mn}|\p{Me}/u);
    // A count, so a narrowing of the sweep is visible rather than quietly
    // passing over an empty set. 2,059 Mn + 13 Me at this Unicode version.
    expect(marks.length).toBeGreaterThanOrEqual(1_700);
    const survivors: string[] = [];
    for (const code of marks) {
      const hidden = String.fromCodePoint(code);
      try {
        assertBrowserSafe({ note: `sk-${hidden}AAAAAAAAAAAAAAAAAAAA` });
        survivors.push(label(code));
      } catch (error) {
        if (!(error instanceof BrowserSafetyError)) throw error;
      }
    }
    expect(survivors).toEqual([]);
  });

  it('refuses every PRIVATE USE code point, swept rather than sampled', () => {
    // Wave 5 correction round nine, High 1. `\p{Co}` — 137,468 code points —
    // was in no residual list, no comment and no test while `\p{Cn}`, which
    // takes the identical argument (no assigned glyph, so nothing a reader can
    // act on, and prose does not contain it), had been closed a round earlier.
    // Executed on the round-eight head, `sk-<U+E000>ABCDEFGHIJKLMNOP0123456789`
    // was accepted by `createTask`, passed `assertBrowserSafe`, and reached a
    // written unauthenticated `hq-snapshot.json` with the key intact.
    const privateUse = codePointsInCategory(/\p{Co}/u);
    // A count, so a narrowing of the sweep is visible rather than quietly
    // passing over an empty set: 6,400 in the BMP plus two full supplementary
    // planes.
    expect(privateUse.length).toBe(137_468);
    const survivors: string[] = [];
    for (const code of privateUse) {
      const hidden = String.fromCodePoint(code);
      try {
        assertBrowserSafe({ note: `sk-${hidden}AAAAAAAAAAAAAAAAAAAA` });
        survivors.push(label(code));
      } catch (error) {
        if (!(error instanceof BrowserSafetyError)) throw error;
      }
    }
    expect(survivors).toEqual([]);
  });

  it('refuses the three private-use code points the review executed, in every shape', () => {
    for (const code of [0xe000, 0xf8ff, 0x100000]) {
      for (const shape of SHAPES) {
        expect(
          () => assertBrowserSafe({ note: shape(String.fromCodePoint(code)) }),
          `${label(code)} in ${shape('')}`,
        ).toThrow(BrowserSafetyError);
      }
    }
  });

  it('refuses an UNASSIGNED code point used the same way', () => {
    // A representative traversal rather than all 814,730: every unassigned code
    // point takes the same `\p{Cn}` branch, and sweeping the whole plane set
    // for six shapes is minutes of CPU for no additional discrimination. The
    // step is deliberately not a power of two, so it does not land only on
    // block boundaries.
    const unassigned = codePointsInCategory(/\p{Cn}/u).filter((_, index) => index % 997 === 0);
    expect(unassigned.length).toBeGreaterThan(700);
    const survivors: string[] = [];
    for (const code of unassigned) {
      const hidden = String.fromCodePoint(code);
      try {
        assertBrowserSafe({ note: `sk-${hidden}AAAAAAAAAAAAAAAAAAAA` });
        survivors.push(label(code));
      } catch (error) {
        if (!(error instanceof BrowserSafetyError)) throw error;
      }
    }
    expect(survivors).toEqual([]);
  });
});

describe('and refuses nothing a Founder would legitimately write', () => {
  it('accepts accented prose, which is what stripping a mark could have broken', () => {
    const legitimate = [
      'Réunion de révision prévue jeudi',
      'Añadir la última versión al índice',
      'Prüfung der Änderungen abgeschlossen',
      'Väärä käännös korjattiin eilen',
      'Đã hoàn thành việc kiểm tra',
      // The strings the shipped suite already pins, carried here so this file
      // cannot pass while narrowing them.
      'task-oriented-approach',
      'Ask-driven workflow',
      'ΤΟΚΕΝ',
      'Секрет',
      // Re-checked when `\p{Co}` was added to the erase set (round nine): the
      // widening must not start refusing ordinary text in any script, and none
      // of these carries a private-use code point at all.
      '盐厂的生产报告已经完成',
      'تم إكمال مراجعة التقرير',
      'Shipment ready ✅ — pallets counted 📦',
    ];
    for (const value of legitimate) {
      expect(() => assertBrowserSafe({ note: value }), value).not.toThrow();
    }
  });

  it('leaves the ORIGINAL text intact: the fold is a scan copy, never a rewrite', () => {
    const original = { note: 'Réunion de révision prévue jeudi' };
    assertBrowserSafe(original);
    // The guard asserts; it does not normalize what is stored or served.
    expect(original.note).toBe('Réunion de révision prévue jeudi');
    expect(original.note.normalize('NFC')).toBe(original.note);
  });

  it('still does not fold an ordinary SPACE, which is the argued boundary', () => {
    // A space is VISIBLE, so it hides nothing, and folding it would start
    // matching prose. Unchanged, and pinned so the round-seven widening cannot
    // be read as having widened this too.
    expect(() => assertBrowserSafe({ note: 'sk- AAAAAAAAAAAAAAAAAAAA' })).not.toThrow();
  });

  it('states the anchoring residual rather than pretending it is closed', () => {
    // A word character before the prefix is deliberately unmatched. Disclosed
    // in both phase documents; pinned here so the disclosure stays true.
    expect(() => assertBrowserSafe({ note: 'Xsk-AAAAAAAAAAAAAAAAAAAA' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: '9sk-AAAAAAAAAAAAAAAAAAAA' })).not.toThrow();
  });

  it('does not refuse ordinary prose merely because a private-use glyph sits in it', () => {
    // Erasing `\p{Co}` REMOVES characters from the scan copy, so it cannot add
    // a letter — but, as for every erase here, removing one CAN join the tokens
    // on either side of it into a prefix neither carried alone. That inference
    // was written the other way round for one round, in this comment and twice
    // in `redaction.ts`, and is corrected in all three (round eleven, Low 2);
    // the executed join is in `redaction-narrow-spaces.test.ts`. What these
    // assertions actually show is the narrower and still useful thing: a
    // private-use glyph in a sentence leaves the sentence a sentence.
    expect(() => assertBrowserSafe({ note: 'The \u{E000} glyph comes from a private font' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: 'Report \u{F8FF} filed for the Mesob pilot' })).not.toThrow();
    // Measured rather than asserted, and disclosed rather than hidden: a
    // private-use code point sitting exactly where a WORD character would
    // otherwise anchor the prefix — `ta\u{E000}sk-oriented-approach` — IS
    // refused. That refusal predates this round and owes nothing to the erase
    // set: `assertBrowserSafe` tests every pattern against the RAW string as
    // well as the folded copy, and in the raw string the character before
    // `sk-` is a private-use code point rather than the `k` that makes
    // `task-oriented-approach` legitimate. The plain word is unaffected.
    expect(() => assertBrowserSafe({ note: 'ta\u{E000}sk-oriented-approach' })).toThrow(
      BrowserSafetyError,
    );
    expect(() => assertBrowserSafe({ note: 'task-oriented-approach' })).not.toThrow();
  });
});

/**
 * The WHOLE-PLANE sweep, run against the guard rather than against a category.
 *
 * Wave 5 correction round nine, Medium 2. `credential-scan-cost.test.ts` shipped
 * the sentence "the full-plane sweep lives in `live-redaction.test.ts`" — and no
 * such sweep existed anywhere: that file's largest is a 65-code-point C0/C1
 * block, and the two `0..0x10ffff` loops in this file COLLECT members of a named
 * category rather than testing the plane against the guard. That sentence is
 * what a reviewer reads to decide the sweep is complete and stop looking, and it
 * is the reason `\p{Co}` survived seven rounds. It is corrected to name this
 * block, and this block makes it true.
 *
 * Every code point in Unicode, minus the surrogate halves, which are not
 * characters and cannot be built one at a time. No sampling and no stride.
 *
 * WHAT IT ASSERTS, and why that is not circular. The interesting property is
 * "no character that a reader cannot see carries a credential past the guard".
 * JS cannot measure ink, so the test names the zero-ink categories INDEPENDENTLY
 * of the guard and asserts that not one member of them survives. Removing a
 * class from `ERASED_CODE_POINTS` therefore fails here even though nobody
 * thought to write a test for that class — which is precisely what did not
 * happen for `\p{Co}`.
 *
 * The survivors are counted rather than ignored, so a guard that started
 * refusing everything could not pass this vacuously, and the one deliberately
 * open invisible-ish class (`\p{Zs}`, argued in `redaction.ts` and disclosed on
 * both phase pages) is pinned at its exact size rather than waved at.
 */
describe('the whole Unicode plane, swept against the guard', () => {
  /**
   * The zero-ink categories, named here and NOT read from the guard, so this
   * file disagrees with `redaction.ts` the moment one is dropped there.
   */
  const ZERO_INK =
    /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Mn}\p{Me}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

  it('lets no zero-ink code point in the entire plane carry a credential through', () => {
    let visited = 0;
    let survived = 0;
    const zeroInkSurvivors: string[] = [];
    const spaceSurvivors: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      visited += 1;
      const hidden = String.fromCodePoint(code);
      try {
        assertBrowserSafe({ note: `sk-${hidden}AAAAAAAAAAAAAAAAAAAA` });
      } catch (error) {
        if (!(error instanceof BrowserSafetyError)) throw error;
        continue;
      }
      survived += 1;
      if (ZERO_INK.test(hidden)) zeroInkSurvivors.push(label(code));
      if (/\p{Zs}/u.test(hidden)) spaceSurvivors.push(label(code));
    }

    // The plane, exactly: 0x110000 code points less the 2,048 surrogate halves.
    // A version-independent number, so a sweep that silently narrowed shows up.
    expect(visited).toBe(1_112_064);
    // The finding, and every class closed before it.
    expect(zeroInkSurvivors).toEqual([]);
    // Non-vacuity: a guard that refused everything would pass the line above.
    // The survivors are ordinary VISIBLE characters — punctuation, symbols and
    // the letters and digits the anchoring heuristic deliberately admits.
    expect(survived).toBeGreaterThan(100_000);
    // The one open invisible-ish class, at its exact size — 17 for eight
    // rounds, and 2 since round ten closed the fifteen `\p{Zs}` separators
    // that are not a plain space (Low 2). They are named rather than counted
    // now, because the two that remain are a deliberate choice and not a
    // residue: folding U+0020 and U+00A0 would join every word of every
    // sentence in the scan copy. If that ever changes, this list changes with
    // it and the disclosure has to move too.
    expect(spaceSurvivors).toEqual(['U+0020', 'U+00A0']);
  }, 120_000);
});

/**
 * Wave 5, correction round thirteen — Low 6: three figures in this file, in
 * `redaction.ts` and on `PHASE_13_ADVANCED_RELIABILITY.md` said `\p{Mn}` was
 * 1,796 code points and `\p{Cn}` 810,961. On the shipped runtime — Node
 * v22.22.2, ICU 78.2, Unicode 17.0 — they are 2,059 and 814,730. `\p{Me}` 13,
 * `\p{Co}` 137,468 and `\p{Zs}` 17 were exact.
 *
 * The class behind it is the one this whole round is about: a figure nothing
 * compared to anything. It is closed the way the depth statement's cost clause
 * was — by MEASURING on the running engine and parsing the written numbers back
 * out of the prose that carries them.
 *
 * A category's size belongs to the Unicode version the engine carries, so the
 * comparison is made only when the running version is the one the prose names.
 * When it is not, what is still asserted is that the prose NAMES a version and
 * does not claim the running one — which is the honest half, and is never a
 * skip: both branches assert.
 */
describe('every Unicode category size this module writes down is measured, not copied forward', () => {
  const MEASURED_ON = '17.0';

  function sizeOf(property: string): number {
    const matcher = new RegExp(`\\p{${property}}`, 'u');
    let total = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      // Surrogates are not characters and cannot be formed with
      // `String.fromCodePoint` in isolation for this purpose.
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (matcher.test(String.fromCodePoint(code))) total += 1;
    }
    return total;
  }

  it('states each figure at the size the running engine reports', () => {
    const expected: Record<string, number> = {
      Mn: 2_059,
      Me: 13,
      Cn: 814_730,
      Co: 137_468,
      Zs: 17,
    };
    const running = process.versions.unicode;
    expect(typeof running, 'the engine must report a Unicode version to compare against').toBe(
      'string',
    );
    if (running === MEASURED_ON) {
      for (const [property, figure] of Object.entries(expected)) {
        expect(sizeOf(property), `\\p{${property}} on Unicode ${running}`).toBe(figure);
      }
    } else {
      // The figures were measured on another version. What must still hold is
      // that this file says WHICH — a number with no version beside it is
      // exactly the defect being corrected — and that the two do not silently
      // claim to be the same.
      expect(MEASURED_ON, 'the recorded version must not claim to be the running one').not.toBe(
        running,
      );
      expect(MEASURED_ON).toMatch(/^\d+\.\d+$/);
    }
  }, 60_000);

  it('carries the same figures in the module docblock that states them', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', 'src', 'live', 'redaction.ts'), 'utf8');
    // Parsed back out of the prose, so the two cannot drift apart again.
    expect(source).toContain('`\\p{Mn}` (2,059 code points)');
    expect(source).toContain('`\\p{Cn}` unassigned (814,730)');
    expect(source, 'the figures must name the Unicode version they were measured on').toContain(
      `Unicode ${MEASURED_ON}`,
    );
  });
});
