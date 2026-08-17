import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge } from '../components/ui.js';
import { useCredit, usePayments } from '../lib/queries.js';
import * as fmt from '../lib/format.js';

export default function CreditPage() {
  const { t, can, tenant } = useAuth();
  usePageTitle(t('nav.credit', 'Credit'), t('credit.subtitle', 'Track active, partial, paid, and overdue invoice balances'));
  const navigate = useNavigate();
  const credit = useCredit();
  const canFinancial = can('credit', 'view_financial');
  const payments = usePayments();
  const currency = tenant?.currency ?? 'ETB';
  const [statusFilter, setStatusFilter] = useState('');

  const rows = (credit.data?.rows ?? []).filter((r) => !statusFilter || r.status === statusFilter);
  const month = fmt.todayIso().slice(0, 7);
  const collectedThisMonth = canFinancial
    ? (payments.data ?? [])
        .filter((p) => p.status === 'posted' && p.date.startsWith(month))
        .reduce((s, p) => s + p.amountCents, 0)
    : null;

  return (
    <div>
      <div className="cards">
        <StatCard label={t('credit.outstanding', 'Outstanding')} value={fmt.money(credit.data?.outstandingCents ?? null, currency)} />
        <StatCard
          label={t('credit.overdue', 'Overdue')}
          value={fmt.money(credit.data?.overdueCents ?? null, currency)}
          tone={(credit.data?.overdueCents ?? 0) > 0 ? 'danger' : undefined}
        />
        <StatCard label={t('credit.due_week', 'Due this week')} value={fmt.money(credit.data?.dueThisWeekCents ?? null, currency)} />
        {canFinancial ? (
          <StatCard label={t('credit.collected', 'Paid this month')} value={fmt.money(collectedThisMonth, currency)} tone="success" />
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="filters">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('credit.all_statuses', 'All credit statuses')}</option>
              <option value="active">{t('status.active', 'Active')}</option>
              <option value="partial">{t('status.partial', 'Partially Paid')}</option>
              <option value="paid">{t('status.paid', 'Paid')}</option>
              <option value="overdue">{t('status.overdue', 'Overdue')}</option>
            </select>
          </div>
          <div className="spacer" />
          {can('payments', 'create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/payments')}>
              {t('credit.record_payment', 'Record payment')}
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('sales.customer', 'Customer')}</th>
                <th>{t('sales.invoice', 'Invoice')}</th>
                <th>{t('credit.sale_date', 'Sale date')}</th>
                {canFinancial ? (
                  <>
                    <th className="num">{t('sales.total', 'Total')}</th>
                    <th className="num">{t('sales.paid', 'Paid')}</th>
                    <th className="num">{t('credit.remaining', 'Remaining')}</th>
                  </>
                ) : null}
                <th>{t('credit.due_date', 'Due date')}</th>
                <th>{t('credit.last_payment', 'Last payment')}</th>
                <th>{t('shell.status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invoiceId}>
                  <td>{r.customerName}</td>
                  <td className="mono">{r.invoiceNumber}</td>
                  <td>{fmt.date(r.saleDate)}</td>
                  {canFinancial ? (
                    <>
                      <td className="num">{fmt.money(r.totalCents, currency)}</td>
                      <td className="num">{fmt.money(r.paidCents, currency)}</td>
                      <td className="num">{fmt.money(r.remainingCents, currency)}</td>
                    </>
                  ) : null}
                  <td>{fmt.date(r.dueDate)}</td>
                  <td>{fmt.date(r.lastPaymentDate)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="table-empty">
                    {t('credit.none', 'No credit records.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
