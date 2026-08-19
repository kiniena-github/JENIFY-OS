import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { ErrorBox, Field, StatusBadge } from '../components/ui.js';
import { useItems, useStages, useWarehouses } from '../lib/queries.js';

/**
 * JENIFY OS first-time tenant setup — a reusable, config-driven guided flow.
 * Every step writes through the SAME settings/master-data APIs the normal
 * Settings screens use, so nothing here is Mesob-specific and everything
 * remains editable later. The wizard never forces itself on an already
 * configured tenant; it is simply a guided path through the configuration.
 */

const STEPS = [
  ['company', 'Company'],
  ['branding', 'Branding'],
  ['languages', 'Languages'],
  ['structure', 'Factory structure'],
  ['items', 'Items / Products / Units'],
  ['production', 'Production template'],
  ['commercial', 'Commercial'],
  ['roles', 'Roles & Permissions'],
  ['staff', 'Owner / Staff accounts'],
  ['review', 'Review & Go Live'],
] as const;
type StepId = (typeof STEPS)[number][0];

export default function SetupPage() {
  const { t, can } = useAuth();
  usePageTitle(t('setup.title', 'JENIFY OS Setup'), t('setup.subtitle', 'Guided first-time configuration — everything stays editable in Settings'));
  const [step, setStep] = useState<StepId>('company');
  const idx = STEPS.findIndex(([id]) => id === step);
  if (!can('settings', 'edit')) {
    return <div className="page-error">{t('setup.owner_only', 'Factory setup requires settings permission.')}</div>;
  }
  return (
    <div>
      <div className="flex" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 6 }}>
        {STEPS.map(([id, label], i) => (
          <button
            key={id}
            className={`btn btn-sm ${step === id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStep(id)}
          >
            {i + 1}. {t(`setup.step_${id}`, label)}
          </button>
        ))}
      </div>
      {step === 'company' ? <CompanyStep /> : null}
      {step === 'branding' ? <BrandingStep /> : null}
      {step === 'languages' ? <LanguagesStep /> : null}
      {step === 'structure' ? <StructureStep /> : null}
      {step === 'items' ? <ItemsStep /> : null}
      {step === 'production' ? <ProductionStep /> : null}
      {step === 'commercial' ? <CommercialStep /> : null}
      {step === 'roles' ? <LinkStep title={t('setup.step_roles', 'Roles & Permissions')} desc={t('setup.roles_desc', 'Review the editable permission matrix for every role. The owner can change access at any time without code changes.')} to="/users" label={t('nav.users', 'Users & Roles')} /> : null}
      {step === 'staff' ? <LinkStep title={t('setup.step_staff', 'Owner / Staff accounts')} desc={t('setup.staff_desc', 'Create staff accounts and assign roles. There is deliberately no public sign-up — factory admins control every account. Generate emergency recovery codes for each Owner.')} to="/users" label={t('users.add', 'Add user')} /> : null}
      {step === 'review' ? <ReviewStep /> : null}
      <div className="flex mt no-print">
        <button className="btn btn-secondary btn-sm" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1][0])}>
          ← {t('setup.prev', 'Previous')}
        </button>
        <div className="spacer" />
        <button
          className="btn btn-primary btn-sm"
          disabled={idx === STEPS.length - 1}
          onClick={() => setStep(STEPS[idx + 1][0])}
        >
          {t('setup.next', 'Next step')} →
        </button>
      </div>
    </div>
  );
}

function Panel({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {hint ? (
          <>
            <div className="spacer" />
            <span className="muted">{hint}</span>
          </>
        ) : null}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

function LinkStep({ title, desc, to, label }: { title: string; desc: string; to: string; label: string }) {
  return (
    <Panel title={title}>
      <p style={{ maxWidth: 640 }}>{desc}</p>
      <Link className="btn btn-primary btn-sm" to={to}>
        {label} →
      </Link>
    </Panel>
  );
}

function CompanyStep() {
  const { t, tenant, refresh } = useAuth();
  const [name, setName] = useState(tenant?.name ?? '');
  const [locationNote, setLocationNote] = useState(tenant?.locationNote ?? '');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  async function save() {
    setError(null);
    try {
      await api.patch('/api/tenant', { name, locationNote });
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Panel
      title={t('setup.step_company', 'Company')}
      hint={t('setup.company_hint', 'TIN, contacts and document identity live in Documents & Branding')}
    >
      <ErrorBox error={error} />
      {saved ? <div className="page-info">{t('settings.saved', 'Saved.')}</div> : null}
      <div className="form-grid">
        <Field label={t('settings.company_name', 'Factory name')} required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('settings.location_note', 'Address / location')}>
          <input value={locationNote} onChange={(e) => setLocationNote(e.target.value)} />
        </Field>
        <Field label={t('settings.currency', 'Currency')}>
          <input value={tenant?.currency ?? ''} readOnly />
        </Field>
        <Field label={t('settings.timezone', 'Timezone')}>
          <input value={tenant?.timezone ?? ''} readOnly />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void save()}>
          {t('settings.save', 'Save settings')}
        </button>
      </div>
    </Panel>
  );
}

function BrandingStep() {
  const { t } = useAuth();
  return (
    <Panel title={t('setup.step_branding', 'Branding')}>
      <p style={{ maxWidth: 640 }}>
        {t(
          'setup.branding_desc',
          'The company logo drives the sign-in screen, the sidebar, and every printed document. Upload logos, stamp and signature, and set document header/footer text in Documents & Branding. Old documents always keep the branding they were issued with.',
        )}
      </p>
      <Link className="btn btn-primary btn-sm" to="/settings">
        {t('settings.tab_documents', 'Documents & Branding')} →
      </Link>
    </Panel>
  );
}

function LanguagesStep() {
  const { t } = useAuth();
  const langs = useQuery({
    queryKey: ['languages'],
    queryFn: () => api.get<Array<{ code: string; name: string }>>('/api/languages'),
  });
  return (
    <Panel title={t('setup.step_languages', 'Languages')}>
      <p style={{ maxWidth: 640 }}>
        {t(
          'setup.languages_desc',
          'English is the base and fallback. Add any working language; every label stays editable per language, and missing translations fall back to English automatically.',
        )}
      </p>
      <div className="flex" style={{ flexWrap: 'wrap' }}>
        {(langs.data ?? []).map((l) => (
          <span key={l.code} className="badge badge-blue">
            {l.name}
          </span>
        ))}
      </div>
      <Link className="btn btn-primary btn-sm mt" to="/settings">
        {t('settings.tab_translations', 'Languages & Translations')} →
      </Link>
    </Panel>
  );
}

function StructureStep() {
  const { t } = useAuth();
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function add() {
    setError(null);
    try {
      await api.post('/api/warehouses', { code: code.trim(), name: name.trim() });
      setCode('');
      setName('');
      await qc.invalidateQueries({ queryKey: ['warehouses'] });
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Panel title={t('setup.step_structure', 'Factory structure')}>
      <ErrorBox error={error} />
      <div className="flex" style={{ flexWrap: 'wrap' }}>
        {(warehouses.data ?? []).map((w) => (
          <span key={w.id} className="badge badge-gray">
            {w.code} — {w.name}
          </span>
        ))}
      </div>
      <div className="form-grid mt">
        <Field label={t('settings.code', 'Code')} required>
          <input value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label={t('settings.name', 'Name')} required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn btn-primary" disabled={!code.trim() || !name.trim()} onClick={() => void add()}>
            + {t('settings.add_warehouse', 'Add warehouse')}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function ItemsStep() {
  const { t } = useAuth();
  const qc = useQueryClient();
  const items = useItems();
  const uoms = useQuery({
    queryKey: ['uoms'],
    queryFn: () => api.get<Array<{ id: string; code: string; name: string; family: string }>>('/api/uoms'),
  });
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'raw_material' | 'finished_good' | 'consumable'>('finished_good');
  const [baseUomId, setBaseUomId] = useState('');
  const [unitWeight, setUnitWeight] = useState('');
  const [sellable, setSellable] = useState(true);

  async function add() {
    setError(null);
    try {
      await api.post('/api/items', {
        code: code.trim(),
        name: name.trim(),
        kind,
        trackingMode: kind === 'consumable' ? 'none' : 'lot',
        baseUomId,
        unitWeightKg: unitWeight ? Number(unitWeight) : undefined,
        sellable,
        purchasable: kind === 'raw_material',
      });
      setCode('');
      setName('');
      setUnitWeight('');
      await qc.invalidateQueries({ queryKey: ['items'] });
    } catch (err) {
      setError(err);
    }
  }

  async function patchItem(id: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.patch(`/api/items/${id}`, patch);
      await qc.invalidateQueries({ queryKey: ['items'] });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Panel title={t('setup.step_items', 'Items / Products / Units')}>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('settings.code', 'Code')}</th>
              <th>{t('settings.name', 'Name')}</th>
              <th>{t('setup.item_kind', 'Type')}</th>
              <th>{t('setup.unit_weight', 'Unit weight (kg)')}</th>
              <th>{t('setup.sellable', 'Sellable')}</th>
              <th>{t('shell.status', 'Status')}</th>
              <th>{t('shell.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {(items.data ?? []).map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.code}</td>
                <td>
                  <input
                    defaultValue={i.name}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== i.name) {
                        void patchItem(i.id, { name: e.target.value.trim() });
                      }
                    }}
                  />
                </td>
                <td>{t(`setup.kind_${i.kind}`, i.kind.replace('_', ' '))}</td>
                <td>{i.unitWeightMilliKg != null ? i.unitWeightMilliKg / 1000 : '\u2014'}</td>
                <td>
                  <input type="checkbox" checked={i.sellable} onChange={() => void patchItem(i.id, { sellable: !i.sellable })} />
                </td>
                <td>
                  <StatusBadge status={i.active ? 'active' : 'inactive'} />
                </td>
                <td>
                  <button className="btn btn-secondary btn-sm" onClick={() => void patchItem(i.id, { active: !i.active })}>
                    {i.active ? t('status.inactive', 'Archive') : t('status.active', 'Reactivate')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-grid mt">
        <Field label={t('settings.code', 'Code')} required>
          <input value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label={t('settings.name', 'Name')} required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('setup.item_kind', 'Type')} required>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="raw_material">{t('setup.kind_raw_material', 'Raw material')}</option>
            <option value="finished_good">{t('setup.kind_finished_good', 'Finished product')}</option>
            <option value="consumable">{t('setup.kind_consumable', 'Side item / consumable')}</option>
          </select>
        </Field>
        <Field label={t('receiving.unit', 'Unit')} required>
          <select value={baseUomId} onChange={(e) => setBaseUomId(e.target.value)}>
            <option value="">{'\u2014'}</option>
            {(uoms.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('setup.unit_weight', 'Unit weight (kg)')}>
          <input type="number" min="0" step="any" value={unitWeight} onChange={(e) => setUnitWeight(e.target.value)} />
        </Field>
        <Field label={t('setup.sellable', 'Sellable')}>
          <select value={sellable ? '1' : '0'} onChange={(e) => setSellable(e.target.value === '1')}>
            <option value="1">{t('shell.yes', 'Yes')}</option>
            <option value="0">{t('shell.no', 'No')}</option>
          </select>
        </Field>
        <div className="field">
          <label>&nbsp;</label>
          <button className="btn btn-primary" disabled={!code.trim() || !name.trim() || !baseUomId} onClick={() => void add()}>
            + {t('setup.add_item', 'Add product')}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function ProductionStep() {
  const { t } = useAuth();
  const qc = useQueryClient();
  // include disabled stages so they can be re-enabled from the wizard
  const stages = useQuery({
    queryKey: ['stages', 'all'],
    queryFn: () =>
      api.get<
        Array<{
          id: string;
          code: string;
          nameKey: string;
          sequence: number;
          outputForm: string;
          outputPolicy: string;
          requiresQc: boolean;
          active: boolean;
        }>
      >('/api/stages?includeInactive=true'),
  });
  const [error, setError] = useState<unknown>(null);

  async function patchStage(id: string, patch: Record<string, unknown>) {
    setError(null);
    try {
      await api.patch(`/api/stages/${id}`, patch);
      await qc.invalidateQueries({ queryKey: ['stages'] });
    } catch (err) {
      setError(err);
    }
  }

  const ordered = [...(stages.data ?? [])].sort((a, b) => a.sequence - b.sequence);

  return (
    <Panel
      title={t('setup.step_production', 'Production template')}
      hint={t('setup.stage_hint', 'Order, physics policy, and the quality gate are configurable; history keeps its recorded numbers')}
    >
      <ErrorBox error={error} />
      <div className="flex" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {ordered
          .filter((st) => st.active !== false)
          .map((st, i) => (
            <React.Fragment key={st.id}>
              {i > 0 ? <span className="muted">{'\u2192'}</span> : null}
              <span className="badge badge-blue">
                {t(st.nameKey, st.code)}
                {st.requiresQc ? ' \u00b7 QC' : ''}
              </span>
            </React.Fragment>
          ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('setup.stage_order', 'Order')}</th>
              <th>{t('reports.stage', 'Stage')}</th>
              <th>{t('setup.stage_policy', 'Quantity policy')}</th>
              <th>{t('production.qc', 'Quality gate')}</th>
              <th>{t('shell.status', 'Status')}</th>
              <th>{t('shell.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((st) => (
              <tr key={st.id}>
                <td style={{ width: 90 }}>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    defaultValue={st.sequence}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isInteger(v) && v > 0 && v !== st.sequence) void patchStage(st.id, { sequence: v });
                    }}
                  />
                </td>
                <td>
                  {t(st.nameKey, st.code)} <span className="muted mono" style={{ fontSize: 11 }}></span>
                </td>
                <td>
                  {st.outputForm === 'packaged_items' ? (
                    <span className="badge badge-gray">{t('setup.policy_converted', 'Converted (units)')}</span>
                  ) : (
                    <select
                      value={st.outputPolicy}
                      onChange={(e) => void patchStage(st.id, { outputPolicy: e.target.value })}
                    >
                      <option value="measured">{t('setup.policy_measured', 'Measured (loss derived)')}</option>
                      <option value="conserved">{t('setup.policy_conserved', 'Conserved (output = input)')}</option>
                    </select>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={st.requiresQc}
                    onChange={() => void patchStage(st.id, { requiresQc: !st.requiresQc })}
                  />
                </td>
                <td>
                  <StatusBadge status={st.active !== false ? 'active' : 'inactive'} />
                </td>
                <td>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void patchStage(st.id, { active: !(st.active !== false) })}
                  >
                    {st.active !== false ? t('status.inactive', 'Disable') : t('status.active', 'Enable')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CommercialStep() {
  const { t } = useAuth();
  return (
    <Panel title={t('setup.step_commercial', 'Commercial')}>
      <p style={{ maxWidth: 640 }}>
        {t(
          'setup.commercial_desc',
          'Configure VAT, price categories with a default, custom-price approval, and document numbering prefixes. Numbering prefixes apply to future documents only — history is never renumbered.',
        )}
      </p>
      <Link className="btn btn-primary btn-sm" to="/settings">
        {t('settings.tab_pricing', 'Prices & VAT')} →
      </Link>
    </Panel>
  );
}

function ReviewStep() {
  const { t, tenant } = useAuth();
  const warehouses = useWarehouses();
  const items = useItems();
  const stages = useStages();
  return (
    <Panel title={t('setup.step_review', 'Review & Go Live')}>
      <table className="data" style={{ maxWidth: 560 }}>
        <tbody>
          <tr>
            <td>{t('settings.company_name', 'Factory name')}</td>
            <td>{tenant?.name}</td>
          </tr>
          <tr>
            <td>{t('settings.tab_warehouses', 'Warehouses')}</td>
            <td>{warehouses.data?.map((w) => w.code).join(' / ')}</td>
          </tr>
          <tr>
            <td>{t('setup.step_items', 'Items')}</td>
            <td>{items.data?.length ?? 0}</td>
          </tr>
          <tr>
            <td>{t('setup.step_production', 'Production stages')}</td>
            <td>{stages.data?.length ?? 0}</td>
          </tr>
        </tbody>
      </table>
      <div className="page-info mt" style={{ maxWidth: 640 }}>
        {t(
          'setup.golive_note',
          'Go-live starts from a FRESH production tenant: approved configuration only, zero test transactions. Real opening stock enters through proper opening documents — never fabricated history. Ask your administrator to run the "Initialize Fresh Production Tenant" provisioning step.',
        )}
      </div>
    </Panel>
  );
}
