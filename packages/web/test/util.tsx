import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import type { EffectiveExperience, QuickAction } from '@factoryos/shared';

/**
 * Shared test helpers for the frontend harness.
 *
 * Components read the shell context through `useAuth()` and talk to the server
 * through the `api` module. Both are mocked per-test (see `vi.mock` in the test
 * files); this file only builds the *values* those mocks hand back, so the
 * mocks stay tiny and the intent of each test stays visible.
 */

export interface MockAuth {
  loading: boolean;
  user: {
    id: string;
    displayName: string;
    roleName: string;
    language: string;
    theme: string;
    permissions: unknown[];
  } | null;
  tenant: {
    id: string;
    code: string;
    name: string;
    locationNote: string | null;
    currency: string;
    timezone: string;
    brandColor: string | null;
    logoPath: string | null;
  } | null;
  languages: unknown[];
  bundle: Record<string, string>;
  language: string;
  theme: string;
  login: (...a: unknown[]) => Promise<void>;
  logout: (...a: unknown[]) => Promise<void>;
  setLanguage: (...a: unknown[]) => Promise<void>;
  setTheme: (...a: unknown[]) => Promise<void>;
  refresh: (...a: unknown[]) => Promise<void>;
  can: (module: string, action?: string) => boolean;
  t: (key: string, fallback?: string) => string;
}

/** A ready-to-use auth context value; override only what a test cares about. */
export function makeAuth(overrides: Partial<MockAuth> = {}): MockAuth {
  return {
    loading: false,
    user: {
      id: 'u1',
      displayName: 'Test Worker',
      roleName: 'Warehouse',
      language: 'en',
      theme: 'light',
      permissions: [],
    },
    tenant: {
      id: 't1',
      code: 'mesob',
      name: 'Mesob Salt Factory',
      locationNote: 'Mekelle',
      currency: 'ETB',
      timezone: 'Africa/Addis_Ababa',
      brandColor: null,
      logoPath: null,
    },
    languages: [],
    bundle: {},
    language: 'en',
    theme: 'light',
    login: async () => {},
    logout: async () => {},
    setLanguage: async () => {},
    setTheme: async () => {},
    refresh: async () => {},
    can: () => true,
    // default translator: return the caller-supplied English fallback verbatim,
    // exactly like the real bundle-miss path.
    t: (key, fallback) => fallback ?? key,
    ...overrides,
  };
}

/** Render inside a router so NavLink/Outlet have their required context. */
export function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/** A resolved worker-mode experience carrying the given mobile action set. */
export function makeExperience(mobileActions: QuickAction[]): EffectiveExperience {
  return {
    homeFocus: 'inventory',
    nav: [],
    quickActions: [],
    mobileActions,
    kpis: [],
    defaultFilters: {},
    derived: false,
  };
}
