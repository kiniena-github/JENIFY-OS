/**
 * Phase 13 SURFACES: the three control routes end to end against the real
 * canonical machinery, and the unauthenticated snapshot section.
 *
 * What this suite proves:
 *
 *  - the three routes join the control API behind the SAME pipeline as every
 *    other route — origin/referer gate, client-identity scan of body AND
 *    query, Founder resolution, `safe()` on every response;
 *  - a signed-in non-Founder gets nothing, and a refused write changes no row;
 *  - there is NO route that opens a run, starts an attempt, records an
 *    outcome, assesses integrity, records a backup or clears safe mode, and no
 *    facade method sits behind an invented one;
 *  - recovering through the route retries NOTHING and touches no other ledger;
 *  - the unauthenticated artifact's new section carries counts over closed
 *    vocabularies and no identifier, path, digest or detail string of any kind.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { expectOk } from './application.fixture.js';
import { fileFixture } from './reliability.fixture.js';
import {
  RUN_KINDS,
  RUN_OUTCOMES,
  RUN_STATES,
  UNRECOGNIZED_BUCKET,
} from '../src/application/reliability-command.js';
import { HQ_INTEGRITY_FINDINGS } from '../src/store/integrity.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-07T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-coo', principalId: 'coo' },
];

/** A session older than the step-up window, so step-up asks for a password. */
const STALE = new Date(NOW.getTime() - 60 * 60_000).toISOString();

function account(accountId: string, authenticatedAt: string = FRESH): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt };
}
/** A signed-in account mapped to NO principal at all. */
const STAFF = account('user-staff');

interface Harness {
  fixture: ReturnType<typeof fileFixture>;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, next?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null } = {}): Harness {
  const fixture = fileFixture({ processIdentity: 'the-surface-process' });
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
    credentials: { verify: (_account, password) => (password === 'correct-password' ? 'ok' : 'rejected') },
  };
  return {
    fixture,
    audit,
    call(request, next) {
      if (next !== undefined) current = next;
      const method = request.method ?? 'GET';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        {
          method,
          path: request.path ?? CONTROL_ROUTES.reliability,
          headers,
          body: request.body,
          query: request.query,
        },
        deps,
      );
    },
  };
}

/** A run standing at an unknown outcome, opened by a process that is gone. */
function unknownRun(h: Harness): string {
  const dead = h.fixture.reopen('a-process-that-is-gone');
  const run = expectOk(
    dead.ops.openRun({
      taskId: h.fixture.claim.taskId,
      workerId: 'claude',
      fence: h.fixture.claim.fence,
      runKind: 'external_action',
      label: 'work whose fate is unknown',
    }),
  ).run;
  expectOk(
    dead.ops.startRunAttempt({ runId: run.id, workerId: 'claude', fence: h.fixture.claim.fence }),
  );
  return run.id;
}

describe('the reliability READ', () => {
  it('answers the Founder with the posture, the runs, the backups and the vocabularies', () => {
    const h = harness();
    try {
      unknownRun(h);
      const response = h.call({});
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.ok).toBe(true);
      const posture = body.posture as Record<string, unknown>;
      expect(posture.processIdentity).toBe('the-surface-process');
      expect(posture.storePresent).toBe(true);
      expect((posture.runs as Record<string, number>).total).toBe(1);
      expect((posture.runs as Record<string, number>).openedByOtherProcesses).toBe(1);
      expect(posture.ledgerStatement).toMatch(/EXECUTION AUDIT/);
      expect(body.runTotal).toBe(1);
      expect((body.runs as Record<string, unknown>[])[0]!.externalActionTaken).toBe(false);
      expect((body.vocabulary as Record<string, unknown[]>).runKinds).toEqual([...RUN_KINDS]);
      expect((body.vocabulary as Record<string, unknown[]>).integrityFindings).toEqual([
        ...HQ_INTEGRITY_FINDINGS,
      ]);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('is a pure read: it re-assesses nothing, latches nothing and writes nothing', () => {
    const h = harness();
    try {
      unknownRun(h);
      const before = h.fixture.raw().prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get();
      const first = h.call({});
      const second = h.call({});
      expect((first.body.posture as Record<string, unknown>).integrity).toEqual(
        (second.body.posture as Record<string, unknown>).integrity,
      );
      expect((first.body.posture as Record<string, Record<string, unknown>>).integrity.depth).toBe(
        'structural',
      );
      expect(h.fixture.raw().prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get()).toEqual(before);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('tells a signed-in non-Founder nothing at all', () => {
    const h = harness({ account: STAFF });
    try {
      const response = h.call({});
      expect(response.status).toBe(403);
      expect(response.body.ok).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain('processIdentity');
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses an unauthenticated caller on all three routes', () => {
    const h = harness({ account: null });
    try {
      for (const path of [
        CONTROL_ROUTES.reliability,
        CONTROL_ROUTES.reliabilityRecover,
        CONTROL_ROUTES.reliabilityReconcile,
      ]) {
        const writes = CONTROL_WRITE_ROUTES.includes(path);
        const response = h.call({ method: writes ? 'POST' : 'GET', path, body: writes ? {} : undefined });
        expect(response.status, path).toBe(401);
        expect(response.body.ok, path).toBe(false);
      }
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('the recovery route', () => {
  it('classifies through the route, retries nothing, and says so on the wire', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      const beforeTasks = h.fixture.raw().prepare(`SELECT * FROM op_tasks ORDER BY id`).all();
      const response = h.call({ method: 'POST', path: CONTROL_ROUTES.reliabilityRecover, body: {} });
      expect(response.status).toBe(200);
      expect(response.body.retriedAnything).toBe(false);
      expect(response.body.externalActionTaken).toBe(false);
      const report = response.body.report as Record<string, unknown>;
      expect(report.interruptedTotal).toBe(1);
      expect(report.nowNeedingReconciliation).toBe(1);
      expect(h.fixture.ops.getRun(runId)!.state).toBe('needs_reconciliation');
      // The queue's own rows are untouched.
      expect(h.fixture.raw().prepare(`SELECT * FROM op_tasks ORDER BY id`).all()).toEqual(beforeTasks);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses an unknown interruption reason rather than coercing it', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.reliabilityRecover,
        body: { reason: 'it seemed fine' },
      });
      expect(response.status).toBe(400);
      expect((response.body.error as Record<string, string>).code).toBe('invalid_input');
    } finally {
      h.fixture.cleanup();
    }
  });

  it('changes nothing for a signed-in non-Founder', () => {
    const h = harness({ account: STAFF });
    try {
      const runId = unknownRun(h);
      const response = h.call({ method: 'POST', path: CONTROL_ROUTES.reliabilityRecover, body: {} });
      expect(response.status).toBe(403);
      expect(h.fixture.ops.getRun(runId)!.state).toBe('attempting');
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses a body that names an actor instead of re-attributing it', () => {
    const h = harness();
    try {
      const response = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.reliabilityRecover,
        body: { requestedBy: 'founder', principalId: 'founder' },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.ok).toBe(false);
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('the reconcile route', () => {
  it('closes an unknown outcome under the resolved Founder', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      expectOk(h.fixture.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      const response = h.call(
        {
          method: 'POST',
          path: CONTROL_ROUTES.reliabilityReconcile,
          body: {
            runId,
            decision: 'confirmed_failed',
            note: 'checked the provider; the request never landed',
          },
        },
        account('user-coo'),
      );
      expect(response.status).toBe(200);
      const run = response.body.run as Record<string, unknown>;
      expect(run.state).toBe('concluded');
      expect(run.outcome).toBe('failed');
      expect(run.externalActionTaken).toBe(false);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses an unknown run with a 404 and an unknown decision with a 400', () => {
    const h = harness();
    try {
      const missing = h.call(
        {
          method: 'POST',
          path: CONTROL_ROUTES.reliabilityReconcile,
          body: { runId: 'run-that-never-existed', decision: 'confirmed_failed', note: 'x' },
        },
        account('user-coo'),
      );
      expect(missing.status).toBe(404);
      const nonsense = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.reliabilityReconcile,
        body: { runId: 'anything', decision: 'confirmed_obviously_fine', note: 'x' },
      });
      expect(nonsense.status).toBe(400);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('refuses a note that looks like a credential rather than storing it', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      expectOk(h.fixture.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      const response = h.call(
        {
          method: 'POST',
          path: CONTROL_ROUTES.reliabilityReconcile,
          body: {
            runId,
            decision: 'confirmed_failed',
            note: 'retried with api_key="sk-abcdefghijklmnop" and it worked',
          },
        },
        account('user-coo'),
      );
      expect(response.status).toBe(400);
      expect(h.fixture.ops.getRun(runId)!.state).toBe('needs_reconciliation');
    } finally {
      h.fixture.cleanup();
    }
  });

  /**
   * Wave 5 High 4. This was the only reconciliation route in HQ without
   * step-up, while Phase 8's `actionReconcile` takes it unconditionally — and
   * the two share their decision vocabulary BY IDENTITY because they are the
   * same judgement. `confirmed_not_executed` here re-opens the run for another
   * attempt generation, so the route also grants a further act.
   */
  it('takes STEP-UP unconditionally, exactly like the Phase 8 action reconcile route', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      expectOk(h.fixture.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      const body = {
        runId,
        decision: 'confirmed_failed',
        note: 'checked the provider; the request never landed',
      };

      // A session older than the step-up window, with no password: 401, and
      // the run is untouched.
      const bare = h.call(
        { method: 'POST', path: CONTROL_ROUTES.reliabilityReconcile, body },
        account('user-coo', STALE),
      );
      expect(bare.status).toBe(401);
      expect((bare.body.error as { code: string }).code).toBe('step_up_required');
      expect(h.fixture.ops.getRun(runId)!.state).toBe('needs_reconciliation');

      // The wrong password: 403, still untouched.
      const wrong = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.reliabilityReconcile,
        body: { ...body, stepUpPassword: 'nope' },
      });
      expect(wrong.status).toBe(403);
      expect((wrong.body.error as { code: string }).code).toBe('step_up_failed');
      expect(h.fixture.ops.getRun(runId)!.state).toBe('needs_reconciliation');

      // The right password: through, and the password never reaches the audit.
      const allowed = h.call({
        method: 'POST',
        path: CONTROL_ROUTES.reliabilityReconcile,
        body: { ...body, stepUpPassword: 'correct-password' },
      });
      expect(allowed.status).toBe(200);
      expect(h.fixture.ops.getRun(runId)!.outcome).toBe('failed');
      expect(JSON.stringify(h.audit)).not.toContain('correct-password');
    } finally {
      h.fixture.cleanup();
    }
  });

  it('advertises the reconcile control beside the recover one, as Phase 8 advertises its own', () => {
    const h = harness();
    try {
      const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<
        string,
        boolean
      >;
      expect(controls.reliabilityRecover).toBe(true);
      expect(controls.reliabilityReconcile).toBe(true);
      expect(controls.actionReconcile).toBe(true);
    } finally {
      h.fixture.cleanup();
    }
  });
});

describe('what the control table deliberately does NOT contain', () => {
  it('has no route that opens a run, attempts one, records an outcome, assesses or backs up', () => {
    const h = harness();
    try {
      for (const invented of [
        '/api/hq/control/reliability/open',
        '/api/hq/control/reliability/attempt',
        '/api/hq/control/reliability/outcome',
        '/api/hq/control/reliability/assess',
        '/api/hq/control/reliability/backup',
        '/api/hq/control/reliability/restore',
        '/api/hq/control/reliability/safe-mode',
        '/api/hq/control/reliability/retry',
      ]) {
        const response = h.call({ method: 'POST', path: invented, body: {} });
        expect(response.status, invented).toBe(404);
      }
    } finally {
      h.fixture.cleanup();
    }
  });

  it('has no path SEGMENT anywhere spelling retry, restore, repair, force or override', () => {
    // Pinned against the route table itself rather than against a list a test
    // maintains: a future route that spells any of these fails here. Matched
    // per SEGMENT rather than as a substring, so `workforce` — which contains
    // "force" and has nothing to do with any of this — is not a false hit.
    for (const path of Object.values(CONTROL_ROUTES)) {
      for (const segment of path.split('/')) {
        expect(segment, path).not.toMatch(/^(retry|restore|repair|force|override)$/i);
      }
    }
  });

  it('names the reliability writes on the stated write surface, and the read not at all', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.reliabilityRecover);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.reliabilityReconcile);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.reliability);
  });
});

describe('the unauthenticated snapshot section', () => {
  it('carries counts over closed vocabularies and no identifier, path, digest or detail', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      expectOk(h.fixture.ops.recoverInterruptedRuns({ requestedBy: 'founder' }));
      const snapshot = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
      const section = snapshot.reliability!;
      expect(Object.keys(section.data).sort()).toEqual([
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
        // Added by Wave 5 correction round fifteen, Medium 2. Three shipped
        // sentences claimed `SAFE_MODE_STATEMENT` was served on this
        // unauthenticated artifact and it was on no part of it — executed with
        // safe mode genuinely engaged at `c23dd0a`, the statement did not
        // appear in any form. It is a fixed CONSTANT carrying no per-file data,
        // so the privacy assertions below are unaffected and the whole-artifact
        // identifier scan still holds; what changes is that the disclosure is
        // now as wide as the pages say it is.
        'safeModeStatement',
        'storePresent',
        'verifiedBackups',
      ]);
      expect(section.data.runs).toBe(1);
      expect(section.data.needsReconciliation).toBe(1);
      expect(section.data.byState.needs_reconciliation).toBe(1);
      expect(Object.keys(section.data.byKind).sort()).toEqual(
        [...RUN_KINDS, UNRECOGNIZED_BUCKET].sort(),
      );
      expect(Object.keys(section.data.byState).sort()).toEqual(
        [...RUN_STATES, UNRECOGNIZED_BUCKET].sort(),
      );
      expect(Object.keys(section.data.byOutcome).sort()).toEqual(
        [...RUN_OUTCOMES, UNRECOGNIZED_BUCKET].sort(),
      );

      // Whole-artifact scan: not one operational identifier crosses.
      const serialized = JSON.stringify(snapshot.reliability);
      expect(serialized).not.toContain(runId);
      expect(serialized).not.toContain('work whose fate is unknown');
      expect(serialized).not.toContain(h.fixture.claim.taskId);
      expect(serialized).not.toContain('claude');
      expect(serialized).not.toContain('a-process-that-is-gone');
      expect(serialized).not.toContain(h.fixture.dbPath);
      expect(section.data.note).toMatch(/Counts over closed vocabularies only/);
      expect(section.provenance.note).toMatch(/never retries an uncertain outcome/i);
    } finally {
      h.fixture.cleanup();
    }
  });

  it('publishes safeMode truthfully, with the finding CATEGORY and never its detail', () => {
    const h = harness();
    try {
      h.fixture.raw().exec('DROP TRIGGER trg_hq_truth_records_no_erase');
      const restarted = h.fixture.reopen('a-tampered-boot');
      const snapshot = liveSnapshotFromOperations(restarted.ops, { now: NOW.toISOString() });
      const section = snapshot.reliability!;
      expect(section.data.safeMode).toBe(true);
      expect(section.data.findings).toEqual({ append_only_guard_missing: 1 });
      expect(section.provenance.note).toMatch(/SAFE MODE/);
      // The detail string names a trigger; it must not reach the artifact.
      expect(JSON.stringify(snapshot.reliability)).not.toContain('trg_hq_truth_records_no_erase');
    } finally {
      h.fixture.cleanup();
    }
  });

  it('counts a forged run kind as unrecognized without publishing its text', () => {
    const h = harness();
    try {
      const runId = unknownRun(h);
      // An APPEND is the write the triggers deliberately permit, so a row
      // carrying a kind outside the vocabulary is representable in the file.
      // Insert one directly, as a hostile writer would.
      h.fixture
        .raw()
        .prepare(
          `INSERT INTO hq_reliability_runs
             (id, run_kind, task_id, mission_id, action_id, capability_id, worker_id, claim_fence,
              claim_nonce, process_id, label, opened_at, run_key)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, NULL, ?, ?, ?, ?)`,
        )
        .run(
          'run-forged',
          'SUPER SECRET PROJECT NAME',
          h.fixture.claim.taskId,
          'github.open_pr',
          'claude',
          'p',
          'ANOTHER SECRET',
          '2026-01-01T00:00:00.000Z',
          'run:forged-key',
        );
      const snapshot = liveSnapshotFromOperations(h.fixture.reopen('reader').ops, { now: NOW.toISOString() });
      const serialized = JSON.stringify(snapshot.reliability);
      expect(serialized).not.toContain('SUPER SECRET PROJECT NAME');
      expect(serialized).not.toContain('ANOTHER SECRET');
      expect(snapshot.reliability!.data.byKind[UNRECOGNIZED_BUCKET]).toBe(1);
      expect(snapshot.reliability!.data.runs).toBe(2);
      // Every count is an integer, and the map totals what was folded.
      const kindTotal = Object.values(snapshot.reliability!.data.byKind).reduce((a, b) => a + b, 0);
      expect(kindTotal).toBe(snapshot.reliability!.data.runs);
      for (const value of Object.values(snapshot.reliability!.data.byOutcome)) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(runId).toBeTruthy();
    } finally {
      h.fixture.cleanup();
    }
  });
});

/**
 * Wave 5 correction round six, High 4 — the write site the round-four fix
 * missed, at the one method the shipped claim covers BY NAME.
 *
 * `PHASE_14…md` says "every facade write that stores caller text goes through
 * `assertNoCredentialShape`". `recordVerifiedBackup` did not: its `note` went
 * through `missionText` and no further. `hq_reliability_backups` is append-only
 * — DELETE and UPDATE are both refused by the engine — and this route applies
 * the strict scan to its whole response, so one accepted credential made
 * `GET /api/hq/control/reliability` answer 500 forever. Executed against the
 * previous head with a real verified backup file: 200, accepted, 500, and still
 * 500 after a restart.
 */
describe('a backup note that the read boundary would refuse is refused at the WRITE', () => {
  const poisoning = [
    'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 before Friday',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ];

  it('refuses every credential shape, records nothing, and leaves the route answering 200', async () => {
    const h = harness();
    try {
      expect(h.call({ path: CONTROL_ROUTES.reliability }).status).toBe(200);
      const backupPath = path.join(h.fixture.dir, 'verified.sqlite');
      await h.fixture.db.backup(backupPath);
      for (const note of poisoning) {
        const refused = h.fixture.ops.recordVerifiedBackup({
          backupPath,
          requestedBy: 'founder',
          note,
        });
        expect(refused.ok, note).toBe(false);
        expect(!refused.ok && refused.error.code, note).toBe('invalid_input');
        expect(!refused.ok && refused.error.message, note).toContain('credential');
        // Nothing was written — the register is append-only, so a row here
        // could never be taken back.
        expect(h.fixture.ops.listVerifiedBackupsBounded().total, note).toBe(0);
        // And the Founder route still answers.
        expect(h.call({ path: CONTROL_ROUTES.reliability }).status, note).toBe(200);
      }
      // An ordinary note is still accepted, so the scan did not become a ban on
      // saying anything about a backup.
      const accepted = h.fixture.ops.recordVerifiedBackup({
        backupPath,
        requestedBy: 'founder',
        note: 'nightly copy, verified before the release',
      });
      expect(accepted.ok).toBe(true);
      expect(h.call({ path: CONTROL_ROUTES.reliability }).status).toBe(200);
    } finally {
      h.fixture.cleanup();
    }
  });
});
