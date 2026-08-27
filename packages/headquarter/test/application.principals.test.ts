/**
 * HQ lane F — the human-principal authorization seam (correction after the
 * PR #142 review of issue #139).
 *
 * The seam exists to hold two things apart that the first cut of this lane
 * had collapsed:
 *
 * - **Human identity is not "whatever is not a worker".** Authorizing by
 *   elimination denied workers but admitted every unknown string. Authority is
 *   now positive and deny-by-default on both sides.
 * - **Originating, approving and executing are three different rights.** A
 *   human may open work and may decide approvals; neither ever becomes a
 *   capability to execute. And the canonical rule that a requester cannot
 *   approve its own action is untouched, so holding both rights still does not
 *   let one person round-trip a gated action alone.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';

describe('lane F — a human principal can originate work', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('lets the Founder open work for a capability they are granted', () => {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'JENIFY-OS' },
        requestedBy: 'founder',
        project: 'jenify-os',
        title: 'Founder-raised check',
      }),
    );
    expect(created.task.status).toBe('queued');
    expect(created.task.createdBy).toBe('founder');
  });

  it('lets the Founder promote a group-room mission they are granted', () => {
    const proposal = expectOk(
      fx.ops.proposeMission({
        threadId: 'war-room-117',
        capabilityId: CAPS.readStatus,
        payload: { repo: 'JENIFY-OS' },
        proposedBy: 'codex',
      }),
    );
    const created = expectOk(
      fx.ops.promoteProposal({ proposalId: proposal.id, promotedBy: 'founder' }),
    );
    expect(created.task.createdBy).toBe('founder');
    expect(fx.ops.getProposal(proposal.id)!.status).toBe('promoted');
  });

  it('holds a human to their grant, exactly like a worker', () => {
    // 'analyst' is granted repo.read_status only.
    expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'analyst' }),
    );
    const denied = fx.ops.createTask({
      capabilityId: CAPS.openPr,
      payload: { branch: 'x' },
      idempotencyKey: 'analyst-pr',
      requestedBy: 'analyst',
    });
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.error.message).toContain('least privilege');
  });

  it('refuses a human with no origination grant at all', () => {
    // 'coo' has approval authority but an empty originate list.
    const res = fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: {},
      requestedBy: 'coo',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toContain('least privilege');
  });

  it('refuses an inactive human principal', () => {
    const res = fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: {},
      requestedBy: 'former-cto',
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('unknown_principal');
    expect(!res.ok && res.error.details?.reason).toBe('principal_inactive');
  });

  it('refuses an unknown human outright', () => {
    for (const id of ['ghost', 'Founder', 'founder ', 'the-founder', '']) {
      const res = fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: {},
        requestedBy: id,
      });
      expect(res.ok).toBe(false);
    }
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });
});

describe('lane F — originating never becomes executing', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('refuses to let a human principal claim work', () => {
    expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'founder' }),
    );
    for (const human of ['founder', 'coo', 'analyst']) {
      const res = fx.ops.claimNext(human, CAPS.readStatus);
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error.code).toBe('humans_do_not_execute');
    }
    // The task is untouched and a real worker can still take it.
    expect(expectOk(fx.ops.claimNext('claude', CAPS.readStatus)).claimedBy).toBe('claude');
  });

  it('refuses to let a human principal start work', () => {
    expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'founder' }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    const res = fx.ops.startTask(claimed.id, 'founder', claimed.fence);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('humans_do_not_execute');
    expect(fx.ops.queue.get(claimed.id)!.status).toBe('assigned');
  });

  it('gives a Founder-originated high-risk task no shortcut past approval', () => {
    // The Founder is not granted infra.drop_index, so they cannot even open
    // it; a granted worker opens it and it is gated exactly as always.
    const blocked = fx.ops.createTask({
      capabilityId: CAPS.dropIndex,
      payload: { index: 'x' },
      idempotencyKey: 'founder-drop',
      requestedBy: 'founder',
    });
    expect(blocked.ok).toBe(false);

    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'x' },
        idempotencyKey: 'worker-drop',
        requestedBy: 'claude',
      }),
    );
    expect(created.task.status).toBe('needs_approval');
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
    // Still requires the exact-action digest, from the Founder, as ever.
    expect(
      fx.ops.approveTask({
        taskId: created.task.id,
        founderId: 'founder',
        expectedActionDigest: 'wrong',
      }).ok,
    ).toBe(false);
    expectOk(
      fx.ops.approveTask({
        taskId: created.task.id,
        founderId: 'founder',
        expectedActionDigest: card.actionDigest,
      }),
    );
  });
});

describe('lane F — approval authority is positive and separate', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  function gated(key: string) {
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'x' },
        idempotencyKey: key,
        requestedBy: 'claude',
      }),
    );
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;
    return { taskId: created.task.id, digest: card.actionDigest };
  }

  it('refuses an unknown human — the hole the review caught', () => {
    const { taskId, digest } = gated('auth-1');
    // None of these are registered principals. Before the correction, every
    // one of them would have been accepted purely for not being a worker.
    for (const impostor of ['founder-bot', 'the-founder', 'Founder', 'admin', 'kiniena']) {
      const res = fx.ops.approveTask({
        taskId,
        founderId: impostor,
        expectedActionDigest: digest,
      });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error.code).toBe('not_permitted');
      expect(!res.ok && res.error.details?.reason).toBe('principal_unknown');
    }
    expect(fx.ops.queue.get(taskId)!.status).toBe('needs_approval');
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals WHERE task_id = ?`).get(taskId) as {
        n: number;
      }).n,
    ).toBe(0);
  });

  it('refuses a registered human without approval authority', () => {
    const { taskId, digest } = gated('auth-2');
    const res = fx.ops.approveTask({
      taskId,
      founderId: 'analyst',
      expectedActionDigest: digest,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.details?.reason).toBe('principal_no_approval_authority');
  });

  it('refuses a deactivated approver', () => {
    const { taskId, digest } = gated('auth-3');
    const res = fx.ops.approveTask({
      taskId,
      founderId: 'former-cto',
      expectedActionDigest: digest,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.details?.reason).toBe('principal_inactive');
  });

  it('still refuses every registered worker, whatever else changed', () => {
    const { taskId, digest } = gated('auth-4');
    for (const worker of ['claude', 'codex', 'jules', 'retired-bot']) {
      const res = fx.ops.approveTask({ taskId, founderId: worker, expectedActionDigest: digest });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error.message).toMatch(/never carries approval authority/i);
    }
  });

  it('refuses a worker even if someone also registers that id as a human', () => {
    // Worker identity wins the check outright, so an id cannot be laundered
    // into approval authority by also listing it as a principal.
    fx.principals.register({
      id: 'claude',
      displayName: 'Definitely A Human',
      originateCapabilities: [CAPS.dropIndex],
      approvalAuthority: true,
      active: true,
    });
    const { taskId, digest } = gated('auth-5');
    const res = fx.ops.approveTask({ taskId, founderId: 'claude', expectedActionDigest: digest });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.message).toMatch(/never carries approval authority/i);
  });

  it('will not let a human approve the very task they opened', () => {
    // The Founder holds BOTH rights — originate archive.index_document, and
    // approval authority. They still cannot round-trip a gated action alone:
    // the canonical requester-cannot-approve rule is untouched by the seam.
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'strategy.pdf' },
        idempotencyKey: 'self-approve-1',
        requestedBy: 'founder',
      }),
    );
    expect(created.task.status).toBe('needs_approval');
    const card = founderConsole(fx.ops).approvals.find((a) => a.taskId === created.task.id)!;

    const self = fx.ops.approveTask({
      taskId: created.task.id,
      founderId: 'founder',
      expectedActionDigest: card.actionDigest,
    });
    expect(self.ok).toBe(false);
    expect(!self.ok && self.error.message).toMatch(/may not approve its own action/i);
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('needs_approval');

    // A second authorized human can decide it. This is the documented answer
    // to "the Founder raised it themselves", not a Founder exception.
    expectOk(
      fx.ops.approveTask({
        taskId: created.task.id,
        founderId: 'coo',
        expectedActionDigest: card.actionDigest,
      }),
    );
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('queued');
  });

  it('gates the kill switch on the same positive authority', () => {
    expect(fx.ops.engageKillSwitch('*', 'founder-bot', 'let me in').ok).toBe(false);
    expect(fx.ops.engageKillSwitch('*', 'analyst', 'no authority').ok).toBe(false);
    expect(fx.ops.engageKillSwitch('*', 'former-cto', 'inactive').ok).toBe(false);
    expect(fx.ops.killSwitchScopes()).toEqual([]);

    expectOk(fx.ops.engageKillSwitch('*', 'founder', 'incident'));
    expect(fx.ops.releaseKillSwitch('*', 'founder-bot').ok).toBe(false);
    expectOk(fx.ops.releaseKillSwitch('*', 'coo'));
  });
});

describe('lane F — review and reconciliation need a known actor too', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = setupFixture();
  });

  it('refuses an unknown reviewer on a pending side effect', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'rev-1',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', running.fence, { pr: 1 }));

    const res = fx.ops.reviewTask(claimed.id, 'some-reviewer', 'pass');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('unknown_principal');
    expect(fx.ops.queue.get(claimed.id)!.reviewState).toBe('pending');

    // A registered human with no approval authority is still a valid
    // reviewer — reviewing a result is not deciding a Founder approval.
    expect(expectOk(fx.ops.reviewTask(claimed.id, 'analyst', 'pass')).status).toBe('completed');
  });

  it('refuses an unknown reconciler on an outcome_unknown task', () => {
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { branch: 'x' },
        idempotencyKey: 'rec-1',
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr, -1_000));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    fx.ops.queue.sweepExpiredLeases();

    const res = fx.ops.reconcileTask(claimed.id, 'confirmed_done', 'whoever', 'looks fine');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('unknown_principal');
    expect(fx.ops.queue.get(claimed.id)!.status).toBe('outcome_unknown');

    expectOk(fx.ops.reconcileTask(claimed.id, 'confirmed_done', 'founder', 'PR verified'));
  });
});
