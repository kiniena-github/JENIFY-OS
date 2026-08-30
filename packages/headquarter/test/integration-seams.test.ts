/**
 * HOSTILE coverage for the seams created by the #219 final integration.
 *
 * Three mechanisms exist only because two independently-reviewed lanes had to
 * become one tree: #200's authority hardening (`claude/epic-pascal-14phai`,
 * head `c3092f3`) and the #221/#223/#224 Direct Order dispatch lane (head
 * `e996c15`). Each lane's own review examined its own side. Nobody had yet
 * reviewed the joins, and a join is exactly where a property gets dropped
 * silently — so each one is attacked here rather than merely exercised.
 *
 * 1. `appendSystemEvidence` — #200 made the evidence WRITER privileged because
 *    a holder can forge entries under any actor. The dispatch lane still has to
 *    record what the SYSTEM did. The narrow surface is the ACTOR, so the attack
 *    is: can it be used to write an attributed entry?
 * 2. `lookupPrincipal` — #200 deleted the public `principals` collaborator
 *    because patching it forged the Founder gate one layer down. #214's control
 *    API still needs the same registry. The attack is: does patching the
 *    replacement forge authority?
 * 3. `resolvedActorAuthentication` — #214 added an EARNED authentication marker;
 *    #200 added a runtime guard against a caller ASSERTING one. The attack is:
 *    can a caller reach the earned value through the input object?
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';
import { SYSTEM_EVIDENCE_ACTORS } from '../src/application/service.js';
import {
  isCallerAssertableActorAuthentication,
  isKnownActorAuthentication,
} from '../src/live/local-trust.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

function seamFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  fixture.principals.register({
    id: 'coo',
    displayName: 'COO',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

describe('the system evidence writer cannot become the forging surface #200 closed', () => {
  it('refuses an actor outside the reserved set', () => {
    const fx = seamFixture();
    expect(() =>
      fx.ops.appendSystemEvidence({
        // The whole point: an attributed entry under a human's name.
        actor: 'founder' as never,
        kind: 'founder_approved_everything',
        payload: {},
      }),
    ).toThrow(/reserved system evidence actor/);
  });

  it('refuses a reserved name that has been registered as a human principal', () => {
    const fx = seamFixture();
    // Defence in depth: the closed union is the primary control, but if a
    // reserved name were ever also registered as a principal, the entry would
    // become attributable to a person. It must fail closed then too.
    fx.principals.register({
      id: 'system',
      displayName: 'System',
      originateCapabilities: [],
      approvalAuthority: true,
      active: true,
    });
    expect(() =>
      fx.ops.appendSystemEvidence({ actor: 'system', kind: 'anything', payload: {} }),
    ).toThrow(/registered principal or worker/);
  });

  it('refuses a reserved name that has been registered as a worker', () => {
    const fx = seamFixture();
    const registered = fx.ops.registerExecutionWorker({
      workerId: 'hq-claude-dispatch',
      displayName: 'collision',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      founderId: 'founder',
    });
    expect(registered.ok).toBe(true);
    expect(() =>
      fx.ops.appendSystemEvidence({
        actor: 'hq-claude-dispatch',
        kind: 'anything',
        payload: {},
      }),
    ).toThrow(/registered principal or worker/);
  });

  it('writes under a reserved actor, and the chain still verifies', () => {
    const fx = seamFixture();
    const entry = fx.ops.appendSystemEvidence({
      actor: 'system',
      kind: 'direct_order_dispatch_blocked',
      payload: { provider: 'CLAUDE' },
    });
    expect(entry.actor).toBe('system');
    // `verifyChain` returns the seq of the first BAD entry, so intact is null.
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });

  it('keeps the reserved set closed to system names only', () => {
    // A future edit that adds a human-shaped id here fails this rather than
    // being noticed in review, or not.
    expect([...SYSTEM_EVIDENCE_ACTORS]).toEqual(['system', 'hq-claude-dispatch']);
  });
});

describe('the principal lookup that replaced the public registry forges nothing', () => {
  it('is a method, not the patchable collaborator #200 removed', () => {
    const fx = seamFixture();
    expect((fx.ops as unknown as Record<string, unknown>).principals).toBeUndefined();
  });

  it('cannot forge approval authority when it is replaced', () => {
    const fx = seamFixture();
    const ops = fx.ops as unknown as Record<string, unknown>;

    // Replace the read with one that says an unauthorized worker is a Founder.
    ops.lookupPrincipal = () => ({
      id: 'codex-worker',
      displayName: 'x',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });

    // Origination still resolves through `#principalOf`, so an unregistered id
    // opens nothing — the patched read lied only to whoever patched it.
    const forged = submitDirectOrder(
      fx.ops,
      { instruction: 'Approve me.', project: 'mesob', route: 'CLAUDE', requestedBy: 'codex-worker' },
      CLAUDE_ONLY,
    );
    expect(forged.ok).toBe(false);

    // And the approval gate is unmoved: a real order still cannot be approved
    // by the principal who opened it, patched read or not.
    const real = submitDirectOrder(
      fx.ops,
      { instruction: 'Draft the plan.', project: 'mesob', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    if (!real.ok) throw new Error('expected an order');
    const task = fx.ops.queue.get(real.data.task.id)!;
    expect(task.status).toBe('needs_approval');
    const selfApproved = fx.ops.approveTask({
      taskId: task.id,
      founderId: 'founder',
      expectedActionDigest: undefined as never,
    });
    expect(selfApproved.ok).toBe(false);
  });
});

describe('an earned authentication marker cannot be asserted by a caller', () => {
  it('separates the vocabulary from what a caller may claim', () => {
    // Being a real member of the union is not permission to claim it.
    expect(isKnownActorAuthentication('authenticated_os_session')).toBe(true);
    expect(isCallerAssertableActorAuthentication('authenticated_os_session')).toBe(false);
    for (const value of ['unauthenticated', 'unauthenticated_local_assertion']) {
      expect(isCallerAssertableActorAuthentication(value)).toBe(true);
    }
    expect(isCallerAssertableActorAuthentication('authenticated')).toBe(false);
  });

  it('refuses an order whose input asserts the earned marker, and queues nothing', () => {
    const fx = seamFixture();
    const result = submitDirectOrder(
      fx.ops,
      {
        instruction: 'Draft the plan.',
        project: 'mesob',
        route: 'CLAUDE',
        requestedBy: 'founder',
        // The exact upgrade the guard exists to refuse: a caller naming the
        // one value only an authenticating interface may produce.
        actorAuthentication: 'authenticated_os_session',
      },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
    expect(fx.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(fx.ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('records the earned marker when the INTERFACE supplies it, not the input', () => {
    const fx = seamFixture();
    const result = submitDirectOrder(
      fx.ops,
      { instruction: 'Draft the plan.', project: 'mesob', route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
      { resolvedActorAuthentication: 'authenticated_os_session' },
    );
    if (!result.ok) throw new Error(`expected an order: ${result.error.code}`);
    const task = fx.ops.queue.get(result.data.task.id)!;
    // It travels inside the payload the approver reads and the digest covers.
    expect(task.payload.actorAuthentication).toBe('authenticated_os_session');
  });

  it('lets the earned marker win over a weaker one the input carries', () => {
    const fx = seamFixture();
    const result = submitDirectOrder(
      fx.ops,
      {
        instruction: 'Draft the plan.',
        project: 'mesob',
        route: 'CLAUDE',
        requestedBy: 'founder',
        actorAuthentication: 'unauthenticated_local_assertion',
      },
      CLAUDE_ONLY,
      { resolvedActorAuthentication: 'authenticated_os_session' },
    );
    if (!result.ok) throw new Error('expected an order');
    const task = fx.ops.queue.get(result.data.task.id)!;
    expect(task.payload.actorAuthentication).toBe('authenticated_os_session');
  });
});
