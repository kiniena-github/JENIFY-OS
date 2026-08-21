import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import type { PermissionMatrix } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { defaultDbPath } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission, listRoles, saveRoleMatrix, createRole } from '../services/permissions.js';
import { listUsers, createUser, updateUser, resetPassword } from '../services/users.js';
import { generateRecoveryCodes, countActiveRecoveryCodes } from '../services/recovery.js';
import {
  listTranslationRows,
  upsertTranslation,
  listLanguages,
  enableLanguage,
  updateLanguage,
  deleteLanguage,
} from '../services/translations.js';
import { getSettings, saveSettings, getSettingsVersion } from '../services/settings.js';
import { listAudit } from '../services/audit.js';
import { writeAudit } from '../services/audit.js';
import { updateTenantBranding, getTenant } from '../services/provisioning.js';
import { listSequences, defineSequence } from '../services/numbering.js';
import { badRequest } from '../util.js';

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

  /**
   * Issue a fresh batch of emergency recovery codes. Plaintext is returned
   * exactly once and never stored; previous unused codes are revoked.
   */
  app.post<{ Params: { id: string } }>('/api/users/:id/recovery-codes', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'manage_users');
    return { codes: generateRecoveryCodes(ctx, req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/users/:id/recovery-codes', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'users', 'manage_users');
    return { active: countActiveRecoveryCodes(ctx, req.params.id) };
  });

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

  // ------------------------------ languages --------------------------------
  app.get<{ Querystring: { includeDisabled?: string } }>('/api/languages', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return listLanguages(ctx, { includeDisabled: req.query.includeDisabled === 'true' });
  });

  app.post<{
    Body: {
      code: string;
      name: string;
      nativeName?: string;
      direction?: 'ltr' | 'rtl';
      flagEmoji?: string;
    };
  }>('/api/languages', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    const id = enableLanguage(ctx, req.body.code, req.body.name, req.body.flagEmoji, {
      nativeName: req.body.nativeName,
      direction: req.body.direction,
    });
    return { id };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      nativeName?: string;
      direction?: 'ltr' | 'rtl';
      flagEmoji?: string | null;
      enabled?: boolean;
    };
  }>('/api/languages/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    updateLanguage(ctx, req.params.id, req.body);
    return { ok: true };
  });

  /** Permanent delete — only for never-used languages; English is protected. */
  app.delete<{ Params: { id: string } }>('/api/languages/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'delete');
    deleteLanguage(ctx, req.params.id);
    return { ok: true };
  });

  // -------------------------- branding assets ------------------------------
  /**
   * Accepts a small base64 image (logo/secondary logo/stamp/signature) and
   * stores it next to the local database; served at /branding/. Changing a
   * logo never changes transaction data.
   */
  app.post<{ Body: { kind: string; dataUrl: string } }>('/api/branding-asset', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    const allowed = ['logo', 'logo2', 'stamp', 'signature'];
    if (!allowed.includes(req.body.kind)) badRequest('asset_kind', 'Unknown asset kind');
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(req.body.dataUrl ?? '');
    if (!match) badRequest('asset_format', 'Provide a PNG, JPEG or WebP image');
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) badRequest('asset_size', 'Image must be 2 MB or smaller');
    const brandingDir = path.join(path.dirname(defaultDbPath()), 'branding');
    fs.mkdirSync(brandingDir, { recursive: true });
    const fileName = `${ctx.tenantId.slice(0, 8)}-${req.body.kind}.${ext}`;
    fs.writeFileSync(path.join(brandingDir, fileName), buf);
    const urlPath = `/branding/${fileName}`;
    if (req.body.kind === 'logo') updateTenantBranding(ctx, { logoPath: urlPath });
    writeAudit(ctx, {
      module: 'settings',
      action: 'branding_asset',
      reference: req.body.kind,
      summary: `Branding asset '${req.body.kind}' updated (${Math.round(buf.length / 1024)} KB)`,
    });
    return { path: urlPath };
  });

  // ------------------------------ settings ---------------------------------
  app.get<{ Params: { domain: string } }>('/api/settings/:domain', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'view');
    return getSettings(ctx, req.params.domain) ?? { version: 0, data: {} };
  });

  /**
   * Branding as it was at a specific version — used by document reprints so
   * an old invoice keeps the presentation that applied when it was issued.
   * Presentation-only data; any signed-in user who can open a document may
   * reproduce its look.
   */
  app.get<{ Params: { version: string } }>('/api/branding-version/:version', async (req) => {
    const ctx = requireCtx(db, req);
    const v = Number(req.params.version);
    if (!Number.isInteger(v) || v < 1) return { version: 0, data: null };
    return getSettingsVersion(ctx, 'branding', v) ?? { version: 0, data: null };
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
      search?: string;
      scope?: 'operational' | 'system' | 'all';
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

  // --------------------------- about / system info -------------------------
  /** Non-sensitive deployment facts for the About panel. Never secrets. */
  app.get('/api/system-info', async (req) => {
    const ctx = requireCtx(db, req);
    const tenant = getTenant(db, ctx.tenantId);
    const dbPath = process.env.FACTORYOS_DB ?? defaultDbPath();
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = fs.statSync(dbPath).size;
    } catch {
      /* in-memory or missing */
    }
    let lastBackup: { file: string; at: string } | null = null;
    try {
      const dir = path.dirname(dbPath);
      const candidates: Array<{ file: string; at: string }> = [];
      const scan = (d: string, prefixes: string[]) => {
        if (!fs.existsSync(d)) return;
        for (const f of fs.readdirSync(d)) {
          if (prefixes.some((p) => f.startsWith(p)) && f.endsWith('.sqlite')) {
            candidates.push({ file: f, at: fs.statSync(path.join(d, f)).mtime.toISOString() });
          }
        }
      };
      scan(dir, ['backup-']); // legacy manual snapshots
      scan(path.join(dir, 'backups'), ['auto-', 'manual-']); // codified backups
      candidates.sort((a, b) => (a.at < b.at ? 1 : -1));
      lastBackup = candidates[0] ?? null;
    } catch {
      /* no backup dir */
    }
    let commit: string | null = null;
    try {
      const gitDir = path.resolve(path.dirname(dbPath), '../.git');
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      commit = head.startsWith('ref: ')
        ? fs.readFileSync(path.join(gitDir, head.slice(5)), 'utf8').trim().slice(0, 7)
        : head.slice(0, 7);
    } catch {
      /* not a git checkout */
    }
    return {
      product: 'JENIFY OS',
      version: '0.1.0',
      tenant: tenant?.name ?? null,
      environment: 'Local deployment',
      commit,
      database: { ok: dbSizeBytes != null, sizeBytes: dbSizeBytes },
      lastBackup,
    };
  });

  // ------------------------------- tenant ----------------------------------
  app.patch<{
    Body: { name?: string; locationNote?: string; brandColor?: string; timezone?: string };
  }>('/api/tenant', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    updateTenantBranding(ctx, req.body);
    return getTenant(db, ctx.tenantId);
  });
}
