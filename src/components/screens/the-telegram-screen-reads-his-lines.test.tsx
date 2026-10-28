// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «قم بتحسين واجهة طلبات تلجرام لانها معجوقة» — THE SCREEN, RENDERED FOR REAL.
 *
 * What it owes beyond drawing: his line order in the columns; tabs whose counts are the server's and whose active count
 * is the list's own total; the reason in Arabic, naming the line; «إعادة المعالجة» only where it can change the answer,
 * and the list read again after it; «تجاهل» that asks first; the message folded until asked for; a card per message on
 * a phone; and the bot's status read when the screen opens and on «تحديث», never on a tab.
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

const LINES = {
  format: 'lines',
  lineCount: 7,
  orderedAt: '2026-10-28 15:40:01',
  customer: 'محمد',
  phone: '0932323642',
  governorate: 'سوريا حماه',
  product: 'ماء الكمأ الأصلي',
  offer: 'القطعة ب 15 $ + توصيل مجاني',
};
const TEXT = ['26818', LINES.orderedAt, LINES.customer, LINES.phone, LINES.governorate, LINES.product, LINES.offer].join('\n');

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
  createdAt: '2026-10-28T12:40:05.000Z',
  source: { chatTitle: 'طلبات الصفحة', topicName: null },
  order: null,
  reading: LINES,
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
  await screen.findAllByText('محمد');
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
    await screen.findAllByText('محمد');
    expect(screen.queryByRole('status', { name: 'جارٍ التحميل' })).toBeNull();
  });

  it('— prints the rule, one line', async () => {
    await draw();
    expect(screen.getByText(/^سطر لكل معلومة: 1 مرجع \(يُتجاهل\) · 2 تاريخ الطلب · 3 العميل · 4 الهاتف · 5 المحافظة · 6 المنتج · 7 العرض\./)).toBeTruthy();
  });

  it('— and to somebody who may not read the messages, says so and asks nothing', () => {
    user.current = { id: 'u2', role: 'CUSTOM', permissions: [] };
    render(<TelegramOrdersScreen />);
    expect(screen.getByText('ما عندك صلاحية تشوف طلبات تلجرام')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
  });
});

describe('his columns, in his order', () => {
  it('— the headings are his seven lines from 2 to 7, then the state', async () => {
    await draw();
    const heads = within(desk()).getAllByRole('columnheader').map((th) => th.textContent);
    expect(heads).toEqual(['تاريخ الطلب', 'العميل', 'الهاتف', 'المحافظة', 'المنتج', 'العرض', 'الحالة', '']);
  });

  it('— and the row is his message, line by line', async () => {
    await draw();
    const cells = within(within(desk()).getAllByRole('row')[1]).getAllByRole('cell').map((td) => td.textContent);
    expect(cells.slice(0, 6)).toEqual([LINES.orderedAt, LINES.customer, LINES.phone, LINES.governorate, LINES.product, LINES.offer]);
  });

  it('— a message with no date line says when it arrived instead', async () => {
    rows = [message('m1', { reading: { format: 'labels', customer: 'سامر', phone: '0933444555' } })];
    render(<TelegramOrdersScreen />);
    await screen.findAllByText('سامر');
    expect(within(desk()).getAllByText(/^وصلت /).length).toBeGreaterThan(0);
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

  it('— «تحديث» reads the bot and the page again', async () => {
    await draw();
    const before = gets().length;
    fireEvent.click(screen.getByRole('button', { name: /تحديث/ }));
    await waitFor(() => expect(statusReads()).toBe(2));
    await waitFor(() => expect(gets().length).toBe(before + 1));
  });
});

describe('why a message waits — in Arabic, naming the line', () => {
  it('— the reason names the line, and the cell of that line is the one marked', async () => {
    rows = [message('m1', { reviewReason: 'INVALID_PHONE' }), message('m2', { reviewReason: 'PRODUCT_NOT_FOUND' })];
    await draw();
    expect(screen.getAllByText('السطر 4: رقم الهاتف مش صالح').length).toBeGreaterThan(0);
    expect(screen.getAllByText('السطر 6: المنتج مش موجود').length).toBeGreaterThan(0);
    // The same column in two rows: marked where its line failed, plain where it did not — and the same mark both times.
    const [phoneRow, productRow] = within(desk()).getAllByRole('row').slice(1);
    const phoneFailed = within(phoneRow).getByText(LINES.phone);
    const phoneFine = within(productRow).getByText(LINES.phone);
    const productFailed = within(productRow).getByText(LINES.product);
    expect(phoneFailed.className).not.toBe(phoneFine.className);
    expect(phoneFailed.className).toBe(productFailed.className);
  });

  it('— no code in English reaches the screen, whatever the door wrote', async () => {
    rows = [
      message('m1', { reviewReason: 'NO_STORE' }),
      message('m2', { reviewReason: 'CUSTOMER_BLOCKED' }),
      message('m3', { reviewReason: 'SOMETHING_NOBODY_WROTE' }),
      message('m4', { processingStatus: 'FAILED', reviewReason: null }),
      message('m5', { reviewReason: 'LINE_COUNT', reading: { format: 'lines', lineCount: 6, orderedAt: LINES.orderedAt } }),
    ];
    await draw();
    expect(document.body.textContent).not.toMatch(/\b[A-Z][A-Z_]{3,}\b/);
    expect(screen.getAllByText('المجموعة مش مربوطة بمتجر').length).toBeGreaterThan(0);
    expect(screen.getAllByText('السطر 4: الرقم بقائمة الحظر').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^عدد أسطر الرسالة 6، والمطلوب 7/).length).toBeGreaterThan(0);
  });

  it('— a duplicate links the order its twin already made', async () => {
    rows = [message('m1', { reviewReason: 'DUPLICATE_REF', twin: { id: 'o1', orderNumber: 'SY-2026-0001' } })];
    await draw();
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
    expect(toast.failed).toHaveBeenCalledWith('السطر 6: المنتج مش موجود');
  });

  it('— and where it cannot, the row says what will', async () => {
    rows = [message('m1', { reviewReason: 'OFFER_UNREADABLE' })];
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
    expect(folds[0].textContent).toContain('26818');
    expect(folds[0].textContent).toContain('من: طلبات الصفحة · بلا موضوع · أبو أحمد · وصلت');
  });
});

describe('on a phone', () => {
  it('— one card per message: the reason first, then the date and the name, then his lines, then the actions', async () => {
    rows = [message('m1'), message('m2', { reviewReason: 'INVALID_PHONE' })];
    await draw();
    expect(cards()).toHaveLength(2);
    const card = cards()[1];
    expect(card.firstElementChild!.textContent).toBe('السطر 4: رقم الهاتف مش صالح');
    expect(card.children[1].textContent).toContain(LINES.orderedAt);
    expect(card.children[1].textContent).toContain(LINES.customer);
    expect(within(card).getAllByRole('term').map((dt) => dt.textContent)).toEqual(['الهاتف', 'المحافظة', 'المنتج', 'العرض', 'الحالة']);
    expect(within(card).getByRole('button', { name: 'تجاهل' })).toBeTruthy();
    expect(within(card).getByText('نص الرسالة')).toBeTruthy();
  });
});
