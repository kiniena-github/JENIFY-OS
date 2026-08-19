import React from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import {
  useParties,
  useItems,
  useUoms,
  useWarehouses,
  useInvoices,
  usePayments,
  useDeliveries,
  useReceipts,
  useTransfers,
  useBatchDetail,
  useStages,
} from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { InvoiceLine } from '../lib/types.js';

interface Branding {
  companyName?: string;
  address?: string;
  phone?: string;
  email?: string;
  tin?: string;
  headerNote?: string;
  footerNote?: string;
  pageSize?: string;
  assets?: Record<string, string>;
}

/**
 * Branded printable documents. Uses the browser's print dialog, which also
 * provides "Save as PDF". Transaction values are immutable — the template
 * only affects presentation.
 */
export default function PrintPage() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const { tenant, t } = useAuth();
  const uiConfig = useQuery({
    queryKey: ['ui-config'],
    queryFn: () => api.get<{ branding: Branding | null }>('/api/ui-config'),
  });
  // §branding snapshot: reprints use the branding VERSION stamped on the
  // document at issuance, so later template changes never alter old documents
  const docVersion = useDocBrandingVersion(kind, id);
  const versioned = useQuery({
    queryKey: ['branding-version', docVersion],
    queryFn: () => api.get<{ version: number; data: Branding | null }>(`/api/branding-version/${docVersion}`),
    enabled: docVersion != null && docVersion > 0,
  });
  const branding = (docVersion != null && docVersion > 0 ? versioned.data?.data : null) ?? uiConfig.data?.branding ?? {};

  return (
    <div style={{ background: 'var(--bg)', minHeight: '100vh', padding: 16 }}>
      <div className="no-print" style={{ maxWidth: 800, margin: '0 auto 12px', display: 'flex', gap: 10 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => window.history.back()}>
          ← {t('shell.cancel', 'Back')}
        </button>
        <div className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
          {t('doc.print', 'Print')} / {t('doc.download_pdf', 'Download PDF')}
        </button>
      </div>
      <div className="print-doc panel" style={{ padding: 32 }}>
        <DocHead branding={branding} logo={tenant?.logoPath} />
        {kind === 'invoice' && id ? <InvoiceDoc id={id} /> : null}
        {kind === 'payment' && id ? <PaymentDoc id={id} /> : null}
        {kind === 'delivery' && id ? <DeliveryDoc id={id} /> : null}
        {kind === 'receiving' && id ? <ReceivingDoc id={id} /> : null}
        {kind === 'transfer' && id ? <TransferDoc id={id} /> : null}
        {kind === 'batch' && id ? <BatchDoc id={id} /> : null}
        <DocFoot branding={branding} />
      </div>
    </div>
  );
}

/** brandingVersion stamped on the printed record (null when none exists). */
function useDocBrandingVersion(kind?: string, id?: string): number | null | undefined {
  const invoice = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<{ invoice: { brandingVersion: number | null } }>(`/api/invoices/${id}`),
    enabled: kind === 'invoice' && !!id,
  });
  const payments = usePayments();
  const deliveries = useDeliveries();
  const receipts = useReceipts();
  const transfers = useTransfers();
  if (kind === 'invoice') return invoice.data ? (invoice.data.invoice.brandingVersion ?? null) : undefined;
  const pick = (rows?: Array<{ id: string; brandingVersion?: number | null }>) =>
    rows ? (rows.find((r) => r.id === id)?.brandingVersion ?? null) : undefined;
  if (kind === 'payment') return pick(payments.data as never);
  if (kind === 'delivery') return pick(deliveries.data as never);
  if (kind === 'receiving') return pick(receipts.data as never);
  if (kind === 'transfer') return pick(transfers.data as never);
  return null;
}

function DocHead({ branding, logo }: { branding: Branding; logo?: string | null }) {
  const { tenant } = useAuth();
  return (
    <div className="doc-head">
      {logo ? <img src={logo} alt="" /> : null}
      <div className="doc-company">
        <h1>{branding.companyName || tenant?.name}</h1>
        <div>{branding.address || tenant?.locationNote}</div>
        {branding.phone ? <div>{branding.phone}</div> : null}
        {branding.email ? <div>{branding.email}</div> : null}
        {branding.tin ? <div>TIN: {branding.tin}</div> : null}
        {branding.headerNote ? <div className="doc-note">{branding.headerNote}</div> : null}
      </div>
      {branding.assets?.logo2 ? <img src={branding.assets.logo2} alt="" /> : null}
    </div>
  );
}

function DocFoot({ branding }: { branding: Branding }) {
  return (
    <>
      <div className="doc-sign">
        <div>
          {branding.assets?.signature ? <img src={branding.assets.signature} alt="" /> : null}
          <div>Prepared by</div>
        </div>
        <div>
          {branding.assets?.stamp ? <img src={branding.assets.stamp} alt="" /> : null}
          <div>Authorized / Stamp</div>
        </div>
        <div>
          <div>Received by</div>
        </div>
      </div>
      <div className="doc-foot">
        <span>{branding.footerNote}</span>
        <span style={{ marginLeft: 'auto' }}>Generated {fmt.dateTime(new Date().toISOString())}</span>
      </div>
    </>
  );
}

function Meta({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="doc-meta">
      {rows.map(([label, value]) => (
        <div key={label}>
          <b>{label}</b>
          {value ?? '—'}
        </div>
      ))}
    </div>
  );
}

function DocTitle({ title, number }: { title: string; number: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '14px 0 2px' }}>
      <h2 style={{ fontSize: 17 }}>{title}</h2>
      <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>
        {number}
      </span>
    </div>
  );
}

function InvoiceDoc({ id }: { id: string }) {
  const { t, tenant } = useAuth();
  const currency = tenant?.currency ?? 'ETB';
  const detail = useQuery({
    queryKey: ['invoice', id],
    queryFn: () =>
      api.get<{ invoice: Record<string, never> & { [k: string]: never } } | { invoice: never; lines: InvoiceLine[] }>(
        `/api/invoices/${id}`,
      ) as Promise<{
        invoice: {
          docNumber: string;
          date: string;
          customerId: string;
          status: string;
          paymentTerm: string;
          priceCategory: string;
          subtotalCents: number | null;
          discountCents: number | null;
          vatCents: number | null;
          totalCents: number | null;
          paidCents: number | null;
          dueDate: string | null;
        };
        lines: InvoiceLine[];
      }>,
  });
  const customers = useParties('?kind=customer');
  const items = useItems();
  const warehouses = useWarehouses();
  if (!detail.data) return <div className="centered-page">Loading…</div>;
  const { invoice, lines } = detail.data;
  const customer = customers.data?.find((c) => c.id === invoice.customerId);
  const remainingCents =
    invoice.totalCents != null && invoice.paidCents != null ? invoice.totalCents - invoice.paidCents : null;
  const fullyPaid = remainingCents === 0 && (invoice.totalCents ?? 0) > 0;
  return (
    <>
      <div style={{ position: 'relative' }}>
        {fullyPaid ? <div className="doc-stamp">{t('doc.paid_stamp', 'PAID')}</div> : null}
        <DocTitle title={t('doc.invoice', 'Sales Invoice')} number={invoice.docNumber} />
      </div>
      <Meta
        rows={[
          [t('sales.customer', 'Customer'), customer?.name],
          [t('customers.location', 'Address / location'), customer?.location ?? '—'],
          [t('customers.phone', 'Phone'), customer?.phone ?? '—'],
          [t('doc.tin', 'TIN'), customer?.taxInfo ?? '—'],
          [t('shell.date', 'Date'), fmt.date(invoice.date)],
          [t('sales.payment_type', 'Payment type'), t(`status.${invoice.paymentTerm}`, invoice.paymentTerm)],
          [t('credit.due_date', 'Due date'), invoice.dueDate ? fmt.date(invoice.dueDate) : '—'],
          [t('sales.price_category', 'Price category'), invoice.priceCategory],
          [t('shell.status', 'Status'), invoice.status],
        ]}
      />
      <table>
        <thead>
          <tr>
            <th>{t('inventory.product', 'Product')}</th>
            <th>{t('inventory.warehouse', 'Warehouse')}</th>
            <th className="num">{t('inventory.qty', 'Quantity')}</th>
            <th className="num">{t('sales.unit_price', 'Unit price')}</th>
            <th className="num">{t('sales.discount', 'Discount')}</th>
            <th className="num">{t('sales.subtotal', 'Subtotal')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{items.data?.find((i) => i.id === l.itemId)?.name ?? '—'}</td>
              <td>{warehouses.data?.find((w) => w.id === l.warehouseId)?.name ?? '—'}</td>
              <td className="num">{fmt.qty(l.qty)}</td>
              <td className="num">{fmt.money(l.unitPriceCents, currency)}</td>
              <td className="num">{fmt.money(l.discountCents, currency)}</td>
              <td className="num">{fmt.money(l.lineSubtotalCents, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="doc-totals">
        <tbody>
          <tr>
            <td>{t('sales.subtotal', 'Subtotal')}</td>
            <td className="num">{fmt.money(invoice.subtotalCents, currency)}</td>
          </tr>
          <tr>
            <td>{t('sales.discount', 'Discount')}</td>
            <td className="num">{fmt.money(invoice.discountCents, currency)}</td>
          </tr>
          <tr>
            <td>{t('sales.vat', 'VAT')}</td>
            <td className="num">{fmt.money(invoice.vatCents, currency)}</td>
          </tr>
          <tr className="grand">
            <td>{t('sales.total', 'Total')}</td>
            <td className="num">{fmt.money(invoice.totalCents, currency)}</td>
          </tr>
          <tr>
            <td>{t('doc.paid', 'Paid')}</td>
            <td className="num">{fmt.money(invoice.paidCents, currency)}</td>
          </tr>
          <tr className={fullyPaid ? undefined : 'grand'}>
            <td>{t('doc.remaining', 'Remaining / Balance')}</td>
            <td className="num">{fmt.money(remainingCents, currency)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function PaymentDoc({ id }: { id: string }) {
  const { t, tenant } = useAuth();
  const currency = tenant?.currency ?? 'ETB';
  const payments = usePayments();
  const customers = useParties('?kind=customer');
  const invoices = useInvoices();
  const allocations = useQuery({
    queryKey: ['payment-allocs', id],
    queryFn: () =>
      api.get<Array<{ id: string; invoiceId: string; amountCents: number; status: string }>>(
        `/api/payments/${id}/allocations`,
      ),
  });
  const p = payments.data?.find((x) => x.id === id);
  if (!p) return <div className="centered-page">Loading…</div>;
  return (
    <>
      <DocTitle title={t('doc.receipt', 'Payment Receipt')} number={p.docNumber} />
      <Meta
        rows={[
          [t('sales.customer', 'Customer'), customers.data?.find((c) => c.id === p.customerId)?.name],
          [t('shell.date', 'Date'), fmt.date(p.date)],
          [t('payments.method', 'Method'), p.method],
          [t('payments.reference', 'Reference'), p.referenceNumber ?? '—'],
          [t('shell.status', 'Status'), p.status],
        ]}
      />
      <table>
        <thead>
          <tr>
            <th>{t('sales.invoice', 'Invoice')}</th>
            <th className="num">{t('payments.allocated', 'Allocated')}</th>
          </tr>
        </thead>
        <tbody>
          {(allocations.data ?? [])
            .filter((a) => a.status === 'active')
            .map((a) => (
              <tr key={a.id}>
                <td className="mono">{invoices.data?.find((i) => i.id === a.invoiceId)?.docNumber ?? '—'}</td>
                <td className="num">{fmt.money(a.amountCents, currency)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <table className="doc-totals">
        <tbody>
          <tr className="grand">
            <td>{t('payments.amount', 'Amount')}</td>
            <td className="num">{fmt.money(p.amountCents, currency)}</td>
          </tr>
          <tr>
            <td>{t('payments.remainder', 'Unallocated')}</td>
            <td className="num">{fmt.money(p.amountCents - p.allocatedCents, currency)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function DeliveryDoc({ id }: { id: string }) {
  const { t } = useAuth();
  const deliveries = useDeliveries();
  const customers = useParties('?kind=customer');
  const invoices = useInvoices();
  const d = deliveries.data?.find((x) => x.id === id);
  if (!d) return <div className="centered-page">Loading…</div>;
  return (
    <>
      <DocTitle title={t('doc.delivery_note', 'Delivery Note')} number={d.docNumber} />
      <Meta
        rows={[
          [t('sales.invoice', 'Invoice'), invoices.data?.find((i) => i.id === d.invoiceId)?.docNumber],
          [t('sales.customer', 'Customer'), customers.data?.find((c) => c.id === d.customerId)?.name],
          [t('delivery.destination', 'Destination'), d.destination],
          [t('delivery.truck', 'Truck'), d.truckNumber ?? '—'],
          [t('delivery.driver', 'Driver'), d.driverName ?? '—'],
          [t('delivery.driver_phone', 'Driver phone'), d.driverPhone ?? '—'],
          [t('delivery.expected', 'Expected'), fmt.date(d.expectedDate)],
          [t('delivery.actual', 'Delivered'), d.actualDate ? fmt.date(d.actualDate) : '—'],
          [t('delivery.received_by', 'Received by'), d.receivedBy ?? '—'],
          [t('shell.status', 'Status'), d.status],
        ]}
      />
      {d.notes ? <p>{d.notes}</p> : null}
    </>
  );
}

function ReceivingDoc({ id }: { id: string }) {
  const { t } = useAuth();
  const receipts = useReceipts();
  const suppliers = useParties('?kind=supplier');
  const items = useItems();
  const warehouses = useWarehouses();
  const r = receipts.data?.find((x) => x.id === id);
  if (!r) return <div className="centered-page">Loading…</div>;
  return (
    <>
      <DocTitle title={t('doc.receiving_note', 'Receiving Note')} number={r.docNumber} />
      <Meta
        rows={[
          [t('receiving.supplier', 'Supplier'), suppliers.data?.find((s) => s.id === r.supplierId)?.name],
          [t('receiving.item', 'Material'), items.data?.find((i) => i.id === r.itemId)?.name],
          [t('receiving.source', 'Source'), r.source ?? '—'],
          [t('shell.date', 'Date'), fmt.date(r.date)],
          [t('receiving.truck', 'Truck'), r.truckNumber ?? '—'],
          [t('receiving.driver', 'Driver'), r.driverName ?? '—'],
          [t('receiving.gross', 'Gross'), r.grossQty != null ? fmt.qtySmart(r.grossQty) : '—'],
          [t('receiving.net', 'Net'), fmt.qtySmart(r.netQty)],
          [t('receiving.warehouse', 'Warehouse'), warehouses.data?.find((w) => w.id === r.warehouseId)?.name],
          [t('shell.status', 'Status'), r.lifecycle],
        ]}
      />
    </>
  );
}

function TransferDoc({ id }: { id: string }) {
  const { t } = useAuth();
  const transfers = useTransfers();
  const warehouses = useWarehouses();
  const tr = transfers.data?.find((x) => x.id === id);
  if (!tr) return <div className="centered-page">Loading…</div>;
  const wh = (wid: string) => warehouses.data?.find((w) => w.id === wid)?.name ?? '—';
  return (
    <>
      <DocTitle title={t('doc.transfer_note', 'Warehouse Transfer')} number={tr.docNumber} />
      <Meta
        rows={[
          [t('shell.date', 'Date'), fmt.date(tr.date)],
          [t('inventory.qty', 'Quantity'), fmt.qtySmart(tr.qty)],
          [t('transfer.from', 'From'), wh(tr.fromWarehouseId)],
          [t('transfer.to_short', 'To'), wh(tr.toWarehouseId)],
          [t('transfer.reason', 'Reason'), tr.reason ?? '—'],
          [t('shell.status', 'Status'), tr.lifecycle],
        ]}
      />
    </>
  );
}

function BatchDoc({ id }: { id: string }) {
  const { t } = useAuth();
  const detail = useBatchDetail(id);
  const stages = useStages();
  const items = useItems();
  if (!detail.data) return <div className="centered-page">Loading…</div>;
  const { batch, tests } = detail.data;
  const stage = stages.data?.find((s) => s.id === batch.stageId);
  const isQc = stage?.requiresQc;
  return (
    <>
      <DocTitle
        title={isQc ? t('doc.qc_certificate', 'Quality Result Sheet') : t('doc.batch_sheet', 'Production Batch Sheet')}
        number={batch.docNumber}
      />
      <Meta
        rows={[
          [t('reports.stage', 'Stage'), stage ? t(stage.nameKey, stage.code) : '—'],
          [t('shell.date', 'Date'), fmt.date(batch.date)],
          [t('production.input', 'Input'), `${fmt.qty(batch.inputQty)} kg`],
          [
            t('production.output', 'Output'),
            batch.outputQty != null
              ? `${fmt.qty(batch.outputQty)} kg`
              : batch.unitsProduced != null
                ? `${fmt.qty((batch.unitsProduced ?? 0) - (batch.unitsRejected ?? 0))} ${
                    items.data?.find((i) => i.id === batch.outputItemId)?.name ?? 'units'
                  }`
                : '—',
          ],
          [t('production.operator', 'Operator'), batch.operatorName ?? '—'],
          [t('shell.status', 'Status'), batch.status],
          [t('production.qc', 'Quality'), isQc ? batch.qcStatus : '—'],
        ]}
      />
      {isQc && tests.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{t('shell.date', 'Date')}</th>
              <th>{t('production.target', 'Target')}</th>
              <th>{t('production.actual', 'Actual result')}</th>
              <th>{t('production.tested_by', 'Tested by')}</th>
              <th>{t('shell.status', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            {tests.map((qt) => (
              <tr key={qt.id}>
                <td>{qt.attemptNumber}</td>
                <td>{fmt.date(qt.date)}</td>
                <td>{qt.targetLevel ?? '—'}</td>
                <td>{qt.actualResult}</td>
                <td>{qt.operatorName ?? '—'}</td>
                <td>{qt.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
