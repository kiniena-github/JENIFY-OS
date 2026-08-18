import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatusBadge, ErrorBox, Field } from '../components/ui.js';
import { useItems, useWarehouses } from '../lib/queries.js';

type Tab = 'general' | 'warehouses' | 'pricing' | 'translations' | 'numbering';

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
  ];
  return (
    <div>
      <div className="flex" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {tabs.map(([id, key, fallback]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(id)}>
            {t(key, fallback)}
          </button>
        ))}
      </div>
      {tab === 'general' ? (
        <>
          <GeneralTab />
          <QualityConfigPanel />
        </>
      ) : null}
      {tab === 'warehouses' ? <WarehousesTab /> : null}
      {tab === 'pricing' ? <PricingTab /> : null}
      {tab === 'translations' ? <TranslationsTab /> : null}
      {tab === 'numbering' ? <NumberingTab /> : null}
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
function QualityConfigPanel() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('settings', 'edit');
  const prodQ = useQuery({
    queryKey: ['settings', 'production'],
    queryFn: () =>
      api.get<{ version: number; data: { iodization?: { targetPpm?: string } } }>(
        '/api/settings/production',
      ),
  });
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const effective = target ?? prodQ.data?.data.iodization?.targetPpm ?? '';

  async function save() {
    setError(null);
    try {
      const data = { ...(prodQ.data?.data ?? {}) };
      data.iodization = { ...(data.iodization ?? {}), targetPpm: effective };
      await api.put('/api/settings/production', { data });
      setSaved(true);
      setTarget(null);
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
            label={t('settings.quality_target', 'Target iodine level (ppm)')}
            hint={t(
              'settings.quality_note',
              'Used as the default target on new quality tests. Tests already recorded keep the target that applied at the time.',
            )}
          >
            <input value={effective} disabled={!canEdit} onChange={(e) => setTarget(e.target.value)} />
          </Field>
        </div>
        {canEdit ? (
          <div className="form-actions">
            <button className="btn btn-primary" disabled={target === null} onClick={() => void save()}>
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
  const warehouses = useWarehouses();
  const canEdit = can('settings', 'edit');
  const [error, setError] = useState<unknown>(null);
  const [edits, setEdits] = useState<Record<string, { name: string; locationNote: string }>>({});

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
        {t('settings.warehouse_note', 'Stock balances are never edited here — they come from approved movements only.')}
      </div>
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
              {canEdit && dirty ? (
                <button className="btn btn-primary btn-sm mt" onClick={() => void save(w.id)}>
                  {t('settings.save', 'Save settings')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PricingData {
  categories: string[];
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

  if (!pricing) return <div className="centered-page">Loading…</div>;

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
          <h2>{t('settings.price_master', 'Product price master')} ({currency})</h2>
          <div className="spacer" />
          <span className="muted">v{pricingQ.data?.version ?? 0}</span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.product', 'Product')}</th>
                {pricing.categories.map((c) => (
                  <th key={c} className="num">
                    {t(`sales.cat_${c}`, c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(items.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  {pricing.categories.map((c) => (
                    <td key={c} className="num" style={{ width: 140 }}>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        disabled={!canEdit}
                        value={pricing.prices[i.id]?.[c] ?? ''}
                        onChange={(e) => setPrice(i.id, c, e.target.value)}
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
                  <td className="mono">{s.seqKey}</td>
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
