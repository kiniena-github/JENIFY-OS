import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { ActionId, ModuleId } from '@factoryos/shared';
import { useAuth } from '../auth.js';
import { OfflineBanner } from './offline.js';

interface NavEntry {
  path: string;
  module: ModuleId;
  action?: ActionId;
  labelKey: string;
  fallback: string;
  icon: string;
}

/** Generic platform navigation. Tenants relabel entries via translations. */
const NAV: NavEntry[] = [
  { path: '/', module: 'dashboard', labelKey: 'nav.dashboard', fallback: 'Dashboard', icon: 'D' },
  { path: '/receiving', module: 'inventory', labelKey: 'nav.receiving', fallback: 'Receiving', icon: 'R' },
  { path: '/inventory', module: 'inventory', labelKey: 'nav.inventory', fallback: 'Inventory', icon: 'I' },
  { path: '/production', module: 'production', labelKey: 'nav.production', fallback: 'Production', icon: 'P' },
  { path: '/customers', module: 'parties', labelKey: 'nav.customers', fallback: 'Customers', icon: 'C' },
  { path: '/sales', module: 'sales', labelKey: 'nav.sales', fallback: 'Sales', icon: 'S' },
  { path: '/credit', module: 'credit', labelKey: 'nav.credit', fallback: 'Credit', icon: '₵' },
  { path: '/payments', module: 'payments', labelKey: 'nav.payments', fallback: 'Payments', icon: '$' },
  { path: '/deliveries', module: 'delivery', labelKey: 'nav.deliveries', fallback: 'Deliveries', icon: 'L' },
  { path: '/sacks', module: 'inventory', labelKey: 'nav.sacks', fallback: 'Empty Sacks', icon: 'E' },
  { path: '/reports', module: 'reports', labelKey: 'nav.reports', fallback: 'Reports', icon: 'T' },
  { path: '/users', module: 'users', labelKey: 'nav.users', fallback: 'Users & Roles', icon: 'U' },
  { path: '/settings', module: 'settings', labelKey: 'nav.settings', fallback: 'Settings', icon: 'G' },
  { path: '/audit', module: 'audit', labelKey: 'nav.audit', fallback: 'Audit Log', icon: 'A' },
];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export const PageTitleContext = React.createContext<{
  title: string;
  sub: string;
  setTitle: (title: string, sub?: string) => void;
}>({ title: '', sub: '', setTitle: () => {} });

export function usePageTitle(title: string, sub?: string): void {
  const ctx = React.useContext(PageTitleContext);
  React.useEffect(() => {
    ctx.setTitle(title, sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, sub]);
}

export default function Layout() {
  const { user, tenant, languages, language, setLanguage, theme, setTheme, logout, can, t } = useAuth();
  const [title, setTitleState] = React.useState('');
  const [sub, setSub] = React.useState('');
  const [navOpen, setNavOpen] = React.useState(false);
  const titleCtx = React.useMemo(
    () => ({
      title,
      sub,
      setTitle: (ti: string, s?: string) => {
        setTitleState(ti);
        setSub(s ?? '');
      },
    }),
    [title, sub],
  );

  if (!user || !tenant) return null;

  const visibleNav = NAV.filter((n) => can(n.module, n.action ?? 'view'));

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <aside className="sidebar">
        <div className="sidebar-brand">
          {tenant.logoPath ? (
            <img
              src={tenant.logoPath}
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="logo-fallback">{initials(tenant.name)}</div>
          )}
          <div>
            <div className="sidebar-brand-name">{tenant.name}</div>
            <div className="sidebar-brand-sub">{t('shell.system', 'Management System')}</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {visibleNav.map((n) => (
            <NavLink key={n.path} to={n.path} end={n.path === '/'} onClick={() => setNavOpen(false)}>
              <span className="nav-icon">{n.icon}</span>
              {t(n.labelKey, n.fallback)}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {tenant.locationNote}
          <br />
          JENIFY OS v0.1
        </div>
      </aside>
      <div className="main">
        <header className="header">
          <button className="nav-toggle" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            ☰
          </button>
          <div>
            <div className="header-title">{title}</div>
            {sub ? <div className="header-sub">{sub}</div> : null}
          </div>
          <div className="header-spacer" />
          <select
            aria-label={t('shell.theme', 'Theme')}
            value={theme}
            onChange={(e) => void setTheme(e.target.value as 'light' | 'dark' | 'system')}
            title={t('shell.theme', 'Theme')}
          >
            <option value="light">☀ {t('theme.light', 'Light')}</option>
            <option value="dark">🌙 {t('theme.dark', 'Dark')}</option>
            <option value="system">🖥 {t('theme.system', 'System')}</option>
          </select>
          {(() => {
            // exact approved flag image for the selected language, when configured
            const current = languages.find((l) => l.code === language);
            return current?.flagEmoji?.startsWith('/') ? (
              <img
                src={current.flagEmoji}
                alt=""
                style={{ height: 20, borderRadius: 3, border: '1px solid var(--border)' }}
              />
            ) : null;
          })()}
          <select
            aria-label={t('shell.language', 'Language')}
            value={language}
            onChange={(e) => void setLanguage(e.target.value)}
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flagEmoji && !l.flagEmoji.startsWith('/') ? `${l.flagEmoji} ` : ''}
                {l.name}
              </option>
            ))}
          </select>
          <div className="header-user">
            <div className="avatar">{initials(user.displayName)}</div>
            <div className="who">
              <div className="name">{user.displayName}</div>
              <div className="role">{user.roleName}</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => void logout()}>
              {t('shell.signout', 'Sign out')}
            </button>
          </div>
        </header>
        <OfflineBanner />
        <main className="workspace">
          <PageTitleContext.Provider value={titleCtx}>
            <Outlet />
          </PageTitleContext.Provider>
        </main>
        {/* Role-scoped mobile bottom navigation: the user's first permitted
            modules as large touch targets; everything else stays behind More
            (the drawer). Hidden on desktop via CSS. A dedicated worker-mode
            experience profile is the Role Experience Engine's job (Wave 1) —
            this is the responsive substrate it will configure. */}
        <nav className="bottom-nav no-print" aria-label="Primary">
          {visibleNav.slice(0, 4).map((n) => (
            <NavLink key={n.path} to={n.path} end={n.path === '/'} onClick={() => setNavOpen(false)}>
              <span className="bn-icon" aria-hidden>{n.icon}</span>
              <span className="bn-label">{t(n.labelKey, n.fallback)}</span>
            </NavLink>
          ))}
          {visibleNav.length > 4 ? (
            <button type="button" onClick={() => setNavOpen(true)}>
              <span className="bn-icon" aria-hidden>⋯</span>
              <span className="bn-label">{t('nav.more', 'More')}</span>
            </button>
          ) : null}
        </nav>
      </div>
    </div>
  );
}
