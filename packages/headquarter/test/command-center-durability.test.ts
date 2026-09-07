/**
 * Phase 10 durability: a real file closed and reopened, and a read-only
 * handle over a database that predates the brief ledger.
 *
 * Two things this proves that an in-memory suite cannot. First, the derived
 * command layer is a function of the canonical rows and of nothing held in
 * process memory: reopen the file and the same question gets the same answer,
 * including the receipts and their digests. Second, absence is OBSERVED, never
 * migrated: a read-only pre-Phase-10 file reports no ledger, refuses to issue
 * one, still answers every derived question from the stores it does have, and
 * is not written to.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  FOUNDER_BRIEF_CAPABILITY,
  briefSchemaPresent,
  ensureBriefSchema,
  registerFounderBriefCapability,
} from '../src/application/chief-of-staff.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { expectOk } from './application.fixture.js';

const CAP = 'archive.index_document';
const FOUNDER = 'founder';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openHq(path: string): { db: ReturnType<typeof openHqDatabase>; ops: HeadquarterOperations; close(): void } {
  const db = openHqDatabase(path);
  const store = new HeadquarterStore(db);
  const ops = new HeadquarterOperations(db, { store });
  return { db, ops, close: () => db.close() };
}

function seed(path: string): { ops: HeadquarterOperations; close(): void; db: ReturnType<typeof openHqDatabase> } {
  const hq = openHq(path);
  new CapabilityRegistry(hq.db).register({
    id: CAP,
    description: 'Index a document into the archive',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: false,
  });
  registerFounderBriefCapability(hq.db);
  new HumanPrincipalRegistry(hq.db).register({
    id: FOUNDER,
    displayName: 'Founder',
    originateCapabilities: [CAP, FOUNDER_BRIEF_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  new HeadquarterStore(hq.db).upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAP],
    active: true,
  });
  return hq;
}

describe('the derived command layer survives a real close and reopen', () => {
  it('answers identically after the process is gone, and keeps every receipt with its digest', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-command-center-'));
    const path = join(dir, 'headquarter.sqlite');

    const writer = seed(path);
    expectOk(
      writer.ops.createTask({
        capabilityId: CAP,
        payload: { doc: 'runbook' },
        idempotencyKey: 'cc-durable',
        requestedBy: 'claude',
        title: 'Index the runbook',
      }),
    );
    const brief = expectOk(writer.ops.issueBrief({ requestedBy: FOUNDER })).brief;
    const inboxBefore = writer.ops.founderInbox({ includeFounderOnly: true });
    const summaryBefore = writer.ops.commandCenterSummary({ includeFounderOnly: true });
    const briefsBefore = writer.ops.listBriefs();
    expect(inboxBefore.items.map((item) => item.reason)).toContain('task_awaiting_approval');
    writer.close();

    const reader = openHq(path);
    expect(reader.ops.briefStorePresent()).toBe(true);
    // The clock is the only thing that legitimately differs between two reads.
    const inboxAfter = reader.ops.founderInbox({ includeFounderOnly: true });
    expect(inboxAfter.items).toEqual(inboxBefore.items);
    expect(inboxAfter.byKind).toEqual(inboxBefore.byKind);
    expect(inboxAfter.total).toBe(inboxBefore.total);
    expect(reader.ops.commandCenterSummary({ includeFounderOnly: true })).toEqual(summaryBefore);
    expect(reader.ops.listBriefs()).toEqual(briefsBefore);
    expect(reader.ops.getBrief(brief.id)).toEqual(brief);
    expect(reader.ops.getBrief('brief-that-never-existed')).toBeNull();

    // The rules refuse identically after the restart, and the receipt still
    // deduplicates because nothing but the receipt itself was appended.
    expect(expectOk(reader.ops.issueBrief({ requestedBy: FOUNDER })).deduplicated).toBe(true);
    const refused = reader.ops.issueBrief({ requestedBy: 'claude' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('not_permitted');
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM hq_briefs`).get() as { n: number }).n).toBe(1);
    expect(reader.ops.queue.evidence.verifyChain()).toBeNull();
    reader.close();
  });

  it('measures the next brief’s delta from the receipt the previous process wrote', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-command-center-delta-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = seed(path);
    const first = expectOk(writer.ops.issueBrief({ requestedBy: FOUNDER })).brief;
    writer.close();

    const reader = openHq(path);
    expect(reader.ops.founderBriefing({ includeFounderOnly: true }).changed.since).toEqual({
      briefId: first.id,
      issuedAt: first.issuedAt,
      watermark: first.watermark,
    });
    expectOk(
      reader.ops.createTask({
        capabilityId: CAP,
        payload: { doc: 'after-restart' },
        idempotencyKey: 'cc-after-restart',
        requestedBy: 'claude',
      }),
    );
    const second = expectOk(reader.ops.issueBrief({ requestedBy: FOUNDER }));
    expect(second.deduplicated).toBe(false);
    expect(second.brief.watermark.evidenceSeq).toBeGreaterThan(first.watermark.evidenceSeq);
    expect(second.brief.counts.attention.total).toBeGreaterThan(first.counts.attention.total);
    reader.close();
  });
});

describe('a read-only handle over a pre-Phase-10 file observes absence and migrates nothing', () => {
  it('reports no ledger, refuses to issue one, still derives every question, and states the absence on the snapshot', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-command-center-readonly-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = seed(path);
    expectOk(
      writer.ops.createTask({
        capabilityId: CAP,
        payload: { doc: 'runbook' },
        idempotencyKey: 'cc-readonly',
        requestedBy: 'claude',
        title: 'Index the runbook',
      }),
    );
    writer.db.exec(`DROP TABLE IF EXISTS hq_briefs;`);
    writer.close();

    const readOnly = openHqDatabaseReadOnly(path);
    expect(() => ensureBriefSchema(readOnly)).not.toThrow();
    expect(briefSchemaPresent(readOnly)).toBe(false);
    const ops = new HeadquarterOperations(readOnly, {});
    expect(ops.briefStorePresent()).toBe(false);
    expect(ops.listBriefs()).toEqual({ briefs: [], total: 0, truncated: false });
    expect(ops.getBrief('anything')).toBeNull();

    // The derived layer does NOT depend on the ledger: the canonical stores
    // are still there, so every question is still answered truthfully.
    const inbox = ops.founderInbox({ includeFounderOnly: true });
    expect(inbox.items.map((item) => item.reason)).toContain('task_awaiting_approval');
    const briefing = ops.founderBriefing({ includeFounderOnly: true });
    expect(briefing.briefs).toEqual({ total: 0, latest: null });
    expect(briefing.changed.since).toBeNull();
    expect(briefing.unknown.storesAbsent).toContain('briefs');
    const issueAct = briefing.safeNext.acts.find((act) => act.act === 'issue_founder_brief')!;
    expect(issueAct.safe).toBe(false);
    expect(issueAct.blockers).toEqual(['the brief ledger is absent on this database handle']);

    // Issuing is refused, and refusing writes nothing through a read-only handle.
    const refused = ops.issueBrief({ requestedBy: FOUNDER });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('invalid_input');

    const snapshot = liveSnapshotFromOperations(ops, { now: '2026-09-07T12:00:00.000Z' });
    expect(snapshot.commandCenter!.data.storePresent).toBe(false);
    expect(snapshot.commandCenter!.data.briefs).toEqual({ total: 0, latest: null });
    expect(snapshot.commandCenter!.data.attention.total).toBeGreaterThan(0);
    expect(snapshot.commandCenter!.provenance.note).toContain('hq_briefs ledger does not exist');
    readOnly.close();

    const check = openHqDatabase(path);
    expect(
      check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_briefs'`).get(),
    ).toBeUndefined();
    check.close();
  });
});
