import { canonicalPhone, nationalDigits, ruleFor } from './phone-rules';
import { toLatinDigits } from './latin-digits';

/**
 * «السلات المهجورة» — THE WORDS AND THE RULES, READABLE FROM ANYWHERE.
 *
 * Client-safe: no database, no session. The screen, the landing door and the staff doors all read the same statuses, the
 * same Arabic and the same phone key from here, so a status the screen offers is a status the door accepts.
 *
 * A cart is a visitor who typed a name and a valid phone on a landing page and did not order within fifteen minutes.
 * Zaki pages decides that and sends it (contract oms-lp.v1 §9); this system receives it and the team works it.
 */

export const CART_STATUSES = [
  'NEW',
  'CONTACTED',
  'NO_ANSWER',
  'CALLBACK',
  'NOT_INTERESTED',
  'INVALID',
  'CONVERTED',
  'RECOVERED',
] as const;

export type CartStatus = (typeof CART_STATUSES)[number];

export function isCartStatus(v: unknown): v is CartStatus {
  return typeof v === 'string' && (CART_STATUSES as readonly string[]).includes(v);
}

/** The status in the words the rest of the OMS uses, and its tone on a chip. */
export const CART_STATUS_AR: Record<CartStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  NEW: { label: 'جديدة', tone: 'warn' },
  CONTACTED: { label: 'تم التواصل', tone: 'neutral' },
  NO_ANSWER: { label: 'ما رد', tone: 'warn' },
  CALLBACK: { label: 'معاودة اتصال', tone: 'neutral' },
  NOT_INTERESTED: { label: 'غير مهتم', tone: 'bad' },
  INVALID: { label: 'رقم غير صالح', tone: 'bad' },
  CONVERTED: { label: 'صارت طلب', tone: 'good' },
  RECOVERED: { label: 'طلب لحاله', tone: 'good' },
};

/**
 * THE STATUSES A PERSON PICKS BY HAND.
 *
 * CONVERTED is written only by «حوّل لطلب», after the ordinary order door has made the order, or by the automatic order
 * (`abandoned-cart-orders.ts`); RECOVERED only by Zaki pages, or by the landing door, when the customer ordered by himself. Neither is a choice in a menu: a cart marked «صارت طلب» with no order
 * behind it is a number on a report that nobody can open.
 */
export const HAND_STATUSES: CartStatus[] = ['NEW', 'CONTACTED', 'NO_ANSWER', 'CALLBACK', 'NOT_INTERESTED', 'INVALID'];

/** A cart that became an order (by the team or by the customer) is finished: its status no longer moves by hand. */
export const CLOSED_STATUSES: CartStatus[] = ['CONVERTED', 'RECOVERED'];

export function isClosedCart(status: string): boolean {
  return (CLOSED_STATUSES as string[]).includes(status);
}

/**
 * WHAT THE RETENTION JOB MAY DELETE, AND AFTER HOW LONG BY DEFAULT.
 *
 * The owner's brief: «احذف … السلات NOT_INTERESTED وINVALID وRECOVERED بعد 60 يوم». CONVERTED is not on the list: its row
 * is the only record that an order came out of a cart, and it is small. A setting (`abandonedCarts.retentionDays` in the
 * company's settings) moves the number, between the two bounds.
 */
export const PRUNED_STATUSES: CartStatus[] = ['NOT_INTERESTED', 'INVALID', 'RECOVERED'];
export const DEFAULT_RETENTION_DAYS = 60;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;

/** The days a stored setting says, clamped, or the default. */
export function retentionDaysOf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isInteger(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, n));
}

/**
 * ═══ A CART WITH A NAME AND A PHONE BECOMES AN ORDER BY ITSELF (the owner, 17/11) ═══
 *
 * «بدي السلات المهجورة تتحول لطلب مباشرة وتنبعت للطابور». A cart that carries a name (two letters at least) and a
 * valid phone becomes an ordinary NEW order in the confirmation queue, through the same engine the landing orders use
 * (`abandoned-cart-orders.ts`). A phone-only cart stays a cart. The switch is the company's
 * (`abandonedCarts.autoConvert`, ON unless somebody turned it off).
 */

/** The switch as stored: ON unless it was turned off in so many words. */
export function autoConvertOf(raw: unknown): boolean {
  return raw !== false;
}

/** A name, by the order door's own measure (`full_name` is two letters at least). */
export const AUTO_ORDER_MIN_NAME = 2;

/**
 * The statuses a cart may become an order from by itself: still open, and not closed by a person as «غير مهتم» or
 * «رقم غير صالح» — that is the team's word, and an order would overrule it.
 */
export const AUTO_ORDER_STATUSES: CartStatus[] = ['NEW', 'CONTACTED', 'NO_ANSWER', 'CALLBACK'];

/** Whether this cart is one the owner asked to become an order: a product of this company and a name. */
export function cartQualifiesForOrder(cart: { status: string; customerName: string | null; productId: string | null; orderId: string | null }): boolean {
  return (
    (AUTO_ORDER_STATUSES as string[]).includes(cart.status) &&
    !cart.orderId &&
    !!cart.productId &&
    (cart.customerName ?? '').trim().length >= AUTO_ORDER_MIN_NAME
  );
}

/**
 * THE ORDER'S SOURCE, as the order screens print it («قناة الطلب: سلة مهجورة»). Not «Landing Page»: the visitor never
 * pressed «اطلب», so the pixel must not be told a form was sent (`salesPageOf` sends only the selling pages' orders).
 */
export const CART_ORDER_SOURCE = 'سلة مهجورة';

/** How far back the job reaches for carts that waited (sent before the release, or while the switch was off). */
export const AUTO_ORDER_BACKLOG_DAYS = 7;

/** The cart's own history lines for its automatic order. CONVERTED is the ordinary one, with `auto: true`. */
export const CART_AUTO_ACTION = {
  /** It qualified and did not become an order — the reason in the line's note. */
  SKIPPED: 'AUTO_ORDER_SKIPPED',
  /** Its automatic order was ended because the customer then ordered by himself. */
  STOOD_DOWN: 'AUTO_ORDER_CANCELLED',
} as const;

/** Why a qualifying cart stayed a cart, in the words its history shows. */
export const AUTO_ORDER_SKIP_AR = {
  HAS_ORDER: 'نفس الرقم عنده طلب لنفس المنتج هالأسبوع — ما انعمل طلب تاني.',
  BLOCKED: 'الرقم محظور — ما انعمل طلب.',
  UNAVAILABLE: 'المنتج أو المتجر موقوف — ما انعمل طلب.',
  REFUSED: 'باب الطلبات ما قبلها',
} as const;

/** The reason the automatic order is ended with when the customer then orders by himself. */
export const CUSTOMER_ORDERED_HIMSELF_AR = 'الزبون طلب بنفسه';

/** The date filter's three windows, in days back from now. */
export const CART_RANGES = { today: 0, '7d': 7, '30d': 30 } as const;
export type CartRange = keyof typeof CART_RANGES;

/** «له طلب»: the same phone has an order for the same product within this many days. */
export const HAS_ORDER_DAYS = 7;

/**
 * ONE PHONE, ONE KEY — HOWEVER ZAKI PAGES WROTE IT.
 *
 * The contract sends the number as the visitor typed it («0791234567»); the brief's example is international without the
 * plus («962791234567»). Both are the same customer, and the key has to be the form `Customer.phone` is stored in, or
 * «له طلب» would never find the order. With the country's rule, `nationalDigits` strips the dial code (with or without
 * `+`/`00`) and the trunk zero; a country with no rule takes the store-agnostic reading (`canonicalPhone`).
 */
export function cartPhoneKey(raw: string, countryCode: string | null | undefined): string {
  const text = toLatinDigits(String(raw ?? '')).trim();
  const rule = ruleFor(countryCode);
  if (rule) return nationalDigits(text, rule.dialCode);
  return canonicalPhone(text);
}

/** The number as a person reads it on this screen: the national form behind a trunk zero, or the whole foreign number. */
export function cartPhoneShown(key: string, countryCode: string | null | undefined): string {
  if (!key) return '';
  const rule = ruleFor(countryCode);
  if (!rule) return key;
  return rule.national.test(key) ? `0${key}` : `+${key}`;
}

/** The ready message «واتساب» opens with: the customer's name, if any, and the product. */
export function cartWhatsappText(customerName: string | null | undefined, productName: string | null | undefined): string {
  const hello = customerName?.trim() ? `مرحبا ${customerName.trim()}` : 'مرحبا';
  const product = productName?.trim();
  return product
    ? `${hello}، شفنا إنك كنت بدك تطلب «${product}» وما كملت الطلب. حابب نكمّله إلك هلأ؟`
    : `${hello}، شفنا إنك كنت بدك تطلب وما كملت الطلب. حابب نكمّله إلك هلأ؟`;
}
