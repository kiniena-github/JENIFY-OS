import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { makeAuth, type MockAuth } from '../../test/util';

const h = vi.hoisted(() => ({ auth: null as unknown as MockAuth }));

vi.mock('../auth.js', () => ({
  useAuth: () => h.auth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { BriefCard, type OwnerBrief } from './BriefCard';

h.auth = makeAuth();

describe('BriefCard', () => {
  it('renders the /api/brief shape: happened items, count badges, and the date', () => {
    const brief: OwnerBrief = {
      date: '2026-08-22',
      happened: [
        { kind: 'sales', severity: 'info', message: '3 sale(s) today', count: 3 },
        { kind: 'production', severity: 'info', message: 'Production output recorded today' },
      ],
      attention: [],
      financialIncluded: true,
    };
    render(<BriefCard brief={brief} />);

    expect(screen.getByText('2026-08-22')).toBeInTheDocument();
    expect(screen.getByText('3 sale(s) today')).toBeInTheDocument();
    expect(screen.getByText('Production output recorded today')).toBeInTheDocument();

    const happened = screen.getAllByTestId('brief-happened-item');
    expect(happened).toHaveLength(2);
    // the count badge shows for the item that carries one, not the other
    expect(within(happened[0]).getByText('3')).toBeInTheDocument();
    expect(within(happened[1]).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('orders attention items most-severe first (error > warning > info) even if given unsorted', () => {
    const brief: OwnerBrief = {
      date: '2026-08-22',
      happened: [],
      // intentionally unsorted input to prove the card enforces the ordering
      attention: [
        { kind: 'qc_release', severity: 'info', message: 'info item' },
        { kind: 'stock_out', severity: 'error', message: 'error item' },
        { kind: 'credit_overdue', severity: 'warning', message: 'warning item' },
      ],
      financialIncluded: true,
    };
    render(<BriefCard brief={brief} />);

    const rows = screen.getAllByTestId('brief-attention-item');
    expect(rows.map((r) => r.getAttribute('data-severity'))).toEqual([
      'error',
      'warning',
      'info',
    ]);
    // severity colour class rides with the row's badge (theme-aware platform class)
    expect(within(rows[0]).getByText('Critical')).toHaveClass('badge-red');
    expect(within(rows[1]).getByText('Warning')).toHaveClass('badge-amber');
    expect(within(rows[2]).getByText('Info')).toHaveClass('badge-blue');
  });

  it('surfaces the financial-hidden note when the role may not see money', () => {
    const brief: OwnerBrief = {
      date: '2026-08-22',
      happened: [],
      attention: [],
      financialIncluded: false,
    };
    render(<BriefCard brief={brief} />);
    expect(screen.getByText(/Financial figures are hidden/i)).toBeInTheDocument();
    // both sections still render their empty state honestly
    expect(screen.getByText('All clear.')).toBeInTheDocument();
  });
});
