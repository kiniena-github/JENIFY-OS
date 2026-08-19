import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard } from '../components/ui.js';
import * as fmt from '../lib/format.js';

interface DashboardData {
  rawStock: { totalQty: number; byWarehouse: Array<{ code: string; name: string; qty: number }> };
  production: Array<{
    stageCode: string;
    nameKey: string;
    outputPolicy: string;
    outputForm: string;
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

export default function DashboardPage() {
  const { t, tenant } = useAuth();
  usePageTitle(t('dashboard.title', 'Dashboard'), t('dashboard.subtitle', 'Live operational and financial overview'));
  const { data } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    refetchInterval: 30_000,
  });
  const currency = tenant?.currency ?? 'ETB';

  if (!data) return <div className="centered-page">Loading…</div>;

  return (
    <div>
      <div className="cards">
        <StatCard label={t('dashboard.raw_total', 'Total raw stock')} value={fmt.qtySmart(data.rawStock.totalQty)} />
        {data.rawStock.byWarehouse.map((w) => (
          <StatCard
            key={w.code}
            label={w.name}
            value={fmt.qtySmart(w.qty)}
            sub={
              data.rawStock.totalQty > 0
                ? `${((w.qty / data.rawStock.totalQty) * 100).toFixed(1)}%`
                : undefined
            }
          />
        ))}
      </div>

      <div className="cards">
        {data.production.flatMap((s) => {
          // converted (packaging) stages get EXPLICIT input vs good-output
          // cards — one ambiguous "Packaging" number hides the reject loss
          if (s.outputForm === 'packaged_items') {
            return [
              <StatCard
                key={`${s.stageCode}-in`}
                label={`${t('dashboard.packaging_input', 'Packaging input today')} — ${t(s.nameKey, s.stageCode)}`}
                value={fmt.qtyExact(s.todayInput)}
              />,
              <StatCard
                key={`${s.stageCode}-out`}
                label={`${t('dashboard.good_output', 'Good packed output today')} — ${t(s.nameKey, s.stageCode)}`}
                value={fmt.qtyExact(s.todayOutput)}
                sub={
                  s.openBatches > 0
                    ? `${s.openBatches} ${t('production.open', 'Open batches').toLowerCase()}`
                    : undefined
                }
              />,
            ];
          }
          return [
            <StatCard
              key={s.stageCode}
              label={`${t('dashboard.today', 'Today')} — ${t(s.nameKey, s.stageCode)}`}
              value={fmt.qtyExact(s.todayOutput)}
              sub={
                s.todayLoss != null && s.todayLoss > 0
                  ? `${t('production.loss', 'Loss')} ${fmt.qtySmart(s.todayLoss)}`
                  : s.outputPolicy === 'conserved'
                    ? t('production.conserved', 'Conserved')
                    : s.openBatches > 0
                      ? `${s.openBatches} ${t('production.open', 'Open batches').toLowerCase()}`
                      : undefined
              }
            />,
          ];
        })}
        {data.finished.map((f) => (
          <StatCard
            key={f.itemName}
            label={f.itemName}
            value={fmt.qty(f.units)}
            sub={f.weight != null ? fmt.qtySmart(f.weight) : undefined}
          />
        ))}
      </div>

      {data.finance ? (
        <div className="cards">
          <StatCard
            label={t('dashboard.today_sales', "Today's sales")}
            value={fmt.money(data.finance.todaySalesCents, currency)}
            sub={`${data.finance.todayInvoices} ${t('dashboard.invoices', 'invoices')}`}
          />
          <StatCard label={t('dashboard.month_sales', 'This month')} value={fmt.money(data.finance.monthSalesCents, currency)} />
          <StatCard label={t('dashboard.payments_today', 'Payments today')} value={fmt.money(data.finance.todayPaymentsCents, currency)} tone="success" />
          <StatCard
            label={t('credit.outstanding', 'Outstanding')}
            value={fmt.money(data.finance.outstandingCents, currency)}
            sub={`${data.finance.outstandingCustomers} ${t('dashboard.customers', 'customers')}`}
          />
          <StatCard
            label={t('credit.overdue', 'Overdue')}
            value={fmt.money(data.finance.overdueCents, currency)}
            sub={`${data.finance.overdueInvoices} ${t('dashboard.invoices', 'invoices')}`}
            tone={data.finance.overdueCents > 0 ? 'danger' : undefined}
          />
          <StatCard label={`${t('sales.vat', 'VAT')} (${t('dashboard.month', 'month')})`} value={fmt.money(data.finance.monthVatCents, currency)} />
        </div>
      ) : null}

      <div className="cards">
        <StatCard label={t('dashboard.deliveries_pending', 'Pending deliveries')} value={data.deliveries.pending + data.deliveries.loading} />
        <StatCard label={t('status.dispatched', 'Dispatched')} value={data.deliveries.dispatched} />
        <StatCard label={t('dashboard.delivered_today', 'Delivered today')} value={data.deliveries.deliveredToday} tone="success" />
        {data.simpleItems.map((s) => (
          <StatCard key={s.label} label={t(s.label, s.label)} value={fmt.qty(s.available)} sub={t('dashboard.available', 'available')} />
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <h2>{t('dashboard.activity', 'Recent activity')}</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('dashboard.time', 'Time')}</th>
                  <th>{t('dashboard.event', 'Activity')}</th>
                  <th>{t('dashboard.reference', 'Reference')}</th>
                </tr>
              </thead>
              <tbody>
                {data.recentActivity.map((e, i) => (
                  <tr key={i}>
                    <td>{fmt.dateTime(e.time)}</td>
                    <td>{e.summary}</td>
                    <td className="mono">{e.reference ?? '—'}</td>
                  </tr>
                ))}
                {data.recentActivity.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      {t('dashboard.no_activity', 'No activity yet.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <h2>{t('dashboard.alerts', 'Alerts')}</h2>
          </div>
          <div className="panel-body">
            {data.alerts.length === 0 ? (
              <div className="muted">{t('dashboard.no_alerts', 'No alerts — everything looks normal.')}</div>
            ) : (
              data.alerts.map((a, i) => (
                <div key={i} className={a.severity === 'error' ? 'page-error' : a.severity === 'warning' ? 'page-info' : 'page-info'}>
                  {a.message}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
