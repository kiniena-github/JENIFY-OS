import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, ReasonDialog } from '../components/ui.js';
import {
  useItems,
  useUoms,
  useWarehouses,
  useParties,
  useInvoices,
  usePricing,
  useStock,
} from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import { normalizePriceCategories } from '@factoryos/shared';
import type { Invoice } from '../lib/types.js';

interface LineDraft {
  itemId: string;
  warehouseId: string;
  qty: string;
  entryUomId: string;
  unitPrice: string; // '' = list price
  discount: string;
}

export default function SalesPage() {
  const { t, can, tenant } = useAuth();
  usePageTitle(t('nav.sales', 'Sales'), t('sales.subtitle', 'Price, reserve stock, and create an invoice'));
  const qc = useQueryClient();
  const items = useItems('?sellable=true');
  const uoms = useUoms();
  const warehouses = useWarehouses();
  const customers = useParties('?kind=customer');
  const invoices = useInvoices();
  const pricing = usePricing();
  const stock = useStock();

  const canFinancial = can('sales', 'view_financial');
  const canApprovePrice = can('sales', 'approve');
  const currency = tenant?.currency ?? 'ETB';

  const [customerId, setCustomerId] = useState('');
  const [priceCategory, setPriceCategory] = useState('');
  const [paymentTerm, setPaymentTerm] = useState<'paid' | 'credit' | 'partial'>('paid');
  const [amountPaid, setAmountPaid] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>('delivery');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([
    { itemId: '', warehouseId: '', qty: '', entryUomId: '', unitPrice: '', discount: '' },
  ]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<Invoice | null>(null);
  const [overrideNeeded, setOverrideNeeded] = useState(false);

  const { categories: allCategories, defaultCode } = normalizePriceCategories(
    pricing.data?.pricing?.data ?? { categories: ['retail', 'wholesale', 'distributor'] },
  );
  const categories = allCategories.filter((c) => c.active);
  // the selected CUSTOMER drives the default category; workers never guess
  const customerDefault = customers.data?.find((c) => c.id === customerId)?.defaultPriceCategory;
  const effCategory =
    priceCategory ||
    (customerDefault && categories.some((c) => c.code === customerDefault) ? customerDefault : null) ||
    defaultCode ||
    'retail';
  const vatRate = pricing.data?.vat?.data.enabled ? pricing.data.vat.data.ratePct : 0;

  function listPrice(itemId: string): number | null {
    return pricing.data?.pricing?.data.prices?.[itemId]?.[effCategory] ?? null;
  }
  function itemBaseUomFamily(itemId: string): string | null {
    const item = items.data?.find((i) => i.id === itemId);
    if (!item) return null;
    return uoms.data?.find((u) => u.id === item.baseUomId)?.family ?? null;
  }
  function availableFor(itemId: string, warehouseId: string): number {
    return (stock.data ?? [])
      .filter((r) => r.itemId === itemId && r.warehouseId === warehouseId)
      .reduce((s, r) => s + r.available, 0);
  }

  const preview = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    for (const l of lines) {
      const qty = Number(l.qty);
      if (!l.itemId || !(qty > 0)) continue;
      const price = l.unitPrice !== '' ? Number(l.unitPrice) : listPrice(l.itemId);
      if (price == null) continue;
      const uom = uoms.data?.find((u) => u.id === l.entryUomId);
      const item = items.data?.find((i) => i.id === l.itemId);
      const baseUom = uoms.data?.find((u) => u.id === item?.baseUomId);
      const factor = uom && baseUom ? uom.factorToBase / baseUom.factorToBase : 1;
      subtotal += qty * factor * price;
      discount += Number(l.discount || 0);
    }
    const taxable = subtotal - discount;
    const vat = (taxable * vatRate) / 100;
    return { subtotal, discount, vat, total: taxable + vat };
  }, [lines, effCategory, vatRate, uoms.data, items.data, pricing.data]);

  const hasCustom = lines.some(
    (l) => (l.unitPrice !== '' && Number(l.unitPrice) !== (listPrice(l.itemId) ?? NaN)) || Number(l.discount || 0) > 0,
  );

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const linesReady = lines.every(
    (l) =>
      l.itemId &&
      l.warehouseId &&
      Number(l.qty) > 0 &&
      l.entryUomId &&
      (l.unitPrice !== '' || listPrice(l.itemId) != null),
  );
  const formReady =
    customerId &&
    linesReady &&
    (paymentTerm === 'paid' || dueDate) &&
    (paymentTerm !== 'partial' || Number(amountPaid) > 0);

  async function submit(confirm: boolean, creditOverride = false) {
    setBusy(true);
    setError(null);
    setOverrideNeeded(false);
    try {
      const payload = {
        customerId,
        date: fmt.todayIso(),
        priceCategory: effCategory,
        paymentTerm,
        dueDate: paymentTerm === 'paid' ? undefined : dueDate,
        fulfillment,
        notes: notes || undefined,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          warehouseId: l.warehouseId,
          qty: Number(l.qty),
          entryUomId: l.entryUomId,
          unitPrice: l.unitPrice !== '' ? Number(l.unitPrice) : undefined,
          discount: l.discount !== '' ? Number(l.discount) : undefined,
        })),
        andConfirm: confirm,
        creditOverride,
      };
      const { id } = await api.post<{ id: string }>('/api/invoices', payload);
      const paid = paymentTerm === 'paid' ? preview.total : Number(amountPaid || 0);
      if (confirm && paid > 0 && can('payments', 'create')) {
        await api.post('/api/payments', {
          customerId,
          date: fmt.todayIso(),
          amount: Math.round(paid * 100) / 100,
          method: 'cash',
          notes: 'Recorded with sale',
          allocations: [{ invoiceId: id, amount: Math.round(paid * 100) / 100 }],
          post: true,
        });
      }
      setCustomerId('');
      setAmountPaid('');
      setDueDate('');
      setNotes('');
      setLines([{ itemId: '', warehouseId: '', qty: '', entryUomId: '', unitPrice: '', discount: '' }]);
      await qc.invalidateQueries();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('credit limit') && can('credit', 'approve')) setOverrideNeeded(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function rowAction(inv: Invoice, action: 'confirm' | 'cancel', reason?: string) {
    setError(null);
    try {
      await api.post(`/api/invoices/${inv.id}/${action}`, reason ? { reason } : {});
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  const customerName = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? '—';
  const finishedAvailable = (stock.data ?? [])
    .filter((r) => r.itemKind === 'finished_good' && r.unitWeightMilliKg != null)
    .reduce((s, r) => s + (r.available / 1000) * (r.unitWeightMilliKg ?? 0), 0);

  return (
    <div>
      <div className="cards">
        <StatCard label={t('sales.available_stock', 'Available finished stock')} value={fmt.qtySmart(finishedAvailable)} />
        {canFinancial ? (
          <>
            <StatCard label={t('sales.subtotal', 'Invoice subtotal')} value={fmt.money(Math.round(preview.subtotal * 100), currency)} />
            <StatCard
              label={`${t('sales.vat', 'VAT')} ${vatRate ? `${vatRate}%` : ''}`}
              value={fmt.money(Math.round(preview.vat * 100), currency)}
            />
            <StatCard label={t('sales.total', 'Total')} value={fmt.money(Math.round(preview.total * 100), currency)} tone="success" />
          </>
        ) : null}
      </div>

      <ErrorBox error={error} />
      {overrideNeeded ? (
        <div className="page-info">
          {t('sales.override_hint', 'This sale exceeds the credit limit. You may confirm with an authorized override.')}{' '}
          <button className="btn btn-primary btn-sm" onClick={() => void submit(true, true)}>
            {t('sales.override', 'Confirm with override')}
          </button>
        </div>
      ) : null}

      {can('sales', 'create') ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('sales.new', 'New sales invoice')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('sales.customer', 'Customer')} required>
                <select
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    setPriceCategory(''); // re-derive from the customer default
                  }}
                >
                  <option value="">—</option>
                  {customers.data
                    ?.filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={t('sales.price_category', 'Price category')} required>
                <select
                  value={effCategory}
                  disabled={!canApprovePrice && !!customerDefault}
                  onChange={(e) => setPriceCategory(e.target.value)}
                >
                  {categories.map((c) => (
                    <option key={c.code} value={c.code}>
                      {t(`sales.cat_${c.code}`, c.name)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('sales.payment_type', 'Payment type')} required>
                <select value={paymentTerm} onChange={(e) => setPaymentTerm(e.target.value as typeof paymentTerm)}>
                  <option value="paid">{t('status.paid', 'Paid')}</option>
                  <option value="credit">{t('sales.credit', 'Credit')}</option>
                  <option value="partial">{t('status.partial', 'Partially Paid')}</option>
                </select>
              </Field>
              {paymentTerm === 'partial' ? (
                <Field label={t('sales.amount_paid', 'Amount paid')} required>
                  <input type="number" min="0" step="any" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
                </Field>
              ) : null}
              {paymentTerm !== 'paid' ? (
                <Field label={t('sales.due_date', 'Credit due date')} required>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
              ) : null}
              <Field label={t('sales.fulfillment', 'Delivery / pickup')} required>
                <select value={fulfillment} onChange={(e) => setFulfillment(e.target.value as typeof fulfillment)}>
                  <option value="delivery">{t('sales.factory_delivery', 'Factory delivery')}</option>
                  <option value="pickup">{t('sales.customer_pickup', 'Customer pickup')}</option>
                </select>
              </Field>
              <Field label={t('shell.notes', 'Notes')}>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>

            <h3 style={{ margin: '16px 0 8px', fontSize: 13.5 }}>{t('sales.lines', 'Invoice lines')}</h3>
            {lines.map((l, i) => {
              const family = itemBaseUomFamily(l.itemId);
              const lineUoms = uoms.data?.filter((u) => !family || u.family === family) ?? [];
              const lp = listPrice(l.itemId);
              const avail = l.itemId && l.warehouseId ? availableFor(l.itemId, l.warehouseId) : null;
              return (
                <div key={i} className="form-grid" style={{ marginBottom: 10, alignItems: 'end' }}>
                  <Field label={t('inventory.product', 'Product')} required>
                    <select
                      value={l.itemId}
                      onChange={(e) => {
                        const itemId = e.target.value;
                        const item = items.data?.find((it) => it.id === itemId);
                        setLine(i, { itemId, entryUomId: item?.baseUomId ?? '' });
                      }}
                    >
                      <option value="">—</option>
                      {items.data?.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('receiving.warehouse', 'Warehouse')} required>
                    <select value={l.warehouseId} onChange={(e) => setLine(i, { warehouseId: e.target.value })}>
                      <option value="">—</option>
                      {warehouses.data?.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={t('inventory.qty', 'Quantity')}
                    required
                    hint={avail != null ? `${t('inventory.available', 'Available')}: ${fmt.qty(avail)}` : undefined}
                  >
                    <input type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                  </Field>
                  <Field label={t('receiving.unit', 'Unit')} required>
                    <select value={l.entryUomId} onChange={(e) => setLine(i, { entryUomId: e.target.value })}>
                      <option value="">—</option>
                      {lineUoms.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {canFinancial ? (
                    <Field
                      label={t('sales.unit_price', 'Unit price')}
                      hint={lp != null ? `${t('sales.list', 'List')}: ${lp} ${currency}` : t('sales.custom_needed', 'No list price — enter approved price')}
                    >
                      <input
                        type="number"
                        min="0"
                        step="any"
                        placeholder={lp != null ? String(lp) : ''}
                        value={l.unitPrice}
                        disabled={!canApprovePrice && lp != null}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                      />
                    </Field>
                  ) : null}
                  {canFinancial ? (
                    <Field label={t('sales.discount', 'Discount')}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={l.discount}
                        disabled={!canApprovePrice}
                        onChange={(e) => setLine(i, { discount: e.target.value })}
                      />
                    </Field>
                  ) : null}
                  <div>
                    {lines.length > 1 ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setLines((ls) => ls.filter((_, x) => x !== i))}>
                        ✕
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setLines((ls) => [...ls, { itemId: '', warehouseId: '', qty: '', entryUomId: '', unitPrice: '', discount: '' }])}
            >
              + {t('sales.add_line', 'Add line')}
            </button>
            {hasCustom && !canApprovePrice ? (
              <div className="page-error mt">{t('sales.custom_blocked', 'Custom prices or discounts require approval authority.')}</div>
            ) : null}
            <div className="form-actions">
              <button className="btn btn-secondary" disabled={busy || !formReady} onClick={() => void submit(false)}>
                {t('shell.save_draft', 'Save draft')}
              </button>
              {can('sales', 'edit') ? (
                <button className="btn btn-primary" disabled={busy || !formReady} onClick={() => void submit(true)}>
                  {t('sales.confirm', 'Confirm sale')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('sales.recent', 'Recent invoices')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('sales.invoice', 'Invoice')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th>{t('sales.customer', 'Customer')}</th>
                {canFinancial ? <th className="num">{t('sales.total', 'Total')}</th> : null}
                {canFinancial ? <th className="num">{t('sales.paid', 'Paid')}</th> : null}
                <th>{t('sales.payment_type', 'Payment')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(invoices.data ?? []).map((inv) => (
                <tr key={inv.id}>
                  <td className="mono">{inv.docNumber}</td>
                  <td>{fmt.date(inv.date)}</td>
                  <td>{customerName(inv.customerId)}</td>
                  {canFinancial ? <td className="num">{fmt.money(inv.totalCents, currency)}</td> : null}
                  {canFinancial ? <td className="num">{fmt.money(inv.paidCents, currency)}</td> : null}
                  <td>
                    <StatusBadge status={inv.paymentTerm === 'paid' ? 'paid' : inv.paymentTerm === 'partial' ? 'partial' : 'active'} />
                  </td>
                  <td>
                    <StatusBadge status={inv.status} />
                  </td>
                  <td>
                    {inv.status === 'pending' && can('sales', 'edit') ? (
                      <button className="btn btn-primary btn-sm" onClick={() => void rowAction(inv, 'confirm')}>
                        {t('sales.confirm_short', 'Confirm')}
                      </button>
                    ) : null}{' '}
                    {(inv.status === 'pending' || inv.status === 'confirmed') && can('sales', 'edit') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setCancelling(inv)}>
                        {t('shell.cancel', 'Cancel')}
                      </button>
                    ) : null}{' '}
                    {inv.status !== 'pending' && inv.status !== 'cancelled' ? (
                      <a className="btn btn-ghost btn-sm" href={`/print/invoice/${inv.id}`}>
                        {t('doc.print', 'Print')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
              {invoices.data?.length === 0 ? (
                <tr>
                  <td colSpan={8} className="table-empty">
                    {t('sales.none', 'No invoices yet.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {cancelling ? (
        <ReasonDialog
          title={`${t('shell.cancel', 'Cancel')} ${cancelling.docNumber}`}
          actionLabel={t('shell.cancel', 'Cancel')}
          onConfirm={(reason) => {
            void rowAction(cancelling, 'cancel', reason);
            setCancelling(null);
          }}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </div>
  );
}
