import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, Modal, ReasonDialog } from '../components/ui.js';
import { useStock, useWarehouses, useUoms, useTransfers, useMovements } from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { StockRow, Transfer } from '../lib/types.js';

type Tab = 'raw' | 'finished' | 'transfers';

export default function InventoryPage() {
  const { t } = useAuth();
  usePageTitle(t('nav.inventory', 'Inventory'), t('inventory.subtitle', 'Calculated stock by batch and warehouse'));
  const [tab, setTab] = useState<Tab>('raw');

  return (
    <div>
      <div className="flex" style={{ marginBottom: 14 }}>
        <button className={`btn btn-sm ${tab === 'raw' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('raw')}>
          {t('inventory.tab_raw', 'Raw Materials')}
        </button>
        <button
          className={`btn btn-sm ${tab === 'finished' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('finished')}
        >
          {t('inventory.tab_finished', 'Finished Products')}
        </button>
        <button
          className={`btn btn-sm ${tab === 'transfers' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setTab('transfers')}
        >
          {t('inventory.tab_transfers', 'Warehouse Transfers')}
        </button>
      </div>
      {tab === 'raw' ? <RawTab /> : tab === 'finished' ? <FinishedTab /> : <TransfersTab />}
    </div>
  );
}

function MovementsModal({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const { t } = useAuth();
  const movements = useMovements(`?lotId=${row.lotId ?? ''}&itemId=${row.itemId}`);
  return (
    <Modal title={`${row.lotNumber ?? row.itemName} — ${t('inventory.movements', 'Stock movements')}`} onClose={onClose} wide>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('shell.date', 'Date')}</th>
              <th>{t('inventory.type', 'Type')}</th>
              <th>{t('inventory.document', 'Document')}</th>
              <th className="num">{t('inventory.qty', 'Quantity')}</th>
              <th>{t('shell.notes', 'Notes')}</th>
            </tr>
          </thead>
          <tbody>
            {(movements.data ?? []).map((m) => (
              <tr key={m.id}>
                <td>{fmt.dateTime(m.postedAt)}</td>
                <td>
                  <span className="badge badge-gray">{m.movementType}</span>
                </td>
                <td className="mono">{m.documentNumber ?? m.documentKind}</td>
                <td className="num" style={{ color: m.qty < 0 ? 'var(--danger)' : 'var(--success)' }}>
                  {m.qty > 0 ? '+' : ''}
                  {fmt.qty(m.qty)}
                </td>
                <td>{m.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function RawTab() {
  const { t } = useAuth();
  const stock = useStock('?kind=raw_material');
  const [viewing, setViewing] = useState<StockRow | null>(null);
  const rows = stock.data ?? [];
  const nonEmpty = rows.filter((r) => r.onHand !== 0 || r.reserved !== 0);
  const totals = rows.reduce(
    (acc, r) => {
      acc.onHand += r.onHand;
      acc.reserved += r.reserved;
      acc.inProcess += r.inProcess;
      acc.available += r.available;
      return acc;
    },
    { onHand: 0, reserved: 0, inProcess: 0, available: 0 },
  );

  return (
    <div>
      <div className="cards">
        <StatCard label={t('inventory.current', 'Current quantity')} value={fmt.qtySmart(totals.onHand)} sub={t('inventory.calculated', 'calculated')} />
        <StatCard label={t('inventory.reserved', 'Reserved')} value={fmt.qtySmart(totals.reserved)} />
        <StatCard label={t('inventory.in_process', 'In process')} value={fmt.qtySmart(totals.inProcess)} />
        <StatCard label={t('inventory.available', 'Available')} value={fmt.qtySmart(totals.available)} tone="success" />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>{t('inventory.raw_records', 'Raw material batches')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.batch', 'Batch')}</th>
                <th>{t('inventory.source', 'Source')}</th>
                <th>{t('inventory.received', 'Received')}</th>
                <th className="num">{t('inventory.initial', 'Initial')}</th>
                <th className="num">{t('inventory.current', 'Current')}</th>
                <th className="num">{t('inventory.reserved', 'Reserved')}</th>
                <th>{t('inventory.warehouse', 'Warehouse')}</th>
                <th>{t('shell.status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {nonEmpty.map((r) => (
                <tr key={`${r.lotId}-${r.warehouseId}`} className="clickable" onClick={() => setViewing(r)}>
                  <td className="mono">{r.lotNumber ?? '—'}</td>
                  <td>{r.lotSource ?? '—'}</td>
                  <td>{fmt.date(r.receivedAt)}</td>
                  <td className="num">{fmt.qty(r.initialQty)}</td>
                  <td className="num">{fmt.qty(r.onHand)}</td>
                  <td className="num">{fmt.qty(r.reserved)}</td>
                  <td>{r.warehouseName}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
              {nonEmpty.length === 0 ? (
                <tr>
                  <td colSpan={8} className="table-empty">
                    {t('inventory.none', 'No stock yet. Approved receiving records appear here.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      {viewing ? <MovementsModal row={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function FinishedTab() {
  const { t } = useAuth();
  const stock = useStock('?kind=finished_good');
  const [viewing, setViewing] = useState<StockRow | null>(null);
  const rows = (stock.data ?? []).filter((r) => r.onHand !== 0 || r.reserved !== 0);
  const weight = (r: StockRow, units: number) =>
    r.unitWeightMilliKg != null ? (units / 1000) * r.unitWeightMilliKg : null;
  const totalWeight = rows.reduce((s, r) => s + (weight(r, r.available) ?? 0), 0);

  return (
    <div>
      <div className="cards">
        <StatCard
          label={t('inventory.fin_available', 'Available weight')}
          value={fmt.qtySmart(totalWeight)}
          sub={t('inventory.all_sizes', 'all sizes')}
        />
        <StatCard
          label={t('inventory.reserved', 'Reserved')}
          value={fmt.qty(rows.reduce((s, r) => s + r.reserved, 0))}
          sub={t('inventory.units', 'units')}
        />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>{t('inventory.fin_records', 'Finished product stock')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.product', 'Product')}</th>
                <th>{t('inventory.batch', 'Batch')}</th>
                <th>{t('inventory.warehouse', 'Warehouse')}</th>
                <th className="num">{t('inventory.available', 'Available')}</th>
                <th className="num">{t('inventory.reserved', 'Reserved')}</th>
                <th className="num">{t('inventory.weight', 'Total weight')}</th>
                <th>{t('shell.status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.lotId}-${r.warehouseId}`} className="clickable" onClick={() => setViewing(r)}>
                  <td>{r.itemName}</td>
                  <td className="mono">{r.lotNumber ?? '—'}</td>
                  <td>{r.warehouseName}</td>
                  <td className="num">{fmt.qty(r.available)}</td>
                  <td className="num">{fmt.qty(r.reserved)}</td>
                  <td className="num">{fmt.qtySmart(weight(r, r.onHand))}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty">
                    {t('inventory.fin_none', 'No finished stock yet. Completed packaging batches appear here.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      {viewing ? <MovementsModal row={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function TransfersTab() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const stock = useStock('?kind=raw_material');
  const warehouses = useWarehouses();
  const uoms = useUoms();
  const transfers = useTransfers();

  const [lotKey, setLotKey] = useState('');
  const [qtyStr, setQtyStr] = useState('');
  const [uomId, setUomId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reversing, setReversing] = useState<Transfer | null>(null);

  const eligible = (stock.data ?? []).filter((r) => r.available > 0 && r.lotId);
  const selected = eligible.find((r) => `${r.lotId}|${r.warehouseId}` === lotKey);
  const massUoms = uoms.data?.filter((u) => u.family === 'mass') ?? [];
  const effUomId = uomId || massUoms.find((u) => u.code === 'kg')?.id || '';
  const canApprove = can('inventory', 'approve');
  const warehouseName = (id: string) => warehouses.data?.find((w) => w.id === id)?.name ?? '—';

  async function submit(andPost: boolean) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/transfers', {
        itemId: selected.itemId,
        lotId: selected.lotId,
        entryUomId: effUomId,
        qty: Number(qtyStr),
        fromWarehouseId: selected.warehouseId,
        toWarehouseId,
        date: fmt.todayIso(),
        reason,
        andPost,
      });
      setQtyStr('');
      setReason('');
      setLotKey('');
      await qc.invalidateQueries({ queryKey: ['transfers'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function post(tr: Transfer) {
    setError(null);
    try {
      await api.post(`/api/transfers/${tr.id}/post`);
      await qc.invalidateQueries({ queryKey: ['transfers'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    }
  }

  async function reverse(reasonText: string) {
    if (!reversing) return;
    setError(null);
    try {
      await api.post(`/api/transfers/${reversing.id}/reverse`, { reason: reasonText });
      setReversing(null);
      await qc.invalidateQueries({ queryKey: ['transfers'] });
      await qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorBox error={error} />
      {can('inventory', 'create') ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('transfer.new', 'New warehouse transfer')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('transfer.batch', 'Batch / source warehouse')} required>
                <select value={lotKey} onChange={(e) => setLotKey(e.target.value)}>
                  <option value="">—</option>
                  {eligible.map((r) => (
                    <option key={`${r.lotId}|${r.warehouseId}`} value={`${r.lotId}|${r.warehouseId}`}>
                      {r.lotNumber} — {r.warehouseName} ({fmt.qty(r.available)} kg)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('inventory.qty', 'Quantity')} required>
                <input type="number" min="0" step="any" value={qtyStr} onChange={(e) => setQtyStr(e.target.value)} />
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
              <Field label={t('transfer.to', 'To warehouse')} required>
                <select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  <option value="">—</option>
                  {warehouses.data
                    ?.filter((w) => w.id !== selected?.warehouseId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={t('transfer.reason', 'Reason / notes')} required>
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button
                className="btn btn-secondary"
                disabled={busy || !selected || !qtyStr || !toWarehouseId || !reason.trim()}
                onClick={() => void submit(false)}
              >
                {t('shell.save_draft', 'Save draft')}
              </button>
              {canApprove ? (
                <button
                  className="btn btn-primary"
                  disabled={busy || !selected || !qtyStr || !toWarehouseId || !reason.trim()}
                  onClick={() => void submit(true)}
                >
                  {t('transfer.approve', 'Approve transfer')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('transfer.history', 'Transfer history')}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('transfer.number', 'Transfer')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th className="num">{t('inventory.qty', 'Quantity')}</th>
                <th>{t('transfer.from', 'From')}</th>
                <th>{t('transfer.to_short', 'To')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(transfers.data ?? []).map((tr) => (
                <tr key={tr.id}>
                  <td className="mono">{tr.docNumber}</td>
                  <td>{fmt.date(tr.date)}</td>
                  <td className="num">{fmt.qtySmart(tr.qty)}</td>
                  <td>{warehouseName(tr.fromWarehouseId)}</td>
                  <td>{warehouseName(tr.toWarehouseId)}</td>
                  <td>
                    <StatusBadge status={tr.lifecycle} />
                  </td>
                  <td>
                    {tr.lifecycle === 'draft' && canApprove ? (
                      <button className="btn btn-primary btn-sm" onClick={() => void post(tr)}>
                        {t('shell.approve', 'Approve')}
                      </button>
                    ) : null}{' '}
                    {tr.lifecycle === 'posted' && canApprove ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setReversing(tr)}>
                        {t('receiving.reverse', 'Reverse')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {transfers.data?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty">
                    {t('transfer.none', 'No transfers yet.')}
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
