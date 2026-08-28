import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  handleControlRequest,
  CONTROL_API_PREFIX,
  type ControlApiDeps,
  type ControlAuditPort,
  type ControlRequest,
  type SessionResolverPort,
  type CredentialVerifierPort,
} from '@factoryos/headquarter/live';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE } from '../app.js';
import { resolveSessionRecord, verifyAccountPassword } from '../services/auth.js';
import {
  assertNotRateLimited,
  recordAuthFailure,
  clearAuthFailures,
} from '../services/ratelimit.js';

/**
 * The JENIFY OS host adapter for the Headquarter browser-control API
 * (issue #200, Founder decision of 2026-08-28).
 *
 * ## Why HQ's write path is mounted HERE
 *
 * The Founder decided that HQ reuses the existing JENIFY OS login rather than
 * growing a second password system. A browser only sends `fos_session` to the
 * host that set it, so the only place the decision can actually be
 * implemented is inside this server. Mounting it anywhere else would have
 * meant either a second credential (refused) or a cross-origin cookie
 * arrangement (weaker, and unnecessary).
 *
 * ## What this file is allowed to be
 *
 * An adapter and nothing more. It translates Fastify to the reduced request
 * shape and back, and supplies three ports. Every authority decision —
 * session → account → configured Founder map → registered principal, origin,
 * step-up, and the canonical Operator rules underneath — lives in
 * `@factoryos/headquarter`'s `live/auth.ts` and `live/control-api.ts`, where
 * it is unit-testable without a server. Nothing here may add a route, widen a
 * check, or shortcut one.
 *
 * ## Opt-in, so the tenant platform is unchanged by default
 *
 * `buildApp` registers this only when it is handed an explicit control plane.
 * An ordinary JENIFY OS deployment — the Mesob pilot included — passes
 * nothing, gets no HQ routes at all, and is byte-for-byte unaffected.
 */

/**
 * Everything the host must decide deliberately before HQ browser writes exist.
 *
 * There is no default for any of it. In particular `founderMap` and
 * `allowedOrigins` have no fallback: an unconfigured deployment authenticates
 * no Founder and accepts no mutation.
 */
export type HeadquarterControlPlane = Pick<
  ControlApiDeps,
  'ops' | 'principals' | 'founderMap' | 'allowedOrigins' | 'secretsEnv'
> & {
  /**
   * Set false to expose the read routes without the write routes — the safe
   * posture while a deployment's Founder binding is still being established.
   */
  mutationsEnabled?: boolean;
  audit?: ControlAuditPort;
};

/**
 * Resolve the acting account from the session cookie ONLY.
 *
 * This is the single place a JENIFY OS identity enters HQ. It reads the
 * opaque cookie and hands it to the same `resolveSessionRecord` the rest of
 * the app uses, so expiry, revocation and account deactivation are enforced
 * on every request rather than cached. It never looks at the body, the query
 * string, or any header other than the cookie.
 */
function sessionResolver(db: Db, token: string | undefined): SessionResolverPort {
  return {
    resolve() {
      if (!token) return null;
      const record = resolveSessionRecord(db, token);
      if (!record) return null;
      return {
        realmId: record.user.tenantId,
        accountId: record.user.id,
        displayName: record.user.displayName,
        authenticatedAt: record.establishedAt,
      };
    },
  };
}

/**
 * Step-up password verification, under the SAME failure budget as login and
 * recovery.
 *
 * Without a budget this endpoint is the softest target in the system, and
 * precisely against the attacker step-up exists to stop: someone holding a
 * stale Founder session can already reach it, so unlimited guesses here would
 * turn a stolen cookie into a password oracle. `verifyPassword` is a
 * synchronous scrypt, so each guess also blocks the event loop — an unbudgeted
 * verifier is a denial-of-service surface as well as a guessing one. The
 * budget bounds both.
 *
 * ## Why the key says `login`
 *
 * `sourceKeyOf` collapses a key to `ip|<second component>|*`, so that second
 * component — not the identifier — is what decides which failures share a
 * per-source ceiling. An earlier version keyed this `ip|hq-stepup|account`
 * and claimed to share login's budget; it did not. It produced its own
 * `ip|hq-stepup|*` ceiling, so exhausting the login budget constrained
 * step-up not at all and an attacker who ran out of login guesses got a fresh
 * allowance simply by moving to this endpoint (issue #200, Codex round 2 P2).
 *
 * Naming the family `login` is what makes the shared ceiling real: failures
 * here charge the same `ip|login|*` bucket that failed sign-ins do, in both
 * directions. The `hq-stepup:` prefix on the identifier keeps the per-account
 * buckets distinct, so a locked-out step-up account does not lock a different
 * account's sign-in. A correct password clears only its own bucket, exactly as
 * a successful sign-in does — the source ceiling is deliberately not cleared,
 * so a spray in progress is not wiped by one success.
 */
const STEP_UP_RATE_LIMIT_FAMILY = 'login';

function credentialVerifier(db: Db, ip: string): CredentialVerifierPort {
  return {
    verify(account, password) {
      const key = `${ip}|${STEP_UP_RATE_LIMIT_FAMILY}|hq-stepup:${account.accountId}`;
      try {
        assertNotRateLimited(key);
      } catch {
        return 'rate_limited';
      }
      if (!verifyAccountPassword(db, account.accountId, password)) {
        recordAuthFailure(key);
        return 'rejected';
      }
      clearAuthFailures(key);
      return 'ok';
    },
  };
}

export function registerHeadquarterRoutes(
  app: FastifyInstance,
  db: Db,
  plane: HeadquarterControlPlane,
): void {
  const handle = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const method = req.method.toUpperCase();
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : (value as string | undefined);
    }
    const path = req.url.split('?')[0]!;
    const control: ControlRequest = { method, path, headers, body: req.body };

    // Ports are built PER REQUEST, closed over this request's cookie and
    // source address. `ControlRequest` deliberately has no field a credential
    // or an IP could sit in — that shape is what stops the boundary reading
    // identity out of a body — so the two are bound here instead, where they
    // cannot be reached by anything the caller sends.
    const deps: ControlApiDeps = {
      ops: plane.ops,
      principals: plane.principals,
      founderMap: plane.founderMap,
      allowedOrigins: plane.allowedOrigins,
      secretsEnv: plane.secretsEnv,
      // The flag is passed through rather than enforced here, so the layer that
      // refuses a write is the same one that tells the console whether the
      // button works. Enforcing it in this adapter left the two disagreeing.
      mutationsEnabled: plane.mutationsEnabled,
      sessions: sessionResolver(db, req.cookies?.[SESSION_COOKIE]),
      credentials: credentialVerifier(db, req.ip),
      audit: plane.audit,
    };

    const result = handleControlRequest(control, deps);
    // No caching of an authenticated, principal-specific answer, ever.
    reply.header('cache-control', 'no-store');
    reply.status(result.status).send(result.body);
  };

  // One wildcard registration per method, so the deny-by-default route table
  // lives in ONE place (`control-api.ts`) instead of being restated here where
  // the two could drift.
  app.get(`${CONTROL_API_PREFIX}/*`, handle);
  app.post(`${CONTROL_API_PREFIX}/*`, handle);
}
