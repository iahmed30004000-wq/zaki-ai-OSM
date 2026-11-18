// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * «طلبات تلجرام» ON THE KIT (R10f, plan 17/11) — ONE LOOK, AND NOTHING ELSE MOVED.
 *
 * What it owes: the frame is `PageShell` with the menu's own name as the one h1; the captions are the sheet's caption size,
 * except the label drawn to match the kit's own field label; the names dialog's boxes are the kit's plain card; every press
 * is still there and opens the same dialog; and the names dialog still posts the same body. The bodies of «تعديل وترحيل» and
 * «دمج الأب سيل» are pinned by their own files (corrects-by-hand, merges-the-upsell), unedited.
 */

const { api, toast, user } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
  user: { current: { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage', 'telegram.connect'] } as Record<string, unknown> },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => async () => true }));

import { TelegramOrdersScreen } from './TelegramOrdersScreen';

const READING = {
  claimed: true,
  orderedAt: '2026-10-28 17:45:32',
  customer: 'زبون تجريبي',
  phone: '0900000000',
  address: 'مدينة تجريبية',
  product: 'منتج تجريبي',
  offer: 'عرض تجريبي',
  price: '25',
  quantity: '1',
};
const ROW = {
  id: 'm1',
  chatId: '-1001',
  threadId: null,
  threadName: null,
  senderName: 'مرسل',
  text: 'نص',
  processingStatus: 'NEEDS_REVIEW',
  reviewReason: 'PRODUCT_NOT_FOUND',
  pageName: 'صفحة',
  createdAt: '2026-10-28T14:45:40.000Z',
  source: { chatTitle: 'مجموعة', topicName: null },
  order: null,
  reading: READING,
  twin: null,
};
const NAMES = {
  rows: [
    { id: 'al1', kind: 'UPSELL', incomingName: 'اسم أب سيل', productId: 'p1', productName: 'منتج تجريبي', extraUnits: 2, linePrice: 20, offerAliases: [], isActive: true },
    {
      id: 'al2',
      kind: 'RENAMED',
      incomingName: 'اسم قديم',
      productId: 'p1',
      productName: 'منتج تجريبي',
      extraUnits: null,
      linePrice: null,
      offerAliases: [{ name: 'عرض قديم', quantity: 2, price: 30 }],
      isActive: true,
    },
  ],
  products: [{ id: 'p1', name: 'منتج تجريبي' }],
  currency: { currencyCode: 'USD', minorUnit: 2 },
};

const SCREENS = ['TelegramOrdersScreen', 'TelegramAliasesDialog', 'TelegramCorrectDialog', 'TelegramUpsellMergeDialog'];
const source = (name: string) => readFileSync(join(process.cwd(), 'src/components/screens', `${name}.tsx`), 'utf8');
/** Built from parts, so this file itself writes no class-like token the stylesheet would pick up. */
const XS = ['text', 'xs'].join('-');

beforeEach(() => {
  vi.clearAllMocks();
  user.current = { id: 'u1', role: 'COMPANY_ADMIN', permissions: ['telegram.view', 'telegram.manage', 'telegram.connect'] };
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/telegram/status') return { botConfigured: true, botApiOk: true };
    if (url === '/api/telegram/upsell-products' && !init?.method) return NAMES;
    if (url.startsWith('/api/telegram/upsell-products')) return { ok: true };
    if (url === '/api/telegram/upsell-merge') return { rows: [] };
    if (url.endsWith('/correct')) return { status: 'NEEDS_REVIEW', reason: 'PRODUCT_NOT_FOUND' };
    return { messages: [ROW], pagination: { total: 1, page: 1, limit: 25, totalPages: 1 }, facts: { review: 1, orders: 0, ignored: 0, all: 1 } };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TelegramOrdersScreen />);
  await screen.findAllByText(READING.customer);
};

describe('the frame', () => {
  it('— one h1, and it is the menu’s own name for the page', async () => {
    await draw();
    const heads = screen.getAllByRole('heading', { level: 1 });
    expect(heads).toHaveLength(1);
    expect(heads[0].textContent).toBe(routeLabel('/growth/telegram/orders'));
    expect(heads[0].textContent).toBe('طلبات تلجرام');
  });

  it('— is the kit’s `PageShell`, and the screen draws no header and no outer box of its own', () => {
    const src = source('TelegramOrdersScreen');
    expect(src).toContain('<PageShell');
    expect(src).toContain("routeLabel('/growth/telegram/orders')");
    expect(src).not.toContain('<PageHeader');
    expect(src).not.toMatch(/className="p-6 /);
  });

  it('— the bot chip still sits beside the name', async () => {
    await draw();
    await waitFor(() => expect(screen.getByText('البوت متصل')).toBeTruthy());
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.parentElement!.textContent).toContain('البوت متصل');
  });
});

describe('the same presses, the same dialogs', () => {
  it('— the four presses of the header for somebody who holds the three keys, then the row’s three', async () => {
    await draw();
    for (const name of ['منتجات الأب سيل', 'دمج الأب سيل — تجربة', /الإعدادات/, /تحديث/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: /الإعدادات/ }).getAttribute('href')).toBe('/settings/links#telegram');
    const desk = screen.getByRole('table');
    expect(within(desk).getAllByRole('columnheader')).toHaveLength(9);
    expect(within(desk).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['تعديل وترحيل', 'إعادة المعالجة', 'تجاهل']);
  });

  it('— «تعديل وترحيل» opens its dialog, eight boxes', async () => {
    await draw();
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /تعديل وترحيل/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(8);
  });

  it('— «منتجات الأب سيل» opens the names, each name on the kit’s plain card', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'منتجات الأب سيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('اسم أب سيل');
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    for (const li of items) {
      expect(li.className).toBe('');
      const card = li.firstElementChild as HTMLElement;
      expect(card.className).toContain('bg-[var(--sys-card)]');
      expect(card.className).toContain('p-3');
      // Plain: a row in a dialog is not a page, so it wears no theme ornament.
      expect(card.classList.contains(CARD_CLASS)).toBe(false);
    }
    // The figures are still the money component's.
    expect(within(dialog).getByText(/عرض قديم ← 2 بـ/)).toBeTruthy();
  });

  it('— and a new upsell name posts the same body as before', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'منتجات الأب سيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('اسم أب سيل');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ أب سيل' }));
    fireEvent.change(within(dialog).getByLabelText('الاسم الوارد'), { target: { value: 'اسم جديد' } });
    fireEvent.change(within(dialog).getByLabelText('المنتج'), { target: { value: 'p1' } });
    fireEvent.change(within(dialog).getByLabelText('عدد العبوات الإضافية'), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByLabelText('سعر السطر'), { target: { value: '12,5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/telegram/upsell-products', expect.objectContaining({ method: 'POST' }))
    );
    const call = api.mock.calls.find((c) => c[0] === '/api/telegram/upsell-products' && (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      kind: 'UPSELL',
      incomingName: 'اسم جديد',
      productId: 'p1',
      extraUnits: 3,
      linePrice: 12.5,
      offerAliases: null,
    });
  });

  it('— «دمج الأب سيل — تجربة» opens its dialog and asks for a preview only', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'دمج الأب سيل — تجربة' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/telegram/upsell-merge', expect.objectContaining({ body: JSON.stringify({ mode: 'preview' }) })));
  });
});

describe('the captions', () => {
  it('— the captions the screen and the names dialog write themselves are the caption size, not the extra-small one', async () => {
    await draw();
    const captions: HTMLElement[] = [
      ...screen.getAllByText('نص الرسالة'),
      ...screen.getAllByText('الصفحة: صفحة'),
      ...screen.getAllByText('المنتج مش موجود'),
    ];
    fireEvent.click(screen.getByRole('button', { name: 'منتجات الأب سيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('اسم أب سيل');
    captions.push(within(dialog).getByText(/عرض قديم ← 2 بـ/), ...within(dialog).getAllByText(/^المنتج: منتج تجريبي/));
    for (const el of captions) {
      expect(el.classList.contains('text-note'), el.textContent ?? '').toBe(true);
      expect(el.classList.contains(XS), el.textContent ?? '').toBe(false);
    }
  });

  it('— and in the source, only that one label line carries it', () => {
    const counts = Object.fromEntries(SCREENS.map((s) => [s, source(s).split(XS).length - 1]));
    expect(counts).toEqual({ TelegramOrdersScreen: 0, TelegramAliasesDialog: 1, TelegramCorrectDialog: 0, TelegramUpsellMergeDialog: 0 });
  });

  it('— no fixed width and no unbreakable line that would push a 375px phone sideways', () => {
    const wide = [['w', '['].join('-'), ['min', 'w', '['].join('-'), ['whitespace', 'nowrap'].join('-')];
    for (const s of SCREENS) for (const token of wide) expect(source(s).includes(token), `${s}: ${token}`).toBe(false);
  });
});
