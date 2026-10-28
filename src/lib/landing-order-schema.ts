/**
 * Shared validation for the PUBLIC landing-page order form (server-side).
 *
 * Security contract: price / productId / companyId / quantity / freeQuantity /
 * status / userId are NOT part of the schema — any client-sent value is
 * ignored. quantity/price derive server-side from slug → LandingPage →
 * LandingPageOffer → DB.
 *
 * Human-readable Arabic field errors replace raw Zod messages (which must
 * never leak to visitors).
 */

import { z } from 'zod';
import { count } from '@/lib/numeric-input';
import { isValidPhoneFor, phoneErrorFor } from '@/lib/phone-rules';

/**
 * The country the page sells into, resolved server-side from
 * slug → LandingPage → Store → Country. It is never taken from the browser.
 *
 * `regions` are that country's own region names (the Region table). When a
 * country has none recorded yet, the city becomes free text instead of being
 * rejected outright — an unconfigured country must not silently stop taking
 * orders.
 */
import { MAX_CART_LINES, MAX_LINE_QUANTITY } from './cart';

export interface OrderLocale {
  countryCode: string | null;
  regions: string[];
}

/** Matches a submitted city against the country's regions, ignoring case and spacing. */
export function isKnownRegion(regions: string[], value: string): boolean {
  const v = value.trim().toLocaleLowerCase('ar');
  return regions.some((r) => r.trim().toLocaleLowerCase('ar') === v);
}

export function buildPublicOrderSchema(locale: OrderLocale) {
  const hasRegions = locale.regions.length > 0;

  return z.object({
    full_name: z
      .string({ message: 'يرجى إدخال الاسم الكامل.' })
      .trim()
      .min(2, 'يرجى إدخال الاسم الكامل.')
      .max(80, 'الاسم طويل جدًا.'),
    phone: z
      .string({ message: 'يرجى إدخال رقم هاتف صحيح.' })
      .trim()
      .min(6, 'يرجى إدخال رقم هاتف صحيح.')
      .max(25, 'رقم الهاتف طويل جدًا.')
      .refine((p) => isValidPhoneFor(locale.countryCode, p), phoneErrorFor(locale.countryCode)),
    address: z
      .string({ message: 'يرجى إدخال العنوان.' })
      .trim()
      .min(5, 'يرجى إدخال العنوان بشكل أوضح.')
      .max(200, 'العنوان طويل جدًا.'),
    city: z
      .string({ message: 'يرجى اختيار المدينة.' })
      .trim()
      .min(2, 'يرجى اختيار المدينة.')
      .max(60, 'يرجى اختيار المدينة.')
      .refine(
        (v) => !hasRegions || isKnownRegion(locale.regions, v),
        'يرجى اختيار المدينة من القائمة.'
      ),
    // Optional: pages WITHOUT offers fall back to the base product price.
    // When present it must reference a real offer (ownership checked in the route).
    offerId: z.string().trim().max(64, 'يرجى اختيار أحد العروض.').optional().default(''),
    /**
     * A BASKET, for a shop that sells more than one thing at a time.
     *
     * Absent on a landing page and on a single-product shop, which sell one
     * product through one door and use `offerId` above. When it is present
     * it IS the order and `offerId` is ignored: two ways of saying what was
     * ordered, both honoured, is two orders.
     *
     * NO PRICES. Every figure is computed on the server from the offers
     * table at the moment the order is placed. A total sent from a browser
     * is a total a browser can choose.
     */
    items: z
      .array(
        z.object({
          productId: z.string().trim().min(1).max(64),
          offerId: z.string().trim().max(64).optional().default(''),
          /**
           * NO PRICE ARRIVES HERE, BUT A COUNT DOES — AND A PUBLIC DOOR IS
           * THE ONE PLACE A HOSTILE VALUE COMES ON PURPOSE.
           *
           * This was `z.coerce.number()`, which is `Number(value)`, so
           * `quantity: '0x10'` was sixteen units of a product off a public
           * form and `'0b11'` was three — measured. The bound caught
           * nothing: 16 is inside `[1, 99]`, and it is the figure stock is
           * reserved and the line total computed from.
           *
           * `count()` from `numeric-input` is the same reader
           * `POST /api/orders` uses for the same column, and the ceiling is
           * unchanged — `MAX_LINE_QUANTITY` from `cart.ts`, which the
           * browser-side cart already clamps to, so the two ends of the
           * same form agree on one number.
           */
          quantity: count(MAX_LINE_QUANTITY, 1),
        })
      )
      .max(MAX_CART_LINES, 'السلة فيها أصناف أكثر مما نقبله في طلب واحد.')
      .optional(),
    /**
     * A SECOND NUMBER TO TRY.
     *
     * `Customer.altPhone` is a column and `findOrCreateCustomer` has always
     * accepted one; the public schema was the only place that did not know
     * about it, so «هاتف بديل» could be ordered and even marked required on
     * the checkout tab and no public door could send one.
     *
     * Optional HERE whatever the shop's settings say, and its format rules
     * are these: the phone above is the identity. When the shop ticked it
     * «إلزامي» (and left it on the form), the door refuses a blank one AFTER
     * this schema, from the store's own «الدفع» — `createPublicOrder` and
     * `checkout-words.ts` — so one schema serves every shop.
     */
    alt_phone: z
      .string()
      .trim()
      .max(25, 'رقم الهاتف طويل جدًا.')
      .optional()
      .default(''),
    notes: z.string().trim().max(500, 'الملاحظات طويلة جدًا.').optional().default(''),
    // Spam protections (checked below, never stored)
    website: z.string().max(0, 'Spam detected').optional().default(''),
    ts: z.string().max(20).optional().default(''),
  });
}

export type PublicOrderInput = z.infer<ReturnType<typeof buildPublicOrderSchema>>;

/** Any Arabic letter — the marker of a message we authored ourselves. */
const ARABIC = /[؀-ۿ]/;

/** Zod issue path → Arabic field error (path key → message). */
const FIELD_ERROR_MESSAGES: Record<string, string> = {
  full_name: 'يرجى إدخال الاسم الكامل.',
  phone: 'يرجى إدخال رقم هاتف صحيح.',
  address: 'يرجى إدخال العنوان.',
  city: 'يرجى اختيار المدينة.',
  offerId: 'يرجى اختيار أحد العروض.',
  items: 'تعذّرت قراءة محتوى السلة. أعد تحميل الصفحة وحاول ثانية.',
  notes: 'الملاحظات طويلة جدًا.',
};

/**
 * Maps Zod issues to safe Arabic field errors. NEVER returns Zod internals
 * ("Too small: expected string…" etc.) to the client.
 */
export function mapZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!key || fieldErrors[key]) continue;
    // Our own messages are Arabic and Zod's internals are not, so an Arabic
    // message is one we wrote and is safe to show — and more specific than
    // the fallback ("رقم هاتف أردني صحيح" instead of "رقم هاتف صحيح").
    fieldErrors[key] = ARABIC.test(issue.message)
      ? issue.message
      : FIELD_ERROR_MESSAGES[key] || 'يرجى التأكد من صحة بيانات الطلب.';
  }
  return fieldErrors;
}

/** Generic safe error response body for a failed validation. */
export const ORDER_VALIDATION_ERROR_BODY = {
  error: 'يرجى التأكد من صحة بيانات الطلب.',
};