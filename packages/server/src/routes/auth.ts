import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE, requireCtx } from '../app.js';
import { login, logout } from '../services/auth.js';
import { getTenant } from '../services/provisioning.js';
import { getBundle, listLanguages } from '../services/translations.js';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { nowIso } from '../util.js';

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  app.post<{
    Body: { username: string; password: string; remember?: boolean; tenantCode?: string };
  }>('/api/auth/login', async (req, reply) => {
    const result = login(db, {
      username: req.body.username,
      password: req.body.password,
      remember: req.body.remember,
      tenantCode: req.body.tenantCode,
      userAgent: req.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, result.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      expires: new Date(result.expiresAt),
    });
    const tenant = getTenant(db, result.user.tenantId);
    return { user: result.user, tenant };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) logout(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const ctx = requireCtx(db, req);
    const tenant = getTenant(db, ctx.tenantId);
    const languages = listLanguages(ctx);
    return { user: ctx.user, tenant, languages };
  });

  /** Self-service preferences (currently: display language). */
  app.patch<{ Body: { language?: string } }>('/api/auth/me', async (req) => {
    const ctx = requireCtx(db, req);
    if (req.body.language) {
      db.update(users)
        .set({ language: req.body.language })
        .where(eq(users.id, ctx.user!.id))
        .run();
    }
    return { ok: true, at: nowIso() };
  });

  app.get<{ Params: { lang: string } }>('/api/i18n/:lang', async (req) => {
    const ctx = requireCtx(db, req);
    return getBundle(ctx, req.params.lang);
  });
}
