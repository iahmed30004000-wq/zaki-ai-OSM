// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «استلمت منه» ON A COURIER'S ORDERS OPENS «تسليم المندوب» — THE MANUAL STATEMENT, DRAWN (F9, 23/11).
 *
 *   · the two presses of the manual statement, with the reference «تسليم {المندوب} {التاريخ}» (editable), and a refused
 *     reference retried WITHOUT adding the orders again;
 *   · the panel: «استلمت / باقي», «زيادة» in red, the per-currency table, «مستلَم — لم يُعتمد بعد»;
 *   · a payment line: this country's wallets only (an unplaced one says «غير مخصّصة»), a rate only for another currency, ONE id
 *     per line kept across a failed press, the button shut while saving;
 *   · «اعتماد» runs the matching and then the approval;
 *   · a person without the keys reads which key — never a dead button;
 *   · orders with no courier keep the old hand form, now on this country's wallets.
 */

const { api, user } = vi.hoisted(() => ({ api: vi.fn(), user: { current: null as unknown } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));

import { CollectDialog } from './CollectDialog';
import { OpenHandovers } from './OpenHandovers';
import { HANDOVER_MAX_PROOF_MB, NO_APPROVE_SENTENCE, NO_UPLOAD_SENTENCE, NOT_APPROVED_YET } from './HandoverPanel';
import { MAX_PROOF_BYTES } from '@/lib/settlement-proof';
import { handoverReference } from '@/lib/handover';

const ST = '88888888-8888-4888-8888-888888888888';
const keys = (...permissions: string[]) => ({ id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions });
const ALL = keys('settlement.upload', 'settlement.review', 'settlement.approve', 'finance.cashbox');

const courierOrder = (id: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber: `SY-${id}`, totalAmount: 20, currency: 'SYP', deliveryFee: 3, expectedCollection: 650_000,
  customer: { fullName: 'سامر' }, deliveryProvider: { id: 'p1', name: 'أبو علي', kind: 'AGENT' }, ...over,
});

const handover = (over: Record<string, unknown> = {}) => ({
  id: ST, reference: 'تسليم أبو علي 2026-11-23', courier: 'أبو علي', currencyCode: 'SYP', orders: 2,
  gap: { claimed: 1_300_000, received: 500_000, gap: -800_000, unconvertible: 0, needsExplanation: true },
  standing: { claimed: 1_300_000, received: 500_000, remaining: 800_000, over: 0 },
  receipts: [{ id: 'r1', amount: 50, currencyCode: 'USD', exchangeRate: 0.0001, receivedAt: '2026-11-23T08:00:00Z', proofName: null, wallet: 'صندوق الدولار' }],
  table: [{ currencyCode: 'USD', amount: 50, rates: [0.0001], equivalent: 500_000 }],
  ...over,
});

const WALLETS = [
  { id: 'w-syp', name: 'صندوق الليرة', currencyCode: 'SYP' },
  { id: 'w-usd', name: 'صندوق الدولار', currencyCode: 'USD' },
  { id: 'w-free', name: 'صندوق عام', currencyCode: 'SYP', unassigned: true },
];

let open = handover();
const calls = (pred: (url: string, init?: RequestInit) => boolean) => api.mock.calls.filter((c) => pred(c[0] as string, c[1] as RequestInit));
const posted = (path: string) => calls((u, i) => u === path && i?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  user.current = ALL;
  open = handover();
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/finance/statements/manual' && init?.method === 'POST') return { statementId: ST };
    if (url.startsWith('/api/finance/statements/manual')) return { handovers: [open] };
    if (url === '/api/finance/wallets?scope=collect') return { wallets: WALLETS };
    if (url.endsWith('/assemble')) return { statementId: ST };
    if (url.endsWith('/receipts')) return { receipt: {}, gap: {} };
    if (url.endsWith('/match')) return {};
    if (init?.method === 'PATCH') return { statement: {} };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const startHandover = async () => {
  render(<CollectDialog orders={[courierOrder('o1'), courierOrder('o2')]} onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /افتح التسليم/ }));
  await screen.findAllByText(/المطلوب/);
};

describe('opening the handover — the manual statement’s two presses', () => {
  it('adds the ticked orders, gathers them under «تسليم {المندوب} {التاريخ}», then shows the panel', async () => {
    await startHandover();
    expect(JSON.parse(posted('/api/finance/statements/manual')[0][1].body as string)).toEqual({
      orders: [{ orderId: 'o1' }, { orderId: 'o2' }],
    });
    const assemble = posted(`/api/finance/statements/${ST}/assemble`);
    expect(JSON.parse(assemble[0][1].body as string)).toEqual({ reference: handoverReference('أبو علي', new Date()) });
    expect(screen.getByText(/باقي/)).toBeTruthy();
  });

  it('the reference is the person’s to change', async () => {
    render(<CollectDialog orders={[courierOrder('o1')]} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('مرجع التسليم'), { target: { value: 'تسليم الخميس' } });
    fireEvent.click(screen.getByRole('button', { name: /افتح التسليم/ }));
    await screen.findAllByText(/المطلوب/);
    expect(JSON.parse(posted(`/api/finance/statements/${ST}/assemble`)[0][1].body as string).reference).toBe('تسليم الخميس');
  });

  it('a refused reference is said in the door’s words, and the retry does NOT add the orders a second time', async () => {
    let refuse = true;
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assemble') && refuse) {
        refuse = false;
        throw new Error('المرجع «x» مستعمل لهذه الشركة في كشف يدوي آخر — اختر مرجعاً مختلفاً');
      }
      return base(url, init);
    });
    render(<CollectDialog orders={[courierOrder('o1')]} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /افتح التسليم/ }));
    expect(await screen.findByText(/مستعمل لهذه الشركة/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /افتح التسليم/ }));
    await screen.findAllByText(/المطلوب/);
    expect(posted('/api/finance/statements/manual')).toHaveLength(1);
    expect(posted(`/api/finance/statements/${ST}/assemble`)).toHaveLength(2);
  });

  it('NEGATIVE: the cash box alone reads which key is missing, the button is shut, and nothing is sent', async () => {
    user.current = keys('finance.cashbox', 'finance.cashbox_view');
    render(<CollectDialog orders={[courierOrder('o1')]} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText(NO_UPLOAD_SENTENCE)).toBeTruthy();
    expect(NO_UPLOAD_SENTENCE).toContain('رفع تقارير الشحن');
    const press = screen.getByRole('button', { name: /افتح التسليم/ }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.click(press);
    expect(api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });
});

describe('the panel', () => {
  it('says «استلمت / باقي», draws the per-currency table and «مستلَم — لم يُعتمد بعد»', async () => {
    await startHandover();
    expect(screen.getByText(NOT_APPROVED_YET)).toBeTruthy();
    const table = screen.getByRole('list', { name: 'حسب العملة' });
    expect(within(table).getByText(/USD/)).toBeTruthy();
    expect(within(table).getByText('0.0001')).toBeTruthy();
  });

  it('a payment above the total says «زيادة» in red', async () => {
    open = handover({
      gap: { claimed: 1_300_000, received: 1_400_000, gap: 100_000, unconvertible: 0, needsExplanation: true },
      standing: { claimed: 1_300_000, received: 1_400_000, remaining: 0, over: 100_000 },
    });
    await startHandover();
    const over = screen.getByText(/زيادة/);
    expect(over.className).toContain('text-[var(--sys-destructive)]');
    expect(screen.queryByText(/باقي/)).toBeNull();
  });

  it('offers this country’s wallets of the chosen currency, an unplaced one said «غير مخصّصة»', async () => {
    await startHandover();
    const walletBox = screen.getByLabelText('المحفظة') as HTMLSelectElement;
    const names = [...walletBox.options].map((o) => o.textContent);
    expect(names).toEqual(['اختر…', 'صندوق الليرة', 'صندوق عام (غير مخصّصة)']);
    expect(calls((u) => u === '/api/finance/wallets?scope=collect')).toHaveLength(1);
    expect(calls((u) => u === '/api/finance/wallets')).toHaveLength(0);
  });

  it('asks a rate only for another currency, and says what it is worth in the orders’ currency', async () => {
    await startHandover();
    expect(screen.queryByLabelText(/سعر الصرف/)).toBeNull();
    fireEvent.change(screen.getByLabelText('العملة'), { target: { value: 'USD' } });
    fireEvent.change(screen.getByLabelText('المبلغ (USD)'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/سعر الصرف/), { target: { value: '0.0001' } });
    expect(screen.getByText('يساوي 500000 SYP')).toBeTruthy();
  });

  it('ONE id per line: a failed press is retried with the same id; a saved one starts a new id', async () => {
    let fail = true;
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/receipts') && fail) {
        fail = false;
        throw new Error('انقطع الاتصال');
      }
      return base(url, init);
    });
    await startHandover();
    const line = () => {
      fireEvent.change(screen.getByLabelText('المحفظة'), { target: { value: 'w-syp' } });
      fireEvent.change(screen.getByLabelText('المبلغ (SYP)'), { target: { value: '800000' } });
      fireEvent.click(screen.getByRole('button', { name: /سجّل الدفعة/ }));
    };
    line();
    expect(await screen.findByText('انقطع الاتصال')).toBeTruthy();
    line();
    await screen.findByText(/انسجّلت الدفعة/);
    line();
    await waitFor(() => expect(posted(`/api/finance/statements/${ST}/receipts`)).toHaveLength(3));
    const ids = posted(`/api/finance/statements/${ST}/receipts`).map((c) => JSON.parse(c[1].body as string).receiptId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(JSON.parse(posted(`/api/finance/statements/${ST}/receipts`)[1][1].body as string)).toMatchObject({ walletId: 'w-syp', amount: 800000 });
  });

  it('the payment button is shut while a payment is on its way', async () => {
    let release: () => void = () => undefined;
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/receipts')) await new Promise<void>((r) => (release = r));
      return base(url, init);
    });
    await startHandover();
    fireEvent.change(screen.getByLabelText('المحفظة'), { target: { value: 'w-syp' } });
    fireEvent.change(screen.getByLabelText('المبلغ (SYP)'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /سجّل الدفعة/ }));
    const busy = (await screen.findByRole('button', { name: /جارٍ التسجيل/ })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    release();
    await screen.findByText(/انسجّلت الدفعة/);
    expect(posted(`/api/finance/statements/${ST}/receipts`)).toHaveLength(1);
  });

  it('«اعتماد» runs the matching and then the approval, with the written reason for the gap', async () => {
    const onDone = vi.fn();
    render(<CollectDialog orders={[courierOrder('o1')]} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /افتح التسليم/ }));
    await screen.findAllByText(/المطلوب/);
    const approve = screen.getByRole('button', { name: /^اعتماد$/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true); // a gap with no reason yet
    fireEvent.change(screen.getByLabelText(/تفسير الفرق/), { target: { value: 'الباقي بيدفعه بكرا' } });
    fireEvent.click(approve);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const order = api.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? 'GET'} ${c[0]}`);
    const m = order.indexOf(`POST /api/finance/statements/${ST}/match`);
    const p = order.indexOf(`PATCH /api/finance/statements/${ST}`);
    expect(m).toBeGreaterThan(-1);
    expect(p).toBeGreaterThan(m);
    expect(JSON.parse(calls((u, i) => i?.method === 'PATCH')[0][1].body as string)).toEqual({
      approve: true, gapExplanation: 'الباقي بيدفعه بكرا',
    });
  });

  it('NEGATIVE: without the approval keys the panel says which, and draws no «اعتماد»', async () => {
    user.current = keys('settlement.upload');
    await startHandover();
    expect(screen.getByText(NO_APPROVE_SENTENCE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^اعتماد$/ })).toBeNull();
  });

  it('«شام كاش»: any wallet of the currency is offered, and the transfer number travels as the receipt’s note — optional, cash sends none', async () => {
    WALLETS.push({ id: 'w-sham', name: 'شام كاش دولار', currencyCode: 'USD' });
    try {
      await startHandover();
      fireEvent.change(screen.getByLabelText('العملة'), { target: { value: 'USD' } });
      const names = [...(screen.getByLabelText('المحفظة') as HTMLSelectElement).options].map((o) => o.textContent);
      expect(names).toEqual(['اختر…', 'صندوق الدولار', 'شام كاش دولار']);
      fireEvent.change(screen.getByLabelText('المحفظة'), { target: { value: 'w-sham' } });
      fireEvent.change(screen.getByLabelText('المبلغ (USD)'), { target: { value: '50' } });
      fireEvent.change(screen.getByLabelText(/سعر الصرف/), { target: { value: '0.0001' } });
      fireEvent.change(screen.getByLabelText('رقم الحوالة / إثبات (اختياري)'), { target: { value: 'SC-4471' } });
      fireEvent.click(screen.getByRole('button', { name: /سجّل الدفعة/ }));
      await screen.findByText(/انسجّلت الدفعة/);
      fireEvent.change(screen.getByLabelText('العملة'), { target: { value: 'SYP' } });
      fireEvent.change(screen.getByLabelText('المحفظة'), { target: { value: 'w-syp' } });
      fireEvent.change(screen.getByLabelText('المبلغ (SYP)'), { target: { value: '800000' } });
      fireEvent.click(screen.getByRole('button', { name: /سجّل الدفعة/ }));
      await waitFor(() => expect(posted(`/api/finance/statements/${ST}/receipts`)).toHaveLength(2));
      const [sham, cash] = posted(`/api/finance/statements/${ST}/receipts`).map((c) => JSON.parse(c[1].body as string));
      expect(sham).toMatchObject({ walletId: 'w-sham', amount: 50, exchangeRate: 0.0001, note: 'SC-4471' });
      expect(cash).toMatchObject({ walletId: 'w-syp', amount: 800000 });
      expect(cash).not.toHaveProperty('note');
    } finally {
      WALLETS.pop();
    }
  });

  it('the proof ceiling is the server’s', () => {
    expect(HANDOVER_MAX_PROOF_MB * 1024 * 1024).toBe(MAX_PROOF_BYTES);
  });
});

describe('orders with no courier keep the old hand form', () => {
  it('is the old form, on this country’s active wallets', async () => {
    render(
      <CollectDialog
        orders={[courierOrder('o1', { deliveryProvider: null, currency: 'SYP' })]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /استلمت منه/ })).toBeTruthy();
    await waitFor(() => expect(calls((u) => u === '/api/finance/wallets?scope=collect')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /افتح التسليم/ })).toBeNull();
  });
});

describe('the open handovers', () => {
  it('draw a card «{المندوب} — باقي X» with «سجّل دفعة», which opens the panel', async () => {
    render(<OpenHandovers />);
    expect(await screen.findByText('أبو علي — باقي 800000 SYP')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /سجّل دفعة/ }));
    expect(await screen.findByText(NOT_APPROVED_YET)).toBeTruthy();
  });

  it('NEGATIVE: for a person without «رفع تقارير الشحن» draw nothing and ask nothing', async () => {
    user.current = keys('finance.cashbox');
    const { container } = render(<OpenHandovers />);
    await Promise.resolve();
    expect(container.textContent).toBe('');
    expect(api).not.toHaveBeenCalled();
  });
});
