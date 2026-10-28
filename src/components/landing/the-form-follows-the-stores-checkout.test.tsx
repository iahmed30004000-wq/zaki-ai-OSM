// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { DEFAULT_STORE_THEME, checkoutForPage, type StoreTheme } from '@/lib/store-theme';
import { DEFAULT_THEME, paletteFor, readableOn } from '@/lib/landing-theme';
import { lookPartReason } from '@/lib/block-look';
import { repoFile, stripComments } from '@/lib/guard-source';
import { newSection } from '@/lib/landing-sections';
import { DEFAULT_SUBMIT, DEFAULT_THANKS } from '@/lib/checkout-words';
import { AppProvider } from '@/context/AppContext';
import { StoreCheckoutNote } from '@/components/landing-editor/StoreCheckoutNote';
import { OrderCta } from './blocks/OrderCta';

/**
 * «مش مربوط بصفحة الهبوط» — the owner, over a screenshot of «القالب والألوان» ← «الدفع».
 *
 * The tab saved the field order, which fields are required, the confirm button's words and colour, and the line
 * after the order. The shop's cart checkout read three of them; every landing page drew its own form and read none.
 * Now every public door hands its order form the store's «الدفع», resolved on the server — and the form, handed
 * nothing, is exactly the one it always was.
 *
 * And «إلزامي» is meant: the owner, asked 28/10 whether a blank required field refuses the order or is taken as
 * before, answered «انطيني الصلاحية شو الي يظهر بالشيك اوت الي بينطلب والترتيب دراخ اند دروب» — refuse it. So a
 * blank required «هاتف بديل» or «ملاحظة» is asked for under its field before anything is sent (the door refuses it
 * too — public-order-asks-what-the-shop-asks.test.ts), and a field the shop hid is neither drawn nor sent.
 */

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('@/components/tracking/GlobalTrackingProvider', () => ({
  useTracking: () => ({ trackEvent, registerPixels: vi.fn(), setPageContext: vi.fn() }),
}));

import OrderForm, { submitWords, thanksLine } from './OrderForm';

const offers = [{ id: 'o1', name: 'عبوة واحدة', quantity: 1, freeQuantity: 0, price: 20, isDefault: true }];

/** The store's «الدفع» as a page hands it in — through the same resolver the server runs. */
const shop = (over: Partial<NonNullable<StoreTheme['checkout']>> = {}) =>
  checkoutForPage({ ...DEFAULT_STORE_THEME, checkout: { ...DEFAULT_STORE_THEME.checkout!, ...over } });

const draw = (props: Partial<React.ComponentProps<typeof OrderForm>> = {}) =>
  render(
    <OrderForm
      slug="kamaa" productName="ماء الكمأ" basePrice={20} currency="USD" offers={offers} recommendations={[]}
      regions={['دمشق', 'حلب']} {...props}
    />
  );

const WIRE: Record<string, string> = { full_name: 'name', phone: 'phone', alt_phone: 'altPhone', address: 'address', notes: 'note' };
/** The fields as a visitor meets them, top to bottom (the city is a listbox button, not a named field). */
const onScreen = () =>
  [...document.querySelectorAll('form [name], #zf-city')]
    .map((el) => (el.id === 'zf-city' ? 'region' : WIRE[(el as HTMLInputElement).name]))
    .filter(Boolean);
/** The labels that end in «*», by the control they name. */
const starred = () =>
  [...document.querySelectorAll('form label')]
    .filter((l) => (l.textContent ?? '').trim().endsWith('*'))
    .map((l) => l.getAttribute('for'));
const field = (name: string) => document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
const foldLine = () => screen.queryByRole('button', { name: '+ إضافة ملاحظة (اختياري)' });
const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
const half = () => [...document.querySelectorAll('.lp-half')].map((e) => e.querySelector('input')?.name);
const initiated = () => trackEvent.mock.calls.filter((c) => c[0] === 'InitiateCheckout');
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** What the form posted, one entry per request. */
let sent: Record<string, unknown>[] = [];
const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(body), { status });
    })
  );
const placed = { orderNumber: 'ORD-2026-0701', total: 20, currency: 'USD' };

/** The four a parcel needs, filled the way a visitor fills them. */
function fill() {
  fireEvent.change(field('full_name')!, { target: { value: 'سلمى الأحمد' } });
  fireEvent.change(field('phone')!, { target: { value: '0999999999' } });
  fireEvent.change(field('address')!, { target: { value: 'شارع بغداد، قرب الجامع' } });
  fireEvent.click(screen.getByRole('button', { name: /المدينة/ }));
  fireEvent.click(screen.getByRole('button', { name: 'دمشق' }));
}
const send = () => fireEvent.submit(document.querySelector('form')!);

beforeEach(() => {
  sent = [];
  trackEvent.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the fields are the shop’s', () => {
  it('a store that never opened «الدفع»: name, phone, the second number, the city, the address — the note folded last', () => {
    draw({ checkout: shop() });
    expect(onScreen()).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    // Still folded behind its one line, and that line comes after the address.
    expect(field('notes')).toBeNull();
    expect(follows(field('address')!, foldLine()!)).toBe(true);
  });

  it('the seller’s own order is the order on the page', () => {
    draw({ checkout: shop({ fieldOrder: ['phone', 'address', 'region', 'name', 'note', 'altPhone'], required: ['note'] }) });
    expect(onScreen()).toEqual(['phone', 'address', 'region', 'name', 'note', 'altPhone']);
  });

  it('«*» is on the fields the shop requires, and only on those', () => {
    draw({ checkout: shop() });
    expect(starred()).toEqual(['zf-full_name', 'zf-phone', 'zf-city', 'zf-address']);
    // The second number says it may be skipped, rather than leaving the visitor to guess.
    expect(screen.getByLabelText('رقم هاتف بديل (اختياري)')).toBe(field('alt_phone'));
    expect(field('alt_phone')!.getAttribute('aria-required')).toBeNull();
    cleanup();

    draw({ checkout: shop({ required: ['altPhone'] }) });
    expect(starred()).toEqual(['zf-full_name', 'zf-phone', 'zf-alt_phone', 'zf-city', 'zf-address']);
    expect(screen.queryByLabelText(/اختياري/)).toBeNull();
    expect(field('alt_phone')!.getAttribute('aria-required')).toBe('true');
  });

  it('the second number is a phone field, written left to right', () => {
    draw({ checkout: shop() });
    const alt = field('alt_phone')!;
    expect(alt.type).toBe('tel');
    expect(alt.getAttribute('dir')).toBe('ltr');
    expect(alt.getAttribute('inputmode')).toBe('tel');
    // Never filled in by the browser with the customer's own number a second time.
    expect(alt.getAttribute('autocomplete')).toBe('off');
  });

  it('and what is typed in it reaches the order', async () => {
    answer(200, placed);
    draw({ checkout: shop() });
    fill();
    fireEvent.change(field('alt_phone')!, { target: { value: '0933 111 222' } });
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(sent).toHaveLength(1);
    expect(sent[0].alt_phone).toBe('0933 111 222');
    expect(sent[0]).toMatchObject({ full_name: 'سلمى الأحمد', phone: '0999999999', city: 'دمشق' });
  });
});

describe('the note', () => {
  it('stays folded when the shop leaves it optional, and opens on a tap — focused, because the visitor asked', () => {
    draw({ checkout: shop() });
    expect(field('notes')).toBeNull();
    fireEvent.click(foldLine()!);
    const note = field('notes')!;
    expect(document.activeElement).toBe(note);
    // The control for the negative below: a focus on this form IS «بدء الطلب».
    expect(initiated()).toHaveLength(1);
  });

  it('is open and marked when the shop requires it', () => {
    draw({ checkout: shop({ required: ['note'] }) });
    expect(foldLine()).toBeNull();
    expect(field('notes')!.tagName).toBe('TEXTAREA');
    expect(starred()).toContain('zf-notes');
    expect(field('notes')!.getAttribute('aria-required')).toBe('true');
  });

  it('NEGATIVE: open from the start, it is not focused — the page does not jump to the form or report «بدء الطلب»', () => {
    draw({ checkout: shop({ required: ['note'] }) });
    // It IS on the screen — or «not focused» would be true of a note that was never drawn.
    expect(field('notes')).not.toBeNull();
    expect(document.activeElement).not.toBe(field('notes'));
    expect(document.activeElement).toBe(document.body);
    expect(initiated()).toHaveLength(0);
  });
});

/**
 * A1 — «اطلب الآن» carried the visitor to the NAME field, which was the first field until the shop could order them.
 * A shop that put the phone first had every visitor dropped into its second box. The form marks its first field and
 * the button reads the mark.
 */
describe('«اطلب الآن» lands in the first field the shop put on the form', () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    // jsdom draws nothing, so it has no scrolling to do — the button calls it, and it is given a no-op.
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    restore = () => {
      Element.prototype.scrollIntoView = had;
    };
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    restore();
  });

  const page = (props: Partial<React.ComponentProps<typeof OrderForm>> = {}) =>
    render(
      <>
        <OrderCta className="lp-cta">اطلب الآن</OrderCta>
        <OrderForm
          slug="kamaa" productName="ماء الكمأ" basePrice={20} currency="USD" offers={offers} recommendations={[]}
          regions={['دمشق', 'حلب']} {...props}
        />
      </>
    );
  /** The press, and the 450ms the button waits for the scroll before it focuses. */
  const press = () => {
    fireEvent.click(screen.getByRole('link', { name: 'اطلب الآن' }));
    act(() => {
      vi.advanceTimersByTime(450);
    });
  };
  const PHONE_FIRST = ['phone', 'name', 'region', 'address', 'altPhone', 'note'] as const;

  it('the phone first — the phone field is focused, and it is the one field marked', () => {
    page({ checkout: shop({ fieldOrder: [...PHONE_FIRST] }) });
    expect(document.querySelectorAll('[data-zf-first]')).toHaveLength(1);
    press();
    expect(document.activeElement).toBe(document.getElementById('zf-phone'));
  });

  it('NEGATIVE: the shop’s default order — the name field, as it always was', () => {
    page({ checkout: shop() });
    press();
    expect(document.activeElement).toBe(document.getElementById('zf-full_name'));
  });

  it('the city first — its button; the second number first — its box', () => {
    page({ checkout: shop({ fieldOrder: ['region', 'name', 'phone', 'address', 'altPhone', 'note'] }) });
    press();
    expect(document.activeElement).toBe(document.getElementById('zf-city'));
    cleanup();
    page({ checkout: shop({ fieldOrder: ['altPhone', 'name', 'phone', 'region', 'address', 'note'] }) });
    press();
    expect(document.activeElement).toBe(document.getElementById('zf-alt_phone'));
  });

  it('a folded note first — the line that opens it; a required one — its box', () => {
    page({ checkout: shop({ fieldOrder: ['note', 'name', 'phone', 'region', 'address', 'altPhone'] }) });
    press();
    expect(document.activeElement).toBe(foldLine());
    cleanup();
    page({ checkout: shop({ fieldOrder: ['note', 'name', 'phone', 'region', 'address', 'altPhone'], required: ['note'] }) });
    press();
    expect(document.activeElement).toBe(field('notes'));
  });

  it('NEGATIVE: a form with no mark (a page older than the mark) — the name field, the old answer', () => {
    page({ checkout: shop({ fieldOrder: [...PHONE_FIRST] }) });
    document.querySelector('[data-zf-first]')!.removeAttribute('data-zf-first');
    press();
    expect(document.activeElement).toBe(document.getElementById('zf-full_name'));
  });

  it('and with no JavaScript the link still lands on the form', () => {
    page({ checkout: shop({ fieldOrder: [...PHONE_FIRST] }) });
    expect(screen.getByRole('link', { name: 'اطلب الآن' }).getAttribute('href')).toBe('#zf-full_name');
  });
});

describe('a blank «هاتف بديل» or «ملاحظة» the shop requires is asked for before anything is sent', () => {
  it('both required, both blank — no request, and the door’s own sentence under each field', async () => {
    answer(200, placed);
    draw({ checkout: shop({ required: ['altPhone', 'note'] }) });
    fill();
    const reportedBefore = trackEvent.mock.calls.length;
    send();
    expect(await screen.findByText('اكتب رقم هاتف بديل')).toBeTruthy();
    expect(field('alt_phone')!.parentElement!.textContent).toContain('اكتب رقم هاتف بديل');
    expect(field('notes')!.parentElement!.textContent).toContain('اكتب ملاحظتك');
    expect(sent, 'انبعت طلب فيه خانة إلزامية فاضية').toHaveLength(0);
    // And nothing reported for the refusal: no focus invented, so no «بدء الطلب», and no «الشراء».
    expect(trackEvent.mock.calls.length, 'الرفض بعت حدث للإعلانات').toBe(reportedBefore);
    expect(trackEvent.mock.calls.filter((c) => c[0] === 'Purchase')).toHaveLength(0);
    // The field is brought into view, never focused — focus is the event the ad accounts read.
    expect(document.activeElement).not.toBe(field('alt_phone'));
    // The form is still the form — the visitor fills it in and presses again.
    expect(submitButton().disabled).toBe(false);
  });

  it('whitespace is blank too', async () => {
    answer(200, placed);
    draw({ checkout: shop({ required: ['altPhone'] }) });
    fill();
    fireEvent.change(field('alt_phone')!, { target: { value: '   ' } });
    send();
    expect(await screen.findByText('اكتب رقم هاتف بديل')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('and once they are filled in, the same press sends the order with them', async () => {
    answer(200, placed);
    draw({ checkout: shop({ required: ['altPhone', 'note'] }) });
    fill();
    send();
    await screen.findByText('اكتب ملاحظتك');
    fireEvent.change(field('alt_phone')!, { target: { value: '0933111222' } });
    fireEvent.change(field('notes')!, { target: { value: 'بعد العصر' } });
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ alt_phone: '0933111222', notes: 'بعد العصر' });
  });

  it('NEGATIVE: neither required — both blank, and the order is sent as before, with both empty', async () => {
    answer(200, placed);
    draw({ checkout: shop() });
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ alt_phone: '', notes: '' });
    expect(screen.queryByText('اكتب رقم هاتف بديل')).toBeNull();
  });
});

describe('a field the shop hid is neither drawn nor sent', () => {
  it('the second number and the note, hidden — not on the form, and no key for either in the order', async () => {
    answer(200, placed);
    draw({ checkout: shop({ hidden: ['altPhone', 'note'] }) });
    expect(onScreen()).toEqual(['name', 'phone', 'region', 'address']);
    expect(field('alt_phone')).toBeNull();
    expect(foldLine(), 'الملاحظة المخفية لسا إلها سطر').toBeNull();
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(Object.keys(sent[0]).sort()).toEqual(
      ['address', 'campaign', 'city', 'full_name', 'offerId', 'phone', 'ts', 'website']
    );
  });

  it('and hidden-and-ticked asks nothing — the order goes out', async () => {
    answer(200, placed);
    draw({ checkout: shop({ hidden: ['altPhone'], required: ['altPhone'] }) });
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('alt_phone');
  });

  it('NEGATIVE: the four a parcel needs cannot be hidden — a stored hidden «phone» is drawn and sent', async () => {
    answer(200, placed);
    draw({ checkout: shop({ hidden: ['phone', 'name', 'region', 'address'] }) });
    expect(onScreen()).toEqual(['name', 'phone', 'altPhone', 'region', 'address']);
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(sent[0]).toMatchObject({ full_name: 'سلمى الأحمد', phone: '0999999999', city: 'دمشق' });
  });
});

describe('a refusal about a field this page does not draw — the page is older than the shop’s «الدفع»', () => {
  const NEWER = {
    error: 'يرجى التأكد من صحة بيانات الطلب.',
    fieldErrors: { alt_phone: 'اكتب رقم هاتف بديل' },
  };

  it('says to reload, near the button — the visitor cannot fill a field that is not there', async () => {
    answer(400, NEWER);
    // Drawn when the second number was hidden; the shop has since shown it and made it required.
    draw({ checkout: shop({ hidden: ['altPhone'] }) });
    fill();
    send();
    const line = await screen.findByText('صار في خانة مطلوبة جديدة — حدّث الصفحة وعيد الطلب');
    expect(follows(line, submitButton()), 'السطر مش جنب الزر').toBe(true);
    expect(screen.queryByText('يرجى التأكد من صحة بيانات الطلب.')).toBeNull();
  });

  it('NEGATIVE: a refusal about a field the page DOES draw is said under that field, and the page needs no reload', async () => {
    answer(400, NEWER);
    draw({ checkout: shop() });
    fill();
    send();
    await screen.findByText('يرجى التأكد من صحة بيانات الطلب.');
    expect(field('alt_phone')!.parentElement!.textContent).toContain('اكتب رقم هاتف بديل');
    expect(screen.queryByText('صار في خانة مطلوبة جديدة — حدّث الصفحة وعيد الطلب')).toBeNull();
  });
});

describe('the door’s own refusals are said under their fields', () => {
  const refused = {
    error: 'يرجى التأكد من صحة بيانات الطلب.',
    fieldErrors: { alt_phone: 'رقم الهاتف طويل جدًا.', notes: 'الملاحظات طويلة جدًا.' },
  };

  it('under the second number and under the open note', async () => {
    answer(400, refused);
    draw({ checkout: shop({ required: ['note'] }) });
    fill();
    // The required note is written — or the form would ask for it and send nothing.
    fireEvent.change(field('notes')!, { target: { value: 'قرب الجامع' } });
    send();
    await screen.findByText('رقم الهاتف طويل جدًا.');
    expect(field('alt_phone')!.parentElement!.textContent).toContain('رقم الهاتف طويل جدًا.');
    expect(field('notes')!.parentElement!.textContent).toContain('الملاحظات طويلة جدًا.');
  });

  it('and under the line that opens a folded note — a refusal about a hidden field is still said', async () => {
    answer(400, refused);
    draw({ checkout: shop() });
    fill();
    send();
    await screen.findByText('الملاحظات طويلة جدًا.');
    expect(foldLine()!.nextElementSibling?.textContent).toContain('الملاحظات طويلة جدًا.');
  });
});

describe('the confirm button’s colour is the shop’s, on that button alone', () => {
  it('sets the colour, its measured ink and its pressed shade on the submit button — nothing else moves', () => {
    draw({ checkout: shop({ buttonColor: '#ffd400' }) });
    const button = submitButton();
    expect(button.style.getPropertyValue('--store-accent')).toBe('#ffd400');
    expect(button.style.getPropertyValue('--store-accent-text')).toBe(readableOn('#ffd400'));
    expect(button.style.getPropertyValue('--store-accent-dark')).toBe(
      paletteFor({ ...DEFAULT_THEME, accent: '#ffd400' }).accentDark
    );
    // Only that button SETS them (the product name on the band only reads one). The band over the form («اطلب
    // الآن») and the offer cards keep the page's accent.
    const SETS = ['--store-accent', '--store-accent-text', '--store-accent-dark'];
    const painted = [...document.querySelectorAll<HTMLElement>('[style]')].filter((el) =>
      SETS.some((name) => el.style.getPropertyValue(name) !== '')
    );
    expect(painted).toEqual([button]);
    expect(screen.getByText('اطلب الآن').parentElement!.getAttribute('style')).toBeNull();
    expect(document.querySelector('#zaki-order-form')!.getAttribute('style')).toBeNull();
  });

  it('NEGATIVE: no colour set — the button is exactly the page’s, as before', () => {
    draw();
    const before = submitButton().className;
    expect(submitButton().getAttribute('style')).toBeNull();
    cleanup();

    draw({ checkout: shop() });
    expect(submitButton().className).toBe(before);
    expect(submitButton().getAttribute('style')).toBeNull();
    cleanup();

    // And a colour the shop's tab could never have saved is no colour either.
    draw({ checkout: shop({ buttonColor: 'red' }) });
    expect(submitButton().className).toBe(before);
    expect(submitButton().getAttribute('style')).toBeNull();
  });
});

describe('the compact look keeps name and phone as its only half-width pair', () => {
  it('side by side while they are next to each other, in either order', () => {
    draw({ checkout: shop(), formStyle: 'compact' });
    expect(half()).toEqual(['full_name', 'phone']);
    cleanup();
    draw({ checkout: shop({ fieldOrder: ['phone', 'name', 'region', 'address', 'altPhone', 'note'] }), formStyle: 'compact' });
    expect(half()).toEqual(['phone', 'full_name']);
  });

  it('NEGATIVE: a field between them — two full rows, never a half field standing alone', () => {
    draw({ checkout: shop({ fieldOrder: ['name', 'altPhone', 'phone', 'region', 'address', 'note'] }), formStyle: 'compact' });
    expect(half()).toEqual([]);
  });

  it('and nothing is half-width in the card look', () => {
    draw({ checkout: shop() });
    expect(half()).toEqual([]);
  });
});

describe('NEGATIVE: a door that hands in no checkout gets the form exactly as it always was', () => {
  it('name, phone, address, city, the note folded — and no second number', () => {
    draw();
    expect(onScreen()).toEqual(['name', 'phone', 'address', 'region']);
    expect(field('alt_phone')).toBeNull();
    expect(follows(document.querySelector('#zf-city')!, foldLine()!)).toBe(true);
    expect(starred()).toEqual(['zf-full_name', 'zf-phone', 'zf-address', 'zf-city']);
    expect(submitButton().getAttribute('style')).toBeNull();
    expect(screen.getByRole('button', { name: /^تأكيد الطلب — 20 USD/ })).toBeTruthy();
  });

  it('and it sends what it always sent, with no alt_phone key at all', async () => {
    answer(200, placed);
    draw();
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(Object.keys(sent[0]).sort()).toEqual(
      ['address', 'campaign', 'city', 'full_name', 'notes', 'offerId', 'phone', 'ts', 'website']
    );
    expect(screen.getByText('سنتواصل معك قريبًا لتأكيد الطلب.')).toBeTruthy();
  });
});

describe('the confirm button’s words — the page’s own, unless it kept the default', () => {
  it('the shop’s words when the page still says «تأكيد الطلب», or nothing at all', () => {
    expect(submitWords('تأكيد الطلب', 'احجز علبتك الآن')).toBe('احجز علبتك الآن');
    expect(submitWords(' تأكيد الطلب ', 'احجز علبتك الآن')).toBe('احجز علبتك الآن');
    expect(submitWords('', 'احجز علبتك الآن')).toBe('احجز علبتك الآن');
    expect(submitWords(undefined, 'احجز علبتك الآن')).toBe('احجز علبتك الآن');
  });

  it('NEGATIVE: the page’s own words stay — the seller typed them on purpose', () => {
    expect(submitWords('اضغط هنا لتأكيد طلبك', 'احجز علبتك الآن')).toBe('اضغط هنا لتأكيد طلبك');
  });

  it('NEGATIVE: never a blank button', () => {
    expect(submitWords('تأكيد الطلب', '')).toBe('تأكيد الطلب');
    expect(submitWords('   ', '   ')).toBe('تأكيد الطلب');
    expect(submitWords(undefined, undefined)).toBe('تأكيد الطلب');
  });

  it('on the button, with the price after them, and in the line under it', () => {
    draw({ checkout: shop({ submitText: 'احجز علبتك الآن' }), submitLabel: 'تأكيد الطلب' });
    expect(screen.getByRole('button', { name: /^احجز علبتك الآن — 20 USD/ })).toBeTruthy();
    expect(screen.getByText(/بالضغط على «احجز علبتك الآن»/)).toBeTruthy();
    cleanup();

    draw({ checkout: shop({ submitText: 'احجز علبتك الآن' }), submitLabel: 'اضغط هنا لتأكيد طلبك' });
    expect(screen.getByRole('button', { name: /^اضغط هنا لتأكيد طلبك — 20 USD/ })).toBeTruthy();
    expect(screen.queryByText(/احجز علبتك الآن/)).toBeNull();
  });
});

describe('the line after the order — the page’s «صفحة الشكر», then the shop’s, then ours', () => {
  it('in that order, and never blank', () => {
    expect(thanksLine('رح نكلمك خلال ساعة.', 'وصلنا طلبك — بنتصل فيك اليوم.')).toBe('رح نكلمك خلال ساعة.');
    expect(thanksLine(undefined, 'وصلنا طلبك — بنتصل فيك اليوم.')).toBe('وصلنا طلبك — بنتصل فيك اليوم.');
    expect(thanksLine('   ', 'وصلنا طلبك — بنتصل فيك اليوم.')).toBe('وصلنا طلبك — بنتصل فيك اليوم.');
    expect(thanksLine('', '')).toBe('سنتواصل معك قريبًا لتأكيد الطلب.');
    expect(thanksLine(undefined, '  ')).toBe('سنتواصل معك قريبًا لتأكيد الطلب.');
  });

  it('a page with no thank-you block says the shop’s line, under the title it always had', async () => {
    answer(200, placed);
    draw({ checkout: shop({ afterOrderMessage: 'وصلنا طلبك — بنتصل فيك اليوم.' }) });
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(screen.getByText('وصلنا طلبك — بنتصل فيك اليوم.')).toBeTruthy();
    expect(screen.getByText('تم تسجيل طلبك بنجاح')).toBeTruthy();
  });

  /*
   * A3 — every «صفحة الشكر» block is born holding the default message, so a page that has the block and never
   * touched it was answering for the shop. The default counts as «nothing written», the same rule as the button.
   */
  it('a page whose «صفحة الشكر» block still holds the default message says the shop’s line', async () => {
    expect(thanksLine(DEFAULT_THANKS, 'وصلنا طلبك — بنتصل فيك اليوم.')).toBe('وصلنا طلبك — بنتصل فيك اليوم.');
    expect(thanksLine(` ${DEFAULT_THANKS} `, 'وصلنا طلبك — بنتصل فيك اليوم.')).toBe('وصلنا طلبك — بنتصل فيك اليوم.');
    // And with no shop line the default is still said, never a blank.
    expect(thanksLine(DEFAULT_THANKS, '')).toBe(DEFAULT_THANKS);

    answer(200, placed);
    const block = newSection('thankyou');
    if (block.type !== 'thankyou') throw new Error('not a thank-you block');
    draw({
      checkout: shop({ afterOrderMessage: 'وصلنا طلبك — بنتصل فيك اليوم.' }),
      thankYou: { title: block.title, message: block.message },
    });
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(screen.getByText('وصلنا طلبك — بنتصل فيك اليوم.')).toBeTruthy();
    expect(screen.queryByText(DEFAULT_THANKS)).toBeNull();
  });

  it('and the two defaults are the blocks’ own — one sentence each, never two copies drifting apart', () => {
    const thanks = newSection('thankyou');
    const form = newSection('form');
    expect(thanks.type === 'thankyou' && thanks.message).toBe(DEFAULT_THANKS);
    expect(form.type === 'form' && form.submitLabel).toBe(DEFAULT_SUBMIT);
  });

  it('NEGATIVE: a page whose own thank-you block has words keeps them', async () => {
    answer(200, placed);
    draw({
      checkout: shop({ afterOrderMessage: 'وصلنا طلبك — بنتصل فيك اليوم.' }),
      thankYou: { title: 'شكراً إلك', message: 'رح نكلمك خلال ساعة.' },
    });
    fill();
    send();
    await screen.findByText(/ORD-2026-0701/);
    expect(screen.getByText('رح نكلمك خلال ساعة.')).toBeTruthy();
    expect(screen.queryByText('وصلنا طلبك — بنتصل فيك اليوم.')).toBeNull();
    expect(screen.getByText('شكراً إلك')).toBeTruthy();
  });
});

/**
 * WHERE THE PAGE READS IT FROM.
 *
 * A checkout read from the page's own theme would be nothing (a page's theme is a look), and one read from a
 * merged page theme would let a page quietly answer for its store. Held by reading the renderer, because the only
 * thing worth catching is a well-meant edit that hands the form some other theme.
 */
describe('the page hands the form its store’s LIVE «الدفع»', () => {
  const ONLY_THE_STORES = /checkoutForPage\(parseStoreTheme\(lp\.store\?\.theme\)\)/;
  const ANY_OTHER = /checkoutForPage\((?!parseStoreTheme\(lp\.store\?\.theme\)\))/;
  const readsTheStore = (src: string) => ONLY_THE_STORES.test(src) && !ANY_OTHER.test(src);

  it('built once, from parseStoreTheme(lp.store?.theme), and handed to the form', () => {
    const view = stripComments(repoFile('src/components/landing/LandingPageView.tsx'));
    expect(readsTheStore(view), 'النموذج بياخد «الدفع» من غير ثيم المتجر المنشور').toBe(true);
    expect(view.match(/checkoutForPage\(/g)).toHaveLength(1);
    expect(view).toContain('checkout={checkout}');
  });

  it('NEGATIVE: the guard tells the store’s theme from the page’s', () => {
    expect(readsTheStore('const checkout = checkoutForPage(parseStoreTheme(lp.store?.theme));')).toBe(true);
    expect(readsTheStore('const checkout = checkoutForPage(parseStoreTheme(lp.theme));')).toBe(false);
    expect(
      readsTheStore('checkoutForPage(themeForPage(parseStoreTheme(lp.store?.theme), pageThemeOverride(lp.theme)))')
    ).toBe(false);
    expect(readsTheStore('checkoutForPage(parseStoreTheme(lp.store?.theme)); checkoutForPage(theme);')).toBe(false);
  });

  it('and the form takes only its TYPE — the module and zod stay off the landing page', () => {
    const TYPE_ONLY = /^import type \{[^}]*\} from '@\/lib\/store-theme';$/m;
    const A_VALUE = /^import (?!type\b)[^;]*from '@\/lib\/store-theme'/m;
    const form = stripComments(repoFile('src/components/landing/OrderForm.tsx'));
    expect(form).toMatch(TYPE_ONLY);
    expect(form, 'النموذج بيجيب قيمة من store-theme فبيشحن zod لكل صفحة').not.toMatch(A_VALUE);
    // NEGATIVE: the second rule does catch a value import.
    expect("import { checkoutForPage } from '@/lib/store-theme';").toMatch(A_VALUE);
    expect("import type { PageCheckout } from '@/lib/store-theme';").not.toMatch(A_VALUE);
  });
});

describe('the seller is told where these come from', () => {
  it('the page editor says it under the button’s words', () => {
    const builder = stripComments(repoFile('src/components/landing-editor/BlockBuilder.tsx'));
    const at = builder.indexOf('نص زر التأكيد (السعر بيطلع بعده)');
    expect(at).toBeGreaterThan(-1);
    expect(builder.slice(at, at + 300)).toContain('<StoreCheckoutNote />');
  });

  /**
   * A4 — the tab's name is a LINK only for whoever may open «القالب والألوان», by the same answer the store's tab
   * strip is drawn from; anybody else reads plain words instead of a door that answers «لا تملك صلاحية».
   */
  const person = (permissions: string[], status = 'ACTIVE') =>
    ({ id: 'u1', email: 'a@b.c', name: 'سلمى', role: 'MANAGER', status, companyId: 'c1', permissions }) as never;
  const note = (user: unknown) =>
    render(
      <AppProvider initialUser={user as never}>
        <StoreCheckoutNote />
      </AppProvider>
    );
  /** The note's link, if it drew one — and it may only ever point at «القالب والألوان». */
  const link = () => {
    const a = document.querySelector('a');
    if (a) expect(a.getAttribute('href')).toBe('/store?tab=front&sec=look');
    return a;
  };

  it('a link to «القالب والألوان» for whoever may open it — «storefront.view» or «storefront.manage»', () => {
    note(person(['storefront.view']));
    expect(link()?.textContent).toBe('«القالب والألوان»');
    expect(link()?.getAttribute('target')).toBe('_blank');
    cleanup();
    note(person(['storefront.manage']));
    expect(link()).not.toBeNull();
  });

  it('NEGATIVE: plain words for anybody the panel would refuse — no permission, a paused account, nobody signed in', () => {
    for (const user of [person(['landing_pages.edit']), person(['storefront.view'], 'SUSPENDED'), null]) {
      note(user);
      expect(link(), JSON.stringify(user)).toBeNull();
      expect(screen.getByText(/«الدفع»/).textContent).toContain('«القالب والألوان»');
      cleanup();
    }
  });

  it('and outside the dashboard’s provider it says the words, and does not fall over', () => {
    render(<StoreCheckoutNote />);
    expect(link()).toBeNull();
    expect(screen.getByText(/«القالب والألوان»/)).toBeTruthy();
  });

  it('and the look panel no longer says the order button is the page’s colour alone', () => {
    expect(lookPartReason('form', 'button')).toContain('«الدفع»');
    expect(lookPartReason('form', 'button')).toContain('اللون الأساسي للصفحة');
  });
});
