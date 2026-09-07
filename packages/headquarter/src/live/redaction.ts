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
 * Every code point that renders as nothing and is therefore usable to break a
 * credential pattern without changing what a reader sees.
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
 *    exactly the same invisible way.
 *
 * Naming a property rather than a range is what makes this hold for code points
 * nobody enumerated, which is why the pinning test uses characters this comment
 * does not list.
 */
const INVISIBLE_CODE_POINTS =
  /[\p{Default_Ignorable_Code_Point}\p{Cf}\u034F\u2028\u2029]/gu;

/**
 * Fold away the two cheap ways to hide a credential shape from a regex:
 * invisible characters inside it, and compatibility variants of its separators.
 *
 * `NFKC` maps the fullwidth forms (`－`, `＿`, `．`) onto the ASCII
 * the patterns look for; the strip removes every invisible code point NFKC
 * leaves alone. Scanning the normalized form only — the ORIGINAL string is
 * what gets refused or published, so this widens what is caught and never
 * rewrites what is carried.
 *
 * NFKC runs FIRST and the strip SECOND, deliberately: a compatibility form can
 * decompose around an invisible character, so stripping afterwards catches a
 * shape that only becomes contiguous once the folding has happened.
 */
function normalizeForScan(value: string): string {
  return value.normalize('NFKC').replace(INVISIBLE_CODE_POINTS, '');
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
    if (key != null && SECRET_KEY_PATTERN.test(key) && !isTrivial(value)) {
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
