import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, Modal, ReasonDialog } from '../components/ui.js';
import { usePayments, useParties, useCredit } from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { Payment } from '../lib/types.js';

const METHODS = ['cash', 'bank_transfer', 'cheque', 'mobile_money'];

export default function PaymentsPage() {
  const { t, can, tenant } = useAuth();
  usePageTitle(t('nav.payments', 'Payments'), t('payments.subtitle', 'Apply customer money to invoice balances'));
  const qc = useQueryClient();
  const payments = usePayments();
  const customers = useParties('?kind=customer');
  const credit = useCredit();
  const currency = tenant?.currency ?? 'ETB';
  const [error, setError] = useState<unknown>(null);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [allocating, setAllocating] = useState<Payment | null>(null);
  const [justPostedId, setJustPostedId] = useState<string | null>(null);

  // step 2 of Record Payment: once the posted payment appears, open the
  // allocation confirmation with a sensible oldest-first suggestion
  React.useEffect(() => {
    if (!justPostedId) return;
    const p = payments.data?.find((x) => x.id === justPostedId);
    if (p) {
      setAllocating(p);
      setJustPostedId(null);
    }
  }, [justPostedId, payments.data]);

  const today = fmt.todayIso();
  const todays = (payments.data ?? []).filter((p) => p.status === 'posted' && p.date === today);
  const customerName = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? '—';

  async function reverse(reason: string) {
    if (!reversing) return;
    setError(null);
    try {
      await api.post(`/api/payments/${reversing.id}/reverse`, { reason });
      setReversing(null);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="cards">
        <StatCard
          label={t('payments.today', 'Payments today')}
          value={fmt.money(todays.reduce((s, p) => s + p.amountCents, 0), currency)}
          sub={`${todays.length} ${t('payments.records', 'records')}`}
        />
        <StatCard
          label={t('payments.unallocated', 'Unallocated money')}
          value={fmt.money(
            (payments.data ?? [])
              .filter((p) => p.status === 'posted')
              .reduce((s, p) => s + (p.amountCents - p.allocatedCents), 0),
            currency,
          )}
        />
        <StatCard label={t('credit.outstanding', 'Outstanding')} value={fmt.money(credit.data?.outstandingCents ?? null, currency)} />
      </div>

      <ErrorBox error={error} />

      {can('payments', 'create') ? (
        <NewPaymentForm onError={setError} onPosted={(id) => setJustPostedId(id)} />
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('payments.recent', 'Recent payments')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('payments.number', 'Payment')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th>{t('sales.customer', 'Customer')}</th>
                <th className="num">{t('payments.amount', 'Amount')}</th>
                <th className="num">{t('payments.allocated', 'Allocated')}</th>
                <th className="num">{t('payments.remainder', 'Unallocated')}</th>
                <th>{t('payments.method', 'Method')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(payments.data ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.docNumber}</td>
                  <td>{fmt.date(p.date)}</td>
                  <td>{customerName(p.customerId)}</td>
                  <td className="num">{fmt.money(p.amountCents, currency)}</td>
                  <td className="num">{fmt.money(p.allocatedCents, currency)}</td>
                  <td className="num">{fmt.money(p.amountCents - p.allocatedCents, currency)}</td>
                  <td>{t(`payments.method_${p.method}`, p.method)}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    {p.status === 'posted' && p.amountCents > p.allocatedCents && can('payments', 'approve') ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setAllocating(p)}>
                        {t('payments.allocate', 'Allocate')}
                      </button>
                    ) : null}{' '}
                    {p.status === 'posted' && can('payments', 'approve') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setReversing(p)}>
                        {t('receiving.reverse', 'Reverse')}
                      </button>
                    ) : null}{' '}
                    {p.status === 'posted' ? (
                      <a className="btn btn-ghost btn-sm" href={`/print/payment/${p.id}`}>
                        {t('doc.print', 'Print')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
              {payments.data?.length === 0 ? (
                <tr>
                  <td colSpan={9} className="table-empty">
                    {t('payments.none', 'No payments yet.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {reversing ? (
        <ReasonDialog
          title={`${t('receiving.reverse', 'Reverse')} ${reversing.docNumber}`}
          actionLabel={t('receiving.reverse', 'Reverse')}
          onConfirm={(r) => void reverse(r)}
          onClose={() => setReversing(null)}
        />
      ) : null}
      {allocating ? (
        <AllocateModal
          payment={allocating}
          onClose={() => setAllocating(null)}
          onDone={() => {
            setAllocating(null);
            void qc.invalidateQueries();
          }}
        />
      ) : null}
    </div>
  );
}

/** Allocation editor rows for a customer's open invoices. */
function useOpenInvoices(customerId: string) {
  const credit = useCredit(customerId ? `?customerId=${customerId}` : '');
  return useMemo(
    () => (credit.data?.rows ?? []).filter((r) => (r.remainingCents ?? 0) > 0),
    [credit.data],
  );
}

function NewPaymentForm({
  onError,
  onPosted,
}: {
  onError: (e: unknown) => void;
  onPosted: (paymentId: string) => void;
}) {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const customers = useParties('?kind=customer');
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [date, setDate] = useState(fmt.todayIso());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const amountNum = Number(amount || 0);
  const canPost = can('payments', 'approve');

  async function submit() {
    setBusy(true);
    onError(null);
    try {
      // step 1: post the money — allocation is a separate explicit confirmation
      const { id } = await api.post<{ id: string }>('/api/payments', {
        customerId,
        date,
        amount: amountNum,
        method,
        referenceNumber: reference || undefined,
        notes: notes || undefined,
        post: true,
      });
      setCustomerId('');
      setAmount('');
      setReference('');
      setNotes('');
      await qc.invalidateQueries();
      onPosted(id); // step 2: open the allocation confirmation
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('payments.new', 'Record payment')}</h2>
        <div className="spacer" />
        <span className="muted">{t('payments.two_step', 'Posting opens the allocation step')}</span>
      </div>
      <div className="panel-body">
        <div className="form-grid">
          <Field label={t('sales.customer', 'Customer')} required>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">\u2014</option>
              {customers.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('payments.amount', 'Amount')} required>
            <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('payments.method', 'Payment method')} required>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`payments.method_${m}`, m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('shell.date', 'Date')} required>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('payments.reference', 'Reference number')}>
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label={t('shell.notes', 'Notes')}>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="form-actions">
          <button
            className="btn btn-primary"
            disabled={!canPost || busy || !customerId || !(amountNum > 0)}
            onClick={() => void submit()}
          >
            {t('payments.post', 'Post payment')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AllocateModal({ payment, onClose, onDone }: { payment: Payment; onClose: () => void; onDone: () => void }) {
  const { t, tenant } = useAuth();
  const currency = tenant?.currency ?? 'ETB';
  const open = useOpenInvoices(payment.customerId);
  const [allocs, setAllocs] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState(false);

  // suggest an oldest-first allocation of the unallocated remainder; the
  // user stays in control and must explicitly Apply
  React.useEffect(() => {
    if (suggested || open.length === 0) return;
    let left = (payment.amountCents - payment.allocatedCents) / 100;
    const next: Record<string, string> = {};
    for (const inv of open) {
      if (left <= 0) break;
      const take = Math.min(left, (inv.remainingCents ?? 0) / 100);
      if (take > 0) next[inv.invoiceId] = String(Math.round(take * 100) / 100);
      left -= take;
    }
    setAllocs(next);
    setSuggested(true);
  }, [open, suggested, payment]);
  const [error, setError] = useState<unknown>(null);
  const remainder = payment.amountCents - payment.allocatedCents;
  const allocTotal = Object.values(allocs).reduce((s, v) => s + Number(v || 0), 0);

  async function apply() {
    setError(null);
    try {
      await api.post(`/api/payments/${payment.id}/allocate`, {
        allocations: Object.entries(allocs)
          .filter(([, v]) => Number(v) > 0)
          .map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })),
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={`${payment.docNumber} — ${t('payments.allocate', 'Allocate')}`} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="page-info">
        {t('payments.remainder', 'Unallocated')}: {fmt.money(remainder, currency)}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('sales.invoice', 'Invoice')}</th>
              <th className="num">{t('credit.remaining', 'Remaining')}</th>
              <th className="num">{t('payments.apply', 'Apply')}</th>
            </tr>
          </thead>
          <tbody>
            {open.map((inv) => (
              <tr key={inv.invoiceId}>
                <td className="mono">{inv.invoiceNumber}</td>
                <td className="num">{fmt.money(inv.remainingCents, currency)}</td>
                <td className="num" style={{ width: 140 }}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={allocs[inv.invoiceId] ?? ''}
                    onChange={(e) => setAllocs((a) => ({ ...a, [inv.invoiceId]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={!(allocTotal > 0) || allocTotal * 100 > remainder}
          onClick={() => void apply()}
        >
          {t('payments.apply', 'Apply')}
        </button>
      </div>
    </Modal>
  );
}
