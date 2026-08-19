import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatusBadge, ErrorBox, Field } from '../components/ui.js';
import { useItems, useWarehouses } from '../lib/queries.js';
import { normalizePriceCategories, type PriceCategory } from '@factoryos/shared';

type Tab = 'general' | 'warehouses' | 'pricing' | 'translations' | 'numbering' | 'documents';

export default function SettingsPage() {
  const { t } = useAuth();
  usePageTitle(t('nav.settings', 'Settings'), t('settings.subtitle', 'Company, warehouses, pricing, languages, and numbering'));
  const [tab, setTab] = useState<Tab>('general');
  const tabs: Array<[Tab, string, string]> = [
    ['general', 'settings.tab_general', 'General'],
    ['warehouses', 'settings.tab_warehouses', 'Warehouses'],
    ['pricing', 'settings.tab_pricing', 'Prices & VAT'],
    ['translations', 'settings.tab_translations', 'Languages & Translations'],
    ['numbering', 'settings.tab_numbering', 'Document numbering'],
    ['documents', 'settings.tab_documents', 'Documents & Branding'],
  ];
  return (
    <div>
      <div className="flex" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {tabs.map(([id, key, fallback]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(id)}>
            {t(key, fallback)}
          </button>
        ))}
        <div className="spacer" />
        <a className="btn btn-ghost btn-sm" href="/setup">
          {t('setup.title', 'Factory setup')} →
        </a>
      </div>
      {tab === 'general' ? (
        <>
          <GeneralTab />
          <CalendarPanel />
          <QualityConfigPanel />
        </>
      ) : null}
      {tab === 'warehouses' ? <WarehousesTab /> : null}
      {tab === 'pricing' ? <PricingTab /> : null}
      {tab === 'translations' ? <TranslationsTab /> : null}
      {tab === 'numbering' ? <NumberingTab /> : null}
      {tab === 'documents' ? <DocumentsTab /> : null}
    </div>
  );
}

function GeneralTab() {
  const { t, tenant, refresh, can } = useAuth();
  const canEdit = can('settings', 'edit');
  const [name, setName] = useState(tenant?.name ?? '');
  const [locationNote, setLocationNote] = useState(tenant?.locationNote ?? '');
  const [brandColor, setBrandColor] = useState(tenant?.brandColor ?? '#1e6bd6');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    try {
      await api.patch('/api/tenant', { name, locationNote, brandColor });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('settings.company', 'Company profile')}</h2>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        {saved ? <div className="page-info">{t('settings.saved', 'Saved. Settings change future behavior only.')}</div> : null}
        <div className="form-grid">
          <Field label={t('settings.company_name', 'Company name')} required>
            <input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('customers.location', 'Location')}>
            <input value={locationNote} disabled={!canEdit} onChange={(e) => setLocationNote(e.target.value)} />
          </Field>
          <Field label={t('settings.brand_color', 'Brand color')}>
            <input type="color" value={brandColor} disabled={!canEdit} onChange={(e) => setBrandColor(e.target.value)} />
          </Field>
          <Field label={t('settings.currency', 'Currency')}>
            <input value={tenant?.currency ?? ''} readOnly />
          </Field>
          <Field label={t('settings.timezone', 'Timezone')}>
            <input value={tenant?.timezone ?? ''} readOnly />
          </Field>
        </div>
        {canEdit ? (
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => void save()}>
              {t('settings.save', 'Save settings')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Quality defaults (e.g. target iodine ppm) — versioned tenant settings. */
/** Calendar display configuration — display only, stored dates never change. */
function CalendarPanel() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('settings', 'edit');
  const generalQ = useQuery({
    queryKey: ['settings', 'general'],
    queryFn: () => api.get<{ version: number; data: Record<string, unknown> }>('/api/settings/general'),
  });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const calendar = (generalQ.data?.data.calendar as string) ?? 'gregorian';

  async function save(next: string) {
    setError(null);
    try {
      await api.put('/api/settings/general', { data: { ...(generalQ.data?.data ?? {}), calendar: next } });
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['settings', 'general'] });
      await qc.invalidateQueries({ queryKey: ['ui-config'] });
      window.location.reload(); // date formatting is applied at load
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('settings.calendar', 'Calendar display')}</h2>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        {saved ? <div className="page-info">{t('settings.saved', 'Saved. Settings change future behavior only.')}</div> : null}
        <div className="form-grid">
          <Field
            label={t('settings.calendar', 'Calendar display')}
            hint={t('settings.calendar_note', 'Display only ""—"" stored dates never change. Ethiopian dates are marked with EC.').replace('""—""', '—')}
          >
            <select value={calendar} disabled={!canEdit} onChange={(e) => void save(e.target.value)}>
              <option value="gregorian">{t('settings.calendar_gc', 'Gregorian (GC)')}</option>
              <option value="ethiopian">{t('settings.calendar_ec', 'Ethiopian (EC)')}</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

function QualityConfigPanel() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('settings', 'edit');
  const prodQ = useQuery({
    queryKey: ['settings', 'production'],
    queryFn: () =>
      api.get<{
        version: number;
        data: { iodization?: { targetPpm?: string; additiveName?: string; additiveForm?: string; additiveUnit?: string } };
      }>('/api/settings/production'),
  });
  const [target, setTarget] = useState<string | null>(null);
  const [additiveName, setAdditiveName] = useState<string | null>(null);
  const [additiveForm, setAdditiveForm] = useState<string | null>(null);
  const [additiveUnit, setAdditiveUnit] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const iod = prodQ.data?.data.iodization ?? {};
  const effective = target ?? iod.targetPpm ?? '';
  const effName = additiveName ?? iod.additiveName ?? '';
  const effForm = additiveForm ?? iod.additiveForm ?? '';
  const effUnit = additiveUnit ?? iod.additiveUnit ?? 'kg';
  const dirty = target !== null || additiveName !== null || additiveForm !== null || additiveUnit !== null;

  async function save() {
    setError(null);
    try {
      const data = { ...(prodQ.data?.data ?? {}) };
      data.iodization = {
        ...(data.iodization ?? {}),
        targetPpm: effective,
        additiveName: effName,
        additiveForm: effForm,
        additiveUnit: effUnit,
      };
      await api.put('/api/settings/production', { data });
      setSaved(true);
      setTarget(null);
      setAdditiveName(null);
      setAdditiveForm(null);
      setAdditiveUnit(null);
      await qc.invalidateQueries({ queryKey: ['settings', 'production'] });
      await qc.invalidateQueries({ queryKey: ['ui-config'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('settings.quality', 'Quality configuration')}</h2>
        <div className="spacer" />
        <span className="muted">v{prodQ.data?.version ?? 0}</span>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        {saved ? <div className="page-info">{t('settings.saved', 'Saved. Settings change future behavior only.')}</div> : null}
        <div className="form-grid">
          <Field
            label={t('settings.quality_target', 'Target level (ppm)')}
            hint={t(
              'settings.quality_note',
              'Used as the default target on new quality tests. Tests already recorded keep the target that applied at the time.',
            )}
          >
            <input value={effective} disabled={!canEdit} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label={t('settings.additive_name', 'Additive name')}>
            <input value={effName} disabled={!canEdit} onChange={(e) => setAdditiveName(e.target.value)} />
          </Field>
          <Field
            label={t('settings.additive_form', 'Additive form/type')}
            hint={t('settings.additive_form_hint', 'e.g. powder, solution, premix — confirm with the factory before relying on it')}
          >
            <input value={effForm} disabled={!canEdit} onChange={(e) => setAdditiveForm(e.target.value)} />
          </Field>
          <Field label={t('settings.additive_unit', 'Additive unit')}>
            <input value={effUnit} disabled={!canEdit} onChange={(e) => setAdditiveUnit(e.target.value)} />
          </Field>
        </div>
        {canEdit ? (
          <div className="form-actions">
            <button className="btn btn-primary" disabled={!dirty} onClick={() => void save()}>
              {t('settings.save', 'Save settings')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WarehousesTab() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const warehouses = useQuery({
    queryKey: ['warehouses', 'all'],
    queryFn: () => api.get<Array<{ id: string; code: string; name: string; locationNote: string | null; active: boolean }>>('/api/warehouses?includeInactive=true'),
  });
  const canEdit = can('settings', 'edit');
  const [error, setError] = useState<unknown>(null);
  const [edits, setEdits] = useState<Record<string, { name: string; locationNote: string }>>({});
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [busy, setBusy] = useState(false);

  async function addWarehouse() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/warehouses', { code: newCode.trim(), name: newName.trim(), locationNote: newLocation || undefined });
      setNewCode('');
      setNewName('');
      setNewLocation('');
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string, active: boolean) {
    setError(null);
    try {
      await api.patch(`/api/warehouses/${id}`, { active });
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      setError(err);
    }
  }

  async function save(id: string) {
    setError(null);
    const e = edits[id];
    if (!e) return;
    try {
      await api.patch(`/api/warehouses/${id}`, e);
      setEdits((x) => {
        const { [id]: _drop, ...rest } = x;
        return rest;
      });
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorBox error={error} />
      <div className="page-info">
        {t('settings.warehouse_note', 'Stock balances are never edited here — they come from approved movements only.')}{' '}
        {t('settings.warehouse_archive_note', 'A warehouse with stock or history is archived, never deleted. Move stock out before closing it.')}
      </div>
      {canEdit ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('settings.add_warehouse', 'Add warehouse')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('settings.code', 'Code')} required>
                <input value={newCode} onChange={(e) => setNewCode(e.target.value)} />
              </Field>
              <Field label={t('settings.name', 'Name')} required>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
              <Field label={t('settings.location_note', 'Location note')}>
                <input value={newLocation} onChange={(e) => setNewLocation(e.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" disabled={busy || !newCode.trim() || !newName.trim()} onClick={() => void addWarehouse()}>
                {t('settings.add_warehouse', 'Add warehouse')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {(warehouses.data ?? []).map((w) => {
          const e = edits[w.id] ?? { name: w.name, locationNote: w.locationNote ?? '' };
          const dirty = e.name !== w.name || e.locationNote !== (w.locationNote ?? '');
          return (
            <div key={w.id} className="card">
              <div className="card-label">
                {t('settings.code', 'Code')}: {w.code} <StatusBadge status={w.active ? 'active' : 'inactive'} />
              </div>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <Field label={t('settings.name', 'Name')}>
                  <input
                    value={e.name}
                    disabled={!canEdit}
                    onChange={(ev) => setEdits((x) => ({ ...x, [w.id]: { ...e, name: ev.target.value } }))}
                  />
                </Field>
                <Field label={t('settings.location_note', 'Location note')}>
                  <input
                    value={e.locationNote}
                    disabled={!canEdit}
                    onChange={(ev) => setEdits((x) => ({ ...x, [w.id]: { ...e, locationNote: ev.target.value } }))}
                  />
                </Field>
              </div>
              <div className="flex mt">
                {canEdit && dirty ? (
                  <button className="btn btn-primary btn-sm" onClick={() => void save(w.id)}>
                    {t('settings.save', 'Save settings')}
                  </button>
                ) : null}
                {canEdit ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => void setActive(w.id, !w.active)}>
                    {w.active ? t('status.inactive', 'Archive') : t('status.active', 'Reactivate')}
                  </button>
                ) : null}
                {canEdit ? <DeleteWarehouseButton id={w.id} onError={setError} /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Permanent delete is offered ONLY for warehouses that no transaction has
 * ever referenced. Anything with history — even at zero current stock —
 * shows why it can only be archived.
 */
function DeleteWarehouseButton({ id, onError }: { id: string; onError: (e: unknown) => void }) {
  const { t } = useAuth();
  const qc = useQueryClient();
  const usage = useQuery({
    queryKey: ['warehouse-usage', id],
    queryFn: () => api.get<{ used: boolean }>(`/api/warehouses/${id}/usage`),
  });
  if (!usage.data) return null;
  if (usage.data.used) {
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        {t('settings.wh_used_hint', 'Has transaction history — archive only')}
      </span>
    );
  }
  async function del() {
    if (!window.confirm(t('settings.wh_delete_confirm', 'Permanently delete this unused warehouse?'))) return;
    onError(null);
    try {
      await api.del(`/api/warehouses/${id}`);
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      onError(err);
    }
  }
  return (
    <button className="btn btn-danger btn-sm" onClick={() => void del()}>
      {t('settings.wh_delete', 'Delete permanently')}
    </button>
  );
}

interface PricingData {
  categories: Array<string | { code: string; name: string; active: boolean }>;
  defaultCategory?: string;
  customPrice?: { enabled?: boolean; requiresApproval?: boolean };
  discount?: { requiresApproval?: boolean };
  prices: Record<string, Record<string, number | null>>;
}

function PricingTab() {
  const { t, can, tenant } = useAuth();
  const canEdit = can('settings', 'edit');
  const currency = tenant?.currency ?? 'ETB';
  const items = useItems('?sellable=true');
  const pricingQ = useQuery({
    queryKey: ['settings', 'pricing'],
    queryFn: () => api.get<{ version: number; data: PricingData }>('/api/settings/pricing'),
  });
  const vatQ = useQuery({
    queryKey: ['settings', 'vat'],
    queryFn: () => api.get<{ version: number; data: { enabled: boolean; ratePct: number } }>('/api/settings/vat'),
  });
  const [pricing, setPricing] = useState<PricingData | null>(null);
  const [vatEnabled, setVatEnabled] = useState(true);
  const [vatRate, setVatRate] = useState('15');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (pricingQ.data?.data && !pricing) setPricing(pricingQ.data.data);
  }, [pricingQ.data, pricing]);
  useEffect(() => {
    if (vatQ.data?.data) {
      setVatEnabled(vatQ.data.data.enabled);
      setVatRate(String(vatQ.data.data.ratePct ?? 0));
    }
  }, [vatQ.data]);

  const [newCatName, setNewCatName] = useState('');
  if (!pricing) return <div className="centered-page">Loading…</div>;
  const normalized = normalizePriceCategories(pricing);

  function mutateCategories(fn: (cats: PriceCategory[]) => void) {
    setPricing((p) => {
      if (!p) return p;
      const next: PricingData = JSON.parse(JSON.stringify(p));
      const cats: PriceCategory[] = normalizePriceCategories(next).categories;
      fn(cats);
      next.categories = cats;
      return next;
    });
    setSaved(false);
  }

  function addCategory() {
    const name = newCatName.trim();
    if (!name) return;
    const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    mutateCategories((cats) => {
      if (!cats.some((c) => c.code === code)) cats.push({ code, name, active: true });
    });
    setNewCatName('');
  }

  function setPrice(itemId: string, cat: string, value: string) {
    setPricing((p) => {
      if (!p) return p;
      const next: PricingData = JSON.parse(JSON.stringify(p));
      next.prices[itemId] = next.prices[itemId] ?? {};
      next.prices[itemId][cat] = value === '' ? null : Number(value);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setError(null);
    try {
      await api.put('/api/settings/pricing', { data: pricing });
      await api.put('/api/settings/vat', { data: { enabled: vatEnabled, ratePct: Number(vatRate) } });
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorBox error={error} />
      {saved ? (
        <div className="page-info">
          {t('settings.pricing_saved', 'Saved as a new version. Existing posted invoices keep the version they used.')}
        </div>
      ) : null}
      <div className="panel">
        <div className="panel-head">
          <h2>{t('settings.categories', 'Price categories')}</h2>
          <div className="spacer" />
          <span className="muted">{t('settings.category_note', 'Categories are archived, never deleted — historical invoices keep the category they used.')}</span>
        </div>
        <div className="panel-body">
          <div className="flex" style={{ flexWrap: 'wrap', gap: 14 }}>
            {normalized.categories.map((c) => (
              <div key={c.code} className="flex" style={{ gap: 6 }}>
                <input
                  style={{ width: 130 }}
                  value={c.name}
                  disabled={!canEdit}
                  onChange={(e) => mutateCategories((cats) => {
                    const target = cats.find((x) => x.code === c.code);
                    if (target) target.name = e.target.value;
                  })}
                />
                <label className="flex" style={{ fontSize: 12 }}>
                  <input
                    type="radio"
                    name="defaultCategory"
                    checked={normalized.defaultCode === c.code}
                    disabled={!canEdit || !c.active}
                    onChange={() => {
                      setPricing((p) => (p ? { ...p, defaultCategory: c.code } : p));
                      setSaved(false);
                    }}
                  />
                  {t('settings.category_default', 'Default')}
                </label>
                {canEdit ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => mutateCategories((cats) => {
                      const target = cats.find((x) => x.code === c.code);
                      if (target) target.active = !target.active;
                    })}
                  >
                    {c.active ? t('status.inactive', 'Archive') : t('status.active', 'Reactivate')}
                  </button>
                ) : null}
              </div>
            ))}
            {canEdit ? (
              <div className="flex" style={{ gap: 6 }}>
                <input
                  style={{ width: 130 }}
                  placeholder={t('settings.category_add', 'Add category')}
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                />
                <button className="btn btn-secondary btn-sm" disabled={!newCatName.trim()} onClick={addCategory}>
                  +
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>{t('settings.price_master', 'Product price master')} ({currency})</h2>
          <div className="spacer" />
          <span className="muted">v{pricingQ.data?.version ?? 0}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.product', 'Product')}</th>
                {normalized.categories.filter((c) => c.active).map((c) => (
                  <th key={c.code} className="num">
                    {t(`sales.cat_${c.code}`, c.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(items.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  {normalized.categories.filter((c) => c.active).map((c) => (
                    <td key={c.code} className="num" style={{ width: 140 }}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={!canEdit}
                        value={pricing.prices[i.id]?.[c.code] ?? ''}
                        onChange={(e) => setPrice(i.id, c.code, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('settings.vat_config', 'VAT configuration')}</h2>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            <Field label={t('settings.vat_status', 'VAT status')}>
              <select value={vatEnabled ? '1' : '0'} disabled={!canEdit} onChange={(e) => setVatEnabled(e.target.value === '1')}>
                <option value="1">{t('settings.enabled', 'Enabled')}</option>
                <option value="0">{t('settings.disabled', 'Disabled')}</option>
              </select>
            </Field>
            <Field label={t('settings.vat_rate', 'VAT rate %')}>
              <input type="number" min="0" step="any" value={vatRate} disabled={!canEdit} onChange={(e) => setVatRate(e.target.value)} />
            </Field>
            <Field label={t('settings.custom_price', 'Custom price')}>
              <input value={t('settings.requires_approval', 'Requires approval')} readOnly />
            </Field>
            <Field label={t('sales.discount', 'Discount')}>
              <input value={t('settings.requires_approval', 'Requires approval')} readOnly />
            </Field>
          </div>
          {canEdit ? (
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => void save()}>
                {t('settings.save_pricing', 'Save pricing')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface TranslationRow {
  key: string;
  module: string | null;
  en: string;
  overrides: Array<{ language: string; text: string; status: string }>;
}

/** Dynamic language manager: add languages, rename, direction, archive. */
function LanguageManager() {
  const { t, can, refresh } = useAuth();
  const canEdit = can('settings', 'edit');
  const qc = useQueryClient();
  const langs = useQuery({
    queryKey: ['languages', 'all'],
    queryFn: () =>
      api.get<Array<{ id: string; code: string; name: string; nativeName: string | null; direction: string; enabled: boolean }>>(
        '/api/languages?includeDisabled=true',
      ),
  });
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [nativeName, setNativeName] = useState('');
  const [code, setCode] = useState('');
  const [direction, setDirection] = useState<'ltr' | 'rtl'>('ltr');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const display = nativeName.trim() ? `${nativeName.trim()} (${name.trim()})` : name.trim();
      await api.post('/api/languages', {
        code: code.trim(),
        name: display,
        nativeName: nativeName.trim() || undefined,
        direction,
      });
      setName('');
      setNativeName('');
      setCode('');
      setDirection('ltr');
      await qc.invalidateQueries({ queryKey: ['languages'] });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(id: string, enabled: boolean) {
    setError(null);
    try {
      await api.patch(`/api/languages/${id}`, { enabled });
      await qc.invalidateQueries({ queryKey: ['languages'] });
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  // permanent delete — the server allows it only for a never-used language
  // (no users, no translations); English is always protected
  async function delLanguage(id: string) {
    if (!window.confirm(t('settings.lang_delete_confirm', 'Permanently delete this unused language?'))) return;
    setError(null);
    try {
      await api.del(`/api/languages/${id}`);
      await qc.invalidateQueries({ queryKey: ['languages'] });
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('settings.add_language', 'Add language')}</h2>
        <div className="spacer" />
        <span className="muted">
          {t('settings.lang_archive_note', 'Languages with translations are archived, never deleted. English stays as the fallback.')}
        </span>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        {canEdit ? (
          <div className="form-grid">
            <Field label={t('settings.lang_name', 'Language name')} required>
              <input value={name} placeholder="Afaan Oromo" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('settings.lang_native', 'Native name')}>
              <input value={nativeName} placeholder="Afaan Oromoo" onChange={(e) => setNativeName(e.target.value)} />
            </Field>
            <Field label={t('settings.lang_code', 'Standard code')} required>
              <input value={code} placeholder="om" onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label={t('settings.lang_direction', 'Direction')}>
              <select value={direction} onChange={(e) => setDirection(e.target.value as 'ltr' | 'rtl')}>
                <option value="ltr">LTR</option>
                <option value="rtl">RTL</option>
              </select>
            </Field>
            <div className="field">
              <label>&nbsp;</label>
              <button className="btn btn-primary" disabled={busy || !name.trim() || !code.trim()} onClick={() => void add()}>
                + {t('settings.add_language', 'Add language')}
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex mt" style={{ flexWrap: 'wrap' }}>
          {(langs.data ?? []).map((l) => (
            <div key={l.id} className="flex" style={{ gap: 6 }}>
              <span className={`badge ${l.enabled ? 'badge-blue' : 'badge-gray'}`}>
                {l.name} · {l.code} · {l.direction.toUpperCase()}
              </span>
              {canEdit && l.code !== 'en' ? (
                <button className="btn btn-secondary btn-sm" onClick={() => void setEnabled(l.id, !l.enabled)}>
                  {l.enabled ? t('status.inactive', 'Archive') : t('status.active', 'Reactivate')}
                </button>
              ) : null}
              {canEdit && l.code !== 'en' ? (
                <button className="btn btn-danger btn-sm" onClick={() => void delLanguage(l.id)}>
                  {t('settings.wh_delete', 'Delete permanently')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TranslationsTab() {
  const { t, languages, can, refresh } = useAuth();
  const canEdit = can('settings', 'edit');
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ['translations'],
    queryFn: () => api.get<{ rows: TranslationRow[] }>('/api/translations'),
  });
  const [moduleFilter, setModuleFilter] = useState('');
  const [search, setSearch] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const editable = languages.filter((l) => l.code !== 'en');

  const rows = (data.data?.rows ?? []).filter(
    (r) =>
      (!moduleFilter || r.module === moduleFilter) &&
      (!search || r.key.includes(search) || r.en.toLowerCase().includes(search.toLowerCase())),
  );
  const modules = [...new Set((data.data?.rows ?? []).map((r) => r.module).filter(Boolean))] as string[];

  async function saveAll() {
    setError(null);
    try {
      for (const [k, text] of Object.entries(edits)) {
        const [key, language] = k.split('||');
        await api.put('/api/translations', { key, language, text, status: 'active' });
      }
      setEdits({});
      await qc.invalidateQueries({ queryKey: ['translations'] });
      await refresh();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorBox error={error} />
      <div className="page-info">
        {t('settings.i18n_note', 'English is the base language. Missing translations fall back to English. Changing labels never changes business data.')}
      </div>
      <LanguageManager />
      <div className="panel">
        <div className="panel-head">
          <div className="filters">
            <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
              <option value="">{t('settings.all_modules', 'All modules')}</option>
              {modules.map((mo) => (
                <option key={mo} value={mo}>
                  {mo}
                </option>
              ))}
            </select>
            <input placeholder={t('shell.search', 'Search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="spacer" />
          {canEdit ? (
            <button className="btn btn-primary btn-sm" disabled={!Object.keys(edits).length} onClick={() => void saveAll()}>
              {t('settings.save_translations', 'Save translations')}
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('settings.key', 'Key')}</th>
                <th>{t('settings.english_base', 'English base')}</th>
                {editable.map((l) => (
                  <th key={l.code}>
                    {l.name} ({t('settings.editable', 'editable')})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.key}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {r.key}
                  </td>
                  <td>{r.en}</td>
                  {editable.map((l) => {
                    const existing = r.overrides.find((o) => o.language === l.code);
                    const editKey = `${r.key}||${l.code}`;
                    const isPlaceholder = existing?.status === 'placeholder';
                    return (
                      <td key={l.code}>
                        <div className="flex">
                          <input
                            style={{ minWidth: 140 }}
                            disabled={!canEdit}
                            value={edits[editKey] ?? existing?.text ?? ''}
                            placeholder={r.en}
                            onChange={(e) => setEdits((x) => ({ ...x, [editKey]: e.target.value }))}
                          />
                          {isPlaceholder && !(editKey in edits) ? <StatusBadge status="placeholder" /> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Documents & Branding: company details, logos/stamps, page setup. */
function DocumentsTab() {
  const { t, can, tenant } = useAuth();
  const canEdit = can('settings', 'edit');
  const qc = useQueryClient();
  const brandingQ = useQuery({
    queryKey: ['settings', 'branding'],
    queryFn: () => api.get<{ version: number; data: Record<string, unknown> }>('/api/settings/branding'),
  });
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const data = draft ?? brandingQ.data?.data ?? {};
  const assets = (data.assets ?? {}) as Record<string, string>;

  function set(key: string, value: unknown) {
    setDraft({ ...data, [key]: value });
    setSaved(false);
  }

  async function save() {
    setError(null);
    try {
      await api.put('/api/settings/branding', { data });
      setSaved(true);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['settings', 'branding'] });
      await qc.invalidateQueries({ queryKey: ['ui-config'] });
    } catch (err) {
      setError(err);
    }
  }

  async function upload(kind: string, file: File) {
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await api.post<{ path: string }>('/api/branding-asset', { kind, dataUrl });
      if (kind !== 'logo') {
        const nextAssets = { ...assets, [kind]: res.path };
        await api.put('/api/settings/branding', { data: { ...data, assets: nextAssets } });
      }
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
    }
  }

  const field = (key: string, labelKey: string, fallback: string) => (
    <Field label={t(labelKey, fallback)}>
      <input value={String(data[key] ?? '')} disabled={!canEdit} onChange={(e) => set(key, e.target.value)} />
    </Field>
  );

  return (
    <div>
      <ErrorBox error={error} />
      {saved ? <div className="page-info">{t('settings.saved', 'Saved. Settings change future behavior only.')}</div> : null}
      <div className="page-info">{t('branding.immutable_note', 'Changing branding or templates never changes transaction data. Documents always show current branding with their original immutable values.')}</div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('branding.company_details', 'Company details on documents')}</h2>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            {field('companyName', 'settings.company_name', 'Company name')}
            {field('address', 'branding.address', 'Address')}
            {field('phone', 'branding.phone', 'Phone')}
            {field('email', 'branding.email', 'Email')}
            {field('tin', 'branding.tin', 'TIN / tax number')}
            {field('headerNote', 'branding.header_note', 'Document header note')}
            {field('footerNote', 'branding.footer_note', 'Document footer note')}
            <Field label={t('branding.page_size', 'Page size')}>
              <select value={String(data.pageSize ?? 'A4')} disabled={!canEdit} onChange={(e) => set('pageSize', e.target.value)}>
                <option value="A4">A4</option>
                <option value="Letter">Letter</option>
              </select>
            </Field>
          </div>
          {canEdit ? (
            <div className="form-actions">
              <button className="btn btn-primary" disabled={draft === null} onClick={() => void save()}>
                {t('settings.save', 'Save settings')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('branding.assets', 'Logos & signatures')}</h2>
        </div>
        <div className="panel-body">
          <div className="form-grid">
            {(['logo', 'logo2', 'stamp', 'signature'] as const).map((kind) => {
              const current = kind === 'logo' ? tenant?.logoPath : assets[kind];
              return (
                <div key={kind} className="field">
                  <label>{t(`branding.${kind}`, kind)}</label>
                  <div className="flex">
                    {current ? (
                      <img src={current} alt="" style={{ height: 44, borderRadius: 6, border: '1px solid var(--border)' }} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {canEdit ? (
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void upload(kind, f);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="form-actions">
            <a className="btn btn-secondary" href="/print/invoice/sample" onClick={(e) => e.preventDefault()} style={{ display: 'none' }}>
              hidden
            </a>
            <PreviewButton />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Opens the most recent invoice (or any printable doc) as a live preview. */
function PreviewButton() {
  const { t } = useAuth();
  const invoices = useQuery({
    queryKey: ['invoices', ''],
    queryFn: () => api.get<Array<{ id: string }>>('/api/invoices'),
    retry: false,
  });
  const target = invoices.data?.[0];
  if (!target) return null;
  return (
    <a className="btn btn-secondary" href={`/print/invoice/${target.id}`}>
      {t('branding.preview', 'Preview sample document')}
    </a>
  );
}

interface SequenceRow {
  seqKey: string;
  prefix: string;
  padding: number;
  nextValue: number;
}

function NumberingTab() {
  const { t, can } = useAuth();
  const canEdit = can('settings', 'edit');
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['sequences'], queryFn: () => api.get<SequenceRow[]>('/api/sequences') });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  async function save(seqKey: string) {
    setError(null);
    try {
      await api.put('/api/sequences', { seqKey, prefix: edits[seqKey] });
      setEdits((x) => {
        const { [seqKey]: _drop, ...rest } = x;
        return rest;
      });
      await qc.invalidateQueries({ queryKey: ['sequences'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('settings.tab_numbering', 'Document numbering')}</h2>
      </div>
      <div className="panel-body">
        <ErrorBox error={error} />
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('settings.sequence', 'Sequence')}</th>
                <th>{t('settings.prefix', 'Prefix')}</th>
                <th className="num">{t('settings.next', 'Next number')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data.data ?? []).map((s) => (
                <tr key={s.seqKey}>
                  <td>
                    {t(`seq.${s.seqKey}`, s.seqKey)}{' '}
                    <span className="muted mono" style={{ fontSize: 11 }}>
                      {s.seqKey}
                    </span>
                  </td>
                  <td style={{ width: 160 }}>
                    <input
                      value={edits[s.seqKey] ?? s.prefix}
                      disabled={!canEdit}
                      onChange={(e) => setEdits((x) => ({ ...x, [s.seqKey]: e.target.value }))}
                    />
                  </td>
                  <td className="num mono">
                    {s.prefix}
                    {String(s.nextValue).padStart(s.padding, '0')}
                  </td>
                  <td>
                    {canEdit && edits[s.seqKey] != null && edits[s.seqKey] !== s.prefix ? (
                      <button className="btn btn-primary btn-sm" onClick={() => void save(s.seqKey)}>
                        {t('settings.save', 'Save settings')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
