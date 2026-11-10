// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «منتجات الأب سيل» AND «دمج الأب سيل — تجربة», RENDERED FOR REAL (10/11).
 *
 * What they owe: the names button for whoever reads the screen and the dry-run button only for `telegram.manage`; the names
 * lists with no change buttons for somebody who may only look; the dry-run's five Arabic columns; and «نعم، نفّذ الدمج» asks
 * a second time before it sends `confirm: true` — a «لا» there sends nothing.
 */

const { api, toast, user, confirmAnswer } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  user: { current: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] } as Record<string, unknown> },
  confirmAnswer: { value: true, asked: 0 },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => async () => {
    confirmAnswer.asked++;
    return confirmAnswer.value;
  },
}));

import { TelegramOrdersScreen } from './TelegramOrdersScreen';

const PLAN = [
  { key: 'pair:m1:m2', kind: 'merge', orderNumber: '30051', product: 'قطرة طنين الأذن', units: 3, amount: 40, action: 'يندمج في طلب واحد' },
  { key: 'msg:m3', kind: 'review', orderNumber: '40000', product: 'قطرة طنين الأذن', units: null, amount: 40, action: 'يبقى بالمراجعة — رسالة أب سيل بلا طلب أساسي بنفس رقم الطلب' },
];
const NAMES = {
  rows: [
    { id: 'al1', kind: 'UPSELL', incomingName: 'كورس طنين: عبوتين إضافيات 🎁', productId: 'p1', productName: 'قطرة طنين الأذن', extraUnits: 2, linePrice: 20, offerAliases: [], isActive: true },
    { id: 'al2', kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productId: 'p1', productName: 'قطرة طنين الأذن', extraUnits: null, linePrice: null, offerAliases: [], isActive: true },
  ],
  products: [{ id: 'p1', name: 'قطرة طنين الأذن' }],
  currency: { currencyCode: 'USD', minorUnit: 2 },
};

const posts = (path: string) => api.mock.calls.filter((c) => String(c[0]) === path && (c[1] as RequestInit | undefined)?.method === 'POST');
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  vi.clearAllMocks();
  confirmAnswer.value = true;
  confirmAnswer.asked = 0;
  user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage'] };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
    if (url === '/api/telegram/upsell-merge') {
      const body = JSON.parse(String(init?.body));
      return body.mode === 'preview' ? { rows: PLAN } : { results: [{ key: 'pair:m1:m2', status: 'PROCESSED', orderId: 'o1' }] };
    }
    if (url === '/api/telegram/upsell-products') return NAMES;
    return { messages: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 }, facts: { review: 0, orders: 0, ignored: 0, all: 0 } };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TelegramOrdersScreen />);
  await screen.findByText('طلبات تلجرام');
};

describe('the two buttons', () => {
  it('both are there for telegram.manage', async () => {
    await draw();
    expect(screen.getByRole('button', { name: 'منتجات الأب سيل' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'دمج الأب سيل — تجربة' })).toBeTruthy();
  });

  it('somebody who may only look gets the names, not the dry-run', async () => {
    user.current = { id: 'u2', role: 'AGENT', permissions: ['telegram.view'] };
    await draw();
    expect(screen.getByRole('button', { name: 'منتجات الأب سيل' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'دمج الأب سيل — تجربة' })).toBeNull();
  });
});

describe('the names dialog', () => {
  it('shows both lists; the change buttons only for telegram.manage', async () => {
    user.current = { id: 'u2', role: 'AGENT', permissions: ['telegram.view'] };
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'منتجات الأب سيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('كورس طنين: عبوتين إضافيات 🎁');
    expect(within(dialog).getByText('الأب سيل')).toBeTruthy();
    expect(within(dialog).getByText('أسماء قديمة')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'أضف الأسماء الجاهزة' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'تعطيل' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /حذف|احذف/ })).toBeNull();
  });

  it('a manager adds the ready names and switches a name off — there is no delete', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'منتجات الأب سيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('كورس طنين: عبوتين إضافيات 🎁');
    expect(within(dialog).queryByRole('button', { name: /حذف|احذف/ })).toBeNull();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'تعطيل' })[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/telegram/upsell-products/al1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ isActive: false }) })));
  });
});

describe('the dry-run', () => {
  const open = async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'دمج الأب سيل — تجربة' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText('يندمج في طلب واحد');
    return dialog;
  };

  it('asks for a preview only, and draws the five Arabic columns', async () => {
    const dialog = await open();
    expect(posts('/api/telegram/upsell-merge').map(bodyOf)).toEqual([{ mode: 'preview' }]);
    const heads = within(within(dialog).getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads).toEqual(['رقم الطلب', 'المنتج', 'العبوات', 'المبلغ', 'الإجراء']);
  });

  it('«نعم، نفّذ الدمج» asks again; a «لا» sends nothing', async () => {
    confirmAnswer.value = false;
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'نعم، نفّذ الدمج' }));
    await waitFor(() => expect(confirmAnswer.asked).toBe(1));
    expect(posts('/api/telegram/upsell-merge').map(bodyOf)).toEqual([{ mode: 'preview' }]);
  });

  it('and a «نعم» sends confirm: true with the rows that would become orders', async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'نعم، نفّذ الدمج' }));
    await waitFor(() => expect(posts('/api/telegram/upsell-merge').map(bodyOf)).toContainEqual({ mode: 'apply', confirm: true, keys: ['pair:m1:m2'] }));
    expect(confirmAnswer.asked).toBe(1);
  });
});
