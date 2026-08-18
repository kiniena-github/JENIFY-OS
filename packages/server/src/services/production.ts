import { and, asc, eq } from 'drizzle-orm';
import type { StageAttributeDef, StageInputSource, StageOutputForm, StageOutputPolicy } from '@factoryos/shared';
import { productionStages } from '../db/schema.js';
import { newId, notFound } from '../util.js';
import type { Ctx } from './context.js';

// Stage configuration (provisioning). Batch execution lives in batches.ts.

export function createStage(
  ctx: Ctx,
  input: {
    code: string;
    nameKey: string;
    sequence: number;
    inputSource: StageInputSource;
    outputForm: StageOutputForm;
    outputPolicy?: StageOutputPolicy;
    requiresQc?: boolean;
    inputItemId?: string;
    priorStageId?: string;
    outputItemIds?: string[];
    attributes?: StageAttributeDef[];
    docSeqKey: string;
  },
): string {
  const id = newId();
  ctx.db
    .insert(productionStages)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code,
      nameKey: input.nameKey,
      sequence: input.sequence,
      inputSource: input.inputSource,
      outputForm: input.outputForm,
      outputPolicy: input.outputPolicy ?? (input.outputForm === 'packaged_items' ? 'converted' : 'measured'),
      requiresQc: input.requiresQc ?? false,
      inputItemId: input.inputItemId ?? null,
      priorStageId: input.priorStageId ?? null,
      outputItemIds: (input.outputItemIds as object) ?? null,
      attributes: (input.attributes as unknown as object) ?? null,
      docSeqKey: input.docSeqKey,
    })
    .run();
  return id;
}

export function listStages(ctx: Ctx) {
  return ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.active, true)))
    .orderBy(asc(productionStages.sequence))
    .all();
}

export function getStage(ctx: Ctx, stageId: string) {
  const row = ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.id, stageId)))
    .get();
  if (!row) notFound('stage_missing', 'Production stage not found');
  return row;
}

export function getStageByCode(ctx: Ctx, code: string) {
  const row = ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.code, code)))
    .get();
  if (!row) notFound('stage_missing', `Production stage '${code}' not found`);
  return row;
}
