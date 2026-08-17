import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  auditEvents,
  deliveries,
  productionBatches,
  productionStages,
  salesInvoices,
} from '../db/schema.js';
import { nowIso } from '../util.js';
import type { Ctx } from './context.js';
import { stockOverview } from './stockview.js';
import { creditOverview } from './creditview.js';
import { listPayments } from './payments.js';
import { getSettings } from './settings.js';

export interface DashboardData {
  rawStock: { totalQty: number; byWarehouse: Array<{ code: string; name: string; qty: number }> };
  production: Array<{
    stageCode: string;
    nameKey: string;
    todayInput: number;
    todayOutput: number;
    todayLoss: number | null;
    openBatches: number;
  }>;
  finished: Array<{ itemName: string; units: number; weight: number | null }>;
  finance: {
    todaySalesCents: number;
    todayInvoices: number;
    monthSalesCents: number;
    monthVatCents: number;
    todayPaymentsCents: number;
    outstandingCents: number;
    outstandingCustomers: number;
    overdueCents: number;
    overdueInvoices: number;
  } | null;
  deliveries: { pending: number; loading: number; dispatched: number; deliveredToday: number };
  simpleItems: Array<{ label: string; available: number; soldMonth: number }>;
  alerts: Array<{ kind: string; message: string; severity: 'warning' | 'error' | 'info' }>;
  recentActivity: Array<{
    time: string;
    user: string | null;
    action: string;
    reference: string | null;
    summary: string;
  }>;
}

export function dashboard(ctx: Ctx, opts: { includeFinancial: boolean }): DashboardData {
  const today = nowIso().slice(0, 10);
  const month = today.slice(0, 7);

  // ---- raw stock ----
  const raw = stockOverview(ctx, { kind: 'raw_material' });
  const byWarehouse = new Map<string, { code: string; name: string; qty: number }>();
  for (const r of raw) {
    const cur = byWarehouse.get(r.warehouseId) ?? { code: r.warehouseCode, name: r.warehouseName, qty: 0 };
    cur.qty += r.onHand;
    byWarehouse.set(r.warehouseId, cur);
  }

  // ---- production today per stage ----
  const stages = ctx.db
    .select()
    .from(productionStages)
    .where(and(eq(productionStages.tenantId, ctx.tenantId), eq(productionStages.active, true)))
    .all();
  const batches = ctx.db
    .select()
    .from(productionBatches)
    .where(eq(productionBatches.tenantId, ctx.tenantId))
    .all();
  const production = stages
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => {
      const todayDone = batches.filter(
        (b) => b.stageId === s.id && b.status === 'completed' && b.date === today,
      );
      return {
        stageCode: s.code,
        nameKey: s.nameKey,
        todayInput: todayDone.reduce((x, b) => x + b.inputQty, 0),
        todayOutput: todayDone.reduce((x, b) => x + (b.outputQty ?? 0), 0),
        todayLoss: s.outputForm === 'bulk' ? todayDone.reduce((x, b) => x + (b.lossQty ?? 0), 0) : null,
        openBatches: batches.filter(
          (b) => b.stageId === s.id && (b.status === 'draft' || b.status === 'in_progress'),
        ).length,
      };
    });

  // ---- finished stock ----
  const finishedStock = stockOverview(ctx, { kind: 'finished_good' });
  const finishedByItem = new Map<string, { itemName: string; units: number; weight: number | null }>();
  for (const r of finishedStock) {
    const cur = finishedByItem.get(r.itemId) ?? {
      itemName: r.itemName,
      units: 0,
      weight: r.unitWeightMilliKg != null ? 0 : null,
    };
    cur.units += r.available;
    if (cur.weight != null && r.unitWeightMilliKg != null) {
      cur.weight += (r.available / 1000) * r.unitWeightMilliKg;
    }
    finishedByItem.set(r.itemId, cur);
  }

  // ---- finance ----
  let finance: DashboardData['finance'] = null;
  const credit = creditOverview(ctx);
  if (opts.includeFinancial) {
    const committed = ctx.db
      .select()
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.tenantId, ctx.tenantId),
          inArray(salesInvoices.status, ['confirmed', 'dispatched', 'completed']),
        ),
      )
      .all();
    const todayInv = committed.filter((i) => i.date === today);
    const monthInv = committed.filter((i) => i.date.startsWith(month));
    const posted = listPayments(ctx).filter((p) => p.status === 'posted');
    finance = {
      todaySalesCents: todayInv.reduce((s, i) => s + i.totalCents, 0),
      todayInvoices: todayInv.length,
      monthSalesCents: monthInv.reduce((s, i) => s + i.totalCents, 0),
      monthVatCents: monthInv.reduce((s, i) => s + i.vatCents, 0),
      todayPaymentsCents: posted.filter((p) => p.date === today).reduce((s, p) => s + p.amountCents, 0),
      outstandingCents: credit.outstandingCents,
      outstandingCustomers: new Set(credit.rows.filter((r) => r.remainingCents > 0).map((r) => r.customerId)).size,
      overdueCents: credit.overdueCents,
      overdueInvoices: credit.rows.filter((r) => r.status === 'overdue').length,
    };
  }

  // ---- deliveries ----
  const dels = ctx.db.select().from(deliveries).where(eq(deliveries.tenantId, ctx.tenantId)).all();
  const deliveryCards = {
    pending: dels.filter((d) => d.status === 'pending').length,
    loading: dels.filter((d) => d.status === 'loading').length,
    dispatched: dels.filter((d) => d.status === 'dispatched').length,
    deliveredToday: dels.filter((d) => d.status === 'delivered' && d.actualDate === today).length,
  };

  // ---- simple item screens (e.g. empty sacks) ----
  const modules = getSettings<{ simpleItemScreens?: Array<{ itemId: string; labelKey: string }> }>(
    ctx,
    'modules',
  );
  const simpleItems = (modules?.data.simpleItemScreens ?? []).map((cfg) => {
    const stock = stockOverview(ctx, { itemId: cfg.itemId });
    return {
      label: cfg.labelKey,
      available: stock.reduce((s, r) => s + r.onHand, 0),
      soldMonth: 0, // detail available in the simple-item report
    };
  });

  // ---- alerts ----
  const alerts: DashboardData['alerts'] = [];
  const overdueRows = credit.rows.filter((r) => r.status === 'overdue');
  if (overdueRows.length > 0) {
    alerts.push({
      kind: 'overdue_credit',
      message: `${overdueRows.length} overdue invoice(s)`,
      severity: 'error',
    });
  }
  const pendingDeliveries = deliveryCards.pending + deliveryCards.loading;
  if (pendingDeliveries > 0) {
    alerts.push({
      kind: 'pending_deliveries',
      message: `${pendingDeliveries} delivery order(s) awaiting dispatch`,
      severity: 'warning',
    });
  }
  const retests = batches.filter(
    (b) => b.status === 'completed' && (b.qcStatus === 'retest_required' || b.qcStatus === 'failed'),
  );
  if (retests.length > 0) {
    alerts.push({
      kind: 'qc_retest',
      message: `${retests.length} batch(es) failed or awaiting retest`,
      severity: 'warning',
    });
  }
  const awaitingQc = batches.filter((b) => b.status === 'completed' && b.qcStatus === 'pending');
  const gatedStages = new Set(stages.filter((s) => s.requiresQc).map((s) => s.id));
  const awaitingApproval = awaitingQc.filter((b) => gatedStages.has(b.stageId));
  if (awaitingApproval.length > 0) {
    alerts.push({
      kind: 'qc_pending',
      message: `${awaitingApproval.length} batch(es) awaiting quality approval`,
      severity: 'info',
    });
  }

  // ---- recent activity ----
  const recent = ctx.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, ctx.tenantId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(8)
    .all();

  return {
    rawStock: {
      totalQty: raw.reduce((s, r) => s + r.onHand, 0),
      byWarehouse: [...byWarehouse.values()].sort((a, b) => a.code.localeCompare(b.code)),
    },
    production,
    finished: [...finishedByItem.values()],
    finance,
    deliveries: deliveryCards,
    simpleItems,
    alerts,
    recentActivity: recent.map((e) => ({
      time: e.createdAt,
      user: e.userId,
      action: e.action,
      reference: e.reference,
      summary: e.summary,
    })),
  };
}
