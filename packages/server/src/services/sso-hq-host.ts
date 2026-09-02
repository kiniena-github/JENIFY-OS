/**
 * Environment-gated configuration for the identity host's HQ sign-in bridge
 * (Phase 2, Stage 2 correction round).
 *
 * ## The defect this closes
 *
 * `buildApp` has accepted an `ssoHq` plane since Stage 2, and `apps/hq-server`
 * has called the identity endpoints since Stage 2 — but nothing ever BUILT a
 * plane outside the tests. `packages/server/src/index.ts`, the process a real
 * deployment runs, invoked `buildApp` without it, so the two shipped processes
 * could not complete a handoff no matter how they were configured: HQ would
 * redirect to `/api/sso/hq/authorize` and the identity host would answer 404. A
 * seam that only tests can reach is not a shipped feature.
 *
 * So this is the identity host's counterpart to `apps/hq-server`'s
 * `ssoConfigFrom`: the one place a real process turns environment variables
 * into a bridge.
 *
 * ## Every value is deliberate. There are no defaults.
 *
 *   FACTORYOS_SSO_HQ=1              master switch. Anything else ⇒ OFF.
 *   FACTORYOS_SSO_HQ_AUDIENCE       the HQ origin tickets may be redeemed for,
 *                                   e.g. https://hq.jenifylabs.com. Also where
 *                                   sign-out is announced, so it must be able
 *                                   to carry the service secret (TLS, or
 *                                   loopback).
 *   FACTORYOS_SSO_HQ_REDIRECT_URIS  comma-separated EXACT callback URLs. No
 *                                   prefixes, no wildcards, no defaults; empty
 *                                   ⇒ the bridge stays OFF rather than
 *                                   bridging nowhere.
 *   FACTORYOS_SSO_HQ_SERVICE_SECRET shared back-channel secret. Dev/test value
 *                                   only — a production credential is a
 *                                   Founder gate, not a deployment step.
 *
 * Partial configuration is OFF, not half-open, and says so at boot: the same
 * rule `apps/hq-server` applies to its half. An ordinary JENIFY OS deployment —
 * the Mesob pilot's exact shape — sets none of these, gets `null`, and has no
 * `/api/sso/hq/*` route at all.
 *
 * ## What it refuses even when switched on
 *
 * A plaintext non-loopback origin, anywhere: the audience receives the service
 * secret on the sign-out back channel, and a redirect URI receives a ticket.
 * `checkBackChannelOrigin` is the same rule the HQ half enforces, imported
 * rather than re-implemented so the two halves cannot drift apart.
 */

import {
  SSO_HQ_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  checkBackChannelOrigin,
  describeBackChannelOriginRefusal,
} from '@factoryos/hq-host';
import { httpHqLogoutNotifier } from './sso-hq.js';
import type { SsoHqPlane } from '../routes/sso-hq.js';

export function loadSsoHqPlane(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): SsoHqPlane | null {
  const audience = env.FACTORYOS_SSO_HQ_AUDIENCE?.trim() ?? '';
  const rawRedirects = env.FACTORYOS_SSO_HQ_REDIRECT_URIS?.trim() ?? '';
  const serviceSecret = env.FACTORYOS_SSO_HQ_SERVICE_SECRET ?? '';

  if (env.FACTORYOS_SSO_HQ !== '1') {
    // Say something only if somebody clearly meant to switch it on: silence is
    // right for the overwhelming majority of deployments, which set none of it.
    if (audience || rawRedirects || serviceSecret) {
      log(
        '[sso] The JENIFY HQ sign-in bridge is configured but FACTORYOS_SSO_HQ is not 1, so it ' +
          'stays OFF. Switching it on is a deliberate act (fail closed).',
      );
    }
    return null;
  }

  const redirectUris = rawRedirects
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!audience || redirectUris.length === 0 || !serviceSecret) {
    log(
      '[sso] FACTORYOS_SSO_HQ=1 but the bridge is only PARTLY configured, so it stays OFF. All of ' +
        'FACTORYOS_SSO_HQ_AUDIENCE, FACTORYOS_SSO_HQ_REDIRECT_URIS and ' +
        'FACTORYOS_SSO_HQ_SERVICE_SECRET are required (fail closed).',
    );
    return null;
  }

  // The audience is where sign-out is announced, carrying the service secret.
  const checkedAudience = checkBackChannelOrigin(audience);
  if (!checkedAudience.ok) {
    log(describeBackChannelOriginRefusal('FACTORYOS_SSO_HQ_AUDIENCE', audience, checkedAudience.reason));
    return null;
  }

  // A redirect URI receives a ticket in its query string; over plaintext that
  // ticket is readable, and a ticket is a credential until it is consumed.
  for (const uri of redirectUris) {
    const checked = checkBackChannelOrigin(uri);
    if (!checked.ok) {
      log(describeBackChannelOriginRefusal('FACTORYOS_SSO_HQ_REDIRECT_URIS', uri, checked.reason));
      return null;
    }
  }

  log(
    `[sso] JENIFY HQ sign-in bridge ON: audience=${checkedAudience.origin}, ` +
      `${redirectUris.length} exact redirect URI(s). This server vouches for accounts it has ` +
      'already authenticated; it never hands HQ a password.',
  );

  return {
    audience: checkedAudience.origin,
    allowedRedirectUris: redirectUris,
    serviceSecret,
    // Trap C, wired for real rather than left to a test double. The route and
    // header come from the shared contract, so the two halves cannot disagree
    // about where sign-out is announced.
    logoutNotifier: httpHqLogoutNotifier({
      hqOrigin: checkedAudience.origin,
      serviceSecret,
      header: SSO_SERVICE_AUTH_HEADER,
      path: SSO_HQ_ROUTES.backchannelLogout,
    }),
    audit: log,
  };
}
