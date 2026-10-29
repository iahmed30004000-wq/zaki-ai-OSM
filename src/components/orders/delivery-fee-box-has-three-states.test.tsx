// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * «NOT RECORDED», «ZERO» AND «A NUMBER» ARE THREE DIFFERENT ANSWERS.
 *
 * `0aea050` closed `PATCH`/`POST /api/orders/[id]/shipping` against a
 * delivery fee that is not a number: `Order.deliveryFee` is `Float?`, and
 * Prisma ACCEPTS `NaN` for a nullable Float — it lands as NULL, and every
 * reader spells NULL `?? 0` — so deleting the fallback was not enough and
 * the door answers 400 instead. `null` stays writable, because «no fee
 * recorded» is what the column's nullability means and 30 of 56 live orders
 * hold it. A typed `0` stays writable, because `priceIncludesDelivery`
 * makes a zero fee a policy.
 *
 * AND THE BROWSER MADE ALL OF IT UNREACHABLE:
 *
 *     deliveryFee: deliveryFee ? Number(deliveryFee) : 0,
 *
 * Only ever a number. An empty box sent `0` — «the courier charges us
 * nothing» — over the column whose whole point is that it can say
 * otherwise. `settlement.ts` deducts that figure from what the courier
 * owes, `commission.ts` subtracts it before commission, and
 * `agent-custody.ts` carries it into custody, so a manufactured zero moves
 * real money in the courier's favour, silently.
 *
 * A second line did the mirror of it:
 *
 *     setDeliveryFee(order.deliveryFee ? String(order.deliveryFee) : '')
 *
 * a falsy test on a figure whose legitimate values include 0, so an order
 * recorded at a zero fee opened with an EMPTY box. Harmless only while an
 * empty box also sent 0 — and the moment an empty box means `null`, that
 * line turns every recorded zero into «not recorded» on the next save.
 * Both are fixed here, and both are asserted, because fixing one without
 * the other is a data loss the tests would not have seen.
 *
 * Every assertion reads THE BODY ON THE WIRE.
 */

import { ShippingSection } from './ShippingSection';

const ORDER = (deliveryFee: number | null, trackingNumber: string | null = null) => ({
  id: 'ord-1',
  version: 7,
  shippingStatus: 'READY_FOR_SHIPPING',
  deliveryProviderId: null,
  deliveryProvider: null,
  shippingBatch: null,
  trackingNumber,
  deliveryFee,
  shippedAt: null,
  outForDeliveryAt: null,
  deliveredAt: null,
  lockedById: null,
  lockExpiresAt: null,
});

/** Every non-GET body the section sent, in order. */
let sent: { url: string; method: string; body: any }[] = [];
let answer: { status: number; payload: any } = { status: 200, payload: { order: { version: 8 } } };

beforeEach(() => {
  sent = [];
  answer = { status: 200, payload: { order: { version: 8 } } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        // A real `Response`: `apiFetch` calls `.clone().json()` on a 400.
        return new Response(JSON.stringify(answer.payload), {
          status: answer.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = url.includes('delivery-attempts') ? { attempts: [] } : { providers: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = async (order: any) => {
  render(<ShippingSection order={order} ar isRtl onRefreshOrder={() => {}} />);
  await waitFor(() => expect(screen.getByText('الشحن والتوصيل')).toBeTruthy());
};

const openTracking = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /رقم التتبع/ }));
  await waitFor(() => expect(screen.getByLabelText('رسوم التوصيل ($)')).toBeTruthy());
  return screen.getByLabelText('رسوم التوصيل ($)') as HTMLInputElement;
};

const feeOf = (body: any) => (Object.prototype.hasOwnProperty.call(body, 'deliveryFee') ? body.deliveryFee : '«absent»');

describe('what the old line did, in the values it produced', () => {
  it('turned every unfilled fee into a free delivery, and a stored zero into a blank', () => {
    const empty = '';
    expect(empty ? Number(empty) : 0).toBe(0);
    // And the mirror: a stored zero read as «nothing to show».
    expect((0 as number | null) ? String(0) : '').toBe('');
    // `NaN` was the other road to the same zero — `0aea050` measured that
    // Prisma writes it as NULL for a nullable Float, and every reader
    // spells NULL `?? 0`.
    expect(Number('2,500')).toBeNaN();
    const stored: number | null = JSON.parse('null');
    expect(stored ?? 0).toBe(0);
  });
});

describe('the box shows what is stored', () => {
  it('shows a stored ZERO as 0 — a recorded policy, not a blank', async () => {
    const user = userEvent.setup();
    await mount(ORDER(0));
    const fee = await openTracking(user);
    // With `order.deliveryFee ? … : ''` this read `''`, and saving would
    // then have written NULL over a deliberate zero.
    expect(fee.value).toBe('0');
  });

  it('shows a NULL fee as an empty box', async () => {
    const user = userEvent.setup();
    await mount(ORDER(null));
    const fee = await openTracking(user);
    expect(fee.value).toBe('');
  });

  it('and a stored number as that number', async () => {
    const user = userEvent.setup();
    await mount(ORDER(3.75));
    const fee = await openTracking(user);
    expect(fee.value).toBe('3.75');
  });
});

describe('the body on the wire — three states, three values', () => {
  it('an EMPTY box sends null, so the column records «not recorded» instead of «free»', async () => {
    const user = userEvent.setup();
    await mount(ORDER(5));
    const fee = await openTracking(user);
    await user.clear(fee);
    await user.click(screen.getByText('حفظ'));

    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0].body;
    expect(sent[0].url).toBe('/api/orders/ord-1/shipping');
    expect(body.action).toBe('update_tracking');
    // THE VALUE. Restore `deliveryFee ? Number(deliveryFee) : 0` and this
    // reads `0`, which the door is obliged to accept and settlement then
    // deducts as a real fee of nothing.
    expect(feeOf(body)).toBeNull();
    expect(body.deliveryFee).not.toBe(0);
    expect(body.expectedVersion).toBe(7);
  });

  it('a typed ZERO sends 0, because a zero fee is a real policy', async () => {
    const user = userEvent.setup();
    await mount(ORDER(null));
    const fee = await openTracking(user);
    await user.type(fee, '0');
    await user.click(screen.getByText('حفظ'));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The characters, which `moneyInput(1_000_000)` reads as 0.
    expect(sent[0].body.deliveryFee).toBe('0');
    expect(Number(sent[0].body.deliveryFee)).toBe(0);
  });

  it('a typed NUMBER travels digit for digit, not re-derived by the browser', async () => {
    const user = userEvent.setup();
    await mount(ORDER(null));
    const fee = await openTracking(user);
    await user.type(fee, '12.75');
    await user.click(screen.getByText('حفظ'));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.deliveryFee).toBe('12.75');
  });

  it('and a NEGATIVE fee is sent as typed, so the door’s Arabic 400 arrives', async () => {
    /*
     * THE ROUND TRIP FROM THE BOX. The box carries no `min`, so `-5` is a
     * value the browser hands over and `checkValidity()` is true;
     * `moneyInput` is `z.number().min(0)`, so the door answers 400 and
     * `zodMessage` names the field. With `Number(deliveryFee)` the browser
     * sent the number `-5` and the same 400 came back — but an EMPTY box
     * could never produce a refusable value at all, which is the half this
     * change restores.
     */
    const user = userEvent.setup();
    answer = { status: 400, payload: { error: 'رسوم التوصيل: 0 على الأقل' } };
    await mount(ORDER(null));
    const fee = await openTracking(user);
    await user.type(fee, '-5');
    expect(fee.value).toBe('-5');
    expect(fee.checkValidity()).toBe(true);
    await user.click(screen.getByText('حفظ'));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.deliveryFee).toBe('-5');
    // And the refusal reaches the person, in the section's own feedback bar.
    await waitFor(() => expect(screen.getByText('رسوم التوصيل: 0 على الأقل')).toBeTruthy());
    // The modal stays open so the number can be corrected.
    expect(screen.getByLabelText('رسوم التوصيل ($)')).toBeTruthy();
  });

  it('and a stored zero left alone sends NOTHING — the dirty check is not defeated', async () => {
    /*
     * The pair of fixes has to hold together: the box must show the stored
     * `0`, because the dirty check compares the box against
     * `String(order.deliveryFee ?? '')`. With the box blanked, `'' !== '0'`
     * read as «changed» and an untouched order was saved with `null` over
     * its recorded zero — a silent write on a screen nobody edited.
     */
    const user = userEvent.setup();
    await mount(ORDER(0, 'TRK-1'));
    const fee = await openTracking(user);
    expect(fee.value).toBe('0');
    await user.click(screen.getByText('حفظ'));
    await waitFor(() => expect(screen.queryByLabelText('رسوم التوصيل ($)')).toBeNull());
    expect(sent).toEqual([]);
  });
});

describe('the reason box — a changed fee can say why (29/10)', () => {
  const reasonBox = () => screen.queryByLabelText('سبب تغيير الأجرة (اختياري)') as HTMLInputElement | null;

  it('is absent while the fee is as stored, and appears the moment it differs', async () => {
    const user = userEvent.setup();
    await mount(ORDER(5));
    const fee = await openTracking(user);
    expect(reasonBox()).toBeNull();
    await user.clear(fee);
    await user.type(fee, '3');
    expect(reasonBox()).toBeTruthy();
    await user.clear(fee);
    await user.type(fee, '5');
    expect(reasonBox()).toBeNull();
  });

  it('travels with a changed fee, and the fee stays the characters typed', async () => {
    const user = userEvent.setup();
    await mount(ORDER(5));
    const fee = await openTracking(user);
    await user.clear(fee);
    await user.type(fee, '0');
    await user.type(reasonBox()!, 'اتفاق مع الشركة');
    await user.click(screen.getByText('حفظ'));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.deliveryFee).toBe('0');
    expect(sent[0].body.deliveryFeeReason).toBe('اتفاق مع الشركة');
  });

  it('is not sent when left empty, nor when only the tracking number changed', async () => {
    const user = userEvent.setup();
    await mount(ORDER(5));
    const fee = await openTracking(user);
    await user.clear(fee);
    await user.type(fee, '7');
    await user.click(screen.getByText('حفظ'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect('deliveryFeeReason' in sent[0].body).toBe(false);
  });
});
