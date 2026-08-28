/**
 * The Founder control console, EXECUTED rather than grepped
 * (issue #200, integration lane).
 *
 * This suite runs the exact source the browser runs — `CONTROL_PLAN_JS`
 * through `new Function` like the freshness rule, and the whole
 * `CONTROL_CONSOLE_JS` against a minimal fake DOM and fake fetch — because
 * the property being protected is behavioural: *no control is constructed
 * unless the control API granted it, and no request ever names an actor*.
 * A label assertion would stay green if the guard behind it were wrong,
 * which is the exact defect class earlier review rounds kept finding.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLAN_JS,
  CONTROL_CONSOLE_JS,
  controlConsoleScript,
} from '../src/ui/control-console.js';
import { CONTROL_ROUTES } from '../src/live/control-api.js';
import { CLIENT_IDENTITY_KEYS } from '../src/live/auth.js';

/* ------------------------------------------------------------------ */
/* Minimal fake DOM — attribute selectors and events only              */
/* ------------------------------------------------------------------ */

class FakeElement {
  tagName: string;
  attrs = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();
  className = '';
  value = '';
  private text = '';

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  get textContent(): string {
    return this.text;
  }
  /** Assigning textContent clears children, as in the real DOM. */
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {} });
    }
  }

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }
  private matches(selector: string): boolean {
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) {
      if (!this.attrs.has(attr[1]!)) return false;
      return attr[2] === undefined || this.attrs.get(attr[1]!) === attr[2];
    }
    return this.tagName === selector;
  }
  querySelector(selector: string): FakeElement | null {
    return this.descendants().find((el) => el.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((el) => el.matches(selector));
  }
}

interface FakePage {
  document: FakeElement & { createElement(tag: string): FakeElement };
  mount(kind: 'direct-order' | 'approvals'): FakeElement;
}

function fakePage(kinds: Array<'direct-order' | 'approvals'>): FakePage {
  const body = new FakeElement('body') as FakePage['document'];
  body.createElement = (tag: string) => new FakeElement(tag);
  const mounts = new Map<string, FakeElement>();
  for (const kind of kinds) {
    const panel = new FakeElement('div');
    panel.setAttribute('data-hq-control', kind);
    const status = new FakeElement('p');
    status.setAttribute('data-hq-control-status', '');
    panel.appendChild(status);
    const mount = new FakeElement('div');
    mount.setAttribute('data-hq-control-mount', '');
    panel.appendChild(mount);
    body.appendChild(panel);
    mounts.set(kind, panel);
  }
  return { document: body, mount: (kind) => mounts.get(kind)! };
}

/* ------------------------------------------------------------------ */
/* Fake fetch                                                          */
/* ------------------------------------------------------------------ */

type Answer = { status: number; body: unknown } | 'reject';

function fakeFetch(answers: Record<string, Answer | Answer[]>) {
  const calls: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
  const remaining = new Map<string, Answer[]>(
    Object.entries(answers).map(([url, a]) => [url, Array.isArray(a) ? [...a] : [a]]),
  );
  const fetch = (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    const queue = remaining.get(url);
    const answer = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]!) : undefined;
    if (answer === undefined) {
      return Promise.resolve({ status: 404, json: () => Promise.resolve({ ok: false }) });
    }
    if (answer === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
  return { fetch, calls };
}

async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

function runConsole(document: unknown, fetch: unknown): void {
  new Function('document', 'fetch', CONTROL_CONSOLE_JS)(document, fetch);
}

function drawnControls(root: FakeElement): FakeElement[] {
  return root
    .descendants()
    .filter((el) => ['button', 'form', 'input', 'textarea', 'select'].includes(el.tagName));
}

const GRANTED_SESSION = {
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

/* ------------------------------------------------------------------ */
/* The plan — executed source, deny by default                         */
/* ------------------------------------------------------------------ */

type Plan = {
  state: string;
  message: string;
  controls: { directOrder: boolean; approve: boolean; deny: boolean };
};

const controlPlan = new Function(`${CONTROL_PLAN_JS}; return controlPlan;`)() as (
  status: number,
  body: unknown,
) => Plan;

const NO_CONTROLS = { directOrder: false, approve: false, deny: false };

describe('controlPlan grants nothing unless the control API said so', () => {
  it('draws nothing when the API is unreachable, unmounted, or the caller is signed out', () => {
    expect(controlPlan(0, null)).toMatchObject({ state: 'unreachable', controls: NO_CONTROLS });
    expect(controlPlan(404, null)).toMatchObject({ state: 'unavailable', controls: NO_CONTROLS });
    expect(controlPlan(401, null)).toMatchObject({ state: 'signed_out', controls: NO_CONTROLS });
    expect(controlPlan(401, { message: 'Sign in to JENIFY OS first.' }).message).toContain(
      'Sign in',
    );
  });

  it('treats every malformed or unexpected body as no-controls, never optimistically', () => {
    for (const body of [
      null,
      undefined,
      'ok',
      42,
      {},
      { ok: false },
      { ok: 'true' },
      { ok: true, founder: 'yes' },
      { ok: true, founder: 1 },
      { ok: true }, // founder absent
    ]) {
      const plan = controlPlan(200, body);
      expect(plan.controls, JSON.stringify(body)).toEqual(NO_CONTROLS);
      expect(plan.state, JSON.stringify(body)).not.toBe('ready');
    }
  });

  it('requires each grant to be literally true — a truthy string grants nothing', () => {
    const plan = controlPlan(200, {
      ok: true,
      founder: true,
      controls: { directOrder: 'true', approve: 1, deny: {} },
    });
    expect(plan.controls).toEqual(NO_CONTROLS);
    expect(plan.state).toBe('no_authority');
  });

  it('grants exactly what the API granted, control by control', () => {
    const approveOnly = controlPlan(200, {
      ok: true,
      founder: true,
      controls: { approve: true, deny: true, directOrder: false },
    });
    expect(approveOnly.state).toBe('ready');
    expect(approveOnly.controls).toEqual({ directOrder: false, approve: true, deny: true });

    const orderOnly = controlPlan(200, {
      ok: true,
      founder: true,
      controls: { directOrder: true },
    });
    expect(orderOnly.controls).toEqual({ directOrder: true, approve: false, deny: false });
  });

  it('explains a granted-nothing Founder session with the API’s own precise reason', () => {
    const mutationsOff = controlPlan(200, {
      ok: true,
      founder: true,
      controls: { directOrder: false, mutationsEnabled: false, trustedOriginConfigured: true },
    });
    expect(mutationsOff.message).toContain('switched off');
    const noOrigin = controlPlan(200, {
      ok: true,
      founder: true,
      controls: { directOrder: false, mutationsEnabled: true, trustedOriginConfigured: false },
    });
    expect(noOrigin.message).toContain('trusted origin');
  });
});

/* ------------------------------------------------------------------ */
/* The console, end to end against a fake DOM                          */
/* ------------------------------------------------------------------ */

describe('the console constructs controls only for a granting session', () => {
  it('draws zero controls when the session probe is unreachable, and says why', async () => {
    const page = fakePage(['direct-order', 'approvals']);
    const { fetch } = fakeFetch({ [CONTROL_ROUTES.session]: 'reject' });
    runConsole(page.document, fetch);
    await flush();
    expect(drawnControls(page.document)).toHaveLength(0);
    expect(page.mount('direct-order').querySelector('[data-hq-control-status]')!.textContent).toContain(
      'read-only',
    );
  });

  it('draws zero controls on a 404 (control plane not mounted)', async () => {
    const page = fakePage(['direct-order', 'approvals']);
    const { fetch } = fakeFetch({
      [CONTROL_ROUTES.session]: { status: 404, body: { ok: false } },
    });
    runConsole(page.document, fetch);
    await flush();
    expect(drawnControls(page.document)).toHaveLength(0);
  });

  it('draws zero controls for a signed-in non-Founder', async () => {
    const page = fakePage(['direct-order', 'approvals']);
    const { fetch, calls } = fakeFetch({
      [CONTROL_ROUTES.session]: {
        status: 200,
        body: {
          ok: true,
          authenticated: true,
          founder: false,
          reason: 'not_founder',
          message: 'This account is signed in but is not the HQ Founder.',
          controls: { directOrder: false, approve: false, deny: false },
        },
      },
    });
    runConsole(page.document, fetch);
    await flush();
    expect(drawnControls(page.document)).toHaveLength(0);
    expect(page.mount('approvals').querySelector('[data-hq-control-status]')!.textContent).toContain(
      'not the HQ Founder',
    );
    // And it never touched a write route.
    expect(calls.every((call) => call.url === CONTROL_ROUTES.session)).toBe(true);
  });

  it('draws only the granted control: an order grant draws no approval control and vice versa', async () => {
    const orderOnlyPage = fakePage(['direct-order', 'approvals']);
    const orderOnly = fakeFetch({
      [CONTROL_ROUTES.session]: {
        status: 200,
        body: { ...GRANTED_SESSION, controls: { ...GRANTED_SESSION.controls, approve: false, deny: false } },
      },
    });
    runConsole(orderOnlyPage.document, orderOnly.fetch);
    await flush();
    expect(drawnControls(orderOnlyPage.mount('direct-order')).length).toBeGreaterThan(0);
    expect(drawnControls(orderOnlyPage.mount('approvals'))).toHaveLength(0);

    const approveOnlyPage = fakePage(['direct-order', 'approvals']);
    const approveOnly = fakeFetch({
      [CONTROL_ROUTES.session]: {
        status: 200,
        body: { ...GRANTED_SESSION, controls: { ...GRANTED_SESSION.controls, directOrder: false } },
      },
      [CONTROL_ROUTES.approvals]: { status: 200, body: { ok: true, approvals: [] } },
    });
    runConsole(approveOnlyPage.document, approveOnly.fetch);
    await flush();
    expect(drawnControls(approveOnlyPage.mount('direct-order'))).toHaveLength(0);
  });
});

describe('the composer form, once granted', () => {
  async function grantedComposer() {
    const page = fakePage(['direct-order']);
    const net = fakeFetch({
      [CONTROL_ROUTES.session]: { status: 200, body: GRANTED_SESSION },
      [CONTROL_ROUTES.orders]: {
        status: 201,
        body: {
          ok: true,
          taskId: 'task-1',
          status: 'needs_approval',
          deduplicated: false,
          requiresFounderApproval: true,
          route: { requested: 'CLAUDE', resolved: 'CLAUDE', reason: 'connected' },
          actionDigest: 'abcdef0123456789abcdef0123456789',
        },
      },
    });
    runConsole(page.document, net.fetch);
    await flush();
    return { page, net };
  }

  it('offers exactly the canonical routes and a single submit control', async () => {
    const { page } = await grantedComposer();
    const mount = page.mount('direct-order');
    const options = mount.querySelectorAll('option').map((option) => option.textContent);
    expect(options).toEqual(['AUTO', 'CLAUDE', 'CODEX']);
    expect(mount.querySelectorAll('button')).toHaveLength(1);
    expect(mount.querySelectorAll('form')).toHaveLength(1);
  });

  it('submits JSON to the canonical orders route, same-origin credentials, no actor field', async () => {
    const { page, net } = await grantedComposer();
    const mount = page.mount('direct-order');
    const form = mount.querySelector('form')!;
    mount.querySelector('textarea')!.value = 'Draft the Q3 maintenance plan.';
    form.dispatch('submit');
    await flush();

    const post = net.calls.find((call) => call.url === CONTROL_ROUTES.orders)!;
    expect(post).toBeDefined();
    expect(post.init!.method).toBe('POST');
    expect(post.init!.credentials).toBe('same-origin');
    expect((post.init!.headers as Record<string, string>)['content-type']).toBe('application/json');

    const payload = JSON.parse(post.init!.body as string) as Record<string, unknown>;
    expect(payload.instruction).toBe('Draft the Q3 maintenance plan.');
    expect(['AUTO', 'CLAUDE', 'CODEX']).toContain(payload.route);
    // The load-bearing negative: the console can NEVER name an actor. This is
    // the same key list the API refuses, so the two cannot drift apart.
    for (const key of CLIENT_IDENTITY_KEYS) {
      expect(payload, key).not.toHaveProperty(key);
    }

    const result = mount.querySelector('[data-hq-control-mount]')!.descendants().at(-1)!;
    expect(result.textContent).toContain('task-1');
    expect(result.textContent).toContain('executes NOTHING until a Founder approves');
  });

  it('refuses to send an empty instruction', async () => {
    const { page, net } = await grantedComposer();
    page.mount('direct-order').querySelector('form')!.dispatch('submit');
    await flush();
    expect(net.calls.some((call) => call.url === CONTROL_ROUTES.orders)).toBe(false);
  });

  it('reports a provider-not-connected refusal with candidates, never substituting', async () => {
    const page = fakePage(['direct-order']);
    const net = fakeFetch({
      [CONTROL_ROUTES.session]: { status: 200, body: GRANTED_SESSION },
      [CONTROL_ROUTES.orders]: {
        status: 409,
        body: {
          ok: false,
          error: { code: 'provider_not_connected', message: 'CODEX is not connected here.' },
          route: [
            { provider: 'CODEX', connected: false, missingFacts: ['CODEX_CLI_PATH'] },
          ],
        },
      },
    });
    runConsole(page.document, net.fetch);
    await flush();
    const mount = page.mount('direct-order');
    mount.querySelector('textarea')!.value = 'Anything';
    mount.querySelector('form')!.dispatch('submit');
    await flush();
    const result = mount.querySelector('[data-hq-control-mount]')!.descendants().at(-1)!;
    expect(result.textContent).toContain('provider_not_connected');
    expect(result.textContent).toContain('CODEX: not connected');
    expect(result.textContent).toContain('missing: CODEX_CLI_PATH');
    expect(result.textContent).toContain('No other provider is ever substituted.');
  });
});

describe('the approvals panel, once granted', () => {
  const APPROVALS = {
    ok: true,
    generatedAt: '2026-08-28T00:00:00.000Z',
    approvals: [
      {
        taskId: 'task-a',
        capabilityId: 'hq.direct_order',
        riskClass: 'founder_gate',
        title: 'Q3 maintenance plan',
        project: 'mesob',
        createdBy: 'coo',
        createdAt: '2026-08-28T00:00:00.000Z',
        actionDigest: 'digest-a-0123456789',
        ask: 'Approve the Q3 maintenance plan order.',
        stepUpRequired: true,
        selfApproval: false,
      },
      {
        taskId: 'task-b',
        capabilityId: 'hq.direct_order',
        riskClass: 'founder_gate',
        title: 'Self-opened order',
        project: null,
        createdBy: 'founder',
        createdAt: '2026-08-28T00:00:00.000Z',
        actionDigest: 'digest-b-0123456789',
        ask: 'Approve my own order.',
        stepUpRequired: true,
        selfApproval: true,
      },
    ],
  };

  async function grantedApprovals(extra: Record<string, Answer | Answer[]> = {}) {
    const page = fakePage(['approvals']);
    const net = fakeFetch({
      [CONTROL_ROUTES.session]: { status: 200, body: GRANTED_SESSION },
      [CONTROL_ROUTES.approvals]: { status: 200, body: APPROVALS },
      ...extra,
    });
    runConsole(page.document, net.fetch);
    await flush();
    return { page, net };
  }

  it('draws Approve only where self-approval does not already refuse it', async () => {
    const { page } = await grantedApprovals();
    const cards = page.mount('approvals').querySelectorAll('[data-hq-control-mount]')[0]!.children;
    expect(cards).toHaveLength(2);
    const [normal, self] = cards as [FakeElement, FakeElement];
    expect(normal.querySelectorAll('button').map((b) => b.textContent)).toEqual([
      'Approve this exact action',
      'Deny',
    ]);
    // The self-opened card gets NO approve control, and says why.
    expect(self.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Deny']);
    const note = self.descendants().find((el) => el.textContent.includes('no-self-approval'));
    expect(note).toBeDefined();
  });

  it('approves with the exact displayed digest, optional note and step-up password — and nothing else', async () => {
    const { page, net } = await grantedApprovals({
      [CONTROL_ROUTES.approve]: { status: 200, body: { ok: true, taskId: 'task-a', status: 'queued' } },
    });
    const card = page.mount('approvals').querySelectorAll('article')[0]!;
    card.querySelectorAll('input').find((el) => el.getAttribute('type') === 'password')!.value =
      'test-password';
    card.querySelectorAll('input').find((el) => el.getAttribute('type') !== 'password')!.value =
      'Looks right.';
    card.querySelectorAll('button')[0]!.dispatch('click');
    await flush();

    const post = net.calls.find((call) => call.url === CONTROL_ROUTES.approve)!;
    expect(post).toBeDefined();
    const payload = JSON.parse(post.init!.body as string) as Record<string, unknown>;
    expect(payload).toEqual({
      taskId: 'task-a',
      expectedActionDigest: 'digest-a-0123456789',
      note: 'Looks right.',
      stepUpPassword: 'test-password',
    });
    for (const key of CLIENT_IDENTITY_KEYS) expect(payload, key).not.toHaveProperty(key);
  });

  it('refuses to deny without a reason, then denies with one', async () => {
    const { page, net } = await grantedApprovals({
      [CONTROL_ROUTES.deny]: { status: 200, body: { ok: true, taskId: 'task-a', status: 'blocked' } },
    });
    const card = page.mount('approvals').querySelectorAll('article')[0]!;
    const deny = card.querySelectorAll('button').find((b) => b.textContent === 'Deny')!;
    deny.dispatch('click');
    await flush();
    expect(net.calls.some((call) => call.url === CONTROL_ROUTES.deny)).toBe(false);

    card.querySelector('textarea')!.value = 'Wrong scope for this quarter.';
    deny.dispatch('click');
    await flush();
    const post = net.calls.find((call) => call.url === CONTROL_ROUTES.deny)!;
    const payload = JSON.parse(post.init!.body as string) as Record<string, unknown>;
    expect(payload).toEqual({
      taskId: 'task-a',
      reason: 'Wrong scope for this quarter.',
      expectedActionDigest: 'digest-a-0123456789',
    });
  });

  it('reports a rate-limited step-up as RATE LIMITED, distinct from a wrong password', async () => {
    const rateLimited = await grantedApprovals({
      [CONTROL_ROUTES.approve]: {
        status: 429,
        body: { ok: false, error: { code: 'step_up_rate_limited', message: 'Too many failed confirmation attempts.' } },
      },
    });
    const card1 = rateLimited.page.mount('approvals').querySelectorAll('article')[0]!;
    card1.querySelectorAll('button')[0]!.dispatch('click');
    await flush();
    const out1 = card1.descendants().find((el) => el.className === 'hq-live-result')!;
    expect(out1.textContent).toContain('RATE LIMITED');
    expect(out1.textContent).not.toContain('did not match');

    const wrongPassword = await grantedApprovals({
      [CONTROL_ROUTES.approve]: {
        status: 403,
        body: { ok: false, error: { code: 'step_up_failed', message: 'That password did not match.' } },
      },
    });
    const card2 = wrongPassword.page.mount('approvals').querySelectorAll('article')[0]!;
    card2.querySelectorAll('button')[0]!.dispatch('click');
    await flush();
    const out2 = card2.descendants().find((el) => el.className === 'hq-live-result')!;
    expect(out2.textContent).toContain('REFUSED (step_up_failed)');
  });
});

describe('the shipped wrapper', () => {
  it('embeds exactly the tested source', () => {
    expect(controlConsoleScript()).toContain(CONTROL_CONSOLE_JS);
    // And the tested plan is the embedded plan — one implementation.
    expect(CONTROL_CONSOLE_JS).toContain(CONTROL_PLAN_JS);
  });
});
