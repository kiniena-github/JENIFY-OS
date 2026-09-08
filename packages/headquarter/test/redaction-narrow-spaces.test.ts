/**
 * Wave 5, correction round ten — the two Lows a fresh hostile review of
 * `6ce93df` reproduced against the credential guard.
 *
 *  - **LOW 1 — the phase document stated an anchor that would REOPEN this
 *    wave's own Critical.** `PHASE_13_ADVANCED_RELIABILITY.md` wrote the
 *    negative lookbehind as `(?<![A-Za-z0-9_])`. The code has never had the
 *    underscore, and must not: `_` inside the class is the `\b` behaviour that
 *    carried `OPENAI_KEY_sk-…` onto the unauthenticated artifact (round four,
 *    Critical C1). The code was stronger than the document said, which is the
 *    direction that gets "corrected" the wrong way by a future reader.
 *  - **LOW 2 — the `\p{Zs}` residual was retained on a justification whose only
 *    worked example does not hold.** The comment said folding the class "would
 *    join ordinary prose into fabricated credential shapes
 *    (`...ask -driven-workflow`)". Reverted-to-test on a scratch copy with
 *    `\p{Zs}` folded, across a 40-string corpus, exactly ONE verdict changed
 *    and it was contrived; the example itself is still accepted, because the
 *    anchor sees the `a` of `ask`. Meanwhile the residual carried a whole key
 *    onto the unauthenticated artifact for every member of the class, and the
 *    "a space is visible, so it hides nothing" argument is at its weakest for
 *    U+2007 FIGURE SPACE and U+200A HAIR SPACE.
 *
 * The fix folds the fifteen `\p{Zs}` separators that are not a plain space, and
 * leaves U+0020 and U+00A0 alone. The measured cost is pinned here rather than
 * asserted: the typography that actually uses those separators — French narrow
 * no-break and thin spaces, Japanese and Chinese ideographic spacing — is run
 * against the guard and must keep passing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertBrowserSafe } from '../src/live/redaction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REDACTION = path.join(HERE, '..', 'src', 'live', 'redaction.ts');
const PHASE_13 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_13_ADVANCED_RELIABILITY.md',
);

/** The `\p{Zs}` members that are NOT a plain space, one per code point. */
const NARROW_SPACES: readonly number[] = [
  0x1680,
  ...Array.from({ length: 11 }, (_, index) => 0x2000 + index),
  0x202f,
  0x205f,
  0x3000,
];

/** The two the design keeps, on the argument that survived the measurement. */
const PLAIN_SPACES: readonly number[] = [0x0020, 0x00a0];

function label(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** The credential shapes, each split by ONE hidden character. */
function shapes(hidden: string): [string, string][] {
  return [
    ['openai', `sk-${hidden}ABCDEFGHIJKLMNOP0123456789`],
    ['github', `ghp_${hidden}ABCDEFGHIJKLMNOP0123456789`],
    ['github pat', `github_pat_${hidden}ABCDEFGHIJKLMNOP0123456789XYZ`],
    ['google', `AIza${hidden}ABCDEFGHIJKLMNOP0123456789`],
    ['bearer', `Bearer x${hidden}ABCDEFGHIJKLMNOP0123456789`],
  ];
}

describe('the fifteen narrow Zs separators no longer carry a credential to the artifact', () => {
  it('refuses every one of them in every credential shape', () => {
    for (const code of NARROW_SPACES) {
      for (const [shape, value] of shapes(String.fromCodePoint(code))) {
        expect(
          () => assertBrowserSafe({ note: value }),
          `${label(code)} in ${shape}`,
        ).toThrow();
      }
    }
  });

  it('keeps the two ordinary spaces admitted, which is the boundary that survived', () => {
    // Folding these would join every word of every sentence in the scan copy.
    // The residual is real and stays stated: a key broken by a plain space
    // still reaches the artifact.
    for (const code of PLAIN_SPACES) {
      expect(() =>
        assertBrowserSafe({ note: `sk-${String.fromCodePoint(code)}ABCDEFGHIJKLMNOP0123456789` }),
        label(code),
      ).not.toThrow();
    }
  });

  it('erases them BEFORE normalization, because NFKC destroys the distinction', () => {
    // Fourteen of the fifteen have a compatibility decomposition to U+0020, so
    // an entry in `ERASED_CODE_POINTS` — which runs after NFKC — is a no-op for
    // them. This asserts the property the ordering rests on, so a refactor that
    // moves the fold later fails here rather than silently reopening the hole.
    for (const code of NARROW_SPACES) {
      const decomposed = String.fromCodePoint(code).normalize('NFKD');
      if (code === 0x1680) {
        expect(decomposed, label(code)).toBe(String.fromCodePoint(code));
      } else {
        expect(decomposed, label(code)).toBe(' ');
      }
    }
  });
});

describe('and refuses nothing the typography that uses those separators writes', () => {
  it('accepts French narrow-space and thin-space punctuation and grouped numbers', () => {
    const legitimate = [
      'Le mot de passe : le mot',
      'Le secret : les notes de la réunion',
      'password : le mot',
      'token : abc def ghi',
      'api_key : la clé',
      'Total : 1 234 567 kg',
      'secret : mots courts ici',
      'Réunion de révision prévue jeudi',
    ];
    for (const value of legitimate) {
      expect(() => assertBrowserSafe({ note: value }), value).not.toThrow();
    }
  });

  it('accepts Japanese and Chinese prose spaced with the ideographic space', () => {
    const legitimate = [
      '盐厂的生产报告　已经完成',
      'テスト　データ　完了',
      'password　：テスト',
    ];
    for (const value of legitimate) {
      expect(() => assertBrowserSafe({ note: value }), value).not.toThrow();
    }
  });

  it('accepts the example the retired justification was built on, which is why it was retired', () => {
    // The comment claimed folding `\p{Zs}` would refuse this. It does not: the
    // anchor sees the `a` of `ask` in front of `sk`, and the run is far too
    // short for `{16,}`. Pinned so the retired sentence cannot come back.
    expect(() => assertBrowserSafe({ note: '...ask -driven-workflow' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: 'ask -driven-workflow' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: 'Ask -driven workflow' })).not.toThrow();
  });
});

describe('the anchor the phase document states is the anchor the code has', () => {
  const source = fs.readFileSync(REDACTION, 'utf8');
  const doc = fs.readFileSync(PHASE_13, 'utf8');

  it('spells the lookbehind without an underscore, in the code and in the document', () => {
    // Read out of the source rather than retyped, so the two cannot drift.
    const anchors = [...source.matchAll(/\(\?<!\[[^\]]*\]\)/g)].map((match) => match[0]);
    expect(anchors.length).toBeGreaterThan(5);
    expect([...new Set(anchors)]).toEqual(['(?<![A-Za-z0-9])']);
    // The document stated `(?<![A-Za-z0-9_])` for one round. `_` inside the
    // class is exactly the `\b` behaviour that let `OPENAI_KEY_sk-…` onto the
    // unauthenticated artifact, so a document that says it invites the fix to
    // be undone.
    expect(doc).not.toContain('(?<![A-Za-z0-9_])');
    expect(doc).toContain('(?<![A-Za-z0-9])');
  });

  it('behaves the way the corrected sentence says, on both sides of the boundary', () => {
    // Refused: an underscore-joined prefix IS a boundary.
    expect(() => assertBrowserSafe({ note: 'OPENAI_KEY_sk-ABCDEFGHIJKLMNOP0123' })).toThrow();
    expect(() => assertBrowserSafe({ note: '_sk-ABCDEFGHIJKLMNOP0123' })).toThrow();
    // Admitted, and disclosed as such: a letter or digit run is not.
    expect(() => assertBrowserSafe({ note: 'Xsk-ABCDEFGHIJKLMNOP0123' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: '9sk-ABCDEFGHIJKLMNOP0123' })).not.toThrow();
  });
});
