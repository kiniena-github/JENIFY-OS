import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, Modal } from '../components/ui.js';
import { useParties, useCredit, usePricing } from '../lib/queries.js';
import { normalizePriceCategories } from '@factoryos/shared';
import * as fmt from '../lib/format.js';
import type { Party } from '../lib/types.js';

const CUSTOMER_TYPES = ['retailer', 'wholesaler', 'distributor', 'other'];

export default function CustomersPage() {
  const { t, can } = useAuth();
  usePageTitle(t('nav.customers', 'Customers'), t('customers.subtitle', 'Customer profile, credit position, and history'));
  const qc = useQueryClient();
  const customers = useParties('?kind=customer');
  const canFinancial = can('parties', 'view_financial');
  const credit = useCredit();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState<Party | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const outstandingByCustomer = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of credit.data?.rows ?? []) {
      if (r.remainingCents != null) m.set(r.customerId, (m.get(r.customerId) ?? 0) + r.remainingCents);
    }
    return m;
  }, [credit.data]);

  const rows = (customers.data ?? []).filter(
    (c) =>
      (!typeFilter || c.partyType === typeFilter) &&
      (!search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.phone ?? '').includes(search)),
  );
  const counts = CUSTOMER_TYPES.map((ty) => ({
    ty,
    n: (customers.data ?? []).filter((c) => c.partyType === ty).length,
  }));
  const totalOutstanding = [...outstandingByCustomer.values()].reduce((s, v) => s + v, 0);

  return (
    <div>
      <div className="cards">
        <StatCard label={t('customers.total', 'Total customers')} value={customers.data?.length ?? '—'} />
        {counts
          .filter((c) => c.n > 0)
          .map((c) => (
            <StatCard key={c.ty} label={t(`customers.type_${c.ty}`, c.ty)} value={c.n} />
          ))}
        {canFinancial ? (
          <StatCard
            label={t('customers.outstanding', 'Outstanding')}
            value={fmt.money(totalOutstanding)}
            tone={totalOutstanding > 0 ? 'danger' : undefined}
          />
        ) : null}
      </div>

      <ErrorBox error={error} />

      <div className="panel">
        <div className="panel-head">
          <div className="filters">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">{t('customers.all_types', 'All customer types')}</option>
              {CUSTOMER_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`customers.type_${ty}`, ty)}
                </option>
              ))}
            </select>
            <input
              placeholder={t('customers.search', 'Search name or phone')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="spacer" />
          {can('parties', 'create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              {t('customers.add', 'Add customer')}
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('customers.name', 'Customer / company')}</th>
                <th>{t('customers.type', 'Type')}</th>
                <th>{t('customers.phone', 'Phone')}</th>
                <th>{t('customers.location', 'Location')}</th>
                {canFinancial ? <th className="num">{t('customers.credit_limit', 'Credit limit')}</th> : null}
                {canFinancial ? <th className="num">{t('customers.outstanding', 'Outstanding')}</th> : null}
                <th>{t('shell.status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setEditing(c)}>
                  <td>{c.name}</td>
                  <td>{c.partyType ? t(`customers.type_${c.partyType}`, c.partyType) : '—'}</td>
                  <td>{c.phone ?? '—'}</td>
                  <td>{c.location ?? '—'}</td>
                  {canFinancial ? <td className="num">{fmt.money(c.creditLimitCents)}</td> : null}
                  {canFinancial ? (
                    <td className="num">{fmt.money(outstandingByCustomer.get(c.id) ?? 0)}</td>
                  ) : null}
                  <td>
                    <StatusBadge status={c.active ? 'active' : 'inactive'} />
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty">
                    {t('customers.none', 'No customers yet.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {editing ? (
        <CustomerModal
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['parties'] });
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function CustomerModal({
  customer,
  onClose,
  onSaved,
  onError,
}: {
  customer: Party | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}) {
  const { t, can } = useAuth();
  const canFinancial = can('parties', 'view_financial');
  const canApprove = can('parties', 'approve');
  const pricingInfo = usePricing();
  const { categories } = normalizePriceCategories(
    pricingInfo.data?.pricing?.data ?? { categories: ['retail', 'wholesale', 'distributor'] },
  );
  const [name, setName] = useState(customer?.name ?? '');
  const [partyType, setPartyType] = useState(customer?.partyType ?? 'retailer');
  const [defaultCategory, setDefaultCategory] = useState(customer?.defaultPriceCategory ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [location, setLocation] = useState(customer?.location ?? '');
  const [taxInfo, setTaxInfo] = useState(customer?.taxInfo ?? '');
  const [creditLimit, setCreditLimit] = useState(
    customer?.creditLimitCents != null ? String(customer.creditLimitCents / 100) : '',
  );
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [active, setActive] = useState(customer?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setLocalError(null);
    try {
      const base = {
        name,
        partyType,
        phone,
        location,
        taxInfo,
        notes,
        defaultPriceCategory: defaultCategory || null,
      };
      if (customer) {
        const patch: Record<string, unknown> = { ...base, active };
        if (canFinancial && canApprove && creditLimit !== '') patch.creditLimit = Number(creditLimit);
        await api.patch(`/api/parties/${customer.id}`, patch);
      } else {
        await api.post('/api/parties', {
          kind: 'customer',
          ...base,
          creditLimit: canFinancial && creditLimit !== '' ? Number(creditLimit) : undefined,
        });
      }
      onSaved();
    } catch (err) {
      setLocalError(err);
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={customer ? customer.name : t('customers.add', 'Add customer')} onClose={onClose}>
      <ErrorBox error={localError} />
      <div className="form-grid">
        <Field label={t('customers.name', 'Customer / company')} required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('customers.type', 'Type')} required>
          <select value={partyType} onChange={(e) => setPartyType(e.target.value)}>
            {CUSTOMER_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`customers.type_${ty}`, ty)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('customers.phone', 'Phone')} required>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t('customers.location', 'Location')} required>
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <Field label={t('customers.tax', 'Tax information')}>
          <input value={taxInfo} onChange={(e) => setTaxInfo(e.target.value)} />
        </Field>
        <Field
          label={t('customers.default_category', 'Default price category')}
          hint={t('sales.price_category', 'Price category') + ' → ' + t('nav.sales', 'Sales')}
        >
          <select value={defaultCategory} onChange={(e) => setDefaultCategory(e.target.value)}>
            <option value="">—</option>
            {categories
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        {canFinancial ? (
          <Field
            label={t('customers.credit_limit', 'Credit limit')}
            hint={customer && !canApprove ? t('customers.limit_locked', 'Limit changes require approval authority') : undefined}
          >
            <input
              type="number"
              min="0"
              step="any"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
              disabled={!!customer && !canApprove}
            />
          </Field>
        ) : null}
        <Field label={t('shell.notes', 'Notes')}>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {customer ? (
          <Field label={t('shell.status', 'Status')}>
            <select value={active ? '1' : '0'} onChange={(e) => setActive(e.target.value === '1')}>
              <option value="1">{t('status.active', 'Active')}</option>
              <option value="0">{t('status.inactive', 'Inactive')}</option>
            </select>
          </Field>
        ) : null}
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !name || !phone || !location} onClick={() => void save()}>
          {t('customers.save', 'Save customer')}
        </button>
      </div>
    </Modal>
  );
}
