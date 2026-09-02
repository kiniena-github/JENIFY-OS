import type { FastifyInstance } from 'fastify';
import {
  registerHeadquarterRoutes as hostRegisterRoutes,
  registerHeadquarterSite as hostRegisterSite,
  type HqIdentityPort,
} from '@factoryos/hq-host';
import type { SessionResolverPort, CredentialVerifierPort } from '@factoryos/headquarter/live';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE } from '../app.js';
import {
  accountLoginIdentifier,
  resolveSessionRecord,
  verifyAccountPassword,
} from '../services/auth.js';
import {
  assertNotRateLimited,
  recordAuthFailure,
  clearAuthFailures,
} from '../services/ratelimit.js';

/**
 * The JENIFY OS host adapter for the Headquarter browser-control API
 * (issue #200, Founder decision of 2026-08-28; narrowed in Phase 2, Stage 1).
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
 * ## What is left in this file after Stage 1
 *
 * Exactly the part of that decision that cannot leave: the two identity
 * adapters. They read this server's session store, password store and rate
 * limiter, so they belong to this server. Everything generic — request
 * translation, the wildcard mounting, the Founder-gated static mount, the
 * cache and referrer headers — now lives in `@factoryos/hq-host`, which HQ can
 * carry to a process that never loads the tenant platform.
 *
 * The exported signatures are deliberately unchanged, so `buildApp` and the
 * existing host tests are untouched by the split.
 */

export type { HeadquarterControlPlane } from '@factoryos/hq-host';

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
 * ## Why the key is EXACTLY the one `/api/auth/login` uses
 *
 * `assertNotRateLimited` enforces two buckets: the key itself, and the source
 * key `sourceKeyOf` derives as `ip|<second component>|*`. Sharing a budget
 * with sign-in therefore means sharing BOTH, and it took two corrections to
 * get there — worth recording, because each intermediate version looked
 * shared and was not.
 *
 * `ip|hq-stepup|<account>` shared neither: it had its own source ceiling too,
 * so exhausting the login budget constrained step-up not at all (Codex round
 * 2 P2). `ip|login|hq-stepup:<account>` shared the ceiling but not the
 * per-account bucket, so an attacker who burned ten sign-in guesses against a
 * known username still got ten more here against the same password before the
 * source ceiling bit (Codex round 6 P2).
 *
 * The key is now the login key: `ip|login|<username>`, built from the stored
 * username `createUser` already lower-cased, which is what
 * `/api/auth/login` derives from the submitted one. Ten failures total across
 * both surfaces, not ten each. A correct password clears only that bucket,
 * exactly as a successful sign-in does — the source ceiling is deliberately
 * not cleared, so a spray in progress is not wiped by one success.
 *
 * An account whose username cannot be resolved (deleted or deactivated
 * mid-session) is refused rather than run through an unbudgeted path.
 */
function credentialVerifier(db: Db, ip: string): CredentialVerifierPort {
  return {
    verify(account, password) {
      const identifier = accountLoginIdentifier(db, account.accountId);
      if (identifier === null) return 'rejected';
      const key = `${ip}|login|${identifier}`;
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

/**
 * This server's answer to "who is making this request", for `@factoryos/hq-host`.
 *
 * Built per request on purpose — see `HqRequestIdentity`. Hoisting either port
 * would cache a session decision the resolver is required to re-take every
 * time.
 */
export function serverIdentity(db: Db): HqIdentityPort {
  return {
    forRequest(req) {
      return {
        sessions: sessionResolver(db, req.cookies?.[SESSION_COOKIE]),
        credentials: credentialVerifier(db, req.ip),
      };
    },
  };
}

export function registerHeadquarterRoutes(
  app: FastifyInstance,
  db: Db,
  plane: import('@factoryos/hq-host').HeadquarterControlPlane,
): void {
  hostRegisterRoutes(app, plane, serverIdentity(db));
}

export function registerHeadquarterSite(
  app: FastifyInstance,
  db: Db,
  plane: import('@factoryos/hq-host').HeadquarterControlPlane,
  root: string,
): void {
  hostRegisterSite(app, plane, serverIdentity(db), root);
}

export { HQ_SITE_PREFIX } from '@factoryos/hq-host';
