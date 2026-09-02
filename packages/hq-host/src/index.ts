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
