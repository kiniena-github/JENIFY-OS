/**
 * The re-scoped mutation invariant (issue #200, LIVE HQ CONTROL V1).
 *
 * PR #211's harness locked "no page contains a form, button, input or
 * mutation" — the right invariant while nothing could authenticate a browser.
 * PR #214 built the authenticated control API, and wiring the composer to it
 * collides with that invariant head-on. This file is the re-scope, and it is
 * deliberately at least as strict about honesty as the old rule was about
 * inertness:
 *
 *   1. The static render still ships NO active control anywhere — a control
 *      drawn for a viewer whose session does not grant it is a false claim.
 *      (`site.test.ts` and `live-ui.test.ts` keep the literal assertions.)
 *   2. No mutation except through the authenticated control API: the wiring
 *      script's only fetch targets are the `CONTROL_ROUTES` constants.
 *   3. No control is drawn that `/session` did not grant: the decision is a
 *      pure function, executed here exactly as the browser executes it, and
 *      it fails closed on every malformed or partial answer.
 *   4. The script never names an actor: no identity-shaped key appears in any
 *      request body it can build.
 *   5. Server text reaches the page through `textContent` only — the script
 *      contains no HTML-injection sink, so a hostile server string cannot
 *      become markup.
 *   6. Outcomes are reported truthfully: BLOCKED stays blocked with no
 *      substitute suggested, approval-gated stays "executes NOTHING until a
 *      Founder approves", and an unreadable reply claims nothing.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSite, type HeadquarterData } from '../src/ui/site.js';
import {
  CONTROL_STATIC_NOTE,
  CONTROL_VERDICT_JS,
  DECISION_OUTCOME_JS,
  ORDER_OUTCOME_JS,
  controlConsoleScript,
} from '../src/ui/control-console.js';
import { CONTROL_ROUTES, CONTROL_API_PREFIX } from '../src/live/control-api.js';
import { CLIENT_IDENTITY_KEYS } from '../src/live/auth.js';
import { HQ_PAGES } from '../src/ui/render.js';

const samplePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'hq-sample.json');
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as HeadquarterData;
const site = buildSite(sample);
const script = controlConsoleScript();

/** Execute the shipped decision source, exactly as the browser does. */
function shipped<T>(source: string, name: string): T {
  return new Function(`${source}; return ${name};`)() as T;
}

type Verdict = { directOrder: boolean; approve: boolean; deny: boolean; message: string };
const controlVerdict = shipped<(session: unknown) => Verdict>(CONTROL_VERDICT_JS, 'controlVerdict');
const orderOutcome = shipped<(status: number, body: unknown) => { kind: string; text: string }>(
  ORDER_OUTCOME_JS,
  'orderOutcome',
);
const decisionOutcome = shipped<
  (action: string, status: number, body: unknown) => { kind: string; text: string }
>(DECISION_OUTCOME_JS, 'decisionOutcome');

/** A fully granted session, the ONE shape that may enable everything. */
const GRANTED = {
  ok: true,
  authenticated: true,
  founder: true,
  principalId: 'founder',
  displayName: 'Founder',
  approvalAuthority: true,
  controls: {
    directOrder: true,
    approve: true,
    deny: true,
    mutationsEnabled: true,
    trustedOriginConfigured: true,
    askForChanges: false,
  },
};

describe('where the script ships', () => {
  it('is embedded on exactly the two pages that hold a control container', () => {
    const withScript = HQ_PAGES.filter((page) => site.get(page.file)!.includes('controlVerdict'));
    expect(withScript.map((page) => page.file).sort()).toEqual(['approvals.html', 'index.html']);
  });

  it('leaves the Headquarters Floor and every other page fully inert', () => {
    for (const page of HQ_PAGES) {
      if (page.file === 'index.html' || page.file === 'approvals.html') continue;
      const html = site.get(page.file)!;
      expect(html, page.file).not.toContain('data-hq-order-composer');
      expect(html, page.file).not.toContain('data-hq-approvals');
      expect(html, page.file).not.toContain('controlVerdict');
    }
  });

  it('ships ONE decision implementation: the page runs the source these tests run', () => {
    expect(site.get('index.html')!).toContain(CONTROL_VERDICT_JS);
    expect(site.get('approvals.html')!).toContain(CONTROL_VERDICT_JS);
    expect(script).toContain(CONTROL_VERDICT_JS);
    expect(script).toContain(ORDER_OUTCOME_JS);
    expect(script).toContain(DECISION_OUTCOME_JS);
  });

  it('states the truthful static sentence that is also true with scripting disabled', () => {
    for (const file of ['index.html', 'approvals.html']) {
      expect(site.get(file)!).toContain('If this sentence is all you see');
    }
    expect(CONTROL_STATIC_NOTE).toContain('No control is ever drawn that the session did not grant');
  });
});

describe('no control is drawn that /session did not grant (fail closed)', () => {
  it('grants everything only for the fully granted shape', () => {
    const verdict = controlVerdict(GRANTED);
    expect(verdict).toMatchObject({ directOrder: true, approve: true, deny: true });
    expect(verdict.message).toContain('canonical Operator rules');
  });

  it('draws nothing for any malformed or non-ok reply', () => {
    for (const bad of [null, undefined, 42, 'ok', [], {}, { ok: false }, { ok: 'true' }]) {
      const verdict = controlVerdict(bad);
      expect(verdict, JSON.stringify(bad)).toMatchObject({
        directOrder: false,
        approve: false,
        deny: false,
      });
      expect(verdict.message.length).toBeGreaterThan(20);
    }
  });

  it('draws nothing for an unauthenticated or non-Founder session, with the truthful reason', () => {
    const signedOut = controlVerdict({ ok: true, authenticated: false, founder: false });
    expect(signedOut).toMatchObject({ directOrder: false, approve: false, deny: false });
    expect(signedOut.message).toContain('Not signed in');

    const staff = controlVerdict({
      ok: true,
      authenticated: true,
      founder: false,
      message: 'This account is signed in but is not the HQ Founder.',
    });
    expect(staff).toMatchObject({ directOrder: false, approve: false, deny: false });
    expect(staff.message).toContain('not the HQ Founder');
  });

  it('requires each flag to be literally true — truthy is not granted', () => {
    for (const notTrue of [1, 'true', 'yes', {}, []]) {
      const verdict = controlVerdict({
        ...GRANTED,
        controls: { directOrder: notTrue, approve: notTrue, deny: notTrue },
      });
      expect(verdict, JSON.stringify(notTrue)).toMatchObject({
        directOrder: false,
        approve: false,
        deny: false,
      });
    }
  });

  it('honours partial grants exactly — registry authority is never widened client-side', () => {
    const approveOnly = controlVerdict({
      ...GRANTED,
      controls: { ...GRANTED.controls, directOrder: false },
    });
    expect(approveOnly).toMatchObject({ directOrder: false, approve: true, deny: true });

    const originateOnly = controlVerdict({
      ...GRANTED,
      controls: { ...GRANTED.controls, approve: false, deny: false },
    });
    expect(originateOnly).toMatchObject({ directOrder: true, approve: false, deny: false });
  });

  it('draws nothing when controls are missing, and says why for known read-only postures', () => {
    const noControls = controlVerdict({ ok: true, authenticated: true, founder: true });
    expect(noControls).toMatchObject({ directOrder: false, approve: false, deny: false });

    const mutationsOff = controlVerdict({
      ...GRANTED,
      controls: { ...GRANTED.controls, directOrder: false, approve: false, deny: false, mutationsEnabled: false },
    });
    expect(mutationsOff.message).toContain('switched off');

    const noOrigin = controlVerdict({
      ...GRANTED,
      controls: {
        ...GRANTED.controls,
        directOrder: false,
        approve: false,
        deny: false,
        trustedOriginConfigured: false,
      },
    });
    expect(noOrigin.message).toContain('no trusted origin');
  });
});

describe('mutations can only target the authenticated control API', () => {
  it('fetches only URL constants, and every constant is a CONTROL_ROUTES path', () => {
    const fetchTargets = [...script.matchAll(/fetch\(\s*([A-Za-z_]+)\s*[,)]/g)].map((m) => m[1]!);
    expect(fetchTargets.length).toBeGreaterThan(0);
    const allowed = ['SESSION_URL', 'ORDERS_URL', 'APPROVALS_URL', 'APPROVE_URL', 'DENY_URL', 'url'];
    for (const target of fetchTargets) {
      expect(allowed, `fetch(${target}) is not a named control-API constant`).toContain(target);
    }
    // The generic `url` parameter is reachable only through postJson and the
    // decide() helper; every call site of either must pass a named constant.
    const postTargets = [...script.matchAll(/(?<!function )postJson\(\s*([A-Za-z_]+)\s*,/g)].map(
      (m) => m[1]!,
    );
    for (const target of postTargets) {
      expect(['ORDERS_URL', 'APPROVE_URL', 'DENY_URL', 'url']).toContain(target);
    }
    const decideTargets = [...script.matchAll(/decide\(\s*'[a-z]+',\s*([A-Za-z_]+)\s*,/g)].map(
      (m) => m[1]!,
    );
    expect(decideTargets.length).toBeGreaterThan(0);
    for (const target of decideTargets) {
      expect(['APPROVE_URL', 'DENY_URL']).toContain(target);
    }
    // And the constants are bound to the canonical route table, not retyped.
    for (const [name, route] of [
      ['SESSION_URL', CONTROL_ROUTES.session],
      ['ORDERS_URL', CONTROL_ROUTES.orders],
      ['APPROVALS_URL', CONTROL_ROUTES.approvals],
      ['APPROVE_URL', CONTROL_ROUTES.approve],
      ['DENY_URL', CONTROL_ROUTES.deny],
    ] as const) {
      expect(script).toContain(`var ${name} = ${JSON.stringify(route)}`);
      expect(route.startsWith(CONTROL_API_PREFIX)).toBe(true);
    }
  });

  it('sends the session cookie the same-origin way and never caches an authenticated answer', () => {
    expect(script).toContain("credentials: 'same-origin'");
    expect(script).not.toContain("credentials: 'include'");
    expect(script).toContain("cache: 'no-store'");
  });

  it('contains no HTML-injection sink: server text lands via textContent only', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'srcdoc']) {
      expect(script).not.toContain(sink);
    }
    expect(script).toContain('textContent');
  });

  it('adds no inline handler and no literal markup tag the static invariant forbids', () => {
    // The script is embedded in the page, so it must not smuggle in the very
    // substrings the static assertions exclude.
    expect(script).not.toContain('<form');
    expect(script).not.toContain('<button');
    expect(script).not.toContain('<input');
    expect(script).not.toMatch(/\son(click|submit|load|error|mouseover)=/);
  });
});

describe('the script never names an actor', () => {
  it('builds no request body carrying an identity-shaped key', () => {
    // Every JSON body the script can send is either a `payload` object built
    // from these literals or the inline decide() objects. Scan all object
    // literals and property assignments in the script for the refused keys.
    const propertyNames = [
      ...[...script.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)].map((m) => m[1]!),
      ...[...script.matchAll(/payload\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)].map((m) => m[1]!),
    ];
    for (const key of CLIENT_IDENTITY_KEYS) {
      expect(propertyNames, `script must never build a '${key}' field`).not.toContain(key);
    }
  });

  it('the body fields it does build are exactly the contract fields', () => {
    for (const legitimate of ['instruction', 'route', 'idempotencyKey', 'taskId', 'expectedActionDigest', 'reason', 'stepUpPassword']) {
      expect(script).toContain(legitimate);
    }
  });
});

describe('order outcomes are reported truthfully', () => {
  it('reports a created Founder-gated order as executing nothing yet', () => {
    const outcome = orderOutcome(201, {
      ok: true,
      taskId: 'task-1',
      status: 'needs_approval',
      deduplicated: false,
      requiresFounderApproval: true,
      actionDigest: 'a'.repeat(64),
      route: { requested: 'AUTO', resolved: 'CLAUDE', reason: 'AUTO selected CLAUDE' },
    });
    expect(outcome.kind).toBe('created');
    expect(outcome.text).toContain('executes NOTHING until a Founder approves');
    expect(outcome.text).toContain('AUTO → CLAUDE');
    expect(outcome.text).toContain('never substituted');
  });

  it('reports a deduplicated submission as matching, not as creating', () => {
    const outcome = orderOutcome(200, {
      ok: true,
      taskId: 'task-1',
      status: 'needs_approval',
      deduplicated: true,
      requiresFounderApproval: true,
      actionDigest: 'a'.repeat(64),
    });
    expect(outcome.kind).toBe('deduplicated');
    expect(outcome.text).toContain('no second task was created');
  });

  it('reports an unconnected provider as BLOCKED with each candidate verdict and no substitute', () => {
    const outcome = orderOutcome(409, {
      ok: false,
      error: {
        code: 'provider_not_connected',
        message: 'CODEX was requested explicitly and is NOT connected here.',
      },
      route: [
        {
          provider: 'CODEX',
          connected: false,
          reason: 'missing local facts',
          missingFacts: ['CODEX_CLI_PATH'],
        },
      ],
    });
    expect(outcome.kind).toBe('blocked');
    expect(outcome.text).toContain('BLOCKED');
    expect(outcome.text).toContain('no other provider was substituted');
    expect(outcome.text).toContain('CODEX: NOT CONNECTED');
    // Fact NAMES may appear via the reason; the outcome adds no invented state.
    expect(outcome.text).not.toContain('CLAUDE');
  });

  it('claims nothing about an unreadable reply', () => {
    for (const broken of [null, undefined, 'weird', 42]) {
      const outcome = orderOutcome(500, broken);
      expect(outcome.kind).toBe('error');
      expect(outcome.text).toContain('nothing can be claimed');
    }
  });

  it('reports a refusal as a refusal, with the server code', () => {
    const outcome = orderOutcome(403, {
      ok: false,
      error: { code: 'capability_disabled', message: 'Capability hq.direct_order is disabled.' },
    });
    expect(outcome.kind).toBe('refused');
    expect(outcome.text).toContain('capability_disabled');
    expect(outcome.text).toContain('Nothing was created');
  });
});

describe('decision outcomes are reported truthfully', () => {
  it('reports a recorded decision with the canonical resulting status', () => {
    const outcome = decisionOutcome('approval', 200, { ok: true, taskId: 't1', status: 'queued' });
    expect(outcome.kind).toBe('done');
    expect(outcome.text).toContain('t1 is now queued');
  });

  it('surfaces step-up refusals as step-up, never as success or generic failure', () => {
    for (const code of ['step_up_required', 'step_up_failed', 'step_up_rate_limited', 'step_up_unavailable']) {
      const outcome = decisionOutcome('approval', 401, {
        ok: false,
        error: { code, message: `server says: ${code}` },
      });
      expect(outcome.kind, code).toBe('step_up');
      expect(outcome.text).toContain(code);
    }
  });

  it('explains a digest mismatch as the action having changed, and as NOT applied', () => {
    const outcome = decisionOutcome('approval', 409, {
      ok: false,
      error: { code: 'action_digest_mismatch', message: 'digest mismatch' },
    });
    expect(outcome.kind).toBe('refused');
    expect(outcome.text).toContain('was not applied');
  });

  it('claims nothing about an unreadable decision reply', () => {
    expect(decisionOutcome('denial', 502, null).kind).toBe('error');
  });
});

describe('the drawn controls honour the canonical rules the server enforces', () => {
  it('withholds Approve on a self-approval card and says why', () => {
    // Structural: the approve button is created only under
    // `verdict.approve && card.selfApproval !== true`, and the self-approval
    // branch draws the truthful sentence instead.
    expect(script).toContain('verdict.approve && card.selfApproval !== true');
    expect(script).toContain('no-self-approval rule refuses your approval');
  });

  it('asks for step-up exactly where the card requires it, as a password the server verifies', () => {
    expect(script).toContain('card.stepUpRequired === true');
    expect(script).toContain('stepUpPassword');
    // The password is read from a live input and never stored or echoed.
    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
  });

  it('requires a denial reason before sending anything', () => {
    expect(script).toContain("if (reason === '')");
    expect(script).toContain('Nothing was sent');
  });

  it('keeps one submission key across retries and rotates it only after success', () => {
    // A network failure retried with the same content must not double-create;
    // a deliberate second identical order after success must.
    expect(script).toContain('var submissionKey = freshKey()');
    expect(script).toContain("outcome.kind === 'created' || outcome.kind === 'deduplicated'");
    expect(script.split('submissionKey = freshKey()').length).toBe(3); // initial + rotate-on-success
  });
});
