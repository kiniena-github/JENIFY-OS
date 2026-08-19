import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api, ApiError } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, DeliveryPerfBadge } from '../components/ui.js';
import { useItems } from '../lib/queries.js';
import * as fmt from '../lib/format.js';

type Preset = 'today' | 'week' | 'month' | 'custom';

interface Card {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: 'danger' | 'success';
}
interface Column {
  key: string;
  label: string;
  render: (row: Record<string, unknown>) => React.ReactNode;
  num?: boolean;
}
interface ReportDef {
  id: string;
  endpoint: string;
  titleKey: string;
  title: string;
  descKey: string;
  desc: string;
  financial?: boolean;
  /** credit report: Open / Settled / All row scope */
  scopeFilter?: boolean;
  /** contextual empty-state wording */
  emptyText?: (t: (k: string, f?: string) => string, scope?: string) => string;
  /** custom flattening when the payload is not a flat `breakdown` array */
  rows?: (d: Record<string, unknown>) => Record<string, unknown>[];
  tableTitle?: (t: (k: string, f?: string) => string, scope?: string) => string;
  cards: (d: Record<string, unknown>, t: (k: string, f?: string) => string, currency: string) => Card[];
  columns: (t: (k: string, f?: string) => string, currency: string) => Column[];
}

const q = (v: unknown) => fmt.qty(v as number);
const qs = (v: unknown) => fmt.qtySmart(v as number);
const m = (v: unknown, c: string) => fmt.money(v as number | null, c);
const pct = (v: unknown) => (v == null ? '—' : `${(v as number).toFixed(1)}%`);
const status = (v: unknown) => <StatusBadge status={String(v ?? '')} />;

/**
 * Consistent result display: a bare numeric reading inherits the unit of the
 * configured target (e.g. target "30-40 ppm" turns "34" into "34 ppm").
 */
function normalizeResult(actual: unknown, target: unknown): string {
  const a = actual == null ? '' : String(actual).trim();
  if (!a) return '—';
  if (!/^\d+(\.\d+)?$/.test(a)) return a;
  const unit = typeof target === 'string' ? (target.match(/[a-zA-Z%]+\s*$/)?.[0]?.trim() ?? '') : '';
  return unit ? `${a} ${unit}` : a;
}

function reportDefs(): ReportDef[] {
  return [
    {
      id: 'raw-stock',
      endpoint: 'raw-stock',
      titleKey: 'reports.raw',
      title: 'Raw Material Report',
      descKey: 'reports.raw_desc',
      desc: 'Received, used, remaining, batch and warehouse.',
      cards: (d, t) => [
        { label: t('reports.received', 'Received'), value: qs(d.receivedQty) },
        { label: t('reports.used', 'Used'), value: qs(d.usedQty) },
        { label: t('reports.remaining', 'Remaining'), value: qs(d.remainingQty) },
        { label: t('inventory.reserved', 'Reserved'), value: qs(d.reservedQty) },
      ],
      // one batch = one original quantity; warehouse locations nest below so a
      // transferred batch can never read as if it was received twice
      rows: (d) =>
        ((d.batches ?? []) as Array<Record<string, unknown>>).flatMap((b) =>
          ((b.locations ?? []) as Array<Record<string, unknown>>).map((loc, i) => ({
            lotNumber: i === 0 ? b.lotNumber : '',
            source: i === 0 ? b.source : '',
            receivedAt: i === 0 ? b.receivedAt : null,
            originalQty: i === 0 ? b.originalQty : null,
            warehouseCode: loc.warehouseCode,
            usedQty: loc.usedQty,
            remainingQty: loc.remainingQty,
            status: loc.status,
          })),
        ),
      columns: (t) => [
        { key: 'lotNumber', label: t('inventory.batch', 'Batch'), render: (r) => <span className="mono">{String(r.lotNumber ?? '')}</span> },
        { key: 'source', label: t('inventory.source', 'Source'), render: (r) => String(r.source ?? '') },
        { key: 'receivedAt', label: t('inventory.received', 'Received'), render: (r) => (r.receivedAt ? fmt.date(r.receivedAt as string) : '') },
        { key: 'originalQty', label: `${t('report.original_qty', 'Original batch quantity')} (kg)`, render: (r) => (r.originalQty == null ? '' : q(r.originalQty)), num: true },
        { key: 'warehouseCode', label: t('inventory.warehouse', 'Warehouse'), render: (r) => String(r.warehouseCode ?? '') },
        { key: 'usedQty', label: `${t('reports.used', 'Used')} (kg)`, render: (r) => q(r.usedQty), num: true },
        { key: 'remainingQty', label: `${t('reports.remaining', 'Remaining')} (kg)`, render: (r) => q(r.remainingQty), num: true },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
    {
      id: 'production',
      endpoint: 'production',
      titleKey: 'reports.production',
      title: 'Production Report',
      descKey: 'reports.production_desc',
      desc: 'Input used, output, loss and efficiency.',
      // per-stage KPIs only — adding consecutive stages together would count
      // the same physical material once per stage
      cards: (d, t) => {
        const per = (d.perStage ?? []) as Array<{
          stageCode: string;
          nameKey: string;
          outputPolicy: string;
          inputQty: number;
          outputQty: number;
          lossQty: number | null;
          efficiencyPct: number | null;
        }>;
        const cards: Card[] = [{ label: t('report.raw_input', 'Raw input'), value: qs(d.rawInputQty) }];
        for (const st of per) {
          cards.push({
            label: `${t(st.nameKey, st.stageCode)} — ${t('production.output', 'Output')}`,
            value: qs(st.outputQty),
            sub:
              st.outputPolicy === 'measured'
                ? `${t('production.loss', 'Loss')} ${qs(st.lossQty ?? 0)} · ${pct(st.efficiencyPct)}`
                : st.outputPolicy === 'conserved'
                  ? t('production.conserved', 'Conserved')
                  : undefined,
          });
        }
        return cards;
      },
      columns: (t) => [
        { key: 'batchNumber', label: t('inventory.batch', 'Batch'), render: (r) => <span className="mono">{String(r.batchNumber)}</span> },
        { key: 'stage', label: t('reports.stage', 'Stage'), render: (r) => String(r.stage) },
        { key: 'sourceRef', label: t('production.source_batch', 'Source'), render: (r) => <span className="mono">{String(r.sourceRef)}</span> },
        { key: 'date', label: t('shell.date', 'Date'), render: (r) => fmt.date(r.date as string) },
        { key: 'inputQty', label: t('production.input', 'Input'), render: (r) => q(r.inputQty), num: true },
        { key: 'outputQty', label: t('production.output', 'Output'), render: (r) => q(r.outputQty), num: true },
        { key: 'lossQty', label: t('production.loss', 'Loss'), render: (r) => q(r.lossQty), num: true },
        { key: 'efficiencyPct', label: t('production.efficiency', 'Efficiency'), render: (r) => pct(r.efficiencyPct), num: true },
      ],
    },
    {
      id: 'quality',
      endpoint: 'quality',
      titleKey: 'reports.quality',
      title: 'Quality / Treatment Report',
      descKey: 'reports.quality_desc',
      desc: 'Additive use, results, pass, fail and retest.',
      // final state and HISTORY are separate: a released batch that once
      // failed still counts in retested/failed-attempt metrics
      cards: (d, t) => {
        const attrs = (d.attributeTotals ?? {}) as Record<string, number>;
        return [
          { label: t('report.q_released', 'Released batches'), value: String(d.releasedCount), tone: 'success' as const },
          { label: t('report.q_failed_now', 'Currently failed'), value: String(d.currentlyFailedCount), tone: (d.currentlyFailedCount as number) > 0 ? ('danger' as const) : undefined },
          { label: t('report.q_retested', 'Retested batches'), value: String(d.retestedBatchCount) },
          { label: t('report.q_attempts', 'Total test attempts'), value: String(d.totalAttempts), sub: `${d.failedAttempts} ${t('report.q_failed_attempts', 'Failed attempts').toLowerCase()}` },
          ...Object.entries(attrs).map(([k, v]) => ({
            label: t(`production.attr.${k}`, k),
            value: v.toLocaleString('en-US', { maximumFractionDigits: 2 }),
          })),
        ];
      },
      columns: (t) => [
        { key: 'batchNumber', label: t('inventory.batch', 'Batch'), render: (r) => <span className="mono">{String(r.batchNumber)}</span> },
        { key: 'sourceRef', label: t('production.source_batch', 'Source'), render: (r) => <span className="mono">{String(r.sourceRef)}</span> },
        { key: 'date', label: t('shell.date', 'Date'), render: (r) => fmt.date(r.date as string) },
        { key: 'inputQty', label: t('production.input', 'Input'), render: (r) => q(r.inputQty), num: true },
        { key: 'actualResult', label: t('production.actual', 'Actual result'), render: (r) => normalizeResult(r.actualResult, r.targetLevel) },
        { key: 'attempts', label: t('reports.attempts', 'Attempts'), render: (r) => String(r.attempts), num: true },
        // QC RESULT (latest test outcome) and RELEASE (formal business action)
        // are different concepts and are shown separately
        { key: 'qcResult', label: t('report.qc_result', 'QC result'), render: (r) => status(r.qcResult) },
        { key: 'releaseStatus', label: t('report.release_status', 'Release status'), render: (r) => status(r.releaseStatus) },
      ],
    },
    {
      id: 'packaging',
      endpoint: 'packaging',
      titleKey: 'reports.packaging',
      title: 'Packaging Report',
      descKey: 'reports.packaging_desc',
      desc: 'Output and rejected packs by product size.',
      cards: (d, t) => {
        const per = (d.perItem ?? []) as Array<{ itemName: string; good: number; weight: number }>;
        return [
          ...per.map((x) => ({
            label: `${x.itemName} — ${t('report.good_units', 'Good units produced')}`,
            value: `${q(x.good)} ${t('report.packs', 'packs')}`,
            sub: qs(x.weight),
          })),
          { label: t('reports.rejected', 'Rejected'), value: `${q(d.totalRejected)} ${t('report.packs', 'packs')}`, tone: 'danger' as const },
        ];
      },
      columns: (t) => [
        { key: 'batchNumber', label: t('inventory.batch', 'Batch'), render: (r) => <span className="mono">{String(r.batchNumber)}</span> },
        { key: 'sourceRef', label: t('production.source_batch', 'Source'), render: (r) => <span className="mono">{String(r.sourceRef)}</span> },
        { key: 'inputQty', label: `${t('report.input_received', 'Input received')} (kg)`, render: (r) => q(r.inputQty), num: true },
        { key: 'itemName', label: t('inventory.product', 'Product'), render: (r) => String(r.itemName) },
        { key: 'unitsProduced', label: t('production.units_produced', 'Produced'), render: (r) => q(r.unitsProduced), num: true },
        { key: 'unitsRejected', label: t('production.units_rejected', 'Rejected'), render: (r) => q(r.unitsRejected), num: true },
        { key: 'goodUnits', label: t('production.good_units', 'Good units'), render: (r) => q(r.goodUnits), num: true },
        { key: 'goodWeight', label: t('reports.good_weight', 'Good weight'), render: (r) => qs(r.goodWeight), num: true },
        { key: 'warehouseName', label: t('report.dest_warehouse', 'Destination warehouse'), render: (r) => String(r.warehouseName ?? '—') },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
    {
      id: 'finished-inventory',
      endpoint: 'finished-inventory',
      titleKey: 'reports.finished',
      title: 'Finished Inventory Report',
      descKey: 'reports.finished_desc',
      desc: 'Available, reserved, sold and warehouse.',
      cards: (d, t) => [
        { label: t('inventory.fin_available', 'Available weight'), value: qs(d.availableWeight) },
        { label: t('inventory.available', 'Available'), value: q(d.availableUnits), sub: 'units' },
        { label: t('inventory.reserved', 'Reserved'), value: q(d.reservedUnits), sub: 'units' },
        { label: t('reports.sold', 'Sold'), value: q(d.soldUnits), sub: 'units' },
      ],
      columns: (t) => [
        { key: 'itemName', label: t('inventory.product', 'Product'), render: (r) => String(r.itemName) },
        { key: 'lotNumber', label: t('inventory.batch', 'Batch'), render: (r) => <span className="mono">{String(r.lotNumber ?? '—')}</span> },
        { key: 'warehouseCode', label: t('inventory.warehouse', 'Warehouse'), render: (r) => String(r.warehouseCode) },
        { key: 'available', label: t('inventory.available', 'Available'), render: (r) => q(r.available), num: true },
        { key: 'reserved', label: t('inventory.reserved', 'Reserved'), render: (r) => q(r.reserved), num: true },
        { key: 'sold', label: t('reports.sold', 'Sold'), render: (r) => q(r.sold), num: true },
        { key: 'weight', label: t('inventory.weight', 'Total weight'), render: (r) => qs(r.weight), num: true },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
    {
      id: 'sales',
      endpoint: 'sales',
      titleKey: 'reports.sales',
      title: 'Sales Report',
      descKey: 'reports.sales_desc',
      desc: 'By date, product, customer, discount and VAT.',
      financial: true,
      cards: (d, t, c) => [
        { label: t('reports.sales_total', 'Sales'), value: m(d.totalCents, c), sub: `${d.invoiceCount} ${t('dashboard.invoices', 'invoices')}` },
        { label: t('sales.discount', 'Discount'), value: m(d.discountCents, c) },
        { label: t('sales.vat', 'VAT'), value: m(d.vatCents, c) },
        { label: t('sales.paid', 'Paid'), value: m(d.paidCents, c), tone: 'success' },
      ],
      columns: (t, c) => [
        { key: 'invoiceNumber', label: t('sales.invoice', 'Invoice'), render: (r) => <span className="mono">{String(r.invoiceNumber)}</span> },
        { key: 'date', label: t('shell.date', 'Date'), render: (r) => fmt.date(r.date as string) },
        { key: 'customerName', label: t('sales.customer', 'Customer'), render: (r) => String(r.customerName) },
        { key: 'products', label: t('inventory.product', 'Product'), render: (r) => String(r.products) },
        { key: 'subtotalCents', label: t('sales.subtotal', 'Subtotal'), render: (r) => m(r.subtotalCents, c), num: true },
        { key: 'discountCents', label: t('sales.discount', 'Discount'), render: (r) => m(r.discountCents, c), num: true },
        { key: 'vatCents', label: t('sales.vat', 'VAT'), render: (r) => m(r.vatCents, c), num: true },
        { key: 'totalCents', label: t('sales.total', 'Total'), render: (r) => m(r.totalCents, c), num: true },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
    {
      id: 'credit',
      endpoint: 'credit',
      titleKey: 'reports.credit',
      title: 'Credit Report',
      descKey: 'reports.credit_desc',
      desc: 'Balances, overdue, due this week and history.',
      financial: true,
      scopeFilter: true,
      emptyText: (t, scope) =>
        scope === 'settled'
          ? t('reports.empty_settled', 'No settled invoices in this period.')
          : scope === 'all'
            ? t('reports.empty_generic', 'No transactions match this period.')
            : t('reports.empty_credit', 'No open credit balances.'),
      rows: (d) => (d.rows ?? []) as Record<string, unknown>[],
      tableTitle: (t, scope) =>
        scope === 'settled'
          ? t('report.scope_settled', 'Settled')
          : scope === 'all'
            ? t('report.scope_all', 'All')
            : t('report.credit_open', 'Open credit balances'),
      cards: (d, t, c) => [
        { label: t('credit.outstanding', 'Outstanding'), value: m(d.outstandingCents, c) },
        { label: t('credit.overdue', 'Overdue'), value: m(d.overdueCents, c), tone: (d.overdueCents as number) > 0 ? 'danger' : undefined },
        { label: t('credit.due_week', 'Due this week'), value: m(d.dueThisWeekCents, c) },
        { label: t('reports.collected', 'Collected'), value: m(d.collectedCents, c), tone: 'success' },
      ],
      columns: (t, c) => [
        { key: 'customerName', label: t('sales.customer', 'Customer'), render: (r) => String(r.customerName) },
        { key: 'invoiceNumber', label: t('sales.invoice', 'Invoice'), render: (r) => <span className="mono">{String(r.invoiceNumber)}</span> },
        { key: 'totalCents', label: t('sales.total', 'Total'), render: (r) => m(r.totalCents, c), num: true },
        { key: 'paidCents', label: t('sales.paid', 'Paid'), render: (r) => m(r.paidCents, c), num: true },
        { key: 'remainingCents', label: t('credit.remaining', 'Remaining'), render: (r) => m(r.remainingCents, c), num: true },
        { key: 'dueDate', label: t('credit.due_date', 'Due'), render: (r) => fmt.date(r.dueDate as string) },
        { key: 'lastPaymentDate', label: t('credit.last_payment', 'Last payment'), render: (r) => fmt.date(r.lastPaymentDate as string) },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
    {
      id: 'delivery',
      endpoint: 'delivery',
      titleKey: 'reports.delivery',
      title: 'Delivery Report',
      descKey: 'reports.delivery_desc',
      desc: 'Pending, dispatched, delivered, destination and truck.',
      cards: (d, t) => [
        { label: t('status.pending', 'Pending'), value: String(d.pending), sub: `${d.loading} ${t('status.loading', 'Loading').toLowerCase()}` },
        { label: t('status.dispatched', 'Dispatched'), value: String(d.dispatched) },
        { label: t('status.delivered', 'Delivered'), value: String(d.delivered), tone: 'success' },
        { label: t('status.cancelled', 'Cancelled'), value: String(d.cancelled) },
      ],
      columns: (t) => [
        { key: 'deliveryNumber', label: t('delivery.number', 'Delivery'), render: (r) => <span className="mono">{String(r.deliveryNumber)}</span> },
        { key: 'invoiceNumber', label: t('sales.invoice', 'Invoice'), render: (r) => <span className="mono">{String(r.invoiceNumber)}</span> },
        { key: 'customerName', label: t('sales.customer', 'Customer'), render: (r) => String(r.customerName) },
        { key: 'destination', label: t('delivery.destination', 'Destination'), render: (r) => String(r.destination ?? '—') },
        { key: 'truckNumber', label: t('delivery.truck', 'Truck'), render: (r) => String(r.truckNumber ?? '—') },
        { key: 'driverName', label: t('delivery.driver', 'Driver'), render: (r) => String(r.driverName ?? '—') },
        { key: 'expectedDate', label: t('delivery.expected', 'Expected'), render: (r) => fmt.date(r.expectedDate as string) },
        { key: 'actualDate', label: t('delivery.actual', 'Actual'), render: (r) => fmt.date(r.actualDate as string) },
        {
          key: 'performance',
          label: t('delivery.performance', 'Performance'),
          render: (r) => (
            <DeliveryPerfBadge
              expectedDate={r.expectedDate as string | null}
              actualDate={r.actualDate as string | null}
              status={String(r.status)}
            />
          ),
        },
        { key: 'status', label: t('shell.status', 'Status'), render: (r) => status(r.status) },
      ],
    },
  ];
}

function periodRange(preset: Preset, from: string, to: string): { from?: string; to?: string } {
  const today = fmt.todayIso();
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: from || undefined, to: to || undefined };
}

export default function ReportsPage() {
  const { t, can } = useAuth();
  usePageTitle(t('nav.reports', 'Reports'), t('reports.subtitle', 'Operational and financial reporting hub'));
  const items = useItems();
  const [active, setActive] = useState<string | null>(null);
  const defs = useMemo(() => {
    const base = reportDefs();
    // simple-item screens (e.g. empty sacks) get their own report card
    return base;
  }, []);

  const uiConfig = useQuery({
    queryKey: ['ui-config'],
    queryFn: () => api.get<{ simpleItemScreens: Array<{ itemId: string; labelKey: string }> }>('/api/ui-config'),
  });

  const simpleDefs: ReportDef[] = (uiConfig.data?.simpleItemScreens ?? []).map((cfg) => ({
    id: `simple-${cfg.itemId}`,
    endpoint: `simple-item&itemId=${cfg.itemId}`,
    titleKey: cfg.labelKey,
    title: items.data?.find((i) => i.id === cfg.itemId)?.name ?? 'Side Item Report',
    descKey: 'reports.simple_desc',
    desc: 'Collected, available, sold and remaining pieces.',
    cards: (d, tt, c) => [
      { label: tt('reports.collected_pcs', 'Collected'), value: q(d.collectedQty) },
      { label: tt('reports.sold', 'Sold'), value: q(d.soldQty) },
      { label: tt('reports.remaining', 'Remaining'), value: q(d.remainingQty) },
      { label: tt('reports.proceeds', 'Proceeds'), value: m(d.proceedsCents, c), tone: 'success' },
    ],
    columns: (tt, c) => [
      { key: 'docNumber', label: tt('inventory.document', 'Document'), render: (r) => <span className="mono">{String(r.docNumber)}</span> },
      { key: 'date', label: tt('shell.date', 'Date'), render: (r) => fmt.date(r.date as string) },
      {
        key: 'type',
        label: tt('inventory.type', 'Type'),
        render: (r) =>
          r.type === 'collect' ? tt('sacks.collected', 'Collected') : tt('sacks.sold', 'Sold'),
      },
      { key: 'qty', label: tt('inventory.qty', 'Quantity'), render: (r) => q(r.qty), num: true },
      { key: 'buyer', label: tt('reports.buyer', 'Buyer'), render: (r) => String(r.buyer ?? '—') },
      { key: 'unitPriceCents', label: tt('reports.price', 'Price'), render: (r) => m(r.unitPriceCents, c), num: true },
      { key: 'totalCents', label: tt('sacks.total', 'Total amount'), render: (r) => m(r.totalCents, c), num: true },
      { key: 'status', label: tt('shell.status', 'Status'), render: (r) => status(r.status) },
    ],
  }));

  const allDefs = [...defs, ...simpleDefs];
  const canFinancial = can('reports', 'view_financial');
  const visible = allDefs.filter((d) => !d.financial || canFinancial);
  const current = visible.find((d) => d.id === active);

  if (current) {
    return <ReportView def={current} onBack={() => setActive(null)} />;
  }

  return (
    <div>
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {visible.map((d) => (
          <div key={d.id} className="card accent" style={{ cursor: 'pointer' }} onClick={() => setActive(d.id)}>
            <div className="card-label">{t(d.titleKey, d.title)}</div>
            <div className="card-sub">{t(d.descKey, d.desc)}</div>
            <div className="mt">
              <span className="btn btn-ghost btn-sm">{t('reports.open', 'Open report')} →</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportView({ def, onBack }: { def: ReportDef; onBack: () => void }) {
  const { t, tenant } = useAuth();
  const currency = tenant?.currency ?? 'ETB';
  const [preset, setPreset] = useState<Preset>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scope, setScope] = useState<'open' | 'settled' | 'all'>('open');
  const range = periodRange(preset, from, to);
  const scopePart = def.scopeFilter ? `scope=${scope}&` : '';
  const query = `?${scopePart}${range.from ? `from=${range.from}&` : ''}${range.to ? `to=${range.to}` : ''}`;
  const url = def.endpoint.includes('&')
    ? `/api/reports/${def.endpoint.split('&')[0]}${query}&${def.endpoint.split('&').slice(1).join('&')}`
    : `/api/reports/${def.endpoint}${query}`;
  const { data, error } = useQuery({
    queryKey: ['report', def.id, query],
    queryFn: () => api.get<Record<string, unknown>>(url),
  });

  const columns = def.columns(t, currency);
  const rows: Record<string, unknown>[] = data
    ? def.rows
      ? def.rows(data)
      : ((data.breakdown ?? []) as Record<string, unknown>[])
    : [];

  function exportCsv() {
    const header = columns.map((c) => c.label).join(',');
    const csvRows = rows.map((r) =>
      columns
        .map((c) => {
          const v = r[c.key];
          const s = v == null ? '' : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(','),
    );
    const blob = new Blob(['﻿' + [header, ...csvRows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${def.id}-${range.from ?? 'all'}-${range.to ?? 'all'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="flex no-print" style={{ marginBottom: 14 }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          ← {t('reports.back', 'All reports')}
        </button>
        <h2 style={{ fontSize: 15 }}>{t(def.titleKey, def.title)}</h2>
        <div className="spacer" />
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
          <option value="today">{t('reports.today', 'Today')}</option>
          <option value="week">{t('reports.week', 'Last 7 days')}</option>
          <option value="month">{t('reports.month', 'This month')}</option>
          <option value="custom">{t('reports.custom', 'Custom dates')}</option>
        </select>
        {preset === 'custom' ? (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        ) : null}
        {def.scopeFilter ? (
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="open">{t('report.scope_open', 'Open')}</option>
            <option value="settled">{t('report.scope_settled', 'Settled')}</option>
            <option value="all">{t('report.scope_all', 'All')}</option>
          </select>
        ) : null}
        <button className="btn btn-secondary btn-sm" onClick={exportCsv} disabled={!rows.length}>
          {t('shell.export', 'Export')} CSV
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => window.print()}>
          {t('shell.print', 'Print')}
        </button>
      </div>

      {error instanceof ApiError && error.status === 403 ? (
        <div className="page-error">{t('reports.forbidden', 'This report requires financial visibility permission.')}</div>
      ) : null}

      {data ? (
        <>
          <div className="cards">
            {def.cards(data, t, currency).map((c, i) => (
              <StatCard key={i} label={c.label} value={c.value} sub={c.sub} tone={c.tone} />
            ))}
          </div>
          <div className="panel">
            <div className="panel-head">
              <h2>{def.tableTitle ? def.tableTitle(t, scope) : t('reports.breakdown', 'Breakdown')}</h2>
              <div className="spacer" />
              <span className="muted">
                {range.from ?? '…'} → {range.to ?? '…'} · {t('reports.approved_only', 'Approved records only')}
              </span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.key} className={c.num ? 'num' : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <td key={c.key} className={c.num ? 'num' : undefined}>
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className="table-empty">
                        {def.emptyText
                          ? def.emptyText(t, scope)
                          : t('reports.empty_generic', 'No transactions match this period.')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="centered-page">Loading…</div>
      )}
    </div>
  );
}
