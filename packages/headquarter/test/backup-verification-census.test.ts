/**
 * `verifyHqBackupFile` runs HQ's OWN tamper detection before it publishes a
 * verdict (Wave 5 correction round ten, HIGH 4).
 *
 * ## What was open
 *
 * From the point the candidate was opened to the end of the function, exactly
 * two things ran against it: `tableNames(db)` and `PRAGMA integrity_check`.
 * None of `structuralIntegrity`, `truncatedImmutableLedgers`,
 * `missingImmutabilityGuards`, `regressedImmutableLedgers`,
 * `elidedCommitmentLedgerRows` or `contradictedChainCommitment` was consulted —
 * and an `integrityVerdict` was published on that basis.
 *
 * Executed: a backup whose committed `op_evidence` audit row had been erased
 * with the guards temporarily dropped verified
 * `{ verified: true, refusals: [], integrityVerdict: 'ok' }`, while the SAME
 * BYTES opened live gave `safeMode: true` with
 * `['append_only_guard_missing', 'append_only_ledger_truncated']`.
 * `recordVerifiedBackup` then accepted it into the append-only
 * `hq_reliability_backups` — and that is one of the two acts deliberately left
 * AVAILABLE during safe mode, so the designed workflow steered a Founder to
 * certify a recovery point at exactly the moment HQ had said the store could
 * not be trusted. The register is `no_rewrite`/`no_erase`, so the
 * certification was permanent.
 *
 * ## What this file pins
 *
 * The matched pair the review used: the same tamper, against the LIVE file and
 * against a BACKUP of it, must reach the same verdict. Plus the two properties
 * a stricter check must not cost — an honest backup still verifies and is still
 * recordable, and the verification never writes to the file it is checking.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { fileFixture } from './reliability.fixture.js';
import { expectOk } from './application.fixture.js';
import { verifyHqBackupFile } from '../src/store/integrity.js';
import { openHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';

/**
 * Erase a committed row from an append-only ledger the way the census is meant
 * to notice: drop the guards, DELETE, put the guards back verbatim. A trigger
 * re-created before the next open is never observed missing by the as-found
 * schema census, which is why this attack needed a durable witness at all.
 */
function eraseCommittedRow(file: string, table: string): void {
  const raw = new Database(file);
  const triggers = (
    raw.prepare(`SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ?`).all(
      table,
    ) as { name: string; sql: string }[]
  ).filter((row) => typeof row.sql === 'string');
  for (const trigger of triggers) raw.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  raw.exec(`DELETE FROM ${table} WHERE rowid = (SELECT MAX(rowid) FROM ${table})`);
  for (const trigger of triggers) raw.exec(trigger.sql);
  raw.close();
}

describe('a backup that would latch safe mode is refused rather than verified', () => {
  it('reaches the same verdict as opening the same bytes live — the matched pair', async () => {
    const fx = fileFixture();
    try {
      // Warm the file so it carries real commitments to contradict.
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      const backupPath = path.join(fx.dir, 'tampered.sqlite');
      await fx.db.backup(backupPath);
      fx.db.close();

      // The control: untouched, the backup verifies.
      const honest = verifyHqBackupFile(backupPath);
      expect(honest.verified).toBe(true);
      expect(honest.refusals).toEqual([]);
      expect(honest.blockingFindings).toEqual([]);
      expect(honest.integrityVerdict).toBe('ok');

      // The tamper, applied to the BACKUP.
      eraseCommittedRow(backupPath, 'op_evidence');

      const verified = verifyHqBackupFile(backupPath);
      expect(verified.verified).toBe(false);
      expect(verified.refusals).toContain('would_latch_safe_mode');
      expect(verified.blockingFindings!.length).toBeGreaterThan(0);
      // The published verdict is no longer a bare `ok` over a file HQ's own
      // census refuses.
      expect(verified.integrityVerdict).not.toBe('ok');
      expect(verified.integrityVerdict).toContain('HQ append-only census');

      // And the same bytes, opened LIVE, latch safe mode — which is the whole
      // point: the two answers used to disagree.
      const live = path.join(fx.dir, 'same-bytes-live.sqlite');
      fs.copyFileSync(backupPath, live);
      const posture = liveSafeMode(live);
      expect(posture.safeMode).toBe(true);
      expect(posture.blocking.length).toBeGreaterThan(0);
      // Both lanes name at least one finding in common, so this is one verdict
      // reached twice rather than two unrelated alarms.
      expect(
        posture.blocking.some((finding) =>
          (verified.blockingFindings! as string[]).includes(finding),
        ),
      ).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('recordVerifiedBackup refuses to certify it — including while safe mode is engaged', async () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      const backupPath = path.join(fx.dir, 'certify-me.sqlite');
      await fx.db.backup(backupPath);
      eraseCommittedRow(backupPath, 'op_evidence');

      const refused = fx.ops.recordVerifiedBackup({
        backupPath,
        requestedBy: 'founder',
        note: 'nightly recovery point',
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(JSON.stringify(refused.error)).toContain('would_latch_safe_mode');
      // Nothing was written into the append-only register, which is the whole
      // guarantee: an accepted row here is permanent.
      expect(fx.ops.listVerifiedBackupsBounded().backups).toEqual([]);

      // The same, under a genuinely latched safe mode — the situation the
      // workflow actually steers a Founder into.
      fx.db.close();
      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_reliability_verdicts_no_erase');
      raw.close();
      const latched = fx.reopen('the-latched-process');
      expect(latched.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      const stillRefused = latched.ops.recordVerifiedBackup({
        backupPath,
        requestedBy: 'founder',
        note: 'nightly recovery point',
      });
      expect(stillRefused.ok).toBe(false);
      latched.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('an honest backup still verifies and is still recordable — the check costs nothing true', async () => {
    const fx = fileFixture();
    try {
      expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
      const backupPath = path.join(fx.dir, 'honest.sqlite');
      await fx.db.backup(backupPath);
      const recorded = expectOk(
        fx.ops.recordVerifiedBackup({
          backupPath,
          requestedBy: 'founder',
          note: 'nightly recovery point, verified by hand',
        }),
      );
      expect(recorded.backup.contentDigest).toBe(
        createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'),
      );
      // And the statement the Founder reads says what was and was not checked.
      expect(recorded.backup.statement).toContain('append-only census');
      expect(recorded.backup.statement).toContain('would latch SAFE MODE');
      expect(recorded.backup.statement).toContain('does not carry AT ALL');
    } finally {
      fx.cleanup();
    }
  });

  it('the verification never writes to the file it is checking', async () => {
    const fx = fileFixture();
    try {
      const backupPath = path.join(fx.dir, 'read-only.sqlite');
      await fx.db.backup(backupPath);
      eraseCommittedRow(backupPath, 'op_evidence');
      const before = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
      const verdict = verifyHqBackupFile(backupPath);
      expect(verdict.verified).toBe(false);
      const after = createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
      // A verification that repaired what it was checking would launder the
      // tamper it exists to find. Byte-for-byte identical, and the digest HQ
      // published is of exactly these bytes.
      expect(after).toBe(before);
      expect(verdict.digest).toBe(before);
      // No sidecar was left behind either.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        expect(fs.existsSync(`${backupPath}${suffix}`)).toBe(false);
      }
    } finally {
      fx.cleanup();
    }
  });
});

/** Open a file with a real facade and report its standing integrity verdict. */
function liveSafeMode(file: string): { safeMode: boolean; blocking: string[] } {
  const db = openHqDatabase(file);
  try {
    const ops = new HeadquarterOperations(db);
    const posture = ops.hqReliabilityPosture();
    return {
      safeMode: posture.integrity.safeMode,
      blocking: posture.integrity.observations.filter((o) => o.blocking).map((o) => o.finding),
    };
  } finally {
    db.close();
  }
}
