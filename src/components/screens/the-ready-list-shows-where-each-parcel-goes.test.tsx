// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «اظهر العنوان بالخانات» (the owner, 8/11) — THE «العنوان» COLUMN ON «إنشاء شحنة».
 *
 * The table says where each parcel goes: a column «العنوان» after «المحافظة» (since 14/11 «المنتج» sits between the two —
 * see `the-ready-list-shows-what-is-in-each-order.test.tsx`), drawn only for a holder of
 * `customers.view` (the list door gives the street to nobody else). The address wraps — never cut with an ellipsis, never
 * widening the table — and on a phone card it is a labelled line with the label above the full-width text. An order with
 * no address says «بلا عنوان» in red, because dispatch will refuse it (`NO_ADDRESS`); an address the server did not send
 * is only a dash, never that red sentence.
 *
 * Worked example: «شارع الجلاء 12» → the cell reads «شارع الجلاء 12». No address → «بلا عنوان». Spaces only → «بلا عنوان».
 * A packer without the address-book key → no «العنوان» heading, and no street anywhere on the screen.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, user } = vi.hoisted(() => ({ apiJson: vi.fn(), user: { current: null as unknown } }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/shipments/new', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

const ADDRESS_BOOK = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'customers.view'] };
const PACKER = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'ops.labels'] };

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: `ORD-${id}`,
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000000', city: 'عمّان' },
  previousOrders: 0,
  region: { id: 'r1', name: 'عمّان' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 3, cod: 23, currency: 'JOD', feeSource: 'region' },
  blocks: [],
  selectable: true,
  hardBlocked: false,
  shipHoldUntil: null,
  standDownBlocked: null,
  shipHoldReason: null,
  ...over,
});

const draw = async (rows: ReturnType<typeof row>[]) => {
  apiJson.mockImplementation(async (url: string) =>
    url.includes('/api/ops/shipments')
      ? { orders: rows, heldCount: 0 }
      : { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] }
  );
  render(<ShipmentsNewScreen />);
  await waitFor(() => expect(screen.queryAllByText(/ORD-/).length).toBeGreaterThan(0), WAIT);
};

/** The headings of the table, without the two empty ones (the tick-box and the actions). */
const headings = () =>
  screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim()).filter(Boolean);

/** The text of the first table row's cell under the «العنوان» heading. */
const addressCell = () => {
  const ths = Array.from(document.querySelectorAll('thead th'));
  const at = ths.findIndex((h) => h.textContent === 'العنوان');
  expect(at, 'no «العنوان» heading').toBeGreaterThan(-1);
  return document.querySelector('tbody tr')!.children[at] as HTMLElement;
};

/** The phone card's «العنوان» line: one `div` of the card's list, a label (`dt`) and a value (`dd`). */
const cardLine = () => {
  const lines = Array.from(document.querySelectorAll('li dl > div')).filter((d) => d.querySelector('dt')?.textContent === 'العنوان');
  expect(lines, 'the card has exactly one «العنوان» line').toHaveLength(1);
  return lines[0] as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  user.current = ADDRESS_BOOK;
});
afterEach(cleanup);

describe('the holder of the address-book key', () => {
  it('has a «العنوان» column after «المحافظة» and «المنتج», and every other column where it was', async () => {
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(headings()).toEqual(['الطلب', 'العميل', 'المحافظة', 'المنتج', 'العنوان', 'تفصيل التحصيل', 'تنبيهات']);
  });

  it('reads the address in the cell', async () => {
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(addressCell().textContent).toBe('شارع الجلاء 12');
  });

  it('an Arabic address with digits is printed as it came (Arabic-Indic and Western digits both)', async () => {
    const written = 'دمشق - المزة - شارع ٧، بناء 12، طابق ٣';
    await draw([row('1', { address: written })]);
    expect(addressCell().textContent).toBe(written);
  });

  it('each order shows its own address', async () => {
    await draw([row('1', { address: 'عنوان الأول' }), row('2', { address: 'عنوان الثاني' }), row('3', { address: null })]);
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const at = Array.from(document.querySelectorAll('thead th')).findIndex((h) => h.textContent === 'العنوان');
    expect(rows.map((r) => r.children[at].textContent)).toEqual(['عنوان الأول', 'عنوان الثاني', 'بلا عنوان']);
  });
});

describe('the address wraps — it is never cut, and it does not widen the table', () => {
  const long = `${'شارع الملك الحسين بن طلال - '.repeat(40)}بناء 12`;

  it('the whole text is in the page, in a box that wraps and picks its own direction', async () => {
    await draw([row('1', { address: long })]);
    const box = addressCell().firstElementChild as HTMLElement;
    expect(box.textContent).toBe(long);
    expect(box.getAttribute('dir')).toBe('auto');
    expect(box.className).toContain('break-words');
    // capped, so a long street makes the cell taller and not the table wider
    expect(box.className).toContain('max-w-xs');
  });

  it('NEGATIVE: nothing in it clips or ellipsises the text', async () => {
    await draw([row('1', { address: long })]);
    const box = addressCell().firstElementChild as HTMLElement;
    // (the class names are built, not written: a name no screen uses would otherwise grow the shipped stylesheet)
    for (const cut of ['truncate', ['line', 'clamp'].join('-'), 'overflow-hidden', ['text', 'ellipsis'].join('-')]) {
      expect(box.className, cut).not.toContain(cut);
    }
  });

  it('on a phone card it is a labelled line: the label above, the text under it at the card’s full width', async () => {
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    const line = cardLine();
    expect((line.querySelector('dd') as HTMLElement).textContent).toBe('شارع الجلاء 12');
    // `wide`: the label and the value are stacked, not squeezed side by side on one line
    expect(line.className).toContain('flex-col');
    // and the label comes first, so it reads above the text
    expect(line.firstElementChild!.tagName).toBe('DT');
  });
});

describe('an order with no address says so — in red', () => {
  const RED = 'text-[var(--sys-destructive)]';

  it('null: «بلا عنوان», in the colour the unset governorate uses', async () => {
    await draw([row('1', { address: null })]);
    const none = addressCell().firstElementChild as HTMLElement;
    expect(none.textContent).toBe('بلا عنوان');
    expect(none.className).toContain(RED);
  });

  it('spaces only: the same — a blank street is none', async () => {
    await draw([row('1', { address: '     ' })]);
    expect(addressCell().textContent).toBe('بلا عنوان');
  });

  it('and the card says it too, under its label', async () => {
    await draw([row('1', { address: null })]);
    const none = cardLine().querySelector('dd')!.firstElementChild as HTMLElement;
    expect(none.textContent).toBe('بلا عنوان');
    expect(none.className).toContain(RED);
  });

  it('NEGATIVE: an order that has one never says «بلا عنوان»', async () => {
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(screen.queryByText('بلا عنوان')).toBeNull();
  });

  it('NEGATIVE: an address the server did not send (undefined) is a dash — not the red sentence, which would claim the order has none', async () => {
    await draw([row('1')]);
    expect(screen.queryByText('بلا عنوان')).toBeNull();
    expect(addressCell().textContent).toBe('—');
  });
});

describe('whoever lacks the address-book key', () => {
  it('has no «العنوان» column at all — the heading, the cell and the card line are all absent', async () => {
    user.current = PACKER;
    await draw([row('1')]);
    expect(headings()).toEqual(['الطلب', 'العميل', 'المحافظة', 'المنتج', 'تفصيل التحصيل', 'تنبيهات']);
    expect(screen.queryByText('العنوان')).toBeNull();
    expect(screen.queryByText('بلا عنوان')).toBeNull();
  });

  it('and a street that somehow came in the payload is not drawn: the column is not there to draw it', async () => {
    user.current = PACKER;
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(screen.queryByText(/شارع الجلاء/)).toBeNull();
    expect(document.body.textContent).not.toContain('شارع الجلاء');
  });

  it('a user nobody has signed in as (null) gets no column either', async () => {
    user.current = null;
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(headings()).not.toContain('العنوان');
    expect(document.body.textContent).not.toContain('شارع الجلاء');
  });

  it('NEGATIVE: the keys next to it do not open the column — only `customers.view` does', async () => {
    user.current = { id: 'u3', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'ops.labels', 'customers.view_basic', 'orders.view'] };
    await draw([row('1', { address: 'شارع الجلاء 12' })]);
    expect(headings()).not.toContain('العنوان');
  });
});
