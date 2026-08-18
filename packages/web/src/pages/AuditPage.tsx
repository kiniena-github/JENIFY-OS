import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MODULES } from '@factoryos/shared';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, Modal } from '../components/ui.js';
import * as fmt from '../lib/format.js';

interface AuditRow {
  id: string;
  userId: string | null;
  module: string;
  action: string;
  entity: string | null;
  reference: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  result: string;
  createdAt: string;
}

/**
 * User-facing audit category: derived from the technical module + entity so
 * e.g. empty-sack sales and raw receiving are not buried under "inventory".
 */
function categoryOf(row: AuditRow): string {
  if (row.entity === 'goods_receipt') return 'receiving';
  if (row.entity === 'simple_transaction') return 'sacks';
  if (row.entity === 'tenant_language' || row.action === 'translation_edit') return 'settings';
  return row.module;
}

const CATEGORY_ORDER = [
  'receiving',
  'inventory',
  'production',
  'quality',
  'parties',
  'sales',
  'credit',
  'payments',
  'delivery',
  'sacks',
  'reports',
  'users',
  'settings',
  'dashboard',
] as const;

export default function AuditPage() {
  const { t } = useAuth();
  usePageTitle(t('nav.audit', 'Audit Log'), t('audit.subtitle', 'Immutable trace of important stock, financial, security, and configuration events'));
  const [category, setCategory] = useState('');
  const [scope, setScope] = useState<'operational' | 'system' | 'all'>('operational');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [viewing, setViewing] = useState<AuditRow | null>(null);
  const pageSize = 50;

  const query = new URLSearchParams();
  // category maps to module/entity filters understood by the API
  if (category === 'receiving') {
    query.set('entity', 'goods_receipt');
  } else if (category === 'sacks') {
    query.set('entity', 'simple_transaction');
  } else if (category) {
    query.set('module', category);
  }
  query.set('scope', scope);
  if (search.trim()) query.set('search', search.trim());
  if (from) query.set('from', `${from}T00:00:00`);
  if (to) query.set('to', `${to}T23:59:59`);
  query.set('limit', String(pageSize));
  query.set('offset', String(page * pageSize));

  const { data } = useQuery({
    queryKey: ['audit', query.toString()],
    queryFn: () => api.get<{ rows: AuditRow[]; count: number }>(`/api/audit?${query.toString()}`),
  });

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Array<{ id: string; displayName: string }>>('/api/users'),
    retry: false,
  });
  const userName = (id: string | null) =>
    id ? (users.data?.find((u) => u.id === id)?.displayName ?? id.slice(0, 8)) : t('audit.system', 'System');
  const actionLabel = (action: string) =>
    t(`audit.action.${action}`, action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

  return (
    <div>
      <div className="cards">
        <StatCard label={t('audit.total', 'Events (filtered)')} value={data?.count ?? '—'} />
        <StatCard
          label={t('audit.scope_operational', 'Operational audit')}
          value={
            <select value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setPage(0); }} style={{ font: 'inherit', fontSize: 15 }}>
              <option value="operational">{t('audit.scope_operational', 'Operational audit')}</option>
              <option value="system">{t('audit.scope_system', 'System / technical activity')}</option>
              <option value="all">{t('audit.scope_all', 'Everything')}</option>
            </select>
          }
        />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="filters">
            <input
              style={{ minWidth: 220 }}
              placeholder={t('audit.search_hint', 'Search reference, user, action or text')}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setSearch(searchDraft);
                  setPage(0);
                }
              }}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSearch(searchDraft);
                setPage(0);
              }}
            >
              {t('shell.search', 'Search')}
            </button>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(0);
              }}
            >
              <option value="">{t('audit.all_modules', 'All modules')}</option>
              {CATEGORY_ORDER.filter((c) => (MODULES as readonly string[]).includes(c) || c === 'receiving' || c === 'sacks').map(
                (c) => (
                  <option key={c} value={c}>
                    {t(`audit.cat.${c}`, c)}
                  </option>
                ),
              )}
            </select>
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
            <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </div>
          <div className="spacer" />
          <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ←
          </button>
          <span className="muted">
            {page + 1} / {Math.max(1, Math.ceil((data?.count ?? 0) / pageSize))}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={(page + 1) * pageSize >= (data?.count ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            →
          </button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('audit.datetime', 'Date / time')}</th>
                <th>{t('users.user', 'User')}</th>
                <th>{t('roles.module', 'Module')}</th>
                <th>{t('audit.action', 'Action')}</th>
                <th>{t('dashboard.reference', 'Reference')}</th>
                <th>{t('audit.summary', 'Change summary')}</th>
                <th>{t('audit.result', 'Result')}</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setViewing(r)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(r.createdAt)}</td>
                  <td>{userName(r.userId)}</td>
                  <td>
                    <span className="badge badge-gray">{t(`audit.cat.${categoryOf(r)}`, categoryOf(r))}</span>
                  </td>
                  <td>{actionLabel(r.action)}</td>
                  <td className="mono">{r.reference ?? '—'}</td>
                  <td>
                    {r.summary}
                    {r.reason ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {t('audit.reason', 'Reason')}: {r.reason}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${r.result === 'success' ? 'badge-green' : 'badge-red'}`}>{r.result}</span>
                  </td>
                </tr>
              ))}
              {data?.rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="table-empty">
                    {t('audit.none', 'No events in this range.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {viewing ? (
        <Modal title={`${actionLabel(viewing.action)} — ${viewing.reference ?? ''}`} onClose={() => setViewing(null)} wide>
          <div className="form-grid">
            <div>
              <div className="card-label">{t('audit.summary', 'Change summary')}</div>
              <div>{viewing.summary}</div>
            </div>
            <div>
              <div className="card-label">{t('users.user', 'User')}</div>
              <div>{userName(viewing.userId)}</div>
            </div>
            {viewing.reason ? (
              <div>
                <div className="card-label">{t('audit.reason', 'Reason')}</div>
                <div>{viewing.reason}</div>
              </div>
            ) : null}
          </div>
          {viewing.before != null || viewing.after != null ? (
            <div className="form-grid mt" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div className="card-label">{t('audit.before', 'Before')}</div>
                <pre style={{ background: 'var(--bg)', padding: 10, borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>
                  {JSON.stringify(viewing.before, null, 2) ?? '—'}
                </pre>
              </div>
              <div>
                <div className="card-label">{t('audit.after', 'After')}</div>
                <pre style={{ background: 'var(--bg)', padding: 10, borderRadius: 6, fontSize: 12, overflowX: 'auto' }}>
                  {JSON.stringify(viewing.after, null, 2) ?? '—'}
                </pre>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
