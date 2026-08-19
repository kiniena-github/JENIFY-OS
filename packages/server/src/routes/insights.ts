import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission, canViewFinancial } from '../services/permissions.js';
import { dashboard } from '../services/dashboard.js';
import {
  rawStockReport,
  productionReport,
  qualityReport,
  packagingReport,
  finishedInventoryReport,
  salesReport,
  creditReport,
  deliveryReport,
  simpleItemReport,
  type Period,
} from '../services/reports.js';
import { postSimpleTxn, reverseSimpleTxn, listSimpleTxns } from '../services/simpletxn.js';
import { writeAudit } from '../services/audit.js';

interface PeriodQuery {
  from?: string;
  to?: string;
  warehouseId?: string;
  customerId?: string;
  stageCode?: string;
  itemId?: string;
  scope?: string; // credit report: open | settled | all
}

export function registerInsightRoutes(app: FastifyInstance, db: Db): void {
  /** Non-sensitive tenant UI configuration readable by any signed-in user. */
  app.get('/api/ui-config', async (req) => {
    const ctx = requireCtx(db, req);
    const { getSettings } = await import('../services/settings.js');
    const modules = getSettings<{ simpleItemScreens?: unknown[] }>(ctx, 'modules');
    const production = getSettings<{
      iodization?: { targetPpm?: string; additiveName?: string; additiveUnit?: string };
    }>(ctx, 'production');
    const general = getSettings<{ calendar?: string }>(ctx, 'general');
    const branding = getSettings<Record<string, unknown>>(ctx, 'branding');
    const pricing = getSettings<{ categories?: unknown[]; defaultCategory?: string }>(ctx, 'pricing');
    return {
      simpleItemScreens: modules?.data.simpleItemScreens ?? [],
      qualityTargetPpm: production?.data.iodization?.targetPpm ?? null,
      additiveName: production?.data.iodization?.additiveName ?? null,
      calendar: general?.data.calendar ?? 'gregorian',
      branding: branding?.data ?? null,
      pricing: pricing ? { categories: pricing.data.categories, defaultCategory: pricing.data.defaultCategory } : null,
    };
  });

  app.get('/api/dashboard', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'dashboard', 'view');
    return dashboard(ctx, { includeFinancial: canViewFinancial(ctx, 'dashboard') });
  });

  app.get<{ Params: { name: string }; Querystring: PeriodQuery }>(
    '/api/reports/:name',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'reports', 'view');
      const p: Period = { from: req.query.from, to: req.query.to };
      const requireFinancial = () => requirePermission(ctx, 'reports', 'view_financial');
      writeAudit(ctx, {
        module: 'reports',
        action: 'report_run',
        reference: req.params.name,
        summary: `Report '${req.params.name}' executed (${p.from ?? '…'} → ${p.to ?? '…'})`,
      });
      switch (req.params.name) {
        case 'raw-stock':
          return rawStockReport(ctx, p, req.query.warehouseId);
        case 'production':
          return productionReport(ctx, p, req.query.stageCode);
        case 'quality':
          return qualityReport(ctx, p);
        case 'packaging':
          return packagingReport(ctx, p);
        case 'finished-inventory':
          return finishedInventoryReport(ctx, p, req.query.warehouseId);
        case 'sales':
          requireFinancial();
          return salesReport(ctx, p, { customerId: req.query.customerId });
        case 'credit':
          requireFinancial();
          return creditReport(
            ctx,
            p,
            req.query.scope === 'settled' || req.query.scope === 'all' ? req.query.scope : 'open',
          );
        case 'delivery':
          return deliveryReport(ctx, p);
        case 'simple-item': {
          if (!req.query.itemId) return { error: 'itemId required' };
          return simpleItemReport(ctx, req.query.itemId, p);
        }
        default:
          return { error: `Unknown report '${req.params.name}'` };
      }
    },
  );

  // --------------------- simple item transactions (sacks) ------------------
  app.get<{ Querystring: { itemId: string } }>('/api/simple-transactions', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listSimpleTxns(ctx, req.query.itemId);
  });

  app.post<{
    Body: {
      itemId: string;
      warehouseId: string;
      type: 'collect' | 'sell';
      qty: number;
      buyer?: string;
      unitPrice?: number;
      date: string;
      notes?: string;
      docSeqKey: string;
    };
  }>('/api/simple-transactions', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'create');
    return postSimpleTxn(ctx, req.body);
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/simple-transactions/:id/reverse',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'inventory', 'approve');
      reverseSimpleTxn(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );
}
