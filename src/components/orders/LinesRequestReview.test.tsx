// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewPreview } from '@/lib/change-request-review';

/**
 * THE DECIDER READS WHAT THE SERVER SAID, before ← after — and cannot press what the server says is impossible.
 *
 * Read off the rendered screen. The server's answer is a fixture; every figure on the screen is one of its numbers, so
 * the tests also hold that the component does arithmetic on none of them.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (url: string) => apiJson(url), apiFetch: vi.fn() }));

import { LinesRequestReview, type Verdict } from './LinesRequestReview';
import { REVIEW_UNAVAILABLE_AR } from '@/lib/change-request-review';

const totals = (cod: number, over: Partial<ReviewPreview['before']> = {}): ReviewPreview['before'] => ({
  subtotal: cod - 2.5,
  discount: 0,
  deliveryFee: 2.5,
  addOns: 0,
  cod,
  giftUnits: 0,
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
      freeQuantity: { from: 0, to: 1 },
      lineTotal: { from: 36, to: 60 },
      unitPrice: { from: 12, to: 12 },
      totalAfterDiscount: 60,
      basis: 'KEEP_UNIT',
    },
    {
      lineId: 'l2',
      changed: false,
      productName: { from: 'صابون', to: 'صابون' },
      quantity: { from: 2, to: 2 },
      freeQuantity: { from: 0, to: 0 },
      lineTotal: { from: 10, to: 10 },
      unitPrice: { from: 5, to: 5 },
      totalAfterDiscount: 10,
      basis: null,
    },
  ],
  before: totals(48.5),
  after: totals(72.5, { subtotal: 70, giftUnits: 1 }),
  stock: [{ productId: 'p1', productName: 'كريم', before: 3, after: 6, held: 3, freed: 0, enough: true, status: 'ENOUGH' }],
  problems: [],
  blocked: false,
  drift: { known: true, moved: false, items: [] },
  door: 'REQUEST',
  orderVersion: 7,
  minorUnit: 3,
  ...over,
});

const serve = (p: ReviewPreview) => {
  apiJson.mockReset();
  apiJson.mockResolvedValue(p);
};

/** The verdicts the parent was told, last one last. */
const draw = (variant?: 'full' | 'gate') => {
  const told: Verdict[] = [];
  render(<LinesRequestReview requestId="cr1" variant={variant} onVerdict={(v) => told.push(v)} />);
  return told;
};

beforeEach(() => {
  apiJson.mockReset();
});
afterEach(cleanup);

describe('Ⅰ · the table', () => {
  it('asks the server about THIS request, and says it is working until the answer comes', async () => {
    serve(preview());
    const told = draw();
    expect(screen.getByText(/جارٍ حساب أثر الطلب/)).toBeTruthy();
    await screen.findAllByText('كريم');
    expect(apiJson).toHaveBeenCalledWith('/api/control/change-requests/cr1/preview');
    // While it was asking, the parent was told «still checking» and no sentence.
    expect(told[0]).toMatchObject({ checking: true, shut: null });
  });

  it('draws the money before ← after, every figure the server’s', async () => {
    serve(preview());
    draw();
    await screen.findByText('الحساب');
    // The total collected: 48.500 became 72.500.
    expect(screen.getAllByText('48.500').length).toBeGreaterThan(0);
    expect(screen.getAllByText('72.500').length).toBeGreaterThan(0);
    for (const label of ['مجموع الأسطر', 'الخصم', 'أجرة التوصيل', 'المطلوب من الزبون', 'القطع المجانية']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it('draws each CHANGED line with its product, quantity, price and gift — and only counts the rest', async () => {
    serve(preview());
    draw();
    await screen.findByText('الأسطر');
    // A table above `md` and a card per row below it come from the one shared component: both are in the page.
    expect(document.querySelectorAll('table').length).toBe(2); // the lines, and the shelf
    const row = document.querySelector('tbody tr') as HTMLElement;
    expect(row.textContent).toContain('كريم');
    // quantity 3 → 5, price 36.000 → 60.000, gift 0 → 1
    expect(row.textContent).toMatch(/3.*5/);
    expect(row.textContent).toContain('36.000');
    expect(row.textContent).toContain('60.000');
    expect(row.textContent).toMatch(/0.*1/);
    expect(screen.queryByText('صابون')).toBeNull();
    expect(screen.getByText('1 سطر بلا تغيير.')).toBeTruthy();
  });

  it('draws the shelf per product, in words, and no count of what the warehouse holds', async () => {
    serve(preview());
    draw();
    await screen.findAllByText('المخزون');
    expect(screen.getAllByText('يكفي').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/متوفر|الرصيد/);
  });

  it('a shelf that cannot cover it is drawn as such', async () => {
    serve(
      preview({
        stock: [{ productId: 'p1', productName: 'كريم', before: 3, after: 6, held: 3, freed: 0, enough: false, status: 'SHORT_BLOCKED' }],
      })
    );
    draw();
    expect((await screen.findAllByText('ما بيكفي')).length).toBeGreaterThan(0);
  });
});

describe('Ⅱ · the reasons it cannot be carried out shut the button', () => {
  const blockedBy = [
    { code: 'STOCK_SHORT_BLOCKED', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' },
    { code: 'STATEMENT_LINKED', blocking: true, messageAr: 'الطلب مربوط بكشف شركة الشحن — الكشف هو اللي بيكتب المال.' },
  ];

  it('tells the parent the sentence: both reasons, once each', async () => {
    serve(preview({ blocked: true, problems: blockedBy }));
    const told = draw();
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    await waitFor(() => expect(told.at(-1)?.checking).toBe(false));
    expect(told.at(-1)?.shut).toBe('المخزون ما بيكفي لـكريم. — الطلب مربوط بكشف شركة الشحن — الكشف هو اللي بيكتب المال.');
    expect(screen.getByText('المخزون ما بيكفي لـكريم.')).toBeTruthy();
  });

  it('a warning alone does not shut it — it is shown under «للعلم»', async () => {
    serve(preview({ problems: [{ code: 'PRICE_FAR_FROM_BASE', blocking: false, messageAr: 'سعر القطعة بعيد كتير عن سعر المنتج الأساسي (12.000).' }] }));
    const told = draw();
    await screen.findByText('للعلم');
    await waitFor(() => expect(told.at(-1)?.checking).toBe(false));
    expect(told.at(-1)?.shut).toBeNull();
    expect(screen.queryByText('ما ينفع تنفيذ هذا الطلب الآن:')).toBeNull();
  });

  it('lines that moved: no result is drawn, only what was asked, and the button is shut', async () => {
    serve(
      preview({
        stale: true,
        after: null,
        blocked: true,
        problems: [{ code: 'LINES_STALE', blocking: true, messageAr: 'تغيّرت أسطر الطلب منذ رفع طلب التعديل — ارفع طلباً جديداً.' }],
      })
    );
    const told = draw();
    await screen.findByText(/ما في حساب لما بعد التعديل/);
    expect(screen.queryByText('الحساب')).toBeNull();
    await waitFor(() => expect(told.at(-1)?.shut).toContain('تغيّرت أسطر الطلب'));
  });

  it('a check that could not be made shuts it too, and can be asked again', async () => {
    apiJson.mockReset();
    apiJson.mockRejectedValueOnce(new Error('تعذر الاتصال'));
    const told = draw();
    await screen.findByText('تعذر الاتصال');
    expect(told.at(-1)).toMatchObject({ checking: false, shut: REVIEW_UNAVAILABLE_AR });

    apiJson.mockResolvedValue(preview());
    fireEvent.click(screen.getByRole('button', { name: 'أعد الفحص' }));
    await screen.findByText('الحساب');
    await waitFor(() => expect(told.at(-1)).toMatchObject({ checking: false, shut: null }));
    expect(apiJson).toHaveBeenCalledTimes(2);
  });
});

describe('Ⅲ · what moved since the request was raised', () => {
  it('says so in sentences, above the table', async () => {
    serve(
      preview({
        drift: {
          known: true,
          moved: true,
          items: [
            { kind: 'TOTAL', messageAr: 'إجمالي الطلب تغيّر منذ الرفع (كان 48.500، صار 50.000).' },
            { kind: 'SHELF', messageAr: 'المخزون ما عاد يكفي لـكريم.' },
          ],
        },
      })
    );
    draw();
    await screen.findByText('تغيّر شيء منذ رفع الطلب:');
    expect(screen.getByText('إجمالي الطلب تغيّر منذ الرفع (كان 48.500، صار 50.000).')).toBeTruthy();
    expect(screen.getByText('المخزون ما عاد يكفي لـكريم.')).toBeTruthy();
  });

  it('draws nothing when nothing moved', async () => {
    serve(preview());
    draw();
    await screen.findByText('الحساب');
    expect(screen.queryByText('تغيّر شيء منذ رفع الطلب:')).toBeNull();
  });

  it('a request with no record of the moment says so instead of «nothing changed»', async () => {
    serve(preview({ drift: { known: false, moved: false, items: [] } }));
    draw();
    expect(await screen.findByText(/بلا سجل لحالة الطلب وقت الرفع/)).toBeTruthy();
  });
});

describe('Ⅳ · the short form, for a card in the queue', () => {
  it('shows the total and the reasons, and not the tables', async () => {
    serve(preview({ blocked: true, problems: [{ code: 'ORDER_CLOSED', blocking: true, messageAr: 'الطلب مغلق (ملغى أو مرفوض أو مسلَّم) — ما بيتعدل.' }] }));
    draw('gate');
    await screen.findByText('ما ينفع تنفيذ هذا الطلب الآن:');
    expect(screen.getAllByText('المطلوب من الزبون:').length).toBe(1);
    expect(document.querySelectorAll('table').length).toBe(0);
    expect(screen.queryByText('الأسطر')).toBeNull();
  });
});

describe('Ⅴ · the screen does no arithmetic and prints no English', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/orders/LinesRequestReview.tsx'), 'utf8')
    // comments out, so the prose is not read as code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never adds, multiplies, rounds or formats a figure itself', () => {
    expect(source).not.toMatch(/toFixed|toLocaleString|Math\.|parseFloat|Number\(/);
    expect(source).not.toMatch(/\b(subtotal|cod|lineTotal|deliveryFee|quantity)\b\s*[*+/-]\s*\w/);
  });

  it('every sentence it draws is Arabic', async () => {
    serve(preview({ blocked: true, problems: [{ code: 'STOCK_SHORT_BLOCKED', blocking: true, messageAr: 'المخزون ما بيكفي لـكريم.' }] }));
    draw();
    await screen.findByText('الحساب');
    const words = (document.body.textContent ?? '').match(/[A-Za-z]{2,}/g) ?? [];
    expect(words).toEqual([]);
    expect(document.body.textContent).not.toMatch(/[٠-٩]/);
  });
});
