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
