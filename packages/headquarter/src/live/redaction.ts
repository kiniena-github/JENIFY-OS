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
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/i, // OpenAI-style secret key
  /\bgh[pousr]_[A-Za-z0-9]{16,}/i, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/i, // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_-]{20,}/i, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/i, // Google OAuth access token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/i, // Slack token
  /\bsbp_[a-f0-9]{32,}/i, // Supabase personal access token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT (base64url; case IS the payload)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, // PEM private key
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i, // Authorization header value
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
 * Every code point that carries NO INK and is therefore usable to break a
 * credential pattern while leaving every character of the credential present.
 *
 * Defined by PROPERTY, not by a hand-listed range (Wave 5 correction round
 * three, Medium B7). The previous version stripped five ranges somebody chose,
 * and a whole class walked straight through it: U+00AD SOFT HYPHEN, U+034F
 * COMBINING GRAPHEME JOINER, U+180E, U+2028 LINE SEPARATOR, U+2029, U+115F and
 * U+FFA0 HALFWIDTH HANGUL FILLER all passed the scan when placed inside `sk-`,
 * `ghp_`, `github_pat_`, `AIza`, a PEM header, `Bearer ` and a JWT.
 *
 * That was not a snapshot backstop failing quietly. End to end through the
 * Founder route, a plain `sk-…` note was refused 400 while the same note
 * carrying one U+00AD was stored 201 and came back on the wire on the next
 * read; and through the RETRIEVAL facade — the layer
 * `RETRIEVAL_GUARD_STATEMENT` names as the guarantee — `searchCompany` and
 * `askJenify` refused the plain form and ACCEPTED the invisible-character form.
 *
 *  - `\p{Default_Ignorable_Code_Point}` is Unicode's own name for "renders as
 *    nothing": the soft hyphen, the Hangul fillers, the Mongolian and variation
 *    selectors, the zero-width and bidi controls, the tag characters;
 *  - `\p{Cf}` is the format category, which overlaps it and covers the rest;
 *  - U+034F and U+2028/U+2029 are named explicitly because they are in neither:
 *    the combining grapheme joiner is a combining mark and the line and
 *    paragraph separators are `Zl`/`Zp`, and all three split a pattern in
 *    exactly the same invisible way;
 *  - U+2800 BRAILLE PATTERN BLANK is named for the same reason and is the one
 *    member with an advance WIDTH. It is `So`, not `Cf` and not
 *    `Default_Ignorable`, and it went straight through this class while
 *    splitting `sk-…` in two (Wave 5 correction round four, Low 2). The rule
 *    the class actually follows is zero INK, not zero width — see
 *    `normalizeForScan`.
 *
 * Naming a property rather than a range is what makes this hold for code points
 * nobody enumerated, which is why the pinning test uses characters this comment
 * does not list.
 */
const INVISIBLE_CODE_POINTS =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\u034F\u2028\u2029\u2800]/gu;

/**
 * Latin lookalikes from the two scripts a homoglyph substitution is actually
 * written in, folded onto the ASCII the credential patterns are written in.
 *
 * **Why this exists** (Wave 5 correction round four, Low 3). The value rule
 * matches SHAPES, and a shape is defeated by one character that reads the same
 * and encodes differently: executed against the previous head, Cyrillic
 * `\u0455` in `\u0455k-ABCDEFGHIJKLMNOP0123` and Cyrillic `\u0430` in
 * `AIz\u0430ABCDEFGHIJKLMNOPQRSTUV` both PASSED with the whole key material
 * intact, while the ASCII spellings of both were refused.
 *
 * **What it deliberately is not.** This is not a Unicode confusables
 * implementation — HQ carries no confusables table, and inventing a partial
 * one while calling it complete would be the overclaim. It is a curated map
 * over Cyrillic and Greek, the two scripts that carry a full set of
 * ASCII-identical letters, sit on common keyboard layouts, and are what
 * homoglyph substitution is written in. Cherokee, Armenian, Coptic, Lisu and
 * the rest are NOT folded and a substitution drawn from them still defeats the
 * shape; that limit is stated in the phase document's residual list rather than
 * papered over.
 *
 * **What bounds the false-positive risk, by construction rather than by
 * hope.** Only glyphs that are identical or all-but-identical are included, and
 * the omissions are what matter: Cyrillic `\u043A`, `\u043C`, `\u0442`,
 * `\u0432`, `\u043D` and `\u0433` are NOT mapped, because their glyphs differ
 * from `k`, `m`, `t`, `b`, `h` and `r`; and Cyrillic `\u041D` folds to `H`,
 * `\u0420` to `P` and `\u0421` to `C`, by SHAPE. The consequence is that no
 * Cyrillic word can fold into any of the English keywords the free-text
 * heuristic looks for — `\u0421\u0415\u041A\u0420\u0415\u0422` folds to
 * `CEKPET`, not `SECRET`, and `\u0422\u041E\u041A\u0415\u041D` folds to
 * `TOKEH`, not `TOKEN` — so ordinary Cyrillic prose cannot become a match by
 * being folded. Greek `\u03A4\u039F\u039A\u0395\u039D` does fold to `TOKEN`,
 * which the case-insensitive free-text heuristic then treats exactly as it
 * already treats the English `TOKEN: …`. That is the pre-existing behaviour
 * of that heuristic applied consistently, not a new class of refusal.
 */
const CONFUSABLE_TO_ASCII: ReadonlyMap<string, string> = new Map<string, string>([
  // Cyrillic capitals whose glyph is the Latin capital.
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u0405', 'S'],
  ['\u0406', 'I'], ['\u0408', 'J'], ['\u041A', 'K'], ['\u041C', 'M'],
  ['\u041D', 'H'], ['\u041E', 'O'], ['\u0420', 'P'], ['\u0421', 'C'],
  ['\u0422', 'T'], ['\u0423', 'Y'], ['\u04AE', 'Y'], ['\u0425', 'X'],
  ['\u051A', 'Q'], ['\u051C', 'W'],
  // Cyrillic smalls whose glyph is the Latin small letter.
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u0455', 's'], ['\u0456', 'i'],
  ['\u0458', 'j'], ['\u043E', 'o'], ['\u0440', 'p'], ['\u0441', 'c'],
  ['\u0443', 'y'], ['\u0445', 'x'], ['\u051B', 'q'], ['\u051D', 'w'],
  // Greek capitals whose glyph is the Latin capital.
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'],
  ['\u0397', 'H'], ['\u0399', 'I'], ['\u039A', 'K'], ['\u039C', 'M'],
  ['\u039D', 'N'], ['\u039F', 'O'], ['\u03A1', 'P'], ['\u03A4', 'T'],
  ['\u03A5', 'Y'], ['\u03A7', 'X'],
  // Greek smalls whose glyph is the Latin small letter.
  ['\u03BF', 'o'], ['\u03C1', 'p'], ['\u03F2', 'c'],
]);

const CONFUSABLE_CODE_POINTS = new RegExp(`[${[...CONFUSABLE_TO_ASCII.keys()].join('')}]`, 'gu');

/**
 * Fold away the three cheap ways to hide a credential shape from a regex:
 * invisible characters inside it, compatibility variants of its separators, and
 * letters from another script that read as the ASCII ones.
 *
 * `NFKC` maps the fullwidth forms (`－`, `＿`, `．`) onto the ASCII
 * the patterns look for; the strip removes every zero-ink code point NFKC
 * leaves alone; the confusable fold maps the Cyrillic and Greek lookalikes onto
 * their ASCII counterparts. Scanning the normalized form only — the ORIGINAL
 * string is what gets refused or published, so this widens what is caught and
 * never rewrites what is carried.
 *
 * NFKC runs FIRST and the strip SECOND, deliberately: a compatibility form can
 * decompose around an invisible character, so stripping afterwards catches a
 * shape that only becomes contiguous once the folding has happened. The
 * confusable fold runs LAST, over the text those two have already made
 * contiguous, for the same reason.
 *
 * **U+2800 BRAILLE PATTERN BLANK is stripped, and it is the one member of the
 * stripped class that is not `Default_Ignorable`** (Wave 5 correction round
 * four, Low 2). It carries an advance width, so it is arguably not "invisible"
 * — but it has no ink, and executed against the previous head it broke
 * `sk-ABCDEFGHIJKLMNOP0123` into two unmatched halves while leaving every
 * character of the key present and usable. What this class is for is ZERO-INK
 * characters, whatever their width, because those are the ones that defeat a
 * shape without removing the credential. Ordinary whitespace is deliberately
 * NOT folded: a space inside a credential is a break a reader can see, and
 * folding whitespace away would start matching prose.
 */
function normalizeForScan(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_CODE_POINTS, '')
    .replace(CONFUSABLE_CODE_POINTS, (character) => CONFUSABLE_TO_ASCII.get(character) ?? character);
}

/** Trivial values are exempt from the key rule so `{ token: null }` is fine. */
function isTrivial(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim().length === 0);
}

function walk(value: unknown, path: string, visit: (value: unknown, path: string, key?: string) => void): void {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, `${path}.${key}`, key);
      walk(child, `${path}.${key}`, visit);
    }
  }
}

/**
 * Refuse a payload that could leak a credential to a browser. Throws
 * `BrowserSafetyError` naming the offending path — fail closed, never redact
 * silently, because a silently-redacted snapshot hides the bug that put the
 * secret there.
 */
export function assertBrowserSafe(payload: unknown, rootPath = 'snapshot'): void {
  walk(payload, rootPath, (value, path, key) => {
    // The key rule reads the normalized form too, for the same reason the
    // value rule does: a field named with one Cyrillic lookalike is still a
    // field that names a credential holder.
    if (key != null && !isTrivial(value) && (SECRET_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(normalizeForScan(key)))) {
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
