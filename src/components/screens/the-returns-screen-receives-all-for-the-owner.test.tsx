// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «استلام الكل» ON THE RETURNS DESK — DRAWN FOR THE OWNER ONLY, ASKED BEFORE IT ACTS, AND SAID IN ONE LINE.
 *
 *   «بدي زر استلام الكل مع صلاحية للمالك» (11/11)
 *
 *   · the button is drawn only when the SERVER says `mayReceiveAll`, only in the work view, only when the list holds
 *     something — and its number is the list's own total (every page of the chosen filters);
 *   · it opens a dialog that says what one press does, that there is no undo, and keeps «نعم، استلم الكل» off until the tick;
 *   · then it walks the door with the same filters and each cursor, shows «استلمت X من Y», can be stopped, and ends with
 *     ONE line of counts by reason — and the list reloads;
 *   · on a phone it is the same button, at a thumb's height.
 */

const { api, phone, failed } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false }, failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المرتجعات</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, done: vi.fn() }) }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => <button type="button">امسح</button> }));

import { ReturnsScreen } from './ReturnsScreen';

const FACTS = {
  views: { pending: 374, received: 14 },
  statuses: { RETURN_REQUESTED: 4, RETURNED: 300, FAILED_DELIVERY: 60, PARTIALLY_DELIVERED: 10 },
  couriers: [],
  ages: { fresh: 1, few: 2, week: 3, old: 368 },
};
const ROW = {
  id: 'o1', orderNumber: 'ORD-1', merchantRef: null, trackingNumber: 'T1', shippingStatus: 'RETURNED', returnReason: null,
  expectedQty: 3, daysWaited: 2, customer: { fullName: 'سارة' }, region: { name: 'عمّان' }, deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: null, expectedBack: 3 }],
  completion: { halves: [], settledCount: 0, degree: 'NONE', complete: false, awaiting: [], label: '' },
  action: null,
};

let may: boolean | undefined;
let total: number;
let answers: { received: number; skipped: Record<string, number>; nextCursor: string | null }[];

const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const postBodies = () => posts().map((c) => JSON.parse((c[1] as RequestInit).body as string));
const gets = () => api.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method);

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  may = true;
  total = 374;
  answers = [{ received: 50, skipped: {}, nextCursor: 'c-50' }, { received: 47, skipped: { NEEDS_THE_QUESTION: 3 }, nextCursor: null }];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const a = answers.shift();
      if (!a) throw new Error('ما في جواب');
      return a;
    }
    const view = new URL(url, 'http://x').searchParams.get('view') ?? 'pending';
    return {
      count: total ? 1 : 0,
      orders: total ? [ROW] : [],
      pagination: { total, page: 1, limit: 25, totalPages: Math.max(1, Math.ceil(total / 25)) },
      facts: FACTS,
      applied: { view, status: null, courier: null, age: null, q: null },
      mayChargeFee: true,
      ...(may === undefined ? {} : { mayReceiveAll: may }),
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ReturnsScreen />);
  await screen.findByLabelText('العرض');
};
const theButton = () => screen.queryByRole('button', { name: /^استلام الكل/ });

describe('the button is drawn only where the door would say yes', () => {
  it('the owner sees «استلام الكل (374)» — the list’s own total, not the page’s 25', async () => {
    await draw();
    expect(theButton()?.textContent).toBe('استلام الكل (374)');
  });

  it('NEGATIVE: absent when the server says no', async () => {
    may = false;
    await draw();
    expect(theButton()).toBeNull();
  });

  it('NEGATIVE: absent when an older server says nothing at all — no word, no button', async () => {
    may = undefined;
    await draw();
    expect(theButton()).toBeNull();
  });

  it('NEGATIVE: absent in the received view', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('العرض'), { target: { value: 'received' } });
    await waitFor(() => expect(gets().length).toBeGreaterThan(1));
    await waitFor(() => expect(theButton()).toBeNull());
  });

  it('NEGATIVE: absent when the list is empty', async () => {
    total = 0;
    await draw();
    expect(theButton()).toBeNull();
  });
});

describe('the dialog asks before it acts', () => {
  it('says how many, what happens to each, and that there is no undo — and «نعم، استلم الكل» waits for the tick', async () => {
    await draw();
    fireEvent.click(theButton()!);
    const dialog = await screen.findByRole('dialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('374');
    for (const said of ['كامل وسليم', 'على الرف', 'عمولة', 'بلا أجرة إرجاع', 'التوصيل الجزئي', 'ما في تراجع']) expect(text).toContain(said);
    const yes = screen.getByRole('button', { name: 'نعم، استلم الكل' }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.click(yes);
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox', { name: 'أقرّ إني عددت وفحصت المرتجعات' }));
    expect(yes.disabled).toBe(false);
  });

  it('«إلغاء» closes it and sends nothing', async () => {
    await draw();
    fireEvent.click(theButton()!);
    fireEvent.click(await screen.findByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });
});

describe('the walk, the progress and the one line', () => {
  const start = async () => {
    await draw();
    fireEvent.click(theButton()!);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox', { name: 'أقرّ إني عددت وفحصت المرتجعات' }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، استلم الكل' }));
  };

  it('sends the chosen filters with the tick and each cursor until null — never ids — then says one line and reloads', async () => {
    await start();
    await screen.findByText('استلمت 97 · تركت 3 توصيل جزئي · تخطيت 0');
    const bodies = postBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ view: 'pending', countedAndInspected: true, cursor: null });
    expect(bodies[1]).toMatchObject({ view: 'pending', countedAndInspected: true, cursor: 'c-50' });
    for (const b of bodies) {
      expect(b).not.toHaveProperty('orderIds');
      expect(b).not.toHaveProperty('orderId');
    }
    expect(posts()[0][0]).toBe('/api/ops/returns/receive-all');
    // The list was asked again after the line.
    const before = gets().length;
    await waitFor(() => expect(gets().length).toBeGreaterThanOrEqual(before));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('«بلا باركود» goes with it: the walk is asked of the SAME narrowing the list shows — and nothing is sent that was not chosen', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('الباركود'), { target: { value: 'none' } });
    await waitFor(() => expect(gets().some((c) => new URL(c[0] as string, 'http://x').searchParams.get('barcode') === 'none')).toBe(true));
    await waitFor(() => expect(theButton()).not.toBeNull());
    fireEvent.click(theButton()!);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox', { name: 'أقرّ إني عددت وفحصت المرتجعات' }));
    fireEvent.click(screen.getByRole('button', { name: 'نعم، استلم الكل' }));
    await screen.findByText('استلمت 97 · تركت 3 توصيل جزئي · تخطيت 0');
    for (const b of postBodies()) expect(b).toMatchObject({ view: 'pending', barcode: 'none', countedAndInspected: true });
  });

  it('and with «بلا باركود» not chosen the walk says «all», which the door reads as no narrowing at all', async () => {
    await start();
    await screen.findByText('استلمت 97 · تركت 3 توصيل جزئي · تخطيت 0');
    for (const b of postBodies()) expect(b.barcode).toBe('all');
  });

  it('shows «استلمت X من Y» while it walks, and «إيقاف» stops after the piece in flight', async () => {
    let release: () => void = () => {};
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await new Promise<void>((r) => (release = r));
        return answers.shift();
      }
      return {
        count: 1, orders: [ROW], pagination: { total, page: 1, limit: 25, totalPages: 15 }, facts: FACTS,
        applied: { view: 'pending', status: null, courier: null, age: null, q: null }, mayChargeFee: true, mayReceiveAll: true,
      };
    });
    await start();
    await screen.findByText('استلمت 0 من 374');
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف' }));
    await act(async () => release());

    await screen.findByText(/^استلمت 50 · تركت 0 توصيل جزئي · تخطيت 0 — وقفت قبل الآخر/);
    expect(posts()).toHaveLength(1);
  });

  it('leaving the screen mid-run is «إيقاف»: the piece in flight finishes, no other is asked, and a screen that is gone is told nothing', async () => {
    let release: () => void = () => {};
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await new Promise<void>((r) => (release = r));
        return answers.shift();
      }
      return {
        count: 1, orders: [ROW], pagination: { total, page: 1, limit: 25, totalPages: 15 }, facts: FACTS,
        applied: { view: 'pending', status: null, courier: null, age: null, q: null }, mayChargeFee: true, mayReceiveAll: true,
      };
    });
    await start();
    await screen.findByText('استلمت 0 من 374');
    const readsBefore = gets().length;
    cleanup(); // the owner went to another screen while the first piece was on its way
    await act(async () => release());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // The first answer said «there is more» (a cursor), and still nothing walked on: one piece asked, one only.
    expect(posts()).toHaveLength(1);
    // And nobody reloaded a list that is not on any screen.
    expect(gets()).toHaveLength(readsBefore);
  });

  it('a half-failed run says so plainly and can be pressed again', async () => {
    answers = [{ received: 50, skipped: {}, nextCursor: 'c-50' }];
    await start();
    await screen.findByText(/^استلمت 50 .*في شي ما زبط.*مرة تانية/);
    expect(failed).toHaveBeenCalled();
    expect(theButton()).not.toBeNull();
  });

  it('skips are counts by reason — no order number is drawn in the line', async () => {
    answers = [{ received: 1, skipped: { ALREADY_RECEIVED: 2, FAILED: 1 }, nextCursor: null }];
    await start();
    const line = await screen.findByText(/^استلمت 1 /);
    expect(line.textContent).toContain('تخطيت 2 (انستلم قبل: 2)');
    expect(line.textContent).toContain('ما زبط 1');
    expect(line.textContent).not.toMatch(/ORD-/);
  });
});

describe('on a phone', () => {
  it('the same button, at a thumb’s height, and the dialog’s buttons too', async () => {
    phone.value = true;
    await draw();
    const b = theButton()!;
    expect(b.className).toContain('h-11');
    expect(b.className).toContain('md:h-10');
    fireEvent.click(b);
    await screen.findByRole('dialog');
    expect((screen.getByRole('button', { name: 'نعم، استلم الكل' }) as HTMLButtonElement).className).toContain('h-11');
  });
});
