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
  HQ_DURABILITY_REQUIREMENT,
  HQ_INTEGRITY_FINDINGS,
  REQUIRED_IMMUTABILITY_GUARDS,
  SAFE_MODE_BLOCKING_FINDINGS,
  SAFE_MODE_STATEMENT,
  fullIntegrity,
  missingImmutabilityGuards,
  structuralIntegrity,
} from '../src/store/integrity.js';
import {
  RELIABILITY_COMMAND_CAPABILITY,
  RELIABILITY_COMMAND_RESERVED_CONTRACT,
  RUN_EVENT_KINDS,
  RUN_FAILURE_CATEGORIES,
  RUN_INTERRUPTION_REASONS,
  RUN_KINDS,
  RUN_OUTCOMES,
  RUN_STATES,
  REPORTABLE_RUN_OUTCOMES,
  isReportableRunOutcome,
  evidenceChainCommitmentBreach,
  standingIntegrityVerdict,
} from '../src/application/reliability-command.js';
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
      const stored = standingIntegrityVerdict(raw)!;
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
      expect(standingIntegrityVerdict(fx.raw())!.safeMode).toBe(true);
      expect(
        (fx.raw().prepare(`SELECT id FROM hq_reliability_verdicts ORDER BY seq DESC LIMIT 1`).get() as {
          id: string;
        }).id,
      ).toBe(row.id);
      // The write this test's three statements deliberately did NOT try, and
      // the only one that ever cleared safe mode (Wave 5 correction round
      // three, Low A9): a plain APPEND of a clean row, which is exactly what an
      // append-only table permits. It lands as a row and settles nothing,
      // because it carries no corroborating entry in the evidence chain.
      raw
        .prepare(
          `INSERT INTO hq_reliability_verdicts
             (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('verdict-appended-clean', new Date().toISOString(), 'full', 0, '[]', 'attacker', 'attacker');
      expect(
        (fx.raw().prepare(`SELECT id FROM hq_reliability_verdicts ORDER BY seq DESC LIMIT 1`).get() as {
          id: string;
        }).id,
      ).toBe('verdict-appended-clean');
      expect(standingIntegrityVerdict(fx.raw())!.safeMode).toBe(true);
      expect(fx.reopen('process-two').ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
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

  /**
   * The title claims the statement DOES what it says, and the body used to grep
   * three substrings and execute nothing — while pinning a sentence whose
   * second half was false (Wave 5 correction round three, Low A10). Each clause
   * is now executed against a real file, and the substring check stays as the
   * cheap half that catches a rewording.
   */
  it('says what it does, and does what it says', () => {
    // The statement is shipped verbatim on every reliability view and in the
    // unauthenticated snapshot, so its wording is a claim HQ makes about
    // itself. The old sentence — "It is never cleared by a boot" — was simply
    // false; the current one names the mechanism and names the case where the
    // mechanism is absent.
    expect(SAFE_MODE_STATEMENT).toContain('APPENDED to HQ’s own verdict ledger');
    expect(SAFE_MODE_STATEMENT).toContain('a restart does not clear it');
    expect(SAFE_MODE_STATEMENT).toContain('only a fresh full assessment that finds nothing blocking');
    expect(SAFE_MODE_STATEMENT).toContain('no Phase 13 ledger');
    // Wave 5 correction round four, Medium M1 / Low L6: two clauses that were
    // broader than the code, made exactly true rather than left aspirational.
    // The statement must NOT claim safe mode refuses everything that adds to
    // the record — `createTask`, `appendSystemEvidence`, `recordVerifiedBackup`
    // and `engageKillSwitch` all add rows under an engaged latch, deliberately.
    expect(SAFE_MODE_STATEMENT).not.toContain('refuses the acts that would add to');
    expect(SAFE_MODE_STATEMENT).toContain('APPROVE, RELEASE, EXECUTE against or grant AUTHORITY');
    // And it must say what the corroboration rule actually delivers, including
    // the residual it cannot close.
    expect(SAFE_MODE_STATEMENT).toContain('a genuine link in the chain');
    expect(SAFE_MODE_STATEMENT).toContain('not a cryptographic boundary');

    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      const engaged = expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(engaged.safeMode).toBe(true);

      // "APPENDED to HQ's own verdict ledger" — a row is really there, and it
      // says what the assessment said.
      const raw = fx.raw();
      const stored = standingIntegrityVerdict(raw)!;
      expect(stored.safeMode).toBe(true);
      expect([...stored.findings]).toContain('evidence_chain_broken');

      // "a restart does not clear it" — executed, not asserted.
      expect(fx.reopen('process-two').ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // "only a fresh full assessment that finds nothing blocking does" — the
      // half that was false. A raw APPEND of a clean verdict is the write an
      // append-only ledger permits, and it used to clear the latch outright.
      raw
        .prepare(
          `INSERT INTO hq_reliability_verdicts
             (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('verdict-says-clean', new Date().toISOString(), 'full', 0, '[]', 'attacker', 'attacker');
      expect(fx.reopen('process-three').ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // And "READS and still reconciles" while "refuses the acts that would
      // add to, approve, release or execute" — one of each, on the same facade.
      const after = fx.reopen('process-four');
      expect(after.ops.listRunsBounded().total).toBe(0);
      expectOk(after.ops.engageKillSwitch('*', 'founder', 'investigating'));
      const release = after.ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * Wave 5 correction round four — the audit log itself.
 *
 * The round's defences (the append-only trigger trio on `op_evidence`, the
 * census membership, the `sqlite_sequence` high-water mark) do work against a
 * tail truncation. They did NOT work against DESTRUCTION, and the reason was
 * boot ORDER: `op_evidence` is created by `migrateHqDatabase`, which runs
 * BEFORE the facade's census, so the absent-table check could never see it
 * absent. `DROP TABLE op_evidence` — with or without the attacker recreating
 * the table and its three guards — read clean at BOTH depths (`safeMode:
 * false`, `observations: []`, `chainVerified: true`) over an audit log
 * destroyed and rebuilt empty, and the same act CLEARED an already-latched
 * safe mode and re-admitted `releaseKillSwitch`.
 *
 * Two independent holds close it, and each is tested on its own so neither can
 * be credited for the other's work:
 *
 *  1. the pre-migration observation, which sees the table absent at the only
 *     instant the question is still answerable;
 *  2. a durable COMMITMENT to the chain's tip, recorded in the append-only
 *     verdict ledger — outside `op_evidence` and outside `sqlite_sequence`, so
 *     a rebuilt log cannot satisfy it whatever it says about itself.
 */
describe('destroying the audit log is a finding, not silence', () => {
  it('sees a DROPPED op_evidence, even though the migration re-creates it first', () => {
    const fx = fileFixture();
    try {
      // A healthy, established file, and a chain that genuinely verifies.
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(verifyEvidenceChain(fx.raw())).toBeNull();

      // The attack: the audit log is destroyed outright. `DROP TABLE` is DDL —
      // no BEFORE trigger refuses it.
      fx.raw().exec('DROP TABLE op_evidence');

      // A new process. `openHqDatabase` re-creates `op_evidence` EMPTY before
      // the facade can look at it, which is exactly what used to launder this.
      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      const findings = posture.integrity.observations.map((o) => o.finding);
      expect(findings).toContain('append_only_guard_missing');
      const detail = posture.integrity.observations
        .filter((o) => o.finding === 'append_only_guard_missing')
        .map((o) => o.detail)
        .join(' ');
      expect(detail).toContain('op_evidence');
      // The LEDGER is named as having gone entirely, not merely three triggers.
      // That half is what the pre-migration observation adds: before it, the
      // drop was reported as missing guards on a table HQ had silently rebuilt
      // empty, and the reader was never told the log itself had been destroyed.
      expect(detail).toContain('absent ENTIRELY');
      expect(detail).toContain('whatever those ledgers held is gone');

      // And the acts safe mode exists to refuse still refuse.
      expectOk(restarted.ops.engageKillSwitch('*', 'founder', 'investigating'));
      const release = restarted.ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a log that was dropped and REBUILT with its own three guards', () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));

      // The stronger form of the attack: the table comes back, with the same
      // declared schema AND its own three append-only guards, so nothing the
      // census looks at is missing. Only the CONTENT is gone.
      const raw = fx.raw();
      raw.exec('DROP TABLE op_evidence');
      raw.exec(`
        CREATE TABLE op_evidence (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          at TEXT NOT NULL,
          task_id TEXT,
          actor TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
        CREATE TRIGGER trg_op_evidence_no_rewrite BEFORE UPDATE ON op_evidence
        BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
        CREATE TRIGGER trg_op_evidence_no_erase BEFORE DELETE ON op_evidence
        BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
        CREATE TRIGGER trg_op_evidence_no_replace BEFORE INSERT ON op_evidence
        WHEN EXISTS (SELECT 1 FROM op_evidence WHERE id = NEW.id)
          OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM op_evidence WHERE seq = NEW.seq))
        BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
      `);
      // Nothing is missing by the guard census, and the walk over what is left
      // verifies perfectly: this is what read clean before the correction.
      expect(missingImmutabilityGuards(fx.raw())).toEqual([]);
      expect(verifyEvidenceChain(fx.raw())).toBeNull();

      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain(
        'evidence_chain_broken',
      );
      expect(
        posture.integrity.observations
          .filter((o) => o.finding === 'evidence_chain_broken')
          .map((o) => o.detail)
          .join(' '),
      ).toContain('reached entry seq');

      // A FULL assessment does not clear it either — the commitment is checked
      // at both depths, and this is the only latch-clearing path there is.
      const assessed = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(assessed.depth).toBe('full');
      expect(assessed.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      // And the report behind it says the chain was NOT verified, rather than
      // reporting "nothing to check" as a pass (Low L7).
      expect(
        fullIntegrity(restarted.db, {
          verifyEvidenceChain: () => verifyEvidenceChain(restarted.db),
          evidenceCommitmentBreachAt: evidenceChainCommitmentBreach(restarted.db),
        }).chainVerified,
      ).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 correction round four, Medium M2. The chain-LENGTH commitment the
   * previous round added lives in `sqlite_sequence`, which carries no triggers
   * and cannot be brought under the census (it is an internal SQLite table).
   * Executed then: drop `trg_op_evidence_no_erase`, delete the tail, RECREATE
   * the trigger, `UPDATE sqlite_sequence SET seq = 2` — and the boot read
   * `safeMode: false, []`. The doc's mitigating clause ("the first is itself a
   * blocking finding") was false, because the guard is recreated before the
   * next boot observation ever runs.
   */
  it('catches a tail truncation that rewrites sqlite_sequence to hide itself', () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      const raw = fx.raw();
      const tip = raw.prepare(`SELECT MAX(seq) AS seq FROM op_evidence`).get() as { seq: number };
      expect(tip.seq).toBeGreaterThan(1);

      raw.exec('DROP TRIGGER trg_op_evidence_no_erase');
      raw.prepare('DELETE FROM op_evidence WHERE seq > 1').run();
      raw.exec(`
        CREATE TRIGGER trg_op_evidence_no_erase BEFORE DELETE ON op_evidence
        BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
      `);
      raw.prepare(`UPDATE sqlite_sequence SET seq = 1 WHERE name = 'op_evidence'`).run();
      // Every check that lives inside the log now agrees the log is fine.
      expect(missingImmutabilityGuards(fx.raw())).toEqual([]);
      expect(verifyEvidenceChain(fx.raw())).toBeNull();

      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.observations.map((o) => o.finding)).toContain(
        'evidence_chain_broken',
      );
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 correction round four, Medium M1. `verdictIsCorroborated` matched
   * `kind` plus a `json_extract` of the payload and nothing else, so a
   * corroborating evidence row needed NO valid hash. Two raw INSERTs — one
   * clean verdict, one forged corroboration — cleared a latched safe mode and
   * re-admitted `releaseKillSwitch` while the chain was genuinely broken.
   */
  it('does not accept a corroborating evidence row that is not a real link', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      const engaged = expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(engaged.safeMode).toBe(true);

      // The two raw appends. Both are writes the append-only triggers
      // deliberately PERMIT — appending is not tampering.
      const raw = fx.raw();
      raw
        .prepare(
          `INSERT INTO hq_reliability_verdicts
             (id, assessed_at, depth, safe_mode, findings, process_id, assessed_by)
           VALUES (?, ?, ?, 0, '[]', ?, ?)`,
        )
        .run('forged-verdict', new Date().toISOString(), 'full', 'not-hq', 'not-hq');
      raw
        .prepare(
          `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          'forged-corroboration',
          new Date().toISOString(),
          'not-hq',
          'hq_integrity_assessed',
          JSON.stringify({ verdictId: 'forged-verdict' }),
          'genesis',
          'not-a-hash-anybody-computed',
        );

      // The forged clear does NOT stand: the walk continues past it to the
      // engaged verdict behind it.
      const standing = standingIntegrityVerdict(fx.raw());
      expect(standing?.safeMode).toBe(true);

      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expectOk(restarted.ops.engageKillSwitch('*', 'founder', 'investigating'));
      const release = restarted.ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  /**
   * Wave 5 correction round four, Medium M3. `assessHqIntegrity` deliberately
   * passes no `immutableTablesAbsentAsFound` — it asks about the file as it NOW
   * stands, which is the only way a latch can ever be cleared. That is right,
   * and it meant a dropped LEDGER observed at boot was cleared by the next
   * assessment with nothing durably recording that rows had gone missing.
   *
   * The clearing is still correct. What is added is that the LOSS is now a
   * fact in the append-only log, which outlives the latch.
   */
  it('records WHICH ledger disappeared in the audit log, so clearing the latch does not erase it', () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      fx.raw().exec('DROP TABLE hq_intel_budgets');

      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      // The Founder assesses the file as it now stands and the latch clears —
      // correctly: HQ has re-created what it declares and the file is sound.
      const cleared = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(cleared.safeMode).toBe(false);

      // And the loss is still on the record afterwards, naming the ledger.
      const entries = restarted.ops.queue.evidence
        .list()
        .filter((entry) => entry.kind === 'hq_immutable_ledger_absent');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.at(-1)!.payload.tables).toContain('hq_intel_budgets');
    } finally {
      fx.cleanup();
    }
  });
});

  /**
   * The acts the corrected sentence names, exercised under an engaged latch.
   * A statement is only true if the code agrees with it, so both halves are
   * asserted here rather than only the wording.
   */
  it('adds to the record and refuses to release, exactly as the corrected sentence says', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      expect(expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' })).safeMode).toBe(true);

      // ADDING to the record is still permitted, and each of these is a fact a
      // store you cannot vouch for still needs written down.
      expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'recorded-under-safe-mode' },
          idempotencyKey: 'recorded-under-safe-mode',
          requestedBy: 'claude',
        }),
      );
      expectOk(fx.ops.engageKillSwitch('*', 'founder', 'investigating'));

      // RELEASING, and buying execution authority, are refused.
      const release = fx.ops.releaseKillSwitch('*', 'founder');
      expect(release.ok).toBe(false);
      expect(!release.ok && release.error.code).toBe('safe_mode_engaged');
      const claim = fx.ops.claimNext('claude', CAPS.openPr);
      expect(claim.ok).toBe(false);
      expect(!claim.ok && claim.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
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

  /**
   * Wave 5 correction round three, Medium A6. The freeze above was applied to
   * the census array and four integrity siblings and stopped there, so the
   * OTHER half of the same gate stayed mutable:
   * `RELIABILITY_COMMAND_RESERVED_CONTRACT` is what the capability drift check
   * compares a registry row AGAINST, and rewriting it made the gate agree with
   * a tampered row. Every `*_RESERVED_CONTRACT` in the package had the same
   * shape, so the fix is one shared helper applied consistently rather than a
   * second one-off — and this test enumerates the package rather than a list
   * somebody has to remember to extend.
   */
  it('freezes every reserved contract and capability declaration in the package', async () => {
    const application = (await import('../src/application/index.js')) as Record<string, unknown>;
    const routing = (await import('../src/routing/providers.js')) as Record<string, unknown>;
    const live = (await import('../src/live/orders.js')) as Record<string, unknown>;
    const names: string[] = [];
    for (const namespace of [application, routing, live]) {
      for (const [name, value] of Object.entries(namespace)) {
        if (!/_RESERVED_CONTRACT$|_CAPABILITY$/.test(name)) continue;
        if (value == null || typeof value !== 'object') continue;
        names.push(name);
        expect(Object.isFrozen(value), name).toBe(true);
        expect(() => {
          (value as Record<string, unknown>).riskClass = 'external_side_effect';
        }, name).toThrow(TypeError);
      }
    }
    // A count, so an accidental narrowing of the scan is visible rather than
    // quietly passing over an empty set.
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toContain('RELIABILITY_COMMAND_RESERVED_CONTRACT');
    expect(names).toContain('INTELLIGENCE_COMMAND_RESERVED_CONTRACT');
    expect(names).toContain('MISSION_COMMAND_RESERVED_CONTRACT');
    expect(names).toContain('PRODUCT_COMMAND_RESERVED_CONTRACT');
    expect(names).toContain('MEMORY_COMMAND_RESERVED_CONTRACT');
    expect(names).toContain('PROJECT_COMMAND_RESERVED_CONTRACT');
  });

  /**
   * Wave 5 correction round four, Medium M7 / M8.
   *
   * The test above claimed to enumerate "the package" and scanned THREE modules
   * for TWO name suffixes. That narrowness is the hole two live exploits fell
   * through, and neither had a `_RESERVED_CONTRACT` or `_CAPABILITY` name:
   *
   *  - `FABRICATED_FIELD_NAMES` is read by `assertNoFabricatedFields`, the
   *    fail-closed publication gate on the unauthenticated snapshot. Executed:
   *    `FABRICATED_FIELD_NAMES.length = 0` and a fabricated `costUsd`
   *    published;
   *  - `STATE_CHANGING_METHODS` is what `checkMutationOrigin` decides on, and
   *    it returns `{ ok: true }` for any method NOT in the list. Executed:
   *    `.length = 0` turned a refused cross-origin non-JSON POST
   *    (`403 content_type_not_json`, no write) into an accepted `201` that
   *    WROTE a budget row.
   *
   * So this one really does enumerate the package: every public entry point in
   * `package.json#exports`, every exported ALL-CAPS binding that is an object
   * or an array, no name filter at all. A future constant is covered the day it
   * is exported, which is the property the previous version only claimed.
   */
  it('freezes EVERY exported closed vocabulary in the package, by enumeration', async () => {
    const entryPoints = [
      '../src/index.js',
      '../src/contracts/index.js',
      '../src/operator/index.js',
      '../src/store/index.js',
      '../src/archive/index.js',
      '../src/connectors/index.js',
      '../src/ui/index.js',
      '../src/organization/index.js',
      '../src/memory/index.js',
      '../src/handover/index.js',
      '../src/registry/index.js',
      '../src/providers/index.js',
      '../src/application/index.js',
      '../src/routing/index.js',
      '../src/live/index.js',
      '../src/client/index.js',
    ];
    const seen = new Map<string, unknown>();
    for (const entry of entryPoints) {
      const namespace = (await import(entry)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(namespace)) {
        // ALL-CAPS is how this package spells a declared constant, and an
        // object or an array is what a `length = 0` or a property rewrite can
        // actually reach.
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        if (value == null || typeof value !== 'object') continue;
        if (!seen.has(name)) seen.set(name, value);
      }
    }
    const unfrozen = [...seen.entries()]
      .filter(([, value]) => !Object.isFrozen(value))
      .map(([name]) => name)
      .sort();
    expect(unfrozen).toEqual([]);
    // A count, so a future narrowing of the enumeration is visible rather than
    // silently passing over an empty set. 202 bindings at this head.
    expect(seen.size).toBeGreaterThanOrEqual(200);
    // The two the previous scan could not see, named so a regression on either
    // is reported by name rather than as an anonymous count.
    for (const name of [
      'FABRICATED_FIELD_NAMES',
      'STATE_CHANGING_METHODS',
      'CLIENT_IDENTITY_KEYS',
      'STEP_UP_RISK_CLASSES',
      'CONTROL_ROUTES',
      'CONTROL_WRITE_ROUTES',
      'MEMORY_PRIVACY_LEVELS',
      'ACTIVITY_STATUSES',
      'ALLOWED_TRANSITIONS',
      'MISSION_ALLOWED_TRANSITIONS',
      'MEMBER_RISK_CLASSES',
      'ALL_RESULT_MARKERS',
      'PROVIDER_HEALTH_STATES',
      'MODEL_AVAILABILITY_STATES',
      'LEXICAL_RETRIEVAL_ADAPTER',
    ]) {
      expect([...seen.keys()], name).toContain(name);
      expect(Object.isFrozen(seen.get(name)), name).toBe(true);
    }
  });

  /**
   * The two exploits themselves, not only the `Object.isFrozen` property —
   * because "frozen" is the mechanism and "the gate still holds" is the
   * guarantee. Under ESM (always strict) the write THROWS.
   */
  it('refuses the two writes that emptied a publication gate and a CSRF gate', async () => {
    const { FABRICATED_FIELD_NAMES, assertNoFabricatedFields, BrowserSafetyError } = await import(
      '../src/live/redaction.js'
    );
    expect(() => {
      (FABRICATED_FIELD_NAMES as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect(() => assertNoFabricatedFields({ card: { costUsd: 42 } })).toThrow(BrowserSafetyError);

    const { STATE_CHANGING_METHODS } = await import('../src/live/auth.js');
    expect(() => {
      (STATE_CHANGING_METHODS as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect([...STATE_CHANGING_METHODS]).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);

    // `RETRIEVAL_GUARD_STATEMENT` says every exported adapter binding is
    // already wrapped; a bare object literal let the wrapper be replaced IN
    // PLACE, which made the shipped sentence false by one line (Medium M9).
    const { LEXICAL_RETRIEVAL_ADAPTER } = await import('../src/application/search-command.js');
    expect(Object.isFrozen(LEXICAL_RETRIEVAL_ADAPTER)).toBe(true);
    expect(() => {
      (LEXICAL_RETRIEVAL_ADAPTER as unknown as { retrieve: unknown }).retrieve = () => [];
    }).toThrow(TypeError);
    expect(() => {
      (LEXICAL_RETRIEVAL_ADAPTER as unknown as { available: unknown }).available = false;
    }).toThrow(TypeError);
  });

  it('freezes the run vocabularies the snapshot counts and the derivation read', () => {
    for (const list of [
      RUN_KINDS,
      RUN_STATES,
      RUN_OUTCOMES,
      REPORTABLE_RUN_OUTCOMES,
      RUN_EVENT_KINDS,
      RUN_FAILURE_CATEGORIES,
      RUN_INTERRUPTION_REASONS,
    ] as readonly (readonly string[])[]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(() => {
        (list as unknown as { length: number }).length = 0;
      }).toThrow(TypeError);
    }
    // `REPORTABLE_RUN_OUTCOMES.length = 0` used to make `isReportableRunOutcome`
    // false for every outcome a worker can report, and `RUN_STATES.length = 0`
    // used to make the unauthenticated snapshot count every run's state as
    // `unrecognized` — a wrong count, published.
    expect(isReportableRunOutcome('succeeded')).toBe(true);
    expect(RUN_STATES).toContain('attempting');
    expect(Object.isFrozen(HQ_DURABILITY_REQUIREMENT)).toBe(true);
  });

  /**
   * The bypass itself, end to end, through supported calls only: a registry row
   * that no longer matches the reserved contract is correctly REFUSED, and
   * rewriting the reserved contract to agree with it no longer buys the
   * Founder-gated act at full depth.
   */
  it('does not admit a Founder reliability act when the RESERVED CONTRACT is patched to match a tampered row', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      raw
        .prepare(`UPDATE op_capabilities SET risk_class = ?, side_effect = 1, idempotent = 0 WHERE id = ?`)
        .run('external_side_effect', RELIABILITY_COMMAND_CAPABILITY.id);
      raw.close();
      const refused = fx.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error.code).toBe('not_permitted');

      // The patch the review used, on the exact object the gate reads.
      const contract = RELIABILITY_COMMAND_RESERVED_CONTRACT as unknown as Record<string, unknown>;
      expect(() => {
        contract.riskClass = 'external_side_effect';
      }).toThrow(TypeError);
      expect(() => {
        contract.sideEffect = true;
      }).toThrow(TypeError);
      expect(RELIABILITY_COMMAND_RESERVED_CONTRACT.riskClass).toBe('founder_gate');

      const stillRefused = fx.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(stillRefused.ok).toBe(false);
      expect(!stillRefused.ok && stillRefused.error.code).toBe('not_permitted');
      expect(!stillRefused.ok && stillRefused.error.message).toMatch(/reserved contract/);
    } finally {
      fx.cleanup();
    }
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
