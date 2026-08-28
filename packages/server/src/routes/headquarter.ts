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
function sessionResolver(db: Db, cookieFor: (request: ControlRequest) => string | undefined): SessionResolverPort {
  return {
    resolve(request) {
      const token = cookieFor(request);
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

function credentialVerifier(db: Db): CredentialVerifierPort {
  return {
    verify(account, password) {
      return verifyAccountPassword(db, account.accountId, password);
    },
  };
}

export function registerHeadquarterRoutes(
  app: FastifyInstance,
  db: Db,
  plane: HeadquarterControlPlane,
): void {
  // The cookie is carried per-request in a WeakMap keyed by the reduced
  // request object rather than being put on the request shape, because
  // `ControlRequest` deliberately has no field a credential could sit in —
  // that shape is what stops the boundary reading identity out of a body.
  const tokens = new WeakMap<ControlRequest, string>();
  const deps: ControlApiDeps = {
    ops: plane.ops,
    principals: plane.principals,
    founderMap: plane.founderMap,
    allowedOrigins: plane.allowedOrigins,
    secretsEnv: plane.secretsEnv,
    sessions: sessionResolver(db, (request) => tokens.get(request)),
    credentials: credentialVerifier(db),
    audit: plane.audit,
  };

  const mutationsEnabled = plane.mutationsEnabled !== false;

  const handle = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const method = req.method.toUpperCase();
    if (!mutationsEnabled && method !== 'GET') {
      reply.status(403).send({
        ok: false,
        error: {
          code: 'mutations_disabled',
          message: 'HQ browser writes are switched off for this deployment.',
        },
      });
      return;
    }

    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : (value as string | undefined);
    }
    const path = req.url.split('?')[0]!;
    const control: ControlRequest = { method, path, headers, body: req.body };
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) tokens.set(control, token);

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
