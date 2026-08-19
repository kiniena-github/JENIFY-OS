import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE, requireCtx } from '../app.js';
import { login, logout } from '../services/auth.js';
import { getTenant } from '../services/provisioning.js';
import { getBundle, listLanguages } from '../services/translations.js';
import { recoverWithCode } from '../services/recovery.js';
import { eq } from 'drizzle-orm';
import { tenants, users } from '../db/schema.js';
import { nowIso } from '../util.js';

export function registerAuthRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Public, unauthenticated: tenant identity for the login screen. The login
   * page is generated from tenant branding — never hard-coded per factory.
   * Only presentation fields are exposed.
   */
  app.get('/api/login-info', async () => {
    const tenant = db.select().from(tenants).where(eq(tenants.active, true)).get();
    if (!tenant) return { name: 'JENIFY OS', logoPath: null, brandColor: null };
    return { name: tenant.name, logoPath: tenant.logoPath, brandColor: tenant.brandColor };
  });

  /**
   * Public, unauthenticated: emergency recovery with a one-time offline code.
   * Never reveals the old password; consumes the code; audited permanently.
   */
  app.post<{ Body: { username: string; code: string; newPassword: string } }>(
    '/api/auth/recover',
    async (req) => {
      recoverWithCode(db, req.body);
      return { ok: true };
    },
  );
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

  /** Self-service preferences: display language and theme. */
  app.patch<{ Body: { language?: string; theme?: 'light' | 'dark' | 'system' } }>(
    '/api/auth/me',
    async (req) => {
      const ctx = requireCtx(db, req);
      const patch: Partial<{ language: string; theme: string }> = {};
      if (req.body.language) patch.language = req.body.language;
      if (req.body.theme && ['light', 'dark', 'system'].includes(req.body.theme)) {
        patch.theme = req.body.theme;
      }
      if (Object.keys(patch).length) {
        db.update(users).set(patch).where(eq(users.id, ctx.user!.id)).run();
      }
      return { ok: true, at: nowIso() };
    },
  );

  app.get<{ Params: { lang: string } }>('/api/i18n/:lang', async (req) => {
    const ctx = requireCtx(db, req);
    return getBundle(ctx, req.params.lang);
  });
}
