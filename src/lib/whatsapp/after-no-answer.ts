import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from '../company-settings';
import type { db } from '../db';
import { effectiveStatus, getActiveConnection } from './connection';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «واتساب بعد لا يرد» — FROM WHOSE WHATSAPP, PER COUNTRY.
 *
 * After a call nobody answered, the agent may message the customer:
 *
 *   AGENT   — from her own WhatsApp, with a ready message (`ContactButtons`). What has always happened, and the default.
 *   COMPANY — from the company's Cloud API number, as an approved Meta TEMPLATE: a message the business starts outside the
 *             24-hour window must be a template, or Meta refuses it.
 *
 * Chosen per country, by its calling code, because Meta does not deliver business messages to recipients in Syria while
 * Jordan works — one switch for the company would be wrong for one of the two.
 *
 * Stored in `Company.settings.whatsappAfterNoAnswer` (no column, no migration), written under the row lock
 * (`updateCompanySettings`), as `no-answer-rounds-switch.ts` stores its switch.
 *
 * ── AGENT UNLESS IT IS PLAINLY COMPANY ──
 *
 * A missing key, a broken document, a country not written down, a value that is not the exact word `COMPANY`, and a read that
 * FAILS are all AGENT — today's screen. A send from the company's number never turns itself on by an error, and even COMPANY
 * sends nothing while the number is not connected: the door asks the connection on every press.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const AFTER_NO_ANSWER_KEY = 'whatsappAfterNoAnswer';
export const AFTER_NO_ANSWER_CACHE_MS = 10_000;

export type WhatsAppRoute = 'AGENT' | 'COMPANY';
export const TEMPLATE_PARAMS = ['none', 'name', 'name_order'] as const;
export type TemplateParams = (typeof TEMPLATE_PARAMS)[number];

export interface AfterNoAnswer {
  /** Calling code (digits) → route. A code that is not here is AGENT. */
  byDialCode: Record<string, WhatsAppRoute>;
  /** The approved template's name in Meta, exactly as Meta has it. Empty = none yet: nothing is sent from the company. */
  templateName: string;
  /** The template's language code in Meta («ar», «en_US»). */
  templateLang: string;
  /** What fills the template's body: nothing, the customer's name, or the name then the order number. */
  templateParams: TemplateParams;
}

export const AFTER_NO_ANSWER_DEFAULT: AfterNoAnswer = Object.freeze({
  byDialCode: Object.freeze({}) as Record<string, WhatsAppRoute>,
  templateName: '',
  templateLang: 'ar',
  templateParams: 'none',
}) as AfterNoAnswer;

/** Meta's template names: lower-case letters, digits and «_», up to 512. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** «ar», «en», «en_US», «pt_BR». */
const TEMPLATE_LANG = /^[a-z]{2,3}(?:_[A-Z]{2})?$/;
/** A calling code: one to four digits, no leading zero. */
const DIAL_CODE = /^[1-9]\d{0,3}$/;

function plain(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A stored value as this build understands it — what cannot be read is the default, piece by piece. */
export function parseAfterNoAnswer(raw: unknown): AfterNoAnswer {
  const o = plain(raw);
  const byDialCode: Record<string, WhatsAppRoute> = {};
  for (const [code, route] of Object.entries(plain(o.byDialCode))) {
    if (DIAL_CODE.test(code) && route === 'COMPANY') byDialCode[code] = 'COMPANY';
    else if (DIAL_CODE.test(code) && route === 'AGENT') byDialCode[code] = 'AGENT';
  }
  const templateName = typeof o.templateName === 'string' && TEMPLATE_NAME.test(o.templateName) ? o.templateName : '';
  const templateLang = typeof o.templateLang === 'string' && TEMPLATE_LANG.test(o.templateLang) ? o.templateLang : 'ar';
  const templateParams = (TEMPLATE_PARAMS as readonly unknown[]).includes(o.templateParams)
    ? (o.templateParams as TemplateParams)
    : 'none';
  return { byDialCode, templateName, templateLang, templateParams };
}

/** The route for one country. No code, an unknown code, anything but COMPANY: AGENT. */
export function routeFor(setting: AfterNoAnswer, dialCode: string | null | undefined): WhatsAppRoute {
  if (!dialCode) return 'AGENT';
  return setting.byDialCode[dialCode] === 'COMPANY' ? 'COMPANY' : 'AGENT';
}

/**
 * A SAVE IS CHECKED WHOLE, AND REFUSED IN ARABIC — not quietly turned into the default, which would tell the owner his
 * choice was saved when it was not.
 */
export function validateAfterNoAnswer(raw: unknown): { ok: true; value: AfterNoAnswer } | { ok: false; errorAr: string } {
  const o = plain(raw);
  const allowed = ['byDialCode', 'templateName', 'templateLang', 'templateParams'];
  if (!raw || typeof raw !== 'object' || Object.keys(o).some((k) => !allowed.includes(k))) {
    return { ok: false, errorAr: 'الإعداد غير مفهوم — أرسل الدول واسم القالب ولغته وما يُملأ فيه فقط.' };
  }
  const byDialCode: Record<string, WhatsAppRoute> = {};
  for (const [code, route] of Object.entries(plain(o.byDialCode))) {
    if (!DIAL_CODE.test(code)) return { ok: false, errorAr: `رمز الدولة «${code}» غير صالح.` };
    if (route !== 'AGENT' && route !== 'COMPANY') return { ok: false, errorAr: 'اختر لكل دولة: من واتساب الموظفة أو من رقم الشركة.' };
    byDialCode[code] = route;
  }
  const name = typeof o.templateName === 'string' ? o.templateName.trim() : o.templateName === undefined ? '' : null;
  if (name === null || (name !== '' && !TEMPLATE_NAME.test(name))) {
    return { ok: false, errorAr: 'اسم القالب بأحرف إنجليزية صغيرة وأرقام و«_» فقط، متل ما هو بميتا.' };
  }
  const lang = typeof o.templateLang === 'string' && o.templateLang.trim() ? o.templateLang.trim() : o.templateLang === undefined ? 'ar' : null;
  if (lang === null || !TEMPLATE_LANG.test(lang)) {
    return { ok: false, errorAr: 'لغة القالب متل ما هي بميتا: «ar» أو «en_US».' };
  }
  const params = o.templateParams === undefined ? 'none' : o.templateParams;
  if (!(TEMPLATE_PARAMS as readonly unknown[]).includes(params)) {
    return { ok: false, errorAr: 'اختر ما يُملأ بالقالب: لا شيء، أو اسم الزبون، أو الاسم ورقم الطلب.' };
  }
  return { ok: true, value: { byDialCode, templateName: name, templateLang: lang, templateParams: params as TemplateParams } };
}

/** The template body's parameters, in the order the template declares them. */
export function templateBodyValues(
  params: TemplateParams,
  order: { customerName: string | null | undefined; orderNumber: string | null | undefined }
): string[] {
  const name = (order.customerName ?? '').trim() || 'زبوننا';
  if (params === 'name') return [name];
  if (params === 'name_order') return [name, (order.orderNumber ?? '').trim() || '—'];
  return [];
}

const cache = new Map<string, { value: AfterNoAnswer; at: number }>();

/** This company's setting — cached, and the default (AGENT everywhere) on any failure. */
export async function afterNoAnswer(client: Client, companyId: string, nowMs: number = Date.now()): Promise<AfterNoAnswer> {
  const hit = cache.get(companyId);
  if (hit && nowMs - hit.at < AFTER_NO_ANSWER_CACHE_MS) return hit.value;
  let value: AfterNoAnswer = AFTER_NO_ANSWER_DEFAULT;
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    value = parseAfterNoAnswer((company?.settings ? JSON.parse(company.settings) : {})[AFTER_NO_ANSWER_KEY]);
  } catch {
    value = AFTER_NO_ANSWER_DEFAULT;
  }
  cache.set(companyId, { value, at: nowMs });
  return value;
}

/**
 * WILL «ابعت من رقم الشركة» BE OFFERED for this country — COMPANY, a template named, and the number connected now. Asked by
 * «طلباتي» once per load, so the sheet draws the agent's own WhatsApp exactly as before whenever any of the three is missing.
 * The send door asks all three again on the press. Any failure: no.
 */
export async function companySendsFor(client: Client, companyId: string, dialCode: string | null | undefined): Promise<boolean> {
  try {
    const setting = await afterNoAnswer(client, companyId);
    if (routeFor(setting, dialCode) !== 'COMPANY' || !setting.templateName) return false;
    return effectiveStatus(await getActiveConnection(companyId)) === 'CONNECTED';
  } catch {
    return false;
  }
}

/** Forget what was read — a save does it, and so may a test. */
export function forgetAfterNoAnswer(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/** Save the whole setting (already validated); only this key of the document is touched. */
export async function saveAfterNoAnswer(companyId: string, value: AfterNoAnswer): Promise<AfterNoAnswer> {
  const stored = await updateCompanySettings<AfterNoAnswer>(companyId, AFTER_NO_ANSWER_KEY, () => value);
  const saved = parseAfterNoAnswer(stored);
  cache.set(companyId, { value: saved, at: Date.now() });
  return saved;
}
