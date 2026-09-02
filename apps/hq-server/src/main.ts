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
import {
  loadHeadquarterHost,
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  NO_IDENTITY,
  type HqIdentityPort,
} from '@factoryos/hq-host';

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
  registerHeadquarterRoutes(app, host.plane, identity);
  if (host.siteRoot) registerHeadquarterSite(app, host.plane, identity, host.siteRoot);

  if (identity === NO_IDENTITY) {
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
