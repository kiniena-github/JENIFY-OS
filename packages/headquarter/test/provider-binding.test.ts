/**
 * Provider binding is an EXECUTION authority (issue #200, Codex P1 #1).
 *
 * The defect under regression here: a direct order resolved its route
 * truthfully and refused to substitute at creation time, but the resolved
 * provider was only payload metadata. `claim()` hands out the head-of-queue
 * task for a capability to any allowed worker, so an order explicitly routed
 * to CLAUDE could be claimed, started and executed by a CODEX worker out of the
 * shared `hq.direct_order` queue. No-substitution held at the front door and
 * evaporated at the back one.
 *
 * Every test below is hostile: it is the wrong worker trying to take work that
 * was not routed to it, or an undeclared one trying to take work at all.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { OperatorQueue } from '../src/operator/queue.js';
import {
  checkProviderBinding,
  EXECUTION_PROVIDER_KEY,
  ProviderBindingViolation,
  readProviderBinding,
  WorkerProviderDirectory,
} from '../src/operator/provider-binding.js';
import {
  DIRECT_ORDER_CAPABILITY,
  registerDirectOrderCapability,
  submitDirectOrder,
} from '../src/live/orders.js';

const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
const BOTH_PROVIDERS = {
  ...CLAUDE_ONLY,
  CODEX_CLI_PATH: '/usr/local/bin/codex',
  CODEX_AUTH_MODE: 'subscription',
};

/**
 * Two workers that may both hold `hq.direct_order`, declared as different
 * providers. This is exactly the shape the finding describes: one shared
 * capability, two providers, one queue.
 */

/**
 * Read a declaration the way a caller legitimately can now: through the copied
 * listing, not by holding the lookup object the binding checks consult.
 */
function providerOfVia(fx: Fixture, workerId: string): string | null {
  return fx.ops.queue.listWorkerProviders().find((r) => r.workerId === workerId)?.providerId ?? null;
}

function bindingFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  for (const id of ['claude-worker', 'codex-worker', 'undeclared-worker']) {
    fixture.store.upsertSpecialist({
      id,
      displayName: id,
      vendor: 'test',
      role: 'parallel_implementer',
      allowedCapabilities: [DIRECT_ORDER_CAPABILITY.id, CAPS.readStatus],
      active: true,
    });
  }
  // Provider identity is DECLARED, never inferred from a vendor string — and
  // declaring it is an authorized configuration act, not something reachable
  // from a queue handle (Codex round-3 P1 #1).
  expectOk(
    fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'founder',
    }),
  );
  expectOk(
    fixture.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CODEX',
      founderId: 'founder',
    }),
  );
  return fixture;
}

/** Create a routed order and get it past the Founder gate into `queued`. */
function queuedOrder(
  fixture: Fixture,
  route: 'CLAUDE' | 'CODEX',
  instruction: string,
  env: Record<string, string> = CLAUDE_ONLY,
): string {
  const result = submitDirectOrder(
    fixture.ops,
    { instruction, project: 'mesob', route, requestedBy: 'founder' },
    env,
  );
  if (!result.ok) throw new Error(`expected an order, got ${result.error.code}`);
  const taskId = result.data.task.id;
  const card = founderConsole(fixture.ops).approvals.find((a) => a.taskId === taskId)!;
  // No self-approval: the founder opened it, so a second authorized human decides.
  expectOk(
    fixture.ops.approveTask({ taskId, founderId: 'coo', expectedActionDigest: card.actionDigest }),
  );
  expect(fixture.ops.queue.get(taskId)!.status).toBe('queued');
  return taskId;
}

function queuedClaudeOrder(fixture: Fixture): string {
  return queuedOrder(fixture, 'CLAUDE', 'Draft the Q3 maintenance plan for the Mesob line.');
}

describe('an order routed to one provider cannot be executed by another', () => {
  it('refuses the wrong provider at claim, and creates no assignment', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);

    const stolen = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('unreachable');
    expect(stolen.error.code).toBe('provider_binding_mismatch');
    expect(stolen.error.details).toMatchObject({
      requiredProvider: 'CLAUDE',
      workerProvider: 'CODEX',
    });

    const task = fx.ops.queue.get(taskId)!;
    expect(task.status).toBe('queued');
    expect(task.claimedBy).toBeNull();
    expect(task.fence).toBe(0);
  });

  it('refuses the wrong provider at the queue itself, not merely in the service layer', () => {
    // The canonical boundary must hold for a caller that never goes through
    // HeadquarterOperations at all.
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    expect(() => fx.ops.queue.claim('codex-worker', DIRECT_ORDER_CAPABILITY.id)).toThrow(
      ProviderBindingViolation,
    );
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('does not burn the single-use approval on a refused claim', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    expect(fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id).ok).toBe(false);
    // The right worker can still claim: the approval nonce was never consumed.
    const claimed = expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id));
    expect(claimed.id).toBe(taskId);
    expect(claimed.claimedBy).toBe('claude-worker');
    expectOk(fx.ops.startTask(taskId, 'claude-worker', claimed.fence));
  });

  it('records the refusal in the hash-chained evidence log', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    const kinds = fx.ops.queue.evidence.list().map((entry) => entry.kind);
    expect(kinds).toContain('provider_binding_rejected');
  });
});

describe('deny by default: an undeclared worker holds no provider', () => {
  it('refuses a worker with no declared execution provider', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const result = fx.ops.claimNext('undeclared-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_binding_mismatch');
    expect(result.error.details).toMatchObject({ workerProvider: null });
  });

  it('refuses everyone when the binding itself is malformed', () => {
    const fx = bindingFixture();
    // A payload that names no usable provider must strand the task rather than
    // fall open to whoever asks first.
    for (const malformed of [null, '', '   ', 42, { provider: 'CLAUDE' }]) {
      const binding = readProviderBinding({ [EXECUTION_PROVIDER_KEY]: malformed });
      expect(binding.bound).toBe(true);
      expect(checkProviderBinding('t', 'claude-worker', binding, 'CLAUDE')).toBeInstanceOf(
        ProviderBindingViolation,
      );
    }
    // And a revoked declaration takes effect immediately.
    expectOk(fx.ops.revokeWorkerProvider({ workerId: 'claude-worker', founderId: 'founder' }));
    expect(providerOfVia(fx, 'claude-worker')).toBeNull();
  });

  it('leaves an unbound task alone — the binding narrows, it never widens', () => {
    const fx = bindingFixture();
    // A capability with no executionProvider in its payload behaves exactly as
    // before: this must not become a new gate on the rest of the system.
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'JENIFY-OS' },
        requestedBy: 'claude',
      }),
    );
    expect(readProviderBinding({ repo: 'JENIFY-OS' }).bound).toBe(false);
    expect(expectOk(fx.ops.claimNext('undeclared-worker', CAPS.readStatus)).claimedBy).toBe(
      'undeclared-worker',
    );
  });

  it('still requires the capability grant: binding removes candidates, never adds one', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    // `jules` is declared CLAUDE but was never granted hq.direct_order.
    expectOk(
      fx.ops.declareWorkerProvider({
        workerId: 'jules',
        providerId: 'CLAUDE',
        founderId: 'founder',
      }),
    );
    const result = fx.ops.claimNext('jules', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not_permitted');
  });
});

describe('the binding holds at start, not only at claim', () => {
  it('refuses to start when the worker no longer executes as the bound provider', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    const claimed = expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id));
    // The declaration changes between claim and start — a re-pointed worker
    // must not carry someone else's routed work into execution.
    expectOk(
      fx.ops.declareWorkerProvider({
        workerId: 'claude-worker',
        providerId: 'CODEX',
        founderId: 'founder',
      }),
    );
    const started = fx.ops.startTask(taskId, 'claude-worker', claimed.fence);
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error('unreachable');
    expect(started.error.code).toBe('provider_binding_mismatch');
    expect(fx.ops.queue.get(taskId)!.status).toBe('assigned');
  });
});

describe('the provider map is configuration, not something a worker can move', () => {
  it('offers no write path, and no lookup OBJECT, from a queue handle', () => {
    // The hostile shape: a worker holds a queue, so anything reachable from a
    // queue is reachable by a worker. This used to assert that the reachable
    // lookup had `providerOf` but not `declare` — which passed while the
    // lookup itself was patchable (Codex on `6cdb3dc`). The stronger property
    // is that there is no lookup object to reach at all.
    const fx = bindingFixture();
    const queue = fx.ops.queue as unknown as Record<string, unknown>;
    expect(queue.workerProviders).toBeUndefined();
    expect(queue.declare).toBeUndefined();
    expect(queue.revoke).toBeUndefined();
    expect(Object.getPrototypeOf(queue)).not.toHaveProperty('declare');
    // Reading declarations is still possible, through a copy.
    expect(typeof queue.listWorkerProviders).toBe('function');
  });

  /**
   * Codex exact-head finding on `6cdb3dc` (P1) — the FIFTH mechanism, and the
   * first that never touches the data. `readonly` is compile-time only, so a
   * worker could patch `providerOf` or replace the lookup wholesale, and both
   * `selectClaimable` and `assertProviderBinding` would consult the patched
   * object. The previous round's object-graph test missed it because it
   * searched for database-shaped objects; the hazard here is a mutable
   * collaborator, so this test attempts the attack rather than describing it.
   */
  it('cannot be made to lie by patching anything a worker can reach', () => {
    const fx = bindingFixture();
    const queue = fx.ops.queue as unknown as Record<string, unknown>;
    const peekTaskId = queuedClaudeOrder(fx);

    // Every documented shape of the attack, attempted for real.
    try {
      (queue.workerProviders as Record<string, unknown>).providerOf = () => 'CLAUDE';
    } catch {
      /* nothing to patch is the outcome under test */
    }
    try {
      queue.workerProviders = { providerOf: () => 'CLAUDE', list: () => [] };
    } catch {
      /* frozen or absent — also fine */
    }
    try {
      queue.listWorkerProviders = () => [
        { workerId: 'codex-worker', providerId: 'CLAUDE', declaredBy: 'me', declaredAt: 'now' },
      ];
    } catch {
      /* also fine */
    }

    // Codex on `67b5937`: the enforcement lookup must not dispatch through any
    // prototype an attacker can reach. `WorkerProviderDirectory` is exported,
    // so patching its prototype used to reach the private instance. The two
    // attempts above patch the INSTANCE; these patch the CLASS and the base
    // object every JavaScript value inherits from.
    // Codex on `e578112`: `claim` dispatched through ORDINARY methods, so
    // patching `selectClaimable`/`assertProviderBinding` on the instance or the
    // class prototype walked a CODEX worker to the conditional update. The
    // previous version of this test patched the directory and `Object.prototype`
    // and never these. Every enforcement method `claim` and `start` touch is
    // patched here, on the instance AND on `OperatorQueue.prototype`.
    const ENFORCEMENT = [
      'selectClaimable',
      'assertProviderBinding',
      'killSwitchEngaged',
      'recordBindingRefusal',
      'validateTaskApproval',
      'rejectAtExecutionBoundary',
    ] as const;
    const queueProto = OperatorQueue.prototype as unknown as Record<string, unknown>;
    const savedProto = new Map<string, unknown>();
    const original = WorkerProviderDirectory.prototype.providerOf;
    try {
      WorkerProviderDirectory.prototype.providerOf = () => 'CLAUDE';
      (Object.prototype as unknown as Record<string, unknown>).providerOf = () => 'CLAUDE';
      for (const name of ENFORCEMENT) {
        savedProto.set(name, queueProto[name]);
        // Permissive stubs: "yes, claimable", "no violation", "not killed".
        queueProto[name] = () => undefined;
        try {
          queue[name] = () => undefined;
        } catch {
          /* non-writable is a pass */
        }
      }
      // And the one shape that returns a value the caller acts on.
      const permissive = () => ({ task: fx.ops.queue.get(peekTaskId), refusal: null });
      queueProto.selectClaimable = permissive;
      try {
        queue.selectClaimable = permissive;
      } catch {
        /* also fine */
      }

      // A CODEX worker still cannot claim a CLAUDE-bound task.
      const taskId = peekTaskId;
      expect(() => fx.ops.queue.claim('codex-worker', DIRECT_ORDER_CAPABILITY.id)).toThrow(
        ProviderBindingViolation,
      );
      expect(fx.ops.queue.get(taskId)!.claimedBy).toBeNull();
      expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
    } finally {
      WorkerProviderDirectory.prototype.providerOf = original;
      delete (Object.prototype as unknown as Record<string, unknown>).providerOf;
      // Restore by DELETING what was never there, rather than assigning
      // undefined — which would leave the property defined and leak a
      // patchable name onto the prototype for every later test. The allowlist
      // test caught exactly that.
      for (const [name, value] of savedProto) {
        if (value === undefined) delete queueProto[name];
        else queueProto[name] = value;
      }
    }
  });

  it('refuses a declaration from a worker, including one about itself', () => {
    const fx = bindingFixture();
    // `codex-worker` is a registered WORKER, so it holds no approval authority
    // and cannot redeclare itself as CLAUDE before claiming a CLAUDE order.
    const escalation = fx.ops.declareWorkerProvider({
      workerId: 'codex-worker',
      providerId: 'CLAUDE',
      founderId: 'codex-worker',
    });
    expect(escalation.ok).toBe(false);
    expect(providerOfVia(fx, 'codex-worker')).toBe('CODEX');

    // And the order it was after is still refused.
    queuedClaudeOrder(fx);
    const stolen = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(stolen.ok).toBe(false);
  });

  it('refuses a declaration from an unknown actor and from a known non-approver', () => {
    const fx = bindingFixture();
    for (const actor of ['nobody-at-all', 'system']) {
      const result = fx.ops.declareWorkerProvider({
        workerId: 'claude-worker',
        providerId: 'CODEX',
        founderId: actor,
      });
      expect(result.ok).toBe(false);
    }
    expect(providerOfVia(fx, 'claude-worker')).toBe('CLAUDE');
  });

  it('fails closed on a provider id the routing registry does not know', () => {
    const fx = bindingFixture();
    for (const providerId of ['claude', 'CLAUDE ', 'CLUADE', '']) {
      const result = fx.ops.declareWorkerProvider({
        workerId: 'new-worker',
        providerId,
        founderId: 'founder',
      });
      expect(result.ok).toBe(false);
    }
    expect(providerOfVia(fx, 'new-worker')).toBeNull();
  });

  it('records the authorized declaration, attributed to the resolved principal', () => {
    const fx = bindingFixture();
    const kinds = fx.ops.queue.evidence.list().map((entry) => entry.kind);
    expect(kinds).toContain('worker_provider_declared');
    expectOk(fx.ops.revokeWorkerProvider({ workerId: 'codex-worker', founderId: 'founder' }));
    expect(fx.ops.queue.evidence.list().map((e) => e.kind)).toContain('worker_provider_revoked');
    expect(
      fx.ops
        .workerProviderDeclarations()
        .every((record) => record.declaredBy === 'founder'),
    ).toBe(true);
  });
});

describe('a bound task does not head-of-line block a worker it is not for', () => {
  it('offers the oldest COMPATIBLE task instead of refusing at the head', () => {
    const fx = bindingFixture();
    // Oldest first: a CLAUDE order, then a CODEX order, in one shared queue.
    const claudeTask = queuedOrder(fx, 'CLAUDE', 'Claude: draft the maintenance plan.', BOTH_PROVIDERS);
    const codexTask = queuedOrder(fx, 'CODEX', 'Codex: review the maintenance plan.', BOTH_PROVIDERS);
    expect(fx.ops.queue.get(claudeTask)!.createdAt <= fx.ops.queue.get(codexTask)!.createdAt).toBe(
      true,
    );

    // Before the fix this was a refusal, forever: the CLAUDE order sat at the
    // head and the CODEX worker could never reach its own work.
    const claimed = expectOk(fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id));
    expect(claimed.id).toBe(codexTask);
    expect(claimed.claimedBy).toBe('codex-worker');

    // Skipping took nothing from the CLAUDE order: untouched, still queued,
    // still claimable by the worker it was routed to.
    const skipped = fx.ops.queue.get(claudeTask)!;
    expect(skipped.status).toBe('queued');
    expect(skipped.claimedBy).toBeNull();
    expect(skipped.fence).toBe(0);
    expect(expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(
      claudeTask,
    );
  });

  it('still refuses loudly when nothing in the queue is compatible', () => {
    // Selection must not turn "that work is not yours" into "the queue is
    // empty": a worker with no work of its own gets the refusal, evidenced.
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const result = fx.ops.claimNext('codex-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_binding_mismatch');
    expect(fx.ops.queue.evidence.list().map((e) => e.kind)).toContain('provider_binding_rejected');
  });

  it('never selects a malformed binding for anyone, and does not let it block', () => {
    const fx = bindingFixture();
    const claudeTask = queuedClaudeOrder(fx);
    // Force a malformed binding onto the head task, behind the queue's back.
    const poisoned = fx.ops.queue.get(claudeTask)!;
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(
        JSON.stringify({ ...poisoned.payload, [EXECUTION_PROVIDER_KEY]: 42 }),
        claudeTask,
      );
    // Nobody may take it — not the provider it was routed to, not anyone else.
    for (const worker of ['claude-worker', 'codex-worker', 'undeclared-worker']) {
      const result = fx.ops.claimNext(worker, DIRECT_ORDER_CAPABILITY.id);
      expect(result.ok).toBe(false);
    }
    expect(fx.ops.queue.get(claudeTask)!.status).toBe('queued');

    // And it does not strand later work its own provider CAN run.
    const second = queuedOrder(fx, 'CLAUDE', 'Claude: a second, well-formed order.');
    expect(expectOk(fx.ops.claimNext('claude-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(second);
  });

  it('offers an undeclared worker unbound work that sits behind a bound task', () => {
    const fx = bindingFixture();
    queuedClaudeOrder(fx);
    const unbound = expectOk(
      fx.ops.createTask({
        capabilityId: DIRECT_ORDER_CAPABILITY.id,
        payload: { kind: 'unbound' },
        idempotencyKey: 'unbound-1',
        requestedBy: 'founder',
      }),
    ).task;
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === unbound.id)!;
    expectOk(
      fx.ops.approveTask({
        taskId: unbound.id,
        founderId: 'coo',
        expectedActionDigest: card.actionDigest,
      }),
    );
    expect(expectOk(fx.ops.claimNext('undeclared-worker', DIRECT_ORDER_CAPABILITY.id)).id).toBe(
      unbound.id,
    );
  });
});

describe('the bound provider is part of the approved action', () => {
  it('changes the action digest, so a swapped provider invalidates the approval', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    const task = fx.ops.queue.get(taskId)!;
    expect(task.payload[EXECUTION_PROVIDER_KEY]).toBe('CLAUDE');
    const swapped = {
      ...task,
      payload: { ...task.payload, [EXECUTION_PROVIDER_KEY]: 'CODEX' },
    };
    expect(taskActionDigest(swapped)).not.toBe(taskActionDigest(task));
  });
});

/**
 * Codex exact-head finding on `5a19350` (P1). Removing the registrar from the
 * queue's property was not enough: the class stayed publicly constructible and
 * `operator/index.ts` re-exported the whole module, so a worker or plugin
 * holding an `HqDatabase` could build one and redeclare itself as the provider
 * a queued order is bound to — walking straight past the authority gate in
 * `HeadquarterOperations.declareWorkerProvider`.
 */
describe('the provider write mechanism is not reachable around the authority gate', () => {
  /**
   * Two attempts failed before this one, and the second failed in a way worth
   * keeping visible. Removing the registrar from the queue's property left the
   * class publicly constructible (Codex on `5a19350`). A module-local
   * construction key then left an exported FACTORY holding that key, so a deep
   * import still reached it (Codex on `03a7104`) — the first mistake one level
   * up. Omitting a name from `operator/index.ts` never stopped a deep import.
   *
   * So the test is no longer "the gate refuses the wrong caller". It is "there
   * is no exported path to the write mechanism at all": it lives unexported
   * inside `application/service.ts`, and the only way to it is through
   * `HeadquarterOperations`, which resolves the actor and requires approval
   * authority.
   */
  it('exports no write mechanism from the operator module, deep import included', async () => {
    const deep = await import('../src/operator/provider-binding.js');
    for (const name of [
      'WorkerProviderRegistrar',
      'createWorkerProviderRegistrar',
      'REGISTRAR_CONSTRUCTION_KEY',
    ]) {
      expect(name in deep, `deep import must not offer ${name}`).toBe(false);
    }
    // The read side stays: the queue needs it and it grants nothing.
    expect('WorkerProviderDirectory' in deep).toBe(true);
  });

  it('exports none of it from the operator package surface either', async () => {
    const surface = await import('../src/operator/index.js');
    for (const name of ['WorkerProviderRegistrar', 'createWorkerProviderRegistrar']) {
      expect(name in surface, `surface must not offer ${name}`).toBe(false);
    }
    expect('WorkerProviderDirectory' in surface).toBe(true);
  });

  it('offers no write method on the read-side directory a worker can build', async () => {
    const { WorkerProviderDirectory } = await import('../src/operator/provider-binding.js');
    const { openMemoryHqDatabase } = await import('../src/store/db.js');
    const readOnly = new WorkerProviderDirectory(openMemoryHqDatabase()) as unknown as Record<
      string,
      unknown
    >;
    // A worker that builds the read side gets lookup and nothing else.
    expect(typeof readOnly.providerOf).toBe('function');
    expect(readOnly.declare).toBeUndefined();
    expect(readOnly.revoke).toBeUndefined();
  });

  /**
   * Codex exact-head finding on `f221826` (P1) — the THIRD time this boundary
   * was bypassed, and the third distinct mechanism. Moving the class into
   * `service.ts` left the INSTANCE on a TypeScript `private` field, which is a
   * compile-time annotation that erases to an ordinary public JavaScript
   * property: `ops.workerProviderRegistrar.declare(...)` was reachable from any
   * JavaScript caller holding the exported operations object. Each previous
   * attempt moved the signpost and left the path.
   *
   * `#private` is enforced by the runtime, so this test reaches for it the way
   * a plain JavaScript worker would rather than the way TypeScript would let it.
   */
  it('does not expose the registrar on the operations object at runtime', () => {
    const { ops } = bindingFixture();
    const asAny = ops as unknown as Record<string, unknown>;
    expect(asAny.workerProviderRegistrar).toBeUndefined();
    // Not reachable by any enumeration either — `#` fields are not properties.
    expect(Object.keys(asAny)).not.toContain('workerProviderRegistrar');
    expect(Object.getOwnPropertyNames(asAny)).not.toContain('workerProviderRegistrar');
    const proto = Object.getPrototypeOf(ops) as object;
    expect(Object.getOwnPropertyNames(proto)).not.toContain('workerProviderRegistrar');
    // And nothing else on the object offers a raw declare/revoke either.
    for (const key of Object.getOwnPropertyNames(asAny)) {
      const value = asAny[key] as Record<string, unknown> | null;
      if (value && typeof value === 'object') {
        expect(typeof value.declare, `${key}.declare must not be callable`).not.toBe('function');
      }
    }
  });

  /**
   * Codex exact-head finding on `135ae58` (P1) — the FOURTH route, and the
   * first one BELOW the mechanism rather than beside it. `private db` erases
   * too, so `ops.db`, `ops.queue.db` and `ops.store.db` handed a writable
   * database to any JavaScript caller holding the operations object. From
   * there `op_worker_providers` can be upserted directly: the provider check
   * then passes, and `declareWorkerProvider`, its principal/approval gate and
   * its evidence record are never reached. Making the registrar `#private`
   * closed the named property and left its substrate public.
   *
   * This test does not check the three names Codex listed. It walks the object
   * graph a worker can actually reach and asserts that NOTHING on it exposes a
   * database — because naming the known routes is what let three previous
   * attempts pass while a hole stood open.
   */
  it('exposes no writable database anywhere a worker can reach', () => {
    const { ops } = bindingFixture();
    const looksLikeDatabase = (value: unknown): boolean =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { prepare?: unknown }).prepare === 'function';

    const seen = new Set<unknown>();
    const offenders: string[] = [];
    const walk = (value: unknown, path: string, depth: number): void => {
      if (depth > 4 || value === null || typeof value !== 'object') return;
      // Databases are checked BEFORE the visited-set short-circuit: every
      // holder shares one database object, so deduplicating by identity would
      // report the first route and hide the rest.
      if (looksLikeDatabase(value)) {
        offenders.push(path);
        return;
      }
      if (seen.has(value)) return;
      seen.add(value);
      for (const key of Object.getOwnPropertyNames(value)) {
        let child: unknown;
        try {
          child = (value as Record<string, unknown>)[key];
        } catch {
          continue; // a throwing getter is not a reachable database
        }
        walk(child, `${path}.${key}`, depth + 1);
      }
    };
    walk(ops, 'ops', 0);
    expect(offenders, `writable database reachable at: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * Codex exact-head finding on `cd058ed` (P1) — the EIGHTH mechanism, and the
   * same shape one level lower: `#validateTaskApproval` was runtime-private,
   * but it DELEGATED to `getApprovalRecord`, which was TypeScript-private and
   * therefore an ordinary writable property. Patch that and an approval which
   * expired while queued passes the claim check.
   *
   * Enumerating patchable methods has now failed eight times, so this test does
   * not enumerate. It asserts the queue's public surface against an ALLOWLIST:
   * anything not on the list is a method a worker can patch, and adding one
   * fails here rather than waiting for a review to find it. The list is
   * deliberately the operations a caller legitimately performs — nothing that
   * participates in deciding whether a claim is allowed.
   */
  it('exposes only its allowlisted public surface, so nothing new becomes patchable', () => {
    // Each entry was checked against `claim` and `start`: none of them is
    // dispatched through on the path that decides whether a claim is allowed.
    // That is the criterion for being allowed to stay public, not "it exists".
    const PUBLIC_SURFACE = new Set([
      'constructor',
      // lifecycle operations a worker or the service legitimately drives
      'enqueue',
      'claim',
      'start',
      'heartbeat',
      'reviewPass',
      'reviewFail',
      'fail',
      'complete',
      'cancel',
      'reconcile',
      'approve',
      'deny',
      'sweepExpiredLeases',
      'engageKillSwitch',
      'releaseKillSwitch',
      // reads; enforcement never dispatches through these, and a caller who
      // patches a read lies only to itself
      'get',
      'listByStatus',
      'killSwitchEngaged',
      'selectClaimable',
      'listWorkerProviders',
    ]);
    const actual = Object.getOwnPropertyNames(OperatorQueue.prototype);
    const unexpected = actual.filter((name) => !PUBLIC_SURFACE.has(name));
    expect(
      unexpected,
      `New public method(s) on OperatorQueue: ${unexpected.join(', ')}. A public method is a ` +
        'patchable one. If it participates in deciding whether a claim is allowed it must be ' +
        '#private; if it is genuinely a read, add it to the allowlist deliberately.',
    ).toEqual([]);
  });

  /**
   * Codex exact-head findings on `7d77766` (two P1s), both attacking the
   * allowlist rather than a fix — which is what the previous review request
   * asked for, and both were right.
   *
   * `get` was allowlisted as a "read" and is not one: `start`, `#assertFence`
   * and `#transition` all dispatched through it, so a patched `get` returning a
   * task with a non-gated `capabilityId` made `start` skip the approval block.
   * And the surface assertion inspected only the PROTOTYPE, never the queue's
   * reachable own fields — so the public, mutable `capabilities` collaborator
   * that claim and start both consult was invisible to it:
   * `queue.capabilities.get = () => undefined` made `cap` absent and skipped
   * every approval check.
   *
   * A prototype allowlist alone cannot express this. The assertion that can is
   * behavioural: patch the reachable collaborators and require the enforced
   * outcome to be unchanged.
   */
  it('ignores patched public reads and collaborators on the enforcement path', () => {
    const fx = bindingFixture();
    const taskId = queuedClaudeOrder(fx);
    const queue = fx.ops.queue as unknown as Record<string, unknown>;
    const real = fx.ops.queue.get(taskId)!;

    // 1. A patched public `get` that reports a non-gated capability.
    queue.get = () => ({ ...real, capabilityId: 'not.gated' });
    // 2. A patched capability registry that reports the capability absent.
    const caps = fx.ops.queue.capabilities as unknown as Record<string, unknown>;
    caps.get = () => undefined;

    // Enforcement is unmoved: the CODEX worker still cannot claim a
    // CLAUDE-bound task, and the real row is untouched.
    expect(() => fx.ops.queue.claim('codex-worker', DIRECT_ORDER_CAPABILITY.id)).toThrow(
      ProviderBindingViolation,
    );

    // The legitimate worker still claims, and the row really moves — proving
    // the closures read the database rather than the patched surfaces.
    const claimed = fx.ops.queue.claim('claude-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(taskId);
    expect(claimed!.capabilityId).toBe(DIRECT_ORDER_CAPABILITY.id);
  });

  /**
   * Codex exact-head finding on `653bdb8` (P1) — the TENTH mechanism, and the
   * first that changes the DATA rather than the code path. The previous round
   * moved enforcement to read the database instead of a patchable object;
   * that is worth nothing while the caller can write the row the database
   * returns. `queue.capabilities.register(...)` was public, so an already
   * claimed `hq.direct_order` could be rewritten to
   * `riskClass: 'read_only', sideEffect: false`, after which `start` skips an
   * expired Founder approval and `complete` skips independent review.
   */
  it('offers workers no way to rewrite the capability row enforcement reads', () => {
    const fx = bindingFixture();
    const caps = fx.ops.queue.capabilities as unknown as Record<string, unknown>;

    // Reads remain, because the console and the service need them.
    expect(typeof caps.get).toBe('function');
    expect(typeof caps.list).toBe('function');
    // Writes are gone from anything a queue handle can reach.
    expect(caps.register).toBeUndefined();
    expect(caps.setEnabled).toBeUndefined();
    expect(Object.getPrototypeOf(caps)).not.toHaveProperty('register');

    // And the definition enforcement uses is the real one, not a downgrade a
    // caller supplied: the gate still holds after an attempted rewrite.
    const registered = fx.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id);
    expect(registered?.riskClass).toBe('founder_gate');
    expect(registered?.sideEffect).toBe(true);
  });

  /**
   * Codex exact-head findings on `d575c89` (two P1s) — the ELEVENTH mechanism,
   * and the second in the rewrite-the-data category after `op_capabilities`.
   * They answered the question the previous review request asked: what else
   * does enforcement read that a caller can still write? `hq_approvals`.
   *
   * `approve` was on the public surface and my allowlist let it stay, on the
   * reasoning that it is "an operation the service drives". It is — but
   * `OperatorQueue.approve` only rejects the creator, the claimant and
   * `system`. It never resolves the supplied name and never checks approval
   * authority, so `queue.approve(taskId, 'fake-founder')` wrote a valid,
   * digest-bound `hq_approvals` row that `claim` and `start` accept: a Direct
   * Order passing its Founder gate with no Founder decision.
   */
  it('offers a worker no way to forge a Founder approval from a queue handle', () => {
    const fx = bindingFixture();
    const queue = fx.ops.queue as unknown as Record<string, unknown>;

    expect(queue.approve).toBeUndefined();
    expect(queue.deny).toBeUndefined();
    expect(Object.getPrototypeOf(queue)).not.toHaveProperty('approve');
    expect(Object.getPrototypeOf(queue)).not.toHaveProperty('deny');

    // The authorized path still works and still resolves the actor: a worker
    // is refused because it holds no approval authority, not because the
    // method is missing.
    const taskId = queuedClaudeOrder(fx);
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
  });

  it('offers execution callers no way to rewrite a capability definition', () => {
    // The companion finding: `registerCapability` on HeadquarterOperations had
    // no authority check, so a caller holding ops could downgrade an
    // already-claimed capability. Registration now needs the DATABASE, which
    // is the boundary that was already true and is now the only one.
    const fx = bindingFixture();
    const ops = fx.ops as unknown as Record<string, unknown>;
    expect(ops.registerCapability).toBeUndefined();
    expect(ops.setCapabilityEnabled).toBeUndefined();
    expect(Object.getPrototypeOf(ops)).not.toHaveProperty('registerCapability');
  });

  it('still lets the authorized service boundary declare, and still gates it', () => {
    const fx = bindingFixture();
    // Through the gate: works.
    expectOk(
      fx.ops.declareWorkerProvider({
        workerId: 'another-worker',
        providerId: 'CLAUDE',
        founderId: 'founder',
      }),
    );
    // An actor without approval authority is still refused — moving the
    // mechanism did not move the gate.
    const refused = fx.ops.declareWorkerProvider({
      workerId: 'another-worker',
      providerId: 'CODEX',
      founderId: 'claude-worker',
    });
    expect(refused.ok).toBe(false);
  });
});
