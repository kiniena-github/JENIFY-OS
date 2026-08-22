import { and, asc, desc, eq } from 'drizzle-orm';
import type { ApprovalPolicy, ApprovalStatus } from '@factoryos/shared';
import { policyRequiresApproval } from '@factoryos/shared';
import { approvalActions, approvalPolicies, approvalRequests, roles } from '../db/schema.js';
import { newId, nowIso, badRequest, forbidden, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';

/**
 * Shared Approvals capability — ONE engine for every module that needs sign-off.
 * Enforcement is server-side: only a user whose role matches the current step's
 * approverRoleCode may approve, and separation of duties prevents a requester
 * from approving their own request. Policies are off by default (no policy =>
 * no approval needed) and threshold-triggered. The action log is append-only.
 */

export function getApprovalPolicy(ctx: Ctx, subjectType: string): ApprovalPolicy | null {
  const row = ctx.db
    .select()
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.tenantId, ctx.tenantId), eq(approvalPolicies.subjectType, subjectType)))
    .orderBy(desc(approvalPolicies.version))
    .limit(1)
    .get();
  return row ? (row.policy as ApprovalPolicy) : null;
}

/**
 * The SPECIFIC policy version a pending request was opened under. Decisions on
 * an in-flight request must evaluate this pinned version, not the latest — a
 * policy edit mid-flight must never silently re-base an open request's approver
 * chain (config-snapshot invariant). Falls back to latest when unpinned.
 */
function getApprovalPolicyVersion(
  ctx: Ctx,
  subjectType: string,
  version: number | null,
): ApprovalPolicy | null {
  if (version == null) return getApprovalPolicy(ctx, subjectType);
  const row = ctx.db
    .select()
    .from(approvalPolicies)
    .where(
      and(
        eq(approvalPolicies.tenantId, ctx.tenantId),
        eq(approvalPolicies.subjectType, subjectType),
        eq(approvalPolicies.version, version),
      ),
    )
    .get();
  return row ? (row.policy as ApprovalPolicy) : null;
}

/** Save a new version of an approval policy (append-only, audited). */
export function saveApprovalPolicy(ctx: Ctx, subjectType: string, policy: ApprovalPolicy): number {
  requirePermission(ctx, 'settings', 'edit');
  if (policy.steps.length === 0) badRequest('approval_steps', 'A policy needs at least one approval step');
  // distinct approver roles per policy: multi-step must mean multi-PERSON, so
  // one user holding a role cannot single-handedly clear two steps (M2).
  const codes = policy.steps.map((s) => s.approverRoleCode);
  if (new Set(codes).size !== codes.length) {
    badRequest('approval_duplicate_role', 'Each approval step must use a distinct approver role');
  }
  // approver roles must exist in this tenant
  for (const step of policy.steps) {
    const role = ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.code, step.approverRoleCode)))
      .get();
    if (!role) badRequest('approver_role', `Approver role '${step.approverRoleCode}' does not exist`);
  }
  const latest = ctx.db
    .select({ version: approvalPolicies.version })
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.tenantId, ctx.tenantId), eq(approvalPolicies.subjectType, subjectType)))
    .orderBy(desc(approvalPolicies.version))
    .limit(1)
    .get();
  const version = (latest?.version ?? 0) + 1;
  ctx.db
    .insert(approvalPolicies)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      subjectType,
      version,
      policy: { ...policy, subjectType } as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'approval_policy_edit',
    entity: 'approval_policy',
    reference: subjectType,
    summary: `Approval policy for '${subjectType}' saved as version ${version}`,
    after: policy,
  });
  return version;
}

export interface ApprovalGate {
  required: boolean;
  requestId?: string;
  status: ApprovalStatus | 'not_required';
}

/**
 * Called by a domain service when a subject is created/changed. If a policy
 * requires approval for this magnitude, opens a pending request and returns
 * required=true so the caller can hold the subject in a not-yet-effective
 * state. If not, returns required=false and the caller proceeds normally.
 */
export function openApprovalIfRequired(
  ctx: Ctx,
  input: { subjectType: string; subjectId: string; magnitudeMinor?: number },
): ApprovalGate {
  const policy = getApprovalPolicy(ctx, input.subjectType);
  const magnitude = input.magnitudeMinor ?? 0;
  if (!policyRequiresApproval(policy, magnitude)) {
    return { required: false, status: 'not_required' };
  }
  const latest = ctx.db
    .select({ version: approvalPolicies.version })
    .from(approvalPolicies)
    .where(and(eq(approvalPolicies.tenantId, ctx.tenantId), eq(approvalPolicies.subjectType, input.subjectType)))
    .orderBy(desc(approvalPolicies.version))
    .limit(1)
    .get();
  const requestId = newId();
  const now = nowIso();
  inTx(ctx, (tx) => {
    tx.db
      .insert(approvalRequests)
      .values({
        id: requestId,
        tenantId: ctx.tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        magnitudeMinor: magnitude,
        status: 'pending',
        currentStep: 0,
        totalSteps: policy!.steps.length,
        policyVersion: latest?.version ?? null,
        requestedBy: actorId(ctx),
        createdAt: now,
      })
      .run();
    tx.db
      .insert(approvalActions)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        requestId,
        step: 0,
        action: 'submit',
        actorUserId: actorId(ctx),
        createdAt: now,
      })
      .run();
    writeAudit(tx, {
      module: 'settings',
      action: 'approval_requested',
      entity: 'approval_request',
      entityId: requestId,
      reference: `${input.subjectType}:${input.subjectId}`,
      summary: `Approval requested for ${input.subjectType} (${policy!.steps.length} step(s))`,
    });
  });
  return { required: true, requestId, status: 'pending' };
}

function loadRequest(ctx: Ctx, requestId: string) {
  const req = ctx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.id, requestId)))
    .get();
  if (!req) notFound('approval_missing', 'Approval request not found');
  return req;
}

/** The actor's current role code (used for step-role matching). */
function actorRoleCode(ctx: Ctx): string | null {
  if (!ctx.user) return null;
  const role = ctx.db
    .select({ code: roles.code })
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, ctx.user.roleId)))
    .get();
  return role?.code ?? null;
}

/**
 * Approve or reject the current step of a request. Server-enforced:
 *  - the actor's role must equal the current step's approverRoleCode;
 *  - separation of duties blocks the original requester from approving;
 *  - approving the last step resolves the request 'approved'; any reject
 *    resolves it 'rejected'. All actions are appended to the log.
 */
export function decideApproval(
  ctx: Ctx,
  requestId: string,
  decision: 'approve' | 'reject',
  comment?: string,
): { status: ApprovalStatus } {
  const req = loadRequest(ctx, requestId);
  if (req.status !== 'pending') badRequest('approval_closed', `Request is already ${req.status}`);
  // evaluate the PINNED policy version the request was opened under (M1)
  const policy = getApprovalPolicyVersion(ctx, req.subjectType, req.policyVersion);
  if (!policy) badRequest('approval_no_policy', 'No approval policy is configured for this subject');
  const step = policy.steps[req.currentStep];
  if (!step) badRequest('approval_step', 'No such approval step');

  const roleCode = actorRoleCode(ctx);
  if (roleCode !== step.approverRoleCode) {
    forbidden('approval_role', `This step must be approved by role '${step.approverRoleCode}'`);
  }
  if (policy.separationOfDuties && req.requestedBy && req.requestedBy === actorId(ctx)) {
    forbidden('approval_sod', 'You cannot approve your own request (separation of duties)');
  }

  return inTx(ctx, (tx) => {
    // re-assert the request is still open inside the tx (defense in depth, L1)
    const fresh = tx.db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .get();
    if (fresh?.status !== 'pending') badRequest('approval_closed', 'Request is no longer pending');
    const now = nowIso();
    let status: ApprovalStatus;
    let nextStep = req.currentStep;
    if (decision === 'reject') {
      status = 'rejected';
    } else if (req.currentStep + 1 >= req.totalSteps) {
      status = 'approved';
    } else {
      status = 'pending';
      nextStep = req.currentStep + 1;
    }
    tx.db
      .update(approvalRequests)
      .set({
        status,
        currentStep: nextStep,
        resolvedAt: status === 'pending' ? null : now,
      })
      .where(eq(approvalRequests.id, requestId))
      .run();
    tx.db
      .insert(approvalActions)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        requestId,
        step: req.currentStep,
        action: decision,
        actorUserId: actorId(ctx),
        comment: comment ?? null,
        createdAt: now,
      })
      .run();
    writeAudit(tx, {
      module: 'settings',
      action: `approval_${decision}`,
      entity: 'approval_request',
      entityId: requestId,
      reference: `${req.subjectType}:${req.subjectId}`,
      summary: `Approval step ${req.currentStep + 1}/${req.totalSteps} ${decision}d → ${status}`,
      reason: comment,
    });
    return { status };
  });
}

/** Cancel a pending request (requester or a settings admin). */
export function cancelApproval(ctx: Ctx, requestId: string, comment?: string): void {
  const req = loadRequest(ctx, requestId);
  if (req.status !== 'pending') badRequest('approval_closed', `Request is already ${req.status}`);
  const isRequester = req.requestedBy && req.requestedBy === actorId(ctx);
  if (!isRequester) requirePermission(ctx, 'settings', 'edit');
  const now = nowIso();
  inTx(ctx, (tx) => {
    tx.db.update(approvalRequests).set({ status: 'cancelled', resolvedAt: now }).where(eq(approvalRequests.id, requestId)).run();
    tx.db
      .insert(approvalActions)
      .values({ id: newId(), tenantId: ctx.tenantId, requestId, step: req.currentStep, action: 'cancel', actorUserId: actorId(ctx), comment: comment ?? null, createdAt: now })
      .run();
    writeAudit(tx, {
      module: 'settings',
      action: 'approval_cancel',
      entity: 'approval_request',
      entityId: requestId,
      reference: `${req.subjectType}:${req.subjectId}`,
      summary: `Approval request cancelled`,
      reason: comment,
    });
  });
}

/**
 * Whether a subject has been approved (for a domain service to gate posting).
 *
 * BANKED GUIDANCE (red-team F-APPR-1): when the first domain wires approvals,
 * it MUST (a) compute the subject's magnitude server-side from the persisted
 * record — never trust a client-supplied magnitude passed to
 * openApprovalIfRequired — and (b) if the amount can change after approval,
 * gate on a magnitude-bound check (approved-for-at-least-this-amount), not this
 * bare boolean, so an approval for a small amount cannot authorize a larger one.
 */
export function isApproved(ctx: Ctx, subjectType: string, subjectId: string): boolean {
  const req = ctx.db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, ctx.tenantId),
        eq(approvalRequests.subjectType, subjectType),
        eq(approvalRequests.subjectId, subjectId),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1)
    .get();
  return req?.status === 'approved';
}

/** The action history of a request (append-only), for the reviewer UI. */
export function approvalHistory(ctx: Ctx, requestId: string) {
  loadRequest(ctx, requestId);
  return ctx.db
    .select()
    .from(approvalActions)
    .where(and(eq(approvalActions.tenantId, ctx.tenantId), eq(approvalActions.requestId, requestId)))
    .orderBy(asc(approvalActions.createdAt))
    .all();
}

/** Pending requests an actor's role is the current approver for (their queue). */
export function pendingApprovalsForActor(ctx: Ctx) {
  const roleCode = actorRoleCode(ctx);
  if (!roleCode) return [];
  const open = ctx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, ctx.tenantId), eq(approvalRequests.status, 'pending')))
    .all();
  return open.filter((r) => {
    const policy = getApprovalPolicyVersion(ctx, r.subjectType, r.policyVersion);
    const step = policy?.steps[r.currentStep];
    if (!step || step.approverRoleCode !== roleCode) return false;
    // hide requests the actor raised (they can't action them under SoD)
    if (policy?.separationOfDuties && r.requestedBy === actorId(ctx)) return false;
    return true;
  });
}
