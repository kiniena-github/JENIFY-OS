/**
 * Phase 7 — the truth graph survives a real close-and-reopen of the
 * canonical database file, and a read-only handle over a pre-Phase-7 file
 * observes absence truthfully instead of migrating.
 *
 * A FILE database, not `:memory:`: the property under test is that a claim,
 * its verification, its Founder acceptance, its contradiction and its
 * supersession all land in the one SQLite file the persistence boundary
 * protects, and are derived identically by a brand-new service instance
 * after the first connection is fully closed — with every authority rule
 * (self-verify, digest binding, one acceptance) refusing identically.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  ensureTruthSchema,
  registerTruthRecordCapability,
  registerTruthVerifyCapability,
  truthSchemaPresent,
} from '../src/application/truth-command.js';
import { expectOk } from './application.fixture.js';

const FOUNDER = 'durability-founder';
const COO = 'durability-coo';
const CAP = 'repo.read_status';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string) {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  return { ops, db, close: () => db.close() };
}

function configure(path: string): void {
  const configDb = openHqDatabase(path);
  registerTruthRecordCapability(configDb);
  registerTruthVerifyCapability(configDb);
  new CapabilityRegistry(configDb).register({
    id: CAP,
    description: 'Read repo/CI status',
    riskClass: 'read_only',
    sideEffect: false,
    idempotent: true,
  });
  const principals = new HumanPrincipalRegistry(configDb);
  principals.register({
    id: FOUNDER,
    displayName: 'Durability Founder',
    originateCapabilities: [CAP, TRUTH_RECORD_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  principals.register({
    id: COO,
    displayName: 'Durability COO',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  const store = new HeadquarterStore(configDb);
  store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAP, TRUTH_RECORD_CAPABILITY.id],
    active: true,
  });
  store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: [CAP, TRUTH_VERIFY_CAPABILITY.id],
    active: true,
  });
  configDb.close();
}

describe('truth across a full close and reopen', () => {
  it('reopens the identical derived graph and refuses identically', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-truth-durability-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);

    const writer = openOps(path);
    const task = expectOk(
      writer.ops.createTask({ capabilityId: CAP, payload: { check: 'ci' }, idempotencyKey: 'd-1', requestedBy: 'claude' }),
    ).task;
    const evidenceId = writer.ops.queue.evidence.list(task.id)[0]!.id;
    const claim = expectOk(
      writer.ops.recordTruth({
        entityKind: 'task',
        entityId: task.id,
        statement: 'CI is green.',
        evidenceRefs: [evidenceId],
        requestedBy: 'claude',
      }),
    ).record;
    const verified = expectOk(
      writer.ops.verifyTruth({
        truthId: claim.id,
        method: 'inspected_evidence',
        verdict: 'confirmed',
        evidenceRefs: [evidenceId],
        limitations: 'Evidence entry only.',
        requestedBy: 'codex',
      }),
    ).record;
    const accepted = expectOk(
      writer.ops.acceptTruth({ truthId: claim.id, expectedDigest: verified.acceptanceDigest!, requestedBy: FOUNDER }),
    ).record;
    expect(accepted.state).toBe('accepted');
    const rival = expectOk(
      writer.ops.recordTruth({
        entityKind: 'task',
        entityId: task.id,
        statement: 'CI is red.',
        contradicts: [claim.id],
        requestedBy: 'claude',
      }),
    ).record;
    const before = writer.ops.getEntityTruth('task', task.id);
    const beforeAll = writer.ops.listTruth();
    const beforeContradictions = writer.ops.listTruthContradictions();
    writer.close();

    // Session two: a brand-new service instance over the same file.
    const reader = openOps(path);
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"asOf":"[^"]*"/g, '"asOf":"T"')) as unknown;
    expect(strip(reader.ops.getEntityTruth('task', task.id))).toEqual(strip(before));
    expect(reader.ops.listTruth()).toEqual(beforeAll);
    expect(reader.ops.listTruthContradictions()).toEqual(beforeContradictions);
    const after = reader.ops.getTruthRecord(claim.id)!;
    expect(after.state).toBe('accepted');
    expect(after.contested).toBe(true);
    expect(after.acceptances[0]!.acceptedBy).toBe(FOUNDER);
    expect(after.verifications[0]!.verifiedBy).toBe('codex');
    expect(reader.ops.getTruthRecord(rival.id)!.contradictions[0]!.resolution).toBe('unresolved');
    // The rules refuse identically after the restart.
    const selfVerify = reader.ops.verifyTruth({
      truthId: rival.id,
      method: 'reviewed',
      verdict: 'confirmed',
      evidenceRefs: [evidenceId],
      limitations: 'none known',
      requestedBy: 'claude',
    });
    expect(selfVerify.ok).toBe(false);
    const secondAcceptor = reader.ops.acceptTruth({ truthId: claim.id, expectedDigest: 'x', requestedBy: COO });
    expect(secondAcceptor.ok).toBe(false);
    if (!secondAcceptor.ok) expect(secondAcceptor.error.code).toBe('truth_conflict');
    // Idempotency survives: the identical re-record dedupes onto the stored row.
    const again = reader.ops.recordTruth({
      entityKind: 'task',
      entityId: task.id,
      statement: 'CI is green.',
      evidenceRefs: [evidenceId],
      requestedBy: 'claude',
    });
    expect(again.ok && again.data.deduplicated && again.data.record.id === claim.id).toBe(true);
    expect(reader.ops.queue.evidence.verifyChain()).toBeNull();
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM hq_truth_records`).get() as { n: number }).n).toBe(2);
    reader.close();
  });

  it('a read-only handle over a pre-Phase-7 file observes absence; nothing is migrated', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-truth-readonly-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = openHqDatabase(path);
    void new HeadquarterOperations(writer, {});
    writer.exec(`
      DROP TABLE IF EXISTS hq_truth_acceptances;
      DROP TABLE IF EXISTS hq_truth_verifications;
      DROP TABLE IF EXISTS hq_truth_relations;
      DROP TABLE IF EXISTS hq_truth_records;
    `);
    writer.close();

    const readOnly = openHqDatabaseReadOnly(path);
    expect(() => ensureTruthSchema(readOnly)).not.toThrow();
    expect(truthSchemaPresent(readOnly)).toBe(false);
    const ops = new HeadquarterOperations(readOnly, {});
    expect(ops.truthStorePresent()).toBe(false);
    expect(ops.listTruth()).toEqual([]);
    expect(ops.getTruthRecord('anything')).toBeNull();
    expect(ops.listTruthContradictions()).toEqual([]);
    expect(ops.truthSummary({ includeFounderOnly: true }).total).toBe(0);
    readOnly.close();

    const check = openHqDatabase(path);
    expect(
      check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_truth_records'`).get(),
    ).toBeUndefined();
    check.close();
  });
});
