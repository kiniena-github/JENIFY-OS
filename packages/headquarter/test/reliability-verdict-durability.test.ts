/**
 * Wave 5 correction — the SAFE-MODE VERDICT, made durable, and the enforcement
 * inputs behind it, made untouchable.
 *
 * Every proof here is hostile and against a real FILE or a raw connection: a
 * second process, a genuinely broken evidence chain, a dropped trigger, a raw
 * `better-sqlite3` handle that never ran HQ's code, and an assignment to an
 * exported constant. Nothing is mocked and nothing is timing-based, because
 * each finding was reproduced that way and has to be closed that way.
 *
 * The five findings:
 *
 *  - **HIGH 1 — the latch was process-local.** `SAFE_MODE_STATEMENT` shipped on
 *    every reliability view, in every refusal, and in the unauthenticated
 *    snapshot, asserting "it is never cleared by a boot". It was: the verdict
 *    lived only in `#integrityReport`, construction ran the STRUCTURAL check
 *    (which by design cannot see a broken chain), and nothing was persisted or
 *    re-read. A plain restart returned `safeMode: false` over a chain still
 *    broken at seq 2, and handed `releaseKillSwitch` and `claimNext` back out.
 *    In a local-first CLI model every command is a new process, so this was not
 *    an exotic path.
 *  - **HIGH 2 — `ENGINE_IMMUTABLE_TABLES` was a mutable exported array** on the
 *    enforcement path of `append_only_guard_missing`, and public package API.
 *    One statement emptied the census and made a tampered file read clean.
 *  - **MEDIUM 5 — `fullIntegrity`'s chain verifier was optional**, and its
 *    absence was indistinguishable from a pass.
 *  - **MEDIUM 6 — the census could not see `hq_mission_plan_items`' guards.**
 *  - **MEDIUM 7 — `authorizeAction` was not safe-mode gated**, though
 *    `approveTask` was gated on exactly the argument that applies to it.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CAPS, expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import {
  ENGINE_IMMUTABLE_TABLES,
  HQ_INTEGRITY_FINDINGS,
  REQUIRED_IMMUTABILITY_GUARDS,
  SAFE_MODE_BLOCKING_FINDINGS,
  SAFE_MODE_STATEMENT,
  fullIntegrity,
  missingImmutabilityGuards,
  structuralIntegrity,
} from '../src/store/integrity.js';
import { latestIntegrityVerdict } from '../src/application/reliability-command.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import { openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';

/** A legal APPEND that leaves the hash chain unverifiable from that entry on. */
function breakChainByLegalAppend(fx: ReturnType<typeof fileFixture>): void {
  fx.raw()
    .prepare(
      `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'forged-evidence-entry',
      new Date().toISOString(),
      null,
      'not-hq',
      'forged',
      '{"executable":false}',
      'genesis',
      'a-hash-that-was-never-computed-over-anything',
    );
}

describe('the safe-mode verdict survives a restart, because it is RECORDED', () => {
  it('re-engages on a new facade over the same file, with the chain still broken', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      // The chain is genuinely broken — established independently, on a raw
      // handle, before anything else is claimed.
      expect(verifyEvidenceChain(fx.raw())).not.toBeNull();

      const engaged = expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(engaged.safeMode).toBe(true);
      expect(engaged.observations.map((o) => o.finding)).toContain('evidence_chain_broken');

      // THE FINDING, reproduced against the correction: a whole new process's
      // facade over the same file. It runs only the structural assessment,
      // which cannot see a broken chain — so before the fix this reported
      // `safeMode: false`, depth `structural`, findings `[]`.
      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      expect(posture.integrity.observations.find((o) => o.finding === 'evidence_chain_broken')!.detail)
        .toContain('Carried from the verdict HQ recorded');

      // And the acts safe mode exists to refuse still refuse, on the NEW
      // facade — which is the whole consequence the finding turned on.
      expectOk(restarted.ops.engageKillSwitch('*', 'founder', 'investigating'));
      const release = restarted.ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
      expectOk(
        restarted.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'after-the-restart' },
          idempotencyKey: 'after-the-restart',
          requestedBy: 'claude',
        }),
      );
      const claim = restarted.ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('survives a guard that the NEXT boot silently re-creates', () => {
    const fx = fileFixture();
    try {
      // `ensure*Schema` is `CREATE TRIGGER IF NOT EXISTS`, so boot #1 repairs
      // the drop. Before the correction the finding therefore survived exactly
      // one boot: boot #2 found a healthy file and said so.
      fx.raw().exec('DROP TRIGGER trg_hq_truth_records_no_erase');
      const bootOne = fx.reopen('process-two');
      expect(bootOne.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      // Boot #1 has now re-created the trigger, so the file is "healthy" — and
      // nobody has run an assessment. This is the exact state the reviewer's
      // PROBE B reached, where boot #2 reported `safeMode: false`.
      expect(missingImmutabilityGuards(fx.raw())).toEqual([]);

      const bootTwo = fx.reopen('process-three');
      expect(bootTwo.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(bootTwo.ops.hqReliabilityPosture().integrity.observations.map((o) => o.finding)).toContain(
        'append_only_guard_missing',
      );
      // Boot #1 recorded what it FOUND, not what it then repaired: the
      // construction-time observation is appended when it is blocking, so the
      // tamper is not forgotten by a restart. Only a Founder assessment of the
      // file as it now stands clears it — and because the guard really was
      // re-created, that assessment legitimately does.
      const cleared = expectOk(bootTwo.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(cleared.safeMode).toBe(false);
      expect(fx.reopen('process-four').ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('is cleared ONLY by a full assessment that finds nothing blocking', () => {
    const fx = fileFixture();
    try {
      fx.raw().exec('DROP TRIGGER trg_hq_action_events_no_erase');
      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const cleared = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(cleared.safeMode).toBe(false);
      // The clean verdict is recorded, so the NEXT process agrees. If clearing
      // were process-local the way engaging was, this would re-engage.
      const after = fx.reopen('process-three');
      expect(after.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      expect(after.ops.hqReliabilityPosture().integrity.observations.map((o) => o.finding)).not.toContain(
        'append_only_guard_missing',
      );
      // And the acts come back: the refusal is no longer safe mode. (The
      // fixture's only task is already claimed, so the honest assertion is
      // that `claimNext` now answers `nothing_claimable` rather than
      // `safe_mode_engaged` — a different refusal, from a different layer.)
      const claim = after.ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('nothing_claimable');
      expectOk(after.ops.releaseKillSwitch('*', 'founder'));
    } finally {
      fx.cleanup();
    }
  });

  it('records the verdict in an append-only ledger a raw writer cannot rewrite', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      const raw = fx.raw();
      const stored = latestIntegrityVerdict(raw)!;
      expect(stored.safeMode).toBe(true);
      expect(stored.depth).toBe('full');
      expect([...stored.findings]).toContain('evidence_chain_broken');

      // The engine holds it, from a connection that never ran HQ's code.
      expect(() => raw.exec(`UPDATE hq_reliability_verdicts SET safe_mode = 0`)).toThrow(/append-only/);
      expect(() => raw.exec(`DELETE FROM hq_reliability_verdicts`)).toThrow(/append-only/);
      const row = raw.prepare(`SELECT * FROM hq_reliability_verdicts ORDER BY seq DESC LIMIT 1`).get() as {
        id: string;
        seq: number;
      };
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO hq_reliability_verdicts
               (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.id, '2020-01-01T00:00:00.000Z', 'full', 0, '[]', 'attacker', 'attacker'),
      ).toThrow(/append-only/);
      // Refused means intact.
      expect(latestIntegrityVerdict(fx.raw())!.safeMode).toBe(true);
      expect(
        (fx.raw().prepare(`SELECT id FROM hq_reliability_verdicts ORDER BY seq DESC LIMIT 1`).get() as {
          id: string;
        }).id,
      ).toBe(row.id);
    } finally {
      fx.cleanup();
    }
  });

  it('carries only BLOCKING findings forward, and only from a safe-mode verdict', () => {
    // A stale `durability_below_requirement` or `foreign_key_violations` must
    // not be re-asserted by a later process that has not just checked it. The
    // carried verdict is the standing statement that HQ cannot vouch for its
    // own record — nothing wider.
    const db = new Database(':memory:') as never;
    const carriedBlocking = structuralIntegrity(db, {
      recordedVerdict: {
        assessedAt: '2026-01-01T00:00:00.000Z',
        depth: 'full',
        safeMode: true,
        findings: ['evidence_chain_broken', 'foreign_key_violations', 'durability_below_requirement'],
      },
    });
    expect(carriedBlocking.observations.map((o) => o.finding)).toEqual(['evidence_chain_broken']);
    expect(carriedBlocking.safeMode).toBe(true);

    const cleanVerdict = structuralIntegrity(db, {
      recordedVerdict: {
        assessedAt: '2026-01-01T00:00:00.000Z',
        depth: 'full',
        safeMode: false,
        findings: [],
      },
    });
    expect(cleanVerdict.safeMode).toBe(false);
    // A finding name outside the closed vocabulary, appended by a raw writer,
    // is dropped rather than carried.
    //
    // This lane wrote the second assertion below as `safeMode` FALSE. The other
    // Wave 5 correction lane, reviewing its own equivalent mechanism, called
    // that the fail-open answer and closed it: the row says HQ stopped trusting
    // itself, and "I could not read why" is not a reason to start again. The
    // merge kept THIS ledger and THAT behaviour, so the assertion is ported
    // rather than dropped — and everything it actually pinned still holds. The
    // forged string is still not carried into `observations`, so it can never
    // reach the unauthenticated artifact's key set or a refusal message, and no
    // vocabulary member is invented for it. `#safeModeRefusal` names the
    // situation categorically instead (pinned in
    // `reliability-authority.test.ts`).
    const forged = structuralIntegrity(db, {
      recordedVerdict: {
        assessedAt: '2026-01-01T00:00:00.000Z',
        depth: 'full',
        safeMode: true,
        findings: ['SUPER SECRET PROJECT NAME'] as never,
      },
    });
    expect(forged.observations).toEqual([]);
    expect(forged.safeMode).toBe(true);
    (db as unknown as { close(): void }).close();
  });

  it('says what it does, and does what it says', () => {
    // The statement is shipped verbatim on every reliability view and in the
    // unauthenticated snapshot, so its wording is a claim HQ makes about
    // itself. The old sentence — "It is never cleared by a boot" — was simply
    // false; the new one names the mechanism and names the case where the
    // mechanism is absent.
    expect(SAFE_MODE_STATEMENT).toContain('APPENDED to HQ’s own verdict ledger');
    expect(SAFE_MODE_STATEMENT).toContain('a restart does not clear it');
    expect(SAFE_MODE_STATEMENT).toContain('no Phase 13 ledger');
  });
});

describe('the enforcement declarations are frozen, not merely typed readonly', () => {
  it('refuses assignment to the census array, its entries and their guard lists', () => {
    // ESM is always strict, so an assignment to a frozen array THROWS rather
    // than failing silently. `ENGINE_IMMUTABLE_TABLES.length = 0` used to empty
    // the census, and a freshly constructed facade then reported `safeMode:
    // false` over a genuinely tampered file.
    expect(Object.isFrozen(ENGINE_IMMUTABLE_TABLES)).toBe(true);
    expect(() => {
      (ENGINE_IMMUTABLE_TABLES as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (ENGINE_IMMUTABLE_TABLES as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    for (const entry of ENGINE_IMMUTABLE_TABLES) {
      expect(Object.isFrozen(entry), entry.table).toBe(true);
      expect(Object.isFrozen(entry.secondaryGuards), entry.table).toBe(true);
      expect(() => {
        (entry.secondaryGuards as unknown as { length: number }).length = 0;
      }).toThrow(TypeError);
      expect(() => {
        (entry as { table: string }).table = 'somewhere_else';
      }).toThrow(TypeError);
      // The REDUCED base too. This freeze and the reduced base came from two
      // different Wave 5 correction lanes and met for the first time in the
      // three-way merge, so the seam is asserted rather than assumed:
      // `requiredGuards.length = 0` would drop `no_erase` and `no_replace` off
      // `hq_mission_plan_items`' declared set and make the census blind to the
      // guard the other lane added — the same exploit as the array above, one
      // field across.
      if (entry.requiredGuards) {
        expect(Object.isFrozen(entry.requiredGuards), entry.table).toBe(true);
        expect(() => {
          (entry.requiredGuards as unknown as { length: number }).length = 0;
        }).toThrow(TypeError);
      }
    }
    expect(ENGINE_IMMUTABLE_TABLES.length).toBeGreaterThan(20);
  });

  it('freezes the other three lists the same verdict rests on', () => {
    for (const list of [
      HQ_INTEGRITY_FINDINGS,
      SAFE_MODE_BLOCKING_FINDINGS,
      REQUIRED_IMMUTABILITY_GUARDS,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => {
        (list as unknown as { length: number }).length = 0;
      }).toThrow(TypeError);
    }
    // Emptying `HQ_INTEGRITY_FINDINGS` used to make every snapshot finding
    // count as `unrecognized`; emptying `SAFE_MODE_BLOCKING_FINDINGS` used to
    // make nothing blocking at all.
    expect([...SAFE_MODE_BLOCKING_FINDINGS]).toHaveLength(3);
    expect([...HQ_INTEGRITY_FINDINGS]).toHaveLength(6);
  });

  it('still finds a tampered file tampered after every attempt at the census', () => {
    const fx = fileFixture();
    try {
      fx.raw().exec('DROP TRIGGER trg_hq_intel_budgets_no_replace_unique');
      // The reviewer's exploit, in full: empty the census, then construct a
      // fresh facade over the tampered file.
      try {
        (ENGINE_IMMUTABLE_TABLES as unknown as { length: number }).length = 0;
      } catch {
        // Expected. The point is what the facade says next.
      }
      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(
        restarted.ops.hqReliabilityPosture().integrity.observations.map((o) => o.finding),
      ).toContain('append_only_guard_missing');
    } finally {
      fx.cleanup();
    }
  });

  it('sees the guards of a table that is NOT append-only as a whole', () => {
    const fx = fileFixture();
    try {
      // `hq_mission_plan_items` is legitimately updated, so it declares a
      // REDUCED base (`no_erase`, `no_replace`) plus `no_relink` / `no_respec`
      // instead of the trio — and while the table was unlisted the census could
      // not see any of them. `trg_hq_mission_plan_items_no_replace` is what
      // stops an `INSERT OR REPLACE` rewriting a plan item's task binding.
      //
      // The other correction lane reached the same table from `no_erase`, which
      // it also ADDED; the merged entry declares both, so both drops are
      // findings. Asserted here together rather than one lane's alone.
      fx.raw().exec('DROP TRIGGER trg_hq_mission_plan_items_no_replace');
      expect(missingImmutabilityGuards(fx.raw())).toEqual([
        'trg_hq_mission_plan_items_no_replace',
      ]);
      fx.raw().exec('DROP TRIGGER trg_hq_mission_plan_items_no_erase');
      expect(missingImmutabilityGuards(fx.raw())).toEqual([
        'trg_hq_mission_plan_items_no_erase',
        'trg_hq_mission_plan_items_no_replace',
      ]);
      const restarted = fx.reopen('process-two');
      const integrity = restarted.ops.hqReliabilityPosture().integrity;
      expect(integrity.safeMode).toBe(true);
      expect(integrity.observations.map((o) => o.finding)).toContain('append_only_guard_missing');
    } finally {
      fx.cleanup();
    }
  });
});

describe('a full assessment cannot read clean because a check was not supplied', () => {
  it('treats a missing chain verifier as an unverifiable chain', () => {
    const fx = fileFixture();
    try {
      // The reviewer's probe: `fullIntegrity(db, {})` returned `depth: 'full'`
      // with no findings, so a caller that simply omitted the verifier got a
      // clean bill of health over a chain nobody checked. This module is
      // public package API, so the required TYPE alone was not enough.
      const missing = fullIntegrity(fx.db, {} as never);
      expect(missing.depth).toBe('full');
      expect(missing.chainVerified).toBe(false);
      expect(missing.safeMode).toBe(true);
      expect(missing.observations.map((o) => o.finding)).toContain('evidence_chain_broken');

      // Supplied and passing: the chain is verified and the report says so.
      const supplied = fullIntegrity(fx.db, { verifyEvidenceChain: () => verifyEvidenceChain(fx.db) });
      expect(supplied.chainVerified).toBe(true);
      expect(supplied.safeMode).toBe(false);

      // A structural pass never claims the chain was verified.
      expect(structuralIntegrity(fx.db).chainVerified).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('safe mode refuses the external-action AUTHORIZATION, like the approval it mirrors', () => {
  it('refuses authorizeAction BEFORE it reads the ledger at all', () => {
    const fx = fileFixture();
    try {
      const attempt = () =>
        fx.ops.authorizeAction({
          actionId: 'an-action-that-does-not-exist',
          workerId: fx.claim.workerId,
          fence: fx.claim.fence,
        });
      // Healthy: the refusal comes from the ledger, which is what it should be.
      const healthy = attempt();
      expect(healthy.ok).toBe(false);
      expect(!healthy.ok && healthy.error.code).toBe('unknown_action');

      breakChainByLegalAppend(fx);
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));

      // In safe mode the SAME call is refused by the gate instead, before the
      // reservation and before any read. `authorizeAction` writes the
      // `authorized` snapshot — the external-action analogue of a primed
      // approval, captured from canonical truth HQ has just declared it cannot
      // stand behind, and it outlives the clearing of safe mode. `approveTask`
      // was gated on exactly that argument; this was not (Wave 5 review,
      // Medium finding 7).
      const engaged = attempt();
      expect(engaged.ok).toBe(false);
      expect(!engaged.ok && engaged.error.code).toBe('safe_mode_engaged');
      expect(!engaged.ok && engaged.error.message).toMatch(/safe mode/i);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the unauthenticated artifact never says "fine" while HQ has said otherwise', () => {
  it('publishes the REAL verdict on a database with no Phase 13 run ledger', () => {
    const fx = fileFixture();
    const dbPath = fx.dbPath;
    try {
      // A genuine pre-Phase-13 file: the run ledger absent, and one append-only
      // guard dropped. `#reliabilityStorePresent` answers only "does this file
      // carry the run TABLES"; the integrity verdict is computed over the whole
      // file, and this is the state where the two disagree.
      const raw = fx.raw();
      raw.exec('DROP TRIGGER trg_hq_mission_intents_no_rewrite');
      for (const table of [
        'hq_reliability_run_events',
        'hq_reliability_runs',
        'hq_reliability_backups',
        'hq_reliability_verdicts',
      ]) {
        raw.exec(`DROP TABLE ${table}`);
      }
      raw.close();
      fx.db.close();

      // Opened exactly as `src/cli/snapshot.ts` opens it.
      const readOnly = openHqDatabaseReadOnly(dbPath);
      const ops = new HeadquarterOperations(readOnly, { processIdentity: 'the-snapshot-cli' });
      expect(ops.reliabilityStorePresent()).toBe(false);

      // The Founder-gated view has always been right about this.
      const posture = ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain('append_only_guard_missing');

      // THE FINDING: the unauthenticated section used to short-circuit to
      // `emptyReliabilitySnapshot(false)`, which HARD-CODES `safeMode: false`,
      // `findings: {}` and `durabilityMeetsRequirement: true` without consulting
      // the verdict at all — so the public artifact published "everything is
      // fine" while HQ had latched safe mode, and the snapshot's "HQ is in SAFE
      // MODE" provenance sentence, gated on the same flag, was suppressed with
      // it (Wave 5 review, Medium finding C-1).
      const summary = ops.reliabilitySummary();
      expect(summary.storePresent).toBe(false);
      expect(summary.safeMode).toBe(true);
      expect(summary.findings.append_only_guard_missing).toBe(1);
      // The run half is still honestly EMPTY, because the ledger really is absent.
      expect(summary.runs).toBe(0);
      expect(summary.verifiedBackups).toBe(0);
      expect(summary.needsReconciliation).toBe(0);
      // The key set is unchanged — twelve, and the same twelve.
      expect(Object.keys(summary).sort()).toEqual(
        [
          'assessmentDepth',
          'byKind',
          'byOutcome',
          'byState',
          'durabilityMeetsRequirement',
          'findings',
          'needsReconciliation',
          'note',
          'runs',
          'safeMode',
          'storePresent',
          'verifiedBackups',
        ].sort(),
      );
      // And the artifact itself carries the provenance sentence again.
      const snapshot = liveSnapshotFromOperations(ops, { now: '2026-09-07T16:00:00.000Z' });
      expect(snapshot.reliability!.data.safeMode).toBe(true);
      expect(snapshot.reliability!.provenance.note).toMatch(/SAFE MODE/);
      // Still no detail text: the dropped trigger's NAME does not cross.
      expect(JSON.stringify(snapshot.reliability)).not.toContain('trg_hq_mission_intents_no_rewrite');
      readOnly.close();
    } finally {
      fx.cleanup();
    }
  });
});
