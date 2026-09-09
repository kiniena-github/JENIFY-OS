/**
 * Shared fixture for the Phase 13 Advanced Reliability suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up.
 *
 * Builds on the lane-F application fixture — which already carries the Founder,
 * the approval-authority-only `coo`, the grantless `analyst`, four workers and
 * the four capabilities — and adds only what a reliability suite needs:
 *
 *  - `hq.reliability_command` registered and granted to the Founder, so the
 *    two Founder acts of the phase (assess, record a verified backup) are
 *    reachable; both switches are available so the fail-closed halves can be
 *    proven too;
 *  - a helper that walks a real task to a live fenced claim, because run
 *    writes are authorized by exactly that claim and nothing else;
 *  - a FILE-backed variant, because the crash/restart, two-connection and
 *    raw-writer proofs cannot be made against `:memory:` — an in-memory
 *    database has no second connection and no file for another process to
 *    open.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openHqDatabase, type HqDatabase } from '../src/store/db.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  registerReliabilityCommandCapability,
} from '../src/application/reliability-command.js';

export interface ReliabilityFixture extends Fixture {
  /** A live fenced claim on a SIDE-EFFECT capability (`CAPS.openPr`, idempotent). */
  claim: { taskId: string; workerId: string; fence: number };
  /** A live fenced claim on a READ-ONLY capability (`CAPS.readStatus`, no side effect). */
  readOnlyClaim: { taskId: string; workerId: string; fence: number };
}

/**
 * `registerReliability: false` leaves `hq.reliability_command` unregistered so
 * a suite can prove the capability gate fails closed; `grantReliability:
 * false` registers it but withholds the Founder's originate grant, which is
 * the other half of the same fail-closed pair.
 */
export function reliabilityFixture(
  options: { registerReliability?: boolean; grantReliability?: boolean } = {},
): ReliabilityFixture {
  const fx = setupFixture();
  if (options.registerReliability !== false) registerReliabilityCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      CAPS.indexDoc,
      ...(options.grantReliability === false ? [] : [RELIABILITY_COMMAND_CAPABILITY.id]),
    ],
    approvalAuthority: true,
    active: true,
  });

  return {
    ...fx,
    claim: claimSideEffectTask(fx, 'rel-side-effect'),
    readOnlyClaim: claimReadOnlyTask(fx, 'rel-read-only'),
  };
}

/**
 * A task on the pre-approved, idempotent, SIDE-EFFECT capability, walked to a
 * live fenced claim held by `claude`. `openPr` is pre-approved by the
 * fixture's policy context, so this needs no Founder approval step and the
 * claim is the only authority in play — which is exactly what the run writes
 * are supposed to rest on.
 */
export function claimSideEffectTask(
  fx: Fixture,
  idempotencyKey: string,
): { taskId: string; workerId: string; fence: number } {
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: idempotencyKey },
      idempotencyKey,
      requestedBy: 'claude',
    }),
  );
  const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr, undefined, created.task.id));
  return { taskId: claimed.id, workerId: 'claude', fence: claimed.fence };
}

/** The same, on the read-only capability — a run on it can never be uncertain. */
export function claimReadOnlyTask(
  fx: Fixture,
  label: string,
): { taskId: string; workerId: string; fence: number } {
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { repo: label },
      requestedBy: 'claude',
    }),
  );
  const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, created.task.id));
  return { taskId: claimed.id, workerId: 'claude', fence: claimed.fence };
}

export interface FileFixture {
  dir: string;
  dbPath: string;
  db: HqDatabase;
  ops: HeadquarterOperations;
  store: HeadquarterStore;
  principals: HumanPrincipalRegistry;
  claim: { taskId: string; workerId: string; fence: number };
  /** Build a SECOND facade over the same file, optionally as another process. */
  reopen(processIdentity?: string): { db: HqDatabase; ops: HeadquarterOperations };
  /** A RAW better-sqlite3 connection that never ran the application's code. */
  raw(): HqDatabase;
  cleanup(): void;
}

/**
 * A real HQ database in a real temporary directory.
 *
 * Everything the phase claims about crashes, second processes, raw writers and
 * backup files is a claim about a FILE, so the suites that prove those claims
 * use one. The directory is removed by `cleanup`.
 */
export function fileFixture(
  options: { processIdentity?: string } = {},
): FileFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-reliability-'));
  const dbPath = path.join(dir, 'headquarter.sqlite');
  const opened: HqDatabase[] = [];

  const build = (processIdentity?: string): { db: HqDatabase; ops: HeadquarterOperations } => {
    const db = openHqDatabase(dbPath);
    opened.push(db);
    const store = new HeadquarterStore(db);
    const ops = new HeadquarterOperations(db, {
      store,
      policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
      processIdentity,
    });
    return { db, ops };
  };

  const first = build(options.processIdentity ?? 'process-one');
  const store = new HeadquarterStore(first.db);
  new CapabilityRegistry(first.db).register({
    id: CAPS.openPr,
    description: 'Open a branch-isolated PR',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: true,
  });
  new CapabilityRegistry(first.db).register({
    id: CAPS.readStatus,
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  registerReliabilityCommandCapability(first.db);
  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr],
    active: true,
  });
  const principals = new HumanPrincipalRegistry(first.db);
  principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, CAPS.openPr, RELIABILITY_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  principals.register({
    id: 'coo',
    displayName: 'Chief Operating Officer',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });

  const created = expectOk(
    first.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'file-fixture' },
      idempotencyKey: 'file-fixture',
      requestedBy: 'claude',
    }),
  );
  const claimed = expectOk(
    first.ops.claimNext('claude', CAPS.openPr, 60 * 60_000, created.task.id),
  );

  return {
    dir,
    dbPath,
    db: first.db,
    ops: first.ops,
    store,
    principals,
    claim: { taskId: claimed.id, workerId: 'claude', fence: claimed.fence },
    reopen: (processIdentity?: string) => build(processIdentity),
    raw: () => {
      const db = new Database(dbPath) as unknown as HqDatabase;
      opened.push(db);
      return db;
    },
    cleanup: () => {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // A double close is not a test failure.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
