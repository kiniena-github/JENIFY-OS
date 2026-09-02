/**
 * Environment-gated host configuration for the HQ control plane
 * (issue #200, integration lane; moved in Phase 2, Stage 1).
 *
 * The loader itself now lives in `@factoryos/hq-host`, because it never had a
 * single dependency on this server: it reads `FACTORYOS_HQ_*`, opens the HQ
 * database and builds the control plane entirely out of `@factoryos/headquarter`
 * and node builtins. Keeping it here would have tied a standalone HQ process to
 * the tenant platform for no reason.
 *
 * This module stays as the server's import path so `buildApp`, the ops scripts
 * and `test/headquarter-host.test.ts` are unaffected by the move. The variables,
 * the fail-closed rules and the OFF-by-default behaviour are unchanged:
 *
 *   FACTORYOS_HQ_CONTROL=1          master switch. Anything else ⇒ OFF.
 *   FACTORYOS_HQ_DB=<path>          the HQ SQLite database. REQUIRED once on.
 *   FACTORYOS_HQ_FOUNDER_MAP=<json> explicit account→principal bindings.
 *   FACTORYOS_HQ_ALLOWED_ORIGINS=<csv>  trusted origins for browser writes.
 *   FACTORYOS_HQ_MUTATIONS=1        browser writes; anything else ⇒ reads only.
 *   FACTORYOS_HQ_SITE_DIR=<path>    static HQ site, served same-origin at /hq/.
 *
 * An ordinary JENIFY OS deployment — the Mesob pilot's exact shape — sets none
 * of them, gets `null`, and gains no HQ route and no new auth surface.
 */

export {
  loadHeadquarterHost,
  observableProviderFacts,
  type HeadquarterHost,
} from '@factoryos/hq-host';
