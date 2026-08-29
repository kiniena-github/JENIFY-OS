/**
 * What the Direct Order CLI tells the operator (issue #224).
 *
 * The correction reached `live/orders.ts`, the control API, the snapshot and
 * the browser console. It had not reached the CLI, which is the interface #200
 * relies on until a browser authentication boundary exists — so the trusted
 * local-admin path still described the old behaviour:
 *
 *   - it formatted `route.resolved`, which means "can dispatch right now" and
 *     is null for a blocked order, so it announced `AUTO → null` as the route
 *     an order had gone to. Exactly the defect Codex found in `defaultTitle`,
 *     one surface over.
 *   - it printed a bare "Order created." over an order that cannot move, which
 *     is the misreport this whole issue exists to close.
 *
 * The wording lives in a pure formatter so these are executed properties, not
 * claims about a `console.log`.
 */

import { describe, expect, it } from 'vitest';
import { formatOrderReceipt } from '../src/cli/order-receipt.js';
import { DIRECT_ORDER_CAPABILITY } from '../src/live/orders.js';
import type { DirectOrderReceipt } from '../src/live/orders.js';
import type { OperatorTask } from '../src/operator/queue.js';

const CONTEXT = { capabilityId: DIRECT_ORDER_CAPABILITY.id, requestedBy: 'founder' };

function task(): OperatorTask {
  return {
    id: 'task-1',
    capabilityId: DIRECT_ORDER_CAPABILITY.id,
    payload: { kind: 'direct_order', executionProvider: 'CLAUDE' },
    idempotencyKey: 'direct-order:abc',
    status: 'needs_approval',
    fence: 0,
    claimedBy: null,
    leaseExpiresAt: null,
    claimNonce: null,
    approvalId: null,
    reviewState: 'none',
    submittedBy: null,
    submittedAt: null,
    createdBy: 'founder',
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
    result: null,
    blockReason: null,
  };
}

function receipt(overrides: Partial<DirectOrderReceipt> = {}): DirectOrderReceipt {
  return {
    task: task(),
    classification: {
      capabilityId: DIRECT_ORDER_CAPABILITY.id,
      riskClass: 'founder_gate',
      requiresApproval: true,
      route: 'founder_approval',
      sideEffect: true,
      idempotent: true,
    } as DirectOrderReceipt['classification'],
    deduplicated: false,
    route: {
      requested: 'CLAUDE',
      resolved: null,
      connected: false,
      reason:
        'CLAUDE was requested explicitly and is NOT connected here, so the order is blocked ' +
        'rather than routed elsewhere. CLAUDE NOT CONNECTED — missing credential(s): ' +
        'CLAUDE_ROUTINE_URL, CLAUDE_ROUTINE_TOKEN.',
      candidates: [],
    },
    idempotencyKey: 'direct-order:abc',
    boundProvider: 'CLAUDE',
    dispatchBlocked: true,
    ...overrides,
  };
}

const text = (r: DirectOrderReceipt): string => formatOrderReceipt(r, CONTEXT).join('\n');

describe('the CLI receipt names the bound provider, never a null resolution', () => {
  it('never prints the literal word null for a blocked order', () => {
    const out = text(receipt());
    expect(out).not.toContain('null');
    expect(out).not.toContain('undefined');
    expect(out).toContain('route:       CLAUDE → CLAUDE');
  });

  it('names what AUTO was actually bound to, not what it resolved to', () => {
    // The case that produced `AUTO → null`: AUTO resolved nothing, and the
    // order is recorded against the declared preference.
    const out = text(
      receipt({
        route: {
          requested: 'AUTO',
          resolved: null,
          connected: false,
          reason: 'AUTO could not select a provider. No substitution is made.',
          candidates: [],
        },
      }),
    );
    expect(out).toContain('route:       AUTO → CLAUDE');
    expect(out).not.toContain('null');
  });

  it('names the resolved provider unchanged when the order is dispatchable', () => {
    const out = text(
      receipt({
        dispatchBlocked: false,
        route: {
          requested: 'CLAUDE',
          resolved: 'CLAUDE',
          connected: true,
          reason: 'Claude is connected.',
          candidates: [],
        },
      }),
    );
    expect(out).toContain('route:       CLAUDE → CLAUDE');
    expect(out).toContain('dispatch:    ready');
  });
});

describe('the CLI receipt never reports a blocked order as on its way', () => {
  it('states BLOCKED, that the order exists, and that nothing was substituted', () => {
    const out = text(receipt());
    expect(out).toContain('dispatch:    BLOCKED — NOT CONNECTED');
    expect(out).toContain('The canonical order EXISTS and is recorded');
    expect(out).toContain('is not lost');
    expect(out).toContain('No other provider was substituted.');
    // The routing lane's own reason, verbatim — never softened for the console.
    expect(out).toContain('missing credential(s): CLAUDE_ROUTINE_URL, CLAUDE_ROUTINE_TOKEN.');
  });

  it('says none of that for an order that is genuinely dispatchable', () => {
    const out = text(
      receipt({
        dispatchBlocked: false,
        route: {
          requested: 'CLAUDE',
          resolved: 'CLAUDE',
          connected: true,
          reason: 'Claude is connected.',
          candidates: [],
        },
      }),
    );
    expect(out).not.toContain('BLOCKED');
    expect(out).not.toContain('is not lost');
  });

  it('carries the blocked statement onto a deduplicated submission too', () => {
    const out = text(receipt({ deduplicated: true }));
    expect(out).toContain('Matched an existing identical order.');
    expect(out).toContain('dispatch:    BLOCKED — NOT CONNECTED');
  });

  it('still says the order executes nothing until a Founder approves it', () => {
    const out = text(receipt());
    expect(out).toContain('executes NOTHING until a Founder approves that exact action by digest');
    // And that the asserted principal is precisely the one who may not approve.
    expect(out).toContain('no-self-approval');
  });

  it('leaks no instruction text — the receipt describes the task, not its contents', () => {
    const blocked = receipt();
    blocked.task.payload.instruction = 'Draft the Q3 maintenance plan for the Mesob line.';
    expect(text(blocked)).not.toContain('Q3 maintenance plan');
  });
});
