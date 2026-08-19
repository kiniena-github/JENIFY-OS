import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ModuleId, ActionId, SessionUser } from '@factoryos/shared';
import { hasPermission } from '@factoryos/shared';
import { api, ApiError } from './api.js';
import { setDisplayCalendar, setDisplayTimezone } from './lib/format.js';

export interface Tenant {
  id: string;
  code: string;
  name: string;
  locationNote: string | null;
  currency: string;
  timezone: string;
  brandColor: string | null;
  logoPath: string | null;
}

export interface Language {
  code: string;
  name: string;
  nativeName?: string | null;
  direction?: string;
  flagEmoji: string | null;
}

type Theme = 'light' | 'dark' | 'system';

interface AuthState {
  loading: boolean;
  user: SessionUser | null;
  tenant: Tenant | null;
  languages: Language[];
  bundle: Record<string, string>;
  language: string;
  theme: Theme;
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setLanguage: (code: string) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  refresh: () => Promise<void>;
  can: (module: ModuleId, action: ActionId | string) => boolean;
  t: (key: string, fallback?: string) => string;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [bundle, setBundle] = useState<Record<string, string>>({});
  const [language, setLanguageState] = useState('en');
  const [theme, setThemeState] = useState<Theme>('system');

  const loadBundle = useCallback(async (lang: string) => {
    const b = await api.get<Record<string, string>>(`/api/i18n/${lang}`);
    setBundle(b);
    setLanguageState(lang);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: SessionUser; tenant: Tenant; languages: Language[] }>(
        '/api/auth/me',
      );
      setUser(me.user);
      setTenant(me.tenant);
      setLanguages(me.languages);
      setThemeState(me.user.theme ?? 'system');
      setDisplayTimezone(me.tenant?.timezone);
      // tenant display calendar (non-sensitive UI config)
      try {
        const cfg = await api.get<{ calendar?: string }>('/api/ui-config');
        setDisplayCalendar(cfg.calendar);
      } catch {
        /* calendar stays gregorian */
      }
      await loadBundle(me.user.language || 'en');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setTenant(null);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, [loadBundle]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string, remember: boolean) => {
      await api.post('/api/auth/login', { username, password, remember });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
    setTenant(null);
  }, []);

  const setLanguage = useCallback(
    async (code: string) => {
      await loadBundle(code);
      if (user) await api.patch('/api/auth/me', { language: code });
    },
    [loadBundle, user],
  );

  const setTheme = useCallback(
    async (next: Theme) => {
      setThemeState(next);
      if (user) await api.patch('/api/auth/me', { theme: next });
    },
    [user],
  );

  // apply the effective theme to the document (per-user preference; 'system'
  // follows the OS setting live)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const effective = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = effective;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  // text direction follows the selected language (RTL support)
  useEffect(() => {
    const current = languages.find((l) => l.code === language);
    document.documentElement.dir = current?.direction === 'rtl' ? 'rtl' : 'ltr';
  }, [language, languages]);

  // apply tenant branding to CSS variables
  useEffect(() => {
    if (tenant?.brandColor) {
      document.documentElement.style.setProperty('--primary', tenant.brandColor);
    }
    document.title = tenant ? `${tenant.name} — JENIFY OS` : 'JENIFY OS';
  }, [tenant]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      tenant,
      languages,
      bundle,
      language,
      theme,
      login,
      logout,
      setLanguage,
      setTheme,
      refresh,
      can: (module, action) => (user ? hasPermission(user.permissions, module, action) : false),
      t: (key, fallback) => bundle[key] ?? fallback ?? key,
    }),
    [loading, user, tenant, languages, bundle, language, theme, login, logout, setLanguage, setTheme, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
