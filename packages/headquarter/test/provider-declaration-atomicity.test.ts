/**
 * Declaring a worker's execution provider is atomic with its evidence
 * (issue #224, Codex P1 on `9fd1f1c`).
 *
 * ## The defect
 *
 * `HeadquarterOperations.declareWorkerProvider` wrote the worker → provider
 * mapping and then appended the `worker_provider_declared` evidence as two
 * separate statements, inside one try/catch. If the append failed — another
 * process holding the SQLite write lock, a full disk — the mapping stayed
 * CHANGED while the method caught the error and returned `operator_rejected`.
 *
 * That is the worst shape this particular write can take. The mapping is an
 * EXECUTION AUTHORITY: it decides which provider-bound tasks a worker may claim
 * and start (`operator/provider-binding.ts`). So the failure left an authority
 * change live in the database, with no record of who made it, and told the
 * operator it had not happened — the one combination that is both unaudited and
 * invisible.
 *
 * The fix is `EvidenceLog.reserve`, an IMMEDIATE write transaction, so a
 * throwing append rolls the declaration back with it and the refusal the caller
 * sees is true.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture } from './application.fixture.js';

function fixtureWithFounder() {
  const fixture = setupFixture();
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

describe('a declaration and its evidence commit together or not at all', () => {
  it('records both on the happy path', () => {
    const fixture = fixtureWithFounder();
    const declared = fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'chair',
    });
    expect(declared.ok).toBe(true);
    expect(fixture.ops.queue.workerProviders.providerOf('claude-worker')).toBe('CLAUDE');
    expect(
      fixture.ops.queue.evidence.list().some((entry) => entry.kind === 'worker_provider_declared'),
    ).toBe(true);
  });

  /**
   * The defect, driven directly: make the evidence append fail and assert the
   * authority change did NOT survive.
   */
  it('rolls the mapping back when the evidence cannot be written', () => {
    const fixture = fixtureWithFounder();
    const evidence = fixture.ops.queue.evidence as unknown as {
      append: (entry: unknown) => unknown;
    };
    const realAppend = evidence.append.bind(evidence);
    evidence.append = (entry: unknown) => {
      const kind = (entry as { kind?: string }).kind;
      if (kind === 'worker_provider_declared') throw new Error('database is locked');
      return realAppend(entry);
    };

    const declared = fixture.ops.declareWorkerProvider({
      workerId: 'claude-worker',
      providerId: 'CLAUDE',
      founderId: 'chair',
    });
    evidence.append = realAppend;

    // The caller is told it failed...
    expect(declared.ok).toBe(false);
    // ...and that is now TRUE: no execution authority was granted.
    expect(fixture.ops.queue.workerProviders.providerOf('claude-worker')).toBeNull();
    // And nothing claims it was.
    expect(
      fixture.ops.queue.evidence.list().some((entry) => entry.kind === 'worker_provider_declared'),
    ).toBe(false);
  });

  it('leaves an EXISTING declaration untouched when a re-declaration fails', () => {
    // `declare` is an upsert, so the rollback has to restore the previous row
    // rather than merely delete a new one. A worker silently losing — or
    // keeping — the wrong provider is the same authority defect wearing
    // different clothes.
    const fixture = fixtureWithFounder();
    fixture.ops.declareWorkerProvider({
      workerId: 'worker-1',
      providerId: 'CLAUDE',
      founderId: 'chair',
    });
    expect(fixture.ops.queue.workerProviders.providerOf('worker-1')).toBe('CLAUDE');

    const evidence = fixture.ops.queue.evidence as unknown as {
      append: (entry: unknown) => unknown;
    };
    const realAppend = evidence.append.bind(evidence);
    evidence.append = (entry: unknown) => {
      if ((entry as { kind?: string }).kind === 'worker_provider_declared') {
        throw new Error('database is locked');
      }
      return realAppend(entry);
    };
    const redeclared = fixture.ops.declareWorkerProvider({
      workerId: 'worker-1',
      providerId: 'CODEX',
      founderId: 'chair',
    });
    evidence.append = realAppend;

    expect(redeclared.ok).toBe(false);
    // Still CLAUDE. The failed re-declaration moved nothing.
    expect(fixture.ops.queue.workerProviders.providerOf('worker-1')).toBe('CLAUDE');
  });

  it('still refuses an unknown provider without writing anything', () => {
    // The validation refusal path must survive being wrapped in a transaction:
    // it throws from inside, and the caller must still get the named reason.
    const fixture = fixtureWithFounder();
    const declared = fixture.ops.declareWorkerProvider({
      workerId: 'worker-1',
      providerId: 'CLUADE',
      founderId: 'chair',
    });
    expect(declared.ok).toBe(false);
    if (declared.ok) throw new Error('unreachable');
    expect(declared.error.code).toBe('unknown_provider');
    expect(fixture.ops.queue.workerProviders.providerOf('worker-1')).toBeNull();
  });

  it('still refuses a principal without approval authority, before any write', () => {
    const fixture = fixtureWithFounder();
    fixture.principals.register({
      id: 'analyst',
      displayName: 'Analyst',
      originateCapabilities: [],
      approvalAuthority: false,
      active: true,
    });
    const declared = fixture.ops.declareWorkerProvider({
      workerId: 'worker-1',
      providerId: 'CLAUDE',
      founderId: 'analyst',
    });
    expect(declared.ok).toBe(false);
    expect(fixture.ops.queue.workerProviders.providerOf('worker-1')).toBeNull();
  });
});
