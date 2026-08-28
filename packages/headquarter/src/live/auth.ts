/**
 * The Founder authentication boundary for browser writes (issue #200, Founder
 * decision of 2026-08-28).
 *
 * ## What this module is for
 *
 * Until now Headquarter could not authenticate a human at all, and said so:
 * `live/local-trust.ts` deliberately has no `authenticated` value, because
 * nothing in the system could earn one. The Founder has now decided the
 * mechanism that earns it — **reuse the existing JENIFY OS login and its
 * server-resolved session**, plus an explicit server-side mapping from a
 * JENIFY OS account to the canonical HQ Founder principal.
 *
 * This module is that boundary, and nothing more. It answers exactly one
 * question — *which registered HQ human principal is making this request, if
 * any* — and it answers it only from facts the host resolved server-side.
 *
 * ## Authentication is not authorization
 *
 * The boundary proves WHO. It never decides WHAT that identity may do. A
 * resolved Founder still passes through `HeadquarterOperations`, which applies
 * the principal registry's originate grants, the capability registry's risk
 * class, `founder_gate` policy, no-self-approval, the action digest, provider
 * binding, fencing and the kill switch exactly as before. Nothing here widens
 * any of them, and `resolveFounderPrincipal` deliberately does NOT check
 * `approvalAuthority`: that is an authorization question and it belongs to the
 * layer that already owns it.
 *
 * ## The five ways this fails closed
 *
 * 1. **Identity is never read from the request.** The caller-supplied body is
 *    scanned for identity-shaped keys and the request is REFUSED if any is
 *    present — not ignored, refused, so a client that believes it can name a
 *    principal learns immediately that it cannot. The acting principal comes
 *    only from `SessionResolverPort`, which the host implements over its own
 *    session store.
 * 2. **No session, expired session, revoked session → no principal.** All
 *    three are one case here: the resolver returns null and the boundary
 *    stops. The resolver is contractually required to enforce expiry and
 *    revocation on EVERY request, never to cache a decision.
 * 3. **The Founder mapping is explicit configuration.** There is no inference
 *    from username, display name, email, admin role, "first user", or tenant
 *    ownership. An unconfigured, malformed, or ambiguous map authenticates
 *    nobody — an empty map is valid and means the browser controls stay off.
 * 4. **The mapped principal must still exist and be active in the HQ
 *    registry.** A binding to a deleted or deactivated principal opens
 *    nothing.
 * 5. **Cross-site requests are refused before identity is even resolved.**
 *    An unlisted or absent `Origin` on a state-changing request is rejected,
 *    and the allow-list starts empty, so a host that forgets to configure it
 *    gets no mutations rather than open ones.
 */

import type { HumanPrincipal, HumanPrincipalPort } from '../application/principals.js';

/* ------------------------------------------------------------------ */
/* The account, as the host resolved it                                */
/* ------------------------------------------------------------------ */

/**
 * A JENIFY OS account the HOST resolved from its own session store.
 *
 * Every field is server-derived. None of it may be assembled from a request
 * body, header, or query parameter other than the opaque session credential
 * the host's own session layer validates.
 */
export interface AuthenticatedAccount {
  /** Tenant/realm the account lives in. Part of the mapping key. */
  realmId: string;
  /** Stable account id within the realm. Part of the mapping key. */
  accountId: string;
  /** Label for audit and display. NEVER authority, never part of the key. */
  displayName: string;
  /**
   * When this session was established (ISO 8601). Drives step-up freshness
   * only; it can never substitute for the mapping.
   */
  authenticatedAt: string;
}

/**
 * The host's session layer.
 *
 * The contract, which the boundary cannot verify and therefore states as a
 * requirement on the implementer: resolve the session on EVERY call, and
 * return null for a missing, expired, revoked, or deactivated-user session.
 */
export interface SessionResolverPort {
  resolve(request: ControlRequest): AuthenticatedAccount | null;
}

/** Re-verify the account's own password, for step-up on high-risk actions. */
export interface CredentialVerifierPort {
  verify(account: AuthenticatedAccount, password: string): boolean;
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/**
 * A request, reduced to what the boundary is allowed to look at.
 *
 * Deliberately has no `user`, `principal`, `session` or `cookies` field: the
 * boundary must not be able to read an identity out of the request even by
 * accident. The host passes the raw credential to its own resolver instead.
 */
export interface ControlRequest {
  method: string;
  /** Path with query string already removed. */
  path: string;
  /** Header names lower-cased by the host. */
  headers: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body, or undefined. */
  body?: unknown;
}

/**
 * Body keys that would be an attempt to supply identity or trust from the
 * client. Their PRESENCE is an error, whatever the value: a request that
 * carries one was written against a different, weaker security model, and
 * silently dropping it would let that client keep believing it worked.
 *
 * `actorAuthentication` is here for the same reason as the identity keys —
 * it is the marker recording how much is known about the caller, and a client
 * that could set it could upgrade its own trust level.
 */
export const CLIENT_IDENTITY_KEYS: readonly string[] = [
  'principalId',
  'principal',
  'founderId',
  'founder',
  'isFounder',
  'requestedBy',
  'by',
  'actor',
  'actorAuthentication',
  'accountId',
  'userId',
  'realmId',
  'tenantId',
  'role',
  'roleName',
  'permissions',
  'sessionToken',
  'token',
];

export type ClientIdentityScan = { ok: true } | { ok: false; key: string };

/** Refuse a body that tries to name who is acting. Top level and one nesting deep. */
export function scanForClientIdentity(body: unknown, depth = 0): ClientIdentityScan {
  if (body == null || typeof body !== 'object') return { ok: true };
  if (Array.isArray(body)) {
    for (const entry of body) {
      const nested = scanForClientIdentity(entry, depth + 1);
      if (!nested.ok) return nested;
    }
    return { ok: true };
  }
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (CLIENT_IDENTITY_KEYS.includes(key)) return { ok: false, key };
    if (depth < 3) {
      const nested = scanForClientIdentity((body as Record<string, unknown>)[key], depth + 1);
      if (!nested.ok) return nested;
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Origin / CSRF                                                       */
/* ------------------------------------------------------------------ */

export const STATE_CHANGING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export type OriginRejection =
  | 'origin_missing'
  | 'origin_not_allowed'
  | 'origin_allowlist_empty'
  | 'content_type_not_json';

export type OriginCheck = { ok: true } | { ok: false; reason: OriginRejection; message: string };

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    // Origin is scheme + host + port only. Anything else in the header is not
    // an origin and is refused rather than trimmed into one.
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Reject any cross-site state-changing request.
 *
 * Two independent gates, because each one alone has a known gap:
 *
 * - **Origin allow-list.** Browsers always send `Origin` on a cross-origin
 *   state-changing request, and on same-origin POSTs too. A missing header on
 *   a mutation therefore means a non-browser client or a stripped proxy, and
 *   is refused rather than trusted. The literal string `null` (sandboxed
 *   iframe, `file://`, some redirect chains) is not an origin and never
 *   matches.
 * - **JSON content type.** An HTML form can be submitted cross-site without
 *   any CORS preflight, but only as `application/x-www-form-urlencoded`,
 *   `multipart/form-data` or `text/plain`. Requiring `application/json`
 *   forces a preflight the browser will refuse to complete, so the classic
 *   form-post CSRF cannot even reach the handler.
 *
 * The allow-list starting EMPTY is the point: a host that forgets to
 * configure origins gets no mutations at all.
 */
export function checkMutationOrigin(
  request: ControlRequest,
  allowedOrigins: readonly string[],
): OriginCheck {
  if (!STATE_CHANGING_METHODS.includes(request.method.toUpperCase())) return { ok: true };

  const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return {
      ok: false,
      reason: 'content_type_not_json',
      message:
        'State-changing HQ requests must be sent as application/json. A cross-site HTML form ' +
        'cannot set that content type without a preflight the browser will refuse.',
    };
  }

  const allowed = allowedOrigins
    .map((entry) => normalizeOrigin(entry))
    .filter((entry): entry is string => entry !== null);
  if (allowed.length === 0) {
    return {
      ok: false,
      reason: 'origin_allowlist_empty',
      message:
        'No trusted origin is configured for HQ browser control, so every state-changing ' +
        'request is refused. Configuring the allow-list is a deliberate deployment action.',
    };
  }

  const raw = request.headers.origin;
  if (!raw) {
    return {
      ok: false,
      reason: 'origin_missing',
      message:
        'This state-changing request carries no Origin header. A browser always sends one, so ' +
        'the request is refused rather than trusted.',
    };
  }
  const origin = normalizeOrigin(raw);
  if (origin === null || !allowed.includes(origin)) {
    return {
      ok: false,
      reason: 'origin_not_allowed',
      message: 'This request came from an origin that is not trusted for HQ browser control.',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The Founder mapping                                                 */
/* ------------------------------------------------------------------ */

/**
 * One explicit binding: this JENIFY OS account IS this HQ human principal.
 *
 * The key is (realmId, accountId) — a stable server-side identifier pair,
 * never a username or an email, because both are mutable and a rename would
 * silently move Founder authority.
 */
export interface FounderBinding {
  realmId: string;
  accountId: string;
  principalId: string;
}

export type FounderMapProblem = 'malformed' | 'ambiguous';

export type FounderMapResult =
  | { ok: true; bindings: readonly FounderBinding[] }
  | { ok: false; reason: FounderMapProblem; message: string };

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the configured Founder map, fail-closed.
 *
 * An empty array is VALID and means "no Founder account is bound here" — the
 * browser controls stay off and every mutation is refused. That is a real,
 * expected deployment state, and it is deliberately distinguished from a
 * BROKEN map, which is an error the operator has to see and fix.
 *
 * Two shapes are refused as ambiguous rather than resolved by precedence:
 * the same account bound twice (which principal wins?) and the same principal
 * bound to two accounts (two logins sharing one Founder identity, so an
 * approval could not be attributed to a person). Neither has a safe default.
 */
export function loadFounderBindings(raw: unknown): FounderMapResult {
  if (raw == null) return { ok: true, bindings: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'The HQ Founder map must be an array of bindings.',
    };
  }
  const bindings: FounderBinding[] = [];
  const seenAccounts = new Set<string>();
  const seenPrincipals = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        reason: 'malformed',
        message: `HQ Founder map entry ${index} is not an object.`,
      };
    }
    const record = entry as Record<string, unknown>;
    const realmId = nonEmptyString(record.realmId);
    const accountId = nonEmptyString(record.accountId);
    const principalId = nonEmptyString(record.principalId);
    if (!realmId || !accountId || !principalId) {
      return {
        ok: false,
        reason: 'malformed',
        message:
          `HQ Founder map entry ${index} needs non-empty realmId, accountId and principalId. ` +
          'A guessed username or email is never accepted in their place.',
      };
    }
    const accountKey = `${realmId} ${accountId}`;
    if (seenAccounts.has(accountKey)) {
      return {
        ok: false,
        reason: 'ambiguous',
        message:
          `HQ Founder map binds account ${accountId} more than once. There is no safe rule for ` +
          'which principal wins, so the whole map is refused.',
      };
    }
    if (seenPrincipals.has(principalId)) {
      return {
        ok: false,
        reason: 'ambiguous',
        message:
          `HQ Founder map binds principal ${principalId} to more than one account. An approval ` +
          'could then not be attributed to one person, so the whole map is refused.',
      };
    }
    seenAccounts.add(accountKey);
    seenPrincipals.add(principalId);
    bindings.push({ realmId, accountId, principalId });
  }
  return { ok: true, bindings };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export type FounderDenial =
  | 'unauthenticated'
  | 'founder_map_unconfigured'
  | 'founder_map_malformed'
  | 'founder_map_ambiguous'
  | 'not_founder'
  | 'principal_unknown'
  | 'principal_inactive';

export interface ResolvedFounder {
  account: AuthenticatedAccount;
  binding: FounderBinding;
  principal: HumanPrincipal;
}

export type FounderResolution =
  | { ok: true; founder: ResolvedFounder }
  | { ok: false; reason: FounderDenial; message: string };

/** HTTP status each denial maps to. Anything authenticated-but-refused is 403. */
export const FOUNDER_DENIAL_STATUS: Readonly<Record<FounderDenial, number>> = {
  unauthenticated: 401,
  founder_map_unconfigured: 403,
  founder_map_malformed: 403,
  founder_map_ambiguous: 403,
  not_founder: 403,
  principal_unknown: 403,
  principal_inactive: 403,
};

export interface FounderResolutionDeps {
  sessions: SessionResolverPort;
  principals: HumanPrincipalPort;
  /** The RAW configured map. Parsed here so a broken map fails closed per request. */
  founderMap: unknown;
}

/**
 * Resolve the acting HQ Founder principal, or say precisely why not.
 *
 * The order matters and is deliberate: authentication first, so an anonymous
 * caller can never learn anything about the Founder map; then the map; then
 * the registry. A non-Founder authenticated user is told only `not_founder` —
 * never which account IS the Founder.
 */
export function resolveFounderPrincipal(
  request: ControlRequest,
  deps: FounderResolutionDeps,
): FounderResolution {
  const account = deps.sessions.resolve(request);
  if (!account) {
    return {
      ok: false,
      reason: 'unauthenticated',
      message: 'Sign in to JENIFY OS first. HQ has no sign-in of its own.',
    };
  }

  const map = loadFounderBindings(deps.founderMap);
  if (!map.ok) {
    return {
      ok: false,
      reason: map.reason === 'malformed' ? 'founder_map_malformed' : 'founder_map_ambiguous',
      message: map.message,
    };
  }
  if (map.bindings.length === 0) {
    return {
      ok: false,
      reason: 'founder_map_unconfigured',
      message:
        'No JENIFY OS account is bound to the HQ Founder principal here, so the Founder ' +
        'controls are off. Binding one is an explicit configuration action.',
    };
  }

  const binding = map.bindings.find(
    (entry) => entry.realmId === account.realmId && entry.accountId === account.accountId,
  );
  if (!binding) {
    return {
      ok: false,
      reason: 'not_founder',
      message: 'This account is signed in but is not the HQ Founder.',
    };
  }

  const principal = deps.principals.get(binding.principalId);
  if (!principal) {
    return {
      ok: false,
      reason: 'principal_unknown',
      message:
        `The Founder map points at HQ principal ${binding.principalId}, which is not registered ` +
        'here. The binding opens nothing.',
    };
  }
  if (!principal.active) {
    return {
      ok: false,
      reason: 'principal_inactive',
      message: `HQ principal ${binding.principalId} is deactivated.`,
    };
  }

  return { ok: true, founder: { account, binding, principal } };
}

/* ------------------------------------------------------------------ */
/* Step-up for high-risk actions                                       */
/* ------------------------------------------------------------------ */

/**
 * How recently the session must have been established for it to stand in for
 * a fresh credential. Short on purpose: the point of step-up is that a
 * long-lived cookie on an unattended machine is not consent to an
 * irreversible action.
 */
export const STEP_UP_MAX_SESSION_AGE_MS = 5 * 60_000;

/**
 * Risk classes whose APPROVAL requires a fresh credential.
 *
 * Approval is where irreversibility begins, so that is where step-up sits.
 * Creating a direct order deliberately does not require it: a created order
 * executes nothing — it lands in `needs_approval` behind the digest gate, and
 * the approval is the step-up-protected act.
 *
 * A denial is never an authorization and is never step-up-gated: making it
 * harder to STOP something than to allow it would be exactly backwards.
 */
export const STEP_UP_RISK_CLASSES: readonly string[] = ['founder_gate', 'destructive'];

export type StepUpFailure = 'step_up_required' | 'step_up_failed' | 'step_up_unavailable';

export type StepUpResult =
  | { ok: true; via: 'fresh_session' | 'password' }
  | { ok: false; reason: StepUpFailure; message: string };

export interface StepUpDeps {
  credentials?: CredentialVerifierPort;
  now?: Date;
}

/**
 * Satisfy step-up either by a genuinely fresh session or by re-entering the
 * account's password.
 *
 * The password is verified through the host's own credential layer and is
 * never stored, echoed, audited, or included in any response. An
 * unparseable `authenticatedAt` is treated as NOT fresh rather than as an
 * error, so a clock or format problem can only ever make the boundary
 * stricter.
 */
export function verifyStepUp(
  founder: ResolvedFounder,
  supplied: unknown,
  deps: StepUpDeps = {},
): StepUpResult {
  const now = (deps.now ?? new Date()).getTime();
  const established = Date.parse(founder.account.authenticatedAt);
  if (Number.isFinite(established) && established <= now && now - established <= STEP_UP_MAX_SESSION_AGE_MS) {
    return { ok: true, via: 'fresh_session' };
  }

  const password = typeof supplied === 'string' ? supplied : '';
  if (password.length === 0) {
    return {
      ok: false,
      reason: 'step_up_required',
      message:
        'This action is irreversible, and the current session is older than the step-up window. ' +
        'Re-enter your JENIFY OS password to confirm it.',
    };
  }
  if (!deps.credentials) {
    return {
      ok: false,
      reason: 'step_up_unavailable',
      message:
        'No credential verifier is wired here, so a step-up confirmation cannot be checked and ' +
        'the action is refused.',
    };
  }
  if (!deps.credentials.verify(founder.account, password)) {
    return {
      ok: false,
      reason: 'step_up_failed',
      message: 'That password did not match. Nothing was changed.',
    };
  }
  return { ok: true, via: 'password' };
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export interface ControlAuditEvent {
  at: string;
  route: string;
  outcome: 'allowed' | 'refused';
  /** Denial/refusal code, or the action name when allowed. */
  detail: string;
  /** Present only once a session resolved. Never a token, never a password. */
  accountId?: string;
  realmId?: string;
  principalId?: string;
}

/**
 * Where privileged HQ browser activity is recorded.
 *
 * The event shape has no field for a credential, a session token, a password,
 * or a request body, so an implementation cannot log one by following the
 * contract.
 */
export interface ControlAuditPort {
  record(event: ControlAuditEvent): void;
}
