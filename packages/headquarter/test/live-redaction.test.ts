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

  /**
   * PORTED from the other Wave 5 round-four lane, whose Low 2 found U+2800.
   *
   * BRAILLE PATTERN BLANK is `So` — not `Cf`, not `Cc`, not
   * `Default_Ignorable` — so it walked through every property this file's C0/C1
   * sweep and the invisible sweep above name, and it broke every credential
   * shape while leaving every character of the credential present and usable.
   * It carries an advance width, which is why it is arguably not "invisible";
   * what the class is actually for is ZERO INK, whatever the width. The merged
   * `ERASED_CODE_POINTS` names it explicitly, so this test asserts against the
   * surviving implementation rather than against the lane that wrote it.
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
      expect(() => assertBrowserSafe({ note: shape('⠀') }), shape('')).toThrow(
        BrowserSafetyError,
      );
    }
    // And braille as braille is still ordinary text, not a refusal.
    expect(() =>
      assertBrowserSafe({ note: '⠠⠓⠑⠍⠑ transcribed for accessibility' }),
    ).not.toThrow();
  });

  /**
   * PORTED from the other Wave 5 round-four lane (its Low 3), and it holds
   * unchanged against the merged fold, which is the union of the two lanes'
   * maps: one Cyrillic or Greek letter that reads as the ASCII one defeats the
   * shape while the credential's entropy is entirely intact. Executed against
   * that lane's head, Cyrillic `s` in `sk-…` and Cyrillic `a` in `AIza…` both
   * PASSED.
   */
  it('refuses a credential whose prefix is spelled with Cyrillic or Greek lookalikes', () => {
    const disguised: [string, string][] = [
      ['Cyrillic s in sk-', 'ѕk-ABCDEFGHIJKLMNOP0123'],
      ['Cyrillic a in AIza', 'AIzаABCDEFGHIJKLMNOPQRSTUV'],
      ['Cyrillic o in xoxb-', 'xоxb-ABCDEFGHIJKL'],
      ['Cyrillic e in eyJ', 'еyJABCDEFGH.ABCDEFGH.ABCDEFGH'],
      ['Greek B in Bearer', 'Βearer ABCDEFGHIJKLMNOP'],
      ['Greek O in BEGIN', '-----BEGIN RSA PRIVATE KEY-----'.replace('O', 'Ο')],
      ['Cyrillic s plus a zero-ink blank', 'ѕk⠀-ABCDEFGHIJKLMNOP0123'],
    ];
    for (const [label, value] of disguised) {
      expect(() => assertBrowserSafe({ note: value }), label).toThrow(BrowserSafetyError);
    }
  });

  /**
   * PORTED from the other Wave 5 round-four lane, and this is the one whose
   * REASON changed in the merge, so the reason is restated rather than carried.
   *
   * That lane's map was curated by OMISSION — it deliberately left Cyrillic
   * `к`, `м`, `т`, `в`, `н` and `г` unmapped so that no Cyrillic string could
   * fold into an English keyword at all. The surviving map is this lane's,
   * which IS shape-faithful for those letters, so that impossibility argument
   * does not carry across and is not restated here. What carries across, and is
   * what the test was really pinning, is that ordinary PROSE in these scripts
   * is not turned into a refusal — which holds because the fold is faithful to
   * the glyph: `С` folds to `C` and not `S`, `н` to `h` and not `n`, `р` to `p`
   * and not `r`, so `СЕКРЕТ` folds to `CEKPET` and `токен` to `tokeh`.
   *
   * The two English keywords that ARE reachable from these alphabets are pinned
   * in the test below this one, so the boundary is asserted from both sides
   * instead of being claimed.
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

  /**
   * NEW at the round-four reconciliation, and the other half of the boundary the
   * test above pins.
   *
   * Computed over the whole modern Russian, Ukrainian and Serbian alphabets, the
   * ASCII letters the merged fold can produce from them are exactly
   * `abcehijkmoptxy`. `apikey` and `cookie` are the only two keywords whose
   * every letter is in that image, so those two — and only those two — have an
   * all-Cyrillic homoglyph spelling. Refusing them is the CORRECT answer, not
   * the cost: they are homoglyph spellings of an English credential keyword,
   * which is the exact thing the fold exists to catch.
   *
   * This is asserted rather than argued so that widening the map later cannot
   * silently widen the false-refusal surface without a test saying so.
   */
  it('folds only the two credential keywords a modern Cyrillic alphabet can spell', () => {
    // а р і к е у — renders as `apikey`, is a word in no language.
    expect(() => assertBrowserSafe({ 'арікеу': 'a-live-value' })).toThrow(BrowserSafetyError);
    // с о о к і е — renders as `cookie`.
    expect(() => assertBrowserSafe({ 'соокіе': 'a-live-value' })).toThrow(BrowserSafetyError);
    // The keywords that need an `s`, `r`, `n`, `d`, `l`, `v`, `w`, `f`, `u` or
    // `z` cannot be reached from those alphabets at all, so their nearest
    // all-Cyrillic spelling stays ordinary text.
    for (const [label, name] of [
      ['Russian for secret, folds to cekpet', 'секрет'],
      ['Russian for token, folds to tokeh', 'токен'],
      ['Russian for password, folds to пapoль', 'пароль'],
      ['Russian for access, folds to дocтyп', 'доступ'],
    ] as [string, string][]) {
      expect(() => assertBrowserSafe({ [name]: 'a-live-value' }), label).not.toThrow();
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

/**
 * Wave 5 correction round six, High 5 — the depth bound was fail-OPEN, and the
 * module said the opposite.
 *
 * The comment on `walk` claimed the cycle set and the depth bound were "both
 * fail-CLOSED in the only direction that matters: they stop the walk
 * descending, they never stop a finding being raised". `JSON.stringify` has no
 * depth limit, so everything below the bound is still serialized and still
 * published: stopping the walk IS stopping the finding. Executed through
 * `proposeAction`, which applies BOTH scans and whose own comment says the
 * payload "is stored permanently and handed verbatim to an adapter" — a
 * credential at nesting depth 63 was refused and the same credential at depth
 * 64 was accepted and stored.
 */
describe('the scan depth bound refuses what it cannot read', () => {
  const CREDENTIAL = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';

  function nest(depth: number, leaf: unknown): unknown {
    let node: unknown = leaf;
    for (let index = 0; index < depth; index += 1) node = { down: node };
    return node;
  }

  it('refuses a credential at every depth, on both sides of the old boundary', () => {
    // 63 was already refused; 64 and beyond were ACCEPTED. Both are asserted,
    // so a future change that moves the bound cannot quietly reopen the hole.
    for (const depth of [0, 1, 62, 63, 64, 65, 128, 512]) {
      expect(
        () => assertBrowserSafe(nest(depth, { note: CREDENTIAL }), 'payload'),
        `depth ${depth}`,
      ).toThrow(BrowserSafetyError);
    }
  });

  it('refuses a structure too deep to scan even when nothing in it looks secret', () => {
    // The refusal is about what HQ could NOT read, so it does not depend on
    // finding anything. This is the fail-closed statement itself.
    expect(() => assertBrowserSafe(nest(400, { note: 'entirely ordinary prose' }))).toThrow(
      BrowserSafetyError,
    );
    // And the bound is nowhere near anything the control plane composes.
    expect(() => assertBrowserSafe(nest(40, { note: 'entirely ordinary prose' }))).not.toThrow();
  });

  it('applies the same rule to the fabricated-field gate, which walks the same graph', () => {
    expect(() => assertNoFabricatedFields(nest(400, { card: { ok: 1 } }))).toThrow(
      BrowserSafetyError,
    );
    expect(() => assertNoFabricatedFields(nest(40, { card: { ok: 1 } }))).not.toThrow();
  });

  it('does not refuse a repeated reference, because the cycle set stops at a value already READ', () => {
    // The two bounds are fail-closed for different reasons, and this is the
    // difference: the `seen` set stops at a value this walk has already
    // scanned, so nothing goes unread and no finding is lost. A shared subtree
    // is ordinary and must stay accepted...
    const shared = { label: 'ordinary' };
    expect(() => assertBrowserSafe({ a: shared, b: shared, c: { d: shared } })).not.toThrow();
    // ...and a credential in a shared subtree is still found, on the first
    // visit, however many times it is referenced.
    const poisoned = { note: CREDENTIAL };
    expect(() => assertBrowserSafe({ a: poisoned, b: poisoned })).toThrow(BrowserSafetyError);
  });

  it('refuses a toJSON that manufactures a FRESH object at every level', () => {
    // The reason the bound exists at all: a `toJSON` that returns a new object
    // every call cannot be closed over by the cycle set, so only the depth
    // bound can end the walk — and ending it silently is what published
    // unscanned content.
    const endless = (): unknown => ({ toJSON: () => ({ down: endless() }) });
    expect(() => assertBrowserSafe(endless())).toThrow(BrowserSafetyError);
  });
});

/**
 * Wave 5 correction round fifteen, MEDIUM 3 — a credential written as a
 * property NAME.
 *
 * `walk`'s plain-object branch visited the CHILD and never the KEY, while the
 * `Map` branch one block above explicitly walked its key. `JSON.stringify`
 * publishes both, so the same credential that was refused as a field's value
 * was published as that field's name. Reproduced at `c23dd0a` at unit level —
 * `{"ghp_…": 1}` ACCEPTED, `{note: "ghp_…"}` REFUSED — and end to end through
 * `proposeAction`, where the key form was accepted and stored verbatim in
 * `hq_action_intents`, a ledger whose `no_erase` guard means the row could not
 * afterwards be removed without DDL.
 *
 * These cases are written as a CLASS rather than as the one instance, because
 * this was the fourth carrier of the same shape: every carrier `walk` descends
 * into must read both the content it holds and the LABEL it holds it under. The
 * carriers with a data-bearing label are the plain object, the `Map` and
 * nothing else — an array index and the literal `.toJSON()` are generated by
 * the walk, not by a caller — and all three are asserted here together so a
 * future carrier cannot be added with only one half wired.
 */
describe('a credential in a property NAME is refused exactly as one in a value is', () => {
  const CREDENTIALS: [string, string][] = [
    ['GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'],
    ['OpenAI key', 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ];

  it.each(CREDENTIALS)('refuses a %s used as a plain-object key', (_label, credential) => {
    // The value under it is deliberately trivial: the credential is the NAME,
    // and nothing else in the payload looks like one.
    expect(() => assertBrowserSafe({ [credential]: 1 })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe({ [credential]: 'x' })).toThrow(BrowserSafetyError);
  });

  it.each(CREDENTIALS)('refuses a %s used as a NESTED plain-object key', (_label, credential) => {
    expect(() => assertBrowserSafe({ a: { b: { [credential]: 'x' } } })).toThrow(BrowserSafetyError);
    // And inside an array, which is the shape a `Record` in a list takes.
    expect(() => assertBrowserSafe({ rows: [{ [credential]: 'x' }] })).toThrow(BrowserSafetyError);
  });

  it.each(CREDENTIALS)('already refused a %s in every other carrier, and still does', (_label, credential) => {
    // The three that were correct before this correction, asserted beside the
    // one that was not so the fix cannot be mistaken for the whole guarantee.
    expect(() => assertBrowserSafe({ v: credential })).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe([credential])).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe(new Map([[credential, 1]]))).toThrow(BrowserSafetyError);
    expect(() => assertBrowserSafe(new Set([credential]))).toThrow(BrowserSafetyError);
  });

  it('every carrier with a data-bearing label reads that label', () => {
    // The class, asserted as a class. A `Map` key and a plain-object key are
    // the only two labels a caller writes; an array index and `.toJSON()` are
    // written by the walk. If a future carrier is added with a caller-supplied
    // label and does not read it, the credential below survives whichever
    // carrier that is.
    const credential = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
    const carriers: [string, unknown][] = [
      ['plain object key', { [credential]: 1 }],
      ['Map key', new Map([[credential, 1]])],
      // Labels the walk generates, carrying the credential as CONTENT instead.
      ['array element', [credential]],
      ['Set member', new Set([credential])],
      ['toJSON projection', { toJSON: () => ({ [credential]: 1 }) }],
    ];
    const published = carriers
      .filter(([, payload]) => {
        try {
          assertBrowserSafe(payload);
          return true;
        } catch {
          return false;
        }
      })
      .map(([label]) => label);
    expect(published, 'a carrier published a credential').toEqual([]);
  });

  it('does not refuse the ordinary identifiers HQ actually keys a Record by', () => {
    // The other direction, because a key rule that refuses real keys is a
    // different outage. These are the shapes `liveSnapshotFromOperations`
    // composes: worker ids, member ids, finding names, run kinds.
    expect(() =>
      assertBrowserSafe({
        workerProviders: { claude: { declaredId: 'claude_code', dispatchable: null } },
        workerMembers: { 'gpt-5-codex': { status: 'active' } },
        findings: { append_only_guard_missing: 1, unrecognized: 0 },
        byKind: { 'task-run': 2 },
      }),
    ).not.toThrow();
  });
});
