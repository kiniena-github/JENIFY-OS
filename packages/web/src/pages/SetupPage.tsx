import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { ErrorBox, Field } from '../components/ui.js';
import { useItems, useStages, useWarehouses } from '../lib/queries.js';

/**
 * FactoryOS first-time tenant setup — a reusable, config-driven guided flow.
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
  usePageTitle(t('setup.title', 'Factory setup'), t('setup.subtitle', 'Guided first-time configuration — everything stays editable in Settings'));
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
  const items = useItems();
  return (
    <Panel
      title={t('setup.step_items', 'Items / Products / Units')}
      hint={t('setup.config_pkg', 'Provisioned by the factory configuration package')}
    >
      <p style={{ maxWidth: 640 }}>
        {t(
          'setup.items_desc',
          'Raw materials, finished products, pack sizes and units of measure are provisioned by the factory configuration package so physics (base units, pack weights, lot tracking) stay consistent. Current catalogue:',
        )}
      </p>
      <div className="flex" style={{ flexWrap: 'wrap' }}>
        {(items.data ?? []).map((i) => (
          <span key={i.id} className={`badge ${i.kind === 'finished_good' ? 'badge-green' : 'badge-gray'}`}>
            {i.name}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function ProductionStep() {
  const { t } = useAuth();
  const stages = useStages();
  return (
    <Panel
      title={t('setup.step_production', 'Production template')}
      hint={t('setup.config_pkg', 'Provisioned by the factory configuration package')}
    >
      <p style={{ maxWidth: 640 }}>
        {t(
          'setup.production_desc',
          'The stage chain defines how material flows and which stage conserves, measures, or converts quantity, and where the quality gate sits. Configured chain:',
        )}
      </p>
      <div className="flex" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        {(stages.data ?? []).map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 ? <span className="muted">→</span> : null}
            <span className="badge badge-blue">
              {t(s.nameKey, s.code)}
              {s.requiresQc ? ' · QC' : ''}
              {s.outputPolicy === 'conserved' ? ` · ${t('production.conserved', 'Conserved')}` : ''}
            </span>
          </React.Fragment>
        ))}
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
