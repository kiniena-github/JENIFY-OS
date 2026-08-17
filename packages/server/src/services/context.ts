import type { Db } from '../db/index.js';
import type { SessionUser } from '@factoryos/shared';

/** Everything a service call needs: connection + authenticated actor. */
export interface Ctx {
  db: Db;
  tenantId: string;
  user: SessionUser | null; // null only for system/seed operations
}

export function actorId(ctx: Ctx): string | null {
  return ctx.user?.id ?? null;
}

/**
 * Run a service composition atomically. better-sqlite3 transactions are
 * synchronous; every write inside `fn` commits or rolls back together.
 */
export function inTx<T>(ctx: Ctx, fn: (txCtx: Ctx) => T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (ctx.db as any).transaction((tx: any) => fn({ ...ctx, db: tx as Db }));
}
