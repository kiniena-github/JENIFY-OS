import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { SESSION_COOKIE, requireCtx, sessionCookieOptions } from '../app.js';
import { login, logout } from '../services/auth.js';
import type { SsoHqPlane } from './sso-hq.js';
import {
  noIdentityRevocation,
  propagateIdentityRevocation,
  type IdentityRevocation,
} from '../services/identity-revocation.js';
import { getTenant } from '../services/provisioning.js';
import { getBundle, listLanguages } from '../services/translations.js';
import { recoverWithCode } from '../services/recovery.js';
import {
  assertNotRateLimited,
  recordAuthFailure,
  clearAuthFailures,
} from '../services/ratelimit.js';
import { eq } from 'drizzle-orm';
import { tenants, users } from '../db/schema.js';
import { nowIso } from '../util.js';

export function registerAuthRoutes(app: FastifyInstance, db: Db, ssoHq?: SsoHqPlane): void {
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
  app.post<{ Body: { username: string; code: string; newPassword: string; tenantCode?: string } }>(
    '/api/auth/recover',
    async (req) => {
      const key = `${req.ip}|recover|${(req.body.username ?? '').trim().toLowerCase()}`;
      assertNotRateLimited(key);
      let revocation: IdentityRevocation;
      try {
        revocation = recoverWithCode(db, req.body);
      } catch (err) {
        recordAuthFailure(key);
        throw err;
      }
      clearAuthFailures(key);
      // Recovery changes the password and ends every session of the account, so
      // it ends the HQ sessions derived from them too. Awaited AFTER the
      // transaction has committed, and never able to fail the recovery itself.
      await propagateIdentityRevocation(ssoHq, revocation);
      return { ok: true };
    },
  );
  app.post<{
    Body: { username: string; password: string; remember?: boolean; tenantCode?: string };
  }>('/api/auth/login', async (req, reply) => {
    // failed-attempt throttling only — successful sign-ins reset the budget
    const rlKey = `${req.ip}|login|${(req.body.username ?? '').trim().toLowerCase()}`;
    assertNotRateLimited(rlKey);
    let result;
    try {
      result = login(db, {
        username: req.body.username,
        password: req.body.password,
        remember: req.body.remember,
        tenantCode: req.body.tenantCode,
        userAgent: req.headers['user-agent'],
      });
    } catch (err) {
      recordAuthFailure(rlKey);
      throw err;
    }
    clearAuthFailures(rlKey);
    reply.setCookie(SESSION_COOKIE, result.token, {
      ...sessionCookieOptions(req),
      expires: new Date(result.expiresAt),
    });
    const tenant = getTenant(db, result.user.tenantId);
    return { user: result.user, tenant };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    // Trap C — a separate HQ cookie does not die on its own when this one does,
    // so sign-out has to say so explicitly. Trap E — a handoff ticket minted
    // moments ago has no derived HQ session yet, so revoking what HQ derived
    // finds nothing and the unconsumed ticket would still mint a NEW HQ session
    // after this sign-out; it has to be killed where it lives. Both are now the
    // shared revocation path's job, in ONE transaction, exactly as they are for
    // a password reset, a recovery and a deactivation.
    // drizzle's better-sqlite3 transaction runs the callback synchronously and
    // commits or rolls back atomically, exactly as `recovery.ts` relies on.
    const revocation = token
      ? db.transaction((tx) => logout(tx as unknown as Db, token))
      : noIdentityRevocation('logout');
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
    // Never blocks or fails sign-out: an unreachable HQ is audited, and the HQ
    // session's own 60-minute ceiling remains the backstop.
    await propagateIdentityRevocation(ssoHq, revocation);
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
