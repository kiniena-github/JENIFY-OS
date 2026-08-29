/**
 * Environment-gated host wiring for the Headquarter control plane
 * (issue #200, LIVE HQ CONTROL V1 integration).
 *
 * ## Off by default, and why that is load-bearing
 *
 * `buildApp` mounts the HQ control routes only when a host passes a control
 * plane, and PR #214 kept every real process from passing one — deliberately,
 * because the control plane is a new authentication boundary and an ordinary
 * tenant deployment (the Mesob pilot) must not acquire one by upgrading. This
 * module is the ONE place that boundary can be switched on, and it requires an
 * explicit `FACTORYOS_HQ_CONTROL=1`. Everything else about the deployment —
 * every tenant route, the branding mount, the session cookie — is
 * byte-for-byte unchanged when the flag is absent, which is the default.
 *
 * ## What turning it on does NOT do
 *
 * Enabling the flag serves the routes; it authenticates nobody and permits
 * nothing:
 *
 *   - `FACTORYOS_HQ_FOUNDER_MAP` unset → an EMPTY Founder map, which is valid
 *     and means no account is the Founder and every mutation is refused. The
 *     `(realmId, accountId) → principalId` binding is deployment
 *     configuration; this module never seeds it, never guesses it from a
 *     username or email, and a malformed value fails closed per request
 *     (`founder_map_malformed`) rather than being repaired.
 *   - `FACTORYOS_HQ_ORIGINS` unset → an empty origin allow-list, so every
 *     state-changing request is refused (`origin_allowlist_empty`).
 *   - The mapped principal must already be registered and active in the HQ
 *     registry, with its own grants. Nothing here registers a principal.
 *
 * The one registration this module performs is `hq.direct_order` — the
 * capability the composer creates — because enabling the control plane IS the
 * deployment's configuration action for browser orders. It never re-enables a
 * capability an operator disabled: `CapabilityRegistry.register` leaves the
 * enabled flag of an existing entry alone, so a containment decision survives
 * restarts.
 *
 * ## Environment variables
 *
 *   FACTORYOS_HQ_CONTROL       '1'/'true' to serve the HQ control routes. Default: off.
 *   FACTORYOS_HQ_DB            HQ SQLite path. Default: data/headquarter.sqlite.
 *   FACTORYOS_HQ_FOUNDER_MAP   JSON array of {realmId, accountId, principalId}. Default: [] (nobody).
 *   FACTORYOS_HQ_ORIGINS       Comma-separated trusted origins. Default: none (no mutations).
 *   FACTORYOS_HQ_MUTATIONS     '0'/'false' to serve reads only. Default: writes allowed
 *                              (they are still quadruple-gated: Founder map, origin
 *                              allow-list, registered principal, capability grants).
 *   FACTORYOS_HQ_SITE          Directory holding the built HQ site (dist/site). Unset: not served.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HeadquarterControlPlane } from './routes/headquarter.js';
import {
  registerDirectOrderCapability,
  CONNECTION_CATALOG,
  type ControlAuditEvent,
} from '@factoryos/headquarter/live';
import { PROVIDER_REGISTRY, type SecretsEnv } from '@factoryos/headquarter/routing';
import { openHqDatabase, HeadquarterStore, DEFAULT_HQ_DB_PATH } from '@factoryos/headquarter/store';
import { HeadquarterOperations } from '@factoryos/headquarter/application';

export interface HeadquarterHostConfig {
  dbPath: string;
  /** Raw map value, handed to the boundary UNREPAIRED so it can fail closed. */
  founderMap: unknown;
  allowedOrigins: string[];
  mutationsEnabled: boolean;
  /** Human-readable notes about what was (not) configured, for startup logs. */
  notices: string[];
}

export interface HeadquarterSiteConfig {
  root: string;
}

function flagOn(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function flagOff(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off';
}

/**
 * Read the HQ control-plane configuration from the environment.
 *
 * Returns null — serve nothing — unless `FACTORYOS_HQ_CONTROL` is explicitly
 * on. Never throws for a malformed value: a broken Founder map is passed
 * through RAW so the authentication boundary refuses it per request with a
 * truthful `founder_map_malformed`, which the operator sees, instead of this
 * module silently "fixing" an authority mapping.
 */
export function resolveHeadquarterEnv(env: NodeJS.ProcessEnv): HeadquarterHostConfig | null {
  if (!flagOn(env.FACTORYOS_HQ_CONTROL)) return null;

  const notices: string[] = [];

  let founderMap: unknown = [];
  const rawMap = env.FACTORYOS_HQ_FOUNDER_MAP;
  if (rawMap == null || rawMap.trim() === '') {
    notices.push(
      'FACTORYOS_HQ_FOUNDER_MAP is not set: no account is bound to the HQ Founder principal, so the browser controls stay off and every mutation is refused. Binding one is an explicit configuration action (docs/HEADQUARTER/FOUNDER_AUTH.md).',
    );
  } else {
    try {
      founderMap = JSON.parse(rawMap);
    } catch {
      // Hand the unparseable value through so loadFounderBindings refuses it
      // as malformed on every request — fail closed, visibly, per request.
      founderMap = rawMap;
      notices.push(
        'FACTORYOS_HQ_FOUNDER_MAP is not valid JSON. The map is refused whole (founder_map_malformed): nobody authenticates as the Founder until it is fixed.',
      );
    }
  }

  const allowedOrigins = (env.FACTORYOS_HQ_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (allowedOrigins.length === 0) {
    notices.push(
      'FACTORYOS_HQ_ORIGINS is not set: the origin allow-list is empty, so every state-changing HQ request is refused. Configure the exact origin the browser uses (e.g. http://192.168.1.10:3001).',
    );
  }

  const mutationsEnabled = !flagOff(env.FACTORYOS_HQ_MUTATIONS);
  if (!mutationsEnabled) {
    notices.push('FACTORYOS_HQ_MUTATIONS is off: HQ control routes are read-only.');
  }

  return {
    dbPath: env.FACTORYOS_HQ_DB?.trim() || DEFAULT_HQ_DB_PATH,
    founderMap,
    allowedOrigins,
    mutationsEnabled,
    notices,
  };
}

/**
 * The non-secret facts the control plane may observe, by NAME.
 *
 * Passing the whole `process.env` would widen what this process even looks at
 * for no benefit; only the fact names the connection catalogue and the
 * provider registry declare are read, and only their presence is ever used —
 * `live/redaction.ts` refuses any response that carries a value.
 */
export function observableSecretsEnv(env: NodeJS.ProcessEnv): SecretsEnv {
  const names = new Set<string>([
    ...CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts),
    ...Object.values(PROVIDER_REGISTRY).flatMap((provider) => [
      ...provider.requiredSecrets,
      ...provider.requiredLocalFacts,
    ]),
  ]);
  const observed: Record<string, string | undefined> = {};
  for (const name of names) {
    if (env[name] != null) observed[name] = env[name];
  }
  return observed;
}

/**
 * Build the control plane a configured host passes to `buildApp`.
 *
 * Opens (or creates) the HQ database and registers the `hq.direct_order`
 * capability — and nothing else: no principal, no Founder binding, no grant.
 */
export function createHeadquarterControlPlane(
  config: HeadquarterHostConfig,
  env: NodeJS.ProcessEnv = process.env,
): HeadquarterControlPlane {
  const hqDb = openHqDatabase(config.dbPath);
  const ops = new HeadquarterOperations(hqDb, { store: new HeadquarterStore(hqDb) });
  registerDirectOrderCapability(ops);
  return {
    ops,
    founderMap: config.founderMap,
    allowedOrigins: config.allowedOrigins,
    secretsEnv: observableSecretsEnv(env),
    mutationsEnabled: config.mutationsEnabled,
    audit: {
      record(event: ControlAuditEvent) {
        // Supplementary, best-effort sink; the authoritative record is the
        // hash-chained op_evidence log written inside the canonical operation.
        console.log(`[hq-control] ${JSON.stringify(event)}`);
      },
    },
  };
}

/**
 * Resolve the same-origin HQ site mount, if the deployment asked for one.
 *
 * The session cookie is `SameSite=Lax`, so the console must be served from
 * the API's own origin for its fetches to carry the cookie at all — that is
 * what this mount is for. Absent or unusable directories fail gracefully and
 * truthfully: the server starts, serves everything else, and says exactly why
 * the site is not mounted.
 */
export function resolveHeadquarterSite(env: NodeJS.ProcessEnv): {
  site: HeadquarterSiteConfig | null;
  notices: string[];
} {
  const raw = env.FACTORYOS_HQ_SITE?.trim();
  if (!raw) return { site: null, notices: [] };
  const root = path.resolve(raw);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      site: null,
      notices: [
        `FACTORYOS_HQ_SITE points at ${root}, which is not a directory. The HQ site is NOT being served; build it first (npm run build:site --workspace @factoryos/headquarter) or fix the path. The API is unaffected.`,
      ],
    };
  }
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    return {
      site: null,
      notices: [
        `FACTORYOS_HQ_SITE directory ${root} has no index.html — it does not look like a built HQ site, so it is NOT being served. Build it with: npm run build:site --workspace @factoryos/headquarter. The API is unaffected.`,
      ],
    };
  }
  return { site: { root }, notices: [] };
}
