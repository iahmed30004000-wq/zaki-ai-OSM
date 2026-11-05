// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «خرج للتوصيل لكل الدفعة» on the batch card (2/11)
 *
 * «خرج للتوصيل» was pressed order by order on the shipping card; a courier worked by hand has no feed, so a batch of 160 parcels
 * was 160 presses. The card of a batch now carries one press for it.
 *
 *  1. The button is drawn only for whoever holds `ops.batches` AND `orders.change_status`, and only on a batch that has parcels
 *     still at «مشحون» — and says how many on its face: «خرج للتوصيل لكل الدفعة (158)».
 *  2. It asks first — «السائق أخذ الدفعة فعلاً؟» — with the count in the sentence. «No» sends nothing.
 *  3. «Yes» sends ONE request to the batch's own door, waits as long as a long batch needs, and refreshes the card.
 *  4. The answer stays on the card: what moved, what was left alone, and every parcel that did not move with the sentence of its
 *     reason — a toast gone in three seconds is no place for a name somebody has to act on.
 *  5. A refusal of the whole press (a key, an empty batch) is said in the server's words, and nothing is claimed.
 *  6. On a phone it is a full-width press of the stage's own group, 44px high, beside the other presses of the batch.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, perms, phone, confirmFn, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  perms: { list: [] as string[] },
  phone: { value: false },
  confirmFn: vi.fn(async (_o: unknown) => true),
  toast: { failed: vi.fn(), done: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => confirmFn,
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: perms.list } }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]);
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'x', describeRefused: () => '', openWaybills: vi.fn(), WaybillError: class extends Error {},
}));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

const LABEL = /خرج للتوصيل لكل الدفعة/;
const KEYS = ['ops.batches', 'orders.change_status'];

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0007', status: 'SHIPPED',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: false },
  creator: { id: 'u1', name: 'قبس' }, createdAt: '2026-11-02T07:00:00.000Z', shippedAt: '2026-11-02T08:00:00.000Z', notes: null,
  _count: { orders: 160 }, courierCityGap: null, shippedCount: 158, ...over,
});

/** The list as the server would answer it, changeable between calls; the press answers with what the test says. */
let listed: ReturnType<typeof batch>[];
let answer: (url: string, init: RequestInit) => unknown;
const serve = () =>
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/out-for-delivery')) return answer(url, init);
    return { batches: listed, pagination: { total: listed.length } };
  });

const summary = (over: Record<string, unknown> = {}) => ({
  success: true, total: 160, moved: 158, skipped: 2, failed: 0, failedOrders: [], failures: [], ...over,
});

const presses = () => apiJson.mock.calls.filter(([url, init]) => String(url).endsWith('/out-for-delivery') && (init as RequestInit)?.method === 'POST');
const button = async () => (await screen.findByRole('button', { name: LABEL }, WAIT)) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  perms.list = [...KEYS];
  phone.value = false;
  confirmFn.mockImplementation(async () => true);
  listed = [batch()];
  answer = () => summary();
  serve();
});
afterEach(cleanup);

describe('1 · the button: who sees it, on which batch, with which number', () => {
  it('is drawn for a holder of both keys on a batch with parcels at «مشحون», with the count on its face', async () => {
    render(<ShippingBatchesScreen />);
    const b = await button();
    expect(b.textContent).toContain('خرج للتوصيل لكل الدفعة (158)');
    expect(b.disabled).toBe(false);
  });

  it('is the count the SERVER sent, not the number of orders in the batch (160 orders, 158 waiting)', async () => {
    listed = [batch({ shippedCount: 3, _count: { orders: 160 } })];
    render(<ShippingBatchesScreen />);
    expect((await button()).textContent).toContain('(3)');
  });

  it.each([
    ['without the batches key', ['orders.change_status']],
    ['without the shipping-status key', ['ops.batches']],
    ['with neither', []],
  ])('NEGATIVE: %s the button is not drawn at all', async (_n, keys) => {
    perms.list = keys;
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0007', undefined, WAIT);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it.each([
    ['no parcel waiting (0)', { shippedCount: 0 }],
    ['a server that does not send the count', { shippedCount: undefined }],
  ])('NEGATIVE: %s — no button', async (_n, over) => {
    listed = [batch(over)];
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0007', undefined, WAIT);
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it.each(['READY', 'SHIPPED', 'CLOSED'])('is a question of the PARCELS, not of the batch’s status: drawn on a %s batch that has some waiting', async (status) => {
    listed = [batch({ status })];
    render(<ShippingBatchesScreen />);
    expect(await button()).toBeTruthy();
  });

  it('each card has its own: two batches, two buttons, each with its own count', async () => {
    listed = [batch({ id: 'b1', batchNumber: 'BATCH-1', shippedCount: 5 }), batch({ id: 'b2', batchNumber: 'BATCH-2', shippedCount: 9 }), batch({ id: 'b3', batchNumber: 'BATCH-3', shippedCount: 0 })];
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-3', undefined, WAIT);
    const names = screen.getAllByRole('button', { name: LABEL }).map((b) => b.textContent);
    expect(names).toEqual(['خرج للتوصيل لكل الدفعة (5)', 'خرج للتوصيل لكل الدفعة (9)']);
  });
});

describe('2 · it asks first, in the words of the question', () => {
  it('«السائق أخذ الدفعة فعلاً؟» with the count in the sentence — and «no» sends nothing', async () => {
    confirmFn.mockImplementation(async () => false);
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());

    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    const asked = confirmFn.mock.calls[0][0] as { title: string; body: string };
    expect(asked.title).toBe('السائق أخذ الدفعة فعلاً؟');
    expect(asked.body).toBe('بتتحدّث 158 طلب لـ«خرج للتوصيل».');
    expect(presses(), 'a «no» still sent the press').toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    [1, 'بتتحدّث طلب واحد لـ«خرج للتوصيل».'],
    [2, 'بتتحدّث طلبين لـ«خرج للتوصيل».'],
    [3, 'بتتحدّث 3 طلبات لـ«خرج للتوصيل».'],
    [10, 'بتتحدّث 10 طلبات لـ«خرج للتوصيل».'],
    [11, 'بتتحدّث 11 طلب لـ«خرج للتوصيل».'],
    [160, 'بتتحدّث 160 طلب لـ«خرج للتوصيل».'],
  ])('the count is said the way Arabic counts: %i', async (n, sentence) => {
    listed = [batch({ shippedCount: n })];
    confirmFn.mockImplementation(async () => false);
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect((confirmFn.mock.calls[0][0] as { body: string }).body).toBe(sentence);
  });
});

describe('3 · «yes» sends one request to the batch’s own door and refreshes the card', () => {
  it('POSTs /api/shipping-batches/:id/out-for-delivery once, with a wait longer than the default', async () => {
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());

    await waitFor(() => expect(presses()).toHaveLength(1));
    const [url, init] = presses()[0] as [string, RequestInit & { timeoutMs?: number }];
    expect(url).toBe('/api/shipping-batches/b1/out-for-delivery');
    expect(init.method).toBe('POST');
    expect(init.timeoutMs, 'a hundred and sixty parcels are not fifteen seconds’ work').toBeGreaterThan(15_000);
  });

  it('refreshes the list after the press, and the button goes when nothing is left at «مشحون»', async () => {
    answer = () => {
      listed = [batch({ shippedCount: 0 })]; // the server moved them: the next read of the list says so
      return summary({ skipped: 2 });
    };
    render(<ShippingBatchesScreen />);
    const listReads = () => apiJson.mock.calls.filter(([url]) => String(url).startsWith('/api/shipping-batches?')).length;
    const before = listReads();
    fireEvent.click(await button());

    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('button', { name: LABEL })).toBeNull());
    expect(screen.getByRole('status'), 'the answer outlives the button').toBeTruthy();
  });

  it('is shut while it works, so a second click cannot send a second press', async () => {
    let release: (v: unknown) => void = () => undefined;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/out-for-delivery')) return new Promise((resolve) => { release = resolve; });
      return { batches: listed, pagination: { total: 1 } };
    });
    render(<ShippingBatchesScreen />);
    const b = await button();
    fireEvent.click(b);

    await waitFor(() => expect((screen.getByRole('button', { name: LABEL }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(presses()).toHaveLength(1);

    release(summary());
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
});

describe('4 · the answer stays on the card', () => {
  // The answer panel is the first live region of the page; the copy buttons of a named parcel (`OrderRef`) carry their own inside it.
  const status = async () => (await screen.findAllByRole('status', undefined, WAIT))[0] as HTMLElement;

  it('what moved and what was left alone', async () => {
    answer = () => summary({ moved: 158, skipped: 2 });
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());
    const s = await status();
    expect(s.textContent).toContain('خرج للتوصيل 158 طلب');
    expect(s.textContent).toContain('تخطّينا 2 (مو بحالة «مشحون»)');
    expect(s.textContent).not.toContain('تعذّر');
  });

  it('every parcel that did not move is named with the sentence of its reason', async () => {
    answer = () =>
      summary({
        moved: 156, skipped: 2, failed: 2, failedOrders: ['ORD-2026-0031', 'ORD-2026-0102'],
        failures: [
          { orderId: 'o31', orderNumber: 'ORD-2026-0031', code: 'ORDER_LOCKED', errorAr: 'موظف آخر يعدّل هذا الطلب الآن — جرّب بعد قليل.' },
          { orderId: 'o102', orderNumber: 'ORD-2026-0102', code: 'VERSION_CONFLICT', errorAr: 'عدّله شخص آخر قبلك — اضغط من جديد.' },
        ],
      });
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());

    const s = await status();
    expect(s.textContent).toContain('خرج للتوصيل 156 طلب');
    expect(s.textContent).toContain('تعذّر 2');
    const items = within(s).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'ORD-2026-0031 — موظف آخر يعدّل هذا الطلب الآن — جرّب بعد قليل.',
      'ORD-2026-0102 — عدّله شخص آخر قبلك — اضغط من جديد.',
    ]);
    // Each number is the order's own reference: the copy press of that number is beside it, like everywhere else on a screen.
    expect(within(items[0]).getByRole('button', { name: 'نسخ رقم الطلب ORD-2026-0031' })).toBeTruthy();
    expect(within(items[1]).getByRole('button', { name: 'نسخ رقم الطلب ORD-2026-0102' })).toBeTruthy();
  });

  it('a second press of a batch that has nothing left says so: nothing moved, all of them left alone', async () => {
    answer = () => summary({ moved: 0, skipped: 160 });
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());
    const s = await status();
    expect(s.textContent).toContain('ما تحرّك أي طلب');
    expect(s.textContent).toContain('تخطّينا 160');
  });

  it('the answer is on the card of ITS batch, not another', async () => {
    listed = [batch({ id: 'b1', batchNumber: 'BATCH-1', shippedCount: 5 }), batch({ id: 'b2', batchNumber: 'BATCH-2', shippedCount: 9 })];
    answer = () => summary({ moved: 5, skipped: 0 });
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2', undefined, WAIT);
    fireEvent.click(screen.getAllByRole('button', { name: LABEL })[0]);

    const s = await status();
    const cards = Array.from(document.querySelectorAll('li')).filter((li) => li.textContent?.includes('BATCH-'));
    expect(cards[0].contains(s)).toBe(true);
    expect(cards[1].contains(s)).toBe(false);
  });

  it('a new press clears the old answer first, so an old answer is never read as the new one', async () => {
    let release: (v: unknown) => void = () => undefined;
    let n = 0;
    answer = () => {
      n += 1;
      return n === 1 ? summary({ moved: 158, skipped: 0 }) : new Promise((resolve) => { release = resolve; });
    };
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());
    expect((await status()).textContent).toContain('158');

    fireEvent.click(await button());
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    release(summary({ moved: 7, skipped: 0 }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('خرج للتوصيل 7 طلبات'));
  });
});

describe('5 · a press the server refused is said, and nothing is claimed', () => {
  it('shows the server’s Arabic sentence and draws no answer panel', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/out-for-delivery')) {
        throw Object.assign(new Error('الدفعة فاضية — ما في طرد يتحرّك.'), { status: 409, data: { code: 'EMPTY_BATCH' } });
      }
      return { batches: listed, pagination: { total: 1 } };
    });
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());

    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('الدفعة فاضية — ما في طرد يتحرّك.'));
    expect(screen.queryByRole('status')).toBeNull();
    expect((await button()).disabled, 'the button is back for another try').toBe(false);
  });
});

describe('6 · on a phone', () => {
  it('is a full-width press of the stage’s own group, 44px high, with the handover’s presses', async () => {
    phone.value = true;
    listed = [batch({ status: 'SHIPPED' })];
    render(<ShippingBatchesScreen />);
    const b = await button();

    expect(b.className).toContain('min-h-11');
    expect(b.className).toContain('w-full');
    // The group of presses that move the batch on: this one alone now — «أنهِ الدفعة بعد التسوية» is gone (5/11).
    const group = b.parentElement as HTMLElement;
    expect(group.className).toContain('flex-col');
    const inGroup = Array.from(group.querySelectorAll('button')).map((x) => x.textContent?.trim());
    expect(inGroup).toEqual(['خرج للتوصيل لكل الدفعة (158)']);
  });

  it('on a desk it sits in the wrapping row beside the other presses, not full width', async () => {
    phone.value = false;
    listed = [batch({ status: 'SHIPPED' })];
    render(<ShippingBatchesScreen />);
    const b = await button();
    expect(b.className).not.toContain('w-full');
    expect(b.className).toContain('md:min-h-0');
    expect((b.parentElement as HTMLElement).className).toContain('flex-wrap');
    const row = Array.from((b.parentElement as HTMLElement).querySelectorAll('button')).map((x) => x.textContent?.trim());
    expect(row).toContain('خرج للتوصيل لكل الدفعة (158)');
    expect(row).not.toContain('أنهِ الدفعة بعد التسوية');
  });

  it('the answer is the same on both', async () => {
    phone.value = true;
    answer = () => summary({ moved: 158, skipped: 2 });
    render(<ShippingBatchesScreen />);
    fireEvent.click(await button());
    expect((await screen.findByRole('status', undefined, WAIT)).textContent).toContain('خرج للتوصيل 158 طلب');
  });
});

describe('7 · nothing else on the card changed', () => {
  it('a batch with no parcel waiting draws the buttons it always drew', async () => {
    listed = [batch({ shippedCount: 0, status: 'SHIPPED' })];
    render(<ShippingBatchesScreen />);
    await screen.findByText('BATCH-2026-0007', undefined, WAIT);
    const names = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    // «أنهِ الدفعة بعد التسوية» is gone (5/11): the courier settles orders, not batches.
    expect(names).not.toContain('أنهِ الدفعة بعد التسوية');
    expect(names.some((n) => LABEL.test(n ?? ''))).toBe(false);
  });
});
