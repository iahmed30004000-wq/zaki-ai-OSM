// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «بدي أثبّت هاد عشان أفهم — زر تثبيت وفلاتر وسيرش بوكس» (the owner, 8/11), on a statement of 116 lines in five queues.
 *
 *   · a box above each queue narrows THAT queue by a barcode, an order number, a phone, a name, a governorate, an address;
 *   · a filter by what the company wrote (the order's own outcome word for the queue of our orders);
 *   · «بلا بتّ فقط» where a queue holds the approval back;
 *   · «ثبّت العناوين»: the headings stay in view while the list scrolls — pinned unless somebody unpins, remembered here;
 *   · a filter is a way of LOOKING: the counter, the gate and every answer still count all the rows, and the search survives
 *     the reload the screen does after every answer.
 *
 * Every name, phone and address below is invented.
 */
const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['settlement.review'] } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';

const delivered = { phrase: 'تم توصيلها', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' };
const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };
const base = {
  matchedBy: null, expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  orderOutcome: null, followUp: null, expectedAmount: null, difference: null, note: null, order: null,
};
const lineOf = (n: number, over: Record<string, unknown> = {}) => ({
  merchantRef: `2000${n}`, barcode: `10000000000${n}`, amount: '12', collected: '15', fee: '3', status: 'تم توصيلها',
  rawRow: `10000000000${n} | 2000${n} | كاش`,
  receiverName: ["سلمى", "ريما", "هدى", "نور", "لانا", "رنا"][n - 1], receiverPhone: `+963 900 000 00${n}`, receiverAddress: `شارع ${n}`, receiverCity: 'حماة', receiverArea: 'حماة',
  ...over,
});
const missing = (n: number, word = delivered, over: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({
  ...base, id: `m${n}`, result: 'MISSING_IN_SYSTEM', statementAmount: '12', courierWord: word, statementLine: lineOf(n, line), ...over,
});
// 1 and 2 delivered (Hama), 3 delivered in Idlib, 4 and 5 returned, 6 returned but parked already.
const rows = [
  missing(1),
  missing(2),
  missing(3, delivered, {}, { receiverCity: 'إدلب', receiverArea: 'إدلب', receiverAddress: 'سلقين - سوق الخضار' }),
  missing(4, returned, {}, { status: 'تم إرجاعها', amount: '0', collected: '0', fee: '0' }),
  missing(5, returned, {}, { status: 'تم إرجاعها', amount: '0', collected: '0', fee: '0' }),
  missing(6, returned, { resolution: 'UNDER_REVIEW', resolutionNote: 'ليس لنا' }, { status: 'تم إرجاعها', amount: '0', collected: '0', fee: '0' }),
  {
    ...base, id: 'u1', result: 'MISSING_IN_STATEMENT', expectedAmount: '20', statementLine: null, courierWord: null,
    orderOutcome: { key: 'DELIVERED_WAITING', label: 'تم التسليم — بانتظار التحصيل' },
    order: { id: 'o8', orderNumber: 'ORD-8', merchantRef: null, shippingStatus: 'DELIVERED' },
  },
];

let store: Record<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') {
      return {
        statements: [{
          id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, currencyCode: 'USD',
          counts: { lines: 6, receipts: 1, matches: rows.length },
        }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: rows } };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const text = (e: Element) => e.textContent ?? '';
/** The card of one queue, found by its title button. */
const queue = (title: string) => screen.getAllByText(title)[0].closest('button')!.parentElement as HTMLElement;
const bodyRows = (title: string) => Array.from(queue(title).querySelectorAll('tbody tr'));
const box = (title: string) => within(queue(title)).getByLabelText('ابحث بهالقسم') as HTMLInputElement;
const MISSING = 'في الكشف وليس عندنا';
const type = (title: string, value: string) => fireEvent.change(box(title), { target: { value } });

describe('the box narrows ONE queue by what a person has in hand', () => {
  it('a phone, typed the way a person writes it, finds the row whose phone the company wrote with a plus and spaces', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    expect(bodyRows(MISSING)).toHaveLength(6);
    type(MISSING, '0900000002');
    expect(bodyRows(MISSING)).toHaveLength(1);
    expect(text(bodyRows(MISSING)[0])).toContain('100000000002');
  });

  it('a barcode, the company’s own order number, a name, an address and a governorate each find their row', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    for (const [q, barcode] of [['100000000003', '100000000003'], ['20003', '100000000003'], ['هدى', '100000000003'], ['سلقين', '100000000003']]) {
      type(MISSING, q);
      expect(bodyRows(MISSING).map((r) => /1000000000\d\d?/.exec(text(r))?.[0]), q).toEqual([barcode]);
    }
    // «ادلب» (without the hamza) finds the Idlib line only: a governorate is looked for as a name.
    type(MISSING, 'ادلب');
    expect(bodyRows(MISSING)).toHaveLength(1);
  });

  it('narrows only the queue it is above — the others keep every row', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    type(MISSING, '0900000001');
    expect(bodyRows(MISSING)).toHaveLength(1);
    // The queue of our own orders still has its one row; the box of that queue is a different box.
    expect(within(queue('طلبات لم يذكرها أي كشف')).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('says how many it shows out of how many, and the counter and the «بلا بتّ» label still count ALL the rows', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    const head = () => text(queue(MISSING).querySelector('button')!);
    expect(head()).toContain('6');
    expect(head()).toContain('5 بلا بتّ'); // the sixth line is parked
    type(MISSING, '0900000002');
    expect(text(queue(MISSING))).toContain('يعرض 1 من 6');
    expect(head()).toContain('6');
    expect(head()).toContain('5 بلا بتّ');
  });

  it('nothing found says so, and one press clears the search and the filter', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    type(MISSING, 'لا يوجد شي بهالاسم');
    expect(text(queue(MISSING))).toContain('ما في سطر بهالبحث أو الفلتر');
    fireEvent.click(within(queue(MISSING)).getByRole('button', { name: 'امسح البحث والفلتر' }));
    expect(bodyRows(MISSING)).toHaveLength(6);
    expect(box(MISSING).value).toBe('');
  });

  it('the search survives the reload the screen does after an answer (run the matching again)', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    type(MISSING, '0900000002');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    });
    await waitFor(() => expect(bodyRows(MISSING)).toHaveLength(1));
    expect(box(MISSING).value).toBe('0900000002');
  });
});

describe('the filter by what the company wrote', () => {
  it('lists the kinds the queue holds with their counts, and narrows by one', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    const select = within(queue(MISSING)).getByLabelText('ما كتبته الشركة') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(['الكل (6)', 'سُلِّمت (3)', 'رجعت (3)']);
    fireEvent.change(select, { target: { value: 'RETURNED' } });
    expect(bodyRows(MISSING)).toHaveLength(3);
    expect(bodyRows(MISSING).every((r) => text(r).includes('تم إرجاعها'))).toBe(true);
  });

  it('works together with the box: both have to hold', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    fireEvent.change(within(queue(MISSING)).getByLabelText('ما كتبته الشركة'), { target: { value: 'RETURNED' } });
    type(MISSING, '0900000004');
    expect(bodyRows(MISSING)).toHaveLength(1);
    type(MISSING, '0900000001'); // a delivered line: not among the returned
    expect(text(queue(MISSING))).toContain('ما في سطر بهالبحث أو الفلتر');
  });

  it('the queue of OUR orders filters by the order’s own outcome word, not the company’s', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('طلبات لم يذكرها أي كشف');
    // One kind only: no filter to draw, and its label is the one for orders.
    expect(within(queue('طلبات لم يذكرها أي كشف')).queryByLabelText('كلمة نتيجته')).toBeNull();
    type('طلبات لم يذكرها أي كشف', 'ORD-8');
    expect(bodyRows('طلبات لم يذكرها أي كشف')).toHaveLength(1);
    type('طلبات لم يذكرها أي كشف', 'بانتظار التحصيل');
    expect(bodyRows('طلبات لم يذكرها أي كشف')).toHaveLength(1);
  });

  it('«بلا بتّ فقط» hides the lines already answered, and is drawn only where something is still a question', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    const toggle = within(queue(MISSING)).getByLabelText(/بلا بتّ فقط \(5\)/) as HTMLInputElement;
    expect(bodyRows(MISSING)).toHaveLength(6);
    fireEvent.click(toggle);
    expect(bodyRows(MISSING)).toHaveLength(5);
    expect(bodyRows(MISSING).some((r) => text(r).includes('100000000006'))).toBe(false);
    // The queue of our own orders has no lines to answer: no toggle there.
    expect(within(queue('طلبات لم يذكرها أي كشف')).queryByLabelText(/بلا بتّ فقط/)).toBeNull();
  });
});

describe('«ثبّت العناوين» — the headings stay in view while the list scrolls', () => {
  const pinned = (title: string) => queue(title).querySelector('[data-pinned]')?.getAttribute('data-pinned');

  it('is pinned from the start — the owner asked for it — and the button says so', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    expect(pinned(MISSING)).toBe('true');
    const pin = within(queue(MISSING)).getByRole('button', { name: 'العناوين مثبّتة' });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
  });

  it('one press unpins every queue, and the choice is remembered in this browser', async () => {
    const first = render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    fireEvent.click(within(queue(MISSING)).getByRole('button', { name: 'العناوين مثبّتة' }));
    expect(pinned(MISSING)).toBeUndefined();
    expect(pinned('فرق في المبلغ')).toBeUndefined();
    expect(within(queue(MISSING)).getByRole('button', { name: 'ثبّت العناوين' }).getAttribute('aria-pressed')).toBe('false');
    expect(store['osm.matching.pinHeader']).toBe('off');
    first.unmount();
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    expect(pinned(MISSING)).toBeUndefined();
  });

  it('a browser that cannot remember (private window) still pins for the visit', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    expect(pinned(MISSING)).toBe('true');
    fireEvent.click(within(queue(MISSING)).getByRole('button', { name: 'العناوين مثبّتة' }));
    expect(pinned(MISSING)).toBeUndefined();
  });

  it('a phone has cards and no headings: no pin to press, and nothing pinned', async () => {
    phone.value = true;
    render(<MatchingScreen />);
    await screen.findAllByText(MISSING);
    expect(within(queue(MISSING)).queryByRole('button', { name: /العناوين مثبّتة|ثبّت العناوين/ })).toBeNull();
    expect(pinned(MISSING)).toBeUndefined();
    // …but the search and the filter are there on a phone too.
    expect(box(MISSING)).toBeTruthy();
  });
});
