/**
 * Browser-safety guard for anything HQ ships to a client (issue #200).
 *
 * The primary defence is architectural and lives elsewhere: credentials never
 * enter the control plane at all (`providers/contracts.ts` has no credential
 * field; `routing/providers.ts` reasons about secret *presence*, never
 * values; `providers/codex/probe.ts` opens auth.json only to learn the auth
 * MODE). This module is the backstop that makes that architecture
 * *mechanically* checkable: every snapshot is walked before it is written, and
 * a snapshot carrying anything that looks like a credential is refused rather
 * than published.
 *
 * Two independent rules, because either alone is easy to slip past:
 *
 *   1. **Key rule** — a field whose NAME reads like a credential holder may
 *      not carry a non-trivial string value. `{ apiKey: 'x' }` is refused on
 *      the name alone, whatever the value looks like.
 *   2. **Value rule** — a string anywhere in the tree may not match a known
 *      credential shape (provider key prefixes, PATs, JWTs, PEM blocks,
 *      `Bearer …`), plus the same `key: value` heuristic the evidence log
 *      already enforces.
 *
 * Fact NAMES are deliberately safe: `'CLAUDE_ROUTINE_TOKEN'` appearing as an
 * element of `missingFacts` is a statement that a secret is absent, and
 * matches neither rule (it is an array element, not a field name, and its
 * text is not a credential shape). That asymmetry is the whole point of the
 * presence-not-value convention used across routing.
 *
 * Separately, `assertNoFabricatedFields` locks the second honesty rule from
 * the mission brief: HQ may not grow a cost, token-usage, ETA, sentiment or
 * confidence field, because the canonical control plane records none of those
 * and a rendered number would be invented.
 */

import { assertNoSecretLikeContent } from '../operator/evidence.js';

/** Field names that may never carry a non-trivial string value. */
const SECRET_KEY_PATTERN =
  /^(.*_)?(api[_-]?key|apikey|secret|password|passwd|passphrase|token|access[_-]?token|refresh[_-]?token|credential|credentials|private[_-]?key|client[_-]?secret|authorization|cookie|session[_-]?token)([_-].*)?$/i;

/**
 * Known credential shapes. Deliberately shape-based rather than
 * entropy-based: a generic "looks random" rule would reject the hash-chained
 * evidence digests, claim nonces and UUIDs that HQ legitimately renders.
 *
 * **Case-insensitive since the Wave 5 review (Low finding C-2).** Ten of the
 * eleven patterns were case-sensitive while only `Bearer` carried `/i`, so
 * `SK-AAAA…` passed where `sk-AAAA…` was refused — a one-keystroke bypass of a
 * guard whose whole job is to fail closed. The JWT pattern is the deliberate
 * exception: `eyJ` is base64url of `{"`, so its case is the ENCODING and not a
 * spelling choice, and loosening it would only widen what it matches by
 * accident.
 *
 * Values are also NORMALIZED before matching (see `normalizeForScan`), because
 * the same finding showed a zero-width space or a fullwidth hyphen inside a key
 * defeating every pattern at once.
 *
 * **`\b` is gone, and its replacement is the point** (Wave 5 correction round
 * four, Critical C1). `\b` is a boundary between a word character and a
 * non-word character, and `_` is a WORD character — so a credential carrying
 * any underscore-joined prefix simply had no boundary in front of it and
 * matched nothing at all. Executed end to end: `OPENAI_KEY_sk-…` was carried on
 * the UNAUTHENTICATED `hq-snapshot.json` while the bare `sk-…` correctly
 * refused the artifact.
 *
 * `(?<![A-Za-z0-9])` is the anchor instead: it treats `_` — and every other
 * punctuation character an identifier joins with — as a boundary, while still
 * refusing to fire in the middle of a letter or digit run. That last part is
 * what keeps ordinary prose out of it: `task-oriented-approach` contains the
 * literal substring `sk-oriented-approach`, which an UNANCHORED pattern would
 * refuse as an OpenAI key. The new anchor matches everywhere `\b` did plus the
 * underscore case, and nowhere else.
 *
 * The residual is stated rather than glossed: a prefix that runs straight into
 * the shape with no separator at all (`KEYsk-…`) is still not matched, because
 * it is genuinely indistinguishable from the `task-…` case above. Anchoring is
 * a heuristic; the architecture — credentials never enter the control plane —
 * is the guarantee.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/i, // OpenAI-style secret key
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/i, // GitHub token
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/i, // GitHub fine-grained PAT
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/i, // Google API key
  /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/i, // Google OAuth access token
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/i, // Slack token
  /(?<![A-Za-z0-9])sbp_[a-f0-9]{32,}/i, // Supabase personal access token
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT (base64url; case IS the payload)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, // PEM private key
  /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._-]{16,}/i, // Authorization header value
  // `api_key: "…"` style assignments inside free text. This mirrors the
  // evidence log's own heuristic, but is applied to each RAW string rather
  // than to the JSON encoding of the whole payload. That difference matters:
  // once stringified, `api_key: "abcd1234efgh5678"` becomes
  // `api_key: \"abcd…\"`, and the backslash stops the original pattern from
  // matching — so a quoted secret in free text slipped past. Checking the
  // unescaped string closes that gap.
  /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

/**
 * Numbers HQ does not measure and therefore may not display. Exact key
 * equality, so `contextWindowTokens` (a vendor-advertised model property,
 * not a usage measurement) is unaffected.
 */
export const FABRICATED_FIELD_NAMES: readonly string[] = [
  'cost',
  'costUsd',
  'costEstimate',
  'estimatedCost',
  'spend',
  'tokens',
  'tokenUsage',
  'tokensUsed',
  'promptTokens',
  'completionTokens',
  'eta',
  'etaSeconds',
  'estimatedCompletion',
  'estimatedFinish',
  'sentiment',
  'mood',
  'confidenceScore',
  'progressPercent',
];

export class BrowserSafetyError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = 'BrowserSafetyError';
  }
}

/**
 * Every code point that does not render as an ordinary visible character, and
 * is therefore usable to break a credential pattern without changing what a
 * reader meaningfully sees.
 *
 * Defined by PROPERTY, not by a hand-listed range (Wave 5 correction round
 * three, Medium B7). The version before that stripped five ranges somebody
 * chose, and a whole class walked straight through it: U+00AD SOFT HYPHEN,
 * U+034F COMBINING GRAPHEME JOINER, U+180E, U+2028 LINE SEPARATOR, U+2029,
 * U+115F and U+FFA0 HALFWIDTH HANGUL FILLER all passed the scan when placed
 * inside `sk-`, `ghp_`, `github_pat_`, `AIza`, a PEM header, `Bearer ` and a
 * JWT.
 *
 * That was not a snapshot backstop failing quietly. End to end through the
 * Founder route, a plain `sk-...` note was refused 400 while the same note
 * carrying one U+00AD was stored 201 and came back on the wire on the next
 * read; and through the RETRIEVAL facade -- the layer
 * `RETRIEVAL_GUARD_STATEMENT` names as the guarantee -- `searchCompany` and
 * `askJenify` refused the plain form and ACCEPTED the invisible-character form.
 *
 *  - `\p{Default_Ignorable_Code_Point}` is Unicode's own name for "renders as
 *    nothing": the soft hyphen, the Hangul fillers, the Mongolian and variation
 *    selectors, the zero-width and bidi controls, the tag characters;
 *  - `\p{Cf}` is the format category, which overlaps it and covers the rest;
 *  - `\p{Cc}` is the C0/C1 CONTROL block -- U+0000-U+001F, U+007F-U+009F. **It
 *    is in neither of the two above, and the previous comment's claim that
 *    naming a property "makes this hold for code points nobody enumerated" was
 *    therefore false of an entire block** (Wave 5 correction round four,
 *    Critical C1). Executed, one fresh fixture per row through
 *    `liveSnapshotFromOperations`: U+0001, U+001F, U+007F and U+0090 each
 *    carried a live credential onto the UNAUTHENTICATED artifact while the
 *    plain form refused to build it. A control character is not a format
 *    character and not default-ignorable; it is simply not a character a reader
 *    of an HQ string ever sees as itself. The claim is corrected here rather
 *    than restated: this set holds for the properties it NAMES, and the pinning
 *    test sweeps the code points themselves rather than trusting the naming;
 *  - U+034F and `\p{Zl}`/`\p{Zp}` (U+2028/U+2029) are named explicitly because
 *    they are in none of the above: the combining grapheme joiner is a
 *    combining mark and the line and paragraph separators are their own
 *    categories, and all three split a pattern in exactly the same invisible
 *    way.
 *
 * `\p{Zs}` -- the ordinary SPACE separators -- is deliberately NOT here, and
 * that is an argued boundary rather than an omission. A space is VISIBLE: it
 * changes what a reader sees, so it hides nothing. Erasing it would join
 * ordinary prose into fabricated credential shapes (`...ask -driven-workflow`),
 * which is a false REFUSAL of a Founder's own text, and `Bearer\s+...` is
 * matched on the raw string anyway.
 */
const ERASED_CODE_POINTS =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}͏]/gu;

/**
 * The hyphen family, folded to ASCII `-`.
 *
 * NFKC does NOT do this: U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2212
 * MINUS SIGN, U+02D7 MODIFIER LETTER MINUS SIGN and U+2043 HYPHEN BULLET are
 * each canonical in their own right, so `sk<U+2010>AAAA...` normalized to
 * itself and matched nothing -- executed, and carried onto the unauthenticated
 * artifact (Wave 5 correction round four, Critical C1). The compatibility forms
 * (U+FE63, U+FF0D) DO fold under NFKC and are listed anyway, so this set is a
 * statement about the hyphen family rather than about what one normalization
 * form happens to leave behind.
 *
 * U+00AD SOFT HYPHEN is deliberately absent: it is invisible, so it belongs in
 * the ERASED set above rather than here.
 */
const HYPHEN_CONFUSABLES =
  /[‐‑‒–—―⁃˗⁻₋−⸺⸻⹀︱︲﹘﹣－᐀᠆ー]/gu;

/**
 * Latin look-alikes from other scripts, folded to the ASCII letter they are
 * drawn as.
 *
 * The KEY rule reads a field NAME, and a name is chosen by whoever built the
 * object: `<Cyrillic a><Cyrillic r>iKey` renders identically to `apiKey` and
 * matched neither rule (Wave 5 correction round four, Critical C1). This is a
 * targeted fold of the confusables that actually spell the words the two rules
 * look for -- not a general confusables table, which HQ has no business
 * shipping its own copy of.
 */
const CONFUSABLE_LATIN: ReadonlyMap<string, string> = new Map([
  ['а', 'a'], ['в', 'b'], ['с', 'c'], ['ԁ', 'd'], ['е', 'e'],
  ['ѕ', 's'], ['і', 'i'], ['ј', 'j'], ['к', 'k'], ['м', 'm'],
  ['н', 'h'], ['о', 'o'], ['р', 'p'], ['т', 't'], ['у', 'y'],
  ['х', 'x'], ['һ', 'h'], ['ԛ', 'q'], ['ԝ', 'w'],
  ['А', 'A'], ['В', 'B'], ['С', 'C'], ['Е', 'E'], ['Ѕ', 'S'],
  ['І', 'I'], ['Ј', 'J'], ['К', 'K'], ['М', 'M'], ['Н', 'H'],
  ['О', 'O'], ['Р', 'P'], ['Т', 'T'], ['У', 'Y'], ['Х', 'X'],
  ['α', 'a'], ['ο', 'o'], ['ν', 'v'], ['ρ', 'p'], ['τ', 't'],
  ['υ', 'u'], ['κ', 'k'], ['ε', 'e'], ['ι', 'i'],
  ['Α', 'A'], ['Β', 'B'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'H'],
  ['Ι', 'I'], ['Κ', 'K'], ['Μ', 'M'], ['Ν', 'N'], ['Ο', 'O'],
  ['Ρ', 'P'], ['Τ', 'T'], ['Υ', 'Y'], ['Χ', 'X'],
]);

function foldConfusableLetters(value: string): string {
  let out = '';
  for (const character of value) out += CONFUSABLE_LATIN.get(character) ?? character;
  return out;
}

/**
 * Fold away the cheap ways to hide a credential shape from a regex: invisible
 * or control characters inside it, compatibility variants of its separators, a
 * hyphen drawn as some other dash, and a letter drawn in another script.
 *
 * Order is load-bearing and each step is here because the one before it does
 * not do its job:
 *
 *  1. `NFKC` maps the fullwidth and compatibility forms onto the ASCII the
 *     patterns look for;
 *  2. the hyphen fold catches the dash family NFKC leaves canonical;
 *  3. the confusable-letter fold catches a word spelled in Cyrillic or Greek;
 *  4. the ERASE runs LAST, because a compatibility form can decompose around an
 *     invisible character and a shape may only become contiguous once the
 *     folding has happened.
 *
 * Scanning the normalized form only -- the ORIGINAL string is what gets refused
 * or published, so this widens what is caught and never rewrites what is
 * carried.
 */
function normalizeForScan(value: string): string {
  return foldConfusableLetters(
    value.normalize('NFKC').replace(HYPHEN_CONFUSABLES, '-'),
  ).replace(ERASED_CODE_POINTS, '');
}

/** Trivial values are exempt from the key rule so `{ token: null }` is fine. */
function isTrivial(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim().length === 0);
}

/**
 * How deep the walk goes before it stops descending. A bound rather than a
 * hope: the traversal now follows `toJSON`, and a `toJSON` that returns a fresh
 * object every call cannot be closed over by the cycle set.
 */
const MAX_SCAN_DEPTH = 64;

/**
 * Walk everything a browser could end up seeing — which is NOT the same set as
 * "the own enumerable properties of a plain object" (Wave 5 correction round
 * four, Critical C1).
 *
 * Three carriers were invisible to the previous walk, each demonstrated at unit
 * level against `assertBrowserSafe`:
 *
 *  - **`toJSON`.** `JSON.stringify` calls it, so a value whose only STRING form
 *    comes from `toJSON` reached the artifact while the walk saw an object with
 *    no string properties at all. It is followed here, so the scan sees what
 *    the serializer will;
 *  - **`Map`.** `Object.entries` of a Map is empty. Its keys are walked as KEY
 *    NAMES (so `new Map([['apiKey', '...']])` meets the key rule) and its values
 *    as values;
 *  - **`Set`.** Same shape of blindness; members are walked as array elements
 *    are.
 *
 * A `seen` set makes a cyclic graph terminate instead of overflowing the stack,
 * and `depth` bounds the rest. Both are fail-CLOSED in the only direction that
 * matters: they stop the walk descending, they never stop a finding being
 * raised.
 */
function walk(
  value: unknown,
  path: string,
  visit: (value: unknown, path: string, key?: string) => void,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  visit(value, path);
  if (value == null || typeof value !== 'object') return;
  if (depth >= MAX_SCAN_DEPTH) return;
  const target = value as object;
  if (seen.has(target)) return;
  seen.add(target);
  // What the SERIALIZER would see. Followed before anything else, because for a
  // value whose own properties are all non-strings this is the only place a
  // credential can be.
  const toJson = (target as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {
    let projected: unknown;
    let projectable = true;
    try {
      projected = (toJson as () => unknown).call(target);
    } catch {
      // A `toJSON` that throws produces nothing to publish; the serializer
      // would fail too. Not a finding, and not a reason to stop scanning the
      // object's own properties.
      projectable = false;
    }
    if (projectable && projected !== target) {
      walk(projected, `${path}.toJSON()`, visit, seen, depth + 1);
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit, seen, depth + 1));
    return;
  }
  if (value instanceof Map) {
    let index = 0;
    for (const [key, child] of value) {
      const at = `${path}{${index}}`;
      index += 1;
      // The Map KEY is scanned as a value in its own right AND, when it is a
      // string, offered to the key rule — a Map is an object whose field names
      // happen to be data.
      walk(key, `${at}.key`, visit, seen, depth + 1);
      if (typeof key === 'string') visit(child, `${at}.value`, key);
      walk(child, `${at}.value`, visit, seen, depth + 1);
    }
    return;
  }
  if (value instanceof Set) {
    let index = 0;
    for (const member of value) {
      walk(member, `${path}<${index}>`, visit, seen, depth + 1);
      index += 1;
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(child, `${path}.${key}`, key);
    walk(child, `${path}.${key}`, visit, seen, depth + 1);
  }
}

/** The key rule, applied to the name as WRITTEN and as normalized. */
function namesACredentialHolder(key: string): boolean {
  // A field NAME is chosen by whoever built the object, so a homoglyph spelling
  // of `apiKey` is exactly as available as an invisible character inside a
  // value. Same normalization, same reason.
  return SECRET_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(normalizeForScan(key));
}

/**
 * Refuse a payload that could leak a credential to a browser. Throws
 * `BrowserSafetyError` naming the offending path — fail closed, never redact
 * silently, because a silently-redacted snapshot hides the bug that put the
 * secret there.
 *
 * **What this does NOT catch, recorded rather than implied.** A credential
 * SPLIT across two sibling fields or two array items (`{a: 'sk-', b: '<32
 * chars>'}`) is not detected, and deliberately so: catching it would mean
 * concatenating sibling values and scanning the join, which fabricates matches
 * out of ordinary text — `['task', '-oriented-workflow-item']` would be refused
 * as an OpenAI key. Every candidate rule for it was a worse trade than the hole,
 * so the hole is stated here and in the phase document rather than papered over.
 * The architecture is what answers it: credentials never enter the control
 * plane, and no HQ writer splits a value across fields.
 */
export function assertBrowserSafe(payload: unknown, rootPath = 'snapshot'): void {
  walk(payload, rootPath, (value, path, key) => {
    if (key != null && namesACredentialHolder(key) && !isTrivial(value)) {
      if (typeof value === 'string' || typeof value === 'number') {
        throw new BrowserSafetyError(
          `Field "${key}" names a credential holder and carries a value; HQ snapshots carry secret PRESENCE, never secret values`,
          path,
        );
      }
    }
    if (typeof value === 'string') {
      const scanned = normalizeForScan(value);
      for (const pattern of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value) || pattern.test(scanned)) {
          throw new BrowserSafetyError('String matches a known credential shape', path);
        }
      }
    }
  });
  // Same `key: value` heuristic the append-only evidence log already applies,
  // so the two boundaries cannot drift apart.
  assertNoSecretLikeContent({ payload } as Record<string, unknown>);
}

/** Refuse a payload that has grown a metric HQ does not actually measure. */
export function assertNoFabricatedFields(payload: unknown, rootPath = 'snapshot'): void {
  walk(payload, rootPath, (_value, path, key) => {
    if (key != null && FABRICATED_FIELD_NAMES.includes(key)) {
      throw new BrowserSafetyError(
        `Field "${key}" is not recorded anywhere in the canonical control plane, so any value shown would be invented`,
        path,
      );
    }
  });
}
