import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { requireCtx } from '../app.js';
import { requirePermission, requireAnyPermission, canViewFinancial } from '../services/permissions.js';
import {
  createSalesReturn,
  reverseSalesReturn,
  listCreditNotes,
  createPurchaseReturn,
  listPurchaseReturns,
  type SalesReturnInput,
  type PurchaseReturnInput,
} from '../services/returns.js';
import {
  createInvoice,
  confirmInvoice,
  cancelInvoice,
  listInvoices,
  getInvoice,
  listInvoiceLines,
  invoicePaidCents,
  type CreateInvoiceInput,
} from '../services/sales.js';
import {
  createDelivery,
  updateDeliveryDetails,
  markLoading,
  dispatchDelivery,
  markDelivered,
  cancelDelivery,
  listDeliveries,
  type CreateDeliveryInput,
} from '../services/deliveries.js';
import {
  createPayment,
  applyAllocations,
  reversePayment,
  listPayments,
  listAllocationsForPayment,
  type CreatePaymentInput,
  type AllocationInput,
} from '../services/payments.js';
import {
  createOrder,
  confirmOrder,
  createInvoiceFromOrder,
  cancelOrder,
  listOrders,
  getOrder,
  listOrderLines,
  listInvoicesForOrder,
  type CreateOrderInput,
  type InvoiceOrderInput,
} from '../services/orders.js';
import { creditOverview } from '../services/creditview.js';
import { getSettings } from '../services/settings.js';

/** Zero out money fields when the caller lacks view_financial on the module. */
function maskMoney<T extends object>(row: T, fields: (keyof T)[], canSee: boolean): T {
  if (canSee) return row;
  const masked = { ...row };
  for (const f of fields) masked[f] = null as T[keyof T];
  return masked;
}

export function registerCommercialRoutes(app: FastifyInstance, db: Db): void {
  // ------------------------------- returns ---------------------------------
  app.post<{ Body: SalesReturnInput }>('/api/sales-returns', async (req) => {
    const ctx = requireCtx(db, req);
    return createSalesReturn(ctx, req.body); // enforces sales.create
  });
  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/sales-returns/:id/reverse', async (req) => {
    const ctx = requireCtx(db, req);
    reverseSalesReturn(ctx, req.params.id, req.body?.reason);
    return { ok: true };
  });
  app.get<{ Querystring: { invoiceId?: string } }>('/api/sales-returns', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    return listCreditNotes(ctx, req.query);
  });
  app.post<{ Body: PurchaseReturnInput }>('/api/purchase-returns', async (req) => {
    const ctx = requireCtx(db, req);
    return createPurchaseReturn(ctx, req.body); // enforces inventory.create
  });
  app.get<{ Querystring: { receiptId?: string } }>('/api/purchase-returns', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'inventory', 'view');
    return listPurchaseReturns(ctx, req.query);
  });

  // ------------------------------- orders ----------------------------------
  app.get<{ Querystring: { customerId?: string; status?: string; channel?: string } }>(
    '/api/orders',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'sales', 'view');
      const canSee = canViewFinancial(ctx, 'sales');
      return listOrders(ctx, req.query).map((o) =>
        maskMoney(o, ['subtotalCents', 'discountCents', 'vatCents', 'totalCents'], canSee),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    const canSee = canViewFinancial(ctx, 'sales');
    const order = getOrder(ctx, req.params.id);
    const lines = listOrderLines(ctx, req.params.id).map((l) =>
      maskMoney(l, ['unitPriceCents', 'discountCents', 'lineSubtotalCents'], canSee),
    );
    const invoices = listInvoicesForOrder(ctx, req.params.id).map((inv) =>
      maskMoney(inv, ['subtotalCents', 'discountCents', 'vatCents', 'totalCents'], canSee),
    );
    return {
      order: maskMoney(order, ['subtotalCents', 'discountCents', 'vatCents', 'totalCents'], canSee),
      lines,
      invoices,
    };
  });

  app.post<{ Body: CreateOrderInput & { andConfirm?: boolean } }>('/api/orders', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'create');
    const { andConfirm, ...input } = req.body;
    const hasCustom = input.lines?.some((l) => l.unitPrice != null || (l.discount ?? 0) > 0);
    if (hasCustom) {
      // custom price / discount requires the approve permission on sales
      requirePermission(ctx, 'sales', 'approve');
      input.customApproved = true;
    }
    const result = createOrder(ctx, input);
    if (andConfirm) confirmOrder(ctx, result.id);
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/orders/:id/confirm', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'edit');
    confirmOrder(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: InvoiceOrderInput }>(
    '/api/orders/:id/invoice',
    async (req) => {
      const ctx = requireCtx(db, req);
      // creates an invoice, so the invoice-creation permission governs
      requirePermission(ctx, 'sales', 'create');
      if (req.body?.creditOverride) requirePermission(ctx, 'credit', 'approve');
      return createInvoiceFromOrder(ctx, req.params.id, req.body);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/orders/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'sales', 'edit');
      cancelOrder(ctx, req.params.id, req.body?.reason);
      return { ok: true };
    },
  );

  // ------------------------------- sales -----------------------------------
  app.get<{ Querystring: { customerId?: string; status?: string } }>('/api/invoices', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    const canSee = canViewFinancial(ctx, 'sales');
    return listInvoices(ctx, req.query).map((inv) => ({
      ...maskMoney(inv, ['subtotalCents', 'discountCents', 'vatCents', 'totalCents'], canSee),
      paidCents: canSee ? invoicePaidCents(ctx, inv.id) : null,
    }));
  });

  app.get<{ Params: { id: string } }>('/api/invoices/:id', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    const canSee = canViewFinancial(ctx, 'sales');
    const invoice = getInvoice(ctx, req.params.id);
    const lines = listInvoiceLines(ctx, req.params.id).map((l) =>
      maskMoney(l, ['unitPriceCents', 'discountCents', 'lineSubtotalCents'], canSee),
    );
    return {
      invoice: {
        ...maskMoney(invoice, ['subtotalCents', 'discountCents', 'vatCents', 'totalCents'], canSee),
        paidCents: canSee ? invoicePaidCents(ctx, invoice.id) : null,
      },
      lines,
    };
  });

  app.post<{ Body: CreateInvoiceInput & { andConfirm?: boolean; creditOverride?: boolean } }>(
    '/api/invoices',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'sales', 'create');
      const { andConfirm, creditOverride, ...input } = req.body;
      const hasCustom = input.lines?.some((l) => l.unitPrice != null || (l.discount ?? 0) > 0);
      if (hasCustom) {
        // custom price / discount requires the approve permission on sales
        requirePermission(ctx, 'sales', 'approve');
        input.customApproved = true;
      }
      const result = createInvoice(ctx, input);
      if (andConfirm) {
        if (creditOverride) requirePermission(ctx, 'credit', 'approve');
        confirmInvoice(ctx, result.id, { creditOverride });
      }
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { creditOverride?: boolean } }>(
    '/api/invoices/:id/confirm',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'sales', 'edit');
      if (req.body?.creditOverride) requirePermission(ctx, 'credit', 'approve');
      confirmInvoice(ctx, req.params.id, { creditOverride: req.body?.creditOverride });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/invoices/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'sales', 'edit');
      cancelInvoice(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  // ------------------------------- credit ----------------------------------
  app.get<{ Querystring: { customerId?: string; status?: string } }>('/api/credit', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'credit', 'view');
    const canSee = canViewFinancial(ctx, 'credit');
    const result = creditOverview(ctx, req.query as Parameters<typeof creditOverview>[1]);
    if (!canSee) {
      return {
        rows: result.rows.map((r) =>
          maskMoney(r, ['totalCents', 'paidCents', 'remainingCents'], false),
        ),
        outstandingCents: null,
        overdueCents: null,
        dueThisWeekCents: null,
      };
    }
    return result;
  });

  // ------------------------------ deliveries -------------------------------
  app.get<{ Querystring: { status?: string } }>('/api/deliveries', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'delivery', 'view');
    return listDeliveries(ctx, req.query);
  });

  app.post<{ Body: CreateDeliveryInput }>('/api/deliveries', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'delivery', 'create');
    return createDelivery(ctx, req.body);
  });

  app.patch<{ Params: { id: string }; Body: Parameters<typeof updateDeliveryDetails>[2] }>(
    '/api/deliveries/:id',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'delivery', 'edit');
      updateDeliveryDetails(ctx, req.params.id, req.body);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/deliveries/:id/loading', async (req) => {
    const ctx = requireCtx(db, req);
    // action-specific 'load' permission; broad 'edit' also accepted
    requireAnyPermission(ctx, 'delivery', ['load', 'edit']);
    markLoading(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/deliveries/:id/dispatch', async (req) => {
    const ctx = requireCtx(db, req);
    // action-specific 'dispatch' permission; broad 'approve' also accepted
    requireAnyPermission(ctx, 'delivery', ['dispatch', 'approve']);
    dispatchDelivery(ctx, req.params.id);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { actualDate: string; receivedBy: string; notes?: string };
  }>('/api/deliveries/:id/delivered', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'delivery', 'edit');
    markDelivered(ctx, req.params.id, req.body);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/deliveries/:id/cancel',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'delivery', 'edit');
      cancelDelivery(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  // ------------------------------- payments --------------------------------
  app.get<{ Querystring: { customerId?: string } }>('/api/payments', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'payments', 'view');
    requirePermission(ctx, 'payments', 'view_financial');
    return listPayments(ctx, req.query);
  });

  app.get<{ Params: { id: string } }>('/api/payments/:id/allocations', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'payments', 'view');
    requirePermission(ctx, 'payments', 'view_financial');
    return listAllocationsForPayment(ctx, req.params.id);
  });

  app.post<{ Body: CreatePaymentInput & { post?: boolean } }>('/api/payments', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'payments', 'create');
    const { post, ...input } = req.body;
    if (post) requirePermission(ctx, 'payments', 'approve');
    return createPayment(ctx, input, { post });
  });

  app.post<{ Params: { id: string }; Body: { allocations: AllocationInput[] } }>(
    '/api/payments/:id/allocate',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'payments', 'approve');
      applyAllocations(ctx, req.params.id, req.body.allocations);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/payments/:id/reverse',
    async (req) => {
      const ctx = requireCtx(db, req);
      requirePermission(ctx, 'payments', 'approve');
      reversePayment(ctx, req.params.id, req.body.reason);
      return { ok: true };
    },
  );

  // ---------------------------- pricing lookup -----------------------------
  app.get('/api/pricing', async (req) => {
    const ctx = requireCtx(db, req);
    requirePermission(ctx, 'sales', 'view');
    const pricing = getSettings(ctx, 'pricing');
    const vat = getSettings(ctx, 'vat');
    return { pricing: pricing ?? null, vat: vat ?? null };
  });
}
