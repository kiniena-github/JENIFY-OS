/**
 * Wave 5, correction round seven — the two UNDISCLOSED sweep residuals.
 *
 * The zero-ink credential sweep names five properties and two code points, and
 * the phase documents argue `\p{Zs}` out of the set on the merits (a space is
 * visible, so it hides nothing). Three whole categories were neither in the set
 * nor in any residual list:
 *
 *  - `\p{Mn}` non-spacing combining marks — 1,796 code points;
 *  - `\p{Me}` enclosing marks — 13;
 *  - `\p{Cn}` unassigned — 810,961.
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
    // passing over an empty set. 1,796 Mn + 13 Me at this Unicode version.
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

  it('refuses an UNASSIGNED code point used the same way', () => {
    // A representative traversal rather than all 810,961: every unassigned code
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
});
