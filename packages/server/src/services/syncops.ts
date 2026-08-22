import { and, eq } from 'drizzle-orm';
import { syncOps } from '../db/schema.js';
import { newId, nowIso, AppError } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { requirePermission } from './permissions.js';
import { createReceipt, postReceipt, type ReceiptInput } from './receiving.js';
import { markDelivered } from './deliveries.js';

/**
 * Offline sync — O2, Receiving first.
 *
 * A device captures an operation offline with a client-generated idempotency
 * key (opKey, a UUIDv7). On reconnect it replays the op here. The server is the
 * FINAL AUTHORITY:
 *   - each opKey is applied AT MOST ONCE (unique index); a duplicate replay
 *     returns the ORIGINAL recorded outcome instead of double-posting;
 *   - the op is re-validated by the normal domain service on the server, so a
 *     rule that changed while the device was offline is enforced now;
 *   - a business rejection is RECORDED and surfaced (status 'rejected'), never
 *     silently merged or last-write-wins;
 *   - the domain write and the sync_ops record commit together, so a crash
 *     cannot leave a posted receipt without its applied-marker (which would
 *     double-post on the next replay).
 *
 * Honest client states map to results: applied → SYNCED, rejected → FAILED —
 * RETRY / CONFLICT — REVIEW REQUIRED (per message), duplicate → already SYNCED.
 */

export type SyncOpStatus = 'applied' | 'rejected';

export interface SyncOpInput {
  opKey: string;
  opType: string; // 'receiving.post' for O2 #1
  payload: unknown;
  deviceId?: string;
  clientCreatedAt?: string;
}

export interface SyncOpResult {
  opKey: string;
  status: SyncOpStatus;
  duplicate: boolean; // true when this replay hit an already-applied op
  resultRef?: string | null;
  message?: string | null;
}

/** Dispatch table: opType → the domain handler that applies it on the server. */
function applyReceivingPost(ctx: Ctx, payload: unknown): { resultRef: string } {
  const input = payload as ReceiptInput;
  // re-run through the normal permission + validation + posting path
  requirePermission(ctx, 'inventory', 'create');
  // server authority: the receipt is attributed to the SYNCING user, never a
  // client-supplied receivedByUserId (createReceipt defaults it to the actor).
  const { receivedByUserId: _ignore, ...safe } = input;
  const { id } = createReceipt(ctx, safe as ReceiptInput);
  requirePermission(ctx, 'inventory', 'approve');
  postReceipt(ctx, id);
  return { resultRef: id };
}

/** O2 workflow #2 — offline delivery confirmation (proof of delivery). */
function applyDeliveryConfirm(ctx: Ctx, payload: unknown): { resultRef: string } {
  const input = payload as {
    deliveryId: string;
    actualDate: string;
    receivedBy: string;
    proofAttachmentId?: string;
    notes?: string;
  };
  requirePermission(ctx, 'delivery', 'edit');
  markDelivered(ctx, input.deliveryId, {
    actualDate: input.actualDate,
    receivedBy: input.receivedBy,
    proofAttachmentId: input.proofAttachmentId,
    notes: input.notes,
  });
  return { resultRef: input.deliveryId };
}

const HANDLERS: Record<string, (ctx: Ctx, payload: unknown) => { resultRef: string }> = {
  'receiving.post': applyReceivingPost,
  'delivery.confirm': applyDeliveryConfirm,
};

function recordedResult(ctx: Ctx, opKey: string): SyncOpResult | null {
  const row = ctx.db
    .select()
    .from(syncOps)
    .where(and(eq(syncOps.tenantId, ctx.tenantId), eq(syncOps.opKey, opKey)))
    .get();
  if (!row) return null;
  return {
    opKey,
    status: row.status as SyncOpStatus,
    duplicate: true,
    resultRef: row.resultRef,
    message: row.message,
  };
}

/**
 * Apply a single queued op idempotently. Safe to call repeatedly with the same
 * opKey: after the first application it returns the recorded outcome.
 */
export function applySyncOp(ctx: Ctx, op: SyncOpInput): SyncOpResult {
  if (!op.opKey || !op.opType) {
    throw new AppError(400, 'sync_op_invalid', 'opKey and opType are required');
  }
  // fast path: already recorded → return the original outcome, no re-apply
  const existing = recordedResult(ctx, op.opKey);
  if (existing) return existing;

  const handler = HANDLERS[op.opType];
  if (!handler) throw new AppError(400, 'sync_op_type', `Unknown sync op type '${op.opType}'`);

  const now = nowIso();
  try {
    // domain write + applied-marker commit atomically
    return inTx(ctx, (tx) => {
      const { resultRef } = handler(tx, op.payload);
      tx.db
        .insert(syncOps)
        .values({
          id: newId(),
          tenantId: tx.tenantId,
          opKey: op.opKey,
          opType: op.opType,
          payload: op.payload as object,
          status: 'applied',
          resultRef,
          deviceId: op.deviceId ?? null,
          appliedBy: actorId(tx),
          clientCreatedAt: op.clientCreatedAt ?? null,
          serverAppliedAt: now,
        })
        .run();
      return { opKey: op.opKey, status: 'applied' as const, duplicate: false, resultRef };
    });
  } catch (err) {
    // A concurrent replay may have inserted the same opKey first — the unique
    // index throws; return the now-recorded outcome (still at-most-once).
    const raced = recordedResult(ctx, op.opKey);
    if (raced) return raced;

    // A genuine business rejection: the domain transaction rolled back, so
    // nothing was posted. Record the rejection (a SEPARATE write) and surface
    // it — never retried silently, never merged.
    const message = err instanceof AppError ? err.message : 'Operation could not be applied';
    try {
      ctx.db
        .insert(syncOps)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          opKey: op.opKey,
          opType: op.opType,
          payload: op.payload as object,
          status: 'rejected',
          resultRef: null,
          message,
          deviceId: op.deviceId ?? null,
          appliedBy: actorId(ctx),
          clientCreatedAt: op.clientCreatedAt ?? null,
          serverAppliedAt: now,
        })
        .run();
    } catch {
      // unique-index race on the rejection insert → fall through to read
      const afterRace = recordedResult(ctx, op.opKey);
      if (afterRace) return afterRace;
    }
    return { opKey: op.opKey, status: 'rejected', duplicate: false, resultRef: null, message };
  }
}

/** Replay a batch of queued ops in order; each result is independent. */
export function replaySyncOps(ctx: Ctx, ops: SyncOpInput[]): SyncOpResult[] {
  return ops.map((op) => applySyncOp(ctx, op));
}

/** The recorded outcome for an opKey, so a device can reconcile its queue. */
export function syncOpStatus(ctx: Ctx, opKey: string): SyncOpResult | null {
  return recordedResult(ctx, opKey);
}
