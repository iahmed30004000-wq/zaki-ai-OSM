// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «اريد يكون في خيار تعديل على الطلبات اللي بخانة المراجعة … تعديل يدوي وترحيل لخانة صارت طلبات» — THE FORM, RENDERED FOR REAL.
 *
 * What it owes: the button on a held or set-aside message and on no other; eight real boxes with what the seller wrote;
 * a blank box is said before anything is sent; the eight values go to `/correct` and nothing else; an order closes it and
 * reads the list again; a message that still waits keeps it open with the NEW reason and what was typed.
 */

const { api, toast, user } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  user: { current: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] } as Record<string, unknown> },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn() }));

import { TelegramOrdersScreen } from './TelegramOrdersScreen';

const READING = {
  claimed: true,
  orderedAt: '2026-10-28 17:45:32',
  customer: 'محمد عيد أطليبي',
  phone: '+96398101968',
  address: 'الرقة الكرمة',
  product: 'ماء الكمأ الأصلي',
  offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
  price: '25',
  quantity: '1',
};

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  chatId: '-1001',
  threadId: null,
  threadName: null,
  senderName: 'أبو أحمد',
  text: 'x',
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
let answer: Record<string, unknown>;
let reads: number;

const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');
const correctPosts = () => posts().filter((c) => String(c[0]).endsWith('/correct'));
const page = () => ({ messages: rows, pagination: { total: 1, page: 1, limit: 25, totalPages: 1 }, facts: { review: 1, orders: 0, ignored: 0, all: 1 } });

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] };
  rows = [message('m1')];
  reads = 0;
  answer = { success: true, status: 'PROCESSED', orderId: 'o1' };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
    if (init?.method === 'POST' && url.endsWith('/correct')) return answer;
    reads++;
    return page();
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TelegramOrdersScreen />);
  await screen.findAllByText(READING.customer);
};
const desk = () => screen.getByRole('table');
const open = async () => {
  await draw();
  fireEvent.click(within(desk()).getByRole('button', { name: /تعديل وترحيل/ }));
  return await screen.findByRole('dialog');
};
const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('the button', () => {
  it('is on a message that waits for review', async () => {
    await draw();
    expect(within(desk()).getByRole('button', { name: /تعديل وترحيل/ })).toBeTruthy();
  });

  it.each(['FAILED', 'IGNORED'])('is on a %s message too — a person may push a set-aside message on', async (status) => {
    rows = [message('m1', { processingStatus: status })];
    await draw();
    expect(within(desk()).getByRole('button', { name: /تعديل وترحيل/ })).toBeTruthy();
  });

  it('is not on a message that is already an order, nor on a PENDING one', async () => {
    rows = [message('m1', { processingStatus: 'PROCESSED', order: { id: 'o1', orderNumber: 'SY-1', offer: null } }), message('m2', { processingStatus: 'PENDING' })];
    await draw();
    expect(screen.queryAllByRole('button', { name: /تعديل وترحيل/ })).toHaveLength(0);
  });

  it('is not shown to somebody who may only look', async () => {
    user.current = { id: 'u2', role: 'MODERATOR', permissions: ['telegram.view'] };
    await draw();
    expect(screen.queryAllByRole('button', { name: /تعديل وترحيل/ })).toHaveLength(0);
  });
});

describe('the form', () => {
  it('has eight real boxes, each with the label the seller writes and what he wrote — and no order number', async () => {
    await open();
    expect(box('تاريخ الطلب').value).toBe(READING.orderedAt);
    expect(box('إسم العميل').value).toBe(READING.customer);
    expect(box('رقم الهاتف').value).toBe(READING.phone);
    expect(box('عنوان العميل').value).toBe(READING.address);
    expect(box('إسم المنتج').value).toBe(READING.product);
    expect(box('إسم العرض').value).toBe(READING.offer);
    expect(box('السعر').value).toBe('25');
    expect(box('الكمية').value).toBe('1');
    expect(screen.queryByLabelText('رقم الطلب')).toBeNull();
  });

  it('says why the message waits, while it is being edited', async () => {
    const dialog = await open();
    expect(within(dialog).getByRole('alert').textContent).toContain('المنتج مش موجود');
  });

  it('starts a message that was no order from its arrival time, the rest empty', async () => {
    rows = [message('m1', { processingStatus: 'IGNORED', reviewReason: 'NOT_IN_FORMAT', reading: { claimed: false } as typeof READING })];
    render(<TelegramOrdersScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: /تعديل وترحيل/ }))[0]);
    await screen.findByRole('dialog');
    expect(box('تاريخ الطلب').value).toMatch(/^2026-10-2[89] \d{2}:\d{2}:\d{2}$/);
    expect(box('إسم العميل').value).toBe('');
    expect(box('رقم الهاتف').value).toBe('');
  });

  it('says a blank box before it sends anything', async () => {
    const dialog = await open();
    fireEvent.change(box('إسم العميل'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /احفظ وحوّلها/ }));
    expect(await within(dialog).findByText('ناقص: إسم العميل')).toBeTruthy();
    expect(correctPosts()).toHaveLength(0);
  });
});

describe('saving', () => {
  it('sends the eight values to /correct and nothing else — and an order closes the form and reads the list again', async () => {
    const dialog = await open();
    fireEvent.change(box('إسم المنتج'), { target: { value: 'ماء الكمأ' } });
    const before = reads;
    fireEvent.click(within(dialog).getByRole('button', { name: /احفظ وحوّلها/ }));
    await waitFor(() => expect(correctPosts()).toHaveLength(1));
    expect(String(correctPosts()[0][0])).toBe('/api/telegram/messages/m1/correct');
    expect(JSON.parse(String((correctPosts()[0][1] as RequestInit).body))).toEqual({
      orderedAt: READING.orderedAt,
      customer: READING.customer,
      phone: READING.phone,
      address: READING.address,
      product: 'ماء الكمأ',
      offer: READING.offer,
      price: '25',
      quantity: '1',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.done).toHaveBeenCalledWith('صارت طلب');
    expect(reads).toBeGreaterThan(before);
    expect(posts().filter((c) => !String(c[0]).endsWith('/correct'))).toHaveLength(0);
  });

  it('a message that still waits keeps the form open with the NEW reason and what was typed', async () => {
    answer = { success: false, status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:25.00' };
    const dialog = await open();
    fireEvent.change(box('السعر'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /احفظ وحوّلها/ }));
    expect(await within(dialog).findByText('السعر المكتوب مش سعر العرض (25.00)')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(box('السعر').value).toBe('30');
    expect(toast.done).not.toHaveBeenCalled();
  });

  it('a refusal from the server is said in the form, not lost', async () => {
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
      if (init?.method === 'POST') throw new Error('صار منها طلب — ما بتنعدّل');
      return page();
    });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: /احفظ وحوّلها/ }));
    expect(await within(dialog).findByText('صار منها طلب — ما بتنعدّل')).toBeTruthy();
  });
});
