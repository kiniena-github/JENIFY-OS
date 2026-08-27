/**
 * Shared fixture for the HQ lane F (issue #139) application-layer test
 * suites.
 *
 * Lives outside the `*.test.ts` glob on purpose: importing a fixture from a
 * test file would re-collect that file's own suites in every importer.
 */

import { expect } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../../src/store/db.js';
import { HeadquarterStore } from '../../src/store/headquarter.js';
import { OperatorQueue } from '../../src/operator/queue.js';
import {
  createHeadquarterOperations,
  GroupRoomService,
  type HeadquarterOperationsService,
} from '../../src/application/index.js';

export interface Harness {
  db: HqDatabase;
  store: HeadquarterStore;
  queue: OperatorQueue;
  ops: HeadquarterOperationsService;
  rooms: GroupRoomService;
}

/**
 * Shared fixture: three capabilities across the risk spectrum and four
 * directory specialists with deliberately different allow-lists.
 */
export function makeHarness(): Harness {
  const db = openMemoryHqDatabase();
  const store = new HeadquarterStore(db);
  const queue = new OperatorQueue(db, { preApprovedCapabilities: new Set(['repo.read_status']) });

  queue.capabilities.register({
    id: 'repo.read_status',
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  queue.capabilities.register({
    id: 'github.open_pr',
    description: 'Open a branch-isolated PR',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: true,
  });
  queue.capabilities.register({
    id: 'infra.delete_bucket',
    description: 'Destructive infrastructure action',
    riskClass: 'destructive',
    sideEffect: true,
    idempotent: false,
  });

  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: ['repo.read_status', 'github.open_pr', 'infra.delete_bucket'],
    active: true,
  });
  store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: ['repo.read_status'],
    active: true,
  });
  store.upsertSpecialist({
    id: 'jules',
    displayName: 'Jules',
    vendor: 'google',
    role: 'parallel_implementer',
    allowedCapabilities: ['repo.read_status'],
    active: true,
  });
  store.upsertSpecialist({
    id: 'idle-bot',
    displayName: 'Idle Bot',
    vendor: 'internal',
    role: 'specialist_tool',
    allowedCapabilities: [],
    active: true,
  });

  const ops = createHeadquarterOperations({
    db,
    store,
    queue,
    policyContext: { preApprovedCapabilities: new Set(['repo.read_status']) },
  });
  const rooms = new GroupRoomService(db, ops);
  return { db, store, queue, ops, rooms };
}

/** Drive a side-effect task to the point where a worker holds it and has started. */
export function claimAndStart(
  h: Harness,
  taskId: string,
  workerId: string,
  capabilityId: string,
): { fence: number } {
  const claimed = h.ops.claimNext(workerId, capabilityId);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.error.code} ${claimed.error.message}`);
  expect(claimed.data.id).toBe(taskId);
  const started = h.ops.start(taskId, workerId, claimed.data.fence);
  if (!started.ok) throw new Error(`start failed: ${started.error.code} ${started.error.message}`);
  return { fence: claimed.data.fence };
}
