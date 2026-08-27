/**
 * Connector safety helpers: secret refusal, untrusted-text sanitization and
 * link safety.
 *
 * Connector input is external and hostile by assumption — issue titles, Drive
 * file names, `html_url` values and error messages are all attacker-influenced.
 * Everything crossing into the index passes through here first.
 *
 * The primary defence against secret leakage is architectural (credentials
 * never enter this package: connectors receive pages from an already-authorized
 * port). These functions are the backstop that keeps a leaked token from being
 * serialized into an index record, a problem message, or a log line.
 */

/** Named patterns so a refusal can say what it matched without echoing it. */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { label: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'google-oauth-token', pattern: /\bya29\.[A-Za-z0-9._-]{10,}/ },
  { label: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{20,}\b/ },
  { label: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/ },
  { label: 'bearer-header', pattern: /\bbearer\s+[A-Za-z0-9._-]{16,}/i },
  {
    label: 'labelled-credential',
    pattern:
      /(api[_-]?key|client[_-]?secret|secret|password|passwd|refresh[_-]?token|access[_-]?token|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
  },
];

/** Config keys a connector configuration must never carry. */
const CREDENTIAL_FIELD_PATTERN =
  /(^|[_.-])(token|secret|password|passwd|credential|credentials|apikey|api_key|private_key|refresh_token|access_token|client_secret|authorization|auth_header|bearer)($|[_.-])/i;

const REDACTED = '[redacted]';

/** Labels of every secret pattern found in `text`. Never returns the match. */
export function findSecretLike(text: string): string[] {
  const found: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) found.push(label);
  }
  return found;
}

/** Replace anything that looks like secret material with `[redacted]`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'), REDACTED);
  }
  return out;
}

/**
 * Refuse to serialize a value carrying secret material. Used at the boundary
 * where connector output would be persisted or logged.
 */
export function assertNoSecretMaterial(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const found = findSecretLike(text ?? '');
  if (found.length > 0) {
    throw new Error(`${label} rejected: contains secret-like content (${found.join(', ')})`);
  }
}

/**
 * Refuse a connector configuration that carries credentials. Authorization is
 * the caller's business; a connector config describes WHAT to read, never how
 * to authenticate.
 */
export function assertNoCredentialFields(label: string, config: unknown): void {
  if (!config || typeof config !== 'object') return;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (CREDENTIAL_FIELD_PATTERN.test(key)) {
        throw new Error(`${label} rejected: credential-like field "${here}" is not allowed in connector config`);
      }
      walk(value, here, depth + 1);
    }
  };
  walk(config, '', 0);
  assertNoSecretMaterial(label, config);
}

/**
 * Normalize untrusted text: drop control characters, collapse whitespace,
 * redact secret-like content, and cap the length. HTML is NOT interpreted or
 * stripped here — it is escaped at render time by the UI layer; removing tags
 * silently would corrupt legitimate titles that contain angle brackets.
 */
export function sanitizeText(raw: unknown, maxLength = 500): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, ' ');
  const collapsed = redactSecrets(stripped).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

/**
 * Schemes a connector locator may use to become a clickable link. Mirrors the
 * archive UI's allowlist (`renderSourceRef`): anything else renders as inert
 * text. Kept as its own constant so the connector layer does not depend on
 * the UI package.
 */
export const LINKABLE_SCHEMES = ['https:'] as const;

export interface LocatorCheck {
  /** Sanitized locator. Empty when the input was unusable. */
  locator: string;
  /** True only when the locator may safely be rendered as a link. */
  linkSafe: boolean;
  /** Reason the locator is not link-safe, when it is not. */
  note?: string;
}

/**
 * Sanitize an evidence locator and decide whether it may be linked.
 *
 * Not link-safe: non-https schemes (`javascript:`, `data:`, `vbscript:`,
 * `file:`), unparseable strings, and https URLs carrying embedded credentials
 * — those are additionally redacted so the userinfo never reaches storage.
 */
export function sanitizeLocator(raw: unknown): LocatorCheck {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { locator: '', linkSafe: false, note: 'locator_missing' };
  }
  const value = sanitizeText(raw, 2048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Repo-relative paths and Drive ids are legitimate locators; they are just
    // never clickable.
    return { locator: value, linkSafe: false, note: 'locator_not_absolute_url' };
  }
  if (!(LINKABLE_SCHEMES as readonly string[]).includes(url.protocol)) {
    return { locator: value, linkSafe: false, note: `locator_scheme_not_allowed:${url.protocol}` };
  }
  if (url.username !== '' || url.password !== '') {
    url.username = '';
    url.password = '';
    return { locator: url.toString(), linkSafe: false, note: 'locator_had_embedded_credentials' };
  }
  return { locator: value, linkSafe: true };
}

/** Hosts a connector will accept as authoritative for its own evidence. */
export function isHost(locator: string, host: string): boolean {
  try {
    return new URL(locator).host === host;
  } catch {
    return false;
  }
}
