/**
 * Hostile coverage for the actor-trust correction (issue #200, PR #201 review).
 *
 * The review found that `hq:order --as <id>` claimed the local OS session
 * authenticated the Founder while accepting a caller-supplied principal id
 * bound to nothing. The correction does not try to authenticate anybody — it
 * reclassifies the interface as trusted-local-admin/maintenance and makes the
 * system say so. These tests are the lock on that:
 *
 *   1. the vocabulary cannot express an authentication claim;
 *   2. the interface refuses to run where "local trust" is not a real claim;
 *   3. an attempted impersonation opens NOTHING when the id is not authorized;
 *   4. an attempted impersonation of an authorized principal cannot reach
 *      execution, because the asserted principal is exactly the one the
 *      canonical no-self-approval rule bars from approving it;
 *   5. no interface string claims the CLI authenticates the Founder.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  CI_ENVIRONMENT_VARIABLES,
  DEFAULT_ACTOR_AUTHENTICATION,
  LOCAL_ADMIN_ACK_FLAG,
  LOCAL_ADMIN_INTERFACE_NOTICE,
  looksLikeCi,
  resolveLocalAdminInvocation,
} from '../src/live/local-trust.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import { DIRECT_ORDER_SESSION_NOTE } from '../src/ui/render.js';
import { taskActionDigest } from '../src/operator/approvals.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

function ordersFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

describe('the invocation fails closed where local trust is not a real claim', () => {
  it('refuses without the explicit acknowledgement flag', () => {
    const result = resolveLocalAdminInvocation(['--as', 'founder'], {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('acknowledgement_missing');
  });

  it('refuses under every CI marker it knows, even WITH the flag', () => {
    for (const name of CI_ENVIRONMENT_VARIABLES) {
      const result = resolveLocalAdminInvocation([LOCAL_ADMIN_ACK_FLAG], { [name]: 'true' });
      expect(result.ok, `${name} must block the invocation`).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('ci_environment');
      expect(result.message).toContain(name);
    }
  });

  it('has no override: nothing in the environment can re-enable a CI run', () => {
    const result = resolveLocalAdminInvocation([LOCAL_ADMIN_ACK_FLAG], {
      CI: 'true',
      // The kind of variable an impatient script would reach for.
      HQ_LOCAL_ADMIN_OVERRIDE: 'true',
      HQ_FORCE: '1',
      FORCE: '1',
    });
    expect(result.ok).toBe(false);
  });

  it('does not treat an explicitly falsy CI marker as CI', () => {
    for (const value of ['', 'false', '0', '  ']) {
      expect(looksLikeCi({ CI: value })).toBeNull();
    }
    expect(looksLikeCi({ CI: 'true' })).toBe('CI');
  });

  it('admits an acknowledged workstation invocation', () => {
    expect(resolveLocalAdminInvocation([LOCAL_ADMIN_ACK_FLAG, '--as', 'founder'], {}).ok).toBe(true);
  });
});

describe('the vocabulary cannot express an authentication claim', () => {
  it('defaults to the weakest value when a caller says nothing', () => {
    expect(DEFAULT_ACTOR_AUTHENTICATION).toBe('unauthenticated');
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.task.payload).toMatchObject({ actorAuthentication: 'unauthenticated' });
  });

  it('records the local assertion when the CLI declares one, and never more than that', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    if (!result.ok) throw new Error('expected ok');
    const recorded = (result.data.task.payload as Record<string, unknown>).actorAuthentication;
    expect(recorded).toBe('unauthenticated_local_assertion');
    // Every value the type admits says how little is known. If a future change
    // adds one that claims authentication, this assertion is where it surfaces.
    expect(String(recorded).startsWith('unauthenticated')).toBe(true);
  });

  it('binds the assertion into the action digest, so it cannot be edited away', () => {
    const { ops } = ordersFixture();
    const asserted = submitDirectOrder(
      ops,
      { ...ORDER, actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    const silent = submitDirectOrder(
      ops,
      { ...ORDER, instruction: `${ORDER.instruction} (second)` },
      CLAUDE_ONLY,
    );
    if (!asserted.ok || !silent.ok) throw new Error('expected both to succeed');
    expect(taskActionDigest(asserted.data.task)).not.toBe(taskActionDigest(silent.data.task));
  });
});

describe('an impersonated assertion is contained by deny-by-default', () => {
  it('opens nothing when the asserted id is not a registered principal', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, requestedBy: 'founder ', actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    // A near-miss id is not a near-miss authorization: it is simply unknown.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unknown_principal');
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('opens nothing when the asserted id is a real human without this grant', () => {
    // 'coo' genuinely exists AND holds approval authority — the most valuable
    // id to impersonate — but was granted no origination at all.
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, requestedBy: 'coo', actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('opens nothing when the asserted id is an inactive principal', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, requestedBy: 'former-cto', actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('opens nothing when the asserted id is a WORKER borrowed as a human', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, requestedBy: 'claude', actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});

describe('an impersonated assertion cannot reach execution', () => {
  it('cannot approve its own order: the asserted principal is the barred one', () => {
    const { ops } = ordersFixture();
    const created = submitDirectOrder(
      ops,
      { ...ORDER, actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error('expected ok');
    const task = created.data.task;
    expect(task.status).toBe('needs_approval');

    // The whole attack: assert `founder`, then try to approve as `founder`.
    const approved = ops.approveTask({
      taskId: task.id,
      founderId: 'founder',
      expectedActionDigest: taskActionDigest(task),
    });
    expect(approved.ok).toBe(false);
    expect(ops.queue.get(task.id)?.status).toBe('needs_approval');
  });

  it('leaves the decision with a second, genuinely present human', () => {
    // Where the real control sits, stated as a test rather than as prose: an
    // asserted order becomes executable only when a DIFFERENT approval-
    // authorized human decides it, seeing the recorded assertion.
    const { ops } = ordersFixture();
    const created = submitDirectOrder(
      ops,
      { ...ORDER, actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error('expected ok');
    const task = created.data.task;

    const approved = ops.approveTask({
      taskId: task.id,
      founderId: 'coo',
      expectedActionDigest: taskActionDigest(task),
    });
    expect(approved.ok).toBe(true);
    // And what they approved carries the assertion, verbatim.
    expect(ops.queue.get(task.id)?.payload).toMatchObject({
      actorAuthentication: 'unauthenticated_local_assertion',
    });
  });

  it('refuses an approval whose digest predates the recorded assertion', () => {
    // A digest captured from an order WITHOUT the marker must not approve one
    // WITH it — the marker is part of the action, not decoration beside it.
    const { ops } = ordersFixture();
    const created = submitDirectOrder(
      ops,
      { ...ORDER, actorAuthentication: 'unauthenticated_local_assertion' },
      CLAUDE_ONLY,
    );
    if (!created.ok) throw new Error('expected ok');
    const task = created.data.task;
    const forged = taskActionDigest({
      ...task,
      payload: { ...(task.payload as Record<string, unknown>), actorAuthentication: 'unauthenticated' },
    });
    const approved = ops.approveTask({
      taskId: task.id,
      founderId: 'coo',
      expectedActionDigest: forged,
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) throw new Error('unreachable');
    expect(approved.error.code).toBe('action_digest_mismatch');
    expect(ops.queue.get(task.id)?.status).toBe('needs_approval');
  });
});

describe('no interface string claims the CLI authenticates the Founder', () => {
  const strings = [LOCAL_ADMIN_INTERFACE_NOTICE, DIRECT_ORDER_SESSION_NOTE];

  it('never repeats the corrected overclaim', () => {
    for (const text of strings) {
      expect(text).not.toContain('OS session is the authentication');
      expect(text.toLowerCase()).not.toContain('the founder’s own os session');
    }
  });

  it('states the CLI classification, now next to the real browser boundary', () => {
    // The browser boundary exists since the Founder decision of 2026-08-28,
    // so the old "HQ is NOT fully Founder-operable from a browser" claim is
    // itself the overclaim now — of the wrong kind. What must survive is the
    // CLI's honest classification: a maintenance interface that asserts a
    // principal id and authenticates nobody.
    expect(LOCAL_ADMIN_INTERFACE_NOTICE).toContain('TRUSTED-LOCAL-ADMIN');
    expect(LOCAL_ADMIN_INTERFACE_NOTICE).toContain('does not authenticate');
    expect(DIRECT_ORDER_SESSION_NOTE.toLowerCase()).toContain('trusted-local-admin');
    expect(DIRECT_ORDER_SESSION_NOTE).toContain('authenticates nobody');
    // And the browser path is described as session-gated, never as open.
    expect(DIRECT_ORDER_SESSION_NOTE).toContain('authenticated HQ control API');
    expect(DIRECT_ORDER_SESSION_NOTE).toContain('never sends an identity');
  });
});
