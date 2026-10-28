// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { CheckoutField } from '@/lib/store-theme';

/**
 * THE STORE'S OWN CHECKOUT, AND ITS «الدفع».
 *
 * «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — the owner, 28/10. The cart's checkout
 * is one of the public forms that follow it: a field the shop hid is neither drawn nor sent, a required one left
 * blank is asked for under its field before anything is sent (and refused by the door anyway), a refusal about a
 * field this page does not draw says to reload, and the button wears the shop's colour.
 */

const { trackEvent, push, shopFetch, clear } = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  push: vi.fn(),
  shopFetch: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({ useTracking: () => ({ trackEvent }) }));
vi.mock('@/lib/storefront-fetch', () => ({ shopFetch: (...a: unknown[]) => shopFetch(...a) }));
vi.mock('./useCart', () => ({
  useCart: () => ({
    ready: true,
    pricing: false,
    lines: [{ productId: 'p1', quantity: 1 }],
    quote: { lines: [], subtotal: 25, cod: 25, currency: 'USD', pieces: 1 },
    clear,
  }),
}));

import { CheckoutForm } from './CheckoutForm';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const EVERY: CheckoutField[] = ['name', 'phone', 'altPhone', 'region', 'address', 'note'];
const FOUR: CheckoutField[] = ['name', 'phone', 'region', 'address'];

const answer = (ok: boolean, body: unknown) => shopFetch.mockResolvedValue({ ok, json: async () => body });
const draw = (props: Partial<React.ComponentProps<typeof CheckoutForm>> = {}) =>
  render(
    <CheckoutForm
      slug="sehha" minorUnit={2} fields={EVERY} required={FOUR} regions={['دمشق']} submitText="أرسل الطلب" {...props}
    />
  );
const box = (field: CheckoutField) => document.getElementById(`co-${field}`) as HTMLInputElement | null;
const type = (field: CheckoutField, value: string) => fireEvent.change(box(field)!, { target: { value } });
function fillFour() {
  type('name', 'سلمى الأحمد');
  type('phone', '0999999999');
  type('region', 'دمشق');
  type('address', 'شارع بغداد، قرب الجامع');
}
const press = () => fireEvent.click(screen.getByRole('button', { name: 'أرسل الطلب' }));
const sentBody = () => JSON.parse(String(shopFetch.mock.calls[0][1].body));
const REFRESH = 'صار في خانة مطلوبة جديدة — حدّث الصفحة وعيد الطلب';

describe('a field the shop hid', () => {
  it('is not drawn and not sent', async () => {
    answer(true, { orderNumber: 'SY-0700', total: 25, currency: 'USD' });
    draw({ fields: FOUR });
    expect(box('altPhone')).toBeNull();
    expect(box('note')).toBeNull();
    fillFour();
    press();
    await waitFor(() => expect(shopFetch).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(['address', 'city', 'full_name', 'items', 'phone']);
  });

  it('NEGATIVE: shown, it is drawn and what is typed in it is sent', async () => {
    answer(true, { orderNumber: 'SY-0701', total: 25, currency: 'USD' });
    draw();
    fillFour();
    type('altPhone', '0933111222');
    press();
    await waitFor(() => expect(shopFetch).toHaveBeenCalledTimes(1));
    expect(sentBody().alt_phone).toBe('0933111222');
  });
});

describe('a required second number or note, left blank', () => {
  it('is asked for under its field, and nothing is sent or reported', async () => {
    draw({ required: [...FOUR, 'altPhone', 'note'] });
    fillFour();
    type('note', '   ');
    press();
    expect(await screen.findByText('اكتب رقم هاتف بديل')).toBeTruthy();
    expect(box('altPhone')!.parentElement!.textContent).toContain('اكتب رقم هاتف بديل');
    expect(box('note')!.parentElement!.textContent).toContain('اكتب ملاحظتك');
    expect(shopFetch, 'انبعت طلب فيه خانة إلزامية فاضية').not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('and filled in, the next press sends it', async () => {
    answer(true, { orderNumber: 'SY-0702', total: 25, currency: 'USD' });
    draw({ required: [...FOUR, 'altPhone'] });
    fillFour();
    press();
    await screen.findByText('اكتب رقم هاتف بديل');
    type('altPhone', '0933111222');
    press();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/s/sehha/thanks?o=SY-0702'));
    expect(sentBody().alt_phone).toBe('0933111222');
  });

  it('NEGATIVE: not required — blank is an answer, and the order is sent', async () => {
    answer(true, { orderNumber: 'SY-0703', total: 25, currency: 'USD' });
    draw();
    fillFour();
    press();
    await waitFor(() => expect(shopFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('اكتب رقم هاتف بديل')).toBeNull();
  });
});

describe('a refusal about a field this page does not draw', () => {
  it('says to reload — the page is older than the shop’s «الدفع»', async () => {
    answer(false, { error: 'يرجى التأكد من صحة بيانات الطلب.', fieldErrors: { alt_phone: 'اكتب رقم هاتف بديل' } });
    draw({ fields: FOUR });
    fillFour();
    press();
    expect((await screen.findByRole('alert')).textContent).toBe(REFRESH);
  });

  it('NEGATIVE: about a field it does draw — under that field, and the door’s own line, no reload', async () => {
    answer(false, { error: 'يرجى التأكد من صحة بيانات الطلب.', fieldErrors: { alt_phone: 'اكتب رقم هاتف بديل' } });
    draw();
    fillFour();
    press();
    expect((await screen.findByRole('alert')).textContent).toBe('يرجى التأكد من صحة بيانات الطلب.');
    expect(box('altPhone')!.parentElement!.textContent).toContain('اكتب رقم هاتف بديل');
    expect(screen.queryByText(REFRESH)).toBeNull();
  });
});

describe('the button wears the shop’s «لون زر التأكيد»', () => {
  const VARS = { '--store-accent': '#ffd400', '--store-accent-text': '#121926', '--store-accent-dark': '#d9b400' };
  const button = () => screen.getByRole('button', { name: 'أرسل الطلب' });

  it('the three variables set on the button itself, and it paints from them', () => {
    draw({ buttonVars: VARS });
    for (const [name, value] of Object.entries(VARS)) expect(button().style.getPropertyValue(name), name).toBe(value);
    expect(button().style.background).toBe('var(--store-accent)');
  });

  it('NEGATIVE: no colour set — nothing set on it, and it wears the shop’s accent as before', () => {
    draw({ buttonVars: null });
    expect(button().style.getPropertyValue('--store-accent')).toBe('');
    expect(button().style.background).toBe('var(--store-accent)');
  });
});
