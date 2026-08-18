import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, Modal, ReasonDialog } from '../components/ui.js';
import { useDeliveries, useInvoices, useParties } from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { Delivery } from '../lib/types.js';

export default function DeliveriesPage() {
  const { t, can } = useAuth();
  usePageTitle(t('nav.deliveries', 'Deliveries'), t('delivery.subtitle', 'Prepare, dispatch, and complete delivery or pickup'));
  const qc = useQueryClient();
  const deliveries = useDeliveries();
  const invoices = useInvoices();
  const customers = useParties('?kind=customer');
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Delivery | null>(null);
  const [delivering, setDelivering] = useState<Delivery | null>(null);
  const [cancelling, setCancelling] = useState<Delivery | null>(null);

  const rows = deliveries.data ?? [];
  const count = (s: string) => rows.filter((d) => d.status === s).length;
  const customerName = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? '—';
  const invoiceNumber = (id: string) => invoices.data?.find((i) => i.id === id)?.docNumber ?? '—';

  const openInvoiceIds = new Set(rows.filter((d) => d.status !== 'cancelled').map((d) => d.invoiceId));
  const confirmable = (invoices.data ?? []).filter((i) => i.status === 'confirmed' && !openInvoiceIds.has(i.id));

  async function act(url: string, body?: unknown) {
    setError(null);
    try {
      await api.post(url, body);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="cards">
        <StatCard label={t('status.pending', 'Pending')} value={count('pending')} />
        <StatCard label={t('status.loading', 'Loading')} value={count('loading')} />
        <StatCard label={t('status.dispatched', 'Dispatched')} value={count('dispatched')} />
        <StatCard label={t('status.delivered', 'Delivered')} value={count('delivered')} tone="success" />
      </div>

      <ErrorBox error={error} />

      <div className="panel">
        <div className="panel-head">
          <h2>{t('delivery.orders', 'Delivery orders')}</h2>
          <div className="spacer" />
          {can('delivery', 'create') && confirmable.length > 0 ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              {t('delivery.new', 'New delivery order')}
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('delivery.number', 'Delivery')}</th>
                <th>{t('sales.invoice', 'Invoice')}</th>
                <th>{t('sales.customer', 'Customer')}</th>
                <th>{t('delivery.destination', 'Destination')}</th>
                <th>{t('delivery.truck', 'Truck')}</th>
                <th>{t('delivery.expected', 'Expected')}</th>
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.docNumber}</td>
                  <td className="mono">{invoiceNumber(d.invoiceId)}</td>
                  <td>{customerName(d.customerId)}</td>
                  <td>{d.destination ?? (d.deliveryType === 'pickup' ? t('sales.customer_pickup', 'Customer pickup') : '—')}</td>
                  <td>{d.truckNumber ?? '—'}</td>
                  <td>{fmt.date(d.expectedDate)}</td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    {(d.status === 'pending' || d.status === 'loading') && can('delivery', 'edit') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(d)}>
                        {t('delivery.details', 'Details')}
                      </button>
                    ) : null}{' '}
                    {d.status === 'pending' && (can('delivery', 'load') || can('delivery', 'edit')) ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void act(`/api/deliveries/${d.id}/loading`)}>
                        {t('status.loading', 'Loading')}
                      </button>
                    ) : null}{' '}
                    {(d.status === 'pending' || d.status === 'loading') &&
                    (can('delivery', 'dispatch') || can('delivery', 'approve')) ? (
                      <button className="btn btn-primary btn-sm" onClick={() => void act(`/api/deliveries/${d.id}/dispatch`)}>
                        {t('delivery.dispatch', 'Dispatch')}
                      </button>
                    ) : null}{' '}
                    {d.status === 'dispatched' && can('delivery', 'edit') ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setDelivering(d)}>
                        {t('status.delivered', 'Delivered')}
                      </button>
                    ) : null}{' '}
                    {(d.status === 'pending' || d.status === 'loading') && can('delivery', 'edit') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setCancelling(d)}>
                        {t('shell.cancel', 'Cancel')}
                      </button>
                    ) : null}{' '}
                    <a className="btn btn-ghost btn-sm" href={`/print/delivery/${d.id}`}>
                      {t('doc.print', 'Print')}
                    </a>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="table-empty">
                    {t('delivery.none', 'No deliveries yet. Confirmed sales appear here as delivery orders.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {creating ? (
        <CreateDeliveryModal
          confirmable={confirmable.map((i) => ({
            id: i.id,
            label: `${i.docNumber} — ${customerName(i.customerId)}`,
            fulfillment: i.fulfillment,
          }))}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries();
          }}
        />
      ) : null}
      {editing ? (
        <DetailsModal
          delivery={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void qc.invalidateQueries();
          }}
        />
      ) : null}
      {delivering ? (
        <DeliveredModal
          delivery={delivering}
          onClose={() => setDelivering(null)}
          onDone={() => {
            setDelivering(null);
            void qc.invalidateQueries();
          }}
        />
      ) : null}
      {cancelling ? (
        <ReasonDialog
          title={`${t('shell.cancel', 'Cancel')} ${cancelling.docNumber}`}
          actionLabel={t('shell.cancel', 'Cancel')}
          onConfirm={(reason) => {
            void act(`/api/deliveries/${cancelling.id}/cancel`, { reason });
            setCancelling(null);
          }}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </div>
  );
}

function CreateDeliveryModal({
  confirmable,
  onClose,
  onDone,
}: {
  confirmable: Array<{ id: string; label: string; fulfillment: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useAuth();
  const [invoiceId, setInvoiceId] = useState('');
  const [destination, setDestination] = useState('');
  const [truckNumber, setTruckNumber] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isPickup = confirmable.find((i) => i.id === invoiceId)?.fulfillment === 'pickup';
  const ready =
    !!invoiceId &&
    !!destination.trim() &&
    !!expectedDate &&
    (isPickup || (!!truckNumber.trim() && !!driverName.trim() && !!driverPhone.trim()));

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/deliveries', {
        invoiceId,
        destination: destination || undefined,
        truckNumber: truckNumber || undefined,
        driverName: driverName || undefined,
        driverPhone: driverPhone || undefined,
        expectedDate: expectedDate || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('delivery.new', 'New delivery order')} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label={t('delivery.linked_invoice', 'Linked invoice')} required>
          <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">—</option>
            {confirmable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('delivery.destination', 'Destination')} required>
          <input value={destination} onChange={(e) => setDestination(e.target.value)} />
        </Field>
        <Field label={t('delivery.truck', 'Truck number')} required={!isPickup}>
          <input value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} />
        </Field>
        <Field label={t('delivery.driver', 'Driver name')} required={!isPickup}>
          <input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
        </Field>
        <Field label={t('delivery.driver_phone', 'Driver phone')} required={!isPickup}>
          <input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
        </Field>
        <Field label={t('delivery.expected', 'Expected delivery')} required>
          <input
            type="date"
            min={fmt.todayIso()}
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void create()}>
          {t('delivery.create', 'Create delivery')}
        </button>
      </div>
    </Modal>
  );
}

function DetailsModal({ delivery, onClose, onDone }: { delivery: Delivery; onClose: () => void; onDone: () => void }) {
  const { t } = useAuth();
  const [destination, setDestination] = useState(delivery.destination ?? '');
  const [truckNumber, setTruckNumber] = useState(delivery.truckNumber ?? '');
  const [driverName, setDriverName] = useState(delivery.driverName ?? '');
  const [driverPhone, setDriverPhone] = useState(delivery.driverPhone ?? '');
  const [expectedDate, setExpectedDate] = useState(delivery.expectedDate ?? '');
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setError(null);
    try {
      await api.patch(`/api/deliveries/${delivery.id}`, {
        destination,
        truckNumber,
        driverName,
        driverPhone,
        expectedDate: expectedDate || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={`${delivery.docNumber} — ${t('delivery.details', 'Details')}`} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label={t('delivery.destination', 'Destination')} required>
          <input value={destination} onChange={(e) => setDestination(e.target.value)} />
        </Field>
        <Field label={t('delivery.truck', 'Truck number')} required>
          <input value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} />
        </Field>
        <Field label={t('delivery.driver', 'Driver name')} required>
          <input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
        </Field>
        <Field label={t('delivery.driver_phone', 'Driver phone')}>
          <input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
        </Field>
        <Field label={t('delivery.expected', 'Expected delivery')}>
          <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          {t('delivery.save', 'Save details')}
        </button>
      </div>
    </Modal>
  );
}

function DeliveredModal({ delivery, onClose, onDone }: { delivery: Delivery; onClose: () => void; onDone: () => void }) {
  const { t } = useAuth();
  const [actualDate, setActualDate] = useState(fmt.todayIso());
  const [receivedBy, setReceivedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/deliveries/${delivery.id}/delivered`, {
        actualDate,
        receivedBy,
        notes: notes || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={`${delivery.docNumber} — ${t('status.delivered', 'Delivered')}`} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label={t('delivery.actual', 'Actual delivery date')} required>
          <input
            type="date"
            max={fmt.todayIso()}
            min={delivery.dispatchDate ?? undefined}
            value={actualDate}
            onChange={(e) => setActualDate(e.target.value)}
          />
        </Field>
        <Field label={t('delivery.received_by', 'Received by')} required>
          <input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} />
        </Field>
        <Field label={t('shell.notes', 'Notes')}>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !receivedBy.trim()} onClick={() => void save()}>
          {t('delivery.mark_delivered', 'Mark delivered')}
        </button>
      </div>
    </Modal>
  );
}
