import { and, eq, inArray } from 'drizzle-orm';
import { productionBatches } from '../db/schema.js';
import type { Ctx } from './context.js';
import { hasPermission } from '@factoryos/shared';
import { dashboard } from './dashboard.js';
import { listDeliveries } from './deliveries.js';
import { deliveryPerformance } from '@factoryos/shared';
import { nowIso } from '../util.js';

/**
 * Owner daily brief — the data foundation for "what happened / what needs my
 * attention / why". Composes existing services (no new queries of substance),
 * respects view_financial (money omitted when not permitted), and stays inside
 * JENIFY (no WhatsApp/external dependency). This is a read-only digest; it never
 * mutates and never invents numbers.
 */

export interface BriefItem {
  kind: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** optional count/value for the UI to render a badge */
  count?: number;
}

export interface OwnerBrief {
  date: string;
  /** "what happened today" — factual highlights */
  happened: BriefItem[];
  /** "what needs my attention" — sorted most-severe first */
  attention: BriefItem[];
  financialIncluded: boolean;
}

const SEV_RANK = { error: 0, warning: 1, info: 2 } as const;

export function ownerBrief(ctx: Ctx): OwnerBrief {
  const includeFinancial =
    ctx.user != null && hasPermission(ctx.user.permissions, 'dashboard', 'view_financial');
  const d = dashboard(ctx, { includeFinancial });
  const today = nowIso().slice(0, 10);

  const happened: BriefItem[] = [];
  const attention: BriefItem[] = [];

  // --- what happened today ---
  if (d.finance) {
    if (d.finance.todayInvoices > 0) {
      happened.push({ kind: 'sales', severity: 'info', message: `${d.finance.todayInvoices} sale(s) today`, count: d.finance.todayInvoices });
    }
    if (d.finance.todayPaymentsCents > 0) {
      happened.push({ kind: 'payments', severity: 'info', message: `Payments received today`, count: d.finance.todayPaymentsCents });
    }
  }
  const producedToday = d.production.reduce((s, p) => s + p.todayOutput, 0);
  if (producedToday > 0) happened.push({ kind: 'production', severity: 'info', message: `Production output recorded today` });
  if (d.deliveries.deliveredToday > 0) happened.push({ kind: 'delivery', severity: 'info', message: `${d.deliveries.deliveredToday} delivery(ies) completed today`, count: d.deliveries.deliveredToday });

  // --- needs attention ---
  // dashboard alerts already surface low stock / abnormal loss etc.
  for (const a of d.alerts) {
    attention.push({ kind: a.kind, severity: a.severity, message: a.message });
  }
  if (d.finance && d.finance.overdueInvoices > 0) {
    attention.push({ kind: 'credit_overdue', severity: 'warning', message: `${d.finance.overdueInvoices} overdue invoice(s)`, count: d.finance.overdueInvoices });
  }
  // late deliveries (dispatched but past expected date)
  const dispatched = listDeliveries(ctx, { status: 'dispatched' });
  const late = dispatched.filter((dl) => {
    const perf = deliveryPerformance({ expectedDate: dl.expectedDate, actualDate: dl.actualDate, status: dl.status, today });
    return perf?.code === 'overdue';
  }).length;
  if (late > 0) attention.push({ kind: 'delivery_late', severity: 'warning', message: `${late} delivery(ies) running late`, count: late });
  // QC batches completed but awaiting release
  const awaiting = ctx.db
    .select({ id: productionBatches.id })
    .from(productionBatches)
    .where(and(eq(productionBatches.tenantId, ctx.tenantId), inArray(productionBatches.qcStatus, ['passed_pending_release'])))
    .all().length;
  if (awaiting > 0) attention.push({ kind: 'qc_release', severity: 'warning', message: `${awaiting} batch(es) awaiting QC release`, count: awaiting });

  attention.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  return { date: today, happened, attention, financialIncluded: includeFinancial };
}
