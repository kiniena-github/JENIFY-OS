/**
 * What the shipped server process builds, from the environment alone
 * (Phase 2, Stage 2 correction round).
 *
 * `index.ts` used to assemble `AppOptions` inline. That is where the HQ sign-in
 * bridge went missing: `buildApp` accepted an `ssoHq` plane, `apps/hq-server`
 * called the identity endpoints, and the process a deployment actually runs
 * never passed one — so the two shipped processes could not complete a handoff,
 * and no test noticed, because every test built its own options.
 *
 * Extracting it fixes that class of defect rather than the one instance: the
 * composition is now a function, so a test can assert what the REAL entrypoint
 * composes instead of asserting what a test composed for itself. `index.ts` is
 * left with the two things that genuinely cannot be tested — opening the
 * default database and listening on a port.
 *
 * Everything stays OFF unless switched on deliberately. An ordinary JENIFY OS
 * deployment (the Mesob pilot's exact shape) sets none of the FACTORYOS_HQ_* or
 * FACTORYOS_SSO_HQ_* variables and gets exactly the options it got before: a
 * db, and nothing else.
 */

import type { AppOptions } from './app.js';
import type { Db } from './db/index.js';
import { loadHeadquarterHost } from './services/headquarter-host.js';
import { loadSsoHqPlane } from './services/sso-hq-host.js';

export interface ComposedAppOptions {
  options: AppOptions;
  /** The HQ database handle, when the control plane is on, so a host can close it. */
  headquarterDb?: { close(): void };
}

export function composeAppOptions(
  db: Db,
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): ComposedAppOptions {
  // HQ control plane: OFF unless the environment switches it on deliberately.
  const hq = loadHeadquarterHost(env, log);
  // The A-4 sign-in bridge: independently OFF unless switched on deliberately.
  // Deliberately NOT conditional on the control plane — this server is the
  // IDENTITY half, and the HQ half it vouches for normally runs in the separate
  // `apps/hq-server` process on its own origin. Requiring FACTORYOS_HQ_CONTROL
  // here would mean a deployment could only bridge to an HQ it also hosted
  // itself, which is the opposite of what Stage 1 and Stage 2 built.
  const ssoHq = loadSsoHqPlane(env, log);

  return {
    options: {
      db,
      ...(hq ? { headquarter: hq.plane } : {}),
      ...(hq?.siteRoot ? { headquarterSite: { root: hq.siteRoot } } : {}),
      ...(ssoHq ? { ssoHq } : {}),
    },
    ...(hq ? { headquarterDb: hq.db } : {}),
  };
}
