/**
 * Company memory survives a real close-and-reopen of the canonical database
 * file (Phase 5, issue #265 — the restart/durable-persistence evidence).
 *
 * Deliberately a FILE database, not `:memory:` (the mission/project
 * durability precedent): a recorded memory, its provenance, its supersede
 * chain and its entity links land in the one SQLite file the persistence
 * boundary protects, and are read back identically by a brand-new
 * `HeadquarterOperations` after the first connection is fully closed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';

const FOUNDER = 'durability-founder';

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string): { ops: HeadquarterOperations; close: () => void } {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  return { ops, close: () => db.close() };
}

describe('memory durability across a full close and reopen', () => {
  it('reopens identical records, provenance, supersede chain and context', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-memory-durability-'));
    const path = join(dir, 'headquarter.sqlite');

    // The configuration acts happen on their own connection first — a
    // separate, deliberate step, exactly as a real deployment performs them.
    const configDb = openHqDatabase(path);
    registerMemoryCommandCapability(configDb);
    registerMissionCommandCapability(configDb);
    new HumanPrincipalRegistry(configDb).register({
      id: FOUNDER,
      displayName: 'Durability Founder',
      originateCapabilities: [MEMORY_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    configDb.close();

    const writer = openOps(path);
    const commanded = writer.ops.commandMission({
      title: 'Improve QOS website speed',
      objective: 'Reduce QOS page load times without changing the visual design',
      requestedBy: FOUNDER,
    });
    if (!commanded.ok) throw new Error(commanded.error.message);
    const missionId = commanded.data.mission.id;

    const noted = writer.ops.recordMemory({
      kind: 'founder_note',
      title: 'Landing page first',
      body: 'Profile the landing page before touching anything else.',
      project: 'QOS',
      missionId,
      tags: ['performance'],
      sourceRefs: ['docs/perf-baseline.md'],
      requestedBy: FOUNDER,
    });
    if (!noted.ok) throw new Error(noted.error.message);
    const superseded = writer.ops.recordMemory({
      kind: 'founder_note',
      title: 'Landing page first',
      body: 'Landing page AND the product list — both profiled before changes.',
      project: 'QOS',
      missionId,
      supersedes: noted.data.record.id,
      requestedBy: FOUNDER,
    });
    if (!superseded.ok) throw new Error(superseded.error.message);
    const summary = writer.ops.recordMemory({
      kind: 'summary',
      title: 'Perf scope, summarized',
      body: 'Scope: landing page and product list profiling precede all changes.',
      project: 'QOS',
      missionId,
      derivedFrom: [superseded.data.record.id],
      requestedBy: FOUNDER,
    });
    if (!summary.ok) throw new Error(summary.error.message);

    const beforeList = writer.ops.listMemory();
    const beforeContext = writer.ops.getMissionContext(missionId);
    if (!beforeContext.ok) throw new Error(beforeContext.error.message);
    writer.close();

    // Session two: a brand-new service instance over the same file.
    const reader = openOps(path);
    expect(reader.ops.listMemory()).toEqual(beforeList);

    const oldNote = reader.ops.getMemoryRecord(noted.data.record.id)!;
    expect(oldNote.status).toBe('SUPERSEDED');
    expect(oldNote.supersededBy).toEqual([superseded.data.record.id]);
    expect(oldNote.body).toBe('Profile the landing page before touching anything else.');
    expect(oldNote.recordedBy).toBe(FOUNDER);
    expect(oldNote.recorded.confidence).toBe('exact');
    expect(oldNote.missionId).toBe(missionId);
    expect(oldNote.sourceRefs).toEqual(['docs/perf-baseline.md']);

    const summaryAfter = reader.ops.getMemoryRecord(summary.data.record.id)!;
    expect(summaryAfter.kind).toBe('summary');
    expect(summaryAfter.derivedFrom).toEqual([superseded.data.record.id]);

    // Context assembly reproduces the same groups over the same file
    // (timestamps aside).
    const strip = (v: unknown) =>
      JSON.parse(JSON.stringify(v).replace(/"(asOf|assembledAt)":"[^"]*"/g, '"$1":"T"')) as unknown;
    const afterContext = reader.ops.getMissionContext(missionId);
    if (!afterContext.ok) throw new Error(afterContext.error.message);
    expect(strip(afterContext.data)).toEqual(strip(beforeContext.data));

    // Idempotency survives the restart: the identical re-record dedupes.
    const again = reader.ops.recordMemory({
      kind: 'summary',
      title: 'Perf scope, summarized',
      body: 'Scope: landing page and product list profiling precede all changes.',
      project: 'QOS',
      missionId,
      derivedFrom: [superseded.data.record.id],
      requestedBy: FOUNDER,
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.record.id).toBe(summary.data.record.id);
    expect(reader.ops.listMemory()).toHaveLength(3);

    // The engine hardening survived the reopen too.
    expect(() => {
      const raw = openHqDatabase(path);
      try {
        raw.prepare(`DELETE FROM hq_memory`).run();
      } finally {
        raw.close();
      }
    }).toThrow(/insert-only/);
    reader.close();
  });
});
