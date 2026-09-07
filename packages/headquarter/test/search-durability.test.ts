/**
 * Phase 11 durability: a real file closed and reopened, and a read-only handle
 * over a database that predates the stores search reads.
 *
 * Two things this proves that an in-memory suite cannot. First, search and Ask
 * Jenify are functions of the canonical rows and of nothing held in process
 * memory: reopen the file and the same query and the same question get the
 * same answer, term for term and citation for citation. Second, absence is
 * OBSERVED, never migrated: a read-only pre-Phase-5/7/9 file reports those
 * sources absent, still answers from the stores it does have, never claims 0
 * means empty, and is not written to — not even by a query that finds nothing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { MEMORY_COMMAND_CAPABILITY, registerMemoryCommandCapability } from '../src/application/memory-command.js';
import { expectOk } from './application.fixture.js';
import type { AskAnswerView, CompanySearchView } from '../src/application/search-command.js';

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

function seed(path: string): { db: ReturnType<typeof openHqDatabase>; ops: HeadquarterOperations; close(): void } {
  const hq = openHq(path);
  new CapabilityRegistry(hq.db).register({
    id: CAP,
    description: 'Index a document into the archive',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: false,
  });
  registerMemoryCommandCapability(hq.db);
  new HumanPrincipalRegistry(hq.db).register({
    id: FOUNDER,
    displayName: 'Founder',
    originateCapabilities: [CAP, MEMORY_COMMAND_CAPABILITY.id],
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

/** Everything but the clock — the part of an answer a restart must not move. */
function stableAnswer(answer: AskAnswerView): string {
  return JSON.stringify({ ...answer, askedAt: null });
}
function stableSearch(result: CompanySearchView): string {
  return JSON.stringify({ ...result, searchedAt: null });
}

describe('search and Ask Jenify survive a real close and reopen', () => {
  it('answers identically after the process is gone', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-search-'));
    const path = join(dir, 'headquarter.sqlite');

    const writer = seed(path);
    expectOk(
      writer.ops.recordMemory({
        kind: 'decision',
        title: 'Rhodium retention policy',
        body: 'Rhodium logs are retained for ninety days and then deleted.',
        project: 'ops',
        requestedBy: FOUNDER,
      }),
    );
    expectOk(
      writer.ops.recordMemory({
        kind: 'founder_note',
        title: 'Rhodium supplier note',
        body: 'The rhodium supplier renegotiation is Founder-only.',
        project: 'ops',
        privacy: 'founder_only',
        requestedBy: FOUNDER,
      }),
    );
    const searchBefore = expectOk(writer.ops.searchCompany({ text: 'rhodium' }, { includeFounderOnly: true }));
    const guardedBefore = expectOk(writer.ops.searchCompany({ text: 'rhodium' }, {}));
    const answerBefore = expectOk(
      writer.ops.askJenify({ question: 'What is the rhodium retention policy?', includeFounderOnly: true }),
    );
    const registryBefore = writer.ops.searchIndexSummary();
    expect(searchBefore.total).toBe(2);
    expect(guardedBefore.total).toBe(1);
    expect(guardedBefore.withheldFounderOnly).toBe(1);
    expect(answerBefore.state).toBe('grounded');
    writer.close();

    const reader = openHq(path);
    expect(
      stableSearch(expectOk(reader.ops.searchCompany({ text: 'rhodium' }, { includeFounderOnly: true }))),
    ).toBe(stableSearch(searchBefore));
    expect(stableSearch(expectOk(reader.ops.searchCompany({ text: 'rhodium' }, {})))).toBe(
      stableSearch(guardedBefore),
    );
    expect(
      stableAnswer(
        expectOk(reader.ops.askJenify({ question: 'What is the rhodium retention policy?', includeFounderOnly: true })),
      ),
    ).toBe(stableAnswer(answerBefore));
    expect(reader.ops.searchIndexSummary()).toEqual(registryBefore);
    // The chain is intact, because nothing appended to it.
    expect(reader.ops.queue.evidence.verifyChain()).toBeNull();
    reader.close();
  });

  it('appends nothing to the file across a whole session of queries', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-search-nowrite-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = seed(path);
    expectOk(
      writer.ops.recordMemory({
        kind: 'decision',
        title: 'Iridium rollout',
        body: 'The iridium rollout is staged over two weeks.',
        project: 'ops',
        requestedBy: FOUNDER,
      }),
    );
    const before = {
      events: (writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_events`).get() as { n: number }).n,
      evidence: (writer.db.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n,
      memory: (writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n,
    };
    for (let i = 0; i < 25; i += 1) {
      expectOk(writer.ops.searchCompany({ text: `iridium ${i}` }, { includeFounderOnly: true }));
      expectOk(writer.ops.askJenify({ question: `What about iridium batch ${i}?`, includeFounderOnly: true }));
    }
    expect({
      events: (writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_events`).get() as { n: number }).n,
      evidence: (writer.db.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n,
      memory: (writer.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n,
    }).toEqual(before);
    writer.close();
  });
});

describe('a read-only handle over a file that predates these stores', () => {
  it('observes each source’s absence, answers from the stores it has, and is never written to', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-search-readonly-'));
    const path = join(dir, 'headquarter.sqlite');

    // A file that predates the later phases: seeded normally, then the three
    // CLASSIFIED stores are dropped — which is what an older deployment's file
    // genuinely looks like from this code's point of view. Dropping is the
    // Phase 10 durability suite's own recipe for the same question.
    const writer = seed(path);
    writer.db.exec(`DROP TABLE IF EXISTS hq_memory;`);
    writer.db.exec(`DROP TABLE IF EXISTS hq_truth_records;`);
    writer.db.exec(`DROP TABLE IF EXISTS hq_collab_sessions;`);
    writer.close();

    const before = statSync(path);
    const db = openHqDatabaseReadOnly(path);
    const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });

    const registry = ops.searchIndexSummary();
    const absent = registry.sources.filter((source) => !source.storePresent).map((source) => source.id);
    // Absence is OBSERVED. Each of these reports 0 documents because the store
    // is not there, not because it is empty — and the two are distinguishable.
    expect(absent).toContain('memory');
    expect(absent).toContain('truth');
    expect(absent).toContain('collaboration');
    for (const id of absent) {
      expect(registry.sources.find((source) => source.id === id)!.readableDocuments).toBe(0);
    }
    // op_tasks and hq_specialists are core schema and are present.
    expect(registry.sources.find((source) => source.id === 'task')!.storePresent).toBe(true);
    expect(registry.sources.find((source) => source.id === 'worker')!.storePresent).toBe(true);

    // It still answers from what it does have.
    const workers = expectOk(ops.searchCompany({ text: 'claude' }, { includeFounderOnly: true }));
    expect(workers.hits.map((hit) => hit.document.entityId)).toEqual(['claude']);

    // A question over an absent store is insufficient evidence, and the answer
    // names the absence as a limitation rather than implying an empty store.
    const answer = expectOk(ops.askJenify({ question: 'What did we decide about retention?', includeFounderOnly: true }));
    expect(answer.state).toBe('insufficient_evidence');
    expect(answer.limitations.map((entry) => entry.code)).toContain('stores_absent');

    db.close();
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
