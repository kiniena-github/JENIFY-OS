/**
 * Phase 5 — recordMemory and the memory facade reads (issue #265).
 *
 * The behavioral contract of the ONE application-layer write path into
 * hq_memory: the CONFIGURATION-vs-INVOCATION trio fails closed, worker and
 * system identity are refused outright, entity refs must name real canonical
 * rows, a summary must name real sources and never touches them, supersession
 * is the only "change", secrets never persist, and every accepted write lands
 * its audit trail (hq_events + op_evidence) atomically.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';

/** Fixture plus the Phase 5 configuration acts a real deployment performs. */
function memoryFixture(): Fixture {
  const fx = setupFixture();
  registerMemoryCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, MEMORY_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function note(over: Record<string, unknown> = {}) {
  return {
    kind: 'founder_note' as const,
    title: 'Salt line 2 stays manual',
    body: 'Do not automate line 2 until the QC gate is live.',
    project: 'JENIFY-OS',
    requestedBy: 'founder',
    ...over,
  };
}

function memoryRowCount(fx: Fixture): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n;
}

describe('recordMemory — provenance and audit', () => {
  it('records a founder note with full provenance and lands both audit trails', () => {
    const fx = memoryFixture();
    const { record, deduplicated } = expectOk(fx.ops.recordMemory(note()));
    expect(deduplicated).toBe(false);
    expect(record.kind).toBe('founder_note');
    expect(record.status).toBe('CURRENT');
    expect(record.privacy).toBe('internal');
    // recordedBy is PROVENANCE: exactly the boundary-resolved principal.
    expect(record.recordedBy).toBe('founder');
    expect(record.recorded.confidence).toBe('exact');
    expect(record.recorded.date).toBeTruthy();
    // hq_events audit (the issue-#120 onEvent hook, live for the first time).
    const events = fx.db
      .prepare(`SELECT * FROM hq_events WHERE subject_id = ?`)
      .all(`memory:${record.id}`);
    expect(events.length).toBe(1);
    // op_evidence entry, appended atomically with the insert.
    const evidence = fx.ops.queue.evidence.list().filter((e) => e.kind === 'memory_recorded');
    expect(evidence.length).toBe(1);
    expect((evidence[0].payload as { memoryId: string }).memoryId).toBe(record.id);
    expect((evidence[0].payload as { executable: boolean }).executable).toBe(false);
  });

  it('deduplicates a byte-identical re-record onto the stored row', () => {
    const fx = memoryFixture();
    const first = expectOk(fx.ops.recordMemory(note()));
    const second = expectOk(fx.ops.recordMemory(note()));
    expect(second.deduplicated).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(memoryRowCount(fx)).toBe(1);
    // The dedupe wrote nothing: still exactly one evidence entry.
    expect(fx.ops.queue.evidence.list().filter((e) => e.kind === 'memory_recorded').length).toBe(1);
  });

  it('a distinct client idempotencyKey makes two otherwise-identical records distinct', () => {
    const fx = memoryFixture();
    expectOk(fx.ops.recordMemory(note({ idempotencyKey: 'a' })));
    const result = fx.ops.recordMemory(note({ idempotencyKey: 'b' }));
    // The duplicate-CURRENT guard still refuses a second CURRENT record with
    // the same kind+project+title — the client key changes the DIGEST, not
    // the store's supersede discipline.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('memory_conflict');
  });
});

describe('recordMemory — authority gates, fail closed', () => {
  it('refuses unknown, worker, ungranted and system identity outright', () => {
    const fx = memoryFixture();
    const cases: { requestedBy: string; code: string }[] = [
      { requestedBy: 'nobody-registered', code: 'unknown_principal' },
      { requestedBy: 'claude', code: 'not_permitted' },
      { requestedBy: 'analyst', code: 'not_permitted' },
      { requestedBy: 'system', code: 'not_permitted' },
    ];
    for (const { requestedBy, code } of cases) {
      const result = fx.ops.recordMemory(note({ requestedBy }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code, requestedBy).toBe(code);
    }
    expect(memoryRowCount(fx)).toBe(0);
  });

  it('fails closed on a missing, altered or disabled capability row — and never repairs', () => {
    const fx = setupFixture(); // capability deliberately NOT registered
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [MEMORY_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const missing = fx.ops.recordMemory(note());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown_capability');

    registerMemoryCommandCapability(fx.db);
    fx.db
      .prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`)
      .run(MEMORY_COMMAND_CAPABILITY.id);
    const altered = fx.ops.recordMemory(note());
    expect(altered.ok).toBe(false);
    if (!altered.ok) expect(altered.error.code).toBe('not_permitted');
    // Detection never repaired the row.
    const row = fx.db
      .prepare(`SELECT side_effect FROM op_capabilities WHERE id = ?`)
      .get(MEMORY_COMMAND_CAPABILITY.id) as { side_effect: number };
    expect(row.side_effect).toBe(1);

    fx.db
      .prepare(`UPDATE op_capabilities SET side_effect = 0 WHERE id = ?`)
      .run(MEMORY_COMMAND_CAPABILITY.id);
    new CapabilityRegistry(fx.db).setEnabled(MEMORY_COMMAND_CAPABILITY.id, false);
    const disabled = fx.ops.recordMemory(note());
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('capability_disabled');
    expect(memoryRowCount(fx)).toBe(0);
  });
});

describe('recordMemory — entity references', () => {
  it('refuses refs that name no canonical row, after the authority gates', () => {
    const fx = memoryFixture();
    for (const [field, code] of [
      ['missionId', 'unknown_mission'],
      ['projectId', 'unknown_project'],
      ['taskId', 'unknown_task'],
    ] as const) {
      const result = fx.ops.recordMemory(note({ [field]: 'ghost' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code, field).toBe(code);
    }
    expect(memoryRowCount(fx)).toBe(0);
  });

  it('records mission-linked memory against a real commanded mission', () => {
    const fx = memoryFixture();
    registerMissionCommandCapability(fx.db);
    fx.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [MEMORY_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const { mission } = expectOk(
      fx.ops.commandMission({
        title: 'Faster QOS site',
        objective: 'Reduce page load times without changing the visual design',
        requestedBy: 'founder',
      }),
    );
    const { record } = expectOk(fx.ops.recordMemory(note({ missionId: mission.id })));
    expect(record.missionId).toBe(mission.id);
    expect(fx.ops.listMemory({ missionId: mission.id }).length).toBe(1);
  });
});

describe('recordMemory — summaries', () => {
  it('a summary must name real sources and leaves the originals byte-identical', () => {
    const fx = memoryFixture();
    const bare = fx.ops.recordMemory(note({ kind: 'summary', title: 'Wave summary' }));
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe('invalid_input');

    const phantom = fx.ops.recordMemory(
      note({ kind: 'summary', title: 'Wave summary', derivedFrom: ['no-such-record'] }),
    );
    expect(phantom.ok).toBe(false);
    if (!phantom.ok) expect(phantom.error.code).toBe('unknown_memory');

    const a = expectOk(fx.ops.recordMemory(note({ title: 'Note A' }))).record;
    const b = expectOk(fx.ops.recordMemory(note({ title: 'Note B' }))).record;
    const beforeA = fx.db.prepare(`SELECT * FROM hq_memory WHERE id = ?`).get(a.id);
    const summary = expectOk(
      fx.ops.recordMemory(
        note({ kind: 'summary', title: 'Both notes, compressed', derivedFrom: [a.id, b.id] }),
      ),
    ).record;
    expect(summary.kind).toBe('summary');
    expect(summary.derivedFrom).toEqual([a.id, b.id]);
    // The summary is a NEW record; its sources are retained untouched.
    expect(fx.db.prepare(`SELECT * FROM hq_memory WHERE id = ?`).get(a.id)).toEqual(beforeA);
    expect(fx.ops.getMemoryRecord(a.id)!.status).toBe('CURRENT');
  });
});

describe('recordMemory — supersession is the only change', () => {
  it('supersedes an existing CURRENT record atomically', () => {
    const fx = memoryFixture();
    const a = expectOk(fx.ops.recordMemory(note())).record;
    const b = expectOk(
      fx.ops.recordMemory(note({ body: 'Line 2 may automate after QC gate v2.', supersedes: a.id })),
    ).record;
    const aAfter = fx.ops.getMemoryRecord(a.id)!;
    expect(aAfter.status).toBe('SUPERSEDED');
    expect(aAfter.supersededBy).toEqual([b.id]);
    expect(b.supersedes).toBe(a.id);
    expect(b.status).toBe('CURRENT');
    // The predecessor's content was NOT rewritten.
    expect(aAfter.body).toBe('Do not automate line 2 until the QC gate is live.');
  });

  it('refuses superseding an unknown or non-CURRENT record, typed', () => {
    const fx = memoryFixture();
    const unknown = fx.ops.recordMemory(note({ supersedes: 'ghost' }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_memory');

    const a = expectOk(fx.ops.recordMemory(note())).record;
    expectOk(fx.ops.recordMemory(note({ body: 'v2', supersedes: a.id })));
    const again = fx.ops.recordMemory(note({ body: 'v3 over a dead row', supersedes: a.id }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('memory_conflict');
  });

  it('a record cannot be born SUPERSEDED', () => {
    const fx = memoryFixture();
    const result = fx.ops.recordMemory(note({ status: 'SUPERSEDED' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/earned/);
  });
});

describe('recordMemory — secret safety and bounds', () => {
  it('refuses secret-like content before anything persists', () => {
    const fx = memoryFixture();
    const result = fx.ops.recordMemory(
      note({ body: 'Set api_key = wJalrXUtnFEMIK7MDENGbPxRfiCY before the run' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(memoryRowCount(fx)).toBe(0);
    expect(fx.ops.queue.evidence.list().filter((e) => e.kind === 'memory_recorded').length).toBe(0);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_events WHERE subject_id LIKE 'memory:%'`).get()).toEqual({ n: 0 });
  });

  it('refuses over-bound and malformed fields with the vocabulary named', () => {
    const fx = memoryFixture();
    const long = fx.ops.recordMemory(note({ title: 'x'.repeat(201) }));
    expect(long.ok).toBe(false);
    const badKind = fx.ops.recordMemory(note({ kind: 'vibe' }));
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.error.message).toContain('founder_note');
    const badRelated = fx.ops.recordMemory(note({ related: { branches: ['x'] } }));
    expect(badRelated.ok).toBe(false);
    if (!badRelated.ok) expect(badRelated.error.message).toContain('related.branches');
    expect(memoryRowCount(fx)).toBe(0);
  });
});

describe('memory reads', () => {
  it('listMemory filters and orders newest-first; zero is zero', () => {
    const fx = memoryFixture();
    expect(fx.ops.listMemory()).toEqual([]);
    expectOk(fx.ops.recordMemory(note({ title: 'First', recorded: { date: '2026-09-01', confidence: 'exact' } })));
    expectOk(fx.ops.recordMemory(note({ title: 'Second', recorded: { date: '2026-09-05', confidence: 'exact' } })));
    const all = fx.ops.listMemory();
    expect(all.map((r) => r.title)).toEqual(['Second', 'First']);
    expect(fx.ops.listMemory({ kind: 'summary' })).toEqual([]);
  });

  it('searchMemoryRecords rides the existing archive engine and returns memory views', () => {
    const fx = memoryFixture();
    expectOk(fx.ops.recordMemory(note({ title: 'Iodine dosing decision', kind: 'decision' })));
    expectOk(fx.ops.recordMemory(note({ title: 'Packaging note' })));
    const { hits, total } = fx.ops.searchMemoryRecords({ text: 'iodine' });
    expect(total).toBe(1);
    expect(hits[0].record.title).toBe('Iodine dosing decision');
    expect(fx.ops.searchMemoryRecords({ text: 'nonexistent-term' }).total).toBe(0);
  });
});
