/**
 * `@factoryos/hq-host` — JENIFY HQ's own HTTP host.
 *
 * HQ can be served by any process that can run Fastify. It depends on the HQ
 * core and a host-supplied identity source, not on the JENIFY OS tenant server.
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

export {
  HQ_DURABLE_TOPOLOGY,
  openHqPersistence,
  resolveHqPersistenceConfig,
  restoreHqBackupToNewFile,
  type HqBackupResult,
  type HqPersistence,
  type HqPersistenceConfig,
  type HqPersistenceMode,
  type HqRuntimeMode,
} from './persistence.js';

export type { HeadquarterSiteOptions } from './routes.js';

/** A-4: shared Jenify identity, separate host-only HQ session. */
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

export {
  backChannelUrl,
  checkBackChannelOrigin,
  checkBackChannelUrl,
  describeBackChannelOriginRefusal,
  isLoopbackHostname,
  type BackChannelOriginCheck,
  type BackChannelOriginRefusal,
  type BackChannelUrlCheck,
} from './sso/origin.js';

export {
  HqSessionStore,
  HQ_REVOCATION_TOMBSTONE_TTL_MS,
  HQ_SESSION_PRUNE_BATCH,
  HQ_SESSION_PRUNE_RETENTION_MS,
  HQ_SESSION_EXPIRED_CANDIDATES_SQL,
  HQ_SESSION_REVOKED_CANDIDATES_SQL,
  type HqSessionCreation,
  type HqSessionRecord,
} from './sso/session-store.js';
export { httpBackChannel, type IdentityBackChannel } from './sso/back-channel.js';
export { ssoIdentity, type SsoIdentity, type StepUpPreparation } from './sso/identity.js';
export {
  registerHqSsoRoutes,
  beginHandoff,
  safeReturnPath,
  type HqSsoOptions,
} from './sso/routes.js';
