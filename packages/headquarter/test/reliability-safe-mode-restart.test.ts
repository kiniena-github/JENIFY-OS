/**
 * Wave 5 review, correction cycle 2 — the HIGH.
 *
 * **A plain restart used to clear an `evidence_chain_broken` safe mode.**
 *
 * The first correction closed the PATCH route to defeating safe mode: the
 * evidence-chain verification moved off `queue.evidence.verifyChain` and onto a
 * `#private` closure over the facade's own handle, and five different hostile
 * patches were proven not to move the verdict. It did not close the RESTART
 * route, which needs no patch and no privilege at all — just process exit.
 *
 * The mechanism was small and total:
 *
 *  - the constructor latched `structuralIntegrity(...)`, which reads the schema
 *    catalogue and the durability pragmas and NEVER verified the chain;
 *  - only `fullIntegrity` verified it, and only `assessHqIntegrity` called that;
 *  - the latched verdict was never persisted — no row, no flag, no file;
 *  - and every HQ entrypoint (`hq:order`, `hq:snapshot`, `hq:workforce`,
 *    `hq:dispatch-claude`, `hq:ingest-claude`) is a fresh process, so the latch
 *    survived at most one command.
 *
 * The reviewer's probe, reproduced below as the first test in this file:
 * break the chain by a LEGAL raw append, assess, watch safe mode engage and
 * `claimNext` / `releaseKillSwitch` refuse — then construct a NEW facade with
 * no assessment and watch both be ALLOWED while the break was still in the
 * file, with the unauthenticated snapshot publishing `safeMode: false` about
 * it. That last line is the exact failure the phase document names as the one
 * it exists to prevent.
 *
 * ## The design, and why it is the root cause fix
 *
 * The construction now VERIFIES THE CHAIN. Nothing is carried across the boot,
 * which is the point: a persisted latch would live in the same file the tamper
 * is in and could be edited by the same access that broke the chain, so the
 * verdict is re-DERIVED from the bytes instead. A new process re-finds the
 * break because the break is still there.
 *
 * Two other options were weighed. Persisting the latch fails on the objection
 * above. Failing closed on the absence of a full assessment, alone, would refuse
 * every act on every boot — an outage, not a safety posture. So the fail-closed
 * rule is kept for the case it actually fits: a chain posture of `not_verified`
 * engages safe mode, which is why the verification argument is REQUIRED rather
 * than optional and why the enforcement points and every published view carry
 * the posture rather than inferring it from `depth`.
 *
 * The measured cost is stated rather than assumed: ~9µs per evidence entry on
 * this repository's own hardware (~2ms at 200 entries, ~170ms at 20,000). It is
 * linear and unbounded, and that is recorded as disclosed debt rather than
 * capped — a cap would mean publishing `safeMode: false` about an unexamined
 * tail, which is the lie this change removes.
 */

import { describe, expect, it } from 'vitest';
import { fileFixture } from './reliability.fixture.js';
import { expectOk, CAPS } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { EvidenceLog, verifyEvidenceChain } from '../src/operator/evidence.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import {
  EVIDENCE_CHAIN_POSTURES,
  SAFE_MODE_STATEMENT,
  INTEGRITY_DEPTH_STATEMENT,
  structuralIntegrity,
  fullIntegrity,
} from '../src/store/integrity.js';

/**
 * Break the chain the way a tamper actually can: a LEGAL APPEND from a raw
 * connection.
 *
 * `op_evidence` carries no engine triggers — its guarantee is the hash chain,
 * not the engine — so an INSERT is a permitted operation. The forged row
 * carries a `prev_hash` and `hash` that do not follow from the row before it,
 * which is precisely what the chain exists to detect. Nothing is UPDATEd and
 * nothing is DELETEd, so no other guard in the system has anything to say
 * about it.
 */
function breakChainByLegalAppend(fx: ReturnType<typeof fileFixture>): number {
  const raw = fx.raw();
  const tail = raw.prepare(`SELECT MAX(seq) AS seq FROM op_evidence`).get() as { seq: number };
  raw
    .prepare(
      `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      'forged-entry',
      new Date().toISOString(),
      'intruder',
      'forged_kind',
      JSON.stringify({ forged: true }),
      'not-the-previous-hash',
      'not-a-real-hash',
    );
  return tail.seq + 1;
}

function failure(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) throw new Error('expected a refusal, got ok');
  return result.error.code;
}

describe('a broken evidence chain survives a restart', () => {
  it('re-engages safe mode on a NEW facade that ran no assessment at all', () => {
    const fx = fileFixture();
    try {
      const brokenAt = breakChainByLegalAppend(fx);
      expect(verifyEvidenceChain(fx.raw())).toBe(brokenAt);

      // ---- the reviewer's step 1: assess, and watch safe mode engage.
      const assessed = expectOk(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      expect(assessed.safeMode).toBe(true);
      expect(assessed.evidenceChain).toBe('broken');
      expect(assessed.observations.map((o) => o.finding)).toContain('evidence_chain_broken');
      expect(failure(fx.ops.claimNext('claude', CAPS.openPr, 60_000))).toBe('safe_mode_engaged');
      expect(failure(fx.ops.releaseKillSwitch('all', 'founder'))).toBe('safe_mode_engaged');

      // ---- the reviewer's step 2: AFTER RESTART, NO ASSESSMENT.
      // This is the whole finding. Before the fix both of the next two lines
      // said ALLOWED.
      const restarted = fx.reopen('process-two');
      expect(failure(restarted.ops.claimNext('claude', CAPS.openPr, 60_000))).toBe(
        'safe_mode_engaged',
      );
      expect(failure(restarted.ops.releaseKillSwitch('all', 'founder'))).toBe('safe_mode_engaged');

      // The verdict the new process holds was DERIVED, not inherited: it never
      // read a stored latch, because there is none to read.
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(posture.integrity.evidenceChain).toBe('broken');
      expect(posture.integrity.depth).toBe('structural');
      expect(posture.integrity.observations.map((o) => o.finding)).toContain(
        'evidence_chain_broken',
      );

      // And the break really is still in the file — the new process did not
      // repair it, and could not: HQ never rewrites its own audit log.
      expect(verifyEvidenceChain(fx.raw())).toBe(brokenAt);
    } finally {
      fx.cleanup();
    }
  });

  it('does not publish safeMode false to a stranger after that restart', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);
      const restarted = fx.reopen('process-two');

      const summary = restarted.ops.reliabilitySummary();
      expect(summary.safeMode).toBe(true);
      expect(summary.evidenceChain).toBe('broken');
      expect(summary.findings.evidence_chain_broken).toBe(1);

      // The unauthenticated artifact itself, not just the fold behind it.
      const snapshot = liveSnapshotFromOperations(restarted.ops, {
        now: new Date().toISOString(),
      });
      const section = snapshot.reliability!;
      expect(section.data.safeMode).toBe(true);
      expect(section.data.evidenceChain).toBe('broken');
      expect(section.provenance.note).toContain('does NOT verify');
      // No detail text, no seq, no forged actor or kind crosses — the finding
      // MAP is the only thing that names it.
      const rendered = JSON.stringify(section);
      expect(rendered).not.toContain('forged');
      expect(rendered).not.toContain('intruder');
    } finally {
      fx.cleanup();
    }
  });

  it('refuses every enforcement point that matters, on the restarted facade', () => {
    const fx = fileFixture();
    try {
      // A real task to approve and a live claim to write a run against, taken
      // BEFORE the tamper so the refusals below are about safe mode and not
      // about a missing precondition.
      const pending = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { branch: 'to-approve' },
          idempotencyKey: 'to-approve',
          requestedBy: 'claude',
        }),
      );
      breakChainByLegalAppend(fx);
      const restarted = fx.reopen('process-two');

      expect(failure(restarted.ops.claimNext('claude', CAPS.openPr, 60_000))).toBe(
        'safe_mode_engaged',
      );
      expect(
        failure(
          restarted.ops.approveTask({
            taskId: pending.task.id,
            founderId: 'founder',
            // Refused before the digest is even compared: safe mode is checked
            // ahead of the approval's own preconditions, so a deliberately
            // wrong digest here still proves the safe-mode refusal fired.
            expectedActionDigest: 'whatever-the-console-rendered',
          }),
        ),
      ).toBe('safe_mode_engaged');
      expect(failure(restarted.ops.releaseKillSwitch('all', 'founder'))).toBe('safe_mode_engaged');
      expect(
        failure(
          restarted.ops.openRun({
            taskId: fx.claim.taskId,
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
            runKind: 'external_action',
            label: 'a run',
          }),
        ),
      ).toBe('safe_mode_engaged');
      expect(
        failure(
          // Refused BEFORE the reservation, so a non-existent actionId still
          // proves the point: safe mode is checked ahead of every canonical
          // lookup, which is what "no side-effect key is burned" means.
          restarted.ops.executeAction({
            actionId: 'act-does-not-matter',
            workerId: fx.claim.workerId,
            fence: fx.claim.fence,
          }),
        ),
      ).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('does NOT engage safe mode on the same restart when the chain is intact', () => {
    // The control. A fix that refused everything would also pass every
    // assertion above, so the healthy path is proven in the same file.
    const fx = fileFixture();
    try {
      const restarted = fx.reopen('process-two');
      const posture = restarted.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(false);
      expect(posture.integrity.evidenceChain).toBe('verified');
      expect(restarted.ops.reliabilitySummary().safeMode).toBe(false);
      // `nothing_claimable`, not `safe_mode_engaged`: the queue is empty
      // because the fixture's one task is already claimed. The distinction is
      // the point — a healthy HQ hands work out.
      expect(failure(restarted.ops.claimNext('claude', CAPS.openPr, 60_000))).toBe(
        'nothing_claimable',
      );
      expect(restarted.ops.releaseKillSwitch('all', 'founder').ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('the chain verdict stays enforcement-safe under a hostile patch', () => {
  /**
   * The first correction proved this for the ASSESSMENT path. The verification
   * now also runs at CONSTRUCTION, so the same patches are re-run against the
   * boot path — a hardening that moved to a new call site is a hardening that
   * has to be re-proved at the new call site.
   */
  it('ignores the patched delegate on the instance, on the prototype, and after construction', () => {
    const fx = fileFixture();
    try {
      breakChainByLegalAppend(fx);

      // (1) on the INSTANCE.
      const restarted = fx.reopen('process-two');
      const instancePatched = { ...restarted.ops.queue.evidence, verifyChain: () => null };
      (restarted.ops.queue as { evidence: unknown }).evidence = instancePatched;
      expect(restarted.ops.queue.evidence.verifyChain()).toBe(null); // the patch took
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
      expect(failure(restarted.ops.claimNext('claude', CAPS.openPr, 60_000))).toBe(
        'safe_mode_engaged',
      );

      // (2) on the PROTOTYPE.
      const original = EvidenceLog.prototype.verifyChain;
      try {
        EvidenceLog.prototype.verifyChain = () => null;
        expect(new EvidenceLog(fx.db).verifyChain()).toBe(null); // the patch took
        // (3) against a facade constructed AFTER the patch — the boot path is
        // the one this correction added, so it is the one that matters here.
        const third = fx.reopen('process-three');
        expect(third.ops.hqReliabilityPosture().integrity.evidenceChain).toBe('broken');
        expect(third.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);
        expect(third.ops.reliabilitySummary().safeMode).toBe(true);
        expect(failure(third.ops.releaseKillSwitch('all', 'founder'))).toBe('safe_mode_engaged');
      } finally {
        EvidenceLog.prototype.verifyChain = original;
      }

      // Independent recomputation, over a connection that ran none of this
      // code, confirms the break was real all along.
      expect(verifyEvidenceChain(fx.raw())).not.toBe(null);
    } finally {
      fx.cleanup();
    }
  });
});

describe('a chain that was not verified is never reported as fine', () => {
  it('fails closed: not_verified engages safe mode exactly as a break does', () => {
    const fx = fileFixture();
    try {
      // A caller that deliberately declines to verify. The argument is
      // REQUIRED, so this is the only way to reach the posture — "forgot to
      // verify" is a type error rather than a silent all-clear.
      const declined = structuralIntegrity(fx.db, { verifyEvidenceChain: null });
      expect(declined.evidenceChain).toBe('not_verified');
      expect(declined.safeMode).toBe(true);
      // And it is not a FINDING: HQ found nothing, it simply did not look.
      expect(declined.observations.filter((o) => o.blocking)).toEqual([]);

      const declinedFull = fullIntegrity(fx.db, { verifyEvidenceChain: null });
      expect(declinedFull.depth).toBe('full');
      expect(declinedFull.evidenceChain).toBe('not_verified');
      expect(declinedFull.safeMode).toBe(true);

      // The healthy comparison, at both depths.
      const verifier = () => verifyEvidenceChain(fx.db);
      expect(structuralIntegrity(fx.db, { verifyEvidenceChain: verifier }).evidenceChain).toBe(
        'verified',
      );
      expect(structuralIntegrity(fx.db, { verifyEvidenceChain: verifier }).safeMode).toBe(false);
      expect(fullIntegrity(fx.db, { verifyEvidenceChain: verifier }).evidenceChain).toBe(
        'verified',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('keeps the posture a closed three-member vocabulary', () => {
    expect([...EVIDENCE_CHAIN_POSTURES]).toEqual(['verified', 'broken', 'not_verified']);
  });

  it('verifies the chain ONCE per assessment, not twice', () => {
    // Two computations of the same verdict can disagree, and this one is
    // O(log) — the single most expensive thing a construction does.
    const fx = fileFixture();
    try {
      let calls = 0;
      const report = fullIntegrity(fx.db, {
        verifyEvidenceChain: () => {
          calls += 1;
          return null;
        },
      });
      expect(calls).toBe(1);
      expect(report.evidenceChain).toBe('verified');
    } finally {
      fx.cleanup();
    }
  });
});

describe('the published statements are literally true', () => {
  it('no longer claims safe mode is never cleared by a boot without saying which half', () => {
    // The old sentence read "It is never cleared by a boot", and for a
    // missing-guard finding that was false: the ensures repair the file, so
    // the next construction legitimately finds a healthy one.
    expect(SAFE_MODE_STATEMENT).not.toContain('It is never cleared by a boot');
    // What IS true, and now said: the chain half cannot be cleared by exiting.
    expect(SAFE_MODE_STATEMENT).toContain('A BROKEN CHAIN CANNOT BE CLEARED BY RESTARTING');
    // And the guard half is stated rather than overclaimed.
    expect(SAFE_MODE_STATEMENT).toContain('the schema ensures re-create a dropped guard');
    // The fail-closed rule is part of the published statement, not folklore.
    expect(SAFE_MODE_STATEMENT).toContain('has not been verified at all in this process');
  });

  it('no longer describes a structural pass as catalogue-and-pragmas only', () => {
    expect(INTEGRITY_DEPTH_STATEMENT).toContain('the evidence hash chain');
    expect(INTEGRITY_DEPTH_STATEMENT).toContain('A structural pass is never reported as a full one');
  });

  it('records the boot-time guard observation in the append-only log when a Founder assesses', () => {
    // LOW 1's honest half. The fresh assessment CANNOT re-find a guard tamper —
    // this process already repaired the file — so the observation would be
    // lost at exit if the assessment did not carry it into the evidence log.
    const fx = fileFixture();
    try {
      fx.raw().exec('DROP TRIGGER trg_hq_intel_costs_no_replace_unique');
      const restarted = fx.reopen('process-two');
      expect(restarted.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      const assessed = expectOk(restarted.ops.assessHqIntegrity({ requestedBy: 'founder' }));
      // The guard is back (the ensures re-created it), so the fresh assessment
      // is clean — that is correct and is what clears the posture.
      expect(assessed.safeMode).toBe(false);

      const entries = restarted.ops.queue.evidence.list();
      const record = entries.filter((e) => e.kind === 'hq_integrity_assessed').at(-1)!;
      const payload = record.payload as Record<string, unknown>;
      expect(payload.guardsMissingAtConstruction).toBe(1);
      expect(payload.guardsMissingAtConstructionNames).toEqual([
        'trg_hq_intel_costs_no_replace_unique',
      ]);
      expect(payload.evidenceChain).toBe('verified');
      // Appending it did not break the chain it was appended to.
      expect(verifyEvidenceChain(fx.raw())).toBe(null);
    } finally {
      fx.cleanup();
    }
  });

  it('writes NOTHING at construction — the boot observation costs no hidden write', () => {
    const fx = fileFixture();
    try {
      const raw = fx.raw();
      const before = raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number };
      const beforeEvents = raw.prepare(`SELECT COUNT(*) AS n FROM hq_events`).get() as { n: number };
      const restarted = fx.reopen('process-two');
      void new HeadquarterOperations(restarted.db);
      const after = raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number };
      const afterEvents = raw.prepare(`SELECT COUNT(*) AS n FROM hq_events`).get() as { n: number };
      expect(after.n).toBe(before.n);
      expect(afterEvents.n).toBe(beforeEvents.n);
    } finally {
      fx.cleanup();
    }
  });
});
