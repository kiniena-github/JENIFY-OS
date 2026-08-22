import type { FastifyInstance } from 'fastify';
import type { ModuleId } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission } from '../services/permissions.js';
import {
  normalizeParsed,
  detectEntityType,
  suggestMapping,
  previewImport,
  executeImport,
  type ParsedInput,
  type ImportOptions,
  type EntityType,
} from '../services/importing.js';

/**
 * Data migration / import endpoints. The client parses the upload (CSV/XLSX)
 * into rows and posts them here; the engine detects, maps, validates, dedupes,
 * previews (zero writes) and imports. Permission is per ENTITY: importing
 * customers/suppliers needs parties.create; items/opening-inventory needs
 * inventory.create — the same authority as creating those records by hand.
 */
function entityPermission(entityType: EntityType): { module: ModuleId; action: string } {
  return entityType === 'customer' || entityType === 'supplier'
    ? { module: 'parties', action: 'create' }
    : { module: 'inventory', action: 'create' };
}

function resolveEntity(parsed: ParsedInput, opts: ImportOptions): EntityType {
  if (opts.entityType) return opts.entityType;
  return detectEntityType(normalizeParsed(parsed)).entityType;
}

export function registerImportRoutes(app: FastifyInstance, db: Db): void {
  // suggest entity type + mapping for the confirm-and-map UI (read-only)
  app.post<{ Body: { parsed: ParsedInput } }>('/api/import/detect', async (req) => {
    const ctx = requireCtx(db, req);
    const table = normalizeParsed(req.body.parsed);
    const detection = detectEntityType(table);
    return { detection, mapping: suggestMapping(table, detection.entityType) };
  });

  // preview performs ZERO writes — safe to call freely
  app.post<{ Body: { parsed: ParsedInput } & ImportOptions }>('/api/import/preview', async (req) => {
    const ctx = requireCtx(db, req);
    const { parsed, ...opts } = req.body;
    const perm = entityPermission(resolveEntity(parsed, opts));
    requirePermission(ctx, perm.module, perm.action);
    return previewImport(ctx, parsed, opts);
  });

  app.post<{ Body: { parsed: ParsedInput } & ImportOptions }>('/api/import/execute', async (req) => {
    const ctx = requireCtx(db, req);
    const { parsed, ...opts } = req.body;
    const perm = entityPermission(resolveEntity(parsed, opts));
    requirePermission(ctx, perm.module, perm.action);
    return executeImport(ctx, parsed, opts);
  });
}
