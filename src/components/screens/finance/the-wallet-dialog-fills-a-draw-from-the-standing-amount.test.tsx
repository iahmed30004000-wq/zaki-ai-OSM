// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «حركة جديدة» ← «سحب شريك» FILLS ITSELF FROM THE PARTNER'S STANDING AMOUNT (23/11, F7).
 *
 * «ليش ما تتثبت كم المسحوبات تبعتي بالدولار والدينار وكل عملة بدل ما كل مرة اسجل كم المبلغ؟» (the owner, over a screenshot of this
 * dialog: «كاش دينار أردني», صادر, 50 JOD, and the empty «ما يعادله بعملة المتجر (USD)»). Once the partner is chosen, the standing
 * row of THAT partner in THE WALLET's currency fills the amount — and «ما يعادله» when it was typed for this store's currency — with
 * the line «من المبلغ الثابت للشريك — تقدر تعدّله». Both boxes stay editable; what is sent is what they hold; the door is unchanged.
 */

const { who, sent, reads, answers } = vi.hoisted(() => ({
  who: { role: 'CUSTOM', keys: [] as string[] },
  sent: [] as { url: string; method: string; body: Record<string, unknown> }[],
  reads: [] as string[],
  answers: { standing: [] as unknown[] | Error, wallet: null as unknown },
}));

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: who.role, permissions: who.keys } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));

import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { WalletsScreen } from './WalletsScreen';

const USD_WALLET = {
  id: 'w1', name: 'الصندوق', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};
const JOD_WALLET = { ...USD_WALLET, id: 'w2', name: 'كاش دينار أردني', currencyCode: 'JOD' };

const line = (id: string, name: string) => ({ id, name, sharePercent: 50, isActive: true, entitlement: 500, draws: 0, balance: 500, broken: 0 });
const STATEMENT = {
  state: 'OK', sharesTotal: 100, currency: 'USD', minorUnit: 2, netProfit: 1000, uncounted: 0, draws: [],
  trust: { level: 'STATED', present: 10, population: 10, share: 100, ar: 'x' },
  totals: { entitlement: 1000, draws: 0, broken: 0 },
  lines: [line('pa', 'شريك أ'), line('pd', 'شريك د'), line('pn', 'شريك بلا مبلغ')],
};
const S = (partnerId: string, currencyCode: string, amount: number, storeValue: number | null = null, storeCurrencyCode: string | null = null) => ({
  partnerId, currencyCode, amount, storeValue, storeCurrencyCode,
});
const LINE = 'من المبلغ الثابت للشريك — تقدر تعدّله';

beforeEach(() => {
  vi.clearAllMocks();
  who.role = 'CUSTOM';
  who.keys = ['finance.cashbox_view', 'finance.cashbox', 'finance.partners'];
  sent.length = 0;
  reads.length = 0;
  answers.standing = [S('pa', 'USD', 250), S('pa', 'JOD', 50, 70.5, 'USD'), S('pd', 'USD', 100), S('pd', 'JOD', 40, 56, 'SYP')];
  answers.wallet = USD_WALLET;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return json({ movement: { id: 'm1' } }, 201);
      }
      reads.push(url);
      if (url === '/api/finance/partners/statement') return json(STATEMENT);
      if (url === '/api/finance/partners/withdrawals?part=standing') {
        return answers.standing instanceof Error ? json({ error: 'x' }, 500) : json({ standing: answers.standing, storeCurrency: 'USD' });
      }
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [answers.wallet] });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDraw() {
  render(
    <StoreCurrencyProvider code="USD">
      <WalletsScreen />
    </StoreCurrencyProvider>
  );
  fireEvent.click((await screen.findAllByText('حركة جديدة')).at(-1)!);
  const d = await screen.findByRole('dialog');
  const kind = within(d).getByLabelText(/^البند/) as HTMLSelectElement;
  await waitFor(() => expect(within(kind).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toContain('PARTNER_DRAW'));
  fireEvent.change(kind, { target: { value: 'PARTNER_DRAW' } });
  await waitFor(() => expect(within(partnerBox(d)).getAllByRole('option').length).toBeGreaterThan(1));
  // The standing amounts are read when the dialog opens; let them land before a partner is picked.
  await waitFor(() => expect(reads).toContain('/api/finance/partners/withdrawals?part=standing'));
  return d;
}
const partnerBox = (d: HTMLElement) => within(d).getByLabelText('الشريك') as HTMLSelectElement;
const amountBox = (d: HTMLElement) => within(d).getByLabelText(/^المبلغ/) as HTMLInputElement;
const valueBox = (d: HTMLElement) => within(d).queryByLabelText(/^ما يعادله بعملة المتجر/) as HTMLInputElement | null;
const send = (d: HTMLElement) => within(d).getByRole('button', { name: 'تسجيل السحب' }) as HTMLButtonElement;
const pick = (d: HTMLElement, id: string) => fireEvent.change(partnerBox(d), { target: { value: id } });
const writes = () => sent.filter((s) => s.method !== 'GET');

describe('the store’s own currency', () => {
  it('choosing the partner fills the amount from his standing row, and says so', async () => {
    const d = await openDraw();
    expect(amountBox(d).value).toBe('');
    pick(d, 'pa');
    await waitFor(() => expect(amountBox(d).value).toBe('250'));
    expect(within(d).getByText(LINE)).toBeTruthy();
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/finance/partners/draws', method: 'POST', body: { walletId: 'w1', partnerId: 'pa', amount: '250' } });
  });

  it('an edit overrides it: the typed figure is sent, and the line goes', async () => {
    const d = await openDraw();
    pick(d, 'pa');
    await waitFor(() => expect(amountBox(d).value).toBe('250'));
    fireEvent.change(amountBox(d), { target: { value: '300' } });
    expect(within(d).queryByText(LINE)).toBeNull();
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w1', partnerId: 'pa', amount: '300' });
  });

  it('a change of partner re-fills; a partner with no standing row empties what the pre-fill wrote', async () => {
    const d = await openDraw();
    pick(d, 'pa');
    await waitFor(() => expect(amountBox(d).value).toBe('250'));
    pick(d, 'pd');
    await waitFor(() => expect(amountBox(d).value).toBe('100'));
    pick(d, 'pn');
    await waitFor(() => expect(amountBox(d).value).toBe(''));
    expect(within(d).queryByText(LINE)).toBeNull();
    expect(send(d).disabled).toBe(true);
  });

  it('NEGATIVE: no standing row = today — the box stays empty, and what is typed is kept across a partner with none', async () => {
    answers.standing = [];
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '12' } });
    pick(d, 'pn');
    await new Promise((r) => setTimeout(r, 20));
    expect(amountBox(d).value).toBe('12');
    expect(within(d).queryByText(LINE)).toBeNull();
  });

  it('NEGATIVE: the standing amounts cannot be read — the boxes are typed, as they always were', async () => {
    answers.standing = new Error('down');
    const d = await openDraw();
    pick(d, 'pa');
    await new Promise((r) => setTimeout(r, 20));
    expect(amountBox(d).value).toBe('');
  });
});

describe('a wallet in another currency (the owner’s screenshot: a dinar wallet in a dollar store)', () => {
  beforeEach(() => {
    answers.wallet = JOD_WALLET;
  });

  it('fills the amount AND «ما يعادله بعملة المتجر (USD)» — both sent as they stand', async () => {
    const d = await openDraw();
    pick(d, 'pa');
    await waitFor(() => expect(amountBox(d).value).toBe('50'));
    expect(valueBox(d)!.value).toBe('70.5');
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w2', partnerId: 'pa', amount: '50', valueInStoreCurrency: '70.5' });
  });

  it('the equivalent is editable too, and the edit is what is sent', async () => {
    const d = await openDraw();
    pick(d, 'pa');
    await waitFor(() => expect(valueBox(d)!.value).toBe('70.5'));
    fireEvent.change(valueBox(d)!, { target: { value: '71' } });
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ amount: '50', valueInStoreCurrency: '71' });
  });

  it('NEGATIVE: an equivalent typed for another store currency is not used — the amount fills, «ما يعادله» stays required and empty', async () => {
    const d = await openDraw();
    pick(d, 'pd');
    await waitFor(() => expect(amountBox(d).value).toBe('40'));
    expect(valueBox(d)!.value).toBe('');
    expect(send(d).disabled).toBe(true);
  });

  it('NEGATIVE: a standing row in ANOTHER currency is ignored — a dollar figure never fills a dinar wallet', async () => {
    answers.standing = [S('pa', 'USD', 250)];
    const d = await openDraw();
    pick(d, 'pa');
    await new Promise((r) => setTimeout(r, 20));
    expect(amountBox(d).value).toBe('');
    expect(valueBox(d)!.value).toBe('');
  });
});

describe('who reads the standing amounts', () => {
  it('NEGATIVE: without «الشركاء والسحوبات» they are never asked for', async () => {
    who.keys = ['finance.cashbox_view', 'finance.cashbox', 'finance.create'];
    render(
      <StoreCurrencyProvider code="USD">
        <WalletsScreen />
      </StoreCurrencyProvider>
    );
    fireEvent.click((await screen.findAllByText('حركة جديدة')).at(-1)!);
    await screen.findByRole('dialog');
    expect(reads.some((u) => u.startsWith('/api/finance/partners/'))).toBe(false);
  });
});
