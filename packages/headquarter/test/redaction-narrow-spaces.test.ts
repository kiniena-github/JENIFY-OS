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

/**
 * Round eleven, Low 2 — the fold's cost sentence claimed something the fold
 * does not do.
 *
 * `redaction.ts` said, of this fold and of the combining-mark fold beside it,
 * that erasing a character "cannot introduce a letter, so it cannot build
 * `sk-`, `ghp_`, `AIza`, a PEM header, a JWT or `Bearer ` out of prose that did
 * not carry one". The first clause is true and the inference from it is false.
 * REMOVING a separator concatenates whatever sat on either side of it, so the
 * scan copy can contain a contiguous prefix that no contiguous run of the
 * original contained. The paragraph half-conceded it two sentences later —
 * "What it CAN do is close a gap" — while the sentence above still said the
 * opposite.
 *
 * The residual is not under-priced and the fold stays: every case below is a
 * REFUSAL, which is the conservative direction — an availability cost on a
 * contrived string, never a leak — and none of them is prose. What was wrong
 * was the sentence, so the sentence is corrected and this block is what makes
 * the corrected version checkable instead of merely more careful.
 */
describe('the fold cannot introduce a letter, but joining two tokens can still build a prefix', () => {
  /**
   * The separator between the two halves is a character the fold ERASES, and
   * neither half is a credential prefix on its own. Both are written out of
   * escapes rather than typed, so the separator is unambiguous in the source.
   */
  const HAIR = '\u200a';
  const IDEOGRAPHIC = '\u3000';

  it('refuses a prefix that exists only once the separator between its halves is erased', () => {
    const joined: readonly (readonly [string, string])[] = [
      [`the gh${HAIR}p_abcdefghijklmnopqrst`, 'ghp_ built across U+200A'],
      [`AI${IDEOGRAPHIC}za0123456789abcdefghij`, 'AIza built across U+3000'],
      [`Bear${HAIR}er 0123456789abcdefghij`, 'Bearer built across U+200A'],
    ];
    for (const [value, why] of joined) {
      // The RAW string carries no such prefix, so this is not the guard's
      // raw-string arm firing: the fold is what creates the shape.
      expect(value, why).not.toMatch(/ghp_|AIza|Bearer /);
      expect(() => assertBrowserSafe({ note: value }), why).toThrow();
    }
  });

  it('admits the identical shapes when the separator is one the fold leaves alone', () => {
    // U+0020 is deliberately NOT folded. The same three strings with a plain
    // space are admitted, which isolates the JOIN as the whole cause of the
    // refusals above rather than anything else in the guard.
    expect(() => assertBrowserSafe({ note: 'the gh p_abcdefghijklmnopqrst' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: 'AI za0123456789abcdefghij' })).not.toThrow();
    expect(() => assertBrowserSafe({ note: 'Bear er 0123456789abcdefghij' })).not.toThrow();
  });

  it('says that in the source, in both places, and no longer says the opposite', () => {
    const prose = fs.readFileSync(REDACTION, 'utf8').replace(/\s+\*?\s*/g, ' ');
    // The retired INFERENCE, by its exact shape, so a revert cannot bring it
    // back quietly. It was written twice — once for the separator fold and
    // once for the combining-mark fold beside it.
    //
    // What is pinned is the step from the true premise to the false
    // conclusion, and not the words of the conclusion itself: both paragraphs
    // now QUOTE the sentence they retired, which is this wave's rule for a
    // correction, so a `not.toContain` on the quoted wording would forbid
    // recording the history. The premise is still there, the conclusion is
    // still quoted, and the join between them is what may never return.
    expect(prose).not.toContain('it cannot introduce a letter, so it');
    expect(prose).not.toContain('cannot introduce a letter, so it cannot build');
    // What replaces it, in both places: the letter claim survives untouched,
    // the false inference from it is gone, and the join is stated instead.
    expect([...prose.matchAll(/cannot introduce a letter/g)]).toHaveLength(2);
    expect([...prose.matchAll(/can join adjacent tokens/g)]).toHaveLength(2);
  });
});
