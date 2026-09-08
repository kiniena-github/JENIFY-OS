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
import { deepFreeze } from '../contracts/freeze.js';

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
export const FABRICATED_FIELD_NAMES: readonly string[] = deepFreeze([
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
]);

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
 * Every code point that carries NO INK — that does not render as an ordinary
 * visible character — and is therefore usable to break a credential pattern
 * while leaving every character of the credential present, and without changing
 * what a reader meaningfully sees.
 *
 * The rule is zero INK, not zero WIDTH, and the difference is load-bearing: one
 * member of this set (U+2800) has an advance width and is here anyway.
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
 *    way;
 *  - U+2800 BRAILLE PATTERN BLANK is named for the same reason, and is the one
 *    member of this set with an advance WIDTH. It is `So` — not `Cf`, not
 *    `Cc`, not `Default_Ignorable` — so it walked straight through every
 *    property named above while splitting `sk-…` in two (Wave 5 correction
 *    round four, the other lane's Low 2, executed on that lane's head). It is
 *    the reason this class is stated as zero INK rather than zero width.
 *    Ordinary whitespace is still deliberately not folded — see the `\p{Zs}`
 *    paragraph below.
 *
 * `\p{Zs}` -- the ordinary SPACE separators -- is deliberately NOT here, and
 * that is an argued boundary rather than an omission. A space is VISIBLE: it
 * changes what a reader sees, so it hides nothing. Erasing it would join
 * ordinary prose into fabricated credential shapes (`...ask -driven-workflow`),
 * which is a false REFUSAL of a Founder's own text, and `Bearer\s+...` is
 * matched on the raw string anyway.
 */
const ERASED_CODE_POINTS =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Cn}͏⠀]/gu;

/**
 * Combining marks, removed from a DECOMPOSED copy before anything else runs.
 *
 * **The zero-ink sweep left three whole categories carrying a credential shape
 * past the guard, and two of them were disclosed nowhere** (Wave 5 correction
 * round seven, the undisclosed sweep residuals). `\p{Mn}` (1,796 code points),
 * `\p{Me}` (13) and `\p{Cn}` unassigned (810,961) each broke
 * `sk-ABCDEFGHIJKLMNOP0123` into two unmatched halves with every character of
 * the key intact. U+0301 COMBINING ACUTE ACCENT and U+0378 (unassigned) are the
 * two the review named, and neither appeared in any residual list.
 *
 * A combining mark is exactly the class this scan exists for: it leaves every
 * credential character present, and a reader strips the mark — `sk-Á…` is read,
 * copied and pasted as `sk-A…`. `\p{Cn}` is the same argument one step further:
 * an unassigned code point has no glyph, so it carries no meaning a reader
 * could act on, and prose does not contain it.
 *
 * **Why this is a SEPARATE step rather than three more entries in the erase
 * set.** The erase runs LAST, after `NFKC` — and `NFKC` COMPOSES a base letter
 * and its mark into a single precomposed character, so by the time the erase
 * runs `A` + U+0301 is `Á`, which is `Lu` and not `Mn`. Removing the mark
 * therefore has to happen on the DECOMPOSED form: `NFKD` first, marks out,
 * then the ordinary pipeline. The categories are in the erase set as well,
 * which catches the marks NFKD leaves standing on a base with no precomposed
 * form (a digit, for instance).
 *
 * **What this costs, bounded rather than hoped.** Accented prose folds to
 * unaccented prose in the SCAN COPY only — the original string is what is
 * refused or published, exactly as for every other fold here. Stripping a mark
 * removes characters; it cannot introduce a letter, so it cannot build `sk-`,
 * `ghp_`, `AIza`, a PEM header, `Bearer ` or a JWT out of prose that did not
 * already carry them. `live-redaction.test.ts`'s twelve legitimate strings and
 * the round-seven suite's accented prose are both pinned against it.
 *
 * `\p{Zs}` is STILL not folded, on the argument that has not changed: a space
 * is visible, so it hides nothing.
 */
const COMBINING_MARKS = /[\p{Mn}\p{Me}]/gu;

function stripCombiningMarks(value: string): string {
  return value.normalize('NFKD').replace(COMBINING_MARKS, '');
}

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
 * **Why this exists, from both round-four lanes, which found it independently.**
 * The KEY rule reads a field NAME, and a name is chosen by whoever built the
 * object: `<Cyrillic a><Cyrillic r>iKey` renders identically to `apiKey` and
 * matched neither rule (Critical C1). The VALUE rule matches SHAPES, and a
 * shape is defeated by one character that reads the same and encodes
 * differently: Cyrillic `ѕ` in `ѕk-ABCDEFGHIJKLMNOP0123` and Cyrillic
 * `а` in `AIzаABCDEFGHIJKLMNOPQRSTUV` both PASSED with the whole key
 * material intact, while the ASCII spellings of both were refused (Low 3).
 *
 * **What it deliberately is not.** This is not a Unicode confusables
 * implementation — HQ carries no confusables table, and inventing a partial one
 * while calling it complete would be the overclaim. It is a curated map over
 * Cyrillic and Greek, the two scripts that carry a full set of ASCII-identical
 * letters, sit on common keyboard layouts, and are what homoglyph substitution
 * is written in. Cherokee, Armenian, Coptic, Lisu and the rest are NOT folded
 * and a substitution drawn from them still defeats the shape; that limit is
 * stated in the phase document's residual list rather than papered over.
 *
 * **What bounds the false-positive risk, by construction rather than by hope.**
 * Every entry is faithful to the GLYPH, and the faithfulness is what does the
 * bounding: Cyrillic `с` folds to `c` and not `s`, `н` to `h` and not `n`, `р`
 * to `p` and not `r`, `В` to `B` and not `V`. Computed over the whole modern
 * Russian, Ukrainian and Serbian alphabets, the ASCII letters this map can
 * produce from them are exactly `abcehijkmoptxy` — so `СЕКРЕТ` folds to
 * `CEKPET` and never to `SECRET`, and `токен` folds to `tokeh` and never to
 * `token`, because `s`, `r` and `n` are not in that image at all.
 *
 * That is a bound, not an impossibility, and the exceptions are named rather
 * than implied: `apikey` (with its `api_key` and `api-key` spellings) and
 * `cookie` are the two keywords whose every letter IS in that image, so
 * `арікеу` and `соокіе` do fold onto them. Neither is a word in any of those
 * languages — they are homoglyph spellings of the English keyword, which is
 * precisely what the fold exists to catch — and both are field-NAME keywords,
 * where a refusal is the correct answer. `live-redaction.test.ts` pins the
 * boundary from both sides: ordinary prose in these scripts is accepted, and
 * those two spellings are refused.
 *
 * **The one visible cost, disclosed rather than discovered.** Greek capitals for
 * `TOKEN` — `ΤΟΚΕΝ` — do fold to `TOKEN`, so Greek
 * text of that shape is refused by the free-text key/value heuristic exactly as
 * the English spelling already is. That is the pre-existing behaviour of that
 * heuristic applied consistently, not a new class of refusal, and it is in the
 * phase document's residual list.
 *
 * ONE map, not two (Wave 5 round-four reconciliation). Both lanes shipped a
 * fold; this is the union of their entries on the broader lane's
 * implementation, because a wider fold is the fail-closed direction for a
 * credential scan and the bound above survives the widening.
 */
const CONFUSABLE_LATIN: ReadonlyMap<string, string> = new Map([
  ['а', 'a'], ['в', 'b'], ['с', 'c'], ['ԁ', 'd'], ['е', 'e'],
  ['ѕ', 's'], ['і', 'i'], ['ј', 'j'], ['к', 'k'], ['м', 'm'],
  ['н', 'h'], ['о', 'o'], ['р', 'p'], ['т', 't'], ['у', 'y'],
  ['х', 'x'], ['һ', 'h'], ['ԛ', 'q'], ['ԝ', 'w'],
  ['А', 'A'], ['В', 'B'], ['С', 'C'], ['Е', 'E'], ['Ѕ', 'S'],
  ['І', 'I'], ['Ј', 'J'], ['К', 'K'], ['М', 'M'], ['Н', 'H'],
  ['О', 'O'], ['Р', 'P'], ['Т', 'T'], ['У', 'Y'], ['Х', 'X'],
  // Carried from the other round-four lane's curated map, which reached four
  // code points this one did not: the Cyrillic Straight U and the Komi Qa/Wa
  // capitals, and the Greek lunate sigma.
  ['Ү', 'Y'], ['Ԛ', 'Q'], ['Ԝ', 'W'], ['ϲ', 'c'],
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
 *
 * **U+2800 BRAILLE PATTERN BLANK is erased by step 4 even though it has an
 * advance width** (Wave 5 correction round four, the other lane's Low 2). It is
 * `So` — not `Cf`, not `Cc`, not `Default_Ignorable` — so it walked through
 * every property `ERASED_CODE_POINTS` names, and on that lane's head it broke
 * `sk-ABCDEFGHIJKLMNOP0123` into two unmatched halves while leaving every
 * character of the key present and usable. What that class is for is ZERO-INK
 * characters, whatever their width, because those are the ones that defeat a
 * shape without removing the credential. Ordinary whitespace is still
 * deliberately NOT folded: a space inside a credential is a break a reader can
 * see, folding it away would start matching prose, and `Bearer\s+…` is matched
 * on the raw string anyway.
 */
function normalizeForScan(value: string): string {
  return foldConfusableLetters(
    stripCombiningMarks(value).normalize('NFKC').replace(HYPHEN_CONFUSABLES, '-'),
  ).replace(ERASED_CODE_POINTS, '');
}

/** Trivial values are exempt from the key rule so `{ token: null }` is fine. */
function isTrivial(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim().length === 0);
}

/**
 * How deep the walk goes before it REFUSES. A bound rather than a hope: the
 * traversal follows `toJSON`, and a `toJSON` that returns a fresh object every
 * call cannot be closed over by the cycle set.
 *
 * **Reaching it is a refusal, not a stop** (Wave 5 correction round six, High
 * 5). It used to `return`, and the comment on `walk` claimed that was
 * "fail-CLOSED in the only direction that matters: they stop the walk
 * descending, they never stop a finding being raised". That was exactly
 * backwards: `JSON.stringify` has NO depth limit, so everything below the bound
 * is still serialized and still published — stopping the walk IS stopping the
 * finding. Executed through `proposeAction`, whose own comment says the payload
 * "is stored permanently and handed verbatim to an adapter" and which applies
 * both scans: a `ghp_…` at nesting depth 60–63 was refused and the SAME
 * credential at depth 64 was accepted and stored, with the strict scan on the
 * response stopping at 64 as well, so the Founder route served it rather than
 * failing.
 *
 * HQ now refuses what it cannot read in full. That is the same rule the rest of
 * this module applies — a check that could not run is not a check that passed —
 * and it costs nothing real: 64 levels of nesting is far beyond any structure
 * the control plane composes, and a caller that genuinely needs to publish one
 * has a shape problem rather than a scanning problem.
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
 * and `depth` bounds the rest. They are fail-closed for DIFFERENT reasons, and
 * conflating them was the round-five defect (Wave 5 correction round six, High
 * 5):
 *
 *  - the `seen` set stops at a value this walk has ALREADY scanned, so nothing
 *    goes unread and no finding is lost;
 *  - `depth` stops at a value the walk has NOT read, so continuing silently
 *    would publish unscanned content — `JSON.stringify` has no depth limit.
 *    Reaching it therefore THROWS. See `MAX_SCAN_DEPTH`.
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
  if (depth >= MAX_SCAN_DEPTH) {
    // REFUSED, not skipped. Everything below here would still be serialized and
    // still be published; a scan that stopped would be a finding that never
    // happened.
    throw new BrowserSafetyError(
      `Value nests deeper than ${MAX_SCAN_DEPTH} levels, which is deeper than HQ scans. HQ refuses what it ` +
        'cannot read in full rather than publishing the part it did not read',
      path,
    );
  }
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
 *
 * **The KEY rule reaches exactly one level, and the refusal message reads wider
 * than that** (Wave 5 correction round seven, Low 8). "Field names a credential
 * holder and carries a value" applies only where the value is a string or a
 * number: `{token: 'x'}` and `{token: 12345}` are refused, and
 * `{token: {v: 'x'}}` and `{token: ['x']}` are not, because the walk descends
 * into the container and the key it then sees is `v` or an index rather than
 * `token`. That is the right trade — refusing every object under a
 * credential-named key would refuse `{apiKeyStatus: {present: true}}`, which is
 * exactly the PRESENCE shape this boundary exists to allow — but it is narrower
 * than the sentence sounds, so it is written down. What still covers the nested
 * case is the VALUE rule, which runs on every string at every depth: a
 * credential-SHAPED string is refused wherever it sits. What is not covered is
 * a credential that is neither shaped like one nor a direct scalar under a
 * credential-named key, and that is the same residual the split-value paragraph
 * above states.
 */
export function assertBrowserSafe(payload: unknown, rootPath = 'snapshot'): void {
  walk(payload, rootPath, (value, path, key) => {
    // Both round-four lanes made the key rule read the NORMALIZED name too, for
    // the same reason the value rule does: a field named with one Cyrillic
    // lookalike is still a field that names a credential holder. One spelling
    // of it survives — `namesACredentialHolder` — because the rule is asked in
    // more than one place.
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
