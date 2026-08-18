import type { FastifyInstance } from 'fastify';
import type { ItemKind, PartyKind } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission, canViewFinancial } from '../services/permissions.js';
import {
  listUoms,
  listItems,
  listWarehouses,
  createWarehouse,
  updateWarehouse,
} from '../services/masterdata.js';
import { listParties, createParty, updateParty, getParty } from '../services/parties.js';

export function registerMasterdataRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/uoms', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listUoms(ctx);
  });

  app.get<{ Querystring: { kind?: ItemKind; sellable?: string } }>('/api/items', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listItems(ctx, {
      kind: req.query.kind,
      sellable: req.query.sellable === undefined ? undefined : req.query.sellable === 'true',
    });
  });

  app.get<{ Querystring: { includeInactive?: string } }>('/api/warehouses', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listWarehouses(ctx, { includeInactive: req.query.includeInactive === 'true' });
  });

  app.post<{ Body: { code: string; name: string; locationNote?: string } }>(
    '/api/warehouses',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'settings', 'edit');
      const id = createWarehouse(ctx, req.body);
      return { id };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; locationNote?: string; active?: boolean };
  }>('/api/warehouses/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'settings', 'edit');
    updateWarehouse(ctx, req.params.id, req.body);
    return { ok: true };
  });

  // ------------------------------- parties ---------------------------------
  const stripFinancial = <T extends { creditLimitCents: number | null }>(
    rows: T[],
    canSee: boolean,
  ) => (canSee ? rows : rows.map((r) => ({ ...r, creditLimitCents: null })));

  app.get<{ Querystring: { kind?: PartyKind; search?: string; partyType?: string } }>(
    '/api/parties',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'parties', 'view');
      const rows = listParties(ctx, req.query);
      return stripFinancial(rows, canViewFinancial(ctx, 'parties'));
    },
  );

  app.get<{ Params: { id: string } }>('/api/parties/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'parties', 'view');
    const row = getParty(ctx, req.params.id);
    return stripFinancial([row], canViewFinancial(ctx, 'parties'))[0];
  });

  app.post<{
    Body: {
      kind: PartyKind;
      name: string;
      partyType?: string;
      phone?: string;
      location?: string;
      taxInfo?: string;
      creditLimit?: number;
      defaultPriceCategory?: string;
      notes?: string;
    };
  }>('/api/parties', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'parties', 'create');
    const id = createParty(ctx, req.body);
    return { id };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      partyType?: string;
      phone?: string;
      location?: string;
      taxInfo?: string;
      creditLimit?: number | null;
      defaultPriceCategory?: string | null;
      notes?: string;
      active?: boolean;
    };
  }>('/api/parties/:id', async (req) => {
    const ctx = requireCtx(db, req);
    // identity/profile editing and financial/credit control are SEPARATE
    // authorities: finance may govern credit without touching identity,
    // and sales may maintain profiles without touching credit.
    const identityFields = [
      'name',
      'partyType',
      'phone',
      'location',
      'taxInfo',
      'defaultPriceCategory',
      'notes',
      'active',
    ] as const;
    if (identityFields.some((f) => req.body[f] !== undefined)) {
      requirePermission(ctx, 'parties', 'edit');
    }
    if (req.body.creditLimit !== undefined) {
      requirePermission(ctx, 'parties', 'view_financial');
      requirePermission(ctx, 'parties', 'approve');
    }
    updateParty(ctx, req.params.id, req.body);
    return { ok: true };
  });
}
