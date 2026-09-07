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
   * Wave 5 correction round four, Critical C1.
   *
   * The previous sweep chose characters from two Unicode PROPERTIES and the
   * comment beside it claimed that naming a property "makes this hold for code
   * points nobody enumerated". It did not hold for an entire BLOCK: `\p{Cc}` is
   * neither `Cf` nor `Default_Ignorable`, and U+0001, U+001F, U+007F and U+0090
   * each carried a live credential onto the UNAUTHENTICATED artifact.
   *
   * So this does not pick four characters either. It sweeps the WHOLE C0/C1
   * control block against every credential shape the guard knows, which is the
   * only form of this test that could have failed before the fix and cannot be
   * satisfied by adding four more entries to a list.
   */
  it('refuses a credential broken by any C0/C1 CONTROL character', () => {
    const shapes = [
      (hidden: string) => `sk-${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `ghp_${hidden}AAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `github_pat_${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `AIza${hidden}AAAAAAAAAAAAAAAAAAAAAAAA`,
      (hidden: string) => `-----BEGIN ${hidden}RSA PRIVATE KEY-----`,
      (hidden: string) => `Bearer ${hidden}AAAAAAAAAAAAAAAAAAAA`,
    ];
    const controls: number[] = [];
    for (let code = 0x00; code <= 0x1f; code += 1) controls.push(code);
    for (let code = 0x7f; code <= 0x9f; code += 1) controls.push(code);
    expect(controls).toHaveLength(65);
    for (const code of controls) {
      const hidden = String.fromCharCode(code);
      for (const shape of shapes) {
        expect(
          () => assertBrowserSafe({ note: shape(hidden) }),
          `U+${code.toString(16).toUpperCase().padStart(4, '0')} in ${shape('')}`,
        ).toThrow(BrowserSafetyError);
      }
    }
  });

  /**
   * NFKC does not fold these. U+2010 HYPHEN and U+2011 NON-BREAKING HYPHEN are
   * canonical in their own right, so `sk<U+2010>...` normalized to itself and
   * matched nothing at all (Wave 5 correction round four, Critical C1).
   */
  it('refuses a credential whose hyphen is drawn as some other dash', () => {
    const dashes = [
      '‐', // HYPHEN
      '‑', // NON-BREAKING HYPHEN
      '‒', // FIGURE DASH
      '–', // EN DASH
      '—', // EM DASH
      '―', // HORIZONTAL BAR
      '⁃', // HYPHEN BULLET
      '˗', // MODIFIER LETTER MINUS SIGN
      '−', // MINUS SIGN
      '﹣', // SMALL HYPHEN-MINUS
      '－', // FULLWIDTH HYPHEN-MINUS
    ];
    for (const dash of dashes) {
      expect(
        () => assertBrowserSafe({ note: `sk${dash}AAAAAAAAAAAAAAAAAAAA` }),
        `U+${dash.codePointAt(0)!.toString(16).toUpperCase()}`,
      ).toThrow(BrowserSafetyError);
    }
  });

  /**
   * `\b` is a boundary between a word character and a non-word character, and
   * `_` is a WORD character — so any underscore-joined prefix removed the
   * boundary the whole pattern set was anchored on (Wave 5 correction round
   * four, Critical C1).
   */
  it('refuses a credential hidden behind a word-character prefix', () => {
    const prefixed = [
      'OPENAI_KEY_sk-AAAAAAAAAAAAAAAAAAAA',
      'openaiKEY_sk-AAAAAAAAAAAAAAAAAAAA',
      'GITHUB_TOKEN_ghp_AAAAAAAAAAAAAAAAAAAA',
      'GOOGLE_KEY_AIzaAAAAAAAAAAAAAAAAAAAAAAAA',
      'HEADER_VALUE_Bearer AAAAAAAAAAAAAAAAAAAA',
    ];
    for (const value of prefixed) {
      expect(() => assertBrowserSafe({ note: value }), value).toThrow(BrowserSafetyError);
    }
  });

  /**
   * The anchor may not be widened into ordinary prose. `task-oriented-approach`
   * literally contains `sk-oriented-approach`, so an UNANCHORED pattern would
   * refuse a Founder's own text — and with the write and read scans now being
   * the same function, a false refusal is a refused write rather than a
   * cosmetic annoyance.
   */
  it('does not fabricate a credential out of ordinary hyphenated prose', () => {
    for (const value of [
      'the next task-oriented-approach for the salt line',
      'a task\n-oriented-workflow-item is ready for review',
      'risk-management-workflow, quarter three',
      'the bearer of the news arrives tomorrow',
    ]) {
      expect(() => assertBrowserSafe({ note: value }), value).not.toThrow();
    }
  });

  /**
   * `Object.entries` of a Map is empty, a Set has no own enumerable members,
   * and a value whose only string form comes from `toJSON` has no string
   * property at all — yet all three are serialized to the artifact (Wave 5
   * correction round four, Critical C1).
   */
  it('sees a credential carried by a Map, a Set or a toJSON projection', () => {
    const key = 'sk-AAAAAAAAAAAAAAAAAAAA';
    expect(() => assertBrowserSafe({ held: new Map([['note', key]]) })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe({ held: new Set([key]) })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe({ held: { toJSON: () => key } })).toThrow(BrowserSafetyError);
    // The KEY rule reaches a Map's keys too: a Map is an object whose field
    // names happen to be data.
    expect(() => assertBrowserSafe({ held: new Map([['apiKey', 'a-live-value']]) })).toThrow(
      BrowserSafetyError,
    );
  });

  /** A field NAME is chosen by whoever built the object, so it can be a homoglyph. */
  it('refuses a credential-named field whose name is spelled in another script', () => {
    // Cyrillic а (U+0430) and р (U+0440): renders as `apiKey`.
    expect(() => assertBrowserSafe({ 'арiKey': 'a-live-value' })).toThrow(
      BrowserSafetyError,
    );
  });

  /** A cyclic graph must terminate rather than overflow the stack. */
  it('terminates on a cyclic object instead of recursing forever', () => {
    const node: Record<string, unknown> = { label: 'fine' };
    node.self = node;
    // The JSON heuristic still refuses to serialize a cycle, which is the
    // fail-closed direction; what must not happen is a stack overflow in the
    // walk itself.
    expect(() => assertBrowserSafe(node)).toThrow();
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
