/**
 * JENIFY HQ's own HTTP surface (Phase 2, Stage 1).
 *
 * ## What moved here, and what did not
 *
 * This is `packages/server/src/routes/headquarter.ts` with one change: the two
 * identity adapters it used to build in-line — a session resolver over the
 * `fos_session` cookie and a credential verifier over the server's password
 * store and rate limiter — are now supplied through `HqIdentityPort` instead of
 * being written here. Everything else is the same code, doing the same job, and
 * `@factoryos/server` still registers the same routes with the same signature.
 *
 * That single change is the whole point of the split: those two adapters are
 * inseparable from the tenant platform's auth tables, and every other line here
 * is generic Fastify glue that HQ can carry on its own. With them parameterised,
 * this package depends on `@factoryos/headquarter` and Fastify and nothing else,
 * so HQ can be served by a process that never loads the tenant platform.
 *
 * ## What this file is allowed to be
 *
 * An adapter and nothing more. It translates Fastify to the reduced request
 * shape and back, and supplies the ports. Every authority decision — session →
 * account → configured Founder map → registered principal, origin, step-up, and
 * the canonical Operator rules underneath — lives in `@factoryos/headquarter`'s
 * `live/auth.ts` and `live/control-api.ts`, where it is unit-testable without a
 * server. Nothing here may add a route, widen a check, or shortcut one.
 *
 * ## Opt-in, so the tenant platform is unchanged by default
 *
 * `buildApp` registers this only when it is handed an explicit control plane.
 * An ordinary JENIFY OS deployment — the Mesob pilot included — passes nothing,
 * gets no HQ routes at all, and is byte-for-byte unaffected.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  handleControlRequest,
  resolveFounderPrincipal,
  CONTROL_API_PREFIX,
  type ControlApiDeps,
  type ControlAuditPort,
  type ControlRequest,
} from '@factoryos/headquarter/live';
import type { HqIdentityPort } from './identity.js';

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

export function registerHeadquarterRoutes(
  app: FastifyInstance,
  plane: HeadquarterControlPlane,
  identity: HqIdentityPort,
): void {
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const method = req.method.toUpperCase();
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : (value as string | undefined);
    }
    const path = req.url.split('?')[0]!;
    const control: ControlRequest = { method, path, headers, body: req.body };

    // The async pre-pass, for an identity source whose credential check is a
    // network call. It must run BEFORE the synchronous core, and an outage must
    // refuse the request rather than be laundered into "wrong password".
    if (identity.prepare) {
      const prepared = await identity.prepare(req);
      if (prepared === 'unavailable') {
        reply.header('cache-control', 'no-store');
        return reply.status(503).send({
          ok: false,
          error: {
            code: 'step_up_unavailable',
            message:
              'Step-up could not be verified because the Jenify identity service did not answer. ' +
              'Nothing was approved. Try again shortly.',
          },
        });
      }
    }

    // Ports are built PER REQUEST, closed over this request's cookie and
    // source address. `ControlRequest` deliberately has no field a credential
    // or an IP could sit in — that shape is what stops the boundary reading
    // identity out of a body — so the two are bound here instead, where they
    // cannot be reached by anything the caller sends.
    const { sessions, credentials } = identity.forRequest(req);

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
      sessions,
      credentials,
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
 * The pages poll `hq-snapshot.json` and call the control API with the host's
 * session cookie, which is HttpOnly and SameSite=Lax — a browser only sends it
 * to the host that set it. A separately-hosted copy of the site would therefore
 * reach the control API with no cookie and be told `unauthenticated` on every
 * request. Serving the pages from this origin is what makes the design's
 * implicit same-origin requirement explicit and true.
 *
 * This is also the precise shape of Founder Gate A: moving the pages to
 * `hq.jenifylabs.com` while the session is issued elsewhere reproduces exactly
 * the failure this mount exists to avoid.
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
export interface HeadquarterSiteOptions {
  /**
   * Where to send a caller who is not signed in at all (A-4's SSO handoff).
   *
   * Returning a URL turns the 401 into a redirect; returning null keeps the
   * 401. It is consulted ONLY for `unauthenticated`, never for a signed-in
   * account that simply is not the Founder — redirecting that case would
   * bounce a legitimate user around a loop instead of telling them the truth,
   * and would leak whether an account maps to the Founder.
   *
   * The hook receives the reply so it can set the CSRF state cookie that binds
   * the round trip.
   */
  onUnauthenticated?: (request: FastifyRequest, reply: FastifyReply) => string | null;
}

export function registerHeadquarterSite(
  app: FastifyInstance,
  plane: HeadquarterControlPlane,
  identity: HqIdentityPort,
  root: string,
  options: HeadquarterSiteOptions = {},
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
          sessions: identity.forRequest(req).sessions,
          // The SAME registry the operations authorize against, reached through
          // the narrow lookup rather than the registry object — `ops.principals`
          // was removed in issue #200 because a public collaborator there was
          // patchable into a forged Founder gate.
          principals: { get: (id: string) => plane.ops.lookupPrincipal(id) },
          founderMap: plane.founderMap,
        },
      );
      if (!resolution.ok) {
        // Not signed in at all, and the host offers a sign-in handoff: send
        // them to it. Deliberately only for `unauthenticated` — see
        // `HeadquarterSiteOptions.onUnauthenticated`.
        if (resolution.reason === 'unauthenticated' && options.onUnauthenticated) {
          const target = options.onUnauthenticated(req, reply);
          if (target) {
            return reply.status(302).header('cache-control', 'no-store').redirect(target);
          }
        }
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
      // The same policy the pages pin for themselves (`REFERRER_POLICY_META`),
      // stated by the host as well (#219 correction round).
      //
      // The console's `/session` probe is a GET, so it carries no `Origin` and
      // its `Referer` is the ONLY evidence of the page's origin the control
      // API can check against the trusted-origin list. A response header is
      // the more reliable half of the pair: it applies to the document before
      // any markup is parsed, and it covers a page this host serves even if a
      // future build ever stops emitting the meta.
      //
      // `same-origin` is stricter than the browser default, never weaker — HQ
      // pages only ever call this same origin, and a cross-origin request now
      // carries no referrer at all. Nothing about what the gate ACCEPTS
      // changes: the referrer's origin is still checked against the configured
      // allow-list.
      reply.header('referrer-policy', 'same-origin');
    });
    scope.register(fastifyStatic, {
      root,
      prefix: HQ_SITE_PREFIX,
      decorateReply: false,
    });
  });
}
