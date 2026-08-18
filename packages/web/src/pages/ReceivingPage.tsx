import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, ReasonDialog } from '../components/ui.js';
import { useItems, useUoms, useWarehouses, useParties, useReceipts } from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { Receipt } from '../lib/types.js';

export default function ReceivingPage() {
  const { t, can } = useAuth();
  usePageTitle(t('nav.receiving', 'Receiving'), t('receiving.subtitle', 'Receive material into a warehouse'));
  const qc = useQueryClient();

  const items = useItems('?kind=raw_material');
  const uoms = useUoms();
  const warehouses = useWarehouses();
  const suppliers = useParties('?kind=supplier');
  const receipts = useReceipts();

  const [itemId, setItemId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [truckNumber, setTruckNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [date, setDate] = useState(fmt.todayIso());
  const [grossQty, setGrossQty] = useState('');
  const [netQty, setNetQty] = useState('');
  const [uomId, setUomId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState<Receipt | null>(null);

  const selectedItem = items.data?.find((i) => i.id === (itemId || items.data?.[0]?.id));
  const effItemId = itemId || items.data?.[0]?.id || '';
  const sourceAttr = (selectedItem?.attributes ?? {}) as { source?: string; sourceLocked?: boolean };
  const massUoms = useMemo(() => uoms.data?.filter((u) => u.family === 'mass') ?? [], [uoms.data]);
  const effUomId = uomId || massUoms.find((u) => u.code === 't')?.id || massUoms[0]?.id || '';

  const today = fmt.todayIso();
  const todays = (receipts.data ?? []).filter((r) => r.date === today && r.lifecycle === 'posted');
  const pending = (receipts.data ?? []).filter((r) => r.lifecycle === 'draft');

  async function submit(andPost: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/receipts', {
        supplierId,
        source: sourceAttr.source,
        truckNumber,
        driverName,
        date,
        itemId: effItemId,
        entryUomId: effUomId,
        grossQty: grossQty ? Number(grossQty) : undefined,
        netQty: Number(netQty),
        warehouseId,
        remarks,
        andPost,
      });
      setTruckNumber('');
      setDriverName('');
      setGrossQty('');
      setNetQty('');
      setRemarks('');
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function action(r: Receipt, act: 'post' | 'cancel'): Promise<void> {
    setError(null);
    try {
      await api.post(`/api/receipts/${r.id}/${act}`, act === 'cancel' ? { reason: 'Cancelled from list' } : undefined);
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    }
  }

  async function reverse(reason: string): Promise<void> {
    if (!reversing) return;
    setError(null);
    try {
      await api.post(`/api/receipts/${reversing.id}/reverse`, { reason });
      setReversing(null);
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    }
  }

  const canCreate = can('inventory', 'create');
  const canApprove = can('inventory', 'approve');
  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.name ?? '—';
  const warehouseName = (id: string) => warehouses.data?.find((w) => w.id === id)?.name ?? '—';

  return (
    <div>
      <div className="cards">
        <StatCard
          label={t('receiving.today', "Today's receipts")}
          value={fmt.qtySmart(todays.reduce((s, r) => s + r.netQty, 0))}
          sub={`${todays.length} ${t('receiving.records', 'records')}`}
        />
        <StatCard
          label={t('receiving.pending', 'Pending approval')}
          value={pending.length}
          sub={fmt.qtySmart(pending.reduce((s, r) => s + r.netQty, 0))}
        />
        {sourceAttr.source ? (
          <StatCard
            label={t('receiving.source', 'Source')}
            value={sourceAttr.source}
            sub={sourceAttr.sourceLocked ? t('receiving.locked', 'Locked') : undefined}
          />
        ) : null}
        <StatCard
          label={t('receiving.warehouses', 'Warehouses')}
          value={warehouses.data?.length ?? '—'}
          sub={warehouses.data?.map((w) => w.code).join(' / ')}
        />
      </div>

      <ErrorBox error={error} />

      {canCreate ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('receiving.new', 'New receiving record')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('receiving.supplier', 'Supplier')} required>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">—</option>
                  {suppliers.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('receiving.item', 'Material')} required>
                <select value={effItemId} onChange={(e) => setItemId(e.target.value)}>
                  {items.data?.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('receiving.source', 'Source')}>
                <input value={sourceAttr.source ?? ''} readOnly={!!sourceAttr.sourceLocked} />
              </Field>
              <Field label={t('receiving.truck', 'Truck number')} required>
                <input value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} />
              </Field>
              <Field label={t('receiving.driver', 'Driver')} required>
                <input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
              </Field>
              <Field label={t('shell.date', 'Date')} required>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label={t('receiving.unit', 'Unit')} required>
                <select value={effUomId} onChange={(e) => setUomId(e.target.value)}>
                  {massUoms.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('receiving.gross', 'Gross quantity')}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={grossQty}
                  onChange={(e) => setGrossQty(e.target.value)}
                />
              </Field>
              <Field
                label={t('receiving.net', 'Net quantity')}
                required
                hint={t('receiving.net_hint', 'Approved stock addition = net quantity')}
              >
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={netQty}
                  onChange={(e) => setNetQty(e.target.value)}
                />
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
              <Field label={t('receiving.remarks', 'Remarks')}>
                <input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button
                className="btn btn-secondary"
                disabled={busy || !supplierId || !netQty || !warehouseId || !truckNumber || !driverName}
                onClick={() => void submit(false)}
              >
                {t('shell.save_draft', 'Save draft')}
              </button>
              {canApprove ? (
                <button
                  className="btn btn-primary"
                  disabled={busy || !supplierId || !netQty || !warehouseId || !truckNumber || !driverName}
                  onClick={() => void submit(true)}
                >
                  {t('receiving.save_approve', 'Save & approve')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('receiving.recent', 'Recent receiving')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('receiving.number', 'Receiving')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th>{t('receiving.supplier', 'Supplier')}</th>
                <th className="num">{t('receiving.net', 'Net quantity')}</th>
                <th>{t('receiving.warehouse', 'Warehouse')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(receipts.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.docNumber}</td>
                  <td>{fmt.date(r.date)}</td>
                  <td>{supplierName(r.supplierId)}</td>
                  <td className="num">{fmt.qtySmart(r.netQty)}</td>
                  <td>{warehouseName(r.warehouseId)}</td>
                  <td>
                    <StatusBadge status={r.lifecycle} />
                  </td>
                  <td>
                    {r.lifecycle === 'draft' && canApprove ? (
                      <button className="btn btn-primary btn-sm" onClick={() => void action(r, 'post')}>
                        {t('shell.approve', 'Approve')}
                      </button>
                    ) : null}{' '}
                    {r.lifecycle === 'draft' ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void action(r, 'cancel')}>
                        {t('shell.cancel', 'Cancel')}
                      </button>
                    ) : null}
                    {r.lifecycle === 'posted' && canApprove ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setReversing(r)}>
                        {t('receiving.reverse', 'Reverse')}
                      </button>
                    ) : null}{' '}
                    {r.lifecycle === 'posted' ? (
                      <a className="btn btn-ghost btn-sm" href={`/print/receiving/${r.id}`}>
                        {t('doc.print', 'Print')}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
              {receipts.data?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty">
                    {t('receiving.none', 'No receiving records yet.')}
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
          onConfirm={(reason) => void reverse(reason)}
          onClose={() => setReversing(null)}
        />
      ) : null}
    </div>
  );
}
