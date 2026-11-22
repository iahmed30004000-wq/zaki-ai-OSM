// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المسحوبات» ON THE SCREEN (22/11) — jsdom, because nothing behind the login can be opened in a browser here.
 *
 *   · one press «سجّل مسحوب» sends the standing amount (or the figure typed over it), the day, the partner and the currency;
 *   · the totals are the server's, each currency on its own line — the screen adds nothing;
 *   · «إلغاء» asks a reason and sends it; the cancelled row says «ملغى» and offers no second cancel;
 *   · the tab is drawn on «الأرباح» only for who holds `finance.partners`, and the profit tab is the default;
 *   · on a phone nothing carries a fixed width wider than the screen.
 */

const { phone, api } = vi.hoisted(() => ({ phone: { value: true }, api: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
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

import { WithdrawalsSection } from './WithdrawalsSection';
import { FinanceProfitScreen } from '../FinanceProfitScreen';

const BOOK = {
  storeId: 's1',
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
    { partnerId: 'p1', currencyCode: 'USD', amount: 250 },
    { partnerId: 'p1', currencyCode: 'JOD', amount: 70 },
  ],
  rows: [
    { id: 'w1', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', minorUnit: 2, amount: 250, withdrawnOn: '2026-11-20', fromStanding: true, note: null, createdAt: '2026-11-20T10:00:00.000Z', createdByName: 'سارة', cancelled: null },
    { id: 'w2', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'JOD', minorUnit: 3, amount: 30, withdrawnOn: '2026-11-21', fromStanding: false, note: null, createdAt: '2026-11-21T10:00:00.000Z', createdByName: 'سارة', cancelled: { reason: 'غلط', at: '2026-11-21T11:00:00.000Z', byName: 'سارة' } },
  ],
  totals: [
    { partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 250, count: 1, minorUnit: 2 },
    { partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'JOD', total: 70, count: 1, minorUnit: 3 },
  ],
  byStore: [
    { storeId: 's1', storeName: 'المتجر الأول', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 250, count: 1, minorUnit: 2 },
    { storeId: 's2', storeName: 'المتجر التاني', partnerId: 'p1', partnerName: 'شريك أ', currencyCode: 'USD', total: 5, count: 1, minorUnit: 2 },
  ],
};

let sent: { url: string; method: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  phone.value = true;
  user = { role: 'SUPER_ADMIN', permissions: [] };
  api.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method) {
      sent.push({ url, method: init.method, body: JSON.parse(String(init.body ?? 'null')) });
      return {};
    }
    if (url === '/api/finance/partners/withdrawals') return BOOK;
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

describe('«سجّل مسحوب» — one press', () => {
  it('sends the standing amount as it stands, with the day, the partner and the currency', async () => {
    await draw();
    const presses = screen.getAllByRole('button', { name: 'سجّل مسحوب' });
    expect(presses).toHaveLength(2); // one per standing currency of «شريك أ»; «شريك ب» has none
    fireEvent.change(screen.getByLabelText('تاريخ السحب'), { target: { value: '2026-11-22' } });
    fireEvent.click(presses[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance/partners/withdrawals',
      method: 'POST',
      body: { partnerId: 'p1', currencyCode: 'USD', amount: '250', withdrawnOn: '2026-11-22' },
    });
  });

  it('a figure typed over the standing one is what is sent for that press', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('المبلغ (JOD)'), { target: { value: '80.5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'سجّل مسحوب' })[1]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ partnerId: 'p1', currencyCode: 'JOD', amount: '80.5' });
  });

  it('a partner with no standing amount is told so, and «مبلغ تاني» opens a form for any currency of the stores', async () => {
    await draw();
    expect(screen.getByText('ما في مبلغ ثابت — حطّه من «المبالغ الثابتة» أو سجّل «مبلغ تاني».')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'مبلغ تاني' })[1]);
    const dialog = await screen.findByRole('dialog');
    const options = within(dialog).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toEqual(['JOD', 'SYP', 'USD']);
    fireEvent.change(within(dialog).getByLabelText('العملة *'), { target: { value: 'SYP' } });
    fireEvent.change(within(dialog).getByLabelText('المبلغ *'), { target: { value: '500000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'سجّل المسحوب' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ partnerId: 'p2', currencyCode: 'SYP', amount: '500000' });
  });

  it('a refusal from the server is said on the screen', async () => {
    await draw();
    api.mockImplementationOnce(async () => {
      throw new Error('المبلغ لازم يكون أكبر من صفر.');
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'سجّل مسحوب' })[0]);
    expect(await screen.findByText('المبلغ لازم يكون أكبر من صفر.')).toBeTruthy();
  });
});

describe('the standing amounts', () => {
  it('one box per currency of the stores; the empty one is sent empty (it clears)', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'المبالغ الثابتة' })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('دولار أمريكي (USD)'), { target: { value: '300' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ المبالغ' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance/partners/withdrawals',
      method: 'PUT',
      body: {
        partnerId: 'p1',
        amounts: [
          { currencyCode: 'JOD', amount: '70' },
          { currencyCode: 'SYP', amount: '' },
          { currencyCode: 'USD', amount: '300' },
        ],
      },
    });
  });
});

describe('the totals and the list', () => {
  it('each currency on its own line — the screen adds nothing across currencies', async () => {
    await draw();
    let card = screen.getByText('مجموع المسحوبات بهالمتجر') as HTMLElement;
    while (!card.querySelector('ul')) card = card.parentElement!;
    const lines = within(card).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('USD');
    expect(lines[1].textContent).toContain('JOD');
    expect(screen.getByText('المتجر التاني')).toBeTruthy();
  });

  it('«إلغاء» asks a reason and sends it; a cancelled row says «ملغى» and offers no second cancel', async () => {
    await draw();
    expect(screen.getAllByText('ملغى').length).toBeGreaterThan(0);
    expect(screen.getAllByText('أُلغي: غلط').length).toBeGreaterThan(0);
    const cancels = screen.getAllByRole('button', { name: 'إلغاء' });
    // The list is drawn as a table and as cards (the kit's `Rows`): every «إلغاء» is the live row's, none the cancelled one's.
    expect(cancels.length).toBeGreaterThan(0);
    for (const b of cancels) expect((b.closest('tr, li, article') as HTMLElement | null)?.textContent ?? '').not.toContain('ملغى');
    fireEvent.click(cancels[0]);
    const dialog = await screen.findByRole('dialog');
    const press = within(dialog).getByRole('button', { name: 'ألغِ المسحوب' }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('سبب الإلغاء *'), { target: { value: 'انسجّل بالغلط' } });
    fireEvent.click(press);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: '/api/finance/partners/withdrawals', method: 'PATCH', body: { withdrawalId: 'w1', reason: 'انسجّل بالغلط' } });
  });

  it('says it is a record: no wallet moves and the profit is unchanged', async () => {
    await draw();
    expect(screen.getByText('سجلّ لِلّي أخده كل شريك، بالمتجر والعملة. ما بيحرّك محفظة، وما بيغيّر الربح ولا حساب الشركاء.')).toBeTruthy();
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
