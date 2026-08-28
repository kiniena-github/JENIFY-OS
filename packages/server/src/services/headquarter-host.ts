/**
 * Environment-gated host configuration for the HQ control plane
 * (issue #200, integration lane).
 *
 * ## OFF is the default, and OFF means byte-for-byte unchanged
 *
 * An ordinary JENIFY OS deployment — the Mesob pilot's exact shape — sets
 * none of these variables, gets `null` from this loader, and `buildApp`
 * therefore registers no HQ route, serves no HQ page, and gains no new auth
 * surface. Every step toward a live HQ control plane is a separate,
 * deliberate configuration action:
 *
 *   FACTORYOS_HQ_CONTROL=1          master switch. Anything else ⇒ OFF.
 *   FACTORYOS_HQ_DB=<path>          the HQ SQLite database. REQUIRED once the
 *                                   switch is on; without it the loader logs
 *                                   and stays off rather than inventing a
 *                                   default location.
 *   FACTORYOS_HQ_FOUNDER_MAP=<json> explicit account→principal bindings.
 *                                   Unset ⇒ nobody is the Founder and every
 *                                   control stays off (that is a valid,
 *                                   fail-closed deployment state). Broken
 *                                   JSON is passed through UNPARSED so the
 *                                   boundary refuses every request as
 *                                   founder_map_malformed — visible, never
 *                                   silently "empty".
 *   FACTORYOS_HQ_ALLOWED_ORIGINS=<csv>  trusted origins for browser writes.
 *                                   Unset ⇒ the control API refuses every
 *                                   mutation (origin_allowlist_empty).
 *   FACTORYOS_HQ_MUTATIONS=1        browser writes. Anything else ⇒ the API
 *                                   serves reads only and SAYS so in
 *                                   /session's control availability.
 *   FACTORYOS_HQ_SITE_DIR=<path>    static HQ site directory (the output of
 *                                   `npm run build:site`), served same-origin
 *                                   at /hq/ and gated to the mapped Founder.
 *                                   Unset ⇒ nothing is served.
 *
 * ## What this loader deliberately does NOT do
 *
 * - It never registers `hq.direct_order`. Registering the capability is its
 *   own configuration action (`registerDirectOrderCapability`), and a
 *   deployment that has not taken it gets `capability_not_registered` — the
 *   session route advertises the composer as off, truthfully.
 * - It never hands the whole `process.env` to the control plane. Only the
 *   fact NAMES the provider registry declares are read, and only their
 *   presence travels (the same narrowing `build-site.ts` performs).
 * - It never parses the Founder map into a "best effort" shape. Authority
 *   configuration either parses exactly or fails closed loudly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HeadquarterOperations } from '@factoryos/headquarter/application';
import { openHqDatabase, HeadquarterStore } from '@factoryos/headquarter/store';
import { PROVIDER_REGISTRY, type SecretsEnv } from '@factoryos/headquarter/routing';
import type { ControlAuditEvent } from '@factoryos/headquarter/live';
import type { HeadquarterControlPlane } from '../routes/headquarter.js';

export interface HeadquarterHost {
  plane: HeadquarterControlPlane;
  /** Directory of the static HQ site to serve at /hq/, when configured. */
  siteRoot?: string;
}

/** The provider facts the control plane may observe. Names, fixed by the registry. */
export function observableProviderFacts(): string[] {
  return [
    ...new Set(
      Object.values(PROVIDER_REGISTRY).flatMap((provider) => [
        ...provider.requiredSecrets,
        ...provider.requiredLocalFacts,
      ]),
    ),
  ];
}

/**
 * Read the HQ host configuration from the environment, fail-closed.
 *
 * Returns `null` — HQ entirely off — unless the master switch and the
 * database path are both set deliberately.
 */
export function loadHeadquarterHost(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HeadquarterHost | null {
  if (env.FACTORYOS_HQ_CONTROL !== '1') return null;

  const dbPath = env.FACTORYOS_HQ_DB;
  if (!dbPath) {
    log(
      '[hq] FACTORYOS_HQ_CONTROL=1 but FACTORYOS_HQ_DB is not set. The HQ control plane stays ' +
        'OFF (fail closed) — pointing it at a database is a deliberate action, not a default.',
    );
    return null;
  }

  const hqDb = openHqDatabase(dbPath);
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });

  // The Founder map: parsed here ONLY to distinguish "valid JSON" from
  // "broken string". A broken value is passed through raw so the boundary's
  // own fail-closed parser refuses every request with a reason the operator
  // can see, instead of this loader silently normalising authority config.
  let founderMap: unknown = null;
  const rawMap = env.FACTORYOS_HQ_FOUNDER_MAP;
  if (rawMap != null && rawMap.trim() !== '') {
    try {
      founderMap = JSON.parse(rawMap);
    } catch {
      founderMap = rawMap;
      log(
        '[hq] FACTORYOS_HQ_FOUNDER_MAP is not valid JSON. Every HQ request will be refused as ' +
          'founder_map_malformed until it is fixed (fail closed).',
      );
    }
  }

  const allowedOrigins = (env.FACTORYOS_HQ_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const mutationsEnabled = env.FACTORYOS_HQ_MUTATIONS === '1';

  // Presence-narrowed provider facts — never the whole environment.
  const secretsEnv: SecretsEnv = {};
  for (const fact of observableProviderFacts()) {
    if (env[fact] != null) secretsEnv[fact] = env[fact];
  }

  let siteRoot: string | undefined;
  const siteDir = env.FACTORYOS_HQ_SITE_DIR;
  if (siteDir != null && siteDir.trim() !== '') {
    if (fs.existsSync(siteDir)) {
      siteRoot = path.resolve(siteDir);
    } else {
      log(`[hq] FACTORYOS_HQ_SITE_DIR points at ${siteDir}, which does not exist. No HQ site is served.`);
    }
  }

  log(
    `[hq] HQ control plane ON: db=${dbPath}, mutations=${mutationsEnabled ? 'ENABLED' : 'off (reads only)'}, ` +
      `trusted origins=${allowedOrigins.length}, founder map=${
        founderMap == null ? 'UNCONFIGURED (controls stay off)' : 'configured'
      }, site=${siteRoot ?? 'not served'}`,
  );

  return {
    plane: {
      ops,
      founderMap,
      allowedOrigins,
      secretsEnv,
      mutationsEnabled,
      audit: {
        // A supplementary host-side sink. The authoritative record is the
        // hash-chained op_evidence log inside the canonical operation; this
        // line exists so privileged browser activity is visible in the server
        // console too. The event shape carries no credential by contract.
        record(event: ControlAuditEvent) {
          log(
            `[hq-audit] ${event.at} ${event.route} ${event.outcome} ${event.detail}` +
              (event.principalId ? ` principal=${event.principalId}` : ''),
          );
        },
      },
    },
    siteRoot,
  };
}
