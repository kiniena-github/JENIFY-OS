/**
 * `@factoryos/hq-host` — JENIFY HQ's own HTTP host (Phase 2, Stage 1).
 *
 * HQ can now be served by any process that can run Fastify. It needs the core
 * (`@factoryos/headquarter`) and an identity source, and nothing else — in
 * particular, not the JENIFY OS tenant platform.
 *
 * Two consumers exist today:
 *
 *   · `@factoryos/server` — supplies identity over its `fos_session` cookie, so
 *     the proven local control plane behaves exactly as before.
 *   · `apps/hq-server`    — supplies `NO_IDENTITY`, so it boots, serves, and
 *     truthfully refuses everything. That is the correct standalone posture
 *     until Founder Gate A decides identity for a separate origin.
 */

export {
  registerHeadquarterRoutes,
  registerHeadquarterSite,
  HQ_SITE_PREFIX,
  type HeadquarterControlPlane,
} from './routes.js';

export {
  NO_IDENTITY,
  type HqIdentityPort,
  type HqRequestIdentity,
} from './identity.js';

export {
  loadHeadquarterHost,
  observableProviderFacts,
  type HeadquarterHost,
} from './config.js';

export type { HeadquarterSiteOptions } from './routes.js';

/**
 * A-4: shared Jenify identity, separate host-only HQ session
 * (Founder Gate A, decided 2026-09-02).
 *
 * A host wiring these must register `@fastify/cookie` itself — the cookie layer
 * is the host's, not this package's, and `@factoryos/server` already has one.
 */
export {
  HQ_SESSION_COOKIE,
  HQ_SESSION_TTL_MS,
  HQ_SSO_STATE_COOKIE,
  SSO_HQ_ROUTES,
  SSO_IDENTITY_ROUTES,
  SSO_SERVICE_AUTH_HEADER,
  SSO_TICKET_TTL_MS,
  type HqSsoClaims,
  type SsoPasswordResult,
  type SsoRedeemError,
  type SsoRedeemResult,
  type SsoVerifyPasswordRequest,
} from './sso/contract.js';

export { HqSessionStore, type HqSessionRecord } from './sso/session-store.js';
export { httpBackChannel, type IdentityBackChannel } from './sso/back-channel.js';
export { ssoIdentity, type SsoIdentity, type StepUpPreparation } from './sso/identity.js';
export {
  registerHqSsoRoutes,
  beginHandoff,
  safeReturnPath,
  type HqSsoOptions,
} from './sso/routes.js';
