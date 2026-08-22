// JENIFY AI — read-only intent layer (AI-M1 / v0).
//
// This is the "analyst": natural language → typed intent → permission check →
// grounded answer over EXISTING permission-respecting services → provenance.
// It is deliberately read-only. It creates, edits, posts, and configures
// NOTHING. Its only effectors are the existing tenant-scoped service reads.
//
// Safety invariants enforced structurally here (see
// docs/research/AI_MASTER_ARCHITECTURE.md §4):
//   §4.1 Capability containment. This module holds NO database handle and
//        issues NO query through the ORM or a raw statement. It calls only
//        existing service functions, each already tenant-scoped through `ctx`.
//        (A test asserts this file's source performs no direct data access.)
//   §4.2 RBAC + tenant isolation. `answerIntent` runs `requirePermission`
//        FIRST (fail-closed) before any data is touched, and `tenantId` is
//        derived ONLY from `ctx` — never from caller-supplied params.
//   §4.3 No fabrication. Every answer carries `provenance` (the record ids it
//        is built from). When the data needed to answer honestly is absent the
//        result is an explicit `insufficient`, never a guessed or invented
//        figure. A truthful zero (e.g. "nobody owes money") is returned as an
//        `ok` answer flagged `empty`, so the caller narrates it as an emptiness
//        rather than confidently inventing detail.
//
// Routes are NOT wired here — the Team Lead wires them. This module is the
// declarative catalog + resolver they call.

import type { ActionId, ModuleId } from '@factoryos/shared';
import { deliveryPerformance, hasPermission } from '@factoryos/shared';
import { forbidden, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { canViewFinancial, requirePermission } from './permissions.js';
import { dashboard } from './dashboard.js';
import { creditOverview } from './creditview.js';
import {
  creditReport,
  productionReport,
  qualityReport,
  rawStockReport,
  finishedInventoryReport,
  salesReport,
} from './reports.js';
import { listMovements } from './inventory.js';
import { listBatches } from './batches.js';
import { listDeliveries } from './deliveries.js';
import { listPayments } from './payments.js';
import { listAudit } from './audit.js';
import { getParty } from './parties.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionRef {
  module: ModuleId;
  action: ActionId | string;
}

/** Parameters an intent may take. Deliberately has NO tenantId field: tenant
 *  scope is derived from `ctx` alone and can never be spoofed through params. */
export interface IntentParams {
  from?: string;
  to?: string;
  warehouseId?: string;
  customerId?: string;
  stageCode?: string;
  itemId?: string;
  lotId?: string;
  limit?: number;
}

export type IntentRunStatus = 'ok' | 'insufficient';

/** What an intent's resolver returns before answerIntent wraps it. */
export interface IntentRunResult {
  status: IntentRunStatus;
  /** structured, grounded data — present when status === 'ok' */
  data?: unknown;
  /** identifiers of the real records the answer is built from */
  provenance?: string[];
  /** a truthful empty/zero answer (caller must narrate emptiness, not invent) */
  empty?: boolean;
  /** why the question cannot be answered honestly (status === 'insufficient') */
  reason?: string;
}

export interface IntentDef {
  /** stable, namespaced id — never changes once assigned */
  id: string;
  description: string;
  /** ALL of these must hold; mirrors the guarded route (fail-closed) */
  requiredPermissions: PermissionRef[];
  /** at least ONE must hold, when present (routes using requireAnyPermission) */
  anyOfPermissions?: PermissionRef[];
  /** the existing service function(s) this intent delegates to */
  delegatesTo: string;
  /** human-readable description of the grounded result shape */
  resultShape: string;
  /** if set, money is masked (nulled) unless the user holds this module's
   *  view_financial — mirrors the UI's server-side masking */
  financialModule?: ModuleId;
  run(ctx: Ctx, params: IntentParams): IntentRunResult;
}

/** The final, wrapped answer returned to a caller/route. */
export interface AiAnswer {
  intentId: string;
  status: IntentRunStatus;
  data?: unknown;
  provenance: string[];
  empty: boolean;
  reason?: string;
  /** true when money fields were nulled because the user lacks view_financial */
  financialMasked: boolean;
  /** echoes the tenant the answer was scoped to — always from ctx, for audit */
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Small pure date helpers (tenant "today" mirrors dashboard.ts: server date).
// No business rule is invented here; these only compute period bounds.
// ---------------------------------------------------------------------------

function dayISO(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function todayISO(): string {
  return dayISO(0);
}
function monthRange(): { from: string; to: string } {
  const today = todayISO();
  return { from: `${today.slice(0, 7)}-01`, to: today };
}
function weekRange(): { from: string; to: string } {
  return { from: dayISO(-6), to: todayISO() };
}
function dayDiffISO(aIso: string, bIso: string): number {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
  return Math.round((a - b) / 86_400_000);
}
function addDaysISO(iso: string, days: number): string {
  const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
/** The equal-length window immediately preceding [from,to]. */
function priorWindow(from: string, to: string): { from: string; to: string } {
  const len = dayDiffISO(to, from); // inclusive length - 1
  const prevTo = addDaysISO(from, -1);
  return { from: addDaysISO(prevTo, -len), to: prevTo };
}
function inRange(date: string, from?: string, to?: string): boolean {
  return (!from || date >= from) && (!to || date <= to);
}

/** Keep only non-empty string identifiers for a provenance list. */
function ids(list: Array<string | null | undefined>): string[] {
  return list.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

// ---------------------------------------------------------------------------
// The intent catalog (read-only v0). Each entry delegates to an existing,
// permission-respecting, tenant-scoped service function. None of them writes.
// ---------------------------------------------------------------------------

export const INTENTS: readonly IntentDef[] = [
  {
    id: 'read.owner.briefing',
    description: 'Owner briefing: today\'s output, sales, credit, stock alerts, top attention items.',
    requiredPermissions: [{ module: 'dashboard', action: 'view' }],
    financialModule: 'dashboard',
    delegatesTo: 'dashboard()',
    resultShape: '{ rawStock, production[], finance|null, deliveries, alerts[], attention[], recentActivity[] }',
    run(ctx) {
      const includeFinancial = canViewFinancial(ctx, 'dashboard');
      const d = dashboard(ctx, { includeFinancial });
      return {
        status: 'ok',
        data: {
          rawStock: d.rawStock,
          production: d.production,
          finance: d.finance, // null when the user lacks dashboard.view_financial
          deliveries: d.deliveries,
          alerts: d.alerts,
          attention: d.alerts.slice(0, 3),
          recentActivity: d.recentActivity,
        },
        provenance: ids(d.recentActivity.map((a) => a.reference)),
        empty: false,
      };
    },
  },
  {
    id: 'read.credit.top_debtors',
    description: 'Customers ranked by outstanding balance ("who owes us the most?").',
    requiredPermissions: [
      { module: 'credit', action: 'view' },
      { module: 'credit', action: 'view_financial' },
    ],
    delegatesTo: 'creditOverview()',
    resultShape: '{ outstandingCents, debtors: [{ customer, invoiceNumber, remainingCents, status }] }',
    run(ctx, params) {
      const ov = creditOverview(ctx);
      const debtors = ov.rows
        .filter((r) => r.remainingCents > 0)
        .sort((a, b) => b.remainingCents - a.remainingCents)
        .slice(0, params.limit ?? 10);
      return {
        status: 'ok',
        data: {
          outstandingCents: ov.outstandingCents,
          debtors: debtors.map((r) => ({
            customer: r.customerName,
            invoiceNumber: r.invoiceNumber,
            remainingCents: r.remainingCents,
            status: r.status,
          })),
        },
        provenance: ids(debtors.map((r) => r.invoiceNumber)),
        empty: debtors.length === 0,
      };
    },
  },
  {
    id: 'read.credit.overdue_invoices',
    description: 'Invoices past their due date with a remaining balance.',
    requiredPermissions: [
      { module: 'credit', action: 'view' },
      { module: 'credit', action: 'view_financial' },
    ],
    delegatesTo: 'creditOverview({ status: "overdue" })',
    resultShape: '{ overdueCents, invoices: [{ customer, invoiceNumber, dueDate, remainingCents }] }',
    run(ctx) {
      const ov = creditOverview(ctx, { status: 'overdue' });
      return {
        status: 'ok',
        data: {
          overdueCents: ov.overdueCents,
          invoices: ov.rows.map((r) => ({
            customer: r.customerName,
            invoiceNumber: r.invoiceNumber,
            dueDate: r.dueDate,
            remainingCents: r.remainingCents,
          })),
        },
        provenance: ids(ov.rows.map((r) => r.invoiceNumber)),
        empty: ov.rows.length === 0,
      };
    },
  },
  {
    id: 'read.sales.today_total',
    description: 'Total sales committed today, with invoice count and VAT.',
    requiredPermissions: [
      { module: 'reports', action: 'view' },
      { module: 'reports', action: 'view_financial' },
    ],
    delegatesTo: 'salesReport(today)',
    resultShape: '{ date, totalCents, invoiceCount, vatCents }',
    run(ctx) {
      const today = todayISO();
      const r = salesReport(ctx, { from: today, to: today });
      return {
        status: 'ok',
        data: {
          date: today,
          totalCents: r.totalCents,
          invoiceCount: r.invoiceCount,
          vatCents: r.vatCents,
        },
        provenance: ids(r.breakdown.map((b) => b.invoiceNumber)),
        empty: r.invoiceCount === 0,
      };
    },
  },
  {
    id: 'read.reports.monthly_pack',
    description: 'Assembled month-to-date figures across sales, production and credit.',
    requiredPermissions: [
      { module: 'reports', action: 'view' },
      { module: 'reports', action: 'view_financial' },
    ],
    delegatesTo: 'salesReport + productionReport + creditReport (month)',
    resultShape: '{ period, sales, production, credit }',
    run(ctx, params) {
      const period =
        params.from && params.to ? { from: params.from, to: params.to } : monthRange();
      const sales = salesReport(ctx, period);
      const production = productionReport(ctx, period);
      const credit = creditReport(ctx, period);
      return {
        status: 'ok',
        data: {
          period,
          sales: {
            invoiceCount: sales.invoiceCount,
            totalCents: sales.totalCents,
            vatCents: sales.vatCents,
          },
          production: {
            rawInputQty: production.rawInputQty,
            finalOutputQty: production.finalOutputQty,
            lossQty: production.lossQty,
          },
          credit: {
            outstandingCents: credit.outstandingCents,
            collectedCents: credit.collectedCents,
          },
        },
        provenance: ids([
          ...sales.breakdown.map((b) => b.invoiceNumber),
          ...production.breakdown.map((b) => b.batchNumber),
        ]),
        empty: sales.invoiceCount === 0 && production.breakdown.length === 0,
      };
    },
  },
  {
    id: 'read.inventory.raw_stock',
    description: 'Raw material on hand: received / used / remaining, by batch and warehouse.',
    requiredPermissions: [{ module: 'inventory', action: 'view' }],
    delegatesTo: 'rawStockReport()',
    resultShape: '{ receivedQty, usedQty, remainingQty, reservedQty, lotCount, batches[] }',
    run(ctx, params) {
      const r = rawStockReport(ctx, {}, params.warehouseId);
      return {
        status: 'ok',
        data: {
          receivedQty: r.receivedQty,
          usedQty: r.usedQty,
          remainingQty: r.remainingQty,
          reservedQty: r.reservedQty,
          lotCount: r.lotCount,
          batches: r.batches,
        },
        provenance: ids(r.batches.map((b) => b.lotNumber)),
        empty: r.batches.length === 0 && r.remainingQty === 0,
      };
    },
  },
  {
    id: 'read.inventory.finished_stock',
    description: 'Finished goods available / reserved / sold, by lot and warehouse.',
    requiredPermissions: [{ module: 'inventory', action: 'view' }],
    delegatesTo: 'finishedInventoryReport()',
    resultShape: '{ availableUnits, reservedUnits, soldUnits, availableWeight, breakdown[] }',
    run(ctx, params) {
      const r = finishedInventoryReport(ctx, {}, params.warehouseId);
      return {
        status: 'ok',
        data: {
          availableUnits: r.availableUnits,
          reservedUnits: r.reservedUnits,
          soldUnits: r.soldUnits,
          availableWeight: r.availableWeight,
          breakdown: r.breakdown,
        },
        provenance: ids(r.breakdown.map((b) => b.lotNumber)),
        empty: r.breakdown.length === 0,
      };
    },
  },
  {
    id: 'read.inventory.lot_history',
    description: 'Stock movements for a specific lot or item (traceability).',
    requiredPermissions: [{ module: 'inventory', action: 'view' }],
    delegatesTo: 'listMovements({ lotId | itemId })',
    resultShape: '{ count, movements: [{ docNumber, type, qty, postedAt, warehouseId }] }',
    run(ctx, params) {
      // Never guess which lot/item: require a resolved reference.
      if (!params.lotId && !params.itemId) {
        return {
          status: 'insufficient',
          reason: 'Specify a lot or item to trace its movements.',
          provenance: [],
        };
      }
      const rows = listMovements(ctx, {
        lotId: params.lotId,
        itemId: params.itemId,
        limit: params.limit ?? 200,
      });
      return {
        status: 'ok',
        data: {
          count: rows.length,
          movements: rows.map((m) => ({
            docNumber: m.documentNumber,
            type: m.movementType,
            qty: m.qty,
            postedAt: m.postedAt,
            warehouseId: m.warehouseId,
          })),
        },
        provenance: ids(rows.map((m) => m.documentNumber)),
        empty: rows.length === 0,
      };
    },
  },
  {
    id: 'read.production.output_today',
    description: 'Today\'s production output per stage, with totals.',
    requiredPermissions: [],
    anyOfPermissions: [
      { module: 'reports', action: 'view' },
      { module: 'production', action: 'view' },
    ],
    delegatesTo: 'productionReport(today)',
    resultShape: '{ date, rawInputQty, finalOutputQty, perStage[] }',
    run(ctx, params) {
      const today = todayISO();
      const r = productionReport(ctx, { from: today, to: today }, params.stageCode);
      return {
        status: 'ok',
        data: {
          date: today,
          rawInputQty: r.rawInputQty,
          finalOutputQty: r.finalOutputQty,
          perStage: r.perStage,
        },
        provenance: ids(r.breakdown.map((b) => b.batchNumber)),
        empty: r.breakdown.length === 0,
      };
    },
  },
  {
    id: 'read.production.loss_explain',
    description:
      'Why did production change? Ranked causes computed from real deltas vs the prior period.',
    requiredPermissions: [{ module: 'reports', action: 'view' }],
    delegatesTo: 'productionReport(current) vs productionReport(prior)',
    resultShape: '{ current, previous, deltas, causes[] }',
    run(ctx, params) {
      const current =
        params.from && params.to ? { from: params.from, to: params.to } : weekRange();
      const previous = priorWindow(current.from, current.to);
      const cur = productionReport(ctx, current, params.stageCode);
      const prev = productionReport(ctx, previous, params.stageCode);
      // Cannot explain a change with nothing to measure in EITHER window.
      if (cur.breakdown.length === 0 && prev.breakdown.length === 0) {
        return {
          status: 'insufficient',
          reason: 'No completed production in either period to compare — nothing to explain.',
          provenance: [],
        };
      }
      const deltas = {
        inputDelta: cur.rawInputQty - prev.rawInputQty,
        outputDelta: cur.finalOutputQty - prev.finalOutputQty,
        lossDelta: cur.lossQty - prev.lossQty,
      };
      // Per-stage output deltas, ranked by magnitude — all from real numbers.
      const prevByStage = new Map(prev.perStage.map((s) => [s.stageCode, s]));
      const causes = cur.perStage
        .map((s) => ({
          stageCode: s.stageCode,
          outputDelta: s.outputQty - (prevByStage.get(s.stageCode)?.outputQty ?? 0),
          lossDelta: (s.lossQty ?? 0) - (prevByStage.get(s.stageCode)?.lossQty ?? 0),
        }))
        .sort((a, b) => Math.abs(b.outputDelta) - Math.abs(a.outputDelta));
      return {
        status: 'ok',
        data: {
          current: {
            period: current,
            rawInputQty: cur.rawInputQty,
            finalOutputQty: cur.finalOutputQty,
            lossQty: cur.lossQty,
          },
          previous: {
            period: previous,
            rawInputQty: prev.rawInputQty,
            finalOutputQty: prev.finalOutputQty,
            lossQty: prev.lossQty,
          },
          deltas,
          causes,
        },
        provenance: ids([
          ...cur.breakdown.map((b) => b.batchNumber),
          ...prev.breakdown.map((b) => b.batchNumber),
        ]),
        empty: false,
      };
    },
  },
  {
    id: 'read.quality.awaiting_release',
    description: 'Completed batches awaiting a QC test or release.',
    requiredPermissions: [],
    anyOfPermissions: [
      { module: 'quality', action: 'view' },
      { module: 'production', action: 'view' },
    ],
    delegatesTo: 'listBatches({ status: "completed" })',
    resultShape: '{ count, batches: [{ batchNumber, qcStatus, date }] }',
    run(ctx) {
      const awaiting = listBatches(ctx, { status: 'completed' }).filter(
        (b) =>
          b.qcStatus === 'pending' ||
          b.qcStatus === 'passed_pending_release' ||
          b.qcStatus === 'retest_required',
      );
      return {
        status: 'ok',
        data: {
          count: awaiting.length,
          batches: awaiting.map((b) => ({
            batchNumber: b.docNumber,
            qcStatus: b.qcStatus,
            date: b.date,
          })),
        },
        provenance: ids(awaiting.map((b) => b.docNumber)),
        empty: awaiting.length === 0,
      };
    },
  },
  {
    id: 'read.quality.failures_period',
    description: 'QC failures / held batches in the period.',
    requiredPermissions: [],
    anyOfPermissions: [
      { module: 'reports', action: 'view' },
      { module: 'quality', action: 'view' },
    ],
    delegatesTo: 'qualityReport(period)',
    resultShape: '{ failedAttempts, currentlyFailedCount, batches[] }',
    run(ctx, params) {
      const period =
        params.from && params.to ? { from: params.from, to: params.to } : monthRange();
      const r = qualityReport(ctx, period);
      const failed = r.breakdown.filter(
        (b) => b.qcResult === 'failed' || b.releaseStatus === 'held',
      );
      return {
        status: 'ok',
        data: {
          failedAttempts: r.failedAttempts,
          currentlyFailedCount: r.currentlyFailedCount,
          batches: failed.map((b) => ({
            batchNumber: b.batchNumber,
            qcResult: b.qcResult,
            releaseStatus: b.releaseStatus,
            date: b.date,
          })),
        },
        provenance: ids(failed.map((b) => b.batchNumber)),
        empty: failed.length === 0,
      };
    },
  },
  {
    id: 'read.delivery.overdue',
    description: 'Open deliveries running past their expected date.',
    requiredPermissions: [{ module: 'delivery', action: 'view' }],
    delegatesTo: 'listDeliveries() + deliveryPerformance()',
    resultShape: '{ count, deliveries: [{ deliveryNumber, expectedDate, daysOverdue, status }] }',
    run(ctx) {
      const today = todayISO();
      const overdue = listDeliveries(ctx)
        .map((d) => ({
          d,
          perf: deliveryPerformance({
            expectedDate: d.expectedDate,
            actualDate: d.actualDate,
            status: d.status,
            today,
          }),
        }))
        .filter((x) => x.perf?.code === 'overdue');
      return {
        status: 'ok',
        data: {
          count: overdue.length,
          deliveries: overdue.map((x) => ({
            deliveryNumber: x.d.docNumber,
            expectedDate: x.d.expectedDate,
            daysOverdue: x.perf!.days,
            status: x.d.status,
          })),
        },
        provenance: ids(overdue.map((x) => x.d.docNumber)),
        empty: overdue.length === 0,
      };
    },
  },
  {
    id: 'read.payments.period_inflow',
    description: 'Cash collected (posted payments) in the period.',
    requiredPermissions: [
      { module: 'payments', action: 'view' },
      { module: 'payments', action: 'view_financial' },
    ],
    delegatesTo: 'listPayments() (posted, in period)',
    resultShape: '{ period, totalCents, count }',
    run(ctx, params) {
      const period =
        params.from && params.to ? { from: params.from, to: params.to } : weekRange();
      const posted = listPayments(ctx).filter(
        (p) => p.status === 'posted' && inRange(p.date, period.from, period.to),
      );
      return {
        status: 'ok',
        data: {
          period,
          totalCents: posted.reduce((s, p) => s + p.amountCents, 0),
          count: posted.length,
        },
        provenance: ids(posted.map((p) => p.docNumber)),
        empty: posted.length === 0,
      };
    },
  },
  {
    id: 'read.parties.customer_360',
    description: 'One customer: profile, credit balance (masked without view_financial), recent invoices.',
    requiredPermissions: [{ module: 'parties', action: 'view' }],
    financialModule: 'parties',
    delegatesTo: 'getParty() + creditOverview({ customerId })',
    resultShape: '{ customer: { name, phone, kind, creditLimitCents?, balanceCents? }, recentInvoices[] }',
    run(ctx, params) {
      if (!params.customerId) {
        return {
          status: 'insufficient',
          reason: 'Specify which customer.',
          provenance: [],
        };
      }
      // getParty is tenant-scoped: a customerId from another tenant throws
      // notFound here, so cross-tenant lookups can never leak data.
      const party = getParty(ctx, params.customerId);
      const showMoney = canViewFinancial(ctx, 'parties');
      const credit = creditOverview(ctx, { customerId: params.customerId });
      const invoices = credit.rows.slice(0, params.limit ?? 10);
      return {
        status: 'ok',
        data: {
          customer: {
            name: party.name,
            phone: party.phone,
            kind: party.kind,
            creditLimitCents: showMoney ? party.creditLimitCents : null,
            balanceCents: showMoney ? credit.outstandingCents : null,
          },
          recentInvoices: invoices.map((r) => ({
            invoiceNumber: r.invoiceNumber,
            date: r.saleDate,
            totalCents: showMoney ? r.totalCents : null,
            remainingCents: showMoney ? r.remainingCents : null,
            status: r.status,
          })),
        },
        provenance: ids(invoices.map((r) => r.invoiceNumber)),
        empty: false,
      };
    },
  },
  {
    id: 'read.audit.recent_activity',
    description: 'Recent operational activity ("what happened / who changed what").',
    requiredPermissions: [{ module: 'audit', action: 'view' }],
    delegatesTo: 'listAudit()',
    resultShape: '{ count, events: [{ id, action, module, reference, summary, user, time }] }',
    run(ctx, params) {
      const res = listAudit(ctx, {
        from: params.from,
        to: params.to,
        scope: 'operational',
        limit: params.limit ?? 50,
      });
      return {
        status: 'ok',
        data: {
          count: res.rows.length,
          events: res.rows.map((e) => ({
            id: e.id,
            action: e.action,
            module: e.module,
            reference: e.reference,
            summary: e.summary,
            user: e.userId,
            time: e.createdAt,
          })),
        },
        provenance: ids(res.rows.map((e) => e.id)),
        empty: res.rows.length === 0,
      };
    },
  },
];

const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]));

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve an intent to a grounded, permission-checked answer.
 *
 * Order of operations is a hard invariant:
 *   1. authenticate (ctx.user must exist),
 *   2. check EVERY required permission (fail-closed) BEFORE any data access,
 *   3. only then call the delegated read service, which is itself tenant-scoped.
 *
 * `tenantId` is taken from `ctx` only. Any `tenantId` inside `params` is ignored
 * by construction — IntentParams has no such field.
 */
export function answerIntent(ctx: Ctx, intentId: string, params: IntentParams = {}): AiAnswer {
  const intent = INTENT_BY_ID.get(intentId);
  if (!intent) notFound('intent_unknown', `Unknown intent '${intentId}'`);

  // (1) authentication
  if (!ctx.user) forbidden('unauthenticated', 'Sign in required');

  // (2) fail-closed permission checks — before ANY data is read
  for (const p of intent.requiredPermissions) requirePermission(ctx, p.module, p.action);
  if (intent.anyOfPermissions && intent.anyOfPermissions.length > 0) {
    const ok = intent.anyOfPermissions.some((p) =>
      hasPermission(ctx.user!.permissions, p.module, p.action),
    );
    if (!ok) {
      forbidden(
        'forbidden',
        `Missing any of ${intent.anyOfPermissions.map((p) => `${p.module}.${p.action}`).join(' | ')}`,
      );
    }
  }

  const financialMasked = intent.financialModule
    ? !canViewFinancial(ctx, intent.financialModule)
    : false;

  // (3) delegate to the existing, tenant-scoped read service
  const res = intent.run(ctx, params);

  return {
    intentId: intent.id,
    status: res.status,
    data: res.data,
    provenance: res.provenance ?? [],
    empty: res.empty ?? false,
    reason: res.reason,
    financialMasked,
    tenantId: ctx.tenantId,
  };
}

/** Catalog metadata (no ctx) — for docs, UI palettes, and route wiring. */
export function listIntentCatalog(): Array<
  Pick<
    IntentDef,
    'id' | 'description' | 'requiredPermissions' | 'anyOfPermissions' | 'delegatesTo' | 'resultShape'
  >
> {
  return INTENTS.map((i) => ({
    id: i.id,
    description: i.description,
    requiredPermissions: i.requiredPermissions,
    anyOfPermissions: i.anyOfPermissions,
    delegatesTo: i.delegatesTo,
    resultShape: i.resultShape,
  }));
}

/** The intents THIS user is permitted to run (permission-aware command palette). */
export function availableIntents(ctx: Ctx): string[] {
  if (!ctx.user) return [];
  const matrix = ctx.user.permissions;
  return INTENTS.filter((i) => {
    const allHeld = i.requiredPermissions.every((p) => hasPermission(matrix, p.module, p.action));
    const anyHeld =
      !i.anyOfPermissions ||
      i.anyOfPermissions.length === 0 ||
      i.anyOfPermissions.some((p) => hasPermission(matrix, p.module, p.action));
    return allHeld && anyHeld;
  }).map((i) => i.id);
}

// ---------------------------------------------------------------------------
// Optional local NL → intent matcher (deterministic, keyword/rule based).
// NO network, NO external LLM. Ambiguous input returns `clarify`; unknown
// input returns `unsupported`; a suspected instruction-override / SQL / secret
// request is refused up front. This never GUESSES an intent.
// ---------------------------------------------------------------------------

export type MatchResult =
  | { kind: 'match'; intentId: string; params: IntentParams }
  | { kind: 'clarify'; message: string; candidates: string[] }
  | { kind: 'unsupported'; message: string };

interface MatchRule {
  intentId: string;
  any: string[]; // matches if the utterance contains ANY of these
  all?: string[]; // ...and ALL of these, when present
}

const MATCH_RULES: readonly MatchRule[] = [
  { intentId: 'read.owner.briefing', any: ['brief me', 'how is the factory', "how's the factory", 'factory doing'] },
  { intentId: 'read.credit.top_debtors', any: ['who owes', 'owes us', 'owes me', 'top debtor', 'biggest debtor'] },
  { intentId: 'read.credit.overdue_invoices', any: ['overdue invoice', 'overdue receivable', 'invoices are overdue'] },
  { intentId: 'read.sales.today_total', any: ['sales today', 'sold today', 'sell today', "today's sales", 'sales for today'] },
  { intentId: 'read.reports.monthly_pack', any: ['monthly report', 'month report', 'monthly pack', 'prepare the monthly'] },
  { intentId: 'read.inventory.raw_stock', any: ['raw stock', 'raw salt', 'raw material', 'how much raw'] },
  { intentId: 'read.inventory.finished_stock', any: ['finished stock', 'finished salt', 'finished goods', 'finished inventory'] },
  { intentId: 'read.inventory.lot_history', any: ['lot history', 'movements for lot', 'stock movements', 'trace lot'] },
  { intentId: 'read.production.output_today', any: ['produce today', 'production today', 'output today', 'produced today'] },
  { intentId: 'read.production.loss_explain', any: ['why did production', 'production fall', 'production drop', 'why is loss', 'explain the loss'] },
  { intentId: 'read.quality.awaiting_release', any: ['awaiting release', 'awaiting qc', 'waiting for qc', 'waiting for release', 'awaiting my release'] },
  { intentId: 'read.quality.failures_period', any: ['quality failures', 'qc failures', 'failed qc', 'failures this'] },
  { intentId: 'read.delivery.overdue', any: ['deliveries late', 'late deliveries', 'overdue deliver', 'deliveries running late'] },
  { intentId: 'read.payments.period_inflow', any: ['cash came in', 'cash collected', 'cash in this', 'collected this', 'money came in', 'payments this week'] },
  { intentId: 'read.parties.customer_360', any: ['about customer', 'everything about', 'customer profile', 'customer 360'] },
  { intentId: 'read.audit.recent_activity', any: ['what happened', 'who logged in', 'recent activity', 'who changed', 'audit trail'] },
];

const REFUSAL_MARKERS: readonly string[] = [
  'raw sql',
  'select *',
  'developer mode',
  'other tenant',
  'other factory',
  "everyone's password",
  'all passwords',
  'drop table',
];

/**
 * Best-effort local mapping of an English utterance to ONE intent id.
 * Deterministic and permission-agnostic (answerIntent still enforces RBAC).
 */
export function matchIntent(utterance: string): MatchResult {
  const text = utterance.toLowerCase().trim();
  if (!text) {
    return { kind: 'clarify', message: 'Please ask a question.', candidates: [] };
  }
  // Up-front refusal of instruction-override / SQL / secret-exfil attempts.
  if (
    REFUSAL_MARKERS.some((m) => text.includes(m)) ||
    (text.includes('ignore') && text.includes('rule'))
  ) {
    return {
      kind: 'unsupported',
      message:
        'I can only answer using approved, permission-checked reads of this tenant\'s data. I can\'t run raw queries, reveal secrets, or override my rules.',
    };
  }
  const matched = MATCH_RULES.filter(
    (r) =>
      r.any.some((k) => text.includes(k)) && (!r.all || r.all.every((k) => text.includes(k))),
  );
  const uniqueIds = [...new Set(matched.map((m) => m.intentId))];
  if (uniqueIds.length === 0) {
    return {
      kind: 'unsupported',
      message: 'I don\'t have a read-only report for that yet.',
    };
  }
  if (uniqueIds.length > 1) {
    return {
      kind: 'clarify',
      message: 'That could mean a few things — which did you want?',
      candidates: uniqueIds,
    };
  }
  return { kind: 'match', intentId: uniqueIds[0], params: {} };
}
