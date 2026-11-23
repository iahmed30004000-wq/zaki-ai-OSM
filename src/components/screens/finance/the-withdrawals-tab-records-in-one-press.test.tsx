// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المسحوبات» ON THE SCREEN — jsdom, because nothing behind the login can be opened in a browser here.
 *
 * 23/11 (F7) — REWRITTEN: a withdrawal is a WALLET MOVEMENT. Old (22/11): the press wrote a row of its own
 * (`POST /api/finance/partners/withdrawals`, «moves no wallet»), and «إلغاء» wrote a cancel row. New: the press writes the draw through
 * the draws door (`POST /api/finance/partners/draws` — a wallet, the partner, the amount and «ما يعادله»), the tab is a read-only
 * dashboard over those movements (a reversed one struck through, reversed at its wallet — no «إلغاء» here), and the old rows sit in
 * a block of their own. Why: «والحركات تكون من المحافظ … ما بدي الحركات المالية بكل مكان، خلص مكان واحد».
 *
 *   · one press sends what the boxes hold, filled from the standing amount (and its equivalent) and changeable;
 *   · no standing row → empty boxes; a standing equivalent typed for another store currency is not used;
 *   · the totals are the server's, each currency on its own line; nothing is added across currencies;
 *   · without the cash box's key no press is drawn, and nothing is sent;
 *   · the tab is drawn on «الأرباح» only for who holds `finance.partners`, and the profit tab is the default.
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

import { WithdrawalsSection, FROM_STANDING_LINE } from './WithdrawalsSection';
import { FinanceProfitScreen } from '../FinanceProfitScreen';

const movement = (over: Record<string, unknown>) => ({
  id: 'm1', walletId: 'wu', direction: 'OUT', amount: 250, currencyCode: 'USD', party: 'شريك أ', category: 'PARTNER_DRAW',
  note: 'سحب شريك أ', partnerId: 'p1', valueInStoreCurrency: 250, createdAt: '2026-11-20T10:00:00.000Z', realDate: '2026-11-20T10:00:00.000Z',
  registeredOnAnotherDay: false, createdByName: 'سارة', isReversal: false, wasReversed: false, reversalOf: null, reversedBy: null,
  reversalReason: null, reversalOfId: null, referenceType: 'PARTNER_DRAW', referenceId: 'p1', partnerName: 'شريك أ', walletName: 'صندوق دولار',
  minorUnit: 2, storeName: 'المتجر الأول', storeCurrency: 'USD', storeMinor: 2, ...over,
});

const BOOK = {
  storeId: 's1',
  storeCurrency: { code: 'USD', minorUnit: 2 },
  mayRecord: true,
  partners: [
    { id: 'p1', name: 'شريك أ', isActive: true },
    { id: 'p2', name: 'شريك ب', isActive: true },
  ],
  currencies: [
    { code: 'JOD', ar: 'دينار أردني', minorUnit: 3 },
    { code: 'SYP', ar: 'ليرة سورية', minorUnit: 2 },
    { code: 'USD', ar: 'دولار أمريكي', minorUnit: 2 },
  ],
  standing: [
    { partnerId: 'p1', currencyCode: 'USD', amount: 250, storeValue: null, storeCurrencyCode: null },
    { partnerId: 'p1', currencyCode: 'JOD', amount: 70, storeValue: 98.7, storeCurrencyCode: 'USD' },
    // Typed in a store priced in another currency: its equivalent is not this store's.
    { partnerId: 'p2', currencyCode: 'JOD', amount: 40, storeValue: 56, storeCurrencyCode: 'SYP' },
  ],
  wallets: [
    { id: 'wu', name: 'صندوق دولار', currencyCode: 'USD', minorUnit: 2 },
    { id: 'wj1', name: 'دينار 1', currencyCode: 'JOD', minorUnit: 3 },
    { id: 'wj2', name: 'دينار 2', currencyCode: 'JOD', minorUnit: 3 },
  ],
  lastWallet: { 'p1|JOD': 'wj2' },
  rows: [
    movement({}),
    movement({
      id: 'm2', walletId: 'wj1', amount: 30, currencyCode: 'JOD', minorUnit: 3, valueInStoreCurrency: 42.3, walletName: 'دينار 1', wasReversed: true,
      reversedBy: { id: 'm3', reversalReason: 'غلط', createdAt: '2026-11-21T11:00:00.000Z' },
    }),
  ],
  totals: [
    { storeId: 's1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 250, valueTotal: 250, count: 1, minorUnit: 2 },
    { storeId: 's1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'JOD', total: 70, valueTotal: 98.7, count: 1, minorUnit: 3 },
  ],
  byStore: [
    { storeId: 's1', storeName: 'المتجر الأول', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 250, valueTotal: 250, count: 1, minorUnit: 2, storeCurrency: 'USD', storeMinor: 2 },
    { storeId: 's2', storeName: 'المتجر التاني', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 5, valueTotal: 5, count: 1, minorUnit: 2, storeCurrency: 'USD', storeMinor: 2 },
  ],
  legacyTotals: [{ partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 999, count: 1, minorUnit: 2 }],
  legacy: [
    { id: 'L1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', minorUnit: 2, amount: 999, withdrawnOn: '2026-11-22', fromStanding: true, note: 'سجل قديم', createdAt: '2026-11-22T10:00:00.000Z', createdByName: 'سارة', cancelled: null },
  ],
};

let book: typeof BOOK = BOOK;
let sent: { url: string; method: string; body: Record<string, unknown> }[] = [];
let gets: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  gets = [];
  book = BOOK;
  phone.value = true;
  user = { role: 'SUPER_ADMIN', permissions: [] };
  api.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method) {
      sent.push({ url, method: init.method, body: JSON.parse(String(init.body ?? 'null')) });
      return {};
    }
    gets.push(url);
    if (url.startsWith('/api/finance/partners/withdrawals')) return book;
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
const presses = () => screen.getAllByRole('button', { name: 'سجّل مسحوب' }) as HTMLButtonElement[];
/** The box of one standing currency: the inputs live in the same block as its press. */
const block = (i: number) => presses()[i].closest('div.space-y-1') as HTMLElement;

describe('«سجّل مسحوب» — one press, a wallet movement', () => {
  it('the store’s own currency: the standing amount out of the wallet picked, to the DRAWS door', async () => {
    await draw();
    expect(presses()).toHaveLength(3); // شريك أ: USD + JOD · شريك ب: JOD
    fireEvent.click(presses()[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance/partners/draws',
      method: 'POST',
      body: { walletId: 'wu', partnerId: 'p1', amount: '250' },
    });
  });

  it('another currency: amount AND «ما يعادله» filled from the standing row, the last wallet he used first, and the line says so', async () => {
    await draw();
    const b = block(1);
    expect((within(b).getByLabelText('المبلغ (JOD)') as HTMLInputElement).value).toBe('70');
    expect((within(b).getByLabelText('ما يعادله بعملة المتجر (USD)') as HTMLInputElement).value).toBe('98.7');
    expect((within(b).getByLabelText('من محفظة') as HTMLSelectElement).value).toBe('wj2');
    expect(within(b).getByText(FROM_STANDING_LINE)).toBeTruthy();
    fireEvent.click(presses()[1]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ walletId: 'wj2', partnerId: 'p1', amount: '70', valueInStoreCurrency: '98.7' });
  });

  it('what the person types over the pre-fill is what is sent — the wallet, the amount and the equivalent', async () => {
    await draw();
    const b = block(1);
    fireEvent.change(within(b).getByLabelText('من محفظة'), { target: { value: 'wj1' } });
    fireEvent.change(within(b).getByLabelText('المبلغ (JOD)'), { target: { value: '80.5' } });
    fireEvent.change(within(b).getByLabelText('ما يعادله بعملة المتجر (USD)'), { target: { value: '113.5' } });
    fireEvent.click(presses()[1]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ walletId: 'wj1', partnerId: 'p1', amount: '80.5', valueInStoreCurrency: '113.5' });
  });

  it('NEGATIVE: an equivalent typed for ANOTHER store currency is not used — the box is empty and the press waits for it', async () => {
    await draw();
    const b = block(2);
    expect((within(b).getByLabelText('المبلغ (JOD)') as HTMLInputElement).value).toBe('40');
    expect((within(b).getByLabelText('ما يعادله بعملة المتجر (USD)') as HTMLInputElement).value).toBe('');
    expect(presses()[2].disabled).toBe(true);
    fireEvent.click(presses()[2]);
    expect(sent).toHaveLength(0);
  });

  it('a refusal from the server is said on the screen', async () => {
    await draw();
    api.mockImplementationOnce(async () => {
      throw new Error('المحفظة موقوفة');
    });
    fireEvent.click(presses()[0]);
    expect(await screen.findByText('المحفظة موقوفة')).toBeTruthy();
  });

  it('NEGATIVE: nothing on this tab writes the old record — no POST or PATCH to the withdrawals door', async () => {
    await draw();
    fireEvent.click(presses()[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent.filter((s) => s.url === '/api/finance/partners/withdrawals' && s.method !== 'PUT')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'إلغاء' })).toHaveLength(0);
  });
});

describe('«مبلغ تاني» — the wallet decides the currency, the standing row fills it', () => {
  const open = async (partner: number) => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'مبلغ تاني' })[partner]);
    return screen.findByRole('dialog');
  };

  it('a partner with a standing row in the wallet’s currency: filled, and changing the wallet re-fills it', async () => {
    const d = await open(0);
    fireEvent.change(within(d).getByLabelText('من محفظة *'), { target: { value: 'wj1' } });
    expect((within(d).getByLabelText('المبلغ (JOD) *') as HTMLInputElement).value).toBe('70');
    expect((within(d).getByLabelText('ما يعادله بعملة المتجر (USD) *') as HTMLInputElement).value).toBe('98.7');
    expect(within(d).getByText(FROM_STANDING_LINE)).toBeTruthy();
    fireEvent.change(within(d).getByLabelText('من محفظة *'), { target: { value: 'wu' } });
    expect((within(d).getByLabelText('المبلغ (USD) *') as HTMLInputElement).value).toBe('250');
    expect(within(d).queryByLabelText(/^ما يعادله/)).toBeNull();
  });

  it('no standing row in that currency: the boxes are empty, as today, and the typed figures are sent', async () => {
    const d = await open(1);
    fireEvent.change(within(d).getByLabelText('من محفظة *'), { target: { value: 'wu' } });
    expect((within(d).getByLabelText('المبلغ (USD) *') as HTMLInputElement).value).toBe('');
    expect(within(d).queryByText(FROM_STANDING_LINE)).toBeNull();
    fireEvent.change(within(d).getByLabelText('المبلغ (USD) *'), { target: { value: '12' } });
    fireEvent.click(within(d).getByRole('button', { name: 'سجّل المسحوب' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ url: '/api/finance/partners/draws', body: { walletId: 'wu', partnerId: 'p2', amount: '12' } });
  });
});

describe('the standing amounts', () => {
  it('one box per currency, and beside each foreign one its worth in the store’s currency — typed once', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'المبالغ الثابتة' })[0]);
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getAllByLabelText('ما يعادله بـUSD')[0] as HTMLInputElement).value).toBe('98.7');
    fireEvent.change(within(dialog).getByLabelText('دولار أمريكي (USD)'), { target: { value: '300' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ المبالغ' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance/partners/withdrawals',
      method: 'PUT',
      body: {
        partnerId: 'p1',
        amounts: [
          { currencyCode: 'JOD', amount: '70', storeValue: '98.7' },
          { currencyCode: 'SYP', amount: '', storeValue: '' },
          { currencyCode: 'USD', amount: '300' },
        ],
      },
    });
  });
});

describe('the dashboard', () => {
  it('each currency on its own line, the foreign one with its worth in the store’s currency; every store he reaches', async () => {
    await draw();
    let card = screen.getByText('مجموع المسحوبات بهالمتجر') as HTMLElement;
    while (!card.querySelector('ul')) card = card.parentElement!;
    const lines = within(card).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('USD');
    expect(lines[0].textContent).not.toContain('يعادل');
    expect(lines[1].textContent).toContain('JOD');
    expect(lines[1].textContent).toContain('يعادل');
    expect(screen.getByText('المتجر التاني')).toBeTruthy();
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
    // Its own sum, inside its own block — never in «مجموع المسحوبات بهالمتجر».
    expect(screen.getByText('شريك أ — مكتوب بالسجل القديم')).toBeTruthy();
    let card = screen.getByText('مجموع المسحوبات بهالمتجر') as HTMLElement;
    while (!card.querySelector('ul')) card = card.parentElement!;
    expect(card.textContent).not.toContain('999');
  });

  it('a span on the real date asks the server for it; «كل السجل» asks for everything', async () => {
    await draw();
    expect(gets[0]).toBe('/api/finance/partners/withdrawals');
    fireEvent.click(screen.getByRole('radio', { name: 'فترة' }));
    await waitFor(() => expect(gets.some((g) => /\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(g))).toBe(true));
  });

  it('NEGATIVE: without the cash box’s key no press is drawn, it says why, and nothing is sent', async () => {
    book = { ...BOOK, mayRecord: false };
    await draw();
    expect(screen.queryAllByRole('button', { name: 'سجّل مسحوب' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'مبلغ تاني' })).toHaveLength(0);
    expect(screen.getByText(/بدّو كمان صلاحية «تسجيل حركات الصندوق»/)).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('says what it is: wallet movements, in one place', async () => {
    await draw();
    expect(screen.getByText(/كل مسحوب حركة صادرة من محفظة/)).toBeTruthy();
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
