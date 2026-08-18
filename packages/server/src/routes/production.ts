import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission } from '../services/permissions.js';
import { listStages } from '../services/production.js';
import {
  createBatch,
  startBatch,
  completeBatch,
  correctBatchOutput,
  cancelBatch,
  listBatches,
  getBatch,
  recordQualityTest,
  approveQualityTest,
  listQualityTests,
  availableSourceBatches,
  batchGenealogy,
  type CreateBatchInput,
  type CompleteBatchInput,
  type QualityTestInput,
} from '../services/batches.js';

export function registerProductionRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/stages', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    return listStages(ctx);
  });

  app.get<{ Querystring: { stageId?: string; status?: string } }>('/api/batches', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    return listBatches(ctx, req.query);
  });

  app.get<{ Params: { id: string } }>('/api/batches/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    const batch = getBatch(ctx, req.params.id);
    const tests = listQualityTests(ctx, batch.id);
    return { batch, tests };
  });

  app.get<{ Params: { id: string } }>('/api/batches/:id/genealogy', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    return batchGenealogy(ctx, req.params.id);
  });

  app.get<{ Querystring: { forStage: string } }>('/api/production/sources', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'view');
    return availableSourceBatches(ctx, req.query.forStage);
  });

  app.post<{ Body: CreateBatchInput & { andStart?: boolean } }>('/api/batches', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'create');
    const { andStart, ...input } = req.body;
    const result = createBatch(ctx, input);
    if (andStart) startBatch(ctx, result.id);
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/batches/:id/start', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'production', 'edit');
    startBatch(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: CompleteBatchInput }>(
    '/api/batches/:id/complete',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'production', 'edit');
      completeBatch(ctx, req.params.id, req.body);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { measuredOutputKg: number; reason: string } }>(
    '/api/batches/:id/correct-output',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'production', 'approve');
      correctBatchOutput(ctx, req.params.id, req.body.measuredOutputKg, req.body.reason);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/batches/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'production', 'edit');
      cancelBatch(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: QualityTestInput }>(
    '/api/batches/:id/qc-test',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'quality', 'create');
      const id = recordQualityTest(ctx, req.params.id, req.body);
      return { id };
    },
  );

  app.post<{ Params: { id: string } }>('/api/batches/:id/qc-approve', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'quality', 'approve');
    approveQualityTest(ctx, req.params.id);
    return { ok: true };
  });
}
