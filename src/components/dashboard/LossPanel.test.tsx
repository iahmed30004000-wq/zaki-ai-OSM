// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { summariseLoss } from '@/lib/loss-analysis';

/**
 * THE PANEL DRAWS WHAT THE READING FOUND — including what it did not find.
 *
 * `loss-analysis.test.ts` argues with the arithmetic and reads the panel's
 * source for its shape. This renders it, because the two failures that
 * matter here are failures of DRAWING, not of counting: a money figure
 * appearing on the half that spent none, and thirty-one lines of courier
 * prose where the panel should say «واحدٌ غيرُ مُصنَّف» and stop.
 */

const fetched = vi.hoisted(() => ({ body: null as unknown }));
vi.mock('@/lib/api-client', () => ({
  apiJson: async () => fetched.body,
  apiFetch: async () => new Response('{}'),
}));
// The panel prints money; the shell that supplies the currency is not here.
vi.mock('@/context/StoreCurrency', () => ({
  useStoreCurrency: () => ({ code: 'USD', minorUnit: 2 }),
}));

import { LossPanel } from './LossPanel';

afterEach(cleanup);

function give(rows: Parameters<typeof summariseLoss>[0]) {
  fetched.body = { ...summariseLoss(rows), period: 'all', scanned: 0, total: 0, truncated: false };
}

describe('the panel', () => {
  it('names the reason, whose fault it is, and what it cost', async () => {
    give([
      { field: 'deliveryFailureReason', reason: 'WRONG_ADDRESS', count: 3, money: 21 },
      { field: 'rejectionReason', reason: 'PRICE_TOO_HIGH', count: 5, money: 0 },
    ]);
    render(<LossPanel period="all" />);

    await waitFor(() => expect(screen.getByText('عنوان خاطئ')).toBeTruthy());
    expect(screen.getByText('السعر مرتفع')).toBeTruthy();
    expect(screen.getAllByText('بياناتٌ عندنا خاطئة').length).toBeGreaterThan(0);
    expect(screen.getByText('قرارُ العميل')).toBeTruthy();
  });

  /**
   * NO MONEY ON THE UN-SHIPPED HALF.
   *
   * Nothing was spent: no fee, no stock, no parcel. A currency figure there
   * would be the biggest number on the screen and the one nobody could
   * defend.
   */
  it('prints no figure on the half that spent nothing', async () => {
    give([{ field: 'rejectionReason', reason: 'PRICE_TOO_HIGH', count: 5, money: 0 }]);
    const { container } = render(<LossPanel period="all" />);

    await waitFor(() => expect(screen.getByText('السعر مرتفع')).toBeTruthy());
    expect(screen.getByText('قبل التأكيد')).toBeTruthy();
    // THE CELL, not the figure. Every row on this half is zero, so a money
    // column drawn here renders the «—» placeholder and no currency at all:
    // a first version of this assertion looked for «$» and passed with the
    // column switched on, and looking for «—» matched the prose instead.
    const row = container.querySelector('li');
    expect(row?.children.length, 'عمودُ المال مرسومٌ على نصفٍ لم يُنفق فيه شيء').toBe(3);
    expect(container.textContent).not.toMatch(/\$|USD/);
  });

  /** One row, with its count — not one row per courier sentence. */
  it('collapses the courier prose onto one row and says how many', async () => {
    give([
      { field: 'returnReason', reason: '14561 - تم الرفض قبل الوصول', count: 1, money: 4 },
      { field: 'returnReason', reason: '14926 - غير محافظة', count: 1, money: 4 },
      { field: 'returnReason', reason: 'رفض الاستلام بالكامل', count: 1, money: 6 },
    ]);
    render(<LossPanel period="all" />);

    await waitFor(() => expect(screen.getByText('سببٌ غيرُ مُصنَّف — نصٌّ حرّ')).toBeTruthy());
    expect(screen.queryByText(/14926/), 'جملةُ المندوب مرسومةٌ في الملخّص').toBeNull();
    expect(screen.getByText(/منها 3 بسببٍ غيرِ مُصنَّف/)).toBeTruthy();
  });

  /** The one line anybody can act on. */
  it('leads with what our own failures cost after shipping', async () => {
    give([
      { field: 'deliveryFailureReason', reason: 'WRONG_ADDRESS', count: 3, money: 21 },
      { field: 'returnReason', reason: 'CUSTOMER_REFUSED', count: 2, money: 9 },
    ]);
    render(<LossPanel period="all" />);

    await waitFor(() => expect(screen.getByText(/دُفعت على 3 شحنةً فشلت لسببٍ عندنا/)).toBeTruthy());
    expect(screen.getByText(/70% من كلفةِ ما فشل بعد الشحن/)).toBeTruthy();
  });

  /** And a customer saying no is not a failure of ours. */
  it('claims nothing when every loss was the customer\'s decision', async () => {
    give([{ field: 'returnReason', reason: 'CUSTOMER_REFUSED', count: 4, money: 18 }]);
    render(<LossPanel period="all" />);

    await waitFor(() => expect(screen.getByText('العميل رفض')).toBeTruthy());
    expect(screen.queryByText(/فشلت لسببٍ عندنا/), 'نسب قرارَ العميل إلينا').toBeNull();
  });

  it('says why it is empty instead of drawing a blank card', async () => {
    give([]);
    render(<LossPanel period="all" />);
    await waitFor(() => expect(screen.getByText('لا طلبَ خسرناه في هذه الفترة')).toBeTruthy());
  });
});

/**
 * «أُغلق بلا رد» — ONE ROW WITH THE TWO STORED CODES UNDER IT (the planner 15/11, answer 8). What is DRAWN merges; the payload the panel received (below, `give`) still holds two lines.
 * A company with only the older code — every company with the plan off — sees exactly the row it always saw.
 */
describe('the no-answer close, drawn as one row', () => {
  const rejectionHalf = (container: HTMLElement) => container.querySelector('section') as HTMLElement;

  it('both codes: one merged row with its sum, and the two codes’ own rows nested under it with their own labels and counts', async () => {
    give([
      { field: 'rejectionReason', reason: 'NO_ANSWER_3_ATTEMPTS', count: 6, money: 0 },
      { field: 'rejectionReason', reason: 'NO_ANSWER_5_ATTEMPTS', count: 4, money: 0 },
      { field: 'rejectionReason', reason: 'PRICE_TOO_HIGH', count: 5, money: 0 },
    ]);
    const { container } = render(<LossPanel period="all" />);
    await waitFor(() => expect(screen.getByText('أُغلق بلا رد')).toBeTruthy());

    const topLevel = [...rejectionHalf(container).querySelectorAll(':scope > ul > li')];
    const merged = topLevel.find((li) => li.textContent?.includes('أُغلق بلا رد'))!;
    // The merged row's own cells: the label, whose defect it is, and «10 · 66.67%» (10 of 15).
    expect(merged.querySelector(':scope > span')?.textContent).toBe('أُغلق بلا رد');
    expect(merged.textContent).toContain('لم نصل إليه في وقته');
    expect(merged.textContent).toContain('10 · 66.67%');
    // The two codes: nested, indented, each with its own words and count — and nowhere at the top level.
    const nested = merged.querySelector(':scope > ul')!;
    expect(nested.getAttribute('aria-label')).toBe('تفصيل «أُغلق بلا رد»');
    expect([...nested.querySelectorAll(':scope > li')].map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^أُغلق بعد ثلاث محاولات بلا ردّ6 · 40%$/),
      expect.stringMatching(/^أُغلق بعد خمس محاولات بلا ردّ4 · 26.67%$/),
    ]);
    expect(nested.className).toMatch(/ps-5/);
    for (const li of topLevel) {
      if (li !== merged) expect(li.textContent, 'a code drawn on its own as well').not.toMatch(/ثلاث محاولات|خمس محاولات/);
    }
    expect(screen.getByText('السعر مرتفع')).toBeTruthy();
  });

  it('only the older code (the plan off): today’s single row — its own label, three cells, no merged label, nothing nested', async () => {
    give([
      { field: 'rejectionReason', reason: 'NO_ANSWER_3_ATTEMPTS', count: 7, money: 0 },
      { field: 'rejectionReason', reason: 'PRICE_TOO_HIGH', count: 3, money: 0 },
    ]);
    const { container } = render(<LossPanel period="all" />);
    await waitFor(() => expect(screen.getByText('أُغلق بعد ثلاث محاولات بلا ردّ')).toBeTruthy());

    expect(screen.queryByText('أُغلق بلا رد')).toBeNull();
    expect(container.querySelector('ul ul')).toBeNull();
    const row = [...container.querySelectorAll('li')].find((li) => li.textContent?.includes('ثلاث محاولات'))!;
    expect(row.children.length, 'the row’s cells: label, fault, count — as before').toBe(3);
    expect(row.textContent).toBe('أُغلق بعد ثلاث محاولات بلا ردّلم نصل إليه في وقته7 · 70%');
  });

  it('only the new code: its own row too, with nothing to merge with', async () => {
    give([{ field: 'rejectionReason', reason: 'NO_ANSWER_5_ATTEMPTS', count: 2, money: 0 }]);
    const { container } = render(<LossPanel period="all" />);
    await waitFor(() => expect(screen.getByText('أُغلق بعد خمس محاولات بلا ردّ')).toBeTruthy());
    expect(screen.queryByText('أُغلق بلا رد')).toBeNull();
    expect(container.querySelector('ul ul')).toBeNull();
  });
});
