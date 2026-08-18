import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MODULES, ACTIONS, EXTRA_ACTIONS, type PermissionMatrix, type ModuleId, type ActionId } from '@factoryos/shared';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatusBadge, ErrorBox, Field, Modal } from '../components/ui.js';
import * as fmt from '../lib/format.js';

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  roleId: string;
  roleName: string | null;
  language: string;
  active: boolean;
  lastLoginAt: string | null;
}

interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isOwnerRole: boolean;
  matrix: PermissionMatrix;
}

export default function UsersPage() {
  const { t } = useAuth();
  usePageTitle(t('nav.users', 'Users & Roles'), t('users.subtitle', 'Staff accounts and editable role permissions'));
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  return (
    <div>
      <div className="flex" style={{ marginBottom: 14 }}>
        <button className={`btn btn-sm ${tab === 'users' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('users')}>
          {t('users.tab_users', 'Users')}
        </button>
        <button className={`btn btn-sm ${tab === 'roles' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('roles')}>
          {t('users.tab_roles', 'Roles & Permissions')}
        </button>
      </div>
      {tab === 'users' ? <UsersTab /> : <RolesTab />}
    </div>
  );
}

function UsersTab() {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/api/roles') });
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canManage = can('users', 'manage_users');

  return (
    <div>
      <ErrorBox error={error} />
      <div className="panel">
        <div className="panel-head">
          <h2>{t('users.accounts', 'Staff accounts')}</h2>
          <div className="spacer" />
          {canManage ? (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              {t('users.add', 'Add user')}
            </button>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('users.user', 'User')}</th>
                <th>{t('users.username', 'Username')}</th>
                <th>{t('users.role', 'Role')}</th>
                <th>{t('users.last_login', 'Last login')}</th>
                <th>{t('shell.status', 'Status')}</th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className={canManage ? 'clickable' : undefined} onClick={() => canManage && setEditing(u)}>
                  <td>{u.displayName}</td>
                  <td className="mono">{u.username}</td>
                  <td>{u.roleName ?? '—'}</td>
                  <td>{fmt.dateTime(u.lastLoginAt)}</td>
                  <td>
                    <StatusBadge status={u.active ? 'active' : 'inactive'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editing ? (
        <UserModal
          user={editing === 'new' ? null : editing}
          roles={roles.data ?? []}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function UserModal({
  user,
  roles,
  onClose,
  onDone,
  onError,
}: {
  user: UserRow | null;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState(user?.roleId ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [active, setActive] = useState(user?.active ?? true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api.patch(`/api/users/${user.id}`, { displayName, roleId, email, phone, active });
        if (password) await api.post(`/api/users/${user.id}/reset-password`, { password });
      } else {
        await api.post('/api/users', { username, displayName, password, roleId, email, phone });
      }
      onDone();
    } catch (err) {
      setError(err);
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? user.displayName : t('users.add', 'Add user')} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label={t('users.display_name', 'Full name')} required>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={t('users.username', 'Username')} required>
          <input value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field
          label={user ? t('users.new_password', 'New password (optional)') : t('users.password', 'Password')}
          required={!user}
        >
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={t('users.role', 'Role')} required>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">—</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('users.email', 'Email')}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t('customers.phone', 'Phone')}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {user ? (
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
        <button
          className="btn btn-primary"
          disabled={busy || !displayName || !roleId || (!user && (!username || !password))}
          onClick={() => void save()}
        >
          {t('users.save', 'Save user')}
        </button>
      </div>
    </Modal>
  );
}

function RolesTab() {
  const { t, can, refresh } = useAuth();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/api/roles') });
  const [roleId, setRoleId] = useState('');
  const [draft, setDraft] = useState<PermissionMatrix | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const canManage = can('users', 'manage_users');

  const role = roles.data?.find((r) => r.id === roleId) ?? roles.data?.[0];
  const matrix: PermissionMatrix = draft ?? role?.matrix ?? {};

  function toggle(mod: ModuleId, act: ActionId | string) {
    if (!canManage) return;
    const next: PermissionMatrix = JSON.parse(JSON.stringify(matrix));
    next[mod] = next[mod] ?? {};
    next[mod]![act] = !next[mod]![act];
    setDraft(next);
    setSaved(false);
  }

  async function save() {
    if (!role) return;
    setError(null);
    try {
      await api.put(`/api/roles/${role.id}/matrix`, { matrix });
      setDraft(null);
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['roles'] });
      await refresh(); // permissions may affect the current session
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorBox error={error} />
      {saved ? <div className="page-info">{t('roles.saved', 'Permissions saved as a new version.')}</div> : null}
      <div className="panel">
        <div className="panel-head">
          <h2>{t('roles.matrix', 'Editable permission matrix')}</h2>
          <select
            value={role?.id ?? ''}
            onChange={(e) => {
              setRoleId(e.target.value);
              setDraft(null);
              setSaved(false);
            }}
          >
            {(roles.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <div className="spacer" />
          {canManage ? (
            <button className="btn btn-primary btn-sm" disabled={!draft} onClick={() => void save()}>
              {t('roles.save', 'Save permissions')}
            </button>
          ) : null}
        </div>
        <div className="panel-body">
          <div className="muted" style={{ marginBottom: 10 }}>
            {t(
              'roles.hint',
              'The owner can change access at any time without code changes. Financial and stock deletion is replaced by cancel, reverse, or approved correction with audit history.',
            )}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('roles.module', 'Module')}</th>
                  {ACTIONS.map((a) => (
                    <th key={a} style={{ textAlign: 'center' }}>
                      {t(`perm.${a}`, a.replace(/_/g, ' '))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MODULES.map((mod) => (
                  <tr key={mod}>
                    <td style={{ fontWeight: 600 }}>{t(`nav.${mod === 'parties' ? 'customers' : mod}`, mod)}</td>
                    {ACTIONS.map((a) => (
                      <td key={a} style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={matrix[mod]?.[a] === true}
                          disabled={!canManage}
                          onChange={() => toggle(mod, a)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* fine-grained module-specific actions (e.g. delivery Load/Dispatch) */}
          <div className="mt">
            <strong style={{ fontSize: 13 }}>{t('roles.extra', 'Module-specific actions')}</strong>
            <div className="flex" style={{ marginTop: 8, flexWrap: 'wrap', gap: 18 }}>
              {(Object.entries(EXTRA_ACTIONS) as Array<[ModuleId, readonly string[]]>).flatMap(([mod, acts]) =>
                acts.map((a) => (
                  <label key={`${mod}.${a}`} className="flex" style={{ fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={matrix[mod]?.[a] === true}
                      disabled={!canManage}
                      onChange={() => toggle(mod, a)}
                    />
                    {t(`nav.${mod === 'parties' ? 'customers' : mod}`, mod)}: {t(`perm.${a}`, a)}
                  </label>
                )),
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
