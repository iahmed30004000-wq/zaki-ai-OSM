// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «قم بتحسين واجهة طلبات تلجرام لانها معجوقة» then «أريده يسحب الطلبات بهذه الصيغة» — THE SCREEN, RENDERED FOR REAL.
 *
 * What it owes beyond drawing: the columns of his labels, in his order; tabs whose counts are the server's and whose
 * active count is the list's own total; the reason in Arabic, naming the field; the message that is not in the format
 * under «متجاهلة»; «إعادة المعالجة» only where it can change the answer, and the list read again after it; «تجاهل» that
 * asks first; the message folded until asked for; a card per message on a phone; and the bot's status read when the
 * screen opens and on «تحديث», never on a tab.
 */

const { api, toast, confirm, user } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  confirm: vi.fn(),
  user: { current: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] } as Record<string, unknown> },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm }));

import { TelegramOrdersScreen } from './TelegramOrdersScreen';

const READING = {
  claimed: true,
  orderedAt: '2026-10-28 17:45:32',
  customer: 'محمد عيد أطليبي',
  phone: '0933620102',
  address: 'دمشق سوريا',
  product: 'ماء الكمأ الأصلي',
  offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
  price: '25',
  quantity: '1',
};
const TEXT = [
  ['رقم الطلب', '26842'],
  ['تاريخ الطلب', READING.orderedAt],
  ['إسم العميل', READING.customer],
  ['رقم الهاتف', READING.phone],
  ['عنوان العميل', READING.address],
  ['إسم المنتج', READING.product],
  ['إسم العرض', READING.offer],
  ['السعر', READING.price],
  ['الكمية', READING.quantity],
]
  .map(([label, value]) => `${label}: ${value}`)
  .join('\n');

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  chatId: '-1001',
  threadId: null,
  threadName: null,
  senderName: 'أبو أحمد',
  text: TEXT,
  processingStatus: 'NEEDS_REVIEW',
  reviewReason: 'PRODUCT_NOT_FOUND',
  pageName: null,
  createdAt: '2026-10-28T14:45:40.000Z',
  source: { chatTitle: 'طلبات الصفحة', topicName: null },
  order: null,
  reading: READING,
  twin: null,
  ...over,
});

let rows: ReturnType<typeof message>[];
let facts: { review: number; orders: number; ignored: number; all: number };
let retryAnswer: Record<string, unknown>;
let holdList: Promise<void> | null;

const gets = () =>
  api.mock.calls
    .filter((c) => !(c[1] && (c[1] as RequestInit).method) && String(c[0]).startsWith('/api/telegram/messages'))
    .map((c) => new URL(String(c[0]), 'http://x').searchParams);
const statusReads = () => api.mock.calls.filter((c) => String(c[0]) === '/api/telegram/status').length;
const posts = (door: string) => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST' && String(c[0]).endsWith(door));

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] };
  rows = [message('m1')];
  facts = { review: 6, orders: 7, ignored: 4, all: 17 };
  retryAnswer = { success: false, status: 'NEEDS_REVIEW', reason: 'PRODUCT_NOT_FOUND' };
  holdList = null;
  confirm.mockResolvedValue(true);
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
    if (init?.method === 'POST' && url.endsWith('/retry')) return retryAnswer;
    if (init?.method === 'POST' && url.endsWith('/ignore')) return { success: true, status: 'IGNORED' };
    if (holdList) await holdList;
    const q = new URL(url, 'http://x').searchParams;
    const tab = (q.get('tab') ?? 'all') as keyof typeof facts;
    const total = facts[tab];
    return { messages: rows, pagination: { total, page: Number(q.get('page')), limit: 25, totalPages: Math.max(1, Math.ceil(total / 25)) }, facts };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TelegramOrdersScreen />);
  await screen.findAllByText(READING.customer);
};
const desk = () => screen.getByRole('table');
const cards = () => within(document.querySelector('ul')!).getAllByRole('listitem');

describe('opening it', () => {
  it('— asks for «للمراجعة», page one, 25 to a page; the bot once', async () => {
    await draw();
    expect(gets()[0].toString()).toBe('tab=review&page=1&limit=25');
    expect(screen.getByRole('tab', { name: /للمراجعة/ }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText('البوت متصل')).toBeTruthy());
    expect(statusReads()).toBe(1);
  });

  it('— and shows the shape of the list until the first page arrives', async () => {
    let release!: () => void;
    holdList = new Promise((r) => {
      release = r;
    });
    render(<TelegramOrdersScreen />);
    expect(screen.getByRole('status', { name: 'جارٍ التحميل' })).toBeTruthy();
    release();
    await screen.findAllByText(READING.customer);
    expect(screen.queryByRole('status', { name: 'جارٍ التحميل' })).toBeNull();
  });

  it('— prints the rule, one line: the nine labels, with the order number marked as ignored', async () => {
    await draw();
    expect(
      screen.getByText(
        /^الرسالة لازم تكون بهالعناوين، سطر لكل معلومة: رقم الطلب \(يُتجاهل\) · تاريخ الطلب · إسم العميل · رقم الهاتف · عنوان العميل · إسم المنتج · إسم العرض · السعر · الكمية\. غير هيك ما بتصير طلب\./
      )
    ).toBeTruthy();
  });

  it('— and to somebody who may not read the messages, says so and asks nothing', () => {
    user.current = { id: 'u2', role: 'CUSTOM', permissions: [] };
    render(<TelegramOrdersScreen />);
    expect(screen.getByText('ما عندك صلاحية تشوف طلبات تلجرام')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });
});

describe('his columns, in his order', () => {
  it('— the headings are what his labels say, price and quantity together, then the state; no order-number column', async () => {
    await draw();
    const heads = within(desk()).getAllByRole('columnheader').map((th) => th.textContent);
    expect(heads).toEqual(['تاريخ الطلب', 'العميل', 'الهاتف', 'العنوان', 'المنتج', 'العرض', 'السعر × الكمية', 'الحالة', '']);
    expect(heads.join(' ')).not.toMatch(/رقم الطلب|مرجع/);
  });

  it('— and the row is his message, label by label', async () => {
    await draw();
    const cells = within(within(desk()).getAllByRole('row')[1]).getAllByRole('cell').map((td) => td.textContent);
    expect(cells.slice(0, 7)).toEqual([READING.orderedAt, READING.customer, READING.phone, READING.address, READING.product, READING.offer, '25 × 1']);
  });

  it('— the order number is nowhere on the row (it is only inside the folded message text)', async () => {
    await draw();
    const row = within(desk()).getAllByRole('row')[1];
    const shown = [...row.querySelectorAll('td')]
      .filter((td) => !td.querySelector('details'))
      .map((td) => td.textContent)
      .join(' ');
    expect(shown).not.toContain('26842');
  });

  it('— a message that is not in the format says when it arrived, shows dashes, and names why', async () => {
    rows = [message('m1', { processingStatus: 'IGNORED', reviewReason: 'NOT_IN_FORMAT', reading: { claimed: false }, text: 'سلام' })];
    render(<TelegramOrdersScreen />);
    await screen.findAllByText('الرسالة مش بصيغة الطلب');
    expect(within(desk()).getAllByText(/^وصلت /).length).toBeGreaterThan(0);
    expect(within(desk()).getAllByText('—').length).toBeGreaterThanOrEqual(6);
  });

  it('— a message a person ignored by hand keeps no stale reason on the row', async () => {
    rows = [message('m1', { processingStatus: 'IGNORED', reviewReason: 'INVALID_PHONE' })];
    await draw();
    expect(screen.queryByText('رقم الهاتف مش صالح')).toBeNull();
  });
});

describe('the tabs', () => {
  it('— carry the server’s counts, and the one that is open is the list’s own total', async () => {
    await draw();
    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) }).textContent;
    expect(tab('للمراجعة')).toBe('للمراجعة6');
    expect(tab('صارت طلبات')).toBe('صارت طلبات7');
    expect(tab('متجاهلة')).toBe('متجاهلة4');
    expect(tab('الكل')).toBe('الكل17');
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'عرض 1 من 6 رسالة')).toBeTruthy();
  });

  it('— a tab asks the list again from page one, and never the bot', async () => {
    await draw();
    fireEvent.click(screen.getByRole('tab', { name: /صارت طلبات/ }));
    await waitFor(() => expect(gets().at(-1)!.toString()).toBe('tab=orders&page=1&limit=25'));
    fireEvent.click(screen.getByRole('tab', { name: /الكل/ }));
    await waitFor(() => expect(gets().at(-1)!.toString()).toBe('page=1&limit=25'));
    expect(statusReads()).toBe(1);
  });

  it('— the «متجاهلة» tab holds the messages that are not in the format, and its count is the list’s total', async () => {
    rows = [message('m1', { processingStatus: 'IGNORED', reviewReason: 'NOT_IN_FORMAT', reading: { claimed: false }, text: 'سلام' })];
    render(<TelegramOrdersScreen />);
    await screen.findAllByText('الرسالة مش بصيغة الطلب');
    fireEvent.click(screen.getByRole('tab', { name: /متجاهلة/ }));
    await waitFor(() => expect(gets().at(-1)!.toString()).toBe('tab=ignored&page=1&limit=25'));
    await screen.findAllByText('الرسالة مش بصيغة الطلب');
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'عرض 1 من 4 رسالة')).toBeTruthy();
  });

  it('— «تحديث» reads the bot and the page again', async () => {
    await draw();
    const before = gets().length;
    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
    await waitFor(() => expect(statusReads()).toBe(2));
    await waitFor(() => expect(gets().length).toBe(before + 1));
  });
});

describe('why a message waits — in Arabic, naming the field', () => {
  it('— the reason names the field, and the cell of that field is the one marked', async () => {
    rows = [message('m1', { reviewReason: 'INVALID_PHONE' }), message('m2', { reviewReason: 'PRODUCT_NOT_FOUND' })];
    await draw();
    expect(screen.getAllByText('رقم الهاتف مش صالح').length).toBeGreaterThan(0);
    expect(screen.getAllByText('المنتج مش موجود').length).toBeGreaterThan(0);
    // The same column in two rows: marked where its field failed, plain where it did not — and the same mark both times.
    const [phoneRow, productRow] = within(desk()).getAllByRole('row').slice(1);
    const phoneFailed = within(phoneRow).getByText(READING.phone);
    const phoneFine = within(productRow).getByText(READING.phone);
    const productFailed = within(productRow).getByText(READING.product);
    expect(phoneFailed.className).not.toBe(phoneFine.className);
    expect(phoneFailed.className).toBe(productFailed.className);
  });

  it('— a number that is no number says which one, as the seller wrote it, and the phone cell is the one marked', async () => {
    rows = [
      message('m1', { reviewReason: 'INVALID_PHONE:12', reading: { ...READING, phone: '12' } }),
      message('m2', { reviewReason: 'PRODUCT_NOT_FOUND' }),
    ];
    await draw();
    expect(screen.getAllByText('رقم الهاتف مش صالح: 12').length).toBeGreaterThan(0);
    const [phoneRow, productRow] = within(desk()).getAllByRole('row').slice(1);
    expect(within(phoneRow).getByText('12').className).not.toBe(within(productRow).getByText(READING.phone).className);
  });

  it('— the offer’s reasons name the offer cell and the price: the sentence the owner asked for, with the price the offer costs', async () => {
    rows = [
      message('m1', { reviewReason: 'OFFER_NOT_FOUND' }),
      message('m2', { reviewReason: 'OFFER_AMBIGUOUS' }),
      message('m3', { reviewReason: 'PRICE_MISMATCH:25.00' }),
      message('m4', { reviewReason: 'QUANTITY_NOT_OFFER' }),
    ];
    await draw();
    for (const sentence of [
      'ما لقيت عرض بهالاسم عند المنتج',
      'أكتر من عرض بنفس الاسم',
      'السعر المكتوب مش سعر العرض (25.00)',
      'الكمية ما بتطابق قطع العرض',
    ]) {
      expect(screen.getAllByText(sentence).length, sentence).toBeGreaterThan(0);
    }
    const [notFound, , mismatch] = within(desk()).getAllByRole('row').slice(1);
    // The offer cell is marked for the offer's reason; the price × quantity cell for the price's.
    expect(within(notFound).getByText(READING.offer).className).not.toBe(within(mismatch).getByText(READING.offer).className);
    expect(within(mismatch).getByText('25 × 1').className).not.toBe(within(notFound).getByText('25 × 1').className);
    expect(document.body.textContent).not.toMatch(/[A-Z][A-Z_]{3,}/);
  });

  it('— an order made from a message shows the offer it was tied to', async () => {
    rows = [
      message('m1', {
        processingStatus: 'PROCESSED',
        reviewReason: null,
        order: { id: 'o1', orderNumber: 'SY-1', offer: { name: 'قطعتين + قطعة هدية ( عدد 3 )' } },
      }),
      message('m2', { processingStatus: 'PROCESSED', reviewReason: null, order: { id: 'o2', orderNumber: 'SY-2', offer: null } }),
    ];
    await draw();
    expect(screen.getAllByText('مربوط بالعرض: قطعتين + قطعة هدية ( عدد 3 )').length).toBeGreaterThan(0);
    // An order whose offer is gone (SetNull) draws no line, rather than an empty one.
    expect(screen.getAllByText(/^مربوط بالعرض:/).length).toBe(screen.getAllByText('مربوط بالعرض: قطعتين + قطعة هدية ( عدد 3 )').length);
  });

  it('— the price and the quantity are one cell, marked for either', async () => {
    rows = [message('m1', { reviewReason: 'INVALID_QUANTITY' }), message('m2', { reviewReason: 'PRODUCT_NOT_FOUND' })];
    await draw();
    const [bad, fine] = within(desk()).getAllByRole('row').slice(1);
    expect(within(bad).getByText('25 × 1').className).not.toBe(within(fine).getByText('25 × 1').className);
  });

  it('— no code in English reaches the screen, whatever the door wrote', async () => {
    rows = [
      message('m1', { reviewReason: 'NO_STORE' }),
      message('m2', { reviewReason: 'CUSTOMER_BLOCKED' }),
      message('m3', { reviewReason: 'SOMETHING_NOBODY_WROTE' }),
      message('m4', { processingStatus: 'FAILED', reviewReason: null }),
      message('m5', { reviewReason: 'MISSING_PHONE', reading: { claimed: true, orderedAt: READING.orderedAt } }),
    ];
    await draw();
    await screen.findAllByText('ناقص: رقم الهاتف');
    expect(document.body.textContent).not.toMatch(/\b[A-Z][A-Z_]{3,}\b/);
    expect(screen.getAllByText('المجموعة مش مربوطة بمتجر').length).toBeGreaterThan(0);
    expect(screen.getAllByText('الرقم بقائمة الحظر').length).toBeGreaterThan(0);
  });

  it('— a duplicate links the order its twin already made', async () => {
    rows = [message('m1', { reviewReason: 'DUPLICATE_ORDER', twin: { id: 'o1', orderNumber: 'SY-2026-0001' } })];
    await draw();
    expect(screen.getAllByText('نفس الزبون والمنتج والوقت صار طلب').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SY-2026-0001').length).toBeGreaterThan(0);
  });
});

describe('the actions on a row', () => {
  it('— «إعادة المعالجة» where it can change the answer, and the list is read again even when it did not', async () => {
    await draw();
    const before = gets().length;
    fireEvent.click(within(desk()).getByRole('button', { name: /إعادة المعالجة/ }));
    await waitFor(() => expect(posts('/m1/retry')).toHaveLength(1));
    await waitFor(() => expect(gets().length).toBe(before + 1));
    expect(toast.failed).toHaveBeenCalledWith('المنتج مش موجود');
  });

  it('— and where it cannot, the row says what will', async () => {
    rows = [message('m1', { reviewReason: 'MISSING_PHONE' })];
    await draw();
    expect(within(desk()).queryByRole('button', { name: /إعادة المعالجة/ })).toBeNull();
    expect(within(desk()).getByText('صحّح الرسالة وابعتها من جديد')).toBeTruthy();
  });

  it('— «تجاهل» asks first, and a «no» sends nothing', async () => {
    confirm.mockResolvedValue(false);
    await draw();
    fireEvent.click(within(desk()).getByRole('button', { name: 'تجاهل' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(posts('/m1/ignore')).toHaveLength(0);
  });

  it('— and a «yes» ignores it and reads the list again', async () => {
    await draw();
    const before = gets().length;
    fireEvent.click(within(desk()).getByRole('button', { name: 'تجاهل' }));
    await waitFor(() => expect(posts('/m1/ignore')).toHaveLength(1));
    await waitFor(() => expect(gets().length).toBe(before + 1));
  });

  it('— an ignored message can be taken back, and one that became an order offers neither', async () => {
    rows = [
      message('m1', { processingStatus: 'IGNORED', reviewReason: null }),
      message('m2', { processingStatus: 'PROCESSED', reviewReason: null, order: { id: 'o9', orderNumber: 'SY-2026-0009' } }),
    ];
    await draw();
    const [ignored, made] = within(desk()).getAllByRole('row').slice(1);
    expect(within(ignored).getByRole('button', { name: /إعادة المعالجة/ })).toBeTruthy();
    expect(within(ignored).queryByRole('button', { name: 'تجاهل' })).toBeNull();
    expect(within(made).queryByRole('button')).toBeNull();
    expect(within(made).getByText('SY-2026-0009')).toBeTruthy();
  });

  it('— somebody who may only read gets no button at all', async () => {
    user.current = { id: 'u3', role: 'CUSTOM', permissions: ['telegram.view'] };
    await draw();
    expect(within(desk()).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: /الإعدادات/ })).toBeNull();
  });
});

describe('the message as it arrived', () => {
  it('— is folded under «نص الرسالة», closed until asked for, with where it came from', async () => {
    await draw();
    const folds = document.querySelectorAll('details');
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      expect(fold.open).toBe(false);
      expect(fold.querySelector('summary')!.textContent).toBe('نص الرسالة');
    }
    expect(folds[0].textContent).toContain('رقم الطلب: 26842');
    expect(folds[0].textContent).toContain('من: طلبات الصفحة · بلا موضوع · أبو أحمد · وصلت');
  });
});

describe('on a phone', () => {
  it('— one card per message: the reason first, then the date and the name, then his labels, then the actions', async () => {
    rows = [message('m1'), message('m2', { reviewReason: 'INVALID_PHONE' })];
    await draw();
    expect(cards()).toHaveLength(2);
    const card = cards()[1];
    expect(card.firstElementChild!.textContent).toBe('رقم الهاتف مش صالح');
    expect(card.children[1].textContent).toContain(READING.orderedAt);
    expect(card.children[1].textContent).toContain(READING.customer);
    expect(within(card).getAllByRole('term').map((dt) => dt.textContent)).toEqual(['الهاتف', 'العنوان', 'المنتج', 'العرض', 'السعر × الكمية', 'الحالة']);
    expect(within(card).getByRole('button', { name: 'تجاهل' })).toBeTruthy();
    expect(within(card).getByText('نص الرسالة')).toBeTruthy();
  });
});
