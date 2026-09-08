/**
 * Shared fixture for the Phase 8 action-gateway suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the lane F fixture and adds deterministic FAKE
 * adapters — the only adapters any test executes through. Nothing here reaches
 * a real provider, repository or network; the architecture is proved against
 * local adapters whose behaviour (succeed / reject / unknown / throw) is chosen
 * by the test.
 */

import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import type {
  ActionExecutionRequest,
  ActionTypeContract,
  AdapterOutcome,
  ExternalActionAdapter,
} from '../src/application/action-gateway.js';
import { taskActionDigest } from '../src/operator/approvals.js';

export type FakeMode = 'succeed' | 'reject' | 'unavailable' | 'unknown' | 'throw';

export interface FakeAdapter extends ExternalActionAdapter {
  calls: ActionExecutionRequest[];
  /** Mutable so a test can change behaviour between attempts. */
  mode: FakeMode;
  externalRef: Record<string, unknown> | null;
}

/**
 * Three action types spanning the reversibility/visibility space.
 *
 * The two that are not both internal and reversible declare
 * `sideEffectIdentityFields`, because `adapterContractProblems` requires it of
 * them (Wave 5 correction round fifteen, High 5): an action HQ cannot walk
 * back must state which payload fields it acts on, so a field the adapter
 * ignores cannot mint a fresh side-effect key. `write_note` deliberately
 * omits it, so the documented internal/reversible fallback stays exercised.
 */
export const FAKE_ACTIONS: Readonly<Record<string, ActionTypeContract>> = {
  write_note: {
    description: 'Write an internal note (reversible; the adapter can delete it).',
    visibility: 'internal',
    reversibility: 'reversible',
    compensation: { supported: true, method: 'delete_note', description: 'Deletes the note by id.' },
  },
  post_comment: {
    description: 'Post an external comment (compensable; the comment can be removed, the notification cannot).',
    visibility: 'external',
    reversibility: 'compensable',
    compensation: { supported: true, method: 'delete_comment', description: 'Removes the comment; readers may have seen it.' },
    sideEffectIdentityFields: ['text'],
  },
  publish_release: {
    description: 'Publish a public release (irreversible; no compensation exists).',
    visibility: 'public',
    reversibility: 'irreversible',
    compensation: null,
    sideEffectIdentityFields: ['tag'],
  },
};

export function fakeAdapter(
  options: {
    id?: string;
    provider?: string | null;
    mode?: FakeMode;
    externalRef?: Record<string, unknown> | null;
    actions?: Readonly<Record<string, ActionTypeContract>>;
  } = {},
): FakeAdapter {
  const adapter: FakeAdapter = {
    id: options.id ?? 'fake.local',
    provider: options.provider === undefined ? null : options.provider,
    actions: options.actions ?? FAKE_ACTIONS,
    calls: [],
    mode: options.mode ?? 'succeed',
    externalRef: options.externalRef === undefined ? { noteId: 'n-1' } : options.externalRef,
    execute(request: ActionExecutionRequest): AdapterOutcome {
      adapter.calls.push(request);
      switch (adapter.mode) {
        case 'succeed':
          return { ok: true, externalRef: adapter.externalRef };
        case 'reject':
          return { ok: false, kind: 'rejected', message: 'the remote refused the request' };
        case 'unavailable':
          return { ok: false, kind: 'unavailable', message: 'the remote is unreachable' };
        case 'unknown':
          return { ok: false, kind: 'unknown', message: 'the request timed out after being sent' };
        case 'throw':
          throw new Error('the adapter died mid-call');
      }
    },
  };
  return adapter;
}

export interface GatewayFixture extends Fixture {
  adapter: FakeAdapter;
}

export function gatewayFixture(options: { adapters?: readonly ExternalActionAdapter[]; adapter?: FakeAdapter } = {}): GatewayFixture {
  const adapter = options.adapter ?? fakeAdapter();
  const fx = setupFixture({ actionAdapters: options.adapters ?? [adapter] });
  // The Founder may originate the side-effect capabilities used here; the
  // COO stays the independent approver (approval authority, no origination).
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
    approvalAuthority: true,
    active: true,
  });
  return { ...fx, adapter };
}

/**
 * A canonical task claimed AND started by `worker` — the state every gateway
 * execution requires. Approval-gated capabilities are approved by `approver`
 * (never the creator), with an optional time-box.
 */
export function startedTask(
  fx: Fixture,
  options: {
    capabilityId?: string;
    payload?: Record<string, unknown>;
    worker?: string;
    creator?: string;
    approver?: string;
    idempotencyKey?: string;
    ttlMs?: number;
  } = {},
): { taskId: string; fence: number; worker: string } {
  const capabilityId = options.capabilityId ?? CAPS.indexDoc;
  const worker = options.worker ?? 'claude';
  const created = expectOk(
    fx.ops.createTask({
      capabilityId,
      payload: options.payload ?? { document: 'doc-1' },
      idempotencyKey: options.idempotencyKey ?? `gw-${Math.random().toString(36).slice(2)}`,
      requestedBy: options.creator ?? worker,
    }),
  ).task;
  if (created.status === 'needs_approval') {
    expectOk(
      fx.ops.approveTask({
        taskId: created.id,
        founderId: options.approver ?? 'coo',
        expectedActionDigest: taskActionDigest(created),
        ttlMs: options.ttlMs,
      }),
    );
  }
  const claimed = expectOk(fx.ops.claimNext(worker, capabilityId, undefined, created.id));
  expectOk(fx.ops.startTask(claimed.id, worker, claimed.fence));
  return { taskId: created.id, fence: claimed.fence, worker };
}

/** Propose (default: by the Founder) + authorize (by the executing worker). */
export function authorizedAction(
  fx: GatewayFixture,
  started: { taskId: string; fence: number; worker: string },
  over: Partial<Parameters<GatewayFixture['ops']['proposeAction']>[0]> = {},
): string {
  const proposed = expectOk(
    fx.ops.proposeAction({
      taskId: started.taskId,
      adapterId: fx.adapter.id,
      actionType: 'write_note',
      target: 'notes/board',
      payload: { text: 'hello' },
      requestedBy: 'founder',
      ...over,
    }),
  ).action;
  expectOk(fx.ops.authorizeAction({ actionId: proposed.id, workerId: started.worker, fence: started.fence }));
  return proposed.id;
}

export function count(fx: Fixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function errorCode(result: { ok: boolean; error?: { code: string } }): string | null {
  return result.ok ? null : (result.error?.code ?? null);
}
