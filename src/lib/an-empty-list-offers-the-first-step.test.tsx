// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AN EMPTY LIST OFFERS THE FIRST STEP, NOT A SENTENCE ABOUT WHERE IT IS.
 *
 * The owner, 21/10: «كل خطوة تودّي للثانية». Fifty-one screens say what they
 * say when they have nothing, and measured across them only six carried a
 * control — every one of which was «clear the filter». None offered the thing
 * that ends an empty list: making the first one. «أضِفه من الزرّ أعلاه»
 * sends the eye to a button a screen's height away, on the screen where a new
 * person is most lost.
 *
 * Eight screens now put that button where the eye already is. The claims:
 *
 *   • it appears only when the list is empty because NOTHING EXISTS — never
 *     under a filter or a search, where the way out is to clear it;
 *   • it is the same act as the header's button, not a second implementation
 *     of it (a copy of «name the batch, then open the form» is how two
 *     buttons come to number batches differently);
 *   • and where the header's button is gated — by permission, or by a wallet
 *     being stopped — so is this one.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { repoFile, stripComments } from './guard-source';

// ───────────────────────── the eight, as source ─────────────────────────

const SCREENS: {
  file: string;
  /** The title of the EmptyState that means «nothing has been made yet». */
  anchor: string;
  label: string;
  /** The handler — which must ALSO be what the screen's own button calls. */
  handler: string;
}[] = [
  { file: 'src/components/screens/OrdersScreen.tsx', anchor: "'لا طلبات في هذا المتجر بعد'", label: 'أنشئ أول طلب', handler: 'setCreateModalOpen(true)' },
  { file: 'src/components/screens/ProductsScreen.tsx', anchor: "'لا منتجات في هذا المتجر بعد'", label: 'أضف أول منتج', handler: 'setCreateModalOpen(true)' },
  { file: 'src/components/screens/CustomersScreen.tsx', anchor: "'لا عملاءَ بعد'", label: 'أضف أول عميل', handler: 'setCreateModalOpen(true)' },
  { file: 'src/components/screens/CommissionSettingsScreen.tsx', anchor: 'title="لا قواعد عمولة بعد"', label: 'أضف أول قاعدة', handler: 'setNewOpen(true)' },
  { file: 'src/components/screens/ManufacturingScreen.tsx', anchor: 'title="لا تشغيلاتِ إنتاجٍ بعد"', label: 'أضف أول تشغيلة', handler: 'openNewBatch' },
  { file: 'src/components/screens/BlacklistScreen.tsx', anchor: 'title="لا أرقامَ محظورة"', label: 'حظر رقم', handler: 'setAdding(true)' },
  { file: 'src/components/screens/finance/WalletsScreen.tsx', anchor: 'title="لا حركاتٍ على هذه المحفظة"', label: 'سجّل أول حركة', handler: 'setRecordOpen(true)' },
  { file: 'src/components/screens/FinanceProfitScreen.tsx', anchor: 'title="لا مصروف مسجَّل في هذا الشهر"', label: 'سجّل أول مصروف', handler: 'onRecord' },
];

/** The text of the `<EmptyState …/>` that carries `anchor`. */
function emptyStateOf(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `ما لقيت ${anchor}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf('<EmptyState', at);
  const end = source.indexOf('/>', at);
  return source.slice(start, end + 2);
}

describe('eight empty lists offer the first step', () => {
  it.each(SCREENS)('$file', ({ file, anchor, label, handler }) => {
    const src = stripComments(repoFile(file));
    const block = emptyStateOf(src, anchor);
    expect(block, 'ما في زر').toContain('action=');
    expect(block).toContain(`'${label}'`);
    expect(block, 'الزر لا يستدعي المعالج').toContain(handler);
  });

  it.each(SCREENS)('and it is the SAME act as the screen’s own button — $label', ({ file, handler }) => {
    const src = stripComments(repoFile(file));
    // The handler appears in the header's button AND in the empty state (at least twice) —
    // for `openNewBatch` and `onRecord` the second is its definition or its prop.
    const uses = src.split(handler).length - 1;
    expect(uses, `${handler}: مرة واحدة فقط — زر الرأس والقائمة الفاضية لازم يكونوا نفس الفعل`).toBeGreaterThanOrEqual(2);
  });

  it('and under a filter or a search the way out is still the way out — the first step is not offered there', () => {
    // Orders, products and customers have two answers to «empty»: a filter that is too narrow, and a
    // book with nothing in it. Only the second is offered the first step.
    const orders = stripComments(repoFile('src/components/screens/OrdersScreen.tsx'));
    expect(orders).toMatch(/activeFilters > 0\s*\?\s*\{ label: 'امسح الفلاتر', onClick: resetFilters \}\s*:\s*canCreate/);
    const products = stripComments(repoFile('src/components/screens/ProductsScreen.tsx'));
    expect(products).toMatch(/search\s*\?\s*\{ label: 'امسح البحث'[^}]*\}\s*:\s*\{ label: 'أضف أول منتج'/);
    const customers = stripComments(repoFile('src/components/screens/CustomersScreen.tsx'));
    expect(customers).toContain("action={search ? undefined : { label: 'أضف أول عميل'");
  });

  it('and where the header’s button is gated, so is this one', () => {
    const orders = stripComments(repoFile('src/components/screens/OrdersScreen.tsx'));
    // The header's two buttons are both `{canCreate && (`; the first step needs the same.
    expect(orders.match(/\{canCreate && \(/g)!.length).toBeGreaterThanOrEqual(2);
    expect(orders).toMatch(/:\s*canCreate\s*\?\s*\{ label: 'أنشئ أول طلب'/);
    // A stopped wallet has its «حركة جديدة» disabled; the first step is simply absent for it.
    const wallets = stripComments(repoFile('src/components/screens/finance/WalletsScreen.tsx'));
    // PR-9: the first step is also absent for a person who may only SEE the cash box (the header's button is hidden for her too).
    expect(wallets).toContain("wallet?.isActive && mayCash ? { label: 'سجّل أول حركة'");
  });

  it('and the new batch is named by ONE function, used by the header and by the empty list', () => {
    const src = stripComments(repoFile('src/components/screens/ManufacturingScreen.tsx'));
    expect(src.match(/const openNewBatch = \(\) =>/g)).toHaveLength(1);
    expect(src.match(/BATCH-\$\{new Date\(\)\.getFullYear\(\)\}/g), 'رقم الدفعة يُصنع بمكانين').toHaveLength(1);
    expect(src).toContain('onClick={openNewBatch}');
    expect(src).toContain('onClick: openNewBatch');
  });

  it('and the profit screen’s empty list is a sub-component, so the act is handed to it — and absent without one', () => {
    const src = stripComments(repoFile('src/components/screens/FinanceProfitScreen.tsx'));
    expect(src).toContain('onRecord={() => setExpenseModalOpen(true)}');
    expect(src).toContain("action={onRecord ? { label: 'سجّل أول مصروف', onClick: onRecord } : undefined}");
  });
});

// ───────────────────────── two of them, really pressed ─────────────────────────

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
// Run the loader ONCE, on mount, and hold the latest one in a ref — as the real hook does. Keyed on the
// loader instead, a screen whose loader is a function written in its body (the customers') is a new
// dependency every render: it loads, sets state, re-renders and loads again until the test times out.
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
// The same object every render, on purpose: a hook that answers a NEW array each time is a dependency that
// changes on every render, and the screen's effects would load, re-render and load again until the test times out.
const { APP, REGIONS } = vi.hoisted(() => ({
  // OLD → NEW (PR-6): the person holds `control.blacklist_manage` — blocking a number is its own key now, and the blacklist
  // screen draws «حظر رقم» (in the header and in the empty list) only for who holds it. The migration gave it to every
  // holder of control.blacklist, so this is the person AFTER the deploy.
  APP: { t: { customers: 'العملاء' }, currentUser: { id: 'u', role: 'COMPANY_ADMIN', permissions: ['control.blacklist_manage'] }, locale: 'ar' },
  REGIONS: { regions: [], countryName: '' },
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => APP }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => REGIONS }));
// `ScreenTitle` reads the address to find the screen's own name; and the customers screen reads what points at it
// (`?search=`, `?segment=`) once, at the start — an address with nothing in it here.
vi.mock('next/navigation', () => ({ usePathname: () => '/control/blacklist', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/growth/AskAi', () => ({ AskAi: () => null }));

import { BlacklistScreen } from '@/components/screens/BlacklistScreen';
import { CustomersScreen } from '@/components/screens/CustomersScreen';

beforeEach(() => {
  apiJson.mockResolvedValue({ blocks: [] });
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ customers: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 } }),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('pressed, it does what the header’s button does', () => {
  it('— the blacklist: an empty book offers «حظر رقم», and pressing it opens the dialog', async () => {
    render(<BlacklistScreen />);
    // Two buttons carry the name: the form’s, and the empty list’s. The second is the one inside the empty state.
    const empty = (await screen.findByText('لا أرقامَ محظورة')).parentElement as HTMLElement;
    const first = within(empty).getByRole('button', { name: /حظر رقم/ });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      fireEvent.click(first);
    });
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('حظر رقم');
  });

  it('and under a search it offers the way out of the search instead, never the first step', async () => {
    apiJson.mockResolvedValue({ blocks: [] });
    render(<BlacklistScreen />);
    await screen.findByText('لا أرقامَ محظورة');
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('رقم الهاتف، الاسم أو السبب'), { target: { value: '0933' } });
    });
    const empty = (await screen.findByText('لا نتائج مطابقة')).parentElement as HTMLElement;
    expect(within(empty).getByRole('button', { name: 'امسح البحث' })).toBeTruthy();
    expect(within(empty).queryByRole('button', { name: /حظر رقم/ })).toBeNull();
  });

  it('— the customers: an empty book offers «أضف أول عميل», and pressing it opens the form', async () => {
    render(<CustomersScreen />);
    const empty = (await screen.findByText('لا عملاءَ بعد')).parentElement as HTMLElement;
    const first = within(empty).getByRole('button', { name: 'أضف أول عميل' });
    await act(async () => {
      fireEvent.click(first);
    });
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('إضافة عميل جديد');
  });

  it('and under a search the customers screen offers nothing to press', async () => {
    render(<CustomersScreen />);
    await screen.findByText('لا عملاءَ بعد');
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/بحث بالاسم/), { target: { value: 'زيد' } });
    });
    const empty = (await screen.findByText('لا عميلَ يطابق بحثك')).parentElement as HTMLElement;
    expect(within(empty).queryByRole('button')).toBeNull();
  });
});
