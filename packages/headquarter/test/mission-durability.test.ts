/**
 * Missions survive a real close-and-reopen of the canonical database file
 * (Phase 3, issue #254 — the restart/durable-persistence evidence).
 *
 * Deliberately a FILE database, not `:memory:`: the property under test is
 * that a commanded mission, its immutable intent history, its plan and its
 * lifecycle land in the one SQLite file the persistence boundary protects,
 * and are read back identically by a brand-new `HeadquarterOperations` after
 * the first connection is fully closed. Runs on every OS — the full-process
 * variant (apps/hq-server/test/durable-persistence.test.ts) stays
 * Linux-gated because it attests a durable mount; this one proves the
 * mission tables themselves.
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

describe('mission durability across a full close and reopen', () => {
  it('reopens the same canonical mission state a fresh service instance', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-mission-durability-'));
    const path = join(dir, 'headquarter.sqlite');

    // The configuration acts happen on their own connection first — a
    // separate, deliberate step, exactly as a real deployment performs them.
    const configDb = openHqDatabase(path);
    registerMissionCommandCapability(configDb);
    new HumanPrincipalRegistry(configDb).register({
      id: FOUNDER,
      displayName: 'Durability Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    configDb.close();

    const writer = openOps(path);
    const commanded = writer.ops.commandMission({
      title: 'Improve QOS website speed',
      objective: 'Reduce QOS page load times without changing the visual design',
      constraints: ['Do not change the visual design', 'Do not deploy production'],
      acceptanceCriteria: ['Median page load under 2 seconds'],
      planItems: ['Measure current load times', 'Optimize the slowest pages'],
      priority: 'high',
      instruction: 'Improve the QOS website speed without changing the visual design.',
      requestedBy: FOUNDER,
    });
    if (!commanded.ok) throw new Error(commanded.error.message);
    const id = commanded.data.mission.id;
    const amended = writer.ops.amendMissionIntent({
      missionId: id,
      amendment: 'Focus the first pass on the landing page.',
      addPlanItems: ['Profile the landing page'],
      requestedBy: FOUNDER,
    });
    if (!amended.ok) throw new Error(amended.error.message);
    const moved = writer.ops.transitionMission({ missionId: id, to: 'working', requestedBy: FOUNDER });
    if (!moved.ok) throw new Error(moved.error.message);
    const before = writer.ops.getMission(id)!;
    const beforeIntents = writer.ops.getMissionIntentHistory(id);
    writer.close();

    // Session two: a brand-new service instance over the same file.
    const reader = openOps(path);
    const after = reader.ops.getMission(id);
    expect(after).toEqual(before);
    expect(after!.status).toBe('working');
    expect(after!.planItems.map((item) => item.summary)).toEqual([
      'Measure current load times',
      'Optimize the slowest pages',
      'Profile the landing page',
    ]);
    // The intent lock survives byte-identical, raw order included.
    const intents = reader.ops.getMissionIntentHistory(id);
    expect(intents).toEqual(beforeIntents);
    expect(intents[0]!.body).toContain(
      'Improve the QOS website speed without changing the visual design.',
    );
    // And idempotency survives: the identical re-command dedupes, not duplicates.
    const again = reader.ops.commandMission({
      title: 'Improve QOS website speed',
      objective: 'Reduce QOS page load times without changing the visual design',
      constraints: ['Do not change the visual design', 'Do not deploy production'],
      acceptanceCriteria: ['Median page load under 2 seconds'],
      planItems: ['Measure current load times', 'Optimize the slowest pages'],
      priority: 'high',
      instruction: 'Improve the QOS website speed without changing the visual design.',
      requestedBy: FOUNDER,
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.data.deduplicated).toBe(true);
    expect(again.data.mission.id).toBe(id);
    expect(reader.ops.listMissions()).toHaveLength(1);
    reader.close();
  });

  it('refuses an invalid transition identically after the restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-mission-durability-'));
    const path = join(dir, 'headquarter.sqlite');
    const configDb = openHqDatabase(path);
    registerMissionCommandCapability(configDb);
    new HumanPrincipalRegistry(configDb).register({
      id: FOUNDER,
      displayName: 'Durability Founder',
      originateCapabilities: [MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    configDb.close();

    const writer = openOps(path);
    const commanded = writer.ops.commandMission({
      title: 'T',
      objective: 'O',
      requestedBy: FOUNDER,
    });
    if (!commanded.ok) throw new Error(commanded.error.message);
    writer.close();

    const reader = openOps(path);
    const illegal = reader.ops.transitionMission({
      missionId: commanded.data.mission.id,
      to: 'complete',
      requestedBy: FOUNDER,
    });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error.code).toBe('invalid_mission_transition');
    expect(reader.ops.getMission(commanded.data.mission.id)!.status).toBe('planned');
    reader.close();
  });
});
