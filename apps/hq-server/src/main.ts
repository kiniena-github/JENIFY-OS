/**
 * Standalone JENIFY HQ process.
 *
 * Phase 2 Stage 3 keeps the proven HQ core/storage semantics but makes hosted
 * persistence explicit. `loadHeadquarterHost` now refuses `runtime=hosted`
 * unless the database is on an operator-attested durable volume. The actual
 * cloud/volume provider remains a Founder gate.
 */

import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {
  loadHeadquarterHost,
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  registerHqSsoRoutes,
  beginHandoff,
  checkBackChannelOrigin,
  describeBackChannelOriginRefusal,
  httpBackChannel,
  ssoIdentity,
  HqSessionStore,
  NO_IDENTITY,
  type HqIdentityPort,
  type HqSsoOptions,
} from '@factoryos/hq-host';

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

  // This channel carries the service secret and Founder step-up password. Only
  // TLS, or recognized loopback for local proof stacks, is accepted.
  const checkedIdentity = checkBackChannelOrigin(identityOrigin);
  if (!checkedIdentity.ok) {
    log(
      describeBackChannelOriginRefusal(
        'HQ_SSO_IDENTITY_ORIGIN',
        identityOrigin,
        checkedIdentity.reason,
      ),
    );
    return null;
  }
  const checkedHq = checkBackChannelOrigin(hqOrigin);
  if (!checkedHq.ok) {
    log(describeBackChannelOriginRefusal('HQ_SSO_HQ_ORIGIN', hqOrigin, checkedHq.reason));
    return null;
  }

  const store = new HqSessionStore(db);
  const backChannel = httpBackChannel({ baseUrl: checkedIdentity.origin, serviceSecret });
  const secureCookies = env.HQ_SSO_INSECURE_COOKIES !== '1';
  log(
    `[hq] Jenify sign-in bridge ON: identity=${checkedIdentity.origin}, hq=${checkedHq.origin}, ` +
      `cookies=${secureCookies ? 'Secure' : 'INSECURE (loopback proof only)'}`,
  );
  return {
    identity: ssoIdentity(store, backChannel),
    options: {
      store,
      backChannel,
      identityOrigin: checkedIdentity.origin,
      hqOrigin: checkedHq.origin,
      serviceSecret,
      secureCookies,
      audit: log,
    },
  };
}

export interface StandaloneOptions {
  env?: Record<string, string | undefined>;
  /** Test/host seam. Production identity comes from the A-4 SSO bridge. */
  identity?: HqIdentityPort;
  log?: (line: string) => void;
}

/** Build the standalone HQ app without listening, so tests can inject and inspect. */
export async function buildStandaloneHq(options: StandaloneOptions = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const identity = options.identity ?? NO_IDENTITY;

  const host = loadHeadquarterHost(env, log);
  if (!host) return null;

  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  const sso = ssoConfigFrom(env, host.db, log);
  const effective = sso ? sso.identity : identity;

  registerHeadquarterRoutes(app, host.plane, effective);
  if (sso) registerHqSsoRoutes(app, sso.options);
  if (host.siteRoot) {
    registerHeadquarterSite(app, host.plane, effective, host.siteRoot, {
      onUnauthenticated: sso
        ? (req, reply) => beginHandoff(sso.options, reply, req.url.split('?')[0]!)
        : undefined,
    });
  }

  if (effective === NO_IDENTITY) {
    log(
      '[hq] NO IDENTITY SOURCE is wired into this process. HQ has no sign-in of its own, so every ' +
        'request resolves nobody: reads answer 401 and controls stay off.',
    );
  }

  /**
   * Release HTTP and durable storage through their owners. The persistence close
   * checkpoints WAL best-effort before releasing SQLite.
   */
  const close = async (): Promise<void> => {
    await app.close();
    host.persistence.close();
  };

  return { app, host, close };
}

async function main(): Promise<void> {
  const built = await buildStandaloneHq();
  if (!built) {
    console.error(
      '[hq] Not started. Set FACTORYOS_HQ_CONTROL=1 and FACTORYOS_HQ_DB=<path>. ' +
        'Hosted runtime additionally requires durable-volume persistence.',
    );
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.HQ_PORT ?? 3200);
  const address = process.env.HQ_HOST ?? '127.0.0.1';
  await built.app.listen({ port, host: address });
  console.log(`[hq] standalone HQ host listening on http://${address}:${port}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
