/**
 * Connector safety primitives (issue #140 / #123, HQ lane G).
 *
 * Everything a connector reads is untrusted: titles, bodies, filenames and
 * URLs are written by anyone who can open an issue or share a document, and
 * the Drive/GitHub metadata around them can be malformed or hostile. This
 * module is the single choke point where that input is made safe before it
 * becomes an index record:
 *
 * - `scrubSecrets` / `assertNoSecretMaterial` — credentials never get
 *   serialized into a snapshot, sync state, or evidence payload.
 * - `sanitizeText` — control characters stripped, length bounded, never null
 *   bytes or terminal escapes in a stored title.
 * - `classifyLocator` — only vetted `https:` locators become clickable; every
 *   other locator is preserved verbatim but marked non-linkable.
 * - `recordDigest` — deterministic content digest, the basis of idempotency.
 *
 * HTML escaping is deliberately NOT done here: storage keeps the original
 * text, and `ui/render.ts` escapes at render time. Escaping twice would
 * corrupt the archived value.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../operator/approvals.js';

/* ------------------------------------------------------------------ */
/* Secret material                                                     */
/* ------------------------------------------------------------------ */

/** Object keys whose *values* are assumed to be credentials, whatever they hold. */
const SECRET_KEY_PATTERN =
  /^(.*[_-])?(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|passphrase|private[_-]?key|credentials?|authorization|auth[_-]?header|cookie|session[_-]?id|bearer|oauth[_-]?token|service[_-]?account[_-]?key)([_-].*)?$/i;

/**
 * High-signal secret shapes in free text. Kept narrow on purpose: a false
 * positive redacts a fragment of an archived summary, so the patterns target
 * real credential formats plus the classic `key: value` disclosure.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bsk-[A-Za-z0-9-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
];

export const REDACTION_PLACEHOLDER = '[redacted]';

export interface ScrubResult<T> {
  value: T;
  /** Dotted paths that were redacted, e.g. `owners.0.emailAddress`. */
  redactedPaths: string[];
}

function redactText(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Fresh lastIndex each call: these are module-level /g regexes.
    pattern.lastIndex = 0;
    if (pattern.test(out)) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTION_PLACEHOLDER);
      redacted = true;
    }
  }
  return { text: out, redacted };
}

/**
 * Deep copy with credentials removed. Values under a secret-looking key are
 * dropped entirely (not replaced with their length or a prefix); secret
 * shapes inside free text are replaced with `[redacted]`.
 *
 * Returns the redacted paths so the caller can raise a truthful
 * `secret_material` issue instead of silently swallowing the finding.
 */
export function scrubSecrets<T>(value: T): ScrubResult<T> {
  const redactedPaths: string[] = [];

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      const { text, redacted } = redactText(node);
      if (redacted) redactedPaths.push(path || '(root)');
      return text;
    }
    if (Array.isArray(node)) return node.map((entry, i) => walk(entry, path ? `${path}.${i}` : String(i)));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SECRET_KEY_PATTERN.test(key)) {
          redactedPaths.push(childPath);
          continue;
        }
        out[key] = walk(entry, childPath);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value, '') as T, redactedPaths };
}

/**
 * Fail-closed backstop: throws if anything secret-looking survives. Used on
 * finished snapshots and on access descriptors, where a credential can only
 * be a caller bug — never on raw source items, which are scrubbed instead.
 */
export function assertNoSecretMaterial(value: unknown, context: string): void {
  const { redactedPaths } = scrubSecrets(value);
  if (redactedPaths.length > 0) {
    throw new Error(`${context}: refused — secret-like material at ${redactedPaths.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** C0/C1 control characters and Unicode bidi/zero-width trickery. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export const MAX_TITLE_LENGTH = 300;
export const MAX_SUMMARY_LENGTH = 280;

/**
 * Normalize untrusted text: control characters removed, whitespace collapsed,
 * length bounded, secrets redacted. Returns null for anything that is not a
 * usable string, so the caller can raise `malformed_metadata` rather than
 * fabricate a placeholder value.
 */
export function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = redactText(value).text
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/* ------------------------------------------------------------------ */
/* Locators                                                            */
/* ------------------------------------------------------------------ */

/**
 * Schemes allowed to become clickable links, matching `ui/render.ts`.
 * Everything else — `javascript:`, `data:`, `file:`, `drive://`, plain repo
 * paths — is kept verbatim but rendered as inert text.
 */
const LINKABLE_SCHEME = 'https:';

export interface LocatorClassification {
  /** The locator, preserved verbatim. Never rewritten. */
  locator: string;
  linkable: boolean;
  /** Why a locator was demoted; null when it is linkable. */
  reason: string | null;
}

/**
 * Decide, once and centrally, whether an external locator may be clickable.
 *
 * A locator is linkable only when it is a well-formed `https:` URL, carries no
 * embedded credentials, and its host is in the caller's allowlist. Hostile
 * schemes are not an error — the record still exists and still points at its
 * original — they simply never become a link.
 */
export function classifyLocator(raw: unknown, allowedHosts: readonly string[]): LocatorClassification {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { locator: '', linkable: false, reason: 'locator missing' };
  }
  const locator = raw.trim();
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return { locator, linkable: false, reason: 'not an absolute URL' };
  }
  if (url.protocol !== LINKABLE_SCHEME) {
    return { locator, linkable: false, reason: `scheme ${url.protocol} is not linkable` };
  }
  if (url.username !== '' || url.password !== '') {
    return { locator, linkable: false, reason: 'URL carries embedded credentials' };
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  if (!allowed) {
    return { locator, linkable: false, reason: `host ${host} is not an allowed source host` };
  }
  return { locator, linkable: true, reason: null };
}

/* ------------------------------------------------------------------ */
/* Digests                                                             */
/* ------------------------------------------------------------------ */

/**
 * Content digest for change detection. Covers identity and content only —
 * never observation timestamps or snapshot-level confidence — so re-reading
 * an unchanged source is a no-op and a partial page never looks like an edit.
 */
export function recordDigest(fields: {
  connector: string;
  sourceType: string;
  sourceId: string;
  locator: string;
  sourceVersion: string | null;
  sourceUpdatedAt: string | null;
  title: string;
  project: string;
  category: string;
  summary: string;
  lifecycle: string;
}): string {
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
