import { updateCompanySettings } from './company-settings';
import { DEFAULT_LANGUAGE, STORE_LANGUAGES } from './store-languages';
import { db } from './db';
import { toLatinDigits } from './latin-digits';

/**
 * WHAT WE SEND A CUSTOMER, AND HOW.
 *
 * Nothing here talks to a gateway. The SMS button opens the phone's own
 * messaging app, WhatsApp opens WhatsApp, the call button dials — all with
 * the text already written. That is deliberate: a gateway means an account,
 * a key, a per-message cost and a delivery report nobody reads, to solve a
 * problem that is really "typing the same sentence forty times a day".
 *
 * It also means the message leaves from the company's own number, which is
 * the number the customer recognises and can reply to.
 *
 * The templates are the company's, not ours. The defaults below are a
 * starting point to edit, not a house style — every business words these
 * differently, and one that reads wrong is worse than none.
 */

export type Channel = 'SMS' | 'WHATSAPP';

/**
 * WHEN a message is sent, not down which wire.
 *
 * The list was a flat pile ordered by whenever somebody added one, so an
 * agent looking for the right sentence during a call read all forty. They
 * are grouped by the MOMENT instead — the agent knows which moment they are
 * in, and never knows which of two channels a template was filed under.
 *
 * `other` is not a moment. It is where a template that predates this list
 * lands, so an old one is never silently filed under a situation nobody
 * chose for it — the seller moves it themselves.
 */
export const SITUATIONS = [
  { key: 'confirmation', ar: 'التأكيد' },
  { key: 'no_answer', ar: 'لا يرد' },
  { key: 'postpone', ar: 'التأجيل' },
  { key: 'shipping', ar: 'الشحن' },
  { key: 'delay', ar: 'التأخير' },
  { key: 'return', ar: 'المرتجع' },
  { key: 'collection', ar: 'التحصيل' },
  { key: 'other', ar: 'غير مصنّفة' },
] as const;

export type Situation = (typeof SITUATIONS)[number]['key'];

export const SITUATION_KEYS = SITUATIONS.map((s) => s.key) as Situation[];

export interface MessageTemplate {
  id: string;
  name: string;
  channel: Channel | 'BOTH';
  body: string;
  /** The moment it belongs to. */
  situation: Situation;
  /** A code from STORE_LANGUAGES — never a second list of languages. */
  lang: string;
  /**
   * Off means written but not offered. A template is turned off for a
   * season or a courier and turned back on; deleting it loses the wording
   * and whoever wrote it types it again from memory.
   */
  active: boolean;
}

/**
 * A stored template as this build understands it.
 *
 * Templates saved before situations existed have none, and a row missing a
 * field must not take the tracking screen down — an agent mid-call needs
 * the list, not a stack trace.
 */
export interface RawTemplate {
  id: string;
  body: string;
  name?: string;
  channel?: string;
  situation?: string;
  lang?: string;
  active?: boolean;
}

export function normalizeTemplate(raw: RawTemplate): MessageTemplate {
  const situation = SITUATION_KEYS.includes(raw.situation as Situation) ? (raw.situation as Situation) : 'other';
  return {
    id: raw.id,
    name: raw.name ?? '',
    channel: raw.channel === 'SMS' || raw.channel === 'WHATSAPP' ? raw.channel : 'BOTH',
    body: raw.body,
    situation,
    lang: STORE_LANGUAGES.some((l) => l.code === raw.lang) ? raw.lang! : DEFAULT_LANGUAGE,
    // An old template was always offered, so it stays offered.
    active: raw.active !== false,
  };
}

/**
 * The placeholders a template may use.
 *
 * Arabic names, because the person writing the template is writing Arabic
 * and should not have to remember `{orderNumber}`.
 */
export const TEMPLATE_VARS = [
  { key: 'رقم_الطلب', label: 'رقم الطلب' },
  { key: 'اسم_الزبون', label: 'اسم الزبون' },
  { key: 'المبلغ', label: 'المبلغ المطلوب' },
  { key: 'العملة', label: 'العملة' },
  { key: 'شركة_الشحن', label: 'شركة الشحن' },
  { key: 'الباركود', label: 'رقم التتبع' },
  { key: 'المحافظة', label: 'المحافظة' },
  { key: 'المتجر', label: 'اسم المتجر' },
  { key: 'المنتجات', label: 'المنتجات' },
  { key: 'الكمية', label: 'الكمية' },
  { key: 'العنوان', label: 'العنوان' },
  { key: 'تاريخ_الطلب', label: 'تاريخ الطلب' },
] as const;

export const DEFAULT_TEMPLATES: MessageTemplate[] = [
  {
    id: 'confirm-address',
    name: 'تأكيد العنوان',
    channel: 'WHATSAPP',
    situation: 'confirmation',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'مرحبا {اسم_الزبون}، قبل شحن طلبك {رقم_الطلب} نريد تأكيد العنوان في {المحافظة}. هل هو صحيح؟',
  },
  {
    id: 'called-no-answer',
    name: 'اتصلنا ولم تردّ',
    channel: 'BOTH',
    situation: 'no_answer',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'مرحبا {اسم_الزبون}، حاولنا الاتصال بك بخصوص طلبك {رقم_الطلب} من {المتجر} ولم نوفَّق. متى يناسبك أن نعاود؟',
  },
  {
    id: 'postponed',
    name: 'أجّلنا بطلبك',
    channel: 'BOTH',
    situation: 'postpone',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'تمام {اسم_الزبون}، أجّلنا طلبك {رقم_الطلب} كما طلبت، وسنعاود الاتصال في الموعد الذي حدّدته.',
  },
  {
    id: 'out-for-delivery',
    name: 'خرج للتوصيل',
    channel: 'BOTH',
    situation: 'shipping',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'مرحبا {اسم_الزبون}، طلبك {رقم_الطلب} خرج للتوصيل اليوم مع {شركة_الشحن}. المبلغ المطلوب {المبلغ} {العملة}. رجاءً كن متاحاً على هذا الرقم.',
  },
  {
    id: 'tracking',
    name: 'رقم التتبع',
    channel: 'BOTH',
    situation: 'shipping',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'طلبك {رقم_الطلب} مع {شركة_الشحن}، ورقم التتبع {الباركود}. المبلغ {المبلغ} {العملة}.',
  },
  {
    id: 'delayed',
    name: 'تأخّر عنك',
    channel: 'BOTH',
    situation: 'delay',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'نعتذر {اسم_الزبون}، تأخّر طلبك {رقم_الطلب} عن موعده مع {شركة_الشحن}. نتابعه الآن ونُعلمك بالجديد.',
  },
  {
    id: 'delivery-failed',
    name: 'حاولنا ولم نصل',
    channel: 'BOTH',
    situation: 'return',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'مرحبا {اسم_الزبون}، حاول مندوب {شركة_الشحن} الوصول إليك لتسليم طلبك {رقم_الطلب} ولم يوفَّق. رجاءً تواصل معنا لتحديد موعد جديد قبل أن يعود الطلب.',
  },
  {
    id: 'amount-due',
    name: 'المبلغ المطلوب',
    channel: 'BOTH',
    situation: 'collection',
    lang: DEFAULT_LANGUAGE,
    active: true,
    body: 'مرحبا {اسم_الزبون}، المبلغ المطلوب لطلبك {رقم_الطلب} هو {المبلغ} {العملة}، يُدفع للمندوب عند الاستلام.',
  },
];

export interface FillContext {
  orderNumber?: string | null;
  customerName?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  courier?: string | null;
  barcode?: string | null;
  region?: string | null;
  storeName?: string | null;
  /** «المنتجات»: each line as «الاسم × الكمية», joined — read from the order's own lines. */
  products?: string | null;
  /** «الكمية»: the units the customer asked for (gifts not counted). */
  quantity?: number | string | null;
  /** «العنوان»: where the order goes. */
  address?: string | null;
  /** «تاريخ_الطلب»: the day the order was made. */
  orderDate?: string | null;
}

/**
 * Put the order's own words into the template.
 *
 * A placeholder with nothing behind it becomes an empty string rather than
 * the literal `{الباركود}`: a customer reading a brace knows something in
 * our system is broken, and there is no repair they can make.
 */
export function fillTemplate(body: string, ctx: FillContext): string {
  const values: Record<string, string> = {
    رقم_الطلب: ctx.orderNumber ?? '',
    اسم_الزبون: ctx.customerName ?? '',
    المبلغ: ctx.amount == null ? '' : String(ctx.amount),
    العملة: ctx.currency ?? '',
    شركة_الشحن: ctx.courier ?? '',
    الباركود: ctx.barcode ?? '',
    المحافظة: ctx.region ?? '',
    المتجر: ctx.storeName ?? '',
    المنتجات: ctx.products ?? '',
    الكمية: ctx.quantity == null ? '' : String(ctx.quantity),
    العنوان: ctx.address ?? '',
    تاريخ_الطلب: ctx.orderDate ?? '',
  };
  return body
    .replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const key = name.trim();
      return key in values ? values[key] : whole;
    })
    // A missing value can leave a double space or a stranded comma.
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** wa.me wants digits only, with the country code and no leading zero. */
export function waNumber(raw: string, countryCode?: string | null): string {
  // An Arabic keyboard types ٠٩٥٢… — read it as 0952…, or the number looks empty and the reason given is wrong.
  raw = toLatinDigits(raw || '');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // Already international — eleven digits or more with no trunk zero is a number carrying its own country code
  // (a Turkish line in the north of Syria: «905XXXXXXXXX»). Prefixing the store's code made it «963905…», nobody.
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.length >= 11 && !digits.startsWith('0')) return digits;
  const cc = (countryCode ?? '').replace(/\D/g, '');
  if (cc) {
    if (!digits.startsWith(cc)) digits = cc + digits.replace(/^0+/, '');
    return digits;
  }
  /*
   * A LOCAL NUMBER WITH NO COUNTRY BEHIND IT IS NOT A WHATSAPP NUMBER.
   *
   * «0952554562» sent on as it is makes wa.me drop the zero and read «95…» as a country — Myanmar — so the
   * message (the customer's name, address, the order) goes to a stranger. There is no safe guess here, so
   * the answer is «no number» and the strip says why. Only a number that carries its own country is let
   * through without one: a leading «+» in what was typed, «00…» (above), or eleven digits and up (above).
   */
  return (raw || '').trim().startsWith('+') ? digits : '';
}

/** Can a WhatsApp link be built for this number: is the country known, or is the number international already? */
export function whatsappReady(phone: string | null | undefined, countryCode?: string | null): boolean {
  return waNumber(phone ?? '', countryCode) !== '';
}

/**
 * THE ONE PLACE A MESSAGE LINK IS BUILT.
 *
 * `wa.me` written into a screen is a screen that will not normalise the
 * number the same way, and there is a guard that fails the build over it.
 * The rule is right and it is older than this function — what was missing
 * was somewhere for a SECOND caller to go.
 *
 * The first caller is the contact strip, messaging a customer from a
 * template. The second is the courier dialog, sending a dispatcher the one
 * sentence that stops a parcel going to the wrong street. Neither of them
 * owns the link format, and neither should discover on its own that a
 * leading zero has to be dropped when a dialling code is prepended.
 *
 * No gateway, here or anywhere: it opens the phone's own WhatsApp with the
 * text already written, so the message leaves from the company's number.
 */
export function whatsappLink(phone: string, countryCode?: string | null, text?: string): string {
  const to = waNumber(phone, countryCode);
  if (!to) return '';
  return text ? `https://wa.me/${to}?text=${encodeURIComponent(text)}` : `https://wa.me/${to}`;
}

export async function templatesFor(companyId: string): Promise<MessageTemplate[]> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  try {
    const stored = (company?.settings ? JSON.parse(company.settings) : {}).messageTemplates;
    // Normalised on the way out, so a template written before situations
    // existed reads as a template and not as a missing field.
    if (Array.isArray(stored) && stored.length > 0) return stored.map(normalizeTemplate);
  } catch {
    /* a broken settings blob must not take the tracking screen down */
  }
  return DEFAULT_TEMPLATES;
}

export async function saveTemplates(
  companyId: string,
  templates: MessageTemplate[]
): Promise<MessageTemplate[]> {
  // Only this key, under a row lock — never the whole document from a read
  // that another save may already have overtaken.
  await updateCompanySettings<MessageTemplate[]>(companyId, 'messageTemplates', () => templates);
  return templates;
}

/**
 * THE ORDER'S OWN LINES AND ADDRESS, FOR THE WORDS A LIST ROW DOES NOT CARRY.
 *
 * The orders list, the tracking list and the queue each hand the message strip a handful of fields; none of them
 * carries the lines. These four placeholders are read from the one order read («GET /api/orders/:id») by the strip
 * itself, so every screen that has an order id gets them and none of them has to remember to.
 */
export const DETAIL_VARS = ['المنتجات', 'الكمية', 'العنوان', 'تاريخ_الطلب'] as const;

/** Does this wording use a placeholder that needs the order's lines or address? */
export function usesOrderDetails(body: string): boolean {
  return DETAIL_VARS.some((v) => body.includes(`{${v}}`));
}

/** The four placeholders, from the order as the single-order door returns it. Pure; money is never touched. */
export function orderDetailsContext(order: {
  createdAt?: string | Date | null;
  deliveryAddress?: string | null;
  customer?: { address?: string | null } | null;
  items?: { productName: string; quantity: number; freeQuantity?: number | null }[] | null;
}): Pick<FillContext, 'products' | 'quantity' | 'address' | 'orderDate'> {
  const items = order.items ?? [];
  const products = items
    .map((i) => `${i.productName} × ${i.quantity}${i.freeQuantity ? ` (+ ${i.freeQuantity} هدية)` : ''}`)
    .join('، ');
  const created = order.createdAt ? new Date(order.createdAt) : null;
  const orderDate =
    created && !Number.isNaN(created.getTime())
      ? `${String(created.getDate()).padStart(2, '0')}/${String(created.getMonth() + 1).padStart(2, '0')}/${created.getFullYear()}`
      : null;
  return {
    products: products || null,
    quantity: items.length > 0 ? items.reduce((n, i) => n + i.quantity, 0) : null,
    address: order.deliveryAddress || order.customer?.address || null,
    orderDate,
  };
}
