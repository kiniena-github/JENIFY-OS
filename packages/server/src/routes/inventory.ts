import type { FastifyInstance } from 'fastify';
import type { ItemKind } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission } from '../services/permissions.js';
import {
  createReceipt,
  updateReceiptDraft,
  postReceipt,
  reverseReceipt,
  cancelReceiptDraft,
  listReceipts,
  getReceipt,
  type ReceiptInput,
} from '../services/receiving.js';
import {
  createTransfer,
  postTransfer,
  reverseTransfer,
  cancelTransferDraft,
  listTransfers,
  type TransferInput,
} from '../services/transfers.js';
import { stockOverview } from '../services/stockview.js';
import { listMovements } from '../services/inventory.js';

export function registerInventoryRoutes(app: FastifyInstance, db: Db): void {
  // ------------------------------ receiving --------------------------------
  app.get('/api/receipts', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listReceipts(ctx);
  });

  app.get<{ Params: { id: string } }>('/api/receipts/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return getReceipt(ctx, req.params.id);
  });

  app.post<{ Body: ReceiptInput & { andPost?: boolean } }>('/api/receipts', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'create');
    const { andPost, ...input } = req.body;
    const result = createReceipt(ctx, input);
    if (andPost) {
      requirePermission(ctx, 'inventory', 'approve');
      postReceipt(ctx, result.id);
    }
    return result;
  });

  app.patch<{ Params: { id: string }; Body: ReceiptInput }>('/api/receipts/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'edit');
    updateReceiptDraft(ctx, req.params.id, req.body);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/receipts/:id/post', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'approve');
    postReceipt(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/receipts/:id/reverse',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'inventory', 'approve');
      reverseReceipt(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/receipts/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'inventory', 'edit');
      cancelReceiptDraft(ctx, req.params.id, req.body?.reason);
      return { ok: true };
    },
  );

  // ------------------------------ transfers --------------------------------
  app.get('/api/transfers', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listTransfers(ctx);
  });

  app.post<{ Body: TransferInput & { andPost?: boolean } }>('/api/transfers', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'create');
    const { andPost, ...input } = req.body;
    const result = createTransfer(ctx, input);
    if (andPost) {
      requirePermission(ctx, 'inventory', 'approve');
      postTransfer(ctx, result.id);
    }
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/transfers/:id/post', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'approve');
    postTransfer(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/transfers/:id/reverse',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'inventory', 'approve');
      reverseTransfer(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/transfers/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'inventory', 'edit');
      cancelTransferDraft(ctx, req.params.id, req.body?.reason);
      return { ok: true };
    },
  );

  // ------------------------------ stock view -------------------------------
  app.get<{ Querystring: { kind?: ItemKind; itemId?: string } }>('/api/stock', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return stockOverview(ctx, req.query);
  });

  app.get<{
    Querystring: { itemId?: string; lotId?: string; warehouseId?: string; documentId?: string };
  }>('/api/movements', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listMovements(ctx, req.query);
  });
}
