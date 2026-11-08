// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «اربطه بطلب» — THE PHONE OF THE LINE, ONE PRESS, AND A STALE PAGE THAT SAYS SO.
 *
 * · the dialog opens on «بهاتف السطر»: it asks the server (`?by=phone`) by itself, shows the phone the server read
 *   off the row and the orders still on the road; a row with no phone says to search by hand, and the free search
 *   is still there;
 * · a link is one press: a second click while the first is on its way sends nothing;
 * · a refusal that means the page is older than the line offers «حدّث الصفحة», which reloads the list behind;
 *   a refusal about the ORDER (settled, held elsewhere) does not — there is nothing stale to refresh.
 * · «سبب الشركة» says four things — status, phone, governorate, address — with the whole row one press away.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { LinkLineDialog, STALE_CODES } from './LinkLineDialog';
import { CourierReason } from './MatchingScreen';

const BASE = '/api/finance/statements/st1/matches/m1/link';

const candidate = (id: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
  id, orderNumber, merchantRef: null, customer: { id: 'cu', fullName: 'رنا', phone: '933620102' },
  shippingStatus: 'SHIPPED', settlementStatus: 'PENDING', closed: false, expected: 20, distance: 0,
  otherCourier: false, blockedBy: [], ...over,
});

const byPhone = {
  header: 'لهذا الرقم 2 طلبات قيد الشحن',
  counts: { total: 2, closed: 0, open: 2 },
  hint: null,
  otherCourierWarning: 'w',
  phone: { shown: '0933620102', country: 'SY' },
  candidates: [candidate('a', 'ORD-A'), candidate('b', 'ORD-B', { expected: 25, distance: 5 })],
};
const noPhone = {
  header: 'لا طلبات قيد الشحن لهذا الرقم', counts: { total: 0, closed: 0, open: 0 }, candidates: [],
  hint: 'ما في رقم هاتف بسطر الشركة — اكتب الهاتف أو رقم الطلب بالبحث تحت', otherCourierWarning: 'w', phone: null,
};
const byText = {
  header: 'لهذا الرقم طلب واحد: مفتوح', counts: { total: 1, closed: 0, open: 1 }, hint: null, otherCourierWarning: 'w',
  candidates: [candidate('t', 'ORD-T')],
};

const refusal = (status: number, code: string, error: string) => Object.assign(new Error(error), { status, data: { error, code } });

let onLinked: ReturnType<typeof vi.fn<() => void>>;
const mount = () =>
  render(<LinkLineDialog statementId="st1" matchId="m1" reference="BC-1" amount={20} currency="SYP" onLinked={onLinked} />);
const openDialog = async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /اربطه بطلب/ }));
  return screen.findByRole('dialog');
};
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  onLinked = vi.fn<() => void>();
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { message: 'رُبط', linked: { result: 'MATCHED' } };
    if (url === `${BASE}?by=phone`) return byPhone;
    if (url.startsWith(`${BASE}?q=`)) return byText;
    return {};
  });
});
afterEach(cleanup);

describe('«بهاتف السطر» runs by itself', () => {
  it('opening the dialog asks the server for the line’s phone — no phone is sent from the screen', async () => {
    await openDialog();
    await screen.findByText(byPhone.header);
    expect(api).toHaveBeenCalledWith(`${BASE}?by=phone`);
    expect(api.mock.calls.every((c) => !String(c[0]).includes('0933620102'))).toBe(true);
  });

  it('shows the phone it read, the header, and the orders on the road to pick from', async () => {
    const dialog = await openDialog();
    await screen.findByText(byPhone.header);
    expect(within(dialog).getByText('0933620102')).toBeTruthy();
    expect(within(dialog).getByText('ORD-A')).toBeTruthy();
    expect(within(dialog).getByText('ORD-B')).toBeTruthy();
  });

  it('a row with no phone says to search by hand, and the free search is right there', async () => {
    api.mockImplementation(async (url: string) => (url === `${BASE}?by=phone` ? noPhone : byText));
    await openDialog();
    expect(await screen.findByText(noPhone.hint)).toBeTruthy();
    const box = screen.getByLabelText('البحث') as HTMLInputElement;
    expect(box.tagName).toBe('INPUT');
    fireEvent.change(box, { target: { value: 'ORD-T' } });
    fireEvent.click(screen.getByRole('button', { name: 'ابحث' }));
    await screen.findByText(byText.header);
    expect(api).toHaveBeenCalledWith(`${BASE}?q=ORD-T`);
  });

  it('the phone button runs the phone search again after a free search', async () => {
    await openDialog();
    await screen.findByText(byPhone.header);
    fireEvent.change(screen.getByLabelText('البحث'), { target: { value: 'ORD-T' } });
    fireEvent.click(screen.getByRole('button', { name: 'ابحث' }));
    await screen.findByText(byText.header);
    fireEvent.click(screen.getByRole('button', { name: /بهاتف السطر/ }));
    await screen.findByText(byPhone.header);
    expect(api.mock.calls.filter((c) => c[0] === `${BASE}?by=phone`)).toHaveLength(2);
  });

  it('a pick from the phone list links with no acknowledgement and no typed query, then reloads the list', async () => {
    await openDialog();
    await screen.findByText(byPhone.header);
    fireEvent.click(screen.getByText('ORD-A'));
    fireEvent.click(screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(BASE);
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toEqual({ orderId: 'a', acceptOtherCourier: false, query: '' });
  });
});

describe('one press is one link', () => {
  it('a double click while the first is on its way sends ONE request', async () => {
    let release: (v: unknown) => void = () => {};
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise((r) => { release = r; });
      return url === `${BASE}?by=phone` ? byPhone : byText;
    });
    await openDialog();
    await screen.findByText(byPhone.header);
    fireEvent.click(screen.getByText('ORD-A'));
    const go = screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' });
    fireEvent.click(go);
    fireEvent.click(go);
    fireEvent.click(go);
    expect(posts()).toHaveLength(1);
    await act(async () => release({ message: 'رُبط', linked: { result: 'MATCHED' } }));
    expect(posts()).toHaveLength(1);
  });

  it('two clicks inside the same moment — before the button has re-drawn as disabled — still send ONE request', async () => {
    let release: (v: unknown) => void = () => {};
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise((r) => { release = r; });
      return url === `${BASE}?by=phone` ? byPhone : byText;
    });
    await openDialog();
    await screen.findByText(byPhone.header);
    fireEvent.click(screen.getByText('ORD-A'));
    const go = screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' });
    // One act: React has not committed `linking` between the two, so the button is still enabled for the second.
    act(() => {
      go.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      go.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(posts()).toHaveLength(1);
    await act(async () => release({ message: 'رُبط', linked: { result: 'MATCHED' } }));
    expect(posts()).toHaveLength(1);
  });
});

describe('a page older than the line', () => {
  const pressAndRefuse = async (err: Error) => {
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw err;
      return url === `${BASE}?by=phone` ? byPhone : byText;
    });
    await openDialog();
    await screen.findByText(byPhone.header);
    fireEvent.click(screen.getByText('ORD-A'));
    fireEvent.click(screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' }));
    return screen.findByRole('alert');
  };

  it('a line somebody already tied: the sentence, and «حدّث الصفحة» that reloads the list behind', async () => {
    const alert = await pressAndRefuse(refusal(409, 'NOT_LINKABLE', 'هذا السطر مربوط بالطلب ORD-9 من قبل — ما انربط مرة ثانية. حدّث الصفحة لترى مكانه الآن'));
    expect(within(alert).getByText(/مربوط بالطلب ORD-9/)).toBeTruthy();
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'حدّث الصفحة' }));
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an approved statement and a row that is gone are stale too', async () => {
    expect(STALE_CODES).toEqual(expect.arrayContaining(['NOT_LINKABLE', 'NOT_FOUND', 'ALREADY_APPROVED']));
    const alert = await pressAndRefuse(refusal(409, 'ALREADY_APPROVED', 'الكشف مغلق نهائياً — التصحيح بكشف تسوية'));
    expect(within(alert).getByRole('button', { name: 'حدّث الصفحة' })).toBeTruthy();
  });

  it('a refusal about the ORDER is said, with no refresh offered: pick another order', async () => {
    const alert = await pressAndRefuse(refusal(409, 'ORDER_NOT_LINKABLE', 'لا يُربط هذا الطلب: الطلب مذكور بسطر آخر من هذا الكشف'));
    expect(within(alert).getByText(/مذكور بسطر آخر/)).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'حدّث الصفحة' })).toBeNull();
    // The dialog stays open so another order can be picked, and the button works again.
    expect((screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a stale search (the line was tied while the dialog opened) offers the refresh too', async () => {
    api.mockImplementation(async () => {
      throw refusal(409, 'NOT_LINKABLE', 'هذا السطر ليس من «في الكشف وليس عندنا»، أو رُبط بطلب من قبل');
    });
    await openDialog();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'حدّث الصفحة' })).toBeTruthy();
  });
});

describe('«سبب الشركة» says four things', () => {
  const line = {
    merchantRef: 'ORD-2026-1711', barcode: 'BSH-55012', amount: '23000', collected: '25000', fee: '2000', status: 'مؤجل',
    rawRow: 'BSH-55012 | ORD-2026-1711 | 25000 | 2000 | 23000 | مؤجل | العميل طلب التأجيل | 0900000001',
  };
  const headed = {
    ...line,
    receiverName: 'سلمى الاختبار', receiverPhone: '+353 87 123 4567', receiverAddress: 'حماة - حي الوسط - بجانب الفرن',
    receiverCity: 'حماة', receiverArea: 'حماة',
  };
  const word = { phrase: 'مؤجل', outcome: 'POSTPONED', known: true, label: 'تأجيل' };
  // What a person SEES: the text outside the folded «النص الأصلي», which is the whole row and says everything.
  const seen = (c: HTMLElement) => {
    const clone = c.cloneNode(true) as HTMLElement;
    clone.querySelector('details')?.remove();
    return clone.textContent ?? '';
  };

  it('«هاي كلها لغي»: the status word, the phone, the governorate and the address — and none of the rest of the row', () => {
    const { container } = render(<CourierReason m={{ courierWord: word, statementLine: headed }} />);
    const text = seen(container);
    expect(text).toContain('«مؤجل»');
    expect(text).toContain('الهاتف: +353871234567');
    expect(text).toContain('المحافظة: حماة');
    expect(text).toContain('العنوان: حماة - حي الوسط - بجانب الفرن');
    // The figures are the columns beside it, the order number is under the barcode, the notes are in the raw row.
    for (const gone of ['رقم الطلب', 'المبلغ', 'المحصَّل', 'الأجرة', 'ملاحظة الشركة', 'العميل طلب التأجيل', 'سلمى الاختبار']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it('the area is read with the governorate only when it says something more', () => {
    const { container } = render(
      <CourierReason m={{ courierWord: word, statementLine: { ...headed, receiverCity: 'ريف دمشق', receiverArea: 'ضواحي دمشق' } }} />
    );
    expect(seen(container)).toContain('المحافظة: ريف دمشق — ضواحي دمشق');
  });

  it('a line imported before the headings were kept: its status and the phone read from its row — the rest is behind «النص الأصلي»', () => {
    const { container } = render(<CourierReason m={{ courierWord: word, statementLine: line }} />);
    const text = seen(container);
    expect(text).toContain('«مؤجل»');
    expect(text).toContain('الهاتف: 0900000001');
    expect(text).not.toContain('المحافظة');
    expect(text).not.toContain('العنوان');
    expect(container.querySelector('details')!.textContent).toContain('العميل طلب التأجيل');
  });

  it('the whole row as written is kept, behind «النص الأصلي»', () => {
    const { container } = render(<CourierReason m={{ courierWord: word, statementLine: headed }} />);
    const details = container.querySelector('details')!;
    expect(details).toBeTruthy();
    expect(details.querySelector('summary')!.textContent).toBe('النص الأصلي');
    expect(details.textContent).toContain(line.rawRow);
  });

  it('a line with no word, no facts and no row shows a dash, not empty labels', () => {
    const { container } = render(
      <CourierReason m={{ courierWord: null, statementLine: { merchantRef: 'R', barcode: 'B', amount: '0', status: null, rawRow: null } }} />
    );
    expect(container.textContent).toBe('—');
  });

  it('a status the phrase table does not hold is still shown, under its name', () => {
    const { container } = render(
      <CourierReason m={{ courierWord: null, statementLine: { ...line, status: 'حالة جديدة', rawRow: 'X | حالة جديدة' } }} />
    );
    expect(seen(container)).toContain('الحالة: حالة جديدة');
  });

  it('a phone the company wrote in another country’s form is shown as written, not hidden for being foreign', () => {
    const { container } = render(
      <CourierReason m={{ courierWord: word, statementLine: { ...headed, receiverPhone: '00966 50 123 4567' } }} />
    );
    expect(seen(container)).toContain('الهاتف: +966501234567');
  });
});
