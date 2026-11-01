import type { Prisma } from '@prisma/client';
import { normalizePhoneNumber } from './phone';
import { readTypedFigure } from './numeric-input';

/**
 * ترحيل طلبات قديمة — طلبات انشحنت فعلاً خارج النظام (ملفات «طلبات سوريا»)، تُكتب كما هي.
 *
 * ── ليش باب لحاله ──
 * باب الطلبات اليومي (`POST /api/orders`) ينشئ طلباً «جديداً» اليوم، ثم التأكيد ثم دفعة الشحن — ودفعة الشحن تعيد حساب
 * المبلغ من جدول الأجور. لطلب انشحن قبل أيام وقبض المندوب مبلغه المكتوب، هذا يغيّر مبلغه وتاريخه ويضيّع رقمه الذي
 * سيأتي به كشف المندوب. هذا الباب يكتب ما في الملف: المبلغ، والتاريخ، ورقم الطلب (`merchantRef`)، وشركة الشحن،
 * والحالة «مؤكّد ومشحون» — ولا يحسب مالاً: المبلغ هو المكتوب.
 *
 * ── المخزون: مرة واحدة ──
 * كل طلب مرحّل يحجز وحداته (`reserveOrderLines`) فينزل المتاح مرة. التسليم لاحقاً يستهلك الدفعات ويُنهي الحجز في
 * اللحظة نفسها، فلا خصم ثانٍ. الكمية بالملف تشمل وحدة الهدية («ماء الكمأ × 3 = 25$» عبوتان + الثالثة)، فتُكتب كما
 * هي كوحدات السطر، وتكلفة البضاعة على كل الوحدات.
 *
 * ── ما لا يفعله ──
 * لا إشعارات، ولا أحداث للأنظمة الأخرى، ولا تحويلات إعلانية: هذه طلبات قديمة، وإعلانها اليوم كذب على كل من يستقبلها.
 *
 * هذا الملف: قراءة الملف (`readMigrationSheet`)، وخطة المطابقة (`planMigration` — نقية، لا قاعدة بيانات)، والكتابة
 * (`writeMigratedOrder`) داخل معاملة واحدة لكل طلب.
 */

/** How a row is recognised as an order already in the system — the owner's choice on the screen. */
export const MATCHING_MODES = ['ref_and_phone', 'ref', 'phone', 'none'] as const;
export type MatchingMode = (typeof MATCHING_MODES)[number];

export const MATCHING_AR: Record<MatchingMode, string> = {
  ref_and_phone: 'رقم الطلب + رقم الهاتف معاً',
  ref: 'رقم الطلب فقط',
  phone: 'رقم الهاتف فقط',
  none: 'بلا مطابقة — كل صف طلب',
};

/** The source written on every migrated order — how a migrated order is told apart later. */
export const MIGRATION_SOURCE = 'ترحيل';

/** The columns this door reads, and the spellings real sheets have used. */
const COLUMNS = {
  ref: ['order number', 'ordernumber', 'رقم الطلب', 'id'],
  name: ['customer name', 'customername', 'اسم العميل', 'الاسم'],
  phone: ['phone number', 'phonenumber', 'phone', 'رقم الهاتف', 'الهاتف'],
  address: ['address', 'العنوان'],
  region: ['region name', 'regionname', 'region', 'المحافظة', 'المدينة'],
  courier: ['shipping company', 'shippingcompany', 'courier', 'شركة الشحن'],
  total: ['total price', 'totalprice', 'total', 'السعر', 'المبلغ'],
  product: ['product name', 'productname', 'product', 'المنتج'],
  quantity: ['quantity', 'qty', 'الكمية'],
} as const;
type ColumnKey = keyof typeof COLUMNS;
const REQUIRED: ColumnKey[] = ['ref', 'phone', 'total', 'product', 'quantity'];

const norm = (s: unknown) => String(s ?? '').replace(/[‎‏*]/g, '').trim().toLowerCase();

export interface SourceRow {
  /** The file it came from, as uploaded. */
  file: string;
  /** 1-based, counting the header — the line a person finds in the spreadsheet. */
  line: number;
  /** The day it shipped (YYYY-MM-DD) — the file's day. */
  date: string;
  ref: string;
  name: string;
  rawPhone: string;
  /** Normalized — the form customers are matched on. Empty when the cell was. */
  phone: string;
  address: string;
  region: string;
  courier: string;
  /** What the customer pays, from the sheet — null when the cell is empty or unreadable. */
  total: number | null;
  product: string;
  /** Units leaving the shelf (gift included) — null when unreadable. */
  quantity: number | null;
}

export interface ReadSheet {
  rows: SourceRow[];
  /** Columns the door needs and the sheet does not have (Arabic names). */
  missing: string[];
}

const COLUMN_AR: Record<ColumnKey, string> = {
  ref: 'رقم الطلب', name: 'اسم العميل', phone: 'رقم الهاتف', address: 'العنوان', region: 'المحافظة',
  courier: 'شركة الشحن', total: 'السعر', product: 'المنتج', quantity: 'الكمية',
};

/** A sheet's rows (header first) as migration rows. Blank lines are skipped, never counted. */
export function readMigrationSheet(sheet: string[][], file: string, date: string, countryCode?: string | null): ReadSheet {
  const [header = [], ...body] = sheet;
  const at: Partial<Record<ColumnKey, number>> = {};
  header.forEach((cell, i) => {
    const n = norm(cell);
    for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
      if (at[key] === undefined && (COLUMNS[key] as readonly string[]).includes(n)) at[key] = i;
    }
  });
  const missing = REQUIRED.filter((k) => at[k] === undefined).map((k) => COLUMN_AR[k]);
  if (missing.length) return { rows: [], missing };

  const cell = (r: string[], k: ColumnKey) => (at[k] === undefined ? '' : String(r[at[k]!] ?? '').trim());
  const rows: SourceRow[] = [];
  body.forEach((r, i) => {
    if (!r || r.every((c) => !String(c ?? '').trim())) return;
    const rawPhone = cell(r, 'phone');
    const total = readFigure(cell(r, 'total'));
    const qty = readFigure(cell(r, 'quantity'));
    rows.push({
      file,
      line: i + 2,
      date,
      ref: cell(r, 'ref').replace(/\.0+$/, ''),
      name: cell(r, 'name'),
      rawPhone,
      phone: rawPhone ? normalizePhoneNumber(rawPhone, countryCode) : '',
      address: cell(r, 'address'),
      region: cell(r, 'region'),
      courier: cell(r, 'courier'),
      total: total !== null && total > 0 ? total : null,
      product: cell(r, 'product'),
      quantity: qty !== null && Number.isInteger(qty) && qty > 0 ? qty : null,
    });
  });
  return { rows, missing: [] };
}

/** A typed figure («20.0», «25») — the shared reader, so «0x10» is refused here as everywhere. */
function readFigure(raw: string): number | null {
  if (!raw) return null;
  const v = readTypedFigure(raw);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type Verdict = 'NEW' | 'DUPLICATE_IN_FILE' | 'IN_SYSTEM' | 'REFUSED';

export interface PlannedRow {
  row: SourceRow;
  verdict: Verdict;
  /** Why it is refused, or which row/order it repeats — Arabic, for the screen. */
  reasons: string[];
  productId: string | null;
  productName: string | null;
  courierId: string | null;
  regionId: string | null;
}

export interface Known {
  /** merchantRef → the phone of that order's customer, for every order of the company that carries one of these refs. */
  refs: Map<string, string>;
  /** Phones (normalized) that already have an order in this store. */
  phones: Set<string>;
}

export interface Lookups {
  products: { id: string; name: string }[];
  couriers: { id: string; name: string }[];
  regions: { id: string; name: string }[];
  /** Where a row with no shipping company goes. */
  defaultCourierId: string | null;
  validPhone: (raw: string) => boolean;
}

const byName = <T extends { name: string }>(list: T[], name: string) => {
  const n = norm(name);
  return n ? list.find((x) => norm(x.name) === n) ?? null : null;
};

/** The key two rows share when they are the same order, by the chosen mechanism — or null when nothing is matched. */
export function matchKey(row: Pick<SourceRow, 'ref' | 'phone'>, mode: MatchingMode): string | null {
  switch (mode) {
    case 'ref_and_phone':
      return `${row.ref}|${row.phone}`;
    case 'ref':
      return row.ref;
    case 'phone':
      return row.phone;
    default:
      return null;
  }
}

/**
 * WHAT WOULD HAPPEN TO EACH ROW — and nothing is written.
 *
 * In this order: a row that cannot be an order is REFUSED (no price, no product, a phone that is no phone, a courier
 * nobody knows); one the system already has is IN_SYSTEM; one an earlier row of the upload already is, is a
 * DUPLICATE_IN_FILE. What is left is NEW. A NEW row whose order number another order already carries is refused too:
 * the number is how the courier's statement finds the order, and two orders cannot answer to one.
 */
export function planMigration(rows: SourceRow[], known: Known, lookups: Lookups, mode: MatchingMode): PlannedRow[] {
  const seen = new Map<string, SourceRow>();
  const refsTaken = new Map<string, SourceRow>();
  return rows.map((row) => {
    const product = byName(lookups.products, row.product);
    const courier = row.courier ? byName(lookups.couriers, row.courier) : null;
    const courierId = row.courier ? courier?.id ?? null : lookups.defaultCourierId;
    const region = byName(lookups.regions, row.region);
    const base = { row, productId: product?.id ?? null, productName: product?.name ?? null, courierId, regionId: region?.id ?? null };

    const refusals: string[] = [];
    if (row.total === null) refusals.push('بلا سعر');
    if (!row.ref) refusals.push('بلا رقم طلب');
    if (row.quantity === null) refusals.push('الكمية غير مقروءة');
    if (!row.rawPhone || !lookups.validPhone(row.rawPhone)) refusals.push('رقم هاتف غير صالح');
    if (!product) refusals.push(`منتج غير موجود بالمتجر: «${row.product || '—'}»`);
    if (row.courier && !courier) refusals.push(`شركة شحن غير معروفة: «${row.courier}»`);
    if (!row.courier && !lookups.defaultCourierId) refusals.push('بلا شركة شحن ولا شركة افتراضية');
    if (refusals.length) return { ...base, verdict: 'REFUSED' as const, reasons: refusals };

    const key = matchKey(row, mode);
    const inSystem =
      mode === 'ref_and_phone' ? known.refs.get(row.ref) === row.phone
      : mode === 'ref' ? known.refs.has(row.ref)
      : mode === 'phone' ? known.phones.has(row.phone)
      : false;
    if (inSystem) return { ...base, verdict: 'IN_SYSTEM' as const, reasons: ['موجود بالنظام — يُتخطّى'] };

    if (key !== null && seen.has(key)) {
      const first = seen.get(key)!;
      return { ...base, verdict: 'DUPLICATE_IN_FILE' as const, reasons: [`يكرّر «${first.file}» سطر ${first.line} — يُتخطّى`] };
    }

    if (known.refs.has(row.ref)) {
      return { ...base, verdict: 'REFUSED' as const, reasons: ['رقم الطلب يحمله طلب آخر بالنظام (زبون آخر)'] };
    }
    if (refsTaken.has(row.ref)) {
      const first = refsTaken.get(row.ref)!;
      return { ...base, verdict: 'REFUSED' as const, reasons: [`رقم الطلب نفسه بـ«${first.file}» سطر ${first.line} لزبون آخر`] };
    }

    if (key !== null) seen.set(key, row);
    refsTaken.set(row.ref, row);
    return { ...base, verdict: 'NEW' as const, reasons: [] };
  });
}

export interface MigrationSummary {
  total: number;
  counts: Record<Verdict, number>;
  /** Units the NEW rows will hold, per product name. */
  units: Record<string, number>;
  /** How many NEW rows go to each courier (by id). */
  byCourier: Record<string, number>;
}

export function summarize(planned: PlannedRow[]): MigrationSummary {
  const counts: Record<Verdict, number> = { NEW: 0, DUPLICATE_IN_FILE: 0, IN_SYSTEM: 0, REFUSED: 0 };
  const units: Record<string, number> = {};
  const byCourier: Record<string, number> = {};
  for (const p of planned) {
    counts[p.verdict]++;
    if (p.verdict !== 'NEW') continue;
    units[p.productName!] = (units[p.productName!] ?? 0) + (p.row.quantity ?? 0);
    byCourier[p.courierId!] = (byCourier[p.courierId!] ?? 0) + 1;
  }
  return { total: planned.length, counts, units, byCourier };
}

/** The day, at noon in Syria — a time that is the same date whatever zone reads it. */
export function shippedAt(date: string): Date {
  return new Date(`${date}T12:00:00+03:00`);
}

export interface WriteContext {
  companyId: string;
  storeId: string;
  countryId: string;
  orderPrefix: string;
  currency: string;
  minorUnit: number;
  allowNegativeStock: boolean;
  user: { id: string; name: string; role: string };
}

export interface WriteDeps {
  findOrCreateCustomer: (tx: Prisma.TransactionClient, seed: {
    companyId: string; storeId: string; phone: string; rawPhone: string; fullName: string; address: string; city: string;
  }) => Promise<{ id: string; firstOrderDate: Date | null }>;
  orderRefFields: (tx: Prisma.TransactionClient, companyId: string, prefix: string, attempt: number, now: Date) => Promise<{ orderNumber: string; merchantRef: string }>;
  /**
   * What ONE unit of the product costs an order: the fixed figure an admin set for it, otherwise the weighted average of the stock
   * on hand (`unitCostsOf`). It was `averageCost`, and the name was the policy; the policy is the owner's now («ثابت لكل الطلبات»).
   */
  unitCost: (tx: Prisma.TransactionClient, companyId: string, productId: string) => Promise<number>;
  deliveryFee: (tx: Prisma.TransactionClient, p: { deliveryProviderId: string; regionId: string | null; minorUnit: number }) => Promise<number>;
  reserve: (tx: Prisma.TransactionClient, orderId: string, opts: { allowNegativeStock: boolean }) => Promise<{ shortages: unknown[] }>;
}

const round = (n: number, minor: number) => Math.round(n * 10 ** minor) / 10 ** minor;

/**
 * ONE MIGRATED ORDER, INSIDE THE CALLER'S TRANSACTION.
 *
 * The figures are the sheet's: `totalAmount` is what the customer pays and nothing recomputes it
 * (`priceIncludesDelivery: true` — the sheets sell with free delivery, so the price already carries it). The courier's
 * fee for the region is written beside it, because it is what the statement will have kept. The order number is the
 * sheet's, so the courier's statement finds it.
 */
export async function writeMigratedOrder(
  tx: Prisma.TransactionClient,
  ctx: WriteContext,
  p: PlannedRow,
  deps: WriteDeps
): Promise<{ orderId: string; orderNumber: string; shortage: boolean }> {
  if (p.verdict !== 'NEW' || !p.productId || !p.courierId || p.row.total === null || p.row.quantity === null) {
    throw new Error('only a NEW, complete row is written');
  }
  const { row } = p;
  const at = shippedAt(row.date);
  const units = row.quantity!;
  const total = round(row.total!, ctx.minorUnit);

  const customer = await deps.findOrCreateCustomer(tx, {
    companyId: ctx.companyId,
    storeId: ctx.storeId,
    phone: row.phone,
    rawPhone: row.rawPhone,
    fullName: row.name || row.rawPhone,
    address: row.address,
    city: row.region,
  });
  const cost = await deps.unitCost(tx, ctx.companyId, p.productId);
  const fee = await deps.deliveryFee(tx, { deliveryProviderId: p.courierId, regionId: p.regionId, minorUnit: ctx.minorUnit });

  let order: { id: string; orderNumber: string } | null = null;
  for (let attempt = 0; attempt < 5 && !order; attempt++) {
    const refs = await deps.orderRefFields(tx, ctx.companyId, ctx.orderPrefix, attempt, at);
    try {
      order = await tx.order.create({
        data: {
          companyId: ctx.companyId,
          countryId: ctx.countryId,
          storeId: ctx.storeId,
          orderNumber: refs.orderNumber,
          merchantRef: row.ref,
          regionId: p.regionId,
          priceIncludesDelivery: true,
          customerId: customer.id,
          productId: p.productId,
          quantity: units,
          sellingPrice: total,
          shippingCost: 0,
          deliveryFee: fee,
          totalAmount: total,
          currency: ctx.currency,
          createdById: ctx.user.id,
          estimatedCostOfGoods: round(cost * units, ctx.minorUnit),
          productNameSnapshot: p.productName,
          status: 'SHIPPED',
          confirmationStatus: 'CONFIRMED',
          shippingStatus: 'SHIPPED',
          settlementStatus: 'PENDING_COLLECTION',
          confirmedAt: at,
          shippedAt: at,
          deliveryProviderId: p.courierId,
          deliveryAssignedAt: at,
          deliveryAssignedById: ctx.user.id,
          signatureStatus: 'UNSIGNED',
          version: 1,
          source: MIGRATION_SOURCE,
          internalNotes: `مرحّل من «${row.file}» سطر ${row.line}`,
          createdAt: at,
        },
        select: { id: true, orderNumber: true },
      });
    } catch (e) {
      // A clash on the generated number is retried; a clash on the sheet's own number is the caller's to report.
      const target = String((e as { meta?: { target?: unknown } })?.meta?.target ?? '');
      if ((e as { code?: string })?.code === 'P2002' && !target.includes('merchantRef') && attempt < 4) continue;
      throw e;
    }
  }
  if (!order) throw new Error('Failed to generate a unique order number');

  await tx.orderItem.create({
    data: {
      companyId: ctx.companyId,
      orderId: order.id,
      productId: p.productId,
      productName: p.productName ?? row.product,
      quantity: units,
      freeQuantity: 0,
      unitPrice: total / units,
      discountShare: 0,
      lineTotal: total,
      addedById: ctx.user.id,
      addedStage: 'INTAKE',
    },
  });

  await tx.customer.update({
    where: { id: customer.id },
    data: { totalOrders: { increment: 1 }, lastOrderDate: at, ...(customer.firstOrderDate ? {} : { firstOrderDate: at }) },
  });

  const reserved = await deps.reserve(tx, order.id, { allowNegativeStock: ctx.allowNegativeStock });

  const log = (statusType: string, previousValue: string, newValue: string) =>
    tx.orderStatusLog.create({
      data: {
        companyId: ctx.companyId, orderId: order!.id, statusType, previousValue, newValue,
        changedById: ctx.user.id, changedByRole: ctx.user.role, note: `ترحيل — «${row.file}» سطر ${row.line}`, createdAt: at,
      },
    });
  await log('CONFIRMATION', 'NEW', 'CONFIRMED');
  await log('SHIPPING', 'NOT_READY', 'SHIPPED');

  await tx.orderActivity.create({
    data: {
      companyId: ctx.companyId,
      orderId: order.id,
      userId: ctx.user.id,
      action: 'ORDER_CREATED',
      newStatus: 'SHIPPED',
      metadata: JSON.stringify({ source: MIGRATION_SOURCE, file: row.file, line: row.line, createdBy: ctx.user.name }),
    },
  });

  return { orderId: order.id, orderNumber: order.orderNumber, shortage: reserved.shortages.length > 0 };
}
