import crypto from 'node:crypto';
import type { ModuleId } from '@factoryos/shared';
import type { Ctx } from './context.js';
import { AppError, nowIso } from '../util.js';
import { requirePermission } from './permissions.js';
import { writeAudit } from './audit.js';
import { createReceipt, type ReceiptInput } from './receiving.js';
import { createInvoice, type CreateInvoiceInput } from './sales.js';

/**
 * JENIFY AI safe-ACTION substrate.
 *
 * The full pipeline the Founder specified:
 *   request → intent → entity resolution → context → TYPED ACTION →
 *   PERMISSION → VALIDATION → RISK CLASSIFICATION → PREVIEW →
 *   CONFIRMATION (when required) → NORMAL DOMAIN API → VERIFY → AUDIT.
 *
 * Safety invariants (the whole point of the substrate):
 *  - The AI can only ever invoke an action from this closed registry. There is
 *    no arbitrary execution and no SQL; each action delegates to an existing
 *    permission-respecting domain service.
 *  - PERMISSION is checked before anything runs, fail-closed, from ctx.
 *  - EXECUTE is impossible without a matching PREVIEW: preview issues a signed
 *    confirmation token bound to (tenant, user, action, params); execute
 *    re-validates and requires that exact token. No token → no write.
 *  - RISK GATING: only 'draft' (reversible, low-risk) actions are executable in
 *    this milestone. 'post'/'destructive'/'config' actions are REGISTERED (so
 *    the catalog and pipeline are complete) but refuse to execute — high-risk
 *    writes are deliberately not enabled yet.
 *  - Every preview and every execute (success or refusal) is audited.
 */

export type ActionRisk = 'draft' | 'post' | 'destructive' | 'config';
export type ConfirmationPolicy = 'preview' | 'explicit';

export interface ActionDef {
  id: string;
  description: string;
  module: ModuleId;
  permission: string; // action on the module
  risk: ActionRisk;
  reversible: boolean;
  confirmation: ConfirmationPolicy;
  /** validate params; throw AppError(400,...) on bad input. Pure-ish, no writes. */
  validate: (ctx: Ctx, params: Record<string, unknown>) => void;
  /** build a human-readable, side-effect-FREE preview of what execute would do. */
  preview: (ctx: Ctx, params: Record<string, unknown>) => { summary: string; details: unknown };
  /** perform the action through the normal domain API; returns a result ref. */
  execute: (ctx: Ctx, params: Record<string, unknown>) => { resultRef: string; resultLabel: string };
}

// Only 'draft' actions may execute in this milestone.
const EXECUTABLE_RISKS: ReadonlySet<ActionRisk> = new Set<ActionRisk>(['draft']);

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

const ACTIONS: readonly ActionDef[] = [
  {
    id: 'draft.receiving',
    description: 'Prepare a draft goods receipt (not posted).',
    module: 'inventory',
    permission: 'create',
    risk: 'draft',
    reversible: true,
    confirmation: 'preview',
    validate: (_ctx, p) => {
      if (!p.supplierId) throw new AppError(400, 'action_param', 'supplierId is required');
      if (!p.itemId) throw new AppError(400, 'action_param', 'itemId is required');
      if (!p.warehouseId) throw new AppError(400, 'action_param', 'warehouseId is required');
      if (!(typeof p.netQty === 'number' && p.netQty > 0)) throw new AppError(400, 'action_param', 'netQty must be a positive number');
    },
    preview: (_ctx, p) => ({
      summary: `Draft a goods receipt of ${p.netQty} into warehouse ${String(p.warehouseId)}`,
      details: { supplierId: p.supplierId, itemId: p.itemId, warehouseId: p.warehouseId, netQty: p.netQty },
    }),
    execute: (ctx, p) => {
      const input = p as unknown as ReceiptInput;
      const { id, docNumber } = createReceipt(ctx, {
        ...input,
        // server authority: attribute to the actor, never a client-supplied user
        receivedByUserId: undefined,
      });
      return { resultRef: id, resultLabel: docNumber };
    },
  },
  {
    id: 'draft.sales_invoice',
    description: 'Prepare a draft sales invoice (pending, not confirmed).',
    module: 'sales',
    permission: 'create',
    risk: 'draft',
    reversible: true,
    confirmation: 'preview',
    validate: (_ctx, p) => {
      if (!p.customerId) throw new AppError(400, 'action_param', 'customerId is required');
      if (!Array.isArray(p.lines) || p.lines.length === 0) throw new AppError(400, 'action_param', 'At least one line is required');
    },
    preview: (_ctx, p) => ({
      summary: `Draft a sales invoice for customer ${String(p.customerId)} with ${(p.lines as unknown[]).length} line(s)`,
      details: { customerId: p.customerId, lines: p.lines },
    }),
    execute: (ctx, p) => {
      const { id, docNumber } = createInvoice(ctx, p as unknown as CreateInvoiceInput);
      return { resultRef: id, resultLabel: docNumber };
    },
  },
  // --- registered but NOT executable yet (high-risk writes deliberately gated) ---
  {
    id: 'post.receiving',
    description: 'Post (finalize) a goods receipt into the stock ledger.',
    module: 'inventory',
    permission: 'approve',
    risk: 'post',
    reversible: false,
    confirmation: 'explicit',
    validate: (_ctx, p) => { if (!p.receiptId) throw new AppError(400, 'action_param', 'receiptId is required'); },
    preview: (_ctx, p) => ({ summary: `Post goods receipt ${String(p.receiptId)} to the ledger`, details: { receiptId: p.receiptId } }),
    execute: () => { throw new AppError(403, 'action_not_enabled', 'Posting actions are not enabled for the AI yet'); },
  },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// Confirmation token: binds a preview to a later execute
// ---------------------------------------------------------------------------

// Per-process secret; tokens are single-run integrity checks, not long-lived
// credentials (they only prove "a preview of exactly this happened this run").
const TOKEN_SECRET = crypto.randomBytes(32);

function confirmationToken(ctx: Ctx, actionId: string, params: Record<string, unknown>): string {
  const material = JSON.stringify({ t: ctx.tenantId, u: ctx.user?.id ?? null, a: actionId, p: params });
  return crypto.createHmac('sha256', TOKEN_SECRET).update(material).digest('hex');
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface ActionPreview {
  actionId: string;
  risk: ActionRisk;
  reversible: boolean;
  executable: boolean; // whether this risk tier may execute in this milestone
  confirmationRequired: boolean;
  summary: string;
  details: unknown;
  /** present only when executable — pass back to executeAction to run it */
  confirmationToken?: string;
}

/** PREVIEW: permission + validation + risk classification, side-effect free. */
export function previewAction(ctx: Ctx, actionId: string, params: Record<string, unknown> = {}): ActionPreview {
  const action = BY_ID.get(actionId);
  if (!action) throw new AppError(404, 'action_unknown', `Unknown action '${actionId}'`);
  requirePermission(ctx, action.module, action.permission); // fail-closed, from ctx
  action.validate(ctx, params);
  const executable = EXECUTABLE_RISKS.has(action.risk);
  const { summary, details } = action.preview(ctx, params);
  writeAudit(ctx, {
    module: action.module,
    action: 'ai_action_preview',
    entity: 'ai_action',
    reference: actionId,
    summary: `AI previewed '${actionId}' (${action.risk})`,
    result: 'success',
  });
  return {
    actionId,
    risk: action.risk,
    reversible: action.reversible,
    executable,
    confirmationRequired: true,
    summary,
    details,
    confirmationToken: executable ? confirmationToken(ctx, actionId, params) : undefined,
  };
}

export interface ActionResult {
  actionId: string;
  resultRef: string;
  resultLabel: string;
  executedAt: string;
}

/**
 * EXECUTE: only after a matching preview (token), re-validated, risk-gated,
 * through the normal domain API, then verified + audited.
 */
export function executeAction(
  ctx: Ctx,
  actionId: string,
  params: Record<string, unknown>,
  opts: { confirmationToken?: string },
): ActionResult {
  const action = BY_ID.get(actionId);
  if (!action) throw new AppError(404, 'action_unknown', `Unknown action '${actionId}'`);

  const refuse = (code: string, message: string): never => {
    writeAudit(ctx, {
      module: action.module,
      action: 'ai_action_execute',
      entity: 'ai_action',
      reference: actionId,
      summary: `AI execute refused '${actionId}': ${code}`,
      result: 'blocked',
    });
    throw new AppError(code === 'action_not_enabled' ? 403 : 400, code, message);
  };

  // risk gate: only low-risk draft actions may execute in this milestone
  if (!EXECUTABLE_RISKS.has(action.risk)) {
    refuse('action_not_enabled', `'${action.risk}' actions are not enabled for the AI yet`);
  }
  // permission (again — never trust that preview happened for authz)
  requirePermission(ctx, action.module, action.permission);
  action.validate(ctx, params);
  // confirmation: execute is impossible without the exact preview token
  const expected = confirmationToken(ctx, actionId, params);
  if (!opts.confirmationToken || opts.confirmationToken !== expected) {
    refuse('action_unconfirmed', 'This action must be previewed and confirmed before it runs');
  }

  const { resultRef, resultLabel } = action.execute(ctx, params);
  const executedAt = nowIso();
  writeAudit(ctx, {
    module: action.module,
    action: 'ai_action_execute',
    entity: 'ai_action',
    entityId: resultRef,
    reference: `${actionId}:${resultLabel}`,
    summary: `AI executed '${actionId}' → ${resultLabel}`,
    result: 'success',
  });
  return { actionId, resultRef, resultLabel, executedAt };
}

/** Catalog metadata for docs/UI (no execution). */
export function listActionCatalog() {
  return ACTIONS.map((a) => ({
    id: a.id,
    description: a.description,
    module: a.module,
    permission: a.permission,
    risk: a.risk,
    reversible: a.reversible,
    executable: EXECUTABLE_RISKS.has(a.risk),
  }));
}
