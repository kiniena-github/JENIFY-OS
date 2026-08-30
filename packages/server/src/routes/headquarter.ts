import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  handleControlRequest,
  resolveFounderPrincipal,
  CONTROL_API_PREFIX,
  type ControlApiDeps,
  type ControlAuditPort,
  type ControlRequest,
  type SessionResolverPort,
  type CredentialVerifierPort,
} from '@factoryos/headquarter/live';
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
  'ops' | 'founderMap' | 'allowedOrigins' | 'secretsEnv' | 'dispatchAvailability'
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
      founderMap: plane.founderMap,
      allowedOrigins: plane.allowedOrigins,
      secretsEnv: plane.secretsEnv,
      // A host that genuinely observes the transport answers for its provider,
      // so the composer, the approvals view and the order itself cannot
      // disagree about whether a provider can dispatch from here.
      dispatchAvailability: plane.dispatchAvailability,
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

/** Where the static HQ site is mounted when a host chooses to serve it. */
export const HQ_SITE_PREFIX = '/hq/';

/**
 * Serve the static HQ site from the API's own origin, Founder-gated.
 *
 * ## Why same-origin serving exists at all
 *
 * The pages poll `hq-snapshot.json` and call the control API with the
 * `fos_session` cookie, which is HttpOnly and SameSite=Lax — a browser only
 * sends it to the host that set it. A separately-hosted copy of the site
 * would therefore reach the control API with no cookie and be told
 * `unauthenticated` on every request. Serving the pages from this origin is
 * what makes the design's implicit same-origin requirement explicit and true.
 *
 * ## Why every request is Founder-gated
 *
 * The rendered pages project canonical company state — tasks, approvals,
 * transcripts, connection evidence. They are static files, but they are not
 * public files. Every request through this mount re-resolves the session and
 * the SAME explicit Founder binding the control API enforces (same map, same
 * principal registry, same fail-closed rules), so a signed-in non-Founder
 * tenant user gets a 403, not a floor plan. There is no caching exemption:
 * `no-store` on every response keeps a shared cache from ever answering for
 * this gate.
 */
export function registerHeadquarterSite(
  app: FastifyInstance,
  db: Db,
  plane: HeadquarterControlPlane,
  root: string,
): void {
  app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      // `headers: {}` is deliberate and loses nothing: `resolveFounderPrincipal`
      // reads the request ONLY to hand it to the sessions port, and the
      // resolver built here ignores it entirely — it closes over the cookie
      // token the host's own cookie layer already parsed. Origin allow-listing
      // is NOT part of Founder resolution: `checkMutationOrigin` is a separate
      // gate the control API applies to state-changing methods only, and this
      // mount serves only GET/HEAD, for which that gate passes uncondition-
      // ally on the mutation path too. So an empty header bag can neither
      // skip nor weaken any check the control API performs — resolution is
      // genuinely header-independent, and an unresolvable session still fails
      // closed to 401/403 below.
      const resolution = resolveFounderPrincipal(
        { method: 'GET', path: req.url.split('?')[0]!, headers: {} },
        {
          sessions: sessionResolver(db, req.cookies?.[SESSION_COOKIE]),
          // The SAME registry the operations authorize against, reached through
          // the narrow lookup rather than the registry object — `ops.principals`
          // was removed in issue #200 because a public collaborator there was
          // patchable into a forged Founder gate.
          principals: { get: (id: string) => plane.ops.lookupPrincipal(id) },
          founderMap: plane.founderMap,
        },
      );
      if (!resolution.ok) {
        // `return reply` is load-bearing, not style: in an ASYNC Fastify hook
        // the documented way to respond and stop the chain is to return the
        // reply. Relying on implicit short-circuiting in the one hook that
        // gates canonical company state would fail OPEN into the static
        // handler if a framework bump ever changed the implicit behavior.
        return reply
          .status(resolution.reason === 'unauthenticated' ? 401 : 403)
          .header('cache-control', 'no-store')
          .type('text/plain; charset=utf-8')
          .send(`HQ access refused: ${resolution.message}`);
      }
    });
    scope.addHook('onSend', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
    });
    scope.register(fastifyStatic, {
      root,
      prefix: HQ_SITE_PREFIX,
      decorateReply: false,
    });
  });
}
