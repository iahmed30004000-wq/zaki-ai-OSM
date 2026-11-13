// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE RETURNS DESK WRITES THE BARCODE AND THE PHONE ON THE ROW, EACH WITH ITS SMALL COPY BUTTON — AND FINDS THE PARCELS WITH NO BARCODE.
 *
 *   «اظهار الباركود والرقم وزر النسخ وضيف للفلتر بلا باركود» (the owner, 13/11, over the returns screen)
 *
 * What the screen owes:
 *
 *   • every row, waiting or counted, shows the courier's barcode as text with the small copy button beside it — the button OFF
 *     («ما في باركود للشحنة») when the courier gave none, never a button that changes what it copies;
 *   • the customer's phone is written on the row with its own copy button — but only when the list CARRIED phones: the warehouse
 *     is sent none (it may not read them), and a column of dashes is not a column;
 *   • a copy writes nothing and asks nothing (no request leaves the screen), and a copy the browser refuses is handed to a field
 *     to select by hand;
 *   • «بلا باركود (N)» is a fifth dropdown with the SERVER'S number beside the word, asked as `barcode=none`, carried into both
 *     views, counted by «إعادة تعيين», and a change starts again at page one.
 */

const { api, copy } = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn() }));
const phone = vi.hoisted(() => ({ value: false }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/lib/clipboard', () => ({ copyText: (...a: unknown[]) => copy(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المرتجعات</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => <button type="button">امسح</button> }));

import { ReturnsScreen } from './ReturnsScreen';

const COURIER = '11111111-1111-4111-8111-111111111111';
const BARCODE = '100550615867';
const PHONE = '0791234567';

const completion = {
  halves: [{ key: 'GOODS', label: 'استلام الراجع وعدّه في المستودع', settled: false, units: 3 }],
  settledCount: 0,
  degree: 'NONE',
  complete: false,
  awaiting: ['GOODS'],
  label: 'تمّ 0 من 1',
};

const waiting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: BARCODE,
  shippingStatus: 'RETURNED',
  returnReason: null,
  expectedQty: 3,
  daysWaited: 5,
  customer: { fullName: 'سارة' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: null, expectedBack: 3 }],
  completion,
  action: null,
  ...over,
});

const counted = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: BARCODE,
  shippingStatus: 'RETURNED',
  returnReason: null,
  customer: { fullName: 'منى' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'أمان' },
  receipt: {
    expectedQty: 3, receivedQty: 3, damagedQty: 0, missingQty: 0, courierFeeCharged: false,
    inspectedAt: '2026-10-19T10:00:00.000Z', inspectedBy: 'أمين', note: null,
  },
  ...over,
});

const FACTS = {
  views: { pending: 60, received: 14 },
  statuses: { RETURN_REQUESTED: 5, RETURNED: 40, FAILED_DELIVERY: 10, PARTIALLY_DELIVERED: 5 },
  couriers: [{ id: COURIER, name: 'ناقل', count: 35 }],
  ages: { fresh: 12, few: 18, week: 20, old: 10 },
  noBarcode: 9,
};

let facts: Record<string, unknown>;
let total: number;
let rowsOf: (view: string) => unknown[];

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');
const lastAsked = () => gets().at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  copy.mockResolvedValue(true);
  facts = structuredClone(FACTS);
  total = 60;
  rowsOf = (view) => (view === 'received' ? [counted('R1')] : [waiting('P1')]);
  api.mockImplementation(async (url: string) => {
    const q = new URL(url, 'http://x').searchParams;
    const view = q.get('view') ?? 'pending';
    const totalPages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(Number(q.get('page')), totalPages);
    return {
      count: total === 0 ? 0 : 1,
      orders: total === 0 ? [] : rowsOf(view),
      pagination: { total, page, limit: 25, totalPages },
      facts,
      applied: { view, status: null, courier: null, age: null, q: null },
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ReturnsScreen />);
  await screen.findByLabelText('العرض');
};
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);
const headings = () => [...document.querySelectorAll('th')].map((th) => th.textContent?.trim());
/** The desk's row for an order — the table's, not the card the same data is also drawn as. */
const deskRow = (orderNumber: string) => screen.getAllByText(orderNumber).map((el) => el.closest('tr')).find((tr): tr is HTMLTableRowElement => !!tr)!;
const cellOf = (tr: HTMLElement, heading: string) => [...tr.querySelectorAll('td')][headings().indexOf(heading)] as HTMLElement;

describe('the barcode, written on the row', () => {
  it('— every waiting parcel shows the courier’s barcode as text, with a button that copies exactly it', async () => {
    await draw();
    const cell = cellOf(deskRow('ORD-P1'), 'الباركود');
    expect(cell.textContent).toContain(BARCODE);
    const button = within(cell).getByRole('button', { name: `نسخ باركود الشحنة ${BARCODE}` }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenCalledWith(BARCODE);
  });

  it('and it is written left-to-right, whatever the page’s direction — a number is read the way it is dialled', async () => {
    await draw();
    const written = within(cellOf(deskRow('ORD-P1'), 'الباركود')).getByText(BARCODE);
    expect(written.getAttribute('dir')).toBe('ltr');
  });

  it('and a parcel with NO barcode — none written, or a blank one — shows a dash and a button that is OFF, in its place', async () => {
    rowsOf = () => [waiting('N1', { trackingNumber: null }), waiting('B1', { trackingNumber: '' }), waiting('S1', { trackingNumber: '   ' })];
    await draw();
    for (const id of ['N1', 'B1', 'S1']) {
      const cell = cellOf(deskRow(`ORD-${id}`), 'الباركود');
      expect(cell.textContent, id).toContain('—');
      const off = within(cell).getByRole('button', { name: 'نسخ باركود الشحنة — ما في باركود للشحنة' }) as HTMLButtonElement;
      expect(off.disabled, id).toBe(true);
      expect(off.getAttribute('title'), id).toBe('ما في باركود للشحنة');
      fireEvent.click(off);
    }
    expect(copy).not.toHaveBeenCalled();
  });

  it('and the button never changes what it copies from row to row — the barcode, never the order number', async () => {
    rowsOf = () => [waiting('A', { trackingNumber: 'T-AAA' }), waiting('B', { trackingNumber: 'T-BBB' })];
    await draw();
    fireEvent.click(within(cellOf(deskRow('ORD-B'), 'الباركود')).getByRole('button'));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenLastCalledWith('T-BBB');
    fireEvent.click(within(cellOf(deskRow('ORD-A'), 'الباركود')).getByRole('button'));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
    expect(copy).toHaveBeenLastCalledWith('T-AAA');
  });

  it('and a copy WRITES NOTHING and asks nothing — no request leaves the screen but the list’s own reads', async () => {
    await draw();
    const before = api.mock.calls.length;
    fireEvent.click(within(cellOf(deskRow('ORD-P1'), 'الباركود')).getByRole('button', { name: `نسخ باركود الشحنة ${BARCODE}` }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(api.mock.calls).toHaveLength(before);
    expect(posts()).toHaveLength(0);
  });

  it('and a copy the browser REFUSES is handed to a field to select by hand — with the barcode in it', async () => {
    copy.mockResolvedValue(false);
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
    await draw();
    fireEvent.click(within(cellOf(deskRow('ORD-P1'), 'الباركود')).getByRole('button', { name: `نسخ باركود الشحنة ${BARCODE}` }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith('تعذّر النسخ — انسخه يدوياً', BARCODE);
    prompt.mockRestore();
  });

  it('and the record of what was counted in carries the same column, in the same place, with the same button', async () => {
    await draw();
    choose('العرض', 'received');
    await waitFor(() => expect(headings()).toContain('عُدَّ في'));
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الباركود', 'الاستلام', 'عُدَّ في']);
    const cell = cellOf(deskRow('ORD-R1'), 'الباركود');
    expect(cell.textContent).toContain(BARCODE);
    fireEvent.click(within(cell).getByRole('button', { name: `نسخ باركود الشحنة ${BARCODE}` }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(BARCODE));
  });

  it('and on a phone it is a line of the card, labelled — the small button a 44px target', async () => {
    phone.value = true;
    await draw();
    expect(screen.getAllByText('الباركود').length).toBeGreaterThan(0);
    const button = screen.getAllByRole('button', { name: `نسخ باركود الشحنة ${BARCODE}` })[0];
    expect(button.className).toContain('h-11');
    fireEvent.click(button);
    await waitFor(() => expect(copy).toHaveBeenCalledWith(BARCODE));
  });
});

describe('the phone, written on the row — for whoever was sent phones', () => {
  it('— the warehouse is sent none: no «الهاتف» column at all, and no number anywhere on the page', async () => {
    await draw();
    expect(headings()).not.toContain('الهاتف');
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الباركود', 'السبب', 'المدّة', 'المتوقَّع رجوعه', '']);
    expect(document.body.textContent).not.toContain(PHONE);
    expect(screen.queryByRole('button', { name: /رقم هاتف الزبون/ })).toBeNull();
  });

  it('and whoever may read phones has the column, between the company and the barcode, with the number written left-to-right', async () => {
    rowsOf = () => [waiting('P1', { customer: { fullName: 'سارة', phone: PHONE } })];
    await draw();
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الهاتف', 'الباركود', 'السبب', 'المدّة', 'المتوقَّع رجوعه', '']);
    const cell = cellOf(deskRow('ORD-P1'), 'الهاتف');
    expect(within(cell).getByText(PHONE).getAttribute('dir')).toBe('ltr');
  });

  it('and its button copies the number as a dialler is given it — and writes nothing, so a copy is never a call', async () => {
    rowsOf = () => [waiting('P1', { customer: { fullName: 'سارة', phone: '٠٧٩١٢٣٤٥٦٧' } })];
    await draw();
    const before = api.mock.calls.length;
    fireEvent.click(within(cellOf(deskRow('ORD-P1'), 'الهاتف')).getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    // Arabic-Indic digits are handed over as Latin ones: that is what a dialler reads.
    expect(copy).toHaveBeenCalledWith(PHONE);
    expect(api.mock.calls).toHaveLength(before);
    expect(posts()).toHaveLength(0);
  });

  it('and a row with no phone on it — beside one that has — shows a dash and NO button, not a button that copies nothing', async () => {
    rowsOf = () => [waiting('P1', { customer: { fullName: 'سارة', phone: PHONE } }), waiting('P2', { customer: { fullName: 'ليلى', phone: null } })];
    await draw();
    const empty = cellOf(deskRow('ORD-P2'), 'الهاتف');
    expect(empty.textContent?.trim()).toBe('—');
    expect(within(empty).queryByRole('button')).toBeNull();
    expect(within(cellOf(deskRow('ORD-P1'), 'الهاتف')).getByRole('button', { name: 'نسخ رقم هاتف الزبون' })).toBeTruthy();
  });

  it('and a copy the browser refuses is handed to a field to select by hand — with the NUMBER in it', async () => {
    copy.mockResolvedValue(false);
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
    rowsOf = () => [waiting('P1', { customer: { fullName: 'سارة', phone: PHONE } })];
    await draw();
    fireEvent.click(within(cellOf(deskRow('ORD-P1'), 'الهاتف')).getByRole('button', { name: 'نسخ رقم هاتف الزبون' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith('تعذّر النسخ — انسخه يدوياً', PHONE);
    prompt.mockRestore();
  });

  it('and the record carries the phone column too, when the list brought phones', async () => {
    rowsOf = (view) => (view === 'received' ? [counted('R1', { customer: { fullName: 'منى', phone: PHONE } })] : [waiting('P1', { customer: { fullName: 'سارة', phone: PHONE } })]);
    await draw();
    choose('العرض', 'received');
    await waitFor(() => expect(headings()).toContain('عُدَّ في'));
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الهاتف', 'الباركود', 'الاستلام', 'عُدَّ في']);
    expect(cellOf(deskRow('ORD-R1'), 'الهاتف').textContent).toContain(PHONE);
  });
});

describe('«بلا باركود», in the toolbar', () => {
  it('— a fifth dropdown, «الباركود», with the server’s number beside the words', async () => {
    await draw();
    expect(options('الباركود')).toEqual(['كل الطرود', 'بلا باركود (9)']);
    expect((screen.getByLabelText('الباركود') as HTMLSelectElement).value).toBe('all');
  });

  it('and nothing is asked about it until it is chosen — the first question is still the work and nothing else', async () => {
    await draw();
    expect(gets()[0].toString()).toBe('view=pending&page=1&limit=25');
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });

  it('and choosing it asks for `barcode=none`, from page one — and the word is the only thing that changed', async () => {
    await draw();
    choose('الباركود', 'none');
    await waitFor(() => expect(lastAsked().get('barcode')).toBe('none'));
    expect(lastAsked().toString()).toBe('barcode=none&view=pending&page=1&limit=25');
  });

  it('and it is one question with the others — the company and the barcode together, none that was not chosen', async () => {
    await draw();
    choose('شركة الشحن', COURIER);
    choose('الباركود', 'none');
    await waitFor(() => expect(lastAsked().get('barcode')).toBe('none'));
    expect(lastAsked().toString()).toBe(`barcode=none&courier=${COURIER}&view=pending&page=1&limit=25`);
  });

  it('and a change starts again at page one, from wherever the reader was', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    choose('الباركود', 'none');
    await waitFor(() => expect(lastAsked().get('barcode')).toBe('none'));
    expect(lastAsked().get('page')).toBe('1');
  });

  it('and choosing «كل الطرود» again drops the word — never `barcode=all` on the wire', async () => {
    await draw();
    choose('الباركود', 'none');
    await waitFor(() => expect(lastAsked().get('barcode')).toBe('none'));
    choose('الباركود', 'all');
    await waitFor(() => expect(lastAsked().has('barcode')).toBe(false));
    expect(lastAsked().toString()).toBe('view=pending&page=1&limit=25');
  });

  it('and «إعادة تعيين» counts it, and puts it back', async () => {
    await draw();
    choose('الباركود', 'none');
    const reset = await screen.findByRole('button', { name: 'إعادة تعيين (1)' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastAsked().has('barcode')).toBe(false));
    expect((screen.getByLabelText('الباركود') as HTMLSelectElement).value).toBe('all');
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });

  it('and it applies to BOTH views: it is carried into the record, and still drawn there', async () => {
    await draw();
    choose('الباركود', 'none');
    await waitFor(() => expect(lastAsked().get('barcode')).toBe('none'));
    choose('العرض', 'received');
    await waitFor(() => expect(lastAsked().get('view')).toBe('received'));
    expect(lastAsked().get('barcode')).toBe('none');
    expect(screen.getByLabelText('الباركود')).toBeTruthy();
    expect((screen.getByLabelText('الباركود') as HTMLSelectElement).value).toBe('none');
  });

  it('and an older server that sends no number is a zero, not a crash and not «undefined»', async () => {
    delete facts.noBarcode;
    await draw();
    expect(options('الباركود')).toEqual(['كل الطرود', 'بلا باركود (0)']);
  });

  it('and an empty list BECAUSE of it says that, and offers the way out — not «the task is done»', async () => {
    await draw();
    total = 0;
    choose('الباركود', 'none');
    expect(await screen.findByText('لا مرتجعات بهذه الشروط')).toBeTruthy();
    expect(screen.queryByText('تمّت المهمة!')).toBeNull();
    total = 60;
    fireEvent.click(screen.getByRole('button', { name: 'امسح الفلاتر' }));
    await waitFor(() => expect(lastAsked().toString()).toBe('view=pending&page=1&limit=25'));
  });
});
