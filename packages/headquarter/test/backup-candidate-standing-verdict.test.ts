/**
 * A backup candidate is asked HQ's OWN full question, not the half `store/`
 * can answer alone (Wave 5 correction round eleven, HIGH 1).
 *
 * ## What was open
 *
 * Round ten made `verifyHqBackupFile` run HQ's append-only census over the
 * opened copy. It ran it as `structuralIntegrity(db)` — with NO options — so
 * two inputs a live construction always has were simply absent, and each was
 * a working vector:
 *
 *  - `options.recordedVerdict` was `undefined`, so `carryRecordedVerdict`
 *    never saw the durable blocking verdict the CANDIDATE carries in its own
 *    `hq_reliability_verdicts`. Executed at the previous head: a file whose
 *    boot had recorded `safe_mode=1 ["append_only_guard_missing"]`, and whose
 *    guard HQ's own `CREATE TRIGGER IF NOT EXISTS` pass had since re-created,
 *    gave `structuralIntegrity(no opts).safeMode = false` and verified
 *    `{ verified: true, refusals: [], integrityVerdict: 'ok' }` — while the
 *    same bytes opened live gave `safeMode: true`;
 *  - a structural pass never walks the evidence log's LINKS; it only checks
 *    `contradictedChainCommitment`. Executed: three entries, seq 2's payload
 *    rewritten in place with the guards temporarily dropped, the committed tip
 *    still at seq 3 — `verified: true, integrityVerdict: 'ok'`, while a Founder
 *    `assessHqIntegrity` over the restored file latches `evidence_chain_broken`.
 *
 * `recordVerifiedBackup` then certified such a file into `hq_reliability_backups`,
 * which is INSERT-only — so the certification was permanent, and it is one of
 * the two acts deliberately left available DURING safe mode.
 *
 * ## What this file pins
 *
 * Both vectors, at the shipped surface a Founder actually reaches
 * (`recordVerifiedBackup`) and at the public function underneath it; that the
 * whole workflow still costs nothing true — an honest backup verifies and is
 * still recordable; that an assessment which could not RUN is a refusal rather
 * than a pass; and that the read-only contract with respect to the candidate
 * survives the extra reads.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { fileFixture } from './reliability.fixture.js';
import { expectOk } from './application.fixture.js';
import {
  structuralIntegrity,
  verifyHqBackupFile,
  type HqBackupCandidateCensus,
} from '../src/store/integrity.js';
import type { HqDatabase } from '../src/store/db.js';
import { verifyEvidenceChain } from '../src/operator/evidence.js';
import {
  reliabilitySchemaPresent,
  standingIntegrityVerdict,
} from '../src/application/reliability-command.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');

/**
 * The assessment spelled out from the primitives that already existed, so this
 * file states the property rather than re-exporting the fix. The shipped
 * implementation is `assessHqBackupCandidate`; that `recordVerifiedBackup`
 * actually passes it is asserted from the source at the bottom of this file,
 * and `backup-verification-census.test.ts` calls it directly.
 */
function assessLikeHq(db: HqDatabase): HqBackupCandidateCensus {
  const structural = structuralIntegrity(db, {
    recordedVerdict: standingIntegrityVerdict(db),
    reliabilitySchemaPresent: reliabilitySchemaPresent(db),
  });
  const findings = new Set(
    structural.observations.filter((o) => o.blocking).map((o) => o.finding),
  );
  let chainVerified = false;
  try {
    chainVerified = verifyEvidenceChain(db) === null;
  } catch {
    chainVerified = false;
  }
  if (!chainVerified) findings.add('evidence_chain_broken');
  return {
    safeMode: structural.safeMode || findings.size > 0,
    blockingFindings: [...findings],
    chainVerified,
  };
}

/** Drop a table's declared guards, apply `mutate`, put the guards back verbatim. */
function underDroppedGuards(file: string, table: string, mutate: (raw: Database.Database) => void): void {
  const raw = new Database(file);
  const triggers = (
    raw
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`)
      .all(table) as { name: string; sql: string }[]
  ).filter((row) => typeof row.sql === 'string');
  for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  mutate(raw);
  for (const trigger of triggers) raw.exec(trigger.sql);
  raw.close();
}

describe('the candidate is asked what it records about ITSELF', () => {
  it('refuses a file carrying a standing blocking verdict, even after the guard was re-created', () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      fx.db.close();

      // The tamper, and then HQ's own repair of the visible half of it: drop a
      // declared guard, let the next construction observe it AS FOUND (which
      // records a blocking verdict) and re-create it. What is left is a file
      // whose schema is perfect and whose own record says HQ stopped trusting
      // it.
      const dropper = new Database(fx.dbPath);
      dropper.exec('DROP TRIGGER IF EXISTS trg_hq_reliability_verdicts_no_erase');
      dropper.close();
      const latched = fx.reopen('the-latching-process');
      expect(latched.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      latched.db.close();

      const candidate = path.join(fx.dir, 'tainted-recovery-point.sqlite');
      fs.copyFileSync(fx.dbPath, candidate);

      // The floor really is clean — this is why the option mattered rather
      // than being belt-and-braces.
      const copy = new Database(candidate, { readonly: true }) as unknown as HqDatabase;
      expect(structuralIntegrity(copy).safeMode).toBe(false);
      const standing = standingIntegrityVerdict(copy);
      expect(standing?.safeMode).toBe(true);
      expect(standing?.findings).toContain('append_only_guard_missing');
      copy.close();
      // The read-only inspection above leaves a `-shm` behind; the candidate a
      // verification is asked about must be the bare file.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        fs.rmSync(`${candidate}${suffix}`, { force: true });
      }

      const verdict = verifyHqBackupFile(candidate, { assessCandidate: assessLikeHq });
      expect(verdict.verified).toBe(false);
      expect(verdict.refusals).toContain('would_latch_safe_mode');
      expect(verdict.blockingFindings).toContain('append_only_guard_missing');
      expect(verdict.integrityVerdict).not.toBe('ok');

      // And the shipped act a Founder reaches refuses it too, so nothing
      // permanent is written.
      const live = fx.reopen('the-certifying-process');
      const refused = live.ops.recordVerifiedBackup({
        backupPath: candidate,
        requestedBy: 'founder',
        note: 'nightly recovery point',
      });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).toContain('would_latch_safe_mode');
      expect(live.ops.listVerifiedBackupsBounded().backups).toEqual([]);
      live.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('refuses a log rewritten in place BEHIND the last checkpoint commitment', async () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      const candidate = path.join(fx.dir, 'chain-tampered.sqlite');
      await fx.db.backup(candidate);

      const before = new Database(candidate, { readonly: true });
      const seqs = (
        before.prepare(`SELECT seq FROM op_evidence ORDER BY seq`).all() as { seq: number }[]
      ).map((row) => row.seq);
      const committed = (
        before.prepare(`SELECT MAX(chain_length) AS len FROM hq_integrity_checkpoints`).get() as {
          len: number;
        }
      ).len;
      before.close();
      for (const suffix of ['-wal', '-shm', '-journal']) {
        fs.rmSync(`${candidate}${suffix}`, { force: true });
      }
      expect(seqs.length).toBeGreaterThan(1);
      // BEHIND the tip the commitment pins, which is what makes
      // `contradictedChainCommitment` — the only chain check a structural pass
      // makes — read clean over this file.
      const target = seqs[0]!;
      expect(target).toBeLessThan(committed);
      underDroppedGuards(candidate, 'op_evidence', (raw) => {
        raw.prepare(`UPDATE op_evidence SET payload = ? WHERE seq = ?`).run('{"t":1}', target);
      });

      const copy = new Database(candidate, { readonly: true }) as unknown as HqDatabase;
      expect(structuralIntegrity(copy).safeMode).toBe(false);
      expect(verifyEvidenceChain(copy)).toBe(target);
      copy.close();
      for (const suffix of ['-wal', '-shm', '-journal']) {
        fs.rmSync(`${candidate}${suffix}`, { force: true });
      }

      const verdict = verifyHqBackupFile(candidate, { assessCandidate: assessLikeHq });
      expect(verdict.verified).toBe(false);
      expect(verdict.refusals).toContain('would_latch_safe_mode');
      expect(verdict.blockingFindings).toContain('evidence_chain_broken');
      expect(verdict.chainVerified).toBe(false);

      const refused = fx.ops.recordVerifiedBackup({
        backupPath: candidate,
        requestedBy: 'founder',
        note: 'nightly recovery point',
      });
      expect(refused.ok).toBe(false);
      expect(fx.ops.listVerifiedBackupsBounded().backups).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('treats an assessment that could not RUN as a refusal, never as a pass', async () => {
    const fx = fileFixture();
    try {
      const candidate = path.join(fx.dir, 'honest.sqlite');
      await fx.db.backup(candidate);

      // Public package API: a JavaScript caller can reach this with no options
      // at all, and `fullIntegrity`'s rule for a missing verifier applies here
      // too — an absent BLOCKING check is not a passed one.
      const missing = (
        verifyHqBackupFile as unknown as (c: string) => ReturnType<typeof verifyHqBackupFile>
      )(candidate);
      expect(missing.verified).toBe(false);
      expect(missing.refusals).toContain('candidate_census_unavailable');
      expect(missing.chainVerified).toBe(false);
      expect(missing.integrityVerdict).toContain('could not run');

      const threw = verifyHqBackupFile(candidate, {
        assessCandidate: () => {
          throw new Error('no');
        },
      });
      expect(threw.refusals).toContain('candidate_census_unavailable');
      expect(threw.verified).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('costs nothing true: an honest backup verifies, records, and is not written to', async () => {
    const fx = fileFixture();
    try {
      expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      const candidate = path.join(fx.dir, 'honest.sqlite');
      await fx.db.backup(candidate);
      const before = createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');

      const verdict = verifyHqBackupFile(candidate, { assessCandidate: assessLikeHq });
      expect(verdict.verified).toBe(true);
      expect(verdict.refusals).toEqual([]);
      expect(verdict.integrityVerdict).toBe('ok');
      // The whole log was walked and stood — a claim `verified` alone does not
      // make, and the reason it is published separately.
      expect(verdict.chainVerified).toBe(true);

      // The candidate is byte-identical and carries no sidecar, after an
      // assessment that now reads the verdict ledger and walks the whole
      // evidence log. Those reads happen against HQ's own scratch copy.
      expect(createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')).toBe(before);
      expect(verdict.digest).toBe(before);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(fs.existsSync(`${candidate}${suffix}`)).toBe(false);
      }

      const recorded = expectOk(
        fx.ops.recordVerifiedBackup({
          backupPath: candidate,
          requestedBy: 'founder',
          note: 'nightly recovery point',
        }),
      );
      expect(recorded.backup.contentDigest).toBe(before);
      // The Founder-facing statement says both new checks, because the code
      // now makes both.
      expect(recorded.backup.statement).toContain('RECORDS ABOUT ITSELF');
      expect(recorded.backup.statement).toContain('walked link by link');
    } finally {
      fx.cleanup();
    }
  });

  it('the certification path passes HQ its own assessor rather than none', () => {
    // Derived from the source: the behavioural assertions above prove the
    // property, and this proves the SHIPPED call site is the one that has it.
    const source = fs.readFileSync(SERVICE, 'utf8');
    const at = source.indexOf('const verification = verifyHqBackupFile(');
    expect(at).toBeGreaterThan(-1);
    const call = source.slice(at, source.indexOf('});', at));
    expect(call).toContain('assessCandidate: assessHqBackupCandidate');
  });
});
