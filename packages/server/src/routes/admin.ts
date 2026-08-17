import type { FastifyInstance } from 'fastify';
import type { PermissionMatrix } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission, listRoles, saveRoleMatrix, createRole } from '../services/permissions.js';
import { listUsers, createUser, updateUser, resetPassword } from '../services/users.js';
import { listTranslationRows, upsertTranslation, listLanguages } from '../services/translations.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { listAudit } from '../services/audit.js';
import { updateTenantBranding, getTenant } from '../services/provisioning.js';
import { listSequences, defineSequence } from '../services/numbering.js';

export function registerAdminRoutes(app: FastifyInstance, db: Db): void {
  // ------------------------------- users -----------------------------------
  app.get('/api/users', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'view');
    return listUsers(ctx);
  });

  app.post<{
    Body: {
      username: string;
      displayName: string;
      password: string;
      roleId: string;
      email?: string;
      phone?: string;
      language?: string;
    };
  }>('/api/users', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'manage_users');
    const id = createUser(ctx, req.body);
    return { id };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      displayName?: string;
      email?: string;
      phone?: string;
      roleId?: string;
      language?: string;
      active?: boolean;
    };
  }>('/api/users/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'manage_users');
    updateUser(ctx, req.params.id, req.body);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/reset-password',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'users', 'manage_users');
      resetPassword(ctx, req.params.id, req.body.password);
      return { ok: true };
    },
  );

  // ------------------------------- roles -----------------------------------
  app.get('/api/roles', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'view');
    return listRoles(ctx);
  });

  app.post<{
    Body: { code: string; name: string; description?: string; matrix: PermissionMatrix };
  }>('/api/roles', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'manage_users');
    const id = createRole(ctx, req.body);
    return { id };
  });

  app.put<{ Params: { id: string }; Body: { matrix: PermissionMatrix } }>(
    '/api/roles/:id/matrix',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'users', 'manage_users');
      const version = saveRoleMatrix(ctx, req.params.id, req.body.matrix);
      return { version };
    },
  );

  // ---------------------------- translations -------------------------------
  app.get<{ Querystring: { module?: string } }>('/api/translations', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return {
      languages: listLanguages(ctx),
      rows: listTranslationRows(ctx, { module: req.query.module }),
    };
  });

  app.put<{
    Body: { key: string; language: string; text: string; status?: 'placeholder' | 'active' };
  }>('/api/translations', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    upsertTranslation(ctx, req.body.key, req.body.language, req.body.text, req.body.status);
    return { ok: true };
  });

  // ------------------------------ settings ---------------------------------
  app.get<{ Params: { domain: string } }>('/api/settings/:domain', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return getSettings(ctx, req.params.domain) ?? { version: 0, data: {} };
  });

  app.put<{ Params: { domain: string }; Body: { data: unknown } }>(
    '/api/settings/:domain',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'settings', 'edit');
      return saveSettings(ctx, req.params.domain, req.body.data);
    },
  );

  // ------------------------------ numbering --------------------------------
  app.get('/api/sequences', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return listSequences(ctx);
  });

  app.put<{ Body: { seqKey: string; prefix: string; padding?: number } }>(
    '/api/sequences',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'settings', 'edit');
      defineSequence(ctx, req.body.seqKey, req.body.prefix, req.body.padding ?? 4);
      return { ok: true };
    },
  );

  // ------------------------------- audit -----------------------------------
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      module?: string;
      action?: string;
      userId?: string;
      entity?: string;
      entityId?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/audit', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'audit', 'view');
    return listAudit(ctx, {
      ...req.query,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
  });

  // ------------------------------- tenant ----------------------------------
  app.patch<{
    Body: { name?: string; locationNote?: string; brandColor?: string };
  }>('/api/tenant', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    updateTenantBranding(ctx, req.body);
    return getTenant(db, ctx.tenantId);
  });
}
