import { and, desc, eq, sql } from 'drizzle-orm';
import type { StageAttributeDef } from '@factoryos/shared';
import { productionBatches, qualityTests } from '../db/schema.js';
import { newId, nowIso, badRequest, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { nextDocNumber } from './numbering.js';
import { getItem, getWarehouse, toBaseQty } from './masterdata.js';
import {
  getAvailable,
  getLot,
  postMovement,
  createLot,
  createReservation,
  listReservationsForDocument,
  releaseReservation,
  consumeReservation,
} from './inventory.js';
import { getStage, getStageByCode } from './production.js';

/**
 * Generic process/batch production engine.
 * A stage's configuration decides how a batch behaves:
 *  - inputSource 'lot'          consume a tracked inventory lot (e.g. washing)
 *  - inputSource 'prior_batch'  consume the bulk output of an earlier batch
 *  - outputForm 'bulk'          output stays as batch balance for the next stage
 *  - outputForm 'packaged_items' output becomes finished inventory (new lot)
 *  - requiresQc                 output is gated until a passed & approved test
 */

export interface CreateBatchInput {
  stageCode: string;
  date: string;
  // lot input
  inputLotId?: string;
  inputWarehouseId?: string;
  inputQty?: number; // natural units
  inputUomId?: string;
  // prior-batch input
  inputBatchId?: string;
  inputBatchQty?: number; // natural units of bulk output (kg)
  operatorName?: string;
  supervisorName?: string;
  attributes?: Record<string, unknown>;
  notes?: string;
}

function validateAttributes(
  defs: StageAttributeDef[] | null,
  values: Record<string, unknown> | undefined,
): void {
  for (const def of defs ?? []) {
    const v = values?.[def.key];
    if (def.required && (v === undefined || v === null || v === '')) {
      badRequest('attr_required', `'${def.key}' is required for this stage`);
    }
    if (v != null && def.type === 'number' && typeof v !== 'number') {
      badRequest('attr_type', `'${def.key}' must be a number`);
    }
  }
}

export function outputBalance(batch: { outputQty: number | null; consumedOutputQty: number }): number {
  return (batch.outputQty ?? 0) - batch.consumedOutputQty;
}

export function createBatch(ctx: Ctx, input: CreateBatchInput): { id: string; docNumber: string } {
  return inTx(ctx, (tx) => {
    const stage = getStageByCode(tx, input.stageCode);
    validateAttributes(stage.attributes as StageAttributeDef[] | null, input.attributes);

    let inputQtyBase = 0;
    if (stage.inputSource === 'lot') {
      if (!input.inputLotId || !input.inputWarehouseId || !input.inputQty || !input.inputUomId) {
        badRequest('batch_input', 'Batch, warehouse, quantity and unit are required');
      }
      const lot = getLot(tx, input.inputLotId);
      if (stage.inputItemId && lot.itemId !== stage.inputItemId) {
        badRequest('batch_input_item', 'Selected batch is not valid for this stage');
      }
      getWarehouse(tx, input.inputWarehouseId);
      inputQtyBase = toBaseQty(tx, input.inputUomId, input.inputQty);
      if (inputQtyBase <= 0) badRequest('batch_qty', 'Input quantity must be positive');
      const available = getAvailable(tx, lot.itemId, input.inputWarehouseId, input.inputLotId);
      if (available < inputQtyBase) {
        badRequest(
          'insufficient_available',
          `Only ${available / 1000} available in the selected warehouse for this batch`,
        );
      }
    } else {
      if (!input.inputBatchId || !input.inputBatchQty) {
        badRequest('batch_input', 'Source batch and quantity are required');
      }
      const source = getBatch(tx, input.inputBatchId);
      const sourceStage = getStage(tx, source.stageId);
      if (stage.priorStageId && source.stageId !== stage.priorStageId) {
        badRequest('batch_wrong_stage', 'Source batch belongs to a different stage');
      }
      if (source.status !== 'completed') {
        badRequest('source_incomplete', 'Source batch must be completed first');
      }
      if (sourceStage.requiresQc && source.qcStatus !== 'passed') {
        badRequest('qc_gate', 'Source batch has not passed quality approval');
      }
      inputQtyBase = Math.round(input.inputBatchQty * 1000); // bulk outputs are kept in milli-kg
      if (inputQtyBase <= 0) badRequest('batch_qty', 'Input quantity must be positive');
      const balance = outputBalance(source);
      if (balance < inputQtyBase) {
        badRequest(
          'insufficient_batch_output',
          `Source batch has only ${balance / 1000} remaining`,
        );
      }
    }

    const docNumber = nextDocNumber(tx, stage.docSeqKey);
    const id = newId();
    tx.db
      .insert(productionBatches)
      .values({
        id,
        tenantId: tx.tenantId,
        stageId: stage.id,
        docNumber,
        date: input.date,
        status: 'draft',
        inputLotId: input.inputLotId ?? null,
        inputBatchId: input.inputBatchId ?? null,
        inputWarehouseId: input.inputWarehouseId ?? null,
        inputQty: inputQtyBase,
        operatorName: input.operatorName ?? null,
        supervisorName: input.supervisorName ?? null,
        recordedBy: actorId(tx),
        attributes: (input.attributes as object) ?? null,
        notes: input.notes ?? null,
        createdBy: actorId(tx),
        createdAt: nowIso(),
      })
      .run();
    writeAudit(tx, {
      module: 'production',
      action: 'batch_draft',
      entity: 'production_batch',
      entityId: id,
      reference: docNumber,
      summary: `${stage.code} batch ${docNumber} drafted`,
    });
    return { id, docNumber };
  });
}

/** Mark in progress; for lot-input stages this reserves the raw quantity. */
export function startBatch(ctx: Ctx, id: string): void {
  inTx(ctx, (tx) => {
    const batch = getBatch(tx, id);
    if (batch.status !== 'draft') badRequest('not_draft', 'Only draft batches can start');
    const stage = getStage(tx, batch.stageId);
    if (stage.inputSource === 'lot' && batch.inputLotId && batch.inputWarehouseId) {
      const lot = getLot(tx, batch.inputLotId);
      createReservation(tx, {
        itemId: lot.itemId,
        lotId: batch.inputLotId,
        warehouseId: batch.inputWarehouseId,
        qty: batch.inputQty,
        documentKind: 'production_batch',
        documentId: id,
      });
    }
    tx.db.update(productionBatches).set({ status: 'in_progress' }).where(eq(productionBatches.id, id)).run();
    writeAudit(tx, {
      module: 'production',
      action: 'batch_start',
      entity: 'production_batch',
      entityId: id,
      reference: batch.docNumber,
      summary: `Batch ${batch.docNumber} started`,
    });
  });
}

export interface CompleteBatchInput {
  // bulk output
  outputQty?: number; // natural units (kg)
  // packaged output
  outputItemId?: string;
  unitsProduced?: number; // whole packs
  unitsRejected?: number;
  outputWarehouseId?: string;
  attributes?: Record<string, unknown>;
  operatorName?: string;
  supervisorName?: string;
  notes?: string;
}

export function completeBatch(ctx: Ctx, id: string, input: CompleteBatchInput): void {
  inTx(ctx, (tx) => {
    const batch = getBatch(tx, id);
    if (batch.status !== 'draft' && batch.status !== 'in_progress') {
      badRequest('batch_closed', 'Batch is already completed or cancelled');
    }
    const stage = getStage(tx, batch.stageId);
    const mergedAttrs = { ...((batch.attributes as object) ?? {}), ...(input.attributes ?? {}) };
    validateAttributes(stage.attributes as StageAttributeDef[] | null, mergedAttrs as Record<string, unknown>);

    // ---- consume input ----
    if (stage.inputSource === 'lot') {
      const lot = getLot(tx, batch.inputLotId!);
      // release the start-reservation first so the consume movement can pass
      for (const r of listReservationsForDocument(tx, 'production_batch', id)) {
        if (r.status === 'active') consumeReservation(tx, r.id);
      }
      postMovement(tx, {
        itemId: lot.itemId,
        lotId: batch.inputLotId,
        warehouseId: batch.inputWarehouseId!,
        qty: -batch.inputQty,
        movementType: 'production_consume',
        documentKind: 'production_batch',
        documentId: id,
        documentNumber: batch.docNumber,
      });
    } else {
      const source = getBatch(tx, batch.inputBatchId!);
      const sourceStage = getStage(tx, source.stageId);
      if (sourceStage.requiresQc && source.qcStatus !== 'passed') {
        badRequest('qc_gate', 'Source batch has not passed quality approval');
      }
      const balance = outputBalance(source);
      if (balance < batch.inputQty) {
        badRequest('insufficient_batch_output', `Source batch has only ${balance / 1000} remaining`);
      }
      tx.db
        .update(productionBatches)
        .set({ consumedOutputQty: source.consumedOutputQty + batch.inputQty })
        .where(eq(productionBatches.id, source.id))
        .run();
    }

    // ---- record output ----
    let update: Partial<typeof productionBatches.$inferInsert>;
    if (stage.outputForm === 'bulk') {
      if (stage.outputPolicy === 'conserved') {
        // Conserved stage: output = input by definition. No automatic mass
        // loss and no invented efficiency. A real measured variance must go
        // through the explicit audited correction (correctBatchOutput).
        if (input.outputQty != null && Math.round(input.outputQty * 1000) !== batch.inputQty) {
          badRequest(
            'conserved_output',
            'This stage conserves quantity: output equals input. Record a measured variance as an audited correction after completion.',
          );
        }
        update = { outputQty: batch.inputQty, lossQty: 0 };
      } else {
        if (input.outputQty == null || input.outputQty < 0) {
          badRequest('output_required', 'Output quantity is required');
        }
        const outBase = Math.round(input.outputQty * 1000);
        if (outBase > batch.inputQty) {
          badRequest('output_exceeds_input', 'Output cannot exceed input quantity');
        }
        update = {
          outputQty: outBase,
          lossQty: batch.inputQty - outBase,
        };
      }
    } else {
      const { outputItemId, unitsProduced, unitsRejected = 0, outputWarehouseId } = input;
      if (!outputItemId || !unitsProduced || !outputWarehouseId) {
        badRequest('output_required', 'Product, produced count and warehouse are required');
      }
      const allowed = (stage.outputItemIds as string[] | null) ?? [];
      if (allowed.length > 0 && !allowed.includes(outputItemId)) {
        badRequest('output_item_invalid', 'This product is not allowed for this stage');
      }
      const item = getItem(tx, outputItemId);
      getWarehouse(tx, outputWarehouseId);
      if (!Number.isInteger(unitsProduced) || unitsProduced <= 0) {
        badRequest('units_invalid', 'Produced count must be a positive whole number');
      }
      if (!Number.isInteger(unitsRejected) || unitsRejected < 0 || unitsRejected > unitsProduced) {
        badRequest('units_invalid', 'Rejected count cannot be negative or exceed produced');
      }
      // converted stage: units cannot weigh more than the consumed input
      if (item.unitWeightMilliKg != null && unitsProduced * item.unitWeightMilliKg > batch.inputQty) {
        badRequest(
          'weight_exceeds_input',
          'Produced units weigh more than the quantity consumed from the source batch',
        );
      }
      const goodUnits = unitsProduced - unitsRejected;
      const lotId = createLot(tx, {
        itemId: outputItemId,
        lotNumber: batch.docNumber,
        sourceKind: 'production_batch',
        sourceId: id,
        receivedAt: batch.date,
        initialQty: goodUnits * 1000,
      });
      if (goodUnits > 0) {
        postMovement(tx, {
          itemId: outputItemId,
          lotId,
          warehouseId: outputWarehouseId,
          qty: goodUnits * 1000,
          movementType: 'production_output',
          documentKind: 'production_batch',
          documentId: id,
          documentNumber: batch.docNumber,
        });
      }
      const goodWeightMilliKg = item.unitWeightMilliKg != null ? goodUnits * item.unitWeightMilliKg : null;
      update = {
        outputItemId,
        unitsProduced: unitsProduced * 1000,
        unitsRejected: unitsRejected * 1000,
        outputWarehouseId,
        outputLotId: lotId,
        outputQty: goodWeightMilliKg, // packed good weight, for reports
        lossQty: null,
      };
    }

    tx.db
      .update(productionBatches)
      .set({
        ...update,
        status: 'completed',
        qcStatus: stage.requiresQc ? batch.qcStatus : 'passed',
        operatorName: input.operatorName ?? batch.operatorName,
        supervisorName: input.supervisorName ?? batch.supervisorName,
        attributes: mergedAttrs as object,
        notes: input.notes ?? batch.notes,
        completedAt: nowIso(),
      })
      .where(eq(productionBatches.id, id))
      .run();

    writeAudit(tx, {
      module: 'production',
      action: 'batch_complete',
      entity: 'production_batch',
      entityId: id,
      reference: batch.docNumber,
      summary: `Batch ${batch.docNumber} completed${
        input.operatorName ?? batch.operatorName ? ` — operator ${input.operatorName ?? batch.operatorName}` : ''
      }${
        input.supervisorName ?? batch.supervisorName
          ? `, supervised by ${input.supervisorName ?? batch.supervisorName}`
          : ''
      }`,
      after: update,
    });
  });
}

/**
 * Explicit measured override for a completed bulk batch (typically a
 * conserved stage where a real variance was later measured). Signed variance,
 * reason, actor and before/after are all preserved in the audit trail.
 */
export function correctBatchOutput(
  ctx: Ctx,
  id: string,
  measuredOutputKg: number,
  reason: string,
): void {
  if (!reason?.trim()) badRequest('reason_required', 'A correction reason is required');
  inTx(ctx, (tx) => {
    const batch = getBatch(tx, id);
    const stage = getStage(tx, batch.stageId);
    if (stage.outputForm !== 'bulk') {
      badRequest('not_bulk', 'Output corrections apply to bulk-output stages only');
    }
    if (batch.status !== 'completed') {
      badRequest('not_completed', 'Only completed batches can be corrected');
    }
    const newOutput = Math.round(measuredOutputKg * 1000);
    if (!(newOutput > 0)) badRequest('output_invalid', 'Measured output must be positive');
    if (newOutput < batch.consumedOutputQty) {
      badRequest(
        'below_consumed',
        `Measured output cannot be below the ${batch.consumedOutputQty / 1000} already consumed downstream`,
      );
    }
    const before = { outputQty: batch.outputQty, lossQty: batch.lossQty };
    const varianceMilli = newOutput - (batch.outputQty ?? 0);
    tx.db
      .update(productionBatches)
      .set({ outputQty: newOutput, lossQty: batch.inputQty - newOutput })
      .where(eq(productionBatches.id, id))
      .run();
    writeAudit(tx, {
      module: 'production',
      action: 'batch_output_correct',
      entity: 'production_batch',
      entityId: id,
      reference: batch.docNumber,
      summary: `Measured output correction on ${batch.docNumber}: ${varianceMilli > 0 ? '+' : ''}${varianceMilli / 1000} kg variance`,
      before,
      after: { outputQty: newOutput, lossQty: batch.inputQty - newOutput },
      reason,
    });
  });
}

export function cancelBatch(ctx: Ctx, id: string, reason: string): void {
  if (!reason?.trim()) badRequest('reason_required', 'A cancellation reason is required');
  inTx(ctx, (tx) => {
    const batch = getBatch(tx, id);
    if (batch.status !== 'draft' && batch.status !== 'in_progress') {
      badRequest('batch_closed', 'Only open batches can be cancelled');
    }
    for (const r of listReservationsForDocument(tx, 'production_batch', id)) {
      if (r.status === 'active') releaseReservation(tx, r.id);
    }
    tx.db
      .update(productionBatches)
      .set({ status: 'cancelled', cancelledReason: reason })
      .where(eq(productionBatches.id, id))
      .run();
    writeAudit(tx, {
      module: 'production',
      action: 'batch_cancel',
      entity: 'production_batch',
      entityId: id,
      reference: batch.docNumber,
      summary: `Batch ${batch.docNumber} cancelled`,
      reason,
    });
  });
}

// ----------------------------- Quality -------------------------------------

export interface QualityTestInput {
  targetLevel?: string;
  actualResult: string;
  status: 'passed' | 'failed' | 'retest_required';
  operatorName?: string;
  date: string;
  notes?: string;
}

/** Append a test attempt. Previous attempts are immutable history. */
export function recordQualityTest(ctx: Ctx, batchId: string, input: QualityTestInput): string {
  return inTx(ctx, (tx) => {
    const batch = getBatch(tx, batchId);
    const stage = getStage(tx, batch.stageId);
    if (!stage.requiresQc) badRequest('no_qc', 'This stage does not require quality tests');
    if (batch.status === 'cancelled') badRequest('batch_cancelled', 'Batch is cancelled');
    if (batch.qcStatus === 'passed' && batch.qcApprovedAt) {
      badRequest('qc_final', 'An approved passed result already exists for this batch');
    }
    if (!input.actualResult?.trim()) badRequest('qc_result', 'Actual test result is required');

    const prior = tx.db
      .select()
      .from(qualityTests)
      .where(eq(qualityTests.batchId, batchId))
      .orderBy(desc(qualityTests.attemptNumber))
      .limit(1)
      .get();
    const id = newId();
    tx.db
      .insert(qualityTests)
      .values({
        id,
        tenantId: tx.tenantId,
        batchId,
        attemptNumber: (prior?.attemptNumber ?? 0) + 1,
        targetLevel: input.targetLevel ?? null,
        actualResult: input.actualResult,
        status: input.status,
        operatorName: input.operatorName ?? null,
        testedBy: actorId(tx),
        date: input.date,
        notes: input.notes ?? null,
        previousTestId: prior?.id ?? null,
        createdAt: nowIso(),
      })
      .run();
    // a passed test alone does NOT release the batch — it awaits an explicit
    // approve & release by quality authority; failed/retest block immediately
    tx.db
      .update(productionBatches)
      .set({ qcStatus: input.status === 'passed' ? 'passed_pending_release' : input.status })
      .where(eq(productionBatches.id, batchId))
      .run();
    writeAudit(tx, {
      module: 'quality',
      action: 'qc_test',
      entity: 'production_batch',
      entityId: batchId,
      reference: batch.docNumber,
      summary: `Test attempt recorded for ${batch.docNumber}: ${input.status}`,
      after: { status: input.status, actualResult: input.actualResult },
    });
    return id;
  });
}

/** Approve the latest passed test; only then may the next stage consume. */
export function approveQualityTest(ctx: Ctx, batchId: string): void {
  inTx(ctx, (tx) => {
    const batch = getBatch(tx, batchId);
    const latest = tx.db
      .select()
      .from(qualityTests)
      .where(eq(qualityTests.batchId, batchId))
      .orderBy(desc(qualityTests.attemptNumber))
      .limit(1)
      .get();
    if (!latest) badRequest('no_test', 'No test has been recorded for this batch');
    if (latest.status !== 'passed') {
      badRequest('not_passed', 'Only a passed test result can be approved');
    }
    if (latest.approvedAt) badRequest('already_approved', 'This result is already approved');
    tx.db
      .update(qualityTests)
      .set({ approvedBy: actorId(tx), approvedAt: nowIso() })
      .where(eq(qualityTests.id, latest.id))
      .run();
    tx.db
      .update(productionBatches)
      .set({ qcStatus: 'passed', qcApprovedBy: actorId(tx), qcApprovedAt: nowIso() })
      .where(eq(productionBatches.id, batchId))
      .run();
    writeAudit(tx, {
      module: 'quality',
      action: 'qc_approve',
      entity: 'production_batch',
      entityId: batchId,
      reference: batch.docNumber,
      summary: `Quality result approved — ${batch.docNumber} released for the next stage`,
    });
  });
}

export function listQualityTests(ctx: Ctx, batchId: string) {
  return ctx.db
    .select()
    .from(qualityTests)
    .where(and(eq(qualityTests.tenantId, ctx.tenantId), eq(qualityTests.batchId, batchId)))
    .orderBy(desc(qualityTests.attemptNumber))
    .all();
}

// ----------------------------- Queries -------------------------------------

export function getBatch(ctx: Ctx, id: string) {
  const row = ctx.db
    .select()
    .from(productionBatches)
    .where(and(eq(productionBatches.tenantId, ctx.tenantId), eq(productionBatches.id, id)))
    .get();
  if (!row) notFound('batch_missing', 'Production batch not found');
  return row;
}

export function listBatches(ctx: Ctx, filter: { stageId?: string; status?: string; limit?: number } = {}) {
  const conds = [eq(productionBatches.tenantId, ctx.tenantId)];
  if (filter.stageId) conds.push(eq(productionBatches.stageId, filter.stageId));
  if (filter.status) conds.push(eq(productionBatches.status, filter.status));
  return ctx.db
    .select()
    .from(productionBatches)
    .where(and(...conds))
    .orderBy(desc(productionBatches.createdAt))
    .limit(Math.min(filter.limit ?? 200, 1000))
    .all();
}

/** Completed source batches with remaining bulk output for the next stage. */
export function availableSourceBatches(ctx: Ctx, forStageCode: string) {
  const stage = getStageByCode(ctx, forStageCode);
  if (!stage.priorStageId) return [];
  const rows = ctx.db
    .select()
    .from(productionBatches)
    .where(
      and(
        eq(productionBatches.tenantId, ctx.tenantId),
        eq(productionBatches.stageId, stage.priorStageId),
        eq(productionBatches.status, 'completed'),
        sql`coalesce(${productionBatches.outputQty}, 0) - ${productionBatches.consumedOutputQty} > 0`,
      ),
    )
    .orderBy(desc(productionBatches.createdAt))
    .all();
  const prior = getStage(ctx, stage.priorStageId);
  return rows.filter((b) => !prior.requiresQc || b.qcStatus === 'passed');
}

// ----------------------------- Genealogy ------------------------------------

export interface GenealogyNode {
  kind: 'lot' | 'batch';
  id: string;
  label: string;
  detail: string;
  children: GenealogyNode[];
}

/** Trace a batch backward to its origin and forward to what consumed it. */
export function batchGenealogy(ctx: Ctx, batchId: string): {
  backward: GenealogyNode[];
  forward: GenealogyNode[];
} {
  const backward: GenealogyNode[] = [];
  let current = getBatch(ctx, batchId);
  // walk upstream
  let guard = 0;
  let cursor: typeof current | null = current;
  while (cursor && guard++ < 20) {
    if (cursor.inputBatchId) {
      const src: typeof current = getBatch(ctx, cursor.inputBatchId);
      backward.push({
        kind: 'batch',
        id: src.id,
        label: src.docNumber,
        detail: `output ${(src.outputQty ?? 0) / 1000} kg`,
        children: [],
      });
      cursor = src;
    } else if (cursor.inputLotId) {
      const lot = getLot(ctx, cursor.inputLotId);
      backward.push({
        kind: 'lot',
        id: lot.id,
        label: lot.lotNumber,
        detail: `lot of ${lot.initialQty / 1000}`,
        children: [],
      });
      cursor = null;
    } else {
      cursor = null;
    }
  }
  // walk downstream: batches that consumed this one
  const consumers = ctx.db
    .select()
    .from(productionBatches)
    .where(
      and(eq(productionBatches.tenantId, ctx.tenantId), eq(productionBatches.inputBatchId, batchId)),
    )
    .all();
  const forward: GenealogyNode[] = consumers.map((c) => ({
    kind: 'batch',
    id: c.id,
    label: c.docNumber,
    detail: c.status,
    children: [],
  }));
  if (current.outputLotId) {
    const lot = getLot(ctx, current.outputLotId);
    forward.push({
      kind: 'lot',
      id: lot.id,
      label: lot.lotNumber,
      detail: 'finished lot',
      children: [],
    });
  }
  return { backward, forward };
}
