import { z } from 'zod';
import { landingThemeSchema } from './landing-theme';
import { toLatinDigits } from './latin-digits';
import { WORK_HOURS_FORMAT_MESSAGE } from './work-hours';

/** Request schemas for /api/geo/* — shared so create and update stay identical. */

// The format half of the working-hours rule; the order half (start before end,
// judged against the stored row for a half that was not sent) lives in
// `workHoursError` (work-hours.ts), which the create and update routes call.
const hhmm = z
  .string({ error: WORK_HOURS_FORMAT_MESSAGE })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, WORK_HOURS_FORMAT_MESSAGE);

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'منطقة زمنية غير صالحة');

export const countryCreateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'رمز البلد حرفان (ISO)'),
  name: z.string().trim().min(2).max(60),
  currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'رمز العملة ثلاثة أحرف (ISO)'),
  minorUnit: z.number().int().min(0).max(4),
  workHoursStart: hhmm.default('09:00'),
  workHoursEnd: hhmm.default('17:00'),
  weekendDays: z
    .array(z.number().int().min(0).max(6))
    .max(6)
    .refine((d) => new Set(d).size === d.length, 'أيام العطلة مكررة')
    .default([5]),
  timezone: timezone.default('Asia/Damascus'),
  orderPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'بادئة الطلب 1-6 أحرف/أرقام').default('ORD'),
  allowNegativeStock: z.boolean().default(false),
});

// Update: every field optional, no defaults re-applied; isActive replaces delete.
export const countryUpdateSchema = z
  .object({
    code: countryCreateSchema.shape.code,
    name: countryCreateSchema.shape.name,
    currencyCode: countryCreateSchema.shape.currencyCode,
    minorUnit: countryCreateSchema.shape.minorUnit,
    workHoursStart: hhmm,
    workHoursEnd: hhmm,
    weekendDays: z
      .array(z.number().int().min(0).max(6))
      .max(6)
      .refine((d) => new Set(d).size === d.length, 'أيام العطلة مكررة'),
    timezone,
    orderPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/),
    allowNegativeStock: z.boolean(),
    isActive: z.boolean(),
  })
  .partial()
  .strict();

export const regionCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

export const STORE_STATUSES = ['ACTIVE', 'PAUSED'] as const;
export const STORE_TYPES = ['MULTI_PRODUCT', 'SINGLE_PRODUCT'] as const;

export const storeCreateSchema = z.object({
  countryId: z.string().uuid('يجب اختيار البلد'),
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'المعرّف: أحرف إنجليزية صغيرة وأرقام وشرطات'),
  logo: z.string().url().max(500).optional(),
  status: z.enum(STORE_STATUSES).default('ACTIVE'),
  type: z.enum(STORE_TYPES).default('MULTI_PRODUCT'),
});

// countryId is intentionally absent: a store never moves between countries.
export const storeUpdateSchema = z
  .object({
    name: storeCreateSchema.shape.name,
    slug: storeCreateSchema.shape.slug,
    logo: z.string().url().max(500).nullable(),
    status: z.enum(STORE_STATUSES),
    type: z.enum(STORE_TYPES),
    /** Whether an advertised price already includes delivery — read on every direct order. */
    priceIncludesDelivery: z.boolean(),
    // ─── The store's public face ───
    // '' clears a field; the storefront then simply shows one thing less.
    storefrontEnabled: z.boolean(),
    // `theme` is deliberately absent. The store's look has one editor —
    // PATCH /api/store/theme, under storefront.manage — and it writes the
    // WHOLE theme: the palette plus the header, footer, product display,
    // checkout and home order. Accepting a theme here too meant a form that
    // knew only the palette could write one back with the rest missing.
    tagline: z.string().trim().max(120).nullable(),
    about: z.string().trim().max(2000).nullable(),
    // Printed on the waybill and dialled from the storefront: a phone number,
    // with the digits an Arabic keyboard types read as 0-9.
    supportPhone: z
      .string()
      .transform((v) => toLatinDigits(v).trim() || null)
      .refine((v) => v === null || /^\+?[\d\s()-]{6,24}$/.test(v), 'رقم هاتف الدعم غير صالح — أرقام فقط، ويمكن أن يبدأ بـ +')
      .nullable(),
    // `domain` is deliberately absent, for the same reason as `theme` and
    // with a sharper edge.
    //
    // It was accepted here as a plain string and written straight through,
    // while the real editor — PATCH /api/store/domain, under
    // storefront.manage — clears `domainVerifiedAt` whenever the domain
    // changes and only ever sets it again after a real DNS lookup.
    //
    // So an owner who edited the domain on THIS form moved the address and
    // left the old verification standing: the store then reported itself
    // verified for a host nobody had checked, and the customer met an error
    // page while the dashboard showed a tick.
    //
    // `.strict()` means a body carrying it is now refused outright rather
    // than quietly ignored — a form that still sends one finds out.
  })
  .partial()
  .strict();

/**
 * DELETE /api/geo/stores/:id — the shop's own name, typed, is the second key.
 *
 * A button can be pressed by a finger that meant the one beside it, and a
 * store is the one thing here that takes its address, its pages and its look
 * with it. The route compares this with the stored name; the schema only says
 * it must be there and that nothing else may ride along.
 */
export const storeDeleteSchema = z.object({ confirm: z.string().min(1, 'اكتب اسم المتجر لتأكيد الحذف') }).strict();

export const contextSelectSchema = z.object({
  countryId: z.string().uuid(),
  storeId: z.string().uuid().nullable().optional(),
});

export const geoAccessSchema = z.object({
  countryIds: z.array(z.string().uuid()).max(200),
  storeIds: z.array(z.string().uuid()).max(500).default([]),
});

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message || 'بيانات غير صالحة';
}
