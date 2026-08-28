import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
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
import { registerSyncRoutes } from './routes/sync.js';
import { registerImportRoutes } from './routes/importing.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { registerOperationsRoutes } from './routes/operations.js';
import {
  registerHeadquarterRoutes,
  type HeadquarterControlPlane,
} from './routes/headquarter.js';

export const SESSION_COOKIE = 'fos_session';

/**
 * Hosts on which a plaintext session cookie is still legitimate: a developer's
 * own machine, and the private networks JENIFY OS is designed to run on. A
 * factory server at `http://192.168.1.10:3001` is the normal local-first
 * deployment, not a misconfiguration.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  if (!host.includes('.')) return true; // a bare LAN hostname, e.g. 'mesob-server'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Session-cookie attributes, derived from the request rather than configured.
 *
 * `SameSite=Lax` keeps the cookie off cross-site POSTs — the first of the two
 * CSRF gates; the HQ control API's origin allow-list is the second.
 *
 * `Secure` is the interesting one, and the rule is deliberately inverted from
 * the obvious version. Setting it from `req.protocol === 'https'` alone LOOKS
 * right and is wrong in exactly the deployment that matters: behind a
 * TLS-terminating proxy the request reaches Fastify as plain HTTP, so a hosted
 * site would silently get a non-Secure session cookie. Fastify only believes
 * `x-forwarded-proto` when `trustProxy` is on, and turning that on globally
 * would make `req.ip` spoofable — which is what the login rate limiter is
 * keyed on. Trading a real brute-force defence for a cookie flag is a bad
 * trade, so the flag is derived a different way.
 *
 * The cookie is therefore Secure by DEFAULT, and plaintext only where
 * plaintext is genuinely legitimate: a loopback or private-network host. A
 * public hostname served over plain HTTP gets a Secure cookie the browser then
 * refuses to send — sign-in visibly fails instead of quietly running an
 * authenticated session in the clear. `x-forwarded-proto: https` is also
 * honoured, but only ever to ADD Secure, so a forged header can achieve
 * nothing.
 */
export function sessionCookieOptions(req: FastifyRequest): {
  path: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
} {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase();
  const https = req.protocol === 'https' || forwarded === 'https';
  const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '');
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: https || !isPrivateHost(hostname),
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}

export interface AppOptions {
  db: Db;
  /**
   * Headquarter browser control, OFF unless a host passes it explicitly.
   *
   * An ordinary tenant deployment (the Mesob pilot included) omits it and
   * gets no HQ routes at all — the control plane is a deliberate act, never
   * something a server acquires by upgrading.
   */
  headquarter?: HeadquarterControlPlane;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  // Low-bandwidth standard: compress JSON responses over 1 kB (translation
  // bundles, reports, movement lists shrink ~5-8x on weak mobile data).
  app.register(compress, { global: true, threshold: 1024 });

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
  registerSyncRoutes(app, opts.db);
  registerImportRoutes(app, opts.db);
  registerAssistantRoutes(app, opts.db);
  registerOnboardingRoutes(app, opts.db);
  registerOperationsRoutes(app, opts.db);
  if (opts.headquarter) registerHeadquarterRoutes(app, opts.db, opts.headquarter);

  return app;
}

/** Build an authenticated service context or fail with 401. */
export function requireCtx(db: Db, req: FastifyRequest): Ctx {
  if (!req.sessionUser) throw new AppError(401, 'unauthenticated', 'Sign in required');
  return { db, tenantId: req.sessionUser.tenantId, user: req.sessionUser };
}
