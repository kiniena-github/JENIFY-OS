/**
 * Turn an observed GitHub transport into a route-availability verdict
 * (issue #224, Codex P1 and P2 on `66d34cc`).
 *
 * ## Why this exists
 *
 * `RouteAvailability` lets a host that can genuinely observe the transport
 * answer "is CLAUDE dispatchable from here?" instead of inferring it from
 * `CLAUDE_ROUTINE_*`. Those are GitHub Actions secrets, deliberately absent on
 * the Founder workstation, where the order travels through the authenticated
 * `gh` session — so inferring from their absence reports a perfectly
 * dispatchable order as BLOCKED, in exactly the environment this lane is built
 * for.
 *
 * The wiring existed but reached only the server host. The Direct Order CLI —
 * which RUNS on the workstation, and is therefore the caller best placed to
 * observe the transport — passed nothing, so it inherited the wrong answer and
 * printed a confident `BLOCKED — NOT CONNECTED` over an order that could have
 * been dispatched. Putting the derivation here rather than inline in the CLI
 * makes it a tested property and gives every observing host one verdict to
 * share, instead of each writing its own slightly different one.
 *
 * ## The three answers, and why a live negative is not "don't know"
 *
 * | Observation | Verdict |
 * |---|---|
 * | live check ran, session authenticated | `true` |
 * | live check ran, no authenticated session | `false` |
 * | no transport here, or the check could not run | `null` |
 *
 * The middle row is the one worth stating. `gh auth status` calls the API, so a
 * non-zero exit is a LIVE answer — the session is missing, expired or revoked —
 * and collapsing it to `null` throws away the strongest fact available. The
 * routing contract would then answer from `secretsEnv`, and a host that happens
 * to carry `CLAUDE_ROUTINE_*` would report the composer and the order READY
 * while the only transport that could carry them refuses as unauthenticated.
 * Discarding a negative you actually observed is how a surface ends up more
 * confident than the evidence.
 *
 * `null` stays reserved for genuine ignorance — no `gh`, or a binary that could
 * not be run — where deferring to the routing contract is exactly right. This
 * module never invents a `true`.
 *
 * Provider-scoped on purpose: it answers for CLAUDE and returns `null` for
 * every other provider, because a GitHub issue transport says nothing about
 * whether Codex's local CLI is installed.
 */

import type { RouteAvailability } from '../../live/orders.js';
import type { ProviderId } from '../../routing/providers.js';
import { DISPATCH_PROVIDER } from './dispatch.js';
import type { GitHubIssueTransport } from './transport.js';

/**
 * How long an observed verdict is reused before the transport is asked again.
 *
 * `gh auth status` spawns a process and calls the GitHub API, so a caller that
 * resolves several routes in one run (the composer offers three) must not pay
 * for it three times. A single CLI invocation is well inside this window, so in
 * practice the check happens once per run.
 */
export const TRANSPORT_VERDICT_TTL_MS = 60_000;

export interface TransportAvailabilityOptions {
  /** Reuse window for an observed verdict. Injected so tests control it. */
  ttlMs?: number;
  /** Clock, injected for the same reason. */
  now?: () => number;
}

/**
 * A `RouteAvailability` backed by a real transport observation.
 *
 * Caches per instance, so the returned object is the unit of caching: build one
 * per host or per CLI run, not one per question.
 *
 * A transport whose `status()` THROWS is treated as ignorance (`null`), not as
 * a negative. A probe that fell over tells us nothing about the session, and
 * turning a broken probe into "not dispatchable" would block orders on the
 * health of the check rather than on the health of the transport.
 */
export function transportRouteAvailability(
  transport: GitHubIssueTransport,
  options: TransportAvailabilityOptions = {},
): RouteAvailability {
  const ttlMs = options.ttlMs ?? TRANSPORT_VERDICT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; verdict: boolean | null } | null = null;

  return {
    providerDispatchable(provider: ProviderId): boolean | null {
      // This transport carries CLAUDE and nothing else. Every other provider is
      // somebody else's question, and answering it would be a guess.
      if (provider !== DISPATCH_PROVIDER) return null;
      const at = now();
      if (cached != null && at - cached.at <= ttlMs) return cached.verdict;
      let verdict: boolean | null;
      try {
        const status = transport.status();
        if (status.depth !== 'live') {
          // No live check happened — no transport here, or it could not be run.
          verdict = null;
        } else {
          // A live check DID happen, so its answer is an answer either way.
          verdict = status.available && status.authenticated;
        }
      } catch {
        verdict = null;
      }
      cached = { at, verdict };
      return verdict;
    },
  };
}
