/**
 * Environment wiring for the Headquarter browser-control plane
 * (issue #200, integration lane).
 *
 * ## Default OFF, by construction
 *
 * `buildApp` mounts HQ routes only when handed an explicit control plane, and
 * this module is the only thing that ever builds one from the environment. It
 * returns `undefined` unless `HQ_CONTROL_ENABLED` is explicitly `1`/`true`, so
 * an ordinary tenant deployment — the Mesob pilot's shape — starts exactly as
 * before: no HQ routes, no HQ database opened, byte-for-byte unchanged
 * behaviour. Enabling the plane is a deliberate operator action, never a side
 * effect of upgrading.
 *
 * ## Fail closed on malformed configuration
 *
 * A malformed `HQ_FOUNDER_MAP` is NOT repaired, defaulted, or dropped to "no
 * founder": the unparseable raw value is passed through so the boundary's own
 * per-request parser (`loadFounderBindings`) refuses it as
 * `founder_map_malformed` — controls stay off, reads keep working, and the
 * session probe reports the precise reason instead of a silent degradation the
 * operator would never see. Nothing here ever guesses a username or an email:
 * the map is `(realmId, accountId) → principalId` or it is nothing.
 *
 * ## Mutations default OFF even when the plane is on
 *
 * `HQ_MUTATIONS_ENABLED` must also be explicitly `1`/`true`. Without it the
 * plane serves the read routes only — the safe posture while a deployment's
 * Founder binding is still being established (`control-api.ts` both refuses
 * the writes and reports the buttons as unavailable from the same flag).
 *
 * ## What is deliberately NOT done here
 *
 * No principal is registered, no capability is registered or re-enabled, and
 * no Founder binding is seeded. Those are configuration decisions made through
 * the trusted-local-admin CLI (`hq:order --register-capability`, principal
 * registration) or explicit config — wiring a server must never widen what the
 * canonical registries already say.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openHqDatabase, type HqDatabase } from '@factoryos/headquarter/store';
import { HeadquarterOperations } from '@factoryos/headquarter/application';
import type { HeadquarterControlPlane } from './routes/headquarter.js';

/** Env vars read by `loadHqControlPlane`. Documented here, used nowhere else. */
export const HQ_ENV_VARS = {
  enabled: 'HQ_CONTROL_ENABLED',
  founderMap: 'HQ_FOUNDER_MAP',
  allowedOrigins: 'HQ_ALLOWED_ORIGINS',
  mutationsEnabled: 'HQ_MUTATIONS_ENABLED',
  dbPath: 'HQ_DB_PATH',
  siteDir: 'HQ_SITE_DIR',
} as const;

/** Explicit opt-in only: `1` or `true` (case-insensitive). Anything else is off. */
export function envFlag(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

export interface HqControlLoadOptions {
  /** Port the server will listen on — used for the default same-origin allow-list. */
  port: number;
  /** Test seam: how the HQ database is opened. Defaults to `openHqDatabase`. */
  openDb?: (dbPath?: string) => HqDatabase;
}

export interface HqControlLoad {
  /** Pass to `buildApp({ db, headquarter })`. Undefined ⇒ no HQ routes at all. */
  headquarter?: HeadquarterControlPlane;
  /** Operator-facing notes about what was (not) enabled and why. No secrets. */
  notes: string[];
}

/**
 * Build the HQ control plane from the environment, or decline to.
 *
 * The returned notes never contain a configured value — only which variable
 * was read and what state that produced — so logging them cannot leak a
 * binding, an origin list, or a path an operator considers sensitive beyond
 * its existence.
 */
export function loadHqControlPlane(
  env: Record<string, string | undefined>,
  opts: HqControlLoadOptions,
): HqControlLoad {
  const notes: string[] = [];

  if (!envFlag(env[HQ_ENV_VARS.enabled])) {
    return {
      notes: [
        `HQ browser control is OFF (${HQ_ENV_VARS.enabled} is not '1'/'true'). ` +
          'No HQ route exists on this server.',
      ],
    };
  }

  // Founder map: absent ⇒ valid-but-empty (controls off, reads on). Malformed
  // JSON ⇒ hand the RAW value to the boundary, whose parser refuses it whole
  // per request as founder_map_malformed. Never repaired, never guessed.
  let founderMap: unknown = [];
  const rawMap = env[HQ_ENV_VARS.founderMap];
  if (rawMap !== undefined && rawMap.trim() !== '') {
    try {
      founderMap = JSON.parse(rawMap);
    } catch {
      founderMap = rawMap;
      notes.push(
        `${HQ_ENV_VARS.founderMap} is not valid JSON. It is passed through unparsed so the ` +
          'control boundary refuses it as founder_map_malformed: reads stay up, every write and ' +
          'every Founder resolution is refused until the map is fixed.',
      );
    }
  } else {
    notes.push(
      `${HQ_ENV_VARS.founderMap} is not set: no account is bound to the Founder principal, so ` +
        'the browser controls stay off (founder_map_unconfigured).',
    );
  }

  // Origins: explicit list wins; otherwise the server's OWN origin only.
  // Defaulting to self is same-origin-only — it can never admit a cross-site
  // caller — and it is what makes the local-first deployment work without a
  // second variable. Cross-origin serving is a deliberate extra configuration.
  const rawOrigins = env[HQ_ENV_VARS.allowedOrigins];
  const allowedOrigins =
    rawOrigins !== undefined && rawOrigins.trim() !== ''
      ? rawOrigins
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      : [`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`];

  const mutationsEnabled = envFlag(env[HQ_ENV_VARS.mutationsEnabled]);
  if (!mutationsEnabled) {
    notes.push(
      `HQ browser writes are OFF (${HQ_ENV_VARS.mutationsEnabled} is not '1'/'true'). ` +
        'Read routes are served; every mutation is refused and no write control is advertised.',
    );
  }

  // The HQ database is SEPARATE from the tenant database by design
  // (store/db.ts): this never opens data/factoryos.sqlite.
  const openDb = opts.openDb ?? openHqDatabase;
  const ops = new HeadquarterOperations(openDb(env[HQ_ENV_VARS.dbPath] || undefined));

  // Static HQ site, served same-origin so the session cookie (SameSite=Lax)
  // actually accompanies the console's requests. Optional: without it the API
  // is still mounted and the site can be served by any same-origin arrangement
  // the operator prefers.
  let siteDir: string | undefined;
  const rawSiteDir = env[HQ_ENV_VARS.siteDir];
  if (rawSiteDir !== undefined && rawSiteDir.trim() !== '') {
    const resolved = path.resolve(rawSiteDir.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      siteDir = resolved;
      notes.push('HQ static site will be served at /hq/ (same-origin with the control API).');
    } else {
      notes.push(
        `${HQ_ENV_VARS.siteDir} does not point at a directory; the HQ static site is NOT served. ` +
          'Build it first (build:site) or fix the path.',
      );
    }
  }

  notes.push(
    `HQ browser control is ON: reads ${mutationsEnabled ? 'and writes' : 'only (writes refused)'}.`,
  );

  return {
    headquarter: {
      ops,
      founderMap,
      allowedOrigins,
      // process.env is read for provider fact PRESENCE only; no value is ever
      // rendered, logged or sent (routing/providers.ts contract).
      secretsEnv: env,
      mutationsEnabled,
      siteDir,
      audit: {
        record(event) {
          // Supplementary sink, best-effort by contract. The event shape has no
          // field for a credential, token, password or request body.
          console.log(`[hq-control] ${JSON.stringify(event)}`);
        },
      },
    },
    notes,
  };
}
