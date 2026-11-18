// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * «العملاء» ON THE KIT (R10d, 18/11) — WHAT THE SCREEN SHOWS DID NOT MOVE.
 *
 * The screen changed its look (the kit's card and tile, the page frame) and nothing else. These pin, on the
 * screen as it was on main before the change, how many buttons, fields, columns and links it draws, and
 * WHAT EACH OF THE TWO VIEWS SEES:
 *
 *   the full view (`customers.view`) — the search, the three filters, the five figures of the book, the list,
 *     and the customer's file with the address and the history;
 *   the limited view (`customers.view_basic`) — the search and the list only: no filter, no figure. The server
 *     sends it the six fields of `BASIC_CUSTOMER_SELECT` and `facts: null`; this screen draws no more than it is given.
 *
 * That difference is a privacy rule. A redesign that drew a filter or a figure for the limited view would hand it
 * the history it is deliberately not shown — so it is counted here, both ways.
 */

const { apiFetch, phone } = vi.hoisted(() => ({ apiFetch: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: vi.fn() }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => undefined }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useCreateIntent', () => ({ useCreateIntent: () => undefined }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ name: 'عمّان' }], countryName: 'الأردن' }) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { customers: 'العملاء' }, currentUser: { id: 'u', role: 'COMPANY_ADMIN', permissions: [] }, locale: 'ar' }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/customers', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/growth/AskAi', () => ({ AskAi: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));

import { CustomersScreen } from './CustomersScreen';

const FACTS = {
  total: 20, ordered: 15, repeat: 4, received: 10, refused: 2, dormant: 3,
  byGrade: { loyal: 0, good: 0, watch: 0, risky: 0, new: 0 },
  cities: [{ city: 'عمّان', count: 12 }],
  deliveryRate: 70,
};

/** A full row, as `FULL_CUSTOMER_SELECT` sends it, with one order in its history. */
const FULL_ROW = {
  id: 'c1', fullName: 'زبون أول', phone: '0790000011', rawPhone: '0790000011', city: 'عمّان', country: 'الأردن',
  address: 'شارع التجربة', totalOrders: 2, deliveredOrders: 1, cancelledOrders: 1, totalPurchaseValue: 50, lastOrderDate: null,
  orders: [{ id: 'o1', orderNumber: 'ORD-T-1', totalAmount: 50, status: 'DELIVERED', product: { name: 'منتج تجربة' } }],
};
/** The same person as `BASIC_CUSTOMER_SELECT` sends them: six fields, nothing of the history. */
const BASIC_ROW = { id: 'c1', fullName: 'زبون أول', phone: '0790000011', rawPhone: '0790000011', city: 'عمّان', country: 'الأردن' };

function answer(limited: boolean) {
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      customers: [limited ? BASIC_ROW : FULL_ROW],
      facts: limited ? null : FACTS,
      limited,
      dialCode: '962',
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
    }),
  }));
}

beforeEach(() => {
  phone.value = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const draw = async (limited: boolean) => {
  answer(limited);
  render(<CustomersScreen />);
  await screen.findAllByText('زبون أول');
  // the filters arrive with the figures, a tick after the rows
  if (!limited) await screen.findByLabelText('الفئة');
};

/** What a person can press, type into, read as a column, or follow — counted on the whole document. */
const census = () => ({
  buttons: screen.queryAllByRole('button').length,
  fields: screen.queryAllByRole('textbox').length + screen.queryAllByRole('combobox').length,
  columns: screen.queryAllByRole('columnheader').length,
  links: screen.queryAllByRole('link').length,
  headings: screen.queryAllByRole('heading', { level: 1 }).length,
});

const FIGURES = ['طلبوا', 'كرّروا الطلب', 'رفضوا طرداً', 'نسبة الاستلام'];
const FILTERS = ['الفئة', 'المحافظة', 'الترتيب'];

describe('the full view (customers.view) — the same things as on main', () => {
  it('the same count of buttons, fields, columns and links, and one h1 with the menu’s name', async () => {
    await draw(false);
    expect(census()).toEqual(FULL_CENSUS);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('العملاء');
  });

  it('the three filters and the five figures are drawn', async () => {
    await draw(false);
    for (const label of FILTERS) expect(screen.getByLabelText(label), label).toBeTruthy();
    for (const label of FIGURES) expect(screen.getByText(label), label).toBeTruthy();
    expect(screen.getByText('70%')).toBeTruthy();
  });

  it('the customer’s file shows the address, the total and the history', async () => {
    await draw(false);
    fireEvent.click(screen.getAllByText('زبون أول')[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('العنوان:')).toBeTruthy();
    expect(within(dialog).getByText('شارع التجربة')).toBeTruthy();
    expect(within(dialog).getByText('إجمالي المشتريات:')).toBeTruthy();
    expect(within(dialog).getByText(/^سجل الطلبات \(1\)/)).toBeTruthy();
    expect(within(dialog).getByText('ORD-T-1')).toBeTruthy();
  });
});

describe('the limited view (customers.view_basic) — still sees less, exactly as on main', () => {
  it('the same count of buttons, fields, columns and links', async () => {
    await draw(true);
    expect(census()).toEqual(LIMITED_CENSUS);
  });

  it('no filter and no figure of the book', async () => {
    await draw(true);
    for (const label of FILTERS) expect(screen.queryByLabelText(label), label).toBeNull();
    for (const label of FIGURES) expect(screen.queryByText(label), label).toBeNull();
  });

  it('asks the server for no filter, and its file has no history in it', async () => {
    await draw(true);
    const url = String(apiFetch.mock.calls.at(-1)![0]);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(['segment', 'city', 'sort'].filter((k) => q.has(k))).toEqual([]);
    fireEvent.click(screen.getAllByText('زبون أول')[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^سجل الطلبات \(0\)/)).toBeTruthy();
    expect(within(dialog).queryByText('ORD-T-1')).toBeNull();
  });
});

describe('at 375px — nothing pins a width that would push the page sideways', () => {
  it('no fixed pixel width anywhere on the screen; the one fixed tile width sits inside a strip that scrolls', async () => {
    phone.value = true;
    window.innerWidth = 375;
    await draw(false);
    for (const el of Array.from(document.body.querySelectorAll('[class]'))) {
      const tokens = (el.getAttribute('class') ?? '').split(/\s+/);
      expect(tokens.filter((t) => /^(min-)?w-\[\d+px\]$/.test(t)), el.outerHTML.slice(0, 80)).toEqual([]);
      if (tokens.includes('w-36')) {
        expect(el.parentElement!.getAttribute('class') ?? '').toContain('overflow-x-auto');
      }
    }
  });
});

/* Counted on main (ca251b2d) before the change, and the same after it. */
const FULL_CENSUS = { buttons: 5, fields: 4, columns: 5, links: 0, headings: 1 };
const LIMITED_CENSUS = { buttons: 5, fields: 1, columns: 5, links: 0, headings: 1 };
