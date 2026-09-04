/**
 * What this browser session is allowed to see and do (issue #250, Stage 4).
 *
 * ## Why the decision is a string of JavaScript
 *
 * The same reason `FRESHNESS_VERDICT_JS` and `CONTROL_GRANT_JS` are: a claim
 * this load-bearing must be tested by RUNNING the code that ships, not by
 * grepping the rendered page for a label. `ACCESS_VERDICT_JS` is embedded
 * verbatim in the immersive page and executed directly by
 * `test/client-access.test.ts` through `new Function`. There is one
 * implementation of "am I allowed in", and it is the one in the document.
 *
 * ## Fail closed, in both directions
 *
 * Every unknown is a refusal:
 *
 *   - the fetch threw (offline, DNS, TLS, the host is down)      → `unreachable`
 *   - the body is not an object, or `ok` is not literally `true` → `malformed`
 *   - 401                                                        → `unauthenticated`
 *   - 200 with `founder !== true`                                → `not_founder`
 *   - 403                                                        → `refused`
 *   - 503 (the identity service did not answer)                  → `unavailable`
 *   - anything else                                              → `malformed`
 *
 * and only a 200 whose body says `ok: true` AND `founder: true` reaches
 * `ready`. `authenticated: true` is not enough, a truthy-but-not-true value is
 * not enough, and a missing field is never read as a permissive default.
 *
 * ## Session expiry is a transition, not a startup case
 *
 * The runtime re-evaluates this verdict on every poll, not only on load. A
 * session that expires mid-session moves `ready → unauthenticated` and the
 * runtime tears every control it drew back down. That is why the verdict is a
 * pure function of one response: it can be applied to the tenth poll exactly as
 * it was applied to the first.
 *
 * ## The message is the server's, verbatim
 *
 * HQ's control API already writes careful, specific refusal messages, and this
 * layer must not paraphrase them into something vaguer. The verdict carries the
 * server's own `message` when it sent one, and falls back to its own wording
 * only when the server said nothing.
 */

/** The states the immersive shell can be in with respect to authority. */
export type AccessState =
  | 'ready'
  | 'unauthenticated'
  | 'not_founder'
  | 'refused'
  | 'unavailable'
  | 'unreachable'
  | 'malformed';

export interface AccessVerdict {
  state: AccessState;
  /** Short label for the header chip. */
  label: string;
  /** The full explanation, the server's own words where it supplied them. */
  message: string;
  /** True only for `ready`. Convenience for the renderer; never inferred. */
  founder: boolean;
}

/**
 * The verdict function, as browser-executable source.
 *
 * Takes `(status, body, transportError)` where `transportError` is the thrown
 * error's message when the fetch itself failed and `null` otherwise. Keeping
 * the transport failure IN the same function is deliberate: an unreachable HQ
 * and a refused HQ are different findings, and a caller that had to distinguish
 * them outside this function could get that distinction wrong in the one place
 * it matters.
 */
export const ACCESS_VERDICT_JS = `function accessVerdict(status, body, transportError) {
  if (transportError) {
    return {
      state: 'unreachable',
      label: 'HQ UNREACHABLE',
      message: 'The HQ control API could not be reached (' + String(transportError) + '). Nothing on this ' +
        'screen is current, and no control is drawn.',
      founder: false
    };
  }
  var readable = body != null && typeof body === 'object';
  var stated = readable && typeof body.message === 'string' && body.message !== '' ? body.message : '';
  var errorMessage = readable && body.error != null && typeof body.error === 'object' &&
    typeof body.error.message === 'string' && body.error.message !== '' ? body.error.message : '';
  if (status === 401) {
    return {
      state: 'unauthenticated',
      label: 'SIGNED OUT',
      message: stated || errorMessage || 'This browser holds no HQ session. Sign in to load canonical state.',
      founder: false
    };
  }
  if (status === 503) {
    return {
      state: 'unavailable',
      label: 'AUTHORITY UNAVAILABLE',
      message: errorMessage || stated || 'The identity service did not answer, so this session could not be ' +
        'established. Nothing was changed.',
      founder: false
    };
  }
  if (status === 403) {
    return {
      state: 'refused',
      label: 'REFUSED',
      message: errorMessage || stated || 'HQ refused this request. No control is drawn.',
      founder: false
    };
  }
  if (status !== 200) {
    return {
      state: 'malformed',
      label: 'UNREADABLE ANSWER',
      message: 'The HQ control API answered ' + String(status) + ', which this client does not accept as a ' +
        'session answer. Nothing is claimed and no control is drawn.',
      founder: false
    };
  }
  if (!readable || body.ok !== true) {
    return {
      state: 'malformed',
      label: 'UNREADABLE ANSWER',
      message: 'The HQ control API answered 200 with a body this client cannot read as a session. Nothing is ' +
        'claimed and no control is drawn.',
      founder: false
    };
  }
  if (body.founder !== true) {
    return {
      state: 'not_founder',
      label: 'READ REFUSED',
      message: stated || 'This session is signed in but is not the mapped Founder, so HQ answers no canonical ' +
        'state to it. This is the deployment working as configured, not an error.',
      founder: false
    };
  }
  return {
    state: 'ready',
    label: 'FOUNDER SESSION',
    message: stated || 'Signed in as the mapped Founder. Canonical state below is served by the authenticated ' +
      'HQ state route; controls are drawn only where the server granted them.',
    founder: true
  };
}`;

/**
 * The same decision, callable from Node.
 *
 * Built by evaluating the SHIPPED source rather than re-implementing it, so a
 * server-side reader and the browser can never disagree. The one-time `new
 * Function` is over a module-private constant, never over anything a request
 * could reach.
 */
export const accessVerdict = new Function(
  `${ACCESS_VERDICT_JS}; return accessVerdict;`,
)() as (status: number, body: unknown, transportError: string | null) => AccessVerdict;

/**
 * Is HQ locked down right now, according to canonical state?
 *
 * The kill switch is not an access question — a Founder can be perfectly
 * authorised while the switch is engaged — so it is answered separately and
 * reported alongside the access verdict rather than folded into it. Folding
 * them would produce the wrong message for both cases.
 */
export interface LockState {
  locked: boolean;
  label: string;
  message: string;
}

export const LOCK_STATE_JS = `function lockState(killSwitch) {
  if (killSwitch == null || typeof killSwitch !== 'object') {
    return {
      locked: false,
      label: '',
      message: 'The state document carried no kill-switch record, so no lock is claimed either way.'
    };
  }
  var scopes = Array.isArray(killSwitch.engagedScopes) ? killSwitch.engagedScopes : [];
  if (killSwitch.globalEngaged === true) {
    return {
      locked: true,
      label: 'HQ LOCKED',
      message: 'The global kill switch is ENGAGED. No capability may execute anywhere in HQ until it is ' +
        'released. Controls that would dispatch work are not drawn.'
    };
  }
  if (scopes.length > 0) {
    return {
      locked: true,
      label: 'PARTIALLY LOCKED',
      message: 'The kill switch is engaged for ' + scopes.length + ' scope(s): ' + scopes.join(', ') +
        '. Work inside those scopes cannot execute.'
    };
  }
  return { locked: false, label: '', message: '' };
}`;

export const lockState = new Function(`${LOCK_STATE_JS}; return lockState;`)() as (
  killSwitch: unknown,
) => LockState;
