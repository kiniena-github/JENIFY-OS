import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, ReasonDialog } from '../components/ui.js';
import { useItems, useWarehouses, useStock } from '../lib/queries.js';
import * as fmt from '../lib/format.js';

interface SimpleTxn {
  id: string;
  docNumber: string;
  itemId: string;
  type: string;
  qty: number;
  buyer: string | null;
  unitPriceCents: number | null;
  date: string;
  lifecycle: string;
}

interface SimpleScreenCfg {
  route: string;
  itemId: string;
  labelKey: string;
  sellDocSeqKey: string;
}

export default function SacksPage() {
  const { t, can, tenant } = useAuth();
  const qc = useQueryClient();
  const currency = tenant?.currency ?? 'ETB';
  const uiConfig = useQuery({
    queryKey: ['ui-config'],
    queryFn: () => api.get<{ simpleItemScreens: SimpleScreenCfg[] }>('/api/ui-config'),
  });
  const cfg = uiConfig.data?.simpleItemScreens?.[0];
  const items = useItems();
  const item = items.data?.find((i) => i.id === cfg?.itemId);
  const label = cfg ? t(cfg.labelKey, item?.name ?? 'Side Items') : 'Side Items';
  usePageTitle(label, t('sacks.subtitle', 'Track reusable pieces separately from product stock'));

  const warehouses = useWarehouses();
  const stock = useStock(cfg ? `?itemId=${cfg.itemId}` : '');
  const txns = useQuery({
    queryKey: ['simple-txns', cfg?.itemId],
    queryFn: () => api.get<SimpleTxn[]>(`/api/simple-transactions?itemId=${cfg!.itemId}`),
    enabled: !!cfg,
  });

  const [type, setType] = useState<'collect' | 'sell'>('collect');
  const [qty, setQty] = useState('');
  const [buyer, setBuyer] = useState('');
  const [price, setPrice] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState<SimpleTxn | null>(null);

  if (!cfg) {
    return <div className="centered-page">{t('sacks.not_configured', 'No side-item screen is configured for this factory.')}</div>;
  }

  const available = (stock.data ?? []).reduce((s, r) => s + r.onHand, 0);
  const month = fmt.todayIso().slice(0, 7);
  const monthTxns = (txns.data ?? []).filter((x) => x.lifecycle === 'posted' && x.date.startsWith(month));
  const collected = monthTxns.filter((x) => x.type === 'collect').reduce((s, x) => s + x.qty, 0);
  const sold = monthTxns.filter((x) => x.type === 'sell').reduce((s, x) => s + x.qty, 0);
  const proceeds = monthTxns
    .filter((x) => x.type === 'sell' && x.unitPriceCents != null)
    .reduce((s, x) => s + Math.round((x.qty / 1000) * x.unitPriceCents!), 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/simple-transactions', {
        itemId: cfg!.itemId,
        warehouseId,
        type,
        qty: Number(qty),
        buyer: type === 'sell' ? buyer : undefined,
        unitPrice: type === 'sell' && price !== '' ? Number(price) : undefined,
        date: fmt.todayIso(),
        notes: notes || undefined,
        docSeqKey: cfg!.sellDocSeqKey,
      });
      setQty('');
      setBuyer('');
      setPrice('');
      setNotes('');
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function reverse(reason: string) {
    if (!reversing) return;
    try {
      await api.post(`/api/simple-transactions/${reversing.id}/reverse`, { reason });
      setReversing(null);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  const ready = warehouseId && Number(qty) > 0 && (type === 'collect' || (buyer.trim() && price !== ''));

  return (
    <div>
      <div className="cards">
        <StatCard label={t('sacks.collected', 'Collected')} value={fmt.qty(collected)} sub={t('dashboard.month', 'month')} />
        <StatCard label={t('inventory.available', 'Available')} value={fmt.qty(available)} sub={t('sacks.pieces', 'pieces')} />
        <StatCard label={t('reports.sold', 'Sold')} value={fmt.qty(sold)} sub={t('dashboard.month', 'month')} />
        {can('inventory', 'view_financial') ? (
          <StatCard label={t('reports.proceeds', 'Proceeds')} value={fmt.money(proceeds, currency)} tone="success" />
        ) : null}
      </div>

      <ErrorBox error={error} />

      {can('inventory', 'create') ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('sacks.new', 'New transaction')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('sacks.type', 'Transaction type')} required>
                <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="collect">{t('sacks.collect', 'Collect pieces')}</option>
                  <option value="sell">{t('sacks.sell', 'Sell pieces')}</option>
                </select>
              </Field>
              <Field label={t('inventory.qty', 'Quantity')} required>
                <input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
              <Field label={t('receiving.warehouse', 'Warehouse')} required>
                <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">—</option>
                  {warehouses.data?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              {type === 'sell' ? (
                <>
                  <Field label={t('reports.buyer', 'Buyer')} required>
                    <input value={buyer} onChange={(e) => setBuyer(e.target.value)} />
                  </Field>
                  <Field label={t('sacks.price', 'Selling price / piece')} required>
                    <input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} />
                  </Field>
                </>
              ) : null}
              <Field label={t('shell.notes', 'Notes')}>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void submit()}>
                {t('sacks.post', 'Post transaction')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('sacks.history', 'Transaction history')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.document', 'Reference')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th>{t('inventory.type', 'Type')}</th>
                <th className="num">{t('inventory.qty', 'Quantity')}</th>
                <th>{t('reports.buyer', 'Buyer')}</th>
                <th className="num">{t('sacks.price', 'Price')}</th>
                <th className="num">{t('sacks.total', 'Total amount')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(txns.data ?? []).map((x) => (
                <tr key={x.id}>
                  <td className="mono">{x.docNumber}</td>
                  <td>{fmt.date(x.date)}</td>
                  <td>
                    <span className={`badge ${x.type === 'collect' ? 'badge-blue' : 'badge-green'}`}>
                      {x.type === 'collect' ? t('sacks.collected', 'Collected') : t('reports.sold', 'Sold')}
                    </span>
                  </td>
                  <td className="num">{fmt.qty(x.qty)}</td>
                  <td>{x.buyer ?? '—'}</td>
                  <td className="num">{fmt.money(x.unitPriceCents, currency)}</td>
                  <td className="num">
                    {x.unitPriceCents != null
                      ? fmt.money(Math.round((x.qty / 1000) * x.unitPriceCents), currency)
                      : '—'}
                  </td>
                  <td>
                    <StatusBadge status={x.lifecycle} />
                  </td>
                  <td>
                    {x.lifecycle === 'posted' && can('inventory', 'approve') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setReversing(x)}>
                        {t('receiving.reverse', 'Reverse')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {txns.data?.length === 0 ? (
                <tr>
                  <td colSpan={9} className="table-empty">
                    {t('sacks.none', 'No transactions yet.')}
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
    </div>
  );
}
