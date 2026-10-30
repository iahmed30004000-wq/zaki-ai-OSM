// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { ReviewPreview } from '@/lib/change-request-review';

/**
 * THE DIALOG THAT DECIDES A REQUEST — for one that edits several lines.
 *
 * «زر موافقة معطّل مع سبب ظاهر عند مشاكل مانعة حالية، ولا يُعطَّل الرفض». Read off the rendered dialog: the approve
 * button is shut for as long as the server's check says the order cannot take the request (or has not said anything yet),
 * the sentence is on the screen and not only in a tooltip, and rejecting is never shut by it.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn<(url: string, init?: { method?: string; body?: string }) => Promise<unknown>>() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (url: string, init?: { method?: string; body?: string }) => apiJson(url, init), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));

import { ChangeRequestReview } from './ChangeRequestReview';

const LINES = {
  v: 2,
  edits: [
    {
      lineId: 'l1',
      productId: { from: 'prod-cream-0001', to: 'prod-cream-0001' },
      quantity: { from: 3, to: 5 },
      lineTotal: { from: 36, to: 60 },
      freeQuantity: { from: 0, to: 0 },
    },
  ],
  snapshot: { orderVersion: 7, minorUnit: 3, before: { cod: 48.5 }, after: { cod: 72.5 } },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cr1',
  orderId: 'o1',
  reason: 'الزبون زاد الكمية',
  changes: { lines: LINES, customerName: { from: 'سامر', to: 'سامر أحمد' } },
  requestedByName: 'ريم',
  requestedRole: 'CONFIRMATION_AGENT',
  createdAt: '2026-10-29T10:00:00.000Z',
  order: { orderNumber: 'SY-2026-0148' },
  needsPriceKey: false,
  ...over,
});

const preview = (over: Partial<ReviewPreview> = {}): ReviewPreview => ({
  requestId: 'cr1',
  stale: false,
  lines: [
    {
      lineId: 'l1',
      changed: true,
      productName: { from: 'كريم', to: 'كريم' },
      quantity: { from: 3, to: 5 },
      freeQuantity: { from: 0, to: 0 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      totalAfterDiscount: 60,
      basis: 'KEEP_UNIT',
    },
  ],
  before: { subtotal: 46, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 48.5, giftUnits: 0 },
  after: { subtotal: 70, discount: 0, deliveryFee: 2.5, addOns: 0, cod: 72.5, giftUnits: 0 },
  stock: [],
  problems: [],
  blocked: false,
  drift: { known: true, moved: false, items: [] },
  door: 'REQUEST',
  orderVersion: 7,
  minorUnit: 3,
  ...over,
});

const STOCK_SHORT = { code: 'STOCK_SHORT_BLOCKED', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' };

/** The list the dialog reads its row from, and the preview of that row. */
function serve(r: ReturnType<typeof row>, p: ReviewPreview | Error) {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string) => {
    if (url.includes('/preview')) {
      if (p instanceof Error) throw p;
      return p;
    }
    return { requests: [r] };
  });
}

const open = () => render(<ChangeRequestReview requestId="cr1" onClose={() => undefined} onDecided={() => undefined} />);
const approve = () => screen.getByRole('button', { name: /موافقة/ }) as HTMLButtonElement;
const reject = () => screen.getByRole('button', { name: /رفض/ }) as HTMLButtonElement;

beforeEach(() => {
  apiJson.mockReset();
});
afterEach(cleanup);

describe('Ⅰ · a request that edits lines', () => {
  it('draws the before ← after table, and not the request as raw JSON', async () => {
    serve(row(), preview());
    open();
    await screen.findByText('الحساب');
    expect(screen.getByText('أسطر الطلب')).toBeTruthy();
    expect(document.body.textContent).not.toContain('"edits"');
    expect(document.body.textContent).not.toContain('lineId');
    // The customer field that travels beside the lines is still drawn as before.
    expect(screen.getByText('اسم العميل')).toBeTruthy();
    expect(screen.getByText('سامر أحمد')).toBeTruthy();
  });

  it('keeps «موافقة» shut while the check is still being made — nobody approves on a guess', async () => {
    let finish: (p: ReviewPreview) => void = () => undefined;
    apiJson.mockReset();
    apiJson.mockImplementation((url: string) =>
      url.includes('/preview') ? new Promise((resolve) => { finish = resolve as (p: ReviewPreview) => void; }) : Promise.resolve({ requests: [row()] })
    );
    open();
    await screen.findByText(/جارٍ حساب أثر الطلب/);
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/الموافقة مقفلة: جارٍ فحص الطلب/)).toBeTruthy();

    finish(preview());
    await screen.findByText('الحساب');
    await waitFor(() => expect(approve().disabled).toBe(false));
  });

  it('opens «موافقة» when nothing stops the request', async () => {
    serve(row(), preview());
    open();
    await screen.findByText('الحساب');
    await waitFor(() => expect(approve().disabled).toBe(false));
    expect(screen.queryByText(/الموافقة مقفلة/)).toBeNull();
  });

  it('shuts «موافقة» with the reason ON THE SCREEN when the server says it cannot be carried out — and rejecting stays open', async () => {
    serve(row(), preview({ blocked: true, problems: [STOCK_SHORT] }));
    open();
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    // The verdict reaches the dialog one render after the table is drawn: wait for the sentence, not for a button that was shut all along.
    await screen.findByText(/الموافقة مقفلة: المخزون ما بيكفي لـكريم\./);
    expect(approve().disabled).toBe(true);
    expect(approve().title).toBe('المخزون ما بيكفي لـكريم.');

    // Rejecting needs a reason (the server insists), not a clean preview.
    expect(reject().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/الطرد خرج مع المندوب/), { target: { value: 'ما يكفي المخزون' } });
    expect(reject().disabled).toBe(false);
  });

  it('a press on a shut «موافقة» sends nothing', async () => {
    serve(row(), preview({ blocked: true, problems: [STOCK_SHORT] }));
    open();
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    apiJson.mockClear();
    fireEvent.click(approve());
    expect(apiJson).not.toHaveBeenCalled();
  });

  it('a check that could not be made keeps it shut, and rejecting open', async () => {
    serve(row(), new Error('تعذر الاتصال'));
    open();
    await screen.findByText('تعذر الاتصال');
    await screen.findByText(/الموافقة مقفلة: تعذّر فحص الطلب/);
    expect(approve().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/الطرد خرج مع المندوب/), { target: { value: 'سبب' } });
    expect(reject().disabled).toBe(false);
  });

  it('approving sends the decision and nothing from the preview', async () => {
    serve(row(), preview());
    open();
    await screen.findByText('الحساب');
    await waitFor(() => expect(approve().disabled).toBe(false));
    apiJson.mockClear();
    apiJson.mockResolvedValue({});
    fireEvent.click(approve());
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    const [url, init] = apiJson.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/control/change-requests/cr1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ decision: 'APPROVED' });
  });

  it('lines that cannot be read are never approved, and the reason is said', async () => {
    serve(row({ changes: { lines: { v: 2, edits: [] } } }), preview());
    open();
    await screen.findByText(/الموافقة مقفلة: ما في أسطر للتعديل/);
    expect(approve().disabled).toBe(true);
  });
});

describe('Ⅱ · every other request is as it was', () => {
  it('asks for no preview and approves on the old rules', async () => {
    serve(row({ changes: { customerName: { from: 'سامر', to: 'سامر أحمد' } } }), preview());
    open();
    await screen.findByText('سامر أحمد');
    await waitFor(() => expect(approve().disabled).toBe(false));
    expect(apiJson.mock.calls.some(([url]) => String(url).includes('/preview'))).toBe(false);
    expect(screen.queryByText(/الموافقة مقفلة/)).toBeNull();
  });

  it('the price key still shuts it, with its own sentence and not the preview’s', async () => {
    serve(row({ needsPriceKey: true }), preview({ blocked: true, problems: [STOCK_SHORT] }));
    open();
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    expect(approve().disabled).toBe(true);
    expect(approve().title).toMatch(/صلاحية تغيير السعر/);
  });
});
