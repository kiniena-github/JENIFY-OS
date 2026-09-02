/**
 * Standalone JENIFY HQ process (Phase 2, Stage 1).
 *
 * ## What this proves
 *
 * That HQ is a product, not a feature of the tenant platform. This process
 * imports `@factoryos/hq-host` and `@factoryos/headquarter` and nothing else —
 * no `@factoryos/server`, no Drizzle, no tenant schema, no Mesob. It opens the
 * HQ database, mounts the same control API and the same Founder-gated site, and
 * answers on its own port.
 *
 * ## What it deliberately does NOT do
 *
 * It ships no identity source. HQ has never had a sign-in of its own, and this
 * process does not invent one: it boots with `NO_IDENTITY`, so every request
 * resolves nobody, every read is refused 401 and every control stays off.
 *
 * That is not a limitation to work around — it is the honest shape of the open
 * Founder decision (Gate A). A browser sends `fos_session` only to the host that
 * set it, and the cookie carries no `Domain`, so an HQ served from its own
 * origin receives no session. Wiring a "local trust" or "dev bypass" here to
 * make the pages appear would be a second authority path built in the dark, and
 * exactly the class of defect Phase 1 spent three correction rounds removing.
 *
 * So this process is useful now for what it demonstrates, and becomes useful to
 * a human the moment Gate A is answered and a real `HqIdentityPort` is passed
 * at the marked seam below.
 *
 * ## Running it
 *
 *   FACTORYOS_HQ_CONTROL=1 \
 *   FACTORYOS_HQ_DB=<path to the HQ sqlite> \
 *   FACTORYOS_HQ_SITE_DIR=<path to the built site> \
 *   npm start --workspace @factoryos/hq-server
 *
 * Binds 127.0.0.1 unless HQ_HOST says otherwise, because a process that refuses
 * everyone is still projecting canonical company state at whatever it binds.
 */

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {
  loadHeadquarterHost,
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  registerHqSsoRoutes,
  beginHandoff,
  httpBackChannel,
  ssoIdentity,
  HqSessionStore,
  NO_IDENTITY,
  type HqIdentityPort,
  type HqSsoOptions,
} from '@factoryos/hq-host';

/**
 * Read the A-4 bridge from the environment, or return null.
 *
 * Fail-closed and all-or-nothing, exactly like `loadHeadquarterHost`: a bridge
 * missing any of its three values is not configured, and HQ falls back to
 * refusing everyone rather than to a partially-checked sign-in.
 *
 *   HQ_SSO_IDENTITY_ORIGIN   e.g. https://app.jenifylabs.com
 *   HQ_SSO_HQ_ORIGIN         this host, e.g. https://hq.jenifylabs.com
 *   HQ_SSO_SERVICE_SECRET    dev/test value only — production is a Founder gate
 *   HQ_SSO_INSECURE_COOKIES=1  drop `Secure`, for a loopback http proof stack
 */
function ssoConfigFrom(
  env: Record<string, string | undefined>,
  db: import('@factoryos/headquarter/store').HqDatabase,
  log: (line: string) => void,
): { identity: HqIdentityPort; options: HqSsoOptions } | null {
  const identityOrigin = env.HQ_SSO_IDENTITY_ORIGIN;
  const hqOrigin = env.HQ_SSO_HQ_ORIGIN;
  const serviceSecret = env.HQ_SSO_SERVICE_SECRET;
  if (!identityOrigin || !hqOrigin || !serviceSecret) {
    if (identityOrigin || hqOrigin || serviceSecret) {
      log(
        '[hq] The Jenify sign-in bridge is only PARTLY configured, so it stays OFF. All three of ' +
          'HQ_SSO_IDENTITY_ORIGIN, HQ_SSO_HQ_ORIGIN and HQ_SSO_SERVICE_SECRET are required.',
      );
    }
    return null;
  }
  const store = new HqSessionStore(db);
  const backChannel = httpBackChannel({ baseUrl: identityOrigin, serviceSecret });
  const secureCookies = env.HQ_SSO_INSECURE_COOKIES !== '1';
  log(
    `[hq] Jenify sign-in bridge ON: identity=${identityOrigin}, hq=${hqOrigin}, ` +
      `cookies=${secureCookies ? 'Secure' : 'INSECURE (loopback proof only)'}`,
  );
  return {
    identity: ssoIdentity(store, backChannel),
    options: { store, backChannel, identityOrigin, hqOrigin, serviceSecret, secureCookies, audit: log },
  };
}

export interface StandaloneOptions {
  env?: Record<string, string | undefined>;
  /**
   * The seam Founder Gate A plugs into.
   *
   * Defaults to `NO_IDENTITY`. Tests pass a resolver to prove the host wiring
   * end to end; a real deployment passes one only once the Founder has decided
   * how a session reaches this origin.
   */
  identity?: HqIdentityPort;
  log?: (line: string) => void;
}

/** Build the standalone HQ app without listening, so tests can inject and inspect. */
export async function buildStandaloneHq(options: StandaloneOptions = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const identity = options.identity ?? NO_IDENTITY;

  const host = loadHeadquarterHost(env, log);
  if (!host) {
    // Fail closed and say why, rather than serving an empty shell.
    return null;
  }

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  // A-4: if the deployment names an identity host, HQ signs people in by
  // handoff instead of refusing everyone. All three values are required — a
  // half-configured bridge stays OFF rather than half-open.
  const sso = ssoConfigFrom(env, host.db, log);
  const effective = sso ? sso.identity : identity;

  registerHeadquarterRoutes(app, host.plane, effective);
  if (sso) registerHqSsoRoutes(app, sso.options);
  if (host.siteRoot) {
    registerHeadquarterSite(app, host.plane, effective, host.siteRoot, {
      // Not signed in and a bridge exists ⇒ start the handoff rather than 401.
      onUnauthenticated: sso
        ? (req, reply) => beginHandoff(sso.options, reply, req.url.split('?')[0]!)
        : undefined,
    });
  }

  if (effective === NO_IDENTITY) {
    log(
      '[hq] NO IDENTITY SOURCE is wired into this process. HQ has no sign-in of its own, so every ' +
        'request will resolve nobody: reads answer 401 and all controls stay off. This is the ' +
        'correct standalone posture until Founder Gate A decides how a session reaches this ' +
        'origin. It is NOT a hosted HQ.',
    );
  }

  /** Release the port and the database together — the two things this owns. */
  const close = async (): Promise<void> => {
    await app.close();
    host.db.close();
  };

  return { app, host, close };
}

async function main(): Promise<void> {
  const built = await buildStandaloneHq();
  if (!built) {
    console.error(
      '[hq] Not started. Set FACTORYOS_HQ_CONTROL=1 and FACTORYOS_HQ_DB=<path> to boot the ' +
        'standalone HQ host.',
    );
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.HQ_PORT ?? 3200);
  // Loopback unless a deployment says otherwise, deliberately.
  const address = process.env.HQ_HOST ?? '127.0.0.1';
  await built.app.listen({ port, host: address });
  console.log(`[hq] standalone HQ host listening on http://${address}:${port}`);
}

// Only run when executed directly, so importing this module in a test does not
// start a listener.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
