/**
 * Direct Orders (issue #200, scope B).
 *
 * The five properties the mission asks to be proved, each with a test that
 * would fail loudly if the seam ever regressed:
 *
 *   create-order idempotency        a repeated order dedupes onto one task
 *   unavailable provider            refused, and NOTHING is created
 *   approval-required path          the task parks in needs_approval
 *   deny-by-default                 unknown capability / unknown principal
 *   no substitution                 CLAUDE never silently becomes CODEX
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  AUTO_ROUTE_PREFERENCE,
  DIRECT_ORDER_CAPABILITY,
  directOrderIdempotencyKey,
  MAX_INSTRUCTION_LENGTH,
  registerDirectOrderCapability,
  resolveOrderRoute,
  submitDirectOrder,
} from '../src/live/orders.js';

/** Environment in which Claude is genuinely connected and Codex is not. */
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };
/** Environment in which the local Codex CLI is genuinely available. */
const CODEX_ONLY = { CODEX_CLI_PATH: '/usr/local/bin/codex', CODEX_AUTH_MODE: 'chatgpt' };
const NOTHING = {};

function ordersFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  // The Founder must be granted origination for the direct-order capability,
  // exactly like any other. The grant lives in the registry, never in the
  // caller — that is the whole point of resolveRequester().
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

describe('route resolution is truthful and never substitutes', () => {
  it('resolves an explicit route only to itself', () => {
    const resolution = resolveOrderRoute('CLAUDE', CLAUDE_ONLY);
    expect(resolution.resolved).toBe('CLAUDE');
    expect(resolution.connected).toBe(true);
  });

  it('blocks an explicit route that is not connected instead of falling back', () => {
    // Codex is asked for; Claude IS available. It must still be blocked.
    const resolution = resolveOrderRoute('CODEX', CLAUDE_ONLY);
    expect(resolution.connected).toBe(false);
    expect(resolution.resolved).toBeNull();
    expect(resolution.candidates.map((candidate) => candidate.provider)).toEqual(['CODEX']);
    expect(resolution.reason).toContain('blocked');
  });

  it('lets AUTO pick only from providers that are genuinely connected', () => {
    expect(resolveOrderRoute('AUTO', CLAUDE_ONLY).resolved).toBe('CLAUDE');
    // Claude is preferred, but preference is not availability.
    expect(AUTO_ROUTE_PREFERENCE[0]).toBe('CLAUDE');
    expect(resolveOrderRoute('AUTO', CODEX_ONLY).resolved).toBe('CODEX');
  });

  it('resolves AUTO to nothing when no provider is connected', () => {
    const resolution = resolveOrderRoute('AUTO', NOTHING);
    expect(resolution.resolved).toBeNull();
    expect(resolution.reason).toContain('No substitution');
  });

  it('reports missing fact NAMES only, never values', () => {
    const resolution = resolveOrderRoute('CLAUDE', NOTHING);
    expect(resolution.candidates[0]!.missingFacts).toEqual([
      'CLAUDE_ROUTINE_URL',
      'CLAUDE_ROUTINE_TOKEN',
    ]);
  });
});

describe('an unavailable provider creates nothing at all', () => {
  it('refuses the order and leaves the queue empty', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, ORDER, NOTHING);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('provider_not_connected');
    // The proof that matters: no canonical task was written.
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
    expect(ops.queue.listByStatus('queued')).toHaveLength(0);
  });

  it('never routes an explicitly-requested blocked provider to a connected one', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, { ...ORDER, route: 'CODEX' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});

describe('a connected order becomes canonical, gated work', () => {
  it('creates a task that is parked in needs_approval and executes nothing', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const { task, classification, route } = result.data;
    expect(task.status).toBe('needs_approval');
    expect(task.capabilityId).toBe(DIRECT_ORDER_CAPABILITY.id);
    expect(classification.requiresApproval).toBe(true);
    expect(classification.riskClass).toBe('founder_gate');
    expect(route.resolved).toBe('CLAUDE');
    // It went through the queue, not around it.
    expect(ops.queue.get(task.id)?.status).toBe('needs_approval');
  });

  it('records the requested and resolved route on the canonical task', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, { ...ORDER, route: 'AUTO' }, CLAUDE_ONLY);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.task.payload).toMatchObject({
      kind: 'direct_order',
      requestedRoute: 'AUTO',
      // The reserved binding key — enforced at claim/start, not decorative.
      executionProvider: 'CLAUDE',
    });
  });

  it('cannot be pre-approved away: founder_gate ignores standing policy', () => {
    // The fixture pre-approves github.open_pr; a founder_gate capability is
    // deliberately not eligible for the same treatment.
    const { ops } = ordersFixture();
    const classification = ops.classify(DIRECT_ORDER_CAPABILITY.id);
    expect(classification.ok).toBe(true);
    if (!classification.ok) throw new Error('unreachable');
    expect(classification.data.requiresApproval).toBe(true);
    expect(classification.data.route).toBe('founder_approval');
  });
});

describe('idempotency', () => {
  it('dedupes an identical resubmission onto the same task', () => {
    const { ops } = ordersFixture();
    const first = submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    const second = submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    if (!first.ok || !second.ok) throw new Error('expected both to succeed');
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.task.id).toBe(first.data.task.id);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(1);
  });

  it('treats a genuinely different order as different work', () => {
    const { ops } = ordersFixture();
    submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    const other = submitDirectOrder(
      ops,
      { ...ORDER, instruction: 'Something else entirely.' },
      CLAUDE_ONLY,
    );
    if (!other.ok) throw new Error('expected ok');
    expect(other.data.deduplicated).toBe(false);
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(2);
  });

  it('derives the key from every field that makes an order the same order', () => {
    const base = { instruction: 'do a thing', project: 'p', route: 'AUTO' as const, requestedBy: 'founder' };
    const key = directOrderIdempotencyKey(base);
    expect(key.startsWith('direct-order:')).toBe(true);
    expect(directOrderIdempotencyKey({ ...base })).toBe(key);
    for (const change of [
      { requestedBy: 'analyst' },
      { route: 'CLAUDE' as const },
      { project: 'other' },
      { instruction: 'do another thing' },
    ]) {
      expect(directOrderIdempotencyKey({ ...base, ...change })).not.toBe(key);
    }
  });

  it('separates the digest fields, so a shifted boundary is not the same order', () => {
    // 'founder' + 'CLAUDE' concatenated must not collide with 'founderCLAUDE'.
    const a = directOrderIdempotencyKey({
      instruction: 'x',
      project: 'p',
      route: 'AUTO',
      requestedBy: 'founder',
    });
    const b = directOrderIdempotencyKey({
      instruction: 'x',
      project: 'p',
      route: 'AUTO',
      requestedBy: 'founderAUTO',
    });
    expect(a).not.toBe(b);
  });

  it('keeps the separator out of the source as a literal control character', () => {
    // It used to be a raw NUL byte written straight into orders.ts, which made
    // the file `data` rather than text to file/grep and — worse — meant any
    // tool that stripped or normalised control characters would have silently
    // changed EVERY idempotency key, breaking dedup of in-flight orders with
    // no visible diff. Same bytes at run time; escape in the source.
    const source = readFileSync(
      fileURLToPath(new URL('../src/live/orders.ts', import.meta.url)),
      'utf8',
    );
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)).toBe(false);
  });

  it('ignores surrounding whitespace, so a stray newline is not a new order', () => {
    const { ops } = ordersFixture();
    const first = submitDirectOrder(ops, ORDER, CLAUDE_ONLY);
    const second = submitDirectOrder(ops, { ...ORDER, instruction: `\n${ORDER.instruction}  ` }, CLAUDE_ONLY);
    if (!first.ok || !second.ok) throw new Error('expected both to succeed');
    expect(second.data.task.id).toBe(first.data.task.id);
  });
});

describe('deny by default', () => {
  it('refuses an unregistered principal', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, { ...ORDER, requestedBy: 'nobody' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unknown_principal');
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('refuses a registered principal without the origination grant', () => {
    const fixture = ordersFixture();
    // 'analyst' exists but was never granted hq.direct_order. The grant is
    // read from the principal registry and handed to the queue, which then
    // rejects the enqueue — the caller never gets to supply its own
    // permissions, so the refusal happens either way.
    const result = submitDirectOrder(fixture.ops, { ...ORDER, requestedBy: 'analyst' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(['not_permitted', 'enqueue_rejected']).toContain(result.error.code);
    expect(fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });

  it('refuses a registered WORKER — humans originate, workers execute', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(ops, { ...ORDER, requestedBy: 'claude' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
  });

  it('refuses when the capability was never registered at all', () => {
    // No registerDirectOrderCapability call: the path must not self-enable.
    const fixture = setupFixture();
    fixture.principals.register({
      id: 'founder2',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const result = submitDirectOrder(fixture.ops, { ...ORDER, requestedBy: 'founder2' }, CLAUDE_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('capability_not_registered');
    // Nothing was created, and — the point of the correction — nothing was
    // registered on the way past either.
    expect(fixture.ops.queue.capabilities.get(DIRECT_ORDER_CAPABILITY.id)).toBeNull();
  });

  it('refuses an unknown route rather than defaulting to one', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, route: 'GEMINI' as unknown as 'AUTO' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invalid_input');
  });
});

describe('input validation', () => {
  it('refuses an empty instruction', () => {
    const { ops } = ordersFixture();
    expect(submitDirectOrder(ops, { ...ORDER, instruction: '   ' }, CLAUDE_ONLY).ok).toBe(false);
  });

  it('refuses an instruction beyond the length bound', () => {
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, instruction: 'x'.repeat(MAX_INSTRUCTION_LENGTH + 1) },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('instruction_too_long');
  });

  it('refuses an instruction carrying a pasted credential, before any task exists', () => {
    // Orders become hash-chained evidence; a secret must be refused here
    // rather than by the evidence log after a task has been written.
    const { ops } = ordersFixture();
    const result = submitDirectOrder(
      ops,
      { ...ORDER, instruction: 'deploy with api_key: "abcd1234efgh5678"' },
      CLAUDE_ONLY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unsafe_instruction');
    expect(ops.queue.listByStatus('needs_approval')).toHaveLength(0);
  });
});
