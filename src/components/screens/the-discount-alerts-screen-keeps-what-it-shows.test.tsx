// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «تنبيهات الخصم» KEEPS WHAT IT SHOWS (18/11, R16f).
 *
 * Written and measured against `osm/main` BEFORE the screen moved onto the
 * kit, and left untouched after: the same data draws the same number of
 * buttons, fields, tick boxes, links and headings, in every state the
 * screen has (loading, nothing in the period, a list, a failure).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { DiscountAlertsScreen } from './DiscountAlertsScreen';

vi.setConfig({ testTimeout: 20000 });
const WAIT = { timeout: 8000 };

const row = (id: string, notable: boolean) => ({
  id,
  orderNumber: `SY-${id}`,
  merchantRef: null,
  createdAt: '2026-10-20T12:00:00.000Z',
  customerName: `زبون ${id}`,
  discount: 5,
  total: 40,
  share: notable ? 30 : 5,
  notable,
  currency: 'JOD',
  byName: 'موظفة',
  confirmationStatus: 'CONFIRMED',
});

const FULL = {
  days: 30,
  currency: 'JOD',
  notableThreshold: 20,
  totals: { orders: 2, discount: 10, notable: 1 },
  byPerson: [{ id: 'u1', name: 'موظفة', orders: 2, total: 10, biggestShare: 30 }],
  orders: [row('1', true), row('2', false)],
};
const NONE = { ...FULL, totals: { orders: 0, discount: 0, notable: 0 }, byPerson: [], orders: [] };

function census() {
  return {
    buttons: screen.queryAllByRole('button').length,
    selects: screen.queryAllByRole('combobox').length,
    ticks: screen.queryAllByRole('checkbox').length,
    links: screen.queryAllByRole('link').length,
    h1: screen.queryAllByRole('heading', { level: 1 }).length,
    h2: screen.queryAllByRole('heading', { level: 2 }).length,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('«تنبيهات الخصم» — the same controls before and after the kit', () => {
  it('with a list: one field, one tick, the copy buttons and links of two orders drawn twice', async () => {
    apiJson.mockResolvedValue(FULL);
    render(<DiscountAlertsScreen />);
    await screen.findAllByText('SY-1', undefined, WAIT);
    // two orders × (desk + phone) = 4 links and 4 copy buttons
    expect(census()).toEqual({ buttons: 4, selects: 1, ticks: 1, links: 4, h1: 1, h2: 2 });
  });

  it('nothing in the period: the field and the tick, no list', async () => {
    apiJson.mockResolvedValue(NONE);
    render(<DiscountAlertsScreen />);
    await screen.findByText('لا خصومات في هذه المدة', undefined, WAIT);
    expect(census()).toEqual({ buttons: 0, selects: 1, ticks: 1, links: 0, h1: 1, h2: 0 });
  });

  it('while loading: the field only — the tick waits for the threshold it names', async () => {
    apiJson.mockReturnValue(new Promise(() => {}));
    render(<DiscountAlertsScreen />);
    await screen.findByText(/جارٍ التحميل/, undefined, WAIT);
    expect(census()).toEqual({ buttons: 0, selects: 1, ticks: 0, links: 0, h1: 1, h2: 0 });
  });

  it('a failure: the sentence, and the field to try another period', async () => {
    apiJson.mockRejectedValue(new Error('تعذر الاتصال'));
    render(<DiscountAlertsScreen />);
    await screen.findByText('تعذر الاتصال', undefined, WAIT);
    expect(census()).toEqual({ buttons: 0, selects: 1, ticks: 0, links: 0, h1: 1, h2: 0 });
  });
});
