/**
 * Browser-safe HQ snapshot (issue #200, scope A).
 *
 * The snapshot is the only artefact that leaves the machine, so these tests
 * assert on the whole thing rather than on a helper: no task payloads, no
 * secrets, no invented metrics, honest provenance, and a mode that degrades
 * to the weakest section rather than to the most flattering one.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, CAPS, expectOk } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import {
  buildHqSnapshot,
  emptyFounderConsole,
  HQ_SNAPSHOT_VERSION,
  liveSnapshotFromOperations,
  trimActivity,
  type SnapshotSources,
} from '../src/live/snapshot.js';
import { assertBrowserSafe, assertNoFabricatedFields, BrowserSafetyError } from '../src/live/redaction.js';
import { weakestMode } from '../src/live/provenance.js';
import { registerDirectOrderCapability, submitDirectOrder, DIRECT_ORDER_CAPABILITY } from '../src/live/orders.js';
import type { ActivityEvent } from '../src/contracts/events.js';

const NOW = '2026-08-28T12:00:00Z';
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

function sources(overrides: Partial<SnapshotSources> = {}): SnapshotSources {
  const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
  return {
    generatedAt: NOW,
    console: { data: emptyFounderConsole(NOW), provenance },
    connections: { data: [], provenance },
    workforce: { data: [], provenance },
    capabilities: { data: [], provenance },
    activity: { data: [], provenance },
    ...overrides,
  };
}

describe('shape and provenance', () => {
  it('stamps a version and the instant it was generated', () => {
    const snapshot = buildHqSnapshot(sources());
    expect(snapshot.snapshotVersion).toBe(HQ_SNAPSHOT_VERSION);
    expect(snapshot.generatedAt).toBe(NOW);
  });

  it('carries per-section provenance naming what was actually read', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW });
    expect(snapshot.operations.provenance.source).toContain('op_tasks');
    expect(snapshot.workforce.provenance.source).toContain('hq_specialists');
    expect(snapshot.capabilities.provenance.source).toContain('op_capabilities');
    expect(snapshot.activity.provenance.source).toContain('hq_events');
    for (const key of ['operations', 'workforce', 'capabilities', 'activity'] as const) {
      expect(snapshot[key].provenance.asOf).toBe(NOW);
    }
  });

  it('takes the WEAKEST mode across sections, so one sample cannot render as LIVE', () => {
    const live = { mode: 'live' as const, source: 't', asOf: NOW };
    const sample = { mode: 'sample' as const, source: 't', asOf: NOW };
    const mixed = buildHqSnapshot(
      sources({
        console: { data: emptyFounderConsole(NOW), provenance: live },
        activity: { data: [], provenance: sample },
      }),
    );
    expect(mixed.mode).toBe('sample');
    expect(weakestMode(['live', 'reconstructed'])).toBe('reconstructed');
    expect(weakestMode(['live', 'live'])).toBe('live');
  });

  it('derives a live snapshot straight from a running operations facade', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(snapshot.mode).toBe('live');
    expect(snapshot.workforce.data.map((worker) => worker.id).sort()).toEqual([
      'claude',
      'codex',
      'jules',
      'retired-bot',
    ]);
    expect(snapshot.capabilities.data.map((capability) => capability.id)).toContain(CAPS.openPr);
    // Connection state is probed independently of the snapshot's own mode.
    const claude = snapshot.connections.data.find((entry) => entry.id === 'anthropic-claude')!;
    expect(claude.state).toBe('connected');
  });
});

describe('what the snapshot must never contain', () => {
  it('never carries a task payload — an order instruction stays server-side', () => {
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.ops);
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const secretish = 'Rotate the warehouse door code to 8891 before Friday.';
    const order = submitDirectOrder(
      fixture.ops,
      { instruction: secretish, route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    expect(order.ok).toBe(true);

    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW, env: CLAUDE_ONLY });
    const serialized = JSON.stringify(snapshot);
    // The task is visible and gated; its contents are not published.
    expect(snapshot.counts.approvals).toBe(1);
    expect(serialized).not.toContain(secretish);
    expect(serialized).not.toContain('8891');
    expect(serialized).not.toContain('"payload"');
    // The order is labelled neutrally unless its author chose a title.
    expect(snapshot.operations.data.approvals[0]!.title).toBe('Direct order → CLAUDE');
  });

  it('publishes a title only when its author deliberately chose one', () => {
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.ops);
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    submitDirectOrder(
      fixture.ops,
      {
        instruction: 'Sensitive detail nobody chose to publish.',
        title: 'Q3 maintenance plan',
        route: 'CLAUDE',
        requestedBy: 'founder',
      },
      CLAUDE_ONLY,
    );
    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW, env: CLAUDE_ONLY });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('Q3 maintenance plan');
    expect(serialized).not.toContain('Sensitive detail');
  });

  it('refuses to build at all when a section carries a credential', () => {
    const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
    expect(() =>
      buildHqSnapshot(
        sources({
          workforce: {
            data: [
              {
                id: 'leaky',
                displayName: 'Leaky',
                vendor: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                role: 'build_lead',
                allowedCapabilities: [],
                active: true,
              },
            ],
            provenance,
          },
        }),
      ),
    ).toThrow(BrowserSafetyError);
  });

  it('proves a real snapshot passes both guards', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(() => assertBrowserSafe(snapshot)).not.toThrow();
    expect(() => assertNoFabricatedFields(snapshot)).not.toThrow();
  });

  it('publishes no cost, token, ETA or sentiment field anywhere', () => {
    const { ops } = setupFixture();
    const serialized = JSON.stringify(liveSnapshotFromOperations(ops, { now: NOW }));
    for (const forbidden of ['"cost"', '"tokens"', '"eta"', '"sentiment"', '"progressPercent"']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('activity trimming', () => {
  const event = (seq: number, extra: Partial<ActivityEvent> = {}): ActivityEvent =>
    ({
      seq,
      id: `e${seq}`,
      at: `2026-08-2${seq}T00:00:00Z`,
      actor: 'claude',
      subjectKind: 'task',
      subjectId: `t${seq}`,
      status: 'running',
      summary: `event ${seq}`,
      detail: { project: 'mesob', title: 'A title', internalPath: '/home/founder/.codex/auth.json' },
      refs: ['https://example.test/pr/1', '/local/path/secret.txt'],
      ...extra,
    }) as ActivityEvent;

  it('keeps only whitelisted detail fields, so arbitrary worker detail cannot leak', () => {
    const [entry] = trimActivity([event(1)]);
    expect(entry!.project).toBe('mesob');
    expect(entry!.title).toBe('A title');
    expect(JSON.stringify(entry)).not.toContain('internalPath');
    expect(JSON.stringify(entry)).not.toContain('auth.json');
  });

  it('drops non-https refs, which would expose the machine’s layout', () => {
    const [entry] = trimActivity([event(1)]);
    expect(entry!.refs).toEqual(['https://example.test/pr/1']);
  });

  it('returns the newest events first, bounded by the limit', () => {
    const entries = trimActivity([event(1), event(3), event(2)], 2);
    expect(entries.map((e) => e.seq)).toEqual([3, 2]);
  });
});

describe('reproducibility', () => {
  it('produces identical bytes for identical inputs', () => {
    const { ops } = setupFixture();
    const a = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    const b = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('counts match the console it projected', () => {
    const fixture = setupFixture();
    expectOk(
      fixture.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'x' },
        idempotencyKey: 'k1',
        requestedBy: 'claude',
      }),
    );
    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW });
    const console_ = founderConsole(fixture.ops, new Date(NOW));
    expect(snapshot.counts.approvals).toBe(console_.approvals.length);
    expect(snapshot.counts.queued).toBe(console_.queued.length);
  });
});
