import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ModuleId, ActionId, SessionUser } from '@factoryos/shared';
import { hasPermission } from '@factoryos/shared';
import { api, ApiError } from './api.js';

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
  flagEmoji: string | null;
}

interface AuthState {
  loading: boolean;
  user: SessionUser | null;
  tenant: Tenant | null;
  languages: Language[];
  bundle: Record<string, string>;
  language: string;
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setLanguage: (code: string) => Promise<void>;
  refresh: () => Promise<void>;
  can: (module: ModuleId, action: ActionId) => boolean;
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

  // apply tenant branding to CSS variables
  useEffect(() => {
    if (tenant?.brandColor) {
      document.documentElement.style.setProperty('--primary', tenant.brandColor);
    }
    document.title = tenant ? `${tenant.name} — FactoryOS` : 'FactoryOS';
  }, [tenant]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      tenant,
      languages,
      bundle,
      language,
      login,
      logout,
      setLanguage,
      refresh,
      can: (module, action) => (user ? hasPermission(user.permissions, module, action) : false),
      t: (key, fallback) => bundle[key] ?? fallback ?? key,
    }),
    [loading, user, tenant, languages, bundle, language, login, logout, setLanguage, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
