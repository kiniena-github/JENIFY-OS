/**
 * Browser-safety guard (issue #200).
 *
 * These are the tests that make "no secret reaches the browser" a mechanical
 * property rather than a promise. They deliberately include the two cases
 * that matter most in practice: a credential smuggled in under an innocent
 * key (caught by shape), and a credential-shaped FIELD NAME carrying a value
 * (caught by name, whatever the value looks like).
 */

import { describe, expect, it } from 'vitest';
import {
  assertBrowserSafe,
  assertNoFabricatedFields,
  BrowserSafetyError,
} from '../src/live/redaction.js';

describe('assertBrowserSafe — key rule', () => {
  it('refuses a credential-named field carrying any value', () => {
    for (const key of ['apiKey', 'api_key', 'secret', 'password', 'accessToken', 'clientSecret', 'privateKey']) {
      expect(() => assertBrowserSafe({ [key]: 'anything-at-all' })).toThrow(BrowserSafetyError);
    }
  });

  it('names the offending path so the leak can be found, not just blocked', () => {
    try {
      assertBrowserSafe({ connections: [{ id: 'github', apiKey: 'abc12345' }] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BrowserSafetyError).path).toBe('snapshot.connections[0].apiKey');
    }
  });

  it('allows a credential-named field that carries no value', () => {
    expect(() => assertBrowserSafe({ token: null, apiKey: '', secret: undefined })).not.toThrow();
  });

  it('allows fact NAMES, because presence is not a secret', () => {
    // This asymmetry is the whole point of the presence-not-value convention:
    // saying CLAUDE_ROUTINE_TOKEN is absent leaks nothing.
    expect(() =>
      assertBrowserSafe({
        missingFacts: ['CLAUDE_ROUTINE_TOKEN', 'GEMINI_API_KEY', 'SUPABASE_ANON_KEY'],
        observedFacts: ['CODEX_CLI_PATH'],
      }),
    ).not.toThrow();
  });
});

describe('assertBrowserSafe — value rule', () => {
  const credentials: [string, string][] = [
    ['OpenAI key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
    ['Google API key', 'AIzaSyA0123456789abcdefghijklmnopqrstuv'],
    ['Slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'],
    ['Authorization header', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
  ];

  it.each(credentials)('refuses a %s wherever it appears in the tree', (_label, value) => {
    expect(() => assertBrowserSafe({ a: { b: [{ blockReason: value }] } })).toThrow(BrowserSafetyError);
  });

  it('refuses a credential hidden under an innocent-looking key', () => {
    // The key rule cannot help here; only the shape rule catches it.
    expect(() => assertBrowserSafe({ summary: 'deploy used ghp_abcdefghijklmnopqrstuvwxyz012' })).toThrow(
      BrowserSafetyError,
    );
  });

  it('keeps allowing the hashes, digests and ids HQ legitimately renders', () => {
    // A generic high-entropy rule would reject all of these, which is why the
    // value rule is shape-based instead.
    expect(() =>
      assertBrowserSafe({
        actionDigest: '3f9a1c2b4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
        claimNonce: 'b6b0f0a2c9d84e2fb1c7a3e5d9f04c18',
        taskId: '9f2c6c1e-6d64-4c0a-a5c7-6a0f1c2d3e4b',
        idempotencyKey: 'direct-order:8f14e45fceea167a5a36dedd4bea2543',
      }),
    ).not.toThrow();
  });
});

describe('the value rule is not defeated by case or by invisible characters', () => {
  /**
   * Wave 5 review, LOW finding C-2. Ten of the eleven shape patterns were
   * case-sensitive while only `Bearer` carried `/i`, so `SK-AAAA…` passed where
   * `sk-AAAA…` was refused — a one-keystroke bypass of a guard whose whole job
   * is to fail closed. Zero-width and fullwidth variants passed for the same
   * kind of reason: the separator the pattern needs was there, but not as the
   * ASCII byte.
   */
  it('refuses the same credential in any case', () => {
    for (const value of [
      'sk-AAAAAAAAAAAAAAAAAAAA',
      'SK-AAAAAAAAAAAAAAAAAAAA',
      'Sk-aaaaaaaaaaaaaaaaaaaa',
      'GHP_AAAAAAAAAAAAAAAAAAAA',
      'aizasyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'XOXB-AAAAAAAAAAAA',
      '-----begin rsa private key-----',
    ]) {
      expect(() => assertBrowserSafe({ note: value }), value).toThrow(BrowserSafetyError);
    }
  });

  it('refuses a credential hidden behind a zero-width or fullwidth character', () => {
    // NFKC folds the fullwidth hyphen onto ASCII; the invisible-code-point
    // strip removes what NFKC leaves alone. The ORIGINAL string is what would
    // have been published, so this widens what is caught and rewrites nothing.
    for (const value of [
      'sk\u200b-AAAAAAAAAAAAAAAAAAAA',
      'sk\uff0dAAAAAAAAAAAAAAAAAAAA',
      'sk-AAAAAAAA\ufeffAAAAAAAAAAAA',
    ]) {
      expect(() => assertBrowserSafe({ note: value }), JSON.stringify(value)).toThrow(
        BrowserSafetyError,
      );
    }
  });

  /**
   * Wave 5 correction round three, Medium B7. The previous strip was five
   * hand-listed ranges, and the test that came with it picked exactly the three
   * characters those ranges handled \u2014 so a whole class walked through both: the
   * soft hyphen, the combining grapheme joiner, the Mongolian vowel separator,
   * the line and paragraph separators, and the Hangul fillers all passed the
   * scan inside every pattern the guard has.
   *
   * The characters below are chosen for the opposite property: NONE of them is
   * in the range the old implementation listed, and the ones the current
   * implementation names in its own comment are deliberately not the only ones
   * here \u2014 the rule is a Unicode PROPERTY, so it has to hold for code points
   * nobody enumerated.
   */
  it('refuses a credential broken by any INVISIBLE code point, not a listed few', () => {
    const invisible = [
      '\u00ad', // SOFT HYPHEN
      '\u034f', // COMBINING GRAPHEME JOINER
      '\u061c', // ARABIC LETTER MARK
      '\u115f', // HANGUL CHOSEONG FILLER
      '\u1160', // HANGUL JUNGSEONG FILLER
      '\u17b4', // KHMER VOWEL INHERENT AQ
      '\u180e', // MONGOLIAN VOWEL SEPARATOR
      '\u2028', // LINE SEPARATOR
      '\u2029', // PARAGRAPH SEPARATOR
      '\u2065', // unassigned default-ignorable
      '\u3164', // HANGUL FILLER
      '\ufe00', // VARIATION SELECTOR-1
      '\uffa0', // HALFWIDTH HANGUL FILLER
      '\u{e0001}', // LANGUAGE TAG
      '\u{e0041}', // TAG LATIN CAPITAL LETTER A
    ];
    // Every credential shape the guard knows, not only the OpenAI one: the
    // review proved the bypass inside all of these.
    const shapes = [
      (hidden: string) => `sk-${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `ghp_${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `github_pat_${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `AIza${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `-----BEGIN ${hidden}RSA PRIVATE KEY-----`,
      (hidden: string) => `Bearer ${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) =>
        `eyJhbGciOi${hidden}JIUzI1NiJ9.eyJzdWIiOiIxIn0.AAAAAAAAAAAAAAAA`,
    ];
    for (const hidden of invisible) {
      for (const shape of shapes) {
        const value = shape(hidden);
        expect(
          () => assertBrowserSafe({ note: value }),
          `U+${hidden.codePointAt(0)!.toString(16).toUpperCase()} in ${shape('')}`,
        ).toThrow(BrowserSafetyError);
      }
    }
  });

  /**
   * U+2800 BRAILLE PATTERN BLANK (Wave 5 correction round four, Low 2).
   *
   * It is `So` — not `Cf`, not `Default_Ignorable` — so the property-named
   * strip did not reach it, and it broke every credential shape while leaving
   * every character of the credential present and usable. It carries an advance
   * width, which is why it is arguably not "invisible"; what the class is
   * actually for is ZERO INK, whatever the width.
   */
  it('refuses a credential broken by a zero-ink character that is not default-ignorable', () => {
    const shapes = [
      (hidden: string) => `sk-${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `ghp_${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `github_pat_${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `AIza${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `Bearer ${hidden}AAAAAAAAAAAAAAAAAAAA`,
    ];
    for (const shape of shapes) {
      expect(() => assertBrowserSafe({ note: shape('\u2800') }), shape('')).toThrow(
        BrowserSafetyError,
      );
    }
    // And braille as braille is still ordinary text, not a refusal.
    expect(() =>
      assertBrowserSafe({ note: '\u2820\u2813\u2811\u280d\u2811 transcribed for accessibility' }),
    ).not.toThrow();
  });

  /**
   * Homoglyph prefixes (Wave 5 correction round four, Low 3): one Cyrillic or
   * Greek letter that reads as the ASCII one defeats the shape while the
   * credential's entropy is entirely intact. Executed against the previous
   * head, Cyrillic `s` in `sk-…` and Cyrillic `a` in `AIza…` both PASSED.
   */
  it('refuses a credential whose prefix is spelled with Cyrillic or Greek lookalikes', () => {
    const disguised: [string, string][] = [
      ['Cyrillic s in sk-', '\u0455k-ABCDEFGHIJKLMNOP0123'],
      ['Cyrillic a in AIza', 'AIz\u0430ABCDEFGHIJKLMNOPQRSTUV'],
      ['Cyrillic o in xoxb-', 'x\u043Exb-ABCDEFGHIJKL'],
      ['Cyrillic e in eyJ', '\u0435yJABCDEFGH.ABCDEFGH.ABCDEFGH'],
      ['Greek B in Bearer', '\u0392earer ABCDEFGHIJKLMNOP'],
      ['Greek O in BEGIN', '-----BEGIN RSA PRIVATE KEY-----'.replace('O', '\u039F')],
      ['Cyrillic s plus a zero-ink blank', '\u0455k\u2800-ABCDEFGHIJKLMNOP0123'],
    ];
    for (const [label, value] of disguised) {
      expect(() => assertBrowserSafe({ note: value }), label).toThrow(BrowserSafetyError);
    }
  });

  /**
   * The other direction, and the one the fold must not cost: the confusable map
   * is curated so that no Cyrillic word can fold into any English keyword the
   * free-text heuristic looks for. Cyrillic capital EN folds to `H` and ER to
   * `P` by SHAPE, and the lowercase letters whose glyphs differ from the Latin
   * ones are deliberately unmapped.
   */
  it('keeps accepting ordinary Cyrillic, Greek and other-script prose', () => {
    const legitimate: [string, string][] = [
      ['Russian prose', '\u041e\u0442\u0447\u0451\u0442 \u043e \u043f\u0440\u043e\u0438\u0437\u0432\u043e\u0434\u0441\u0442\u0432\u0435 \u0441\u043e\u043b\u0438 \u0437\u0430 \u043a\u0432\u0430\u0440\u0442\u0430\u043b'],
      ['Russian, the word secret', '\u0421\u0435\u043a\u0440\u0435\u0442 \u043d\u0430\u0448\u0435\u0433\u043e \u0443\u0441\u043f\u0435\u0445\u0430 \u2014 \u043f\u043e\u0441\u0442\u043e\u044f\u043d\u0441\u0442\u0432\u043e'],
      ['Russian, the word token', '\u0422\u043e\u043a\u0435\u043d \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u0438\u0441\u0442\u0451\u043a \u0432\u0447\u0435\u0440\u0430'],
      ['Ukrainian', '\u0412\u0438\u0440\u043e\u0431\u043d\u0438\u0446\u0442\u0432\u043e \u0441\u043e\u043b\u0456 \u0437\u0440\u043e\u0441\u043b\u043e'],
      ['Greek prose', '\u0397 \u03ad\u03ba\u03b8\u03b5\u03c3\u03b7 \u03c0\u03b1\u03c1\u03b1\u03b3\u03c9\u03b3\u03ae\u03c2 \u03b5\u03af\u03bd\u03b1\u03b9 \u03ad\u03c4\u03bf\u03b9\u03bc\u03b7'],
      ['Greek capitals heading', '\u0395\u039a\u0398\u0395\u03a3\u0397 \u03a0\u0391\u03a1\u0391\u0393\u03a9\u0393\u0397\u03a3'],
      ['Cherokee', '\u13e3\u13b3\u13a9 report heading'],
      ['Armenian', '\u0531\u0580\u057f\u0561\u0564\u0580\u0578\u0582\u0569\u0575\u0561\u0576'],
      ['mixed Latin and Cyrillic', 'Mesob Salt Factory \u2014 \u041c\u0435\u0437\u043e\u0431 \u2014 Q3'],
    ];
    for (const [label, value] of legitimate) {
      expect(() => assertBrowserSafe({ note: value }), label).not.toThrow();
    }
  });

  it('still allows the hashes and ids HQ renders, after normalization', () => {
    // The normalization must not turn a legitimate value into a false refusal.
    expect(() =>
      assertBrowserSafe({
        actionDigest: '3f9a1c2b4d5e6f7081920a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f',
        taskId: '9f2c6c1e-6d64-4c0a-a5c7-6a0f1c2d3e4b',
        label: 'Ask Jenify about the salt yield',
      }),
    ).not.toThrow();
  });
});

describe('assertNoFabricatedFields', () => {
  it('refuses metrics the control plane does not record', () => {
    for (const field of ['cost', 'costUsd', 'tokens', 'eta', 'sentiment', 'progressPercent']) {
      expect(() => assertNoFabricatedFields({ card: { [field]: 42 } })).toThrow(BrowserSafetyError);
    }
  });

  it('leaves a vendor-advertised model property alone', () => {
    // contextWindowTokens describes the model, it does not measure a run.
    expect(() => assertNoFabricatedFields({ model: { contextWindowTokens: 200000 } })).not.toThrow();
  });
});
