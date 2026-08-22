import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { AppError } from '../util.js';
import { replaySyncOps, syncOpStatus, type SyncOpInput } from '../services/syncops.js';

/**
 * Offline sync endpoints (O2). The device replays its queued ops here on
 * reconnect. Each op carries its own client idempotency key; the server applies
 * at-most-once and returns a per-op outcome the device maps to its honest sync
 * states. Permissions are enforced inside each op's domain handler.
 */
export function registerSyncRoutes(app: FastifyInstance, db: Db): void {
  // bound per-request work (F-SYNC-4): a device queue drains in capped batches,
  // so no single authenticated request can flood sync_ops with rejected rows.
  const MAX_BATCH = 200;
  app.post<{ Body: { ops: SyncOpInput[] } }>('/api/sync/replay', async (req) => {
    const ctx = requireCtx(db, req);
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (ops.length > MAX_BATCH) {
      throw new AppError(400, 'sync_batch_too_large', `A replay batch may contain at most ${MAX_BATCH} ops`);
    }
    return { results: replaySyncOps(ctx, ops) };
  });

  app.get<{ Params: { opKey: string } }>('/api/sync/op/:opKey', async (req) => {
    const ctx = requireCtx(db, req);
    return { result: syncOpStatus(ctx, req.params.opKey) };
  });
}
