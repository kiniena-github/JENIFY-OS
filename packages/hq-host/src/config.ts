/**
 * Environment-gated host configuration for the HQ control plane.
 *
 * OFF remains the default. Stage 3 adds an explicit persistence contract while
 * preserving every existing local/workstation setting:
 *
 *   FACTORYOS_HQ_CONTROL=1
 *   FACTORYOS_HQ_DB=<path>
 *   FACTORYOS_HQ_RUNTIME=local|hosted              (default: local)
 *   FACTORYOS_HQ_PERSISTENCE=local-file|durable-volume
 *   FACTORYOS_HQ_DURABLE_ROOT=<mounted volume>     (durable mode only)
 *   FACTORYOS_HQ_BACKUP_DIR=<directory>            (optional)
 *
 * A hosted runtime fails closed unless durable-volume mode is explicitly
 * configured. The provider/volume itself is deliberately not chosen here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HeadquarterOperations } from '@factoryos/headquarter/application';
import { HeadquarterStore, type HqDatabase } from '@factoryos/headquarter/store';
import { PROVIDER_REGISTRY, type SecretsEnv } from '@factoryos/headquarter/routing';
import { claude } from '@factoryos/headquarter/providers';
import type { ControlAuditEvent } from '@factoryos/headquarter/live';
import { openHqPersistence } from './persistence-guard.js';
import type { HqPersistence } from './persistence.js';

export interface HeadquarterHost {
  plane: HeadquarterControlPlane;
  /** Directory of the static HQ site to serve at /hq/, when configured. */
  siteRoot?: string;
  /** Open database retained for compatibility with the Stage-1 host contract. */
  db: HqDatabase;
  /** Stage-3 owner of durability, backups/checkpoints and shutdown. */
  persistence: HqPersistence;
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
 * Nothing is opened unless the master switch is exactly `1`. Once it is on,
 * persistence is the first boundary evaluated so a hosted process can never
 * silently boot against an ephemeral database.
 */
export function loadHeadquarterHost(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HeadquarterHost | null {
  if (env.FACTORYOS_HQ_CONTROL !== '1') return null;

  const persistence = openHqPersistence(env, log);
  if (!persistence) return null;
  const hqDb = persistence.db;
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });

  // The Founder map is parsed only to distinguish valid JSON from malformed
  // authority configuration. Malformed input travels raw to the boundary so it
  // is refused visibly rather than normalized into an accidental empty map.
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

  // Presence-narrowed provider facts — never hand the entire process
  // environment to the control plane.
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
    `[hq] HQ control plane ON: db=${persistence.config.dbPath}, ` +
      `persistence=${persistence.config.mode}/${persistence.config.runtime}, ` +
      `mutations=${mutationsEnabled ? 'ENABLED' : 'off (reads only)'}, ` +
      `trusted origins=${allowedOrigins.length}, founder map=${
        founderMap == null ? 'UNCONFIGURED (controls stay off)' : 'configured'
      }, site=${siteRoot ?? 'not served'}`,
  );

  // What CLAUDE dispatchability actually depends on where this host runs.
  // The shared helper returns false for an observed unavailable transport, true
  // only for observed availability, and null for genuine ignorance.
  const dispatchAvailability =
    claude.transportRouteAvailability(claude.ghCliTransport()).providerDispatchable;

  return {
    plane: {
      ops,
      founderMap,
      allowedOrigins,
      secretsEnv,
      dispatchAvailability,
      mutationsEnabled,
      audit: {
        record(event: ControlAuditEvent) {
          log(
            `[hq-audit] ${event.at} ${event.route} ${event.outcome} ${event.detail}` +
              (event.principalId ? ` principal=${event.principalId}` : ''),
          );
        },
      },
    },
    siteRoot,
    db: hqDb,
    persistence,
  };
}
