/**
 * What the strict credential scan COSTS in ordinary Founder prose, pinned so
 * the disclosure is enforced rather than asserted (Wave 5 correction round seven,
 * Low 1).
 *
 * ## The finding
 *
 * Round four replaced the weak `key: value` heuristic at 29 facade write sites
 * with `assertBrowserSafe`, the strict shape-based scan the read boundary
 * applies. Its disclosure said "nothing that used to be refused is now
 * accepted", which is true and is only half the trade. The other half —
 * what is now REFUSED that used to be accepted — was not stated at all, and
 * two shapes carry a real cost:
 *
 *   Bearer\s+[A-Za-z0-9._-]{16,}   →  "The bearer responsibilities were
 *                                      reassigned to the shift lead."
 *   sk-[A-Za-z0-9_-]{16,}          →  "Contract with Addis-Sk-Trading-
 *                                      Corporation renewed for 2027."
 *
 * The second is not a hypothetical: it is a plausible Ethiopian business name,
 * in a product whose first tenant is an Ethiopian salt factory. A Founder who
 * types either sentence into a note gets `invalid_input`, there is no override,
 * and rephrasing is the only remedy.
 *
 * ## Why the patterns were NOT loosened
 *
 * Because this is the same function the READ boundary applies. Loosening it to
 * admit the prose loosens what may be PUBLISHED as well as what may be stored,
 * and every candidate discriminator was a real weakening of a fail-closed
 * backstop that could not be shown not to admit a genuine credential:
 *
 *  - "require a digit in the run" admits a real token that happens to have
 *    none — for a 16-character all-letter run that is a ~6.6% chance, not a
 *    rounding error;
 *  - "require a longer run" is an arbitrary number that moves the boundary
 *    without removing it.
 *
 * So the cost is disclosed instead, and pinned HERE: these exact strings must
 * stay refused. A future tightening that admits them fails this file and has to
 * move the disclosure with it, rather than silently changing the trade.
 *
 * ## And the evasion direction is not opened
 *
 * The last group proves the scan still refuses what it was hardened to refuse.
 *
 * The whole-plane sweep lives in `redaction-invisible-classes.test.ts`, in the
 * `the whole Unicode plane, swept against the guard` block: every one of the
 * 1,112,064 non-surrogate code points is pushed through `assertBrowserSafe`
 * inside `sk-…`, and no member of the zero-ink categories may survive. This
 * file is the SAMPLE that would notice a loosening made in the name of this
 * Low.
 *
 * That sentence used to read "the full-plane sweep lives in
 * `live-redaction.test.ts`", and it was false: that file's largest sweep is a
 * 65-code-point C0/C1 block, and no whole-plane sweep against the guard existed
 * anywhere in the package. It is corrected here because it is the sentence a
 * reviewer reads to decide the sweep is complete and stop looking, and it is
 * why `\p{Co}` PRIVATE USE stayed open for seven rounds (Wave 5 correction
 * round nine, Medium 2).
 */

import { describe, expect, it } from 'vitest';
import { assertBrowserSafe } from '../src/live/redaction.js';
import { assertNoSecretLikeContent } from '../src/operator/evidence.js';

function strictlyRefused(value: string): boolean {
  try {
    assertBrowserSafe({ note: value });
    return false;
  } catch {
    return true;
  }
}

function weaklyRefused(value: string): boolean {
  try {
    assertNoSecretLikeContent({ note: value } as Record<string, unknown>);
    return false;
  } catch {
    return true;
  }
}

/** Ordinary prose the weak heuristic accepted and the strict scan refuses. */
const NEWLY_REFUSED: readonly string[] = [
  'The bearer responsibilities were reassigned to the shift lead.',
  'Contract with Addis-Sk-Trading-Corporation renewed for 2027.',
];

/** Prose both checks refused — no change, and not part of the new cost. */
const ALREADY_REFUSED: readonly string[] = [
  'Our secret: nondisclosure agreements were signed by every supplier.',
  'The token: appreciation for a decade of service.',
];

describe('the strict write scan refuses some ordinary prose, and that cost is exactly this', () => {
  it('the two disclosed sentences are refused by the strict scan', () => {
    for (const sentence of NEWLY_REFUSED) {
      expect(strictlyRefused(sentence), `no longer refused: ${sentence}`).toBe(true);
    }
  });

  it('the weak heuristic accepted them — so these refusals are NEW, not pre-existing', () => {
    for (const sentence of NEWLY_REFUSED) {
      expect(weaklyRefused(sentence), `weak heuristic also refused: ${sentence}`).toBe(false);
    }
  });

  it('the other two disclosed sentences were already refused by both, and are not part of the new cost', () => {
    for (const sentence of ALREADY_REFUSED) {
      expect(weaklyRefused(sentence)).toBe(true);
      expect(strictlyRefused(sentence)).toBe(true);
    }
  });

  it('the cost is bounded: ordinary business prose around those two words is still accepted', () => {
    // The disclosure would be worthless if it were "prose containing the word
    // bearer is refused". The pattern needs a 16+ run right after it, and a
    // credential-shaped run after `sk-`; these are the near misses.
    for (const sentence of [
      'The bearer of this note is the shift lead.',
      'Bearer bonds are not an instrument this company uses.',
      'Contract with Addis-Sk-Trading renewed for 2027.',
      'The task-oriented-approach was agreed with the supplier.',
      'Mesob Salt Factory shipped 240 tonnes to Addis Ababa in Q3.',
      'Ask the supplier for a written quotation before the shift ends.',
    ]) {
      expect(strictlyRefused(sentence), `unexpectedly refused: ${sentence}`).toBe(false);
    }
  });

  it('the refusal is invalid_input-shaped: it names the path and never redacts silently', () => {
    let message = '';
    try {
      assertBrowserSafe({ note: NEWLY_REFUSED[0] }, 'stored_text');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('credential shape');
    expect(message).toContain('stored_text.note');
  });
});

describe('nothing in this disclosure loosened the evasion direction', () => {
  const KEY = 'sk-ABCDEFGHIJKLMNOP0123';

  it('the plain shape is refused', () => {
    expect(strictlyRefused(KEY)).toBe(true);
  });

  it('every zero-ink separator inside the shape is still refused', () => {
    // The classes `ERASED_CODE_POINTS` names, sampled at the code points each
    // previous round found walking through: the soft hyphen, the combining
    // grapheme joiner, a C0 and a C1 control, the line and paragraph
    // separators, a zero-width space, a Hangul filler, a tag character, and
    // the one member with an advance width, U+2800 BRAILLE PATTERN BLANK.
    for (const codePoint of [
      0x00ad, 0x034f, 0x0001, 0x001f, 0x007f, 0x0090, 0x2028, 0x2029, 0x200b, 0x200d, 0x115f,
      0xffa0, 0x180e, 0xe0001, 0x2800, 0xfeff,
    ]) {
      const split = `sk${String.fromCodePoint(codePoint)}-ABCDEFGHIJKLMNOP0123`;
      expect(
        strictlyRefused(split),
        `U+${codePoint.toString(16).toUpperCase()} splits the shape undetected`,
      ).toBe(true);
    }
  });

  it('the hyphen family, homoglyphs and an underscore-joined prefix are still refused', () => {
    expect(strictlyRefused('sk‐ABCDEFGHIJKLMNOP0123')).toBe(true);
    expect(strictlyRefused('sk－ABCDEFGHIJKLMNOP0123')).toBe(true);
    expect(strictlyRefused('ѕk-ABCDEFGHIJKLMNOP0123')).toBe(true);
    expect(strictlyRefused(`OPENAI_KEY_${KEY}`)).toBe(true);
    expect(strictlyRefused('SK-ABCDEFGHIJKLMNOP0123')).toBe(true);
  });

  it('the key rule, and the carriers a plain property walk cannot see, are still refused', () => {
    const refusedPayload = (payload: unknown) => {
      try {
        assertBrowserSafe(payload);
        return false;
      } catch {
        return true;
      }
    };
    expect(refusedPayload({ apiKey: 'value-here' })).toBe(true);
    expect(refusedPayload({ 'арiKey': 'value-here' })).toBe(true);
    expect(refusedPayload({ m: new Map([['apiKey', 'value-here']]) })).toBe(true);
    expect(refusedPayload({ s: new Set([KEY]) })).toBe(true);
    expect(refusedPayload({ t: { toJSON: () => KEY } })).toBe(true);
  });
});
