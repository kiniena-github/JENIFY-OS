import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionUser } from '@factoryos/shared';
import type { Db } from './db/index.js';
import { defaultDbPath } from './db/index.js';
import { AppError } from './util.js';
import { resolveSession } from './services/auth.js';
import type { Ctx } from './services/context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMasterdataRoutes } from './routes/masterdata.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerProductionRoutes } from './routes/production.js';
import { registerCommercialRoutes } from './routes/commercial.js';
import { registerInsightRoutes } from './routes/insights.js';

export const SESSION_COOKIE = 'fos_session';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}

export interface AppOptions {
  db: Db;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);

  // Tenant branding assets (logo, flags, stamps) live next to the local DB.
  const brandingDir = path.join(path.dirname(defaultDbPath()), 'branding');
  fs.mkdirSync(brandingDir, { recursive: true });
  app.register(fastifyStatic, { root: brandingDir, prefix: '/branding/' });

  app.decorateRequest('sessionUser', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    req.sessionUser = token ? resolveSession(opts.db, token) : null;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    // Fastify validation errors etc.
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      console.error(err);
      reply.status(500).send({ error: 'internal', message: 'Internal server error' });
    } else {
      reply.status(status).send({ error: 'request_error', message: e.message });
    }
  });

  app.get('/api/health', async () => ({ ok: true, service: 'factoryos' }));

  registerAuthRoutes(app, opts.db);
  registerAdminRoutes(app, opts.db);
  registerMasterdataRoutes(app, opts.db);
  registerInventoryRoutes(app, opts.db);
  registerProductionRoutes(app, opts.db);
  registerCommercialRoutes(app, opts.db);
  registerInsightRoutes(app, opts.db);

  return app;
}

/** Build an authenticated service context or fail with 401. */
export function requireCtx(db: Db, req: FastifyRequest): Ctx {
  if (!req.sessionUser) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return { db, tenantId: req.sessionUser.tenantId, user: req.sessionUser };
}
