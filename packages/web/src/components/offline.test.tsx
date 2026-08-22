import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeAuth, type MockAuth } from '../../test/util';

/**
 * Offline / sync honesty UX regression (Mobile+Offline mission §4).
 * The contract: the offline banner appears ONLY when the device is offline, and
 * every SyncStatusBadge state carries its honest label + colour class.
 */

const h = vi.hoisted(() => ({ auth: null as unknown as MockAuth }));

vi.mock('../auth.js', () => ({
  useAuth: () => h.auth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { OfflineBanner, SyncStatusBadge, type SyncState } from './offline';

h.auth = makeAuth();

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  setOnline(true); // restore jsdom default for the next test
});

describe('OfflineBanner', () => {
  it('renders nothing while the device is online', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the honest offline warning when the device is offline', () => {
    setOnline(false);
    render(<OfflineBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('offline-banner');
    expect(banner).toHaveTextContent('You are offline.');
    // it must never pretend data is saved — it warns changes cannot be saved
    expect(banner).toHaveTextContent(/cannot be saved/i);
  });
});

describe('SyncStatusBadge', () => {
  const cases: Array<{ state: SyncState; label: string; cls: string }> = [
    { state: 'local', label: 'Saved locally', cls: 'badge-gray' },
    { state: 'pending', label: 'Waiting to sync', cls: 'badge-amber' },
    { state: 'synced', label: 'Synced', cls: 'badge-green' },
    { state: 'conflict', label: 'Conflict — review required', cls: 'badge-red' },
    { state: 'failed', label: 'Failed — retry', cls: 'badge-red' },
  ];

  it.each(cases)('renders the $state state with its label and colour class', ({ state, label, cls }) => {
    const { container } = render(<SyncStatusBadge state={state} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveClass('badge', 'sync-badge', cls);
  });
});
