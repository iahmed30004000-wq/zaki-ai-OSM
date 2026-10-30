// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «الخصم على الطلب» RESPONDS — THE CARD SHOWS «بعد الخصم» WHILE THE BOXES ARE BEING TYPED.
 *
 * DEFINITION OF DONE for the screen half of the work:
 *   · typing in the discount box shows, at once, the goods after the discount — and, with more than one line, the
 *     share each line carries — in the figures the server will write (`order-discount-preview.ts` hands the boxes to
 *     `computeCod`; the real door is held equal in `the-discount-answers.test.ts`);
 *   · the same figure follows a price box and a quantity;
 *   · a discount bigger than the goods is said under the box and LOCKS حفظ — no request goes out;
 *   · a box the door would refuse (below zero) is said too, and locks it;
 *   · the rule is written once, in plain words, under the two boxes;
 *   · the save still sends the discount ONCE, and the lines as the boxes hold them;
 *   · after confirmation the same figure shows and the same lock holds, and the path is still a request;
 *   · on a phone the block is there, the boxes are still 44 points tall and nothing is drawn twice.
 *
 * Every figure is worked by hand beside the assertion (JOD, three places).
 */

const { apiFetch, apiJson, ask } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn(), ask: vi.fn() }));
const phone = vi.hoisted(() => ({ value: false }));

vi.mock('@/lib/api-client', () => ({ apiFetch, apiJson }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => ask }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span data-testid="thumb" /> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { OrderLinesCard } from './OrderLinesCard';

const CURRENCY = { code: 'JOD', minorUnit: 3 };

const A = {
  id: 'i1', productId: 'p1', productName: 'كريم', quantity: 3, freeQuantity: 0,
  unitPrice: '12' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '36' as unknown as number, beforeDiscount: 36,
};
const B = {
  id: 'i2', productId: 'p2', productName: 'صابون', quantity: 2, freeQuantity: 0,
  unitPrice: '5' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '10' as unknown as number, beforeDiscount: 10,
};
type Line = typeof A;

function draw(items: Line[] = [A, B], over: Record<string, unknown> = {}) {
  return render(
    <OrderLinesCard
      order={{
        id: 'o1', version: 7, confirmationStatus: 'NEW', totalAmount: 48.5, quantity: 5, sellingPrice: 46,
        discountAmount: 0, deliveryFee: 2.5, priceIncludesDelivery: false, internalNotes: null, customerNotes: null,
        items, product: { name: 'كريم', image: null }, productNameSnapshot: 'كريم', productImageSnapshot: null, offer: null,
        deliveryProvider: { id: 'dp1', name: 'شركة' }, ...over,
      }}
      currency={CURRENCY}
      canEdit
      onAcquireLock={() => {}}
      onSaved={() => {}}
    />
  );
}

const discountBox = () => screen.getByLabelText('الخصم على الطلب') as HTMLInputElement;
const priceBoxes = () => screen.getAllByPlaceholderText('سعر السطر') as HTMLInputElement[];
const saveButton = () => screen.getByRole('button', { name: /حفظ بيانات الطلب/ }) as HTMLButtonElement;
/** The live line, as a person reads it: «بعد الخصم: 41.400 JOD». */
const after = () => (screen.getByText(/بعد الخصم/) as HTMLElement).textContent ?? '';
const shares = () => screen.queryAllByText(/من الخصم/).map((e) => e.textContent ?? '');

async function open() {
  await userEvent.click(screen.getByRole('button', { name: /تعديل/ }));
  await waitFor(() => expect(priceBoxes().length).toBeGreaterThan(0));
}
async function typeDiscount(text: string) {
  await userEvent.clear(discountBox());
  if (text !== '') await userEvent.type(discountBox(), text);
}
async function typePrice(index: number, text: string) {
  await userEvent.clear(priceBoxes()[index]);
  await userEvent.type(priceBoxes()[index], text);
}

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  apiJson.mockResolvedValue({ products: [] });
  apiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  ask.mockResolvedValue(null);
});
afterEach(cleanup);

describe('Ⅰ · typing the discount shows the goods after it, at once', () => {
  it('opens on the goods as they stand: 46.000, nothing off', async () => {
    draw();
    await open();
    expect(after()).toContain('46.000 JOD');
    expect(shares(), 'ما في خصم، ما في حصص').toEqual([]);
  });

  it('4.6 typed: 41.400 after it, and the shares 3.600 and 1.000 on the two lines', async () => {
    draw();
    await open();
    await typeDiscount('4.6');
    // 36/46 × 4.6 = 3.6 and 10/46 × 4.6 = 1.0
    expect(after()).toContain('41.400 JOD');
    const said = shares();
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('3.600 JOD');
    expect(said[1]).toContain('1.000 JOD');
  });

  it('follows each keystroke — 4, then 4.6, then 46 — and never lags a key behind', async () => {
    draw();
    await open();
    await userEvent.clear(discountBox());
    await userEvent.type(discountBox(), '4');
    expect(after()).toContain('42.000 JOD');
    await userEvent.type(discountBox(), '.6');
    expect(after()).toContain('41.400 JOD');
    await typeDiscount('46');
    expect(after()).toContain('0.000 JOD');
  });

  it('a price box moves it: كريم 60 instead of 36 with the same 4.6 — 65.400 after, shares 3.943 and 0.657', async () => {
    draw();
    await open();
    await typeDiscount('4.6');
    await typePrice(0, '60');
    // 70 − 4.6; 60/70 × 4.6 = 3.943 and 10/70 × 4.6 = 0.657
    expect(after()).toContain('65.400 JOD');
    expect(shares()[0]).toContain('3.943 JOD');
    expect(shares()[1]).toContain('0.657 JOD');
  });

  it('a quantity moves nothing it should not: a price already written stays, and so does «بعد الخصم»', async () => {
    draw();
    await open();
    await typeDiscount('4.6');
    await userEvent.click(screen.getAllByRole('button', { name: 'زد الكمية' })[0]);
    // the price box holds a saved total — a quantity never rewrites it
    expect(priceBoxes()[0].value).toBe('36');
    expect(after()).toContain('41.400 JOD');
  });

  it('an emptied discount box is no discount: the goods stand', async () => {
    draw();
    await open();
    await typeDiscount('4.6');
    await typeDiscount('');
    expect(after()).toContain('46.000 JOD');
  });

  it('a price box emptied leaves nothing true to show — a dash, not a confident figure', async () => {
    draw();
    await open();
    await userEvent.clear(priceBoxes()[0]);
    expect(after()).toContain('—');
    expect(after()).not.toContain('JOD');
  });

  it('a single line names no shares — there is only one place for the discount to go', async () => {
    draw([A], { quantity: 3, sellingPrice: 36 });
    await open();
    await typeDiscount('6');
    expect(after()).toContain('30.000 JOD');
    expect(shares()).toEqual([]);
  });
});

describe('Ⅱ · one rule, said in the open', () => {
  it('«سعر كل سطر قبل الخصم؛ الخصم مرة واحدة على مجموع الطلب» sits under the two boxes', async () => {
    draw();
    await open();
    expect(screen.getByText('سعر كل سطر قبل الخصم؛ الخصم مرة واحدة على مجموع الطلب.')).toBeTruthy();
    // and the old sentence, which promised a spread «عند الحفظ» and showed none of it, is gone
    expect(screen.queryByText(/يُوزَّع على الأسطر عند الحفظ/)).toBeNull();
  });
});

describe('Ⅲ · a discount the door would refuse is said before the press, and locks it', () => {
  it('47 off 46: the message names the goods (46.000), حفظ is locked, and a press sends nothing', async () => {
    draw();
    await open();
    await typeDiscount('47');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('الخصم أكبر من قيمة البضاعة');
    expect(alert.textContent).toContain('46.000 JOD');
    expect(saveButton().disabled).toBe(true);
    await userEvent.click(saveButton());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('and taking it down to 46 unlocks it: all of it off is a figure the door takes', async () => {
    draw();
    await open();
    await typeDiscount('47');
    expect(saveButton().disabled).toBe(true);
    await typeDiscount('46');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    expect(after()).toContain('0.000 JOD');
  });

  it('a line made dearer lifts the ceiling — the message follows the goods, not a stored figure', async () => {
    draw();
    await open();
    await typeDiscount('47');
    expect(saveButton().disabled).toBe(true);
    await typePrice(0, '40');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('below zero: «اكتب خصماً صحيحاً», locked', async () => {
    draw();
    await open();
    await typeDiscount('-5');
    expect(screen.getByRole('alert').textContent).toContain('اكتب خصماً صحيحاً');
    expect(saveButton().disabled).toBe(true);
  });

  it('and there is no alert at all while the figure is fine', async () => {
    draw();
    await open();
    await typeDiscount('10');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

describe('Ⅳ · the save sends the discount once, beside the lines as the boxes hold them', () => {
  it('4.6 and صابون at 14: the body is the boxes’ characters and the one discount', async () => {
    draw();
    await open();
    await typeDiscount('4.6');
    await typePrice(1, '14');
    await userEvent.click(saveButton());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.discountAmount).toBe(4.6);
    expect(body.items.map((l: { unitPrice: string }) => l.unitPrice)).toEqual(['36', '14']);
    expect(body.expectedVersion).toBe(7);
  });
});

describe('Ⅴ · after confirmation: the same figure, the same lock — and still a request', () => {
  const CONFIRMED = { confirmationStatus: 'CONFIRMED' };

  it('shows «بعد الخصم» and locks an excessive discount, with the old wording of the path untouched', async () => {
    draw([A, B], CONFIRMED);
    await open();
    await typeDiscount('10');
    expect(after()).toContain('36.000 JOD');
    await typeDiscount('50');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('46.000 JOD');
  });

  it('a discount alone raises ONE request carrying only the discount (the lines are not part of it)', async () => {
    ask.mockResolvedValue('الزبون طلب خصم');
    // the catalogue read answers as before; the request door answers «queued, not applied»
    apiJson.mockImplementation(async (url: string) =>
      /change-requests/.test(String(url)) ? { request: { id: 'r1' }, readyToApply: false } : { products: [] }
    );
    draw([A, B], CONFIRMED);
    await open();
    await typeDiscount('10');
    await userEvent.click(saveButton());
    await waitFor(() => expect(apiJson.mock.calls.some((c) => /change-requests/.test(String(c[0])))).toBe(true));
    const raised = apiJson.mock.calls.filter((c) => /change-requests/.test(String(c[0])));
    expect(raised).toHaveLength(1);
    const sent = JSON.parse((raised[0][1] as { body: string }).body);
    expect(sent.changes).toEqual({ discountAmount: { to: 10 } });
    expect(apiFetch, 'ما انحفظ مباشرة').not.toHaveBeenCalled();
  });
});

describe('Ⅵ · on a phone', () => {
  it('the block is there once, the discount box is 44 points tall, and the save button keeps its 44', async () => {
    phone.value = true;
    draw();
    await open();
    await typeDiscount('4.6');
    expect(screen.getAllByText(/بعد الخصم/)).toHaveLength(1);
    expect(after()).toContain('41.400 JOD');
    expect(discountBox().className).toMatch(/\bh-11\b/);
    expect(saveButton().className).toMatch(/\bmin-h-11\b/);
    // the two boxes share one rule line, not two
    expect(screen.getAllByText('سعر كل سطر قبل الخصم؛ الخصم مرة واحدة على مجموع الطلب.')).toHaveLength(1);
  });
});
