// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي تخلي في خانة لعرض اسم المنتج، بين المحافظة والعنوان» (the owner, 14/11) — THE «المنتج» COLUMN ON «إنشاء شحنة».
 *
 * Each order's row says what is in it: a column «المنتج» between «المحافظة» and «العنوان», one line per product of THAT
 * order, worded «الاسم × الكمية» with a gift beside its line (`goodsLines`, the wording every other list uses). It needs
 * no key beyond the screen's own — the lines are already in the list's payload — so it is there with and without the
 * address-book key, and without that key it sits right after the governorate.
 *
 * It is read at the packing bench, so nothing is cut: every line is drawn (no «+N أخرى»), a long name wraps and never
 * ends in an ellipsis, and the box is capped so a long name makes its cell taller and never the table wider. On a phone
 * card it is a labelled line, the label above the lines.
 *
 * Worked example: an order of «كريم مرطب» × 2 with 1 free, and «غسول» × 1 → two lines, «كريم مرطب × 2 (+1 مجاني)» and
 * «غسول × 1». The next order's row shows ITS product, never this one's.
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

type Line = { productName: string; quantity: number; freeQuantity: number };
const line = (productName: string, quantity = 1, freeQuantity = 0): Line => ({ productName, quantity, freeQuantity });

const row = (id: string, items: Line[], over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: `ORD-${id}`,
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000000', city: 'عمّان' },
  previousOrders: 0,
  region: { id: 'r1', name: 'عمّان' },
  address: `عنوان ${id}`,
  items,
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

/** The cell of every table row, under the «المنتج» heading. */
const goodsCells = () => {
  const at = Array.from(document.querySelectorAll('thead th')).findIndex((h) => h.textContent === 'المنتج');
  expect(at, 'no «المنتج» heading').toBeGreaterThan(-1);
  return Array.from(document.querySelectorAll('tbody tr')).map((r) => r.children[at] as HTMLElement);
};

/** The lines of one cell, as the reader sees them: the children of the box that holds them (a dash has none). */
const linesOf = (cell: HTMLElement) => Array.from(cell.firstElementChild?.children ?? []).map((l) => l.textContent);

/** The phone cards' lines under a label: one `div` of a card's list, a label (`dt`) and a value (`dd`). */
const cardLines = (label: string) =>
  Array.from(document.querySelectorAll('li dl > div')).filter((d) => d.querySelector('dt')?.textContent === label) as HTMLElement[];

beforeEach(() => {
  vi.clearAllMocks();
  user.current = ADDRESS_BOOK;
});
afterEach(cleanup);

describe('the column', () => {
  it('sits between «المحافظة» and «العنوان», and every other column is where it was', async () => {
    await draw([row('1', [line('كريم مرطب')])]);
    expect(headings()).toEqual(['الطلب', 'العميل', 'المحافظة', 'المنتج', 'العنوان', 'تفصيل التحصيل', 'تنبيهات']);
  });

  it('needs no key of its own: without the address-book key it is still there, right after «المحافظة»', async () => {
    user.current = PACKER;
    await draw([row('1', [line('كريم مرطب')])]);
    expect(headings()).toEqual(['الطلب', 'العميل', 'المحافظة', 'المنتج', 'تفصيل التحصيل', 'تنبيهات']);
    expect(linesOf(goodsCells()[0])).toEqual(['كريم مرطب × 1']);
  });
});

describe('each order shows ITS OWN product', () => {
  it('three orders, three different products — every row reads its own, in the quantity the order has', async () => {
    await draw([
      row('1', [line('كريم مرطب', 1)]),
      row('2', [line('غسول الوجه', 3)]),
      row('3', [line('سيروم فيتامين سي', 2)]),
    ]);
    expect(goodsCells().map(linesOf)).toEqual([['كريم مرطب × 1'], ['غسول الوجه × 3'], ['سيروم فيتامين سي × 2']]);
  });

  it('NEGATIVE: one order’s product is never printed in another order’s row', async () => {
    await draw([row('1', [line('كريم مرطب')]), row('2', [line('غسول الوجه')])]);
    const [first, second] = goodsCells();
    expect(first.textContent).not.toContain('غسول الوجه');
    expect(second.textContent).not.toContain('كريم مرطب');
  });

  it('an order of several products draws every one, in the order’s own order, and never says «+N أخرى»', async () => {
    const names = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس'];
    await draw([row('1', names.map((n) => line(n)))]);
    expect(linesOf(goodsCells()[0])).toEqual(names.map((n) => `${n} × 1`));
    expect(screen.queryByText(/أخرى/)).toBeNull();
  });

  it('a gift is written beside its line, not as a line of its own', async () => {
    await draw([row('1', [line('كريم مرطب', 2, 1), line('غسول', 1)])]);
    expect(linesOf(goodsCells()[0])).toEqual(['كريم مرطب × 2 (+1 مجاني)', 'غسول × 1']);
  });

  it('an order that came with no lines is a dash — never an empty cell that reads as «not loaded»', async () => {
    await draw([row('1', [])]);
    expect(goodsCells()[0].textContent).toBe('—');
  });
});

describe('a long name wraps — it is never cut, and it does not widen the table', () => {
  const long = `${'كريم مرطب للوجه بخلاصة الصبار والفيتامين سي - '.repeat(12)}50 مل`;

  it('the whole name is in the page, in a box that wraps, capped, each line picking its own direction', async () => {
    await draw([row('1', [line(long)])]);
    const box = goodsCells()[0].firstElementChild as HTMLElement;
    expect(linesOf(goodsCells()[0])).toEqual([`${long} × 1`]);
    expect(box.className).toContain('break-words');
    expect(box.className).toContain('max-w-xs');
    expect(box.firstElementChild!.getAttribute('dir')).toBe('auto');
  });

  it('NEGATIVE: nothing in it clips or ellipsises the text', async () => {
    await draw([row('1', [line(long)])]);
    const box = goodsCells()[0].firstElementChild as HTMLElement;
    const item = box.firstElementChild as HTMLElement;
    // (the class names are built, not written: a name no screen uses would otherwise grow the shipped stylesheet)
    for (const cut of ['truncate', ['line', 'clamp'].join('-'), 'overflow-hidden', ['text', 'ellipsis'].join('-')]) {
      expect(box.className, cut).not.toContain(cut);
      expect(item.className, cut).not.toContain(cut);
    }
  });
});

describe('on a phone card', () => {
  it('it is a labelled line: the label above, the lines under it at the card’s full width', async () => {
    await draw([row('1', [line('كريم مرطب', 2, 1), line('غسول', 1)])]);
    const [card] = cardLines('المنتج');
    expect(cardLines('المنتج'), 'the card has exactly one «المنتج» line').toHaveLength(1);
    expect(linesOf(card.querySelector('dd') as HTMLElement)).toEqual(['كريم مرطب × 2 (+1 مجاني)', 'غسول × 1']);
    // `wide`: the label and the value are stacked, not squeezed side by side on one line
    expect(card.className).toContain('flex-col');
    expect(card.firstElementChild!.tagName).toBe('DT');
  });

  it('the card keeps the same order of fields: «المحافظة», then «المنتج», then «العنوان»', async () => {
    await draw([row('1', [line('كريم مرطب')])]);
    const labels = Array.from(document.querySelectorAll('li dl > div > dt')).map((dt) => dt.textContent);
    expect(labels.indexOf('المنتج')).toBe(labels.indexOf('المحافظة') + 1);
    expect(labels.indexOf('العنوان')).toBe(labels.indexOf('المنتج') + 1);
  });
});
