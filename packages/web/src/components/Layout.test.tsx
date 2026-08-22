import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { makeAuth, makeExperience, renderWithRouter, type MockAuth } from '../../test/util';

/**
 * Mobile-viewport regression tests for the app shell (W1-A7).
 *
 * jsdom has NO layout engine and no media queries, so we do NOT assert pixel
 * geometry or which breakpoint is active — CSS decides that. We assert the
 * *shipped DOM contract* the mobile rules depend on: the bottom nav exists with
 * the right entries and affordances, worker-mode actions drive it, and long
 * translated labels stay in the wrapping-capable element without crashing.
 */

// Mutable holders the hoisted mock factories close over.
const h = vi.hoisted(() => ({
  auth: null as unknown as MockAuth,
  apiGet: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  useAuth: () => h.auth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../api.js', () => ({
  api: { get: h.apiGet, post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import Layout from './Layout';

function bottomNav(): HTMLElement {
  // the bottom bar is the <nav aria-label="Primary"> (sidebar nav has no label)
  return screen.getByRole('navigation', { name: 'Primary' });
}

describe('Layout — mobile bottom navigation', () => {
  beforeEach(() => {
    h.auth = makeAuth();
    // default: no worker experience configured -> permission-derived bottom nav
    h.apiGet.mockRejectedValue(new Error('no experience'));
  });

  it('renders the bottom nav shell with permission-derived entries and a More affordance', async () => {
    renderWithRouter(<Layout />);
    const nav = bottomNav();
    expect(nav).toHaveClass('bottom-nav');

    // first four permitted modules become large touch targets
    expect(within(nav).getByText('Dashboard')).toBeInTheDocument();
    expect(within(nav).getByText('Receiving')).toBeInTheDocument();
    expect(within(nav).getByText('Inventory')).toBeInTheDocument();
    expect(within(nav).getByText('Production')).toBeInTheDocument();
    // everything else stays behind More (opens the drawer)
    expect(within(nav).getByRole('button', { name: /More/ })).toBeInTheDocument();
    // it truncates to four entries + More, not the whole 14-item menu
    expect(within(nav).queryByText('Audit Log')).not.toBeInTheDocument();
  });

  it('worker-mode: a configured mobileActions set drives the bottom bar, capped at 5 + More', async () => {
    h.apiGet.mockResolvedValue(
      makeExperience([
        { id: 'receive', labelKey: 'act.receive', path: '/receiving', module: 'inventory', icon: 'R' },
        { id: 'move', labelKey: 'act.move', path: '/inventory', module: 'inventory', icon: 'M' },
        { id: 'issue', labelKey: 'act.issue', path: '/production', module: 'production', icon: 'I' },
        { id: 'count', labelKey: 'act.count', path: '/inventory', module: 'inventory', icon: 'C' },
        { id: 'lookup', labelKey: 'act.lookup', path: '/inventory', module: 'inventory', icon: 'L' },
        { id: 'sixth', labelKey: 'act.sixth', path: '/reports', module: 'reports', icon: 'X' },
      ]),
    );
    renderWithRouter(<Layout />);

    // labels come from t(labelKey, id); our mock t returns the id fallback
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await waitFor(() => expect(within(nav).getByText('receive')).toBeInTheDocument());
    for (const id of ['receive', 'move', 'issue', 'count', 'lookup']) {
      expect(within(nav).getByText(id)).toBeInTheDocument();
    }
    // the 6th action is dropped by the slice(0,5) cap...
    expect(within(nav).queryByText('sixth')).not.toBeInTheDocument();
    // ...and the More affordance still opens the full drawer
    expect(within(nav).getByRole('button', { name: /More/ })).toBeInTheDocument();
  });

  it('long Amharic-length labels do not throw and sit in the wrapping (.bn-label) element', async () => {
    // a deliberately long Ge'ez-script label — worker-mode must never assume
    // English length (research: MOBILE_LOWEND_UX.md §D.3)
    const longLabel = 'የመቀበያ እና የማከማቻ ክፍል ውስጥ ያለውን ጨው ንብረት በዝርዝር ማስተዳደር እና መከታተል';
    h.auth = makeAuth({ t: () => longLabel });

    const { container } = renderWithRouter(<Layout />);

    const labels = container.querySelectorAll('.bottom-nav .bn-label');
    expect(labels.length).toBeGreaterThan(0);
    // the CSS wrapping class (-webkit-line-clamp:2 / overflow-wrap:anywhere)
    // is applied to the element actually carrying the translated text
    const first = labels[0] as HTMLElement;
    expect(first).toHaveClass('bn-label');
    expect(first.textContent).toBe(longLabel);
  });
});
