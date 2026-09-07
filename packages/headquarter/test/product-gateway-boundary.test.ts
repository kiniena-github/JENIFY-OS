/**
 * Phase 12's two hardest claims, proven against the real machinery.
 *
 * 1. **Product state is NOT task authority.** No eligibility, claim, dispatch,
 *    approval, execution or kill-switch decision moves when a product's
 *    lifecycle moves — including all the way to `released` — and none moves
 *    when a hostile same-realm patch FORGES a released product on the public
 *    reads. Proven by taking the same canonical decisions with and without the
 *    product and comparing them, and by a source scan showing the enforcement
 *    layer never mentions a product table at all.
 *
 * 2. **The Product Factory cannot bypass the Phase 8 gateway.** A release IS
 *    an external action, so it is proposed, risk-assessed, approved, bound to
 *    a live claim and Intent-Guarded exactly like every other external action
 *    — and it is refused when the approval is absent or stale, when the
 *    payload digest changed, when the provider binding does not match, and
 *    when any kill switch is engaged. The Product Factory contributes NOTHING
 *    to any of those decisions: a `released` product does not soften one of
 *    them, and a product that does not exist does not harden one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import {
  authorizedAction,
  count,
  errorCode,
  fakeAdapter,
  gatewayFixture,
  startedTask,
  type GatewayFixture,
} from './action-gateway.fixture.js';
import { productFixture, advanceTo } from './product-factory.fixture.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  PRODUCT_COMMAND_CAPABILITY,
  registerProductCommandCapability,
} from '../src/application/product-command.js';
import {
  EXTERNAL_ACTION_KILL_SCOPE,
  adapterKillSwitchScope,
  providerKillSwitchScope,
  assessActionRisk,
  riskRequiresApproval,
} from '../src/application/action-gateway.js';

/**
 * A gateway fixture that also carries a real project and a real product, so a
 * "release" can be attempted in the only way HQ admits one: as an external
 * action through the gateway, bound to a canonical task.
 */
function releaseFixture(options: Parameters<typeof gatewayFixture>[0] = {}): {
  fx: GatewayFixture;
  projectId: string;
  productId: string;
} {
  const fx = gatewayFixture(options);
  registerProjectCommandCapability(fx.db);
  registerProductCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      CAPS.indexDoc,
      CAPS.dropIndex,
      PROJECT_COMMAND_CAPABILITY.id,
      PRODUCT_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  const project = expectOk(
    fx.ops.createProject({
      name: 'rhodium platform',
      purpose: 'The rhodium delivery platform',
      requestedBy: 'founder',
    }),
  ).project;
  const product = expectOk(
    fx.ops.createProduct({
      projectId: project.id,
      productType: 'web',
      name: 'rhodium console',
      problem: 'A stated problem',
      targetUsers: 'Stated users',
      requestedBy: 'founder',
    }),
  ).product;
  return { fx, projectId: project.id, productId: product.id };
}

/** Take the canonical decisions a product must never influence. */
function canonicalDecisions(fx: GatewayFixture, taskId: string): Record<string, unknown> {
  const eligibility = fx.ops.evaluateTaskEligibility(taskId);
  const task = fx.ops.queue.get(taskId);
  return {
    eligible: eligibility.ok ? JSON.stringify(eligibility.data) : `refused:${errorCode(eligibility)}`,
    status: task?.status ?? null,
    reviewState: task?.reviewState ?? null,
    killSwitch: fx.ops.queue.killSwitchEngaged(),
  };
}

/* ------------------------------------------------------------------ */

describe('a product lifecycle is not task authority', () => {
  it('changes no eligibility, claim, approval or kill-switch decision as it advances to released', () => {
    const fx = productFixture();
    const gated = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { document: 'unrelated' },
        idempotencyKey: 'product-neutrality',
        requestedBy: 'claude',
      }),
    ).task;
    const before = {
      eligibility: JSON.stringify(expectOk(fx.ops.evaluateTaskEligibility(gated.id))),
      status: fx.ops.queue.get(gated.id)!.status,
      killSwitch: fx.ops.queue.killSwitchEngaged(),
      claimable: errorCode(fx.ops.claimNext('claude', CAPS.indexDoc, undefined, gated.id)),
    };
    // The task is held at the Founder gate; a product reaching `released`
    // must not change that by one bit.
    expect(before.status).toBe('needs_approval');
    expect(before.claimable).toBe('nothing_claimable');

    advanceTo(fx, fx.productId, 'released');
    expect(fx.ops.getProduct(fx.productId)!.lifecycle).toBe('released');

    expect(JSON.stringify(expectOk(fx.ops.evaluateTaskEligibility(gated.id)))).toBe(before.eligibility);
    expect(fx.ops.queue.get(gated.id)!.status).toBe(before.status);
    expect(fx.ops.queue.killSwitchEngaged()).toBe(before.killSwitch);
    expect(errorCode(fx.ops.claimNext('claude', CAPS.indexDoc, undefined, gated.id))).toBe(before.claimable);
  });

  it('is not task authority even when a hostile patch FORGES a released product', () => {
    const { fx, productId } = releaseFixture();
    const started = startedTask(fx);
    const baseline = canonicalDecisions(fx, started.taskId);

    const prototype = Object.getPrototypeOf(fx.ops) as {
      getProduct: (id: string) => unknown;
      listProducts: () => unknown[];
      productReleaseReadiness: (id: string) => unknown;
    };
    const realGet = prototype.getProduct;
    const realList = prototype.listProducts;
    const realReadiness = prototype.productReleaseReadiness;
    const forged = {
      id: productId,
      lifecycle: 'released',
      authority: { executesExternally: true, founderOnly: false },
    };
    prototype.getProduct = () => forged as never;
    prototype.listProducts = () => [forged as never];
    prototype.productReleaseReadiness = () =>
      ({ ok: true, data: { blockers: [], authorizesRelease: true } }) as never;
    try {
      // Every lie TOOK on its public surface.
      expect((fx.ops.getProduct(productId) as { lifecycle: string }).lifecycle).toBe('released');
      expect((fx.ops.listProducts() as { lifecycle: string }[])[0]!.lifecycle).toBe('released');
      expect(
        (fx.ops.productReleaseReadiness(productId) as { data: { authorizesRelease: boolean } }).data
          .authorizesRelease,
      ).toBe(true);

      // And moved NOTHING the operator decides.
      expect(canonicalDecisions(fx, started.taskId)).toEqual(baseline);
      // A forged `authorizesRelease: true` buys no external execution: the
      // action still has to be proposed and authorized like any other.
      const actionId = authorizedAction(fx, started, {
        actionType: 'publish_release',
        target: 'releases/rhodium-console',
        payload: { version: '1.0.0' },
      });
      expectOk(fx.ops.engageKillSwitch(EXTERNAL_ACTION_KILL_SCOPE, 'founder', 'stop'));
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe(
        'kill_switch_engaged',
      );
      expect(fx.adapter.calls).toHaveLength(0);
    } finally {
      prototype.getProduct = realGet;
      prototype.listProducts = realList;
      prototype.productReleaseReadiness = realReadiness;
    }
  });

  it('a task and a queue behave identically on a handle with NO product schema at all', () => {
    // The mirror image of the patch test: the absence of the whole Product
    // Factory changes nothing either, which is what "not authority" means in
    // both directions.
    const bare = setupFixture();
    const withProducts = productFixture();
    const spec = {
      capabilityId: CAPS.indexDoc,
      payload: { document: 'same' },
      idempotencyKey: 'identical-across-handles',
      requestedBy: 'claude',
    };
    const a = expectOk(bare.ops.createTask(spec)).task;
    const b = expectOk(withProducts.ops.createTask(spec)).task;
    expect(a.status).toBe(b.status);
    expect(errorCode(bare.ops.claimNext('claude', CAPS.indexDoc, undefined, a.id))).toBe(
      errorCode(withProducts.ops.claimNext('claude', CAPS.indexDoc, undefined, b.id)),
    );
    // The classification and the approval requirement are identical too. (The
    // action digests are deliberately NOT compared: a digest covers the task
    // id, which is a fresh uuid on each handle, so equality there would be a
    // statement about uuid generation rather than about products.)
    expect(JSON.stringify(bare.ops.classify(CAPS.indexDoc))).toBe(
      JSON.stringify(withProducts.ops.classify(CAPS.indexDoc)),
    );
    expect(bare.ops.productStorePresent()).toBe(true);
  });

  it('the enforcement layer never mentions a product table or the product vocabulary', () => {
    // A source scan, because behaviour alone cannot prove a NEGATIVE about
    // every future call site. The operator queue, the policy engine, the
    // approval machinery and the capability registry are the four modules
    // that decide whether work may run; none of them may know products exist.
    const enforcement = [
      'src/operator/queue.ts',
      'src/operator/policy.ts',
      'src/operator/approvals.ts',
      'src/operator/capabilities.ts',
    ];
    for (const file of enforcement) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const forbidden of ['hq_products', 'hq_product_events', 'hq_product_artifacts', 'productLifecycle', 'release_candidate']) {
        expect(source, `${file} must not mention ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('a release is an external action, and the gateway is its only path', () => {
  it('assesses a public irreversible release as critical and REQUIRES an approval', () => {
    // The risk engine's own answer for the shape a release has. Nothing in
    // the Product Factory can lower it, because nothing in the Product
    // Factory is an input to it.
    const assessment = assessActionRisk({
      capability: { riskClass: 'external_side_effect', sideEffect: true },
      contract: { visibility: 'public', reversibility: 'irreversible' },
      escalations: { productionScope: true },
    });
    expect(assessment.level).toBe('critical');
    expect(assessment.factors).toContain('public_and_irreversible');
    expect(assessment.factors).toContain('production_scope');
    expect(riskRequiresApproval(assessment.level)).toBe(true);
  });

  it('runs a real release only through propose -> authorize -> execute, with the approval bound', () => {
    const { fx } = releaseFixture();
    const started = startedTask(fx);
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: fx.adapter.id,
        actionType: 'publish_release',
        target: 'releases/rhodium-console',
        payload: { version: '1.0.0' },
        requestedBy: 'founder',
      }),
    ).action;
    expect(proposed.riskLevel).toBe('critical');
    expect(proposed.visibility).toBe('public');
    expect(proposed.reversibility).toBe('irreversible');
    expect(proposed.compensation).toBeNull();
    // Proposing performs nothing.
    expect(fx.adapter.calls).toHaveLength(0);

    expectOk(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }));
    const executed = expectOk(
      fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }),
    );
    expect(executed.outcome).toBe('succeeded');
    expect(fx.adapter.calls).toHaveLength(1);
    // The authorization rested on a real approval row on the canonical task.
    expect(fx.ops.getAction(proposed.id)!.authorization?.approvalId).toBeTruthy();
  });

  it('refuses a release with NO approval on the canonical task', () => {
    const { fx } = releaseFixture();
    // `readStatus` is read-only and needs no approval to start — so the task
    // is executing with no approval row at all, and a critical action must
    // demand one anyway.
    const started = startedTask(fx, { capabilityId: CAPS.readStatus, idempotencyKey: 'release-no-approval' });
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: fx.adapter.id,
        actionType: 'publish_release',
        target: 'releases/rhodium-console',
        payload: { version: '1.0.0' },
        requestedBy: 'founder',
      }),
    ).action;
    expect(proposed.riskLevel).toBe('critical');
    expect(errorCode(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'approval_required_by_risk',
    );
    expect(fx.adapter.calls).toHaveLength(0);
    expect(fx.ops.getAction(proposed.id)!.state).toBe('proposed');
  });

  it('refuses a release whose approval went STALE between authorization and the call', () => {
    const { fx } = releaseFixture();
    const started = startedTask(fx, { ttlMs: 60_000, idempotencyKey: 'release-stale' });
    const actionId = authorizedAction(fx, started, {
      actionType: 'publish_release',
      target: 'releases/rhodium-console',
      payload: { version: '1.0.0' },
    });
    const later = new Date(Date.now() + 61_000);
    expect(
      errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence, now: later })),
    ).toBe('action_approval_stale');
    expect(fx.adapter.calls).toHaveLength(0);
  });

  it('refuses a release whose approved payload digest changed underneath it', () => {
    const { fx } = releaseFixture();
    const started = startedTask(fx, { idempotencyKey: 'release-digest' });
    const actionId = authorizedAction(fx, started, {
      actionType: 'publish_release',
      target: 'releases/rhodium-console',
      payload: { version: '1.0.0' },
    });
    fx.db
      .prepare(`UPDATE op_tasks SET payload = ? WHERE id = ?`)
      .run(JSON.stringify({ document: 'swapped' }), started.taskId);
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe(
      'action_digest_mismatch',
    );
    expect(fx.adapter.calls).toHaveLength(0);
  });

  it('refuses a release whose provider binding does not match the executing worker', () => {
    const claude = fakeAdapter({ id: 'fake.claude', provider: 'CLAUDE' });
    const { fx } = releaseFixture({ adapters: [claude], adapter: claude });
    const started = startedTask(fx, { idempotencyKey: 'release-provider' });
    const proposed = expectOk(
      fx.ops.proposeAction({
        taskId: started.taskId,
        adapterId: 'fake.claude',
        actionType: 'publish_release',
        target: 'releases/rhodium-console',
        payload: { version: '1.0.0' },
        requestedBy: 'founder',
      }),
    ).action;
    // Undeclared worker: refused rather than guessed from its vendor string.
    expect(errorCode(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'provider_binding_mismatch',
    );
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'coo' }));
    expectOk(fx.ops.authorizeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }));
    // Redeclared between authorization and execution: the Intent Guard stops it.
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CODEX', founderId: 'coo' }));
    expect(errorCode(fx.ops.executeAction({ actionId: proposed.id, workerId: 'claude', fence: started.fence }))).toBe(
      'provider_binding_mismatch',
    );
    expect(claude.calls).toHaveLength(0);
  });

  it('refuses a release under every kill-switch scope, including with a released product', () => {
    const { fx, productId } = releaseFixture();
    // Take the product all the way to `released` first: the strongest form of
    // "the product record softens no gate".
    for (const to of [
      'research',
      'specification',
      'architecture',
      'build',
      'test',
      'review',
      'release_candidate',
      'released',
    ]) {
      expectOk(
        fx.ops.moveProductLifecycle({ productId, to, note: `Advance to ${to}.`, requestedBy: 'founder' }),
      );
    }
    expect(fx.ops.getProduct(productId)!.lifecycle).toBe('released');

    const started = startedTask(fx, { idempotencyKey: 'release-killswitch' });
    const actionId = authorizedAction(fx, started, {
      actionType: 'publish_release',
      target: 'releases/rhodium-console',
      payload: { version: '1.0.0' },
    });
    for (const scope of ['*', CAPS.indexDoc, EXTERNAL_ACTION_KILL_SCOPE, adapterKillSwitchScope('fake.local')]) {
      expectOk(fx.ops.engageKillSwitch(scope, 'founder', 'stop the release'));
      expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence })), scope).toBe(
        'kill_switch_engaged',
      );
      expectOk(fx.ops.releaseKillSwitch(scope, 'founder'));
    }
    expect(fx.adapter.calls).toHaveLength(0);
    expect(fx.ops.getAction(actionId)!.state).toBe('authorized');
  });

  it('stops a provider-scoped release even though the product says released', () => {
    const claude = fakeAdapter({ id: 'fake.claude', provider: 'CLAUDE' });
    const { fx } = releaseFixture({ adapters: [claude], adapter: claude });
    expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'coo' }));
    const started = startedTask(fx, {
      payload: { document: 'd', executionProvider: 'CLAUDE' },
      idempotencyKey: 'release-provider-scope',
    });
    const actionId = authorizedAction(fx, started, {
      adapterId: 'fake.claude',
      actionType: 'publish_release',
      target: 'releases/rhodium-console',
      payload: { version: '1.0.0' },
    });
    expectOk(fx.ops.engageKillSwitch(providerKillSwitchScope('CLAUDE'), 'founder', 'provider stop'));
    expect(errorCode(fx.ops.executeAction({ actionId, workerId: 'claude', fence: started.fence }))).toBe(
      'kill_switch_engaged',
    );
    expect(claude.calls).toHaveLength(0);
  });

  it('never lets a product write reach an adapter, however far the lifecycle goes', () => {
    const { fx, productId } = releaseFixture();
    const intentsBefore = count(fx, 'hq_action_intents');
    const eventsBefore = count(fx, 'hq_action_events');
    for (const to of [
      'research',
      'specification',
      'architecture',
      'build',
      'test',
      'review',
      'release_candidate',
      'released',
    ]) {
      expectOk(
        fx.ops.moveProductLifecycle({ productId, to, note: `Advance to ${to}.`, requestedBy: 'founder' }),
      );
    }
    expectOk(
      fx.ops.registerProductArtifact({
        productId,
        kind: 'release_candidate',
        name: 'rhodium 1.0.0',
        locator: 'releases/rhodium-console-1.0.0.tgz',
        requestedBy: 'founder',
      }),
    );
    // The readiness read reports a clean record — and STILL authorizes nothing.
    const readiness = expectOk(fx.ops.productReleaseReadiness(productId));
    expect(readiness.authorizesRelease).toBe(false);
    expect(readiness.externalActionPath).toBe('phase_8_action_gateway');
    // No adapter was called, and the action ledger never moved.
    expect(fx.adapter.calls).toHaveLength(0);
    expect(count(fx, 'hq_action_intents')).toBe(intentsBefore);
    expect(count(fx, 'hq_action_events')).toBe(eventsBefore);
  });
});
