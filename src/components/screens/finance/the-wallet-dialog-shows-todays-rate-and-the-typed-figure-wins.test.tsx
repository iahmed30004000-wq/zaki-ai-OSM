// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «حركة جديدة» ← «سحب شريك» SHOWS «ما يعادله» AT TODAY'S RATE (23/11, F8).
 *
 * A dinar wallet in a dollar store: once an amount is typed, «ما يعادله» shows the figure the server will write from today's rate,
 * with «بسعر اليوم — تقدر تعدّله», the kind, the source and the date — and NOTHING is sent for it (the server fills it and freezes the
 * rate). A figure the person types is sent and wins. A pound wallet with no typed rate says «ما في سعر — اكتب سعر الليرة بالإعدادات»
 * and still saves. The field is never required.
 */

const { who, sent, answers } = vi.hoisted(() => ({
  who: { role: 'CUSTOM', keys: [] as string[] },
  sent: [] as { url: string; method: string; body: Record<string, unknown> }[],
  answers: { wallet: null as unknown, rates: null as unknown },
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
const JOD_WALLET = { ...USD_WALLET, id: 'w2', name: 'كاش دينار', currencyCode: 'JOD' };
const SYP_WALLET = { ...USD_WALLET, id: 'w3', name: 'كاش ليرة', currencyCode: 'SYP' };
const line = (id: string, name: string) => ({ id, name, sharePercent: 50, isActive: true, entitlement: 500, draws: 0, balance: 500, broken: 0 });
const STATEMENT = {
  state: 'OK', sharesTotal: 100, currency: 'USD', minorUnit: 2, netProfit: 1000, uncounted: 0, draws: [],
  trust: { level: 'STATED', present: 10, population: 10, share: 100, ar: 'x' },
  totals: { entitlement: 1000, draws: 0, broken: 0 },
  lines: [line('pa', 'شريك أ')],
};
const TODAY = new Date().toISOString();
const RATES = {
  table: {
    auto: { attemptedAt: TODAY, fiat: { source: 'open.er-api.com', asOf: TODAY, fetchedAt: TODAY, perUsd: { JOD: 0.709 } } },
    manual: { rates: {} },
  },
};
const LINE = 'بسعر اليوم — تقدر تعدّله';

beforeEach(() => {
  vi.clearAllMocks();
  who.keys = ['finance.cashbox_view', 'finance.cashbox', 'finance.partners'];
  sent.length = 0;
  answers.wallet = JOD_WALLET;
  answers.rates = RATES;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return json({ movement: { id: 'm1' } }, 201);
      }
      if (url === '/api/finance/partners/statement') return json(STATEMENT);
      if (url === '/api/finance/partners/withdrawals?part=standing') return json({ standing: [] });
      if (url === '/api/finance/exchange-rates') return answers.rates instanceof Error ? json({ error: 'x' }, 500) : json(answers.rates);
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
  fireEvent.change(partnerBox(d), { target: { value: 'pa' } });
  return d;
}
const partnerBox = (d: HTMLElement) => within(d).getByLabelText('الشريك') as HTMLSelectElement;
const amountBox = (d: HTMLElement) => within(d).getByLabelText(/^المبلغ/) as HTMLInputElement;
const valueBox = (d: HTMLElement) => within(d).getByLabelText(/^ما يعادله بعملة المتجر/) as HTMLInputElement;
const send = (d: HTMLElement) => within(d).getByRole('button', { name: 'تسجيل السحب' }) as HTMLButtonElement;
const writes = () => sent.filter((s) => s.method !== 'GET');

describe('today’s rate in the box', () => {
  it('100 JOD shows 141.04 with «بسعر اليوم — تقدر تعدّله», «تلقائي» and the source; NOTHING is sent for it — the server fills and freezes it', async () => {
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '100' } });
    await waitFor(() => expect(valueBox(d).value).toBe('141.04'));
    expect(d.textContent).toContain(LINE);
    expect(d.textContent).toContain('تلقائي · open.er-api.com');
    expect(d.textContent).toContain('بسعر يوم التسجيل');
    expect(valueBox(d).required).toBe(false);
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w2', partnerId: 'pa', amount: '100' });
  });

  it('the figure follows the amount until the box is touched', async () => {
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '100' } });
    await waitFor(() => expect(valueBox(d).value).toBe('141.04'));
    fireEvent.change(amountBox(d), { target: { value: '70.9' } });
    await waitFor(() => expect(valueBox(d).value).toBe('100'));
  });

  it('a value the person typed wins: it is sent, and the today line goes', async () => {
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '100' } });
    await waitFor(() => expect(valueBox(d).value).toBe('141.04'));
    fireEvent.change(valueBox(d), { target: { value: '140' } });
    expect(d.textContent).not.toContain(LINE);
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w2', partnerId: 'pa', amount: '100', valueInStoreCurrency: '140' });
  });

  it('an emptied box never blocks: nothing is sent for it, and the server fills it from today’s rate', async () => {
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '100' } });
    await waitFor(() => expect(valueBox(d).value).toBe('141.04'));
    fireEvent.change(valueBox(d), { target: { value: '' } });
    expect(send(d).disabled).toBe(false);
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w2', partnerId: 'pa', amount: '100' });
  });
});

describe('no rate', () => {
  it('NEGATIVE: a pound wallet with no typed rate says «ما في سعر — اكتب سعر الليرة بالإعدادات», the box is empty, and it still saves', async () => {
    answers.wallet = SYP_WALLET;
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '1300000' } });
    await waitFor(() => expect(d.textContent).toContain('ما في سعر — اكتب سعر الليرة بالإعدادات'));
    expect(valueBox(d).value).toBe('');
    expect(send(d).disabled).toBe(false);
    fireEvent.click(send(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w3', partnerId: 'pa', amount: '1300000' });
  });

  it('NEGATIVE: the rates cannot be read — the box is empty and typed, as before; nothing blocks', async () => {
    answers.rates = new Error('down');
    const d = await openDraw();
    fireEvent.change(amountBox(d), { target: { value: '100' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(valueBox(d).value).toBe('');
    expect(d.textContent).not.toContain(LINE);
    expect(send(d).disabled).toBe(false);
  });
});
