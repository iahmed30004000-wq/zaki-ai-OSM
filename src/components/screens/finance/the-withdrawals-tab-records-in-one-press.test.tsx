// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المسحوبات» ON THE SCREEN — jsdom, because nothing behind the login can be opened in a browser here.
 *
 * 23/11 (F7) — REWRITTEN: a withdrawal is a WALLET MOVEMENT, recorded ONLY at the wallet, in its own currency. Old (22/11): the tab
 * recorded rows of its own (POST /api/finance/partners/withdrawals, «moves no wallet»), with «المبالغ الثابتة», «مبلغ تاني» and
 * «إلغاء». New: the tab is a READ-ONLY dashboard over the PARTNER_DRAW movements — per partner per currency, never summed across, a
 * reversed one struck through, the draws with no store-currency worth said apart — and the old rows sit in a block of their own.
 * Why: «السحوبات الأساسية بتتسجّل سحب من المحفظة بالعملة … بدون ما يجيني سعر الصرف» and «خلص مكان واحد».
 *
 *   · no recording control at all: no date box, no «سجّل مسحوب», no «مبلغ تاني», no «المبالغ الثابتة», and nothing is ever sent;
 *   · the totals are the server's, each currency on its own line; a currency with draws of no worth carries the line that says so;
 *   · the tab is drawn on «الأرباح» only for who holds finance.partners, and the profit tab is the default.
 */

const { phone, api } = vi.hoisted(() => ({ phone: { value: true }, api: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/profit',
  useSearchParams: () => new URLSearchParams(),
}));
let user: { role: string; permissions: string[] } = { role: 'SUPER_ADMIN', permissions: [] };
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', isRtl: true, currentUser: user }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown, opts?: { key?: string }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));

import { WithdrawalsSection, UNVALUED_LINE } from './WithdrawalsSection';
import { FinanceProfitScreen } from '../FinanceProfitScreen';

const movement = (over: Record<string, unknown>) => ({
  id: 'm1', walletId: 'wu', direction: 'OUT', amount: 250, currencyCode: 'USD', party: 'شريك أ', category: 'PARTNER_DRAW',
  note: 'سحب شريك أ', partnerId: 'p1', valueInStoreCurrency: 250, createdAt: '2026-11-20T10:00:00.000Z', realDate: '2026-11-20T10:00:00.000Z',
  registeredOnAnotherDay: false, createdByName: 'سارة', isReversal: false, wasReversed: false, reversalOf: null, reversedBy: null,
  reversalReason: null, reversalOfId: null, referenceType: 'PARTNER_DRAW', referenceId: 'p1', partnerName: 'شريك أ', walletName: 'صندوق دولار',
  minorUnit: 2, storeName: 'المتجر الأول', storeCurrency: 'USD', storeMinor: 2, ...over,
});
const total = (over: Record<string, unknown>) => ({
  storeId: 's1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 0, count: 0, minorUnit: 2,
  valueTotal: 0, valueCount: 0, unvaluedTotal: 0, unvaluedCount: 0, ...over,
});

const BOOK = {
  storeId: 's1',
  storeCurrency: { code: 'USD', minorUnit: 2 },
  partners: [
    { id: 'p1', name: 'شريك أ', isActive: true },
    { id: 'p2', name: 'شريك ب', isActive: true },
  ],
  currencies: [
    { code: 'JOD', ar: 'دينار أردني', minorUnit: 3 },
    { code: 'USD', ar: 'دولار أمريكي', minorUnit: 2 },
    { code: 'USDT', ar: 'USDT', minorUnit: 2 },
  ],
  rows: [
    movement({}),
    movement({
      id: 'm2', walletId: 'wj', amount: 30, currencyCode: 'JOD', minorUnit: 3, valueInStoreCurrency: 42.3, walletName: 'دينار', wasReversed: true,
      reversedBy: { id: 'm3', reversalReason: 'غلط', createdAt: '2026-11-21T11:00:00.000Z' },
    }),
    movement({ id: 'm4', walletId: 'wt', amount: 1000, currencyCode: 'USDT', valueInStoreCurrency: null, walletName: 'محفظة USDT' }),
  ],
  totals: [
    total({ currencyCode: 'USD', total: 250, count: 1, valueTotal: 250, valueCount: 1 }),
    total({ currencyCode: 'JOD', total: 1070, count: 2, minorUnit: 3, valueTotal: 98.7, valueCount: 1, unvaluedTotal: 1000, unvaluedCount: 1 }),
    total({ currencyCode: 'USDT', total: 1000, count: 1, unvaluedTotal: 1000, unvaluedCount: 1 }),
  ],
  byStore: [
    { ...total({ currencyCode: 'USD', total: 250, count: 1 }), storeName: 'المتجر الأول', storeCurrency: 'USD', storeMinor: 2 },
    { ...total({ storeId: 's2', currencyCode: 'USD', total: 5, count: 1 }), storeName: 'المتجر التاني', storeCurrency: 'USD', storeMinor: 2 },
    { ...total({ storeId: 's2', currencyCode: 'USDT', total: 700, count: 1, unvaluedTotal: 700, unvaluedCount: 1 }), storeName: 'المتجر التاني', storeCurrency: 'USD', storeMinor: 2 },
  ],
  legacyTotals: [{ partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 999, count: 1, minorUnit: 2 }],
  legacy: [
    { id: 'L1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', minorUnit: 2, amount: 999, withdrawnOn: '2026-11-22', fromStanding: true, note: 'سجل قديم', createdAt: '2026-11-22T10:00:00.000Z', createdByName: 'سارة', cancelled: null },
  ],
};

let sent: { url: string; method: string }[] = [];
let gets: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  gets = [];
  phone.value = true;
  user = { role: 'SUPER_ADMIN', permissions: [] };
  api.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method) {
      sent.push({ url, method: init.method });
      return {};
    }
    gets.push(url);
    if (url.startsWith('/api/finance/partners/withdrawals')) return BOOK;
    if (url === '/api/finance/partners/statement') return { state: 'NO_PARTNERS', lines: [], draws: [], trust: { level: 'STATED', ar: '' }, totals: {}, netProfit: 0, uncounted: 0 };
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/finance/profitability')) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      return new Response(JSON.stringify({ currency: 'JOD', summary: null, expenses: [], spend: null }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = async () => {
  render(<WithdrawalsSection />);
  await screen.findByText('سجل المسحوبات');
};
const totalsCard = () => {
  let card = screen.getByText('مجموع المسحوبات بهالمتجر') as HTMLElement;
  while (!card.querySelector('ul')) card = card.parentElement!;
  return card;
};

describe('the tab records nothing — a withdrawal is recorded at its wallet', () => {
  it('NEGATIVE: no date box, no «سجّل مسحوب», no «مبلغ تاني», no «المبالغ الثابتة», no «إلغاء» — and nothing is ever sent', async () => {
    await draw();
    for (const name of ['سجّل مسحوب', 'مبلغ تاني', 'المبالغ الثابتة', 'إلغاء']) expect(screen.queryAllByRole('button', { name })).toHaveLength(0);
    expect(screen.queryByLabelText('تاريخ السحب')).toBeNull();
    expect(screen.queryByLabelText('تاريخ الحركة الفعلي')).toBeNull();
    expect(screen.queryByText(/ما في مبلغ ثابت/)).toBeNull();
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('it says where a withdrawal is recorded, and links there', async () => {
    await draw();
    expect(screen.getByText(/كل مسحوب حركة صادرة من محفظة/)).toBeTruthy();
    expect((screen.getByText('المحافظ') as HTMLAnchorElement).getAttribute('href')).toBe('/finance/wallets');
  });
});

describe('the dashboard', () => {
  it('each partner PER CURRENCY, on its own line — dollars, dinars and USDT never summed', async () => {
    await draw();
    const lines = within(totalsCard()).getAllByRole('listitem');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (l.textContent!.match(/USDT|JOD|USD/) ?? [''])[0])).toEqual(['USD', 'JOD', 'USDT']);
    expect(totalsCard().textContent).not.toContain('2,320');
    expect(screen.getByText('المتجر التاني')).toBeTruthy();
  });

  it('a currency with draws of no store-currency worth carries the line, per currency; the one with a worth says it', async () => {
    await draw();
    const [usd, jod, usdt] = within(totalsCard()).getAllByRole('listitem');
    expect(usd.textContent).not.toContain(UNVALUED_LINE);
    expect(jod.textContent).toContain(UNVALUED_LINE);
    expect(jod.textContent).toContain('مكتوب جنبها ما يعادلها');
    expect(usdt.textContent).toContain(UNVALUED_LINE);
    expect(usdt.textContent).not.toContain('مكتوب جنبها');
  });

  it('«المسحوبات بكل المتاجر» marks the draws with no store value too, per store and currency', async () => {
    await draw();
    let card = screen.getByText('المسحوبات بكل المتاجر') as HTMLElement;
    while (!card.querySelector('ul')) card = card.parentElement!;
    const rows = [...card.querySelectorAll('li > div')] as HTMLElement[];
    const usdt = rows.find((r) => r.textContent!.includes('USDT'))!;
    expect(usdt.textContent).toContain(UNVALUED_LINE);
    expect(rows.filter((r) => r.textContent!.includes(UNVALUED_LINE))).toHaveLength(1);
  });

  it('a reversed draw is listed struck through and marked, the eye opens it, and a link opens it in its wallet', async () => {
    await draw();
    expect(screen.getAllByText('معكوس').length).toBeGreaterThan(0);
    expect(screen.getAllByText('انعكس: غلط').length).toBeGreaterThan(0);
    expect(document.querySelector('.line-through')?.textContent).toContain('30');
    const links = screen.getAllByText('افتح الحركة بالمحفظة') as HTMLAnchorElement[];
    expect(links[0].getAttribute('href')).toBe('/finance/wallets?wallet=wu&movement=m1');
    fireEvent.click(screen.getAllByRole('button', { name: 'تفاصيل الحركة' })[0]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('تفاصيل الحركة')).toBeTruthy();
    expect(panel.textContent).toContain('سحب شريك');
  });

  it('the old record sits in its own block, read-only, said to be counted nowhere', async () => {
    await draw();
    expect(screen.getByText('قديمة — غير مربوطة بمحفظة')).toBeTruthy();
    expect(screen.getByText(/ما بتنحسب بأي مجموع/)).toBeTruthy();
    expect(screen.getAllByText('سجل قديم').length).toBeGreaterThan(0);
    expect(screen.getByText('شريك أ — مكتوب بالسجل القديم')).toBeTruthy();
    expect(totalsCard().textContent).not.toContain('999');
  });

  it('a span on the real date asks the server for it; «كل السجل» asks for everything', async () => {
    await draw();
    expect(gets[0]).toBe('/api/finance/partners/withdrawals');
    fireEvent.click(screen.getByRole('radio', { name: 'فترة' }));
    await waitFor(() => expect(gets.some((g) => /\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(g))).toBe(true));
  });

  it('on a phone nothing carries a fixed width wider than the screen', async () => {
    await draw();
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/\bw-\[(\d{4,}|[5-9]\d\d)px\]/);
    expect(html).not.toMatch(/\bmin-w-\[(\d{4,}|[4-9]\d\d)px\]/);
  });
});

describe('the tab on «الأرباح»', () => {
  it('for the holder of the key: two tabs, the profit first and chosen; «المسحوبات» draws the section', async () => {
    user = { role: 'MODERATOR', permissions: ['finance.view', 'finance.partners'] };
    render(<FinanceProfitScreen />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['الأرباح', 'المسحوبات']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(api.mock.calls.map((c) => c[0])).not.toContain('/api/finance/partners/withdrawals');
    fireEvent.click(tabs[1]);
    expect(await screen.findByText('سجل المسحوبات')).toBeTruthy();
  });

  it('NEGATIVE: without `finance.partners` no tab is drawn and the withdrawals are never asked for', async () => {
    user = { role: 'MODERATOR', permissions: ['finance.view', 'finance.cashbox', 'finance.create'] };
    render(<FinanceProfitScreen />);
    await screen.findByText('سجل المصاريف');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText('المسحوبات')).toBeNull();
    expect(api.mock.calls.map((c) => c[0])).not.toContain('/api/finance/partners/withdrawals');
  });
});
