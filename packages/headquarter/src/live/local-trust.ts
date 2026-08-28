/**
 * How a direct order's actor is (not) authenticated — correction after the
 * ChatGPT review of PR #201, issue #200.
 *
 * ## The overclaim this module removes
 *
 * The first cut of `hq:order` described the CLI as a path "where the Founder's
 * own OS session is the authentication". That was not true. `--as <id>` takes
 * a caller-supplied principal id and binds it to nothing: not to the OS user,
 * not to the process owner, not to any credential. The only fact the interface
 * genuinely establishes is that the caller can run a process against the HQ
 * SQLite file — and anyone who can do that could already write the database
 * directly, which is precisely why the CLI grants no new authority and equally
 * why it must not be described as authenticating anybody.
 *
 * So the honest classification, recorded here rather than in prose that can
 * drift: `hq:order` is a **trusted-local-admin / maintenance interface**. It is
 * for someone who already holds full local trust over the HQ database. It is
 * NOT an authenticated Founder-facing path. That was the whole of the story
 * until the Founder decided the mechanism on 2026-08-28: HQ now reuses the
 * existing JENIFY OS login (`live/auth.ts`), and the browser control API is
 * the authenticated Founder path. This CLI is unchanged and is still not one.
 *
 * ## Fail closed, in three ways
 *
 * 1. **An `authenticated` value exists only where something earns it.** The
 *    rule has always been that adding one requires a code-reviewed change
 *    here, next to the mechanism — never a caller's assertion or an inferred
 *    flag. `authenticated_os_session` was added under exactly that rule and is
 *    settable only by `live/control-api.ts`, which refuses to read it from a
 *    request at all. This CLI still cannot reach it.
 * 2. **The default is the weakest value.** A caller that says nothing is
 *    recorded as `unauthenticated`, never as trusted-local, and never silently
 *    upgraded.
 * 3. **The interface refuses to run where "local trust" is not a real claim.**
 *    Under CI the caller is a shared automation runner, not a person at a
 *    trusted workstation, so the invocation is refused outright; and even
 *    locally the operator must acknowledge the trust model explicitly, so an
 *    unattended script cannot place principal-attributed orders by accident.
 *
 * ## What actually contains an impersonated assertion
 *
 * Not this module. Two canonical rules do, and both are untouched:
 *
 * - **Deny by default.** An asserted id that is not a registered human
 *   principal holding the origination grant opens nothing at all.
 * - **No self-approval.** `OperatorQueue.approve` refuses `by === createdBy`.
 *   An order asserted as `founder` is exactly the order `founder` may not
 *   approve, so a local assertion can never manufacture an *approved* action;
 *   a second, genuinely present approval-authorized human has to decide it,
 *   and they see the actor assertion recorded on the task.
 *
 * `test/live-order-actor-trust.test.ts` proves each of those end to end.
 */

/**
 * What is known about the actor behind a write.
 *
 * Rule 1 above said a value claiming authentication could only be added "in a
 * code-reviewed change, next to the mechanism that earns it". This is that
 * change: the Founder decided on 2026-08-28 that HQ reuses the existing
 * JENIFY OS login, and `live/auth.ts` implements that boundary. So there is
 * now exactly one authenticated value, and the rule that produced it is
 * unchanged — a third value would need the same treatment again.
 */
export type ActorAuthentication =
  /**
   * The acting principal was derived server-side from a live JENIFY OS
   * session plus an EXPLICIT configured account→principal binding.
   *
   * What this value does and does not claim, precisely, because a marker that
   * overclaims is worse than none:
   *
   * - It claims the caller held a valid, unexpired, unrevoked session for an
   *   account the deployment bound to this HQ principal by configuration.
   * - It does NOT claim the human was re-verified at this moment. Step-up
   *   (`verifyStepUp`) is what does that, and it is required separately for
   *   irreversible approvals rather than folded in here.
   * - It grants nothing. It is a record of how the attribution was obtained,
   *   travelling inside the action digest so an approver sees it and it
   *   cannot be edited between rendering and approval.
   *
   * Only `live/control-api.ts` may set it, because only that path resolves an
   * identity through `live/auth.ts`. No caller can supply it: the control API
   * refuses any request body carrying `actorAuthentication` at all.
   */
  | 'authenticated_os_session'
  /**
   * A principal id asserted at a trusted-local-admin interface. Establishes
   * local process access to the HQ database; establishes nothing about WHO.
   */
  | 'unauthenticated_local_assertion'
  /** Nothing at all is known about the caller. The default. */
  | 'unauthenticated';

export const DEFAULT_ACTOR_AUTHENTICATION: ActorAuthentication = 'unauthenticated';

/**
 * One-line classification of the CLI, quoted by the CLI itself and by the UI
 * so the two can never drift into different claims.
 */
export const LOCAL_ADMIN_INTERFACE_NOTICE =
  'hq:order is a TRUSTED-LOCAL-ADMIN / MAINTENANCE interface, not an authenticated Founder ' +
  'path: --as asserts a principal id and does not authenticate it. Anyone who can run this ' +
  'command already has full local access to the Headquarter database. The order is attributed ' +
  'to the asserted id, executes nothing on creation, and still needs a Founder approval that ' +
  'the asserted principal itself may not give.';

/** The flag by which an operator acknowledges the classification above. */
export const LOCAL_ADMIN_ACK_FLAG = '--local-admin';

/** Environment variables whose presence means "this is not a person's workstation". */
export const CI_ENVIRONMENT_VARIABLES = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
] as const;

export type LocalInvocationRejection = 'ci_environment' | 'acknowledgement_missing';

export type LocalInvocationResult =
  | { ok: true }
  | { ok: false; reason: LocalInvocationRejection; message: string };

/** True when the environment identifies itself as automation rather than a workstation. */
export function looksLikeCi(env: NodeJS.ProcessEnv): string | null {
  for (const name of CI_ENVIRONMENT_VARIABLES) {
    const value = env[name];
    if (value == null) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === 'false' || normalized === '0') continue;
    return name;
  }
  return null;
}

/**
 * Decide whether this process may act as a trusted-local admin at all.
 *
 * Refuses in CI (a shared runner is not a trusted workstation, and an
 * automation job must not open principal-attributed orders) and refuses
 * without the explicit acknowledgement flag. There is deliberately no override
 * environment variable: an escape hatch would be exactly the "trust me" input
 * this whole correction exists to remove.
 */
export function resolveLocalAdminInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): LocalInvocationResult {
  const ci = looksLikeCi(env);
  if (ci) {
    return {
      ok: false,
      reason: 'ci_environment',
      message:
        `Refusing to run: ${ci} is set, so this is automation, not a trusted local workstation. ` +
        'This interface asserts a principal id without authenticating it, which is only ' +
        'defensible for someone who already holds local trust over the HQ database. There is ' +
        'no override.',
    };
  }
  if (!argv.includes(LOCAL_ADMIN_ACK_FLAG)) {
    return {
      ok: false,
      reason: 'acknowledgement_missing',
      message:
        `Refusing to run: pass ${LOCAL_ADMIN_ACK_FLAG} to acknowledge the trust model. ` +
        LOCAL_ADMIN_INTERFACE_NOTICE,
    };
  }
  return { ok: true };
}
