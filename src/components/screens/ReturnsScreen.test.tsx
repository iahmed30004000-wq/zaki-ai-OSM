// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE RETURNS DESK READS WHAT THE DOOR WROTE.
 *
 *   «استلم جزءي: شو المنتج الي استلمو وكم قطعة وشو الي رجع»
 *   «إذا الأوردر فيه أكثر من كمية واستلم أو رفض قطعة، حط إجراء إضافي مثل:
 *    هل الطلب استلم؟ نعم / لا»
 *
 * The clerk has the box open in front of them, so the line list is the
 * figure they believe — and it used to print every line at its full shipped
 * quantity, «ماء الكمأ × 3» for a parcel where the customer kept two. The
 * total in the row behind the dialog said 1. Two numbers about one parcel,
 * and the wrong one was the louder.
 *
 * These render the dialog because that is the only place the fault was
 * visible: every figure involved was already correct in the database.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
// A camera is not a thing jsdom has, and this test is not about scanning.
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => <button type="button">امسح</button> }));

import { ReturnsScreen } from './ReturnsScreen';

/** Three units went out, the customer kept two, one is coming back. */
const PARTIAL_ROW = {
  id: 'o1',
  orderNumber: 'SY-2026-0148',
  merchantRef: null,
  trackingNumber: 'TRK-1',
  shippingStatus: 'PARTIALLY_DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  returnReason: null,
  expectedQty: 1,
  customer: { fullName: 'سارة' },
  region: { name: 'دمشق' },
  deliveryProvider: { name: 'ناقل' },
  lines: [
    { itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: 2, expectedBack: 1 },
  ],
  completion: {
    halves: [
      { key: 'MONEY', label: 'تحصيل مال ما استلمه العميل', settled: false, units: 2 },
      { key: 'GOODS', label: 'استلام الراجع وعدّه في المستودع', settled: false, units: 1 },
    ],
    settledCount: 0,
    degree: 'NONE',
    complete: false,
    awaiting: ['MONEY', 'GOODS'],
    label: 'تمّ 0 من 2 — بانتظار تحصيل مال ما استلمه العميل و استلام الراجع وعدّه في المستودع',
  },
  action: {
    key: 'GOODS',
    question: 'هل رجعت القطع المرفوضة إلى المستودع؟',
    yes: 'نعم — عددتها واستلمتها',
    no: 'لا — لم تصل بعد',
  },
};

/** An announced return: the door never spoke, the whole parcel is due back. */
const WHOLE_ROW = {
  ...PARTIAL_ROW,
  id: 'o2',
  shippingStatus: 'RETURN_REQUESTED',
  expectedQty: 3,
  lines: [{ itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: null, expectedBack: 3 }],
  completion: {
    halves: [{ key: 'GOODS', label: 'استلام الراجع وعدّه في المستودع', settled: false, units: 3 }],
    settledCount: 0,
    degree: 'NONE',
    complete: false,
    awaiting: ['GOODS'],
    label: 'تمّ 0 من 1 — بانتظار استلام الراجع وعدّه في المستودع',
  },
  action: null,
};

/** The door's whole answer — the rows, the page they are on, the numbers beside the filters, the view they belong to. */
const answer = (rows: unknown[]) => ({
  count: rows.length,
  orders: rows,
  pagination: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    views: { pending: rows.length, received: 0 },
    statuses: { RETURN_REQUESTED: 0, RETURNED: 0, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 0 },
    couriers: [],
    ages: { fresh: 0, few: 0, week: 0, old: 0 },
  },
  applied: { view: 'pending', status: null, courier: null, age: null, q: null },
});

const openDialog = async (row: unknown) => {
  apiJson.mockResolvedValue(answer([row]));
  render(<ReturnsScreen />);
  // The first test of the file pays for the first render, and the default 1 s of `waitFor` is too short under a parallel
  // full run (RV103). The wait is longer; what is asserted is not.
  const receive = await waitFor(() => screen.getAllByRole('button', { name: 'استلام' })[0], { timeout: 4000 });
  await userEvent.click(receive);
  return screen.getByText('استلام مرتجع');
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('what came back, per product', () => {
  it('shows the units taken at the door beside the units due back', async () => {
    await openDialog(PARTIAL_ROW);
    const row = screen.getByText('ماء الكمأ').closest('div')!.parentElement!;
    // Shipped 3, kept 2, coming back 1 — all three, in one line, in Western
    // digits. The old list printed only «3».
    expect(row.textContent).toContain('3');
    expect(row.textContent).toContain('2');
    expect(row.textContent).toContain('1');
  });

  it('prints a dash, not a zero, where the door never spoke', async () => {
    // «0 delivered» is a statement that the customer refused it. An announced
    // return is not that statement.
    await openDialog(WHOLE_ROW);
    // Scoped to the dialog's own line: the list behind it prints a dash for
    // every empty column, so an unscoped search finds those instead.
    const row = screen.getAllByText('ماء الكمأ')[0].closest('div')!.parentElement!;
    expect(row.textContent).toContain('—');
  });

  it('names the two settlements and says the order will not close on one', async () => {
    await openDialog(PARTIAL_ROW);
    expect(screen.getByText(/يُتَمَّم مرتين/)).toBeTruthy();
    expect(screen.getByText(/تحصيل مال ما استلمه العميل/)).toBeTruthy();
  });

  it('does not claim two settlements on a parcel that only has one', async () => {
    await openDialog(WHOLE_ROW);
    expect(screen.queryByText(/يُتَمَّم مرتين/)).toBeNull();
  });
});

describe('nothing in the dialog draws white', () => {
  /**
   * «إذا كانت بيضا فتكون أزرق». Asserted on what RENDERS, not on the source:
   * the source guard in returns-dialog-fields.test.ts proves the shared
   * `Input` is used, and this proves the token survives to the DOM.
   *
   * A control with no background of its own is painted by the browser, and
   * that is what «بيضا» was. The scheme half is answered at the root now —
   * `color-scheme` per palette, guarded in system-themes.test.ts — and this
   * still asserts the token, because the card's own colour is not the user
   * agent's to supply.
   */
  const themed = (el: Element) =>
    el.className.includes('bg-[var(--sys-card)]') || el.className.includes('accent-[var(--sys-primary)]');

  it('every field names a system background, tick boxes included', async () => {
    await openDialog(PARTIAL_ROW);
    await userEvent.click(screen.getByRole('button', { name: 'نعم — عددتها واستلمتها' }));
    const fields = [...document.querySelectorAll('[role="dialog"] input')];
    expect(fields.length).toBeGreaterThan(3);
    expect(fields.filter((f) => !themed(f)).map((f) => f.getAttribute('type') ?? 'text')).toEqual([]);
  });

  it('and every field carries the focus ring the owner asked for', async () => {
    await openDialog(PARTIAL_ROW);
    await userEvent.click(screen.getByRole('button', { name: 'نعم — عددتها واستلمتها' }));
    // system.css paints `:focus-visible` only — a keyboard signal, by
    // design. A TAPPED box showed nothing at all until the shared field
    // brought `focus:ring-[var(--sys-primary)]/25`.
    const typed = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')].filter(
      (f) => f.type !== 'checkbox'
    );
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.every((f) => f.className.includes('focus:ring-[var(--sys-primary)]/25'))).toBe(true);
  });

  it('keeps the three counted boxes on one height', async () => {
    // Two inputs and a computed figure in one row. The computed one had a
    // flat `h-10` and a label at `mb-1` while the fields had `h-11 md:h-10`
    // and `mb-1.5`, so the row stood at three heights on a phone.
    await openDialog(PARTIAL_ROW);
    await userEvent.click(screen.getByRole('button', { name: 'نعم — عددتها واستلمتها' }));
    const missing = screen.getByText('ناقص (محسوب)');
    expect(missing.className).toContain('mb-1.5');
    expect(missing.className).toContain('text-[var(--sys-heading)]');
    expect(missing.nextElementSibling!.className).toContain('h-11');
    expect(missing.nextElementSibling!.className).toContain('md:h-10');
  });
});

describe('the extra action gates the count', () => {
  it('asks «هل الطلب استلم؟» before offering anything to count', async () => {
    await openDialog(PARTIAL_ROW);
    expect(screen.getByText('هل رجعت القطع المرفوضة إلى المستودع؟')).toBeTruthy();
    // Nothing to fill in and nothing to confirm until it is answered: a
    // pre-filled count answers the question with the commonest wrong answer.
    expect(screen.queryByText('سليم')).toBeNull();
    expect(screen.queryByRole('button', { name: 'تأكيد الاستلام' })).toBeNull();
  });

  it('opens the count on «نعم»', async () => {
    await openDialog(PARTIAL_ROW);
    await userEvent.click(screen.getByRole('button', { name: 'نعم — عددتها واستلمتها' }));
    expect(screen.getByText('سليم')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تأكيد الاستلام' })).toBeTruthy();
  });

  it('records nothing on «لا», and says the order stays open', async () => {
    await openDialog(PARTIAL_ROW);
    apiJson.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'لا — لم تصل بعد' }));
    expect(screen.getByText(/لا يُسجَّل استلام/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تأكيد الاستلام' })).toBeNull();
    expect(apiJson).not.toHaveBeenCalled();
  });

  it('is not asked of a parcel the door never split — that flow is unchanged', async () => {
    await openDialog(WHOLE_ROW);
    expect(screen.queryByText(/هل رجعت القطع/)).toBeNull();
    // Straight to the count, as it always was.
    expect(screen.getByText('سليم')).toBeTruthy();
  });
});

describe('the reason column speaks Arabic', () => {
  it('prints the Arabic label of a return reason, never the code', async () => {
    apiJson.mockResolvedValue(answer([{ ...PARTIAL_ROW, returnReason: 'CUSTOMER_REFUSED' }]));
    render(<ReturnsScreen />);
    await waitFor(() => screen.getAllByText('العميل رفض'));
    expect(screen.queryByText('CUSTOMER_REFUSED')).toBeNull();
  });

  it('and a code nobody labelled reads «أخرى», not the raw code', async () => {
    apiJson.mockResolvedValue(answer([{ ...PARTIAL_ROW, returnReason: 'SOME_NEW_CODE' }]));
    render(<ReturnsScreen />);
    await waitFor(() => screen.getAllByText('أخرى'));
    expect(screen.queryByText('SOME_NEW_CODE')).toBeNull();
  });
});

describe('a reason somebody wrote is shown as written', () => {
  it('shows a free Arabic sentence untouched, not «أخرى»', async () => {
    apiJson.mockResolvedValue(answer([{ ...PARTIAL_ROW, returnReason: 'أُغلق كخسارة — لم تُستلم البضاعة. ضاعت في الطريق' }]));
    render(<ReturnsScreen />);
    await waitFor(() => screen.getAllByText('أُغلق كخسارة — لم تُستلم البضاعة. ضاعت في الطريق'));
    expect(screen.queryByText('أخرى')).toBeNull();
  });
});
