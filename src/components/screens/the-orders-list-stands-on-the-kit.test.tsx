// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الطلبات» ON THE KIT (R10a, 18/11) — the same screen, drawn with the shared parts.
 *
 * The move changes how the list is drawn and nothing it does. This file holds the promises of that move:
 *
 *   • every create door on this screen still opens its window (quick, AI, import, migrate) — press, window mounted;
 *   • the screen draws ONE h1, the menu's name for it, inside the shared frame (`PageShell`);
 *   • the tick boxes are the kit's `Checkbox`, each with an id of its own, and ticking a row never opens the order;
 *   • the row's print press is the kit's `IconButton`, named by the order it prints;
 *   • the figures above the list are `StatTile`s with the server's numbers, drawn as they came;
 *   • at 375px no class on the screen asks for a width wider than the phone;
 *   • the count of controls is the count before the move (the plan's rule), read from the inventory the script writes.
 *
 * No browser behind the sign-in (every account has a second factor only the owner completes), so this is jsdom.
 */

const { apiFetch, user, phone } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/orders',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', t: { quickCreateOrder: 'إدخال طلب سريع', export: 'تصدير' }, currentUser: user.current }),
}));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => <i data-picker /> }));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(async () => ({ refused: [], count: 1, opened: true })),
  describeRefused: () => '',
  BLOCKED_WAYBILLS: 'x',
  WaybillError: class extends Error {},
}));
// The windows are not this screen's files: a marker that says «mounted and open» is all this file asks of them.
vi.mock('@/components/orders/CreateOrderModal', () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-window="create" /> : null),
}));
vi.mock('@/components/orders/AiOrderModal', () => ({
  AiOrderModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-window="ai" /> : null),
}));
vi.mock('@/components/orders/OrderDetailModal', () => ({
  OrderDetailModal: ({ isOpen, orderId }: { isOpen: boolean; orderId: string | null }) =>
    isOpen ? <div data-window="order" data-order={orderId ?? ''} /> : null,
}));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => <div data-window="import" /> }));
vi.mock('@/components/orders/MigrateOrdersDialog', () => ({ MigrateOrdersDialog: () => <div data-window="migrate" /> }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));

import { OrdersScreen } from './OrdersScreen';

const ORDERS = Array.from({ length: 3 }, (_, i) => ({
  id: `o${i + 1}`,
  orderNumber: `ORD-26-${8000 + i}`,
  state: 'CONFIRMED',
  customer: { id: `c${i + 1}`, fullName: `زبون ${i + 1}`, city: 'عمّان' },
  region: { name: 'إربد' },
  productNameSnapshot: 'منتج',
  quantity: 1,
  source: 'يدوي',
  createdAt: '2026-10-20T09:00:00.000Z',
  totalAmount: 40,
  confirmationStatus: 'CONFIRMED',
  deliveryProvider: { kind: 'COMPANY', name: 'ناقل' },
}));

const SUMMARY = {
  counts: [{ state: 'CONFIRMED', count: 3 }],
  countsTotal: 3,
  cards: { orders: 7, value: 280, average: 40, profit: { value: 55, orders: 2 } },
};

const EVERY_KEY = ['orders.view', 'orders.create', 'orders.import', 'orders.migrate', 'reports.export', 'ops.labels'];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  user.current = { id: 'u1', name: 'م', role: 'ADMIN', permissions: EVERY_KEY, status: 'ACTIVE' };
  apiFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      const u = String(url);
      if (u.startsWith('/api/orders/summary')) return SUMMARY;
      if (u.startsWith('/api/orders?')) return { orders: ORDERS, pagination: { page: 1, limit: 25, total: 3, totalPages: 1 } };
      return {};
    },
  }));
});
afterEach(cleanup);

const draw = async () => {
  render(<OrdersScreen />);
  await screen.findByLabelText(`تحديد الطلب ${ORDERS[2].orderNumber}`);
};
const windowOf = (name: string) => document.querySelector(`[data-window="${name}"]`);

describe('«الطلبات» on the kit — every create door still opens its window', () => {
  const DOORS: [string, string | RegExp][] = [
    ['create', 'إدخال طلب سريع'],
    ['ai', 'إدخال بالذكاء الاصطناعي'],
    ['import', 'استيراد طلبات'],
    ['migrate', 'ترحيل طلبات قديمة'],
  ];
  for (const [win, name] of DOORS) {
    it(`«${String(name)}» → its window is mounted`, async () => {
      await draw();
      expect(windowOf(win), 'مفتوحة قبل الضغط').toBeNull();
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(windowOf(win), `${String(name)} ما فتح نافذته`).not.toBeNull());
    });
  }

  it('and none is drawn for somebody who may not use it (the doors keep their keys)', async () => {
    user.current = { id: 'u2', name: 'ع', role: 'AGENT', permissions: ['orders.view'], status: 'ACTIVE' };
    await draw();
    for (const [, name] of DOORS) expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
  });
});

describe('«الطلبات» on the kit — the frame, the boxes, the row', () => {
  it('draws ONE h1, the menu’s name, and the filters sit between it and the list', async () => {
    await draw();
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('الطلبات');
    const search = screen.getByLabelText('ابحث في الطلبات');
    const list = screen.getByLabelText(`افتح الطلب ${ORDERS[0].orderNumber}`);
    // header → filters → list, in that order in the page
    expect(h1s[0].compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('every tick box is the kit’s, with an id of its own and a label that points at it', async () => {
    await draw();
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes).toHaveLength(ORDERS.length + 1);
    const ids = boxes.map((b) => b.id);
    expect(new Set(ids).size).toBe(boxes.length);
    expect(ids).toEqual(['order-select-all', ...ORDERS.map((o) => `order-select-${o.id}`)]);
    for (const b of boxes) expect(b.closest('label')!.getAttribute('for')).toBe(b.id);
  });

  it('ticking a row ticks it and does NOT open the order; the bar counts it', async () => {
    await draw();
    fireEvent.click(screen.getByLabelText(`تحديد الطلب ${ORDERS[1].orderNumber}`));
    expect((screen.getByLabelText(`تحديد الطلب ${ORDERS[1].orderNumber}`) as HTMLInputElement).checked).toBe(true);
    expect(windowOf('order'), 'التحديد فتح الطلب').toBeNull();
    expect(screen.getByText('محدَّد: 1 طلب')).toBeTruthy();
    // select-all ticks the page, and pressing it again clears it
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    expect(screen.getByText(`محدَّد: ${ORDERS.length} طلب`)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    expect(screen.queryByText(/محدَّد:/)).toBeNull();
  });

  it('pressing the row itself still opens its order', async () => {
    await draw();
    fireEvent.click(screen.getByLabelText(`افتح الطلب ${ORDERS[0].orderNumber}`));
    expect(windowOf('order')?.getAttribute('data-order')).toBe(ORDERS[0].id);
  });

  it('the row’s print is a named icon button, and pressing it prints that order without opening it', async () => {
    const { openWaybills } = await import('@/components/labels/openWaybills');
    await draw();
    const press = screen.getByRole('button', { name: `اطبع بوليصة ${ORDERS[0].orderNumber}` });
    expect(press.getAttribute('title')).toBe(`اطبع بوليصة ${ORDERS[0].orderNumber}`);
    expect(press.textContent?.trim()).toBe('');
    fireEvent.click(press);
    await waitFor(() => expect(openWaybills).toHaveBeenCalledTimes(1));
    expect((openWaybills as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].orderIds).toEqual([ORDERS[0].id]);
    expect(windowOf('order')).toBeNull();
  });

  it('the figures are StatTiles carrying the server’s numbers as they came', async () => {
    await draw();
    const name = await screen.findByText('عدد الطلبات');
    const tile = name.closest('dl')!;
    expect(tile, 'البلاطة مش StatTile').not.toBeNull();
    expect(within(tile).getByText('7')).toBeTruthy();
    const grid = tile.parentElement!.parentElement!;
    const names = Array.from(grid.querySelectorAll('dt')).map((d) => d.textContent);
    expect(names).toEqual(['عدد الطلبات', 'إجمالي القيمة', 'متوسط الطلب', 'صافي الربح (من 2 طلب مسجّل ربحه)']);
    const figures = Array.from(grid.querySelectorAll('dd')).map((d) => d.textContent ?? '');
    expect(figures[1]).toMatch(/280/);
    expect(figures[2]).toMatch(/40/);
    expect(figures[3]).toMatch(/55/);
  });

  it('a summary with no average says «—», never a zero', async () => {
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/orders/summary')
          ? { ...SUMMARY, cards: { orders: 0, value: 0, average: null } }
          : { orders: ORDERS, pagination: { page: 1, limit: 25, total: 3, totalPages: 1 } },
    }));
    await draw();
    const tile = (await screen.findByText('متوسط الطلب')).closest('dl')!;
    expect(tile.querySelector('dd')!.textContent).toBe('—');
    expect(screen.queryByText(/صافي الربح/)).toBeNull();
  });
});

describe('«الطلبات» on the kit — a phone at 375px', () => {
  const tooWide = () => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[class]'))) {
      for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
        const m = /^(?:min-)?w-\[(\d+)px\]$/.exec(token);
        if (m && Number(m[1]) > 375) out.push(token);
        // Spelled in pieces: the stylesheet scanner reads test files, and a whole class name here would be a rule in production.
        const [lead, ...rest] = token.split('-');
        if ((lead === 'w' || lead === 'min') && /^(?:w-)?(?:max|screen)$/.test(rest.join('-')) && token !== 'min-w-0') out.push(token);
      }
    }
    return out;
  };

  it('the cards, the bar and the filter fold ask for no width wider than the phone', async () => {
    phone.value = true;
    await draw();
    // the filters are folded behind one button on a phone
    const fold = document.querySelector('details[data-advanced-group]');
    expect(fold, 'ما في طيّة فلاتر').not.toBeNull();
    fireEvent.click(screen.getByLabelText('تحديد كل الطلبات في هذه الصفحة'));
    expect(document.querySelector('[role="toolbar"]'), 'شريط التحديد ما ظهر').not.toBeNull();
    expect(tooWide()).toEqual([]);
  });
});

describe('«الطلبات» on the kit — the same number of controls as before the move', () => {
  /*
   * Before R10a the inventory read 19 buttons and 11 inputs (two of them the tick boxes). After it the same 19 presses
   * are 18 buttons + 1 icon button, and the same 11 inputs are 9 + 2 kit tick boxes. A press or a field that disappears
   * in a later change fails here, not in somebody's morning.
   */
  it('19 presses and 11 fields, counted by the inventory script', () => {
    const inv = JSON.parse(readFileSync(join(process.cwd(), 'scripts/ui-inventory.json'), 'utf8'));
    const row = inv['src/components/screens/OrdersScreen.tsx'];
    expect((row.buttons ?? 0) + (row.iconButtons ?? 0)).toBe(19);
    expect((row.inputs ?? 0) + (row.checkboxes ?? 0)).toBe(11);
    expect(row.modals ?? 0).toBe(0);
    expect(row.links ?? 0).toBe(0);
    expect(row.columns ?? 0).toBe(0);
  });

  it('and the five windows are mounted from this screen, by name', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/OrdersScreen.tsx'), 'utf8');
    for (const w of ['<CreateOrderModal', '<AiOrderModal', '<OrderDetailModal', '<ImportOrdersDialog', '<MigrateOrdersDialog']) {
      expect(src.split(w).length - 1, w).toBe(1);
    }
  });
});
