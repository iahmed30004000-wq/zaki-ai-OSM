import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { looksLikeXlsx, readXlsxRows } from '@/lib/xlsx-reader';
import { isValidPhoneFor } from '@/lib/phone-rules';
import { findOrCreateCustomer } from '@/lib/customer-identity';
import { orderRefFields } from '@/lib/order-ref';
import { unitCostsOf } from '@/lib/product-fixed-cost';
import { resolveDeliveryFee } from '@/lib/delivery-fees';
import { reserveOrderLines } from '@/lib/reservation';
import {
  MATCHING_MODES,
  planMigration,
  readMigrationSheet,
  summarize,
  writeMigratedOrder,
  type Known,
  type MatchingMode,
  type PlannedRow,
  type SourceRow,
} from '@/lib/order-migration';

/**
 * POST /api/orders/import/migrate — ترحيل طلبات قديمة من ملفات المندوب.
 *
 * multipart: `files` (xlsx، واحد أو أكثر) · `dates` (YYYY-MM-DD لكل ملف بنفس الترتيب) · `matching` (آلية المطابقة)
 * · `defaultCourierId` (لمن لا شركة شحن بصفه؛ الافتراضي «الباشا») · `apply` («1» يكتب، غيره معاينة فقط).
 *
 * المعاينة لا تكتب شيئاً. التطبيق يكتب كل طلب جديد بمعاملة لحاله — فطلب يفشل هو طلب واحد، لا تراجع عن الباقين.
 * الجواب لا يحمل اسماً ولا هاتفاً ولا عنواناً: ملف وسطر وسبب فقط.
 *
 * للمالك وحده: `orders.import` و`orders.migrate` معاً — باب يكتب طلبات مؤكّدة ومشحونة بتاريخ ماضٍ ليس لكل من يستورد.
 */

const MAX_FILES = 10;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 3000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_COURIER = 'الباشا';

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('orders.import');
    if (!can(user, 'orders.migrate')) {
      return NextResponse.json({ error: forbiddenAr('Forbidden: missing required permission orders.migrate'), code: 'OWNER_ONLY' }, { status: 403 });
    }
    if (!storeId) return NextResponse.json({ error: 'اختر المتجر أولاً', code: 'STORE_REQUIRED' }, { status: 400 });

    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: 'أرسل الملفات' }, { status: 400 });
    const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
    const dates = form.getAll('dates').map(String);
    const matching = String(form.get('matching') ?? 'ref_and_phone') as MatchingMode;
    const apply = form.get('apply') === '1';
    const askedCourier = String(form.get('defaultCourierId') ?? '').trim();

    if (!files.length || files.length > MAX_FILES) return NextResponse.json({ error: `ملف واحد إلى ${MAX_FILES} ملفات` }, { status: 400 });
    if (dates.length !== files.length || dates.some((d) => !DATE.test(d))) {
      return NextResponse.json({ error: 'لكل ملف تاريخ شحن (سنة-شهر-يوم)', code: 'DATE_REQUIRED' }, { status: 400 });
    }
    if (!(MATCHING_MODES as readonly string[]).includes(matching)) return NextResponse.json({ error: 'آلية مطابقة غير معروفة' }, { status: 400 });

    // ── read every file ──
    const rows: SourceRow[] = [];
    for (const [i, file] of files.entries()) {
      if (file.size > MAX_BYTES) return NextResponse.json({ error: `«${file.name}» أكبر من 4 ميجابايت` }, { status: 413 });
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!looksLikeXlsx(bytes)) return NextResponse.json({ error: `«${file.name}» ليس ملف إكسل (xlsx)` }, { status: 400 });
      const read = readMigrationSheet(readXlsxRows(bytes), file.name, dates[i], country.code);
      if (read.missing.length) {
        return NextResponse.json({ error: `«${file.name}» ينقصه: ${read.missing.join('، ')}`, code: 'MISSING_COLUMNS' }, { status: 400 });
      }
      rows.push(...read.rows);
    }
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `أكثر من ${MAX_ROWS} صف بدفعة واحدة` }, { status: 413 });

    // ── what the store has, and what the system already holds ──
    const [products, couriers, regions] = await Promise.all([
      db.product.findMany({ where: { companyId, storeId }, select: { id: true, name: true } }),
      db.deliveryProvider.findMany({ where: { companyId }, select: { id: true, name: true } }),
      db.region.findMany({ where: { countryId: country.id }, select: { id: true, name: true } }),
    ]);
    const defaultCourierId = askedCourier
      ? couriers.find((c) => c.id === askedCourier)?.id ?? null
      : couriers.find((c) => c.name.trim() === DEFAULT_COURIER)?.id ?? null;
    if (askedCourier && !defaultCourierId) return NextResponse.json({ error: 'شركة الشحن الافتراضية غير موجودة' }, { status: 404 });

    const known = await knownOrders(companyId, storeId, rows);
    const planned = planMigration(rows, known, {
      products, couriers, regions, defaultCourierId,
      validPhone: (raw) => isValidPhoneFor(country.code, raw),
    }, matching);
    const summary = summarize(planned);
    const courierName = new Map(couriers.map((c) => [c.id, c.name]));

    const report = {
      matching,
      summary: { ...summary, byCourier: Object.fromEntries(Object.entries(summary.byCourier).map(([id, n]) => [courierName.get(id) ?? id, n])) },
      // File, line and reason — never a name, a phone or an address.
      notNew: planned.filter((p) => p.verdict !== 'NEW').map(lineOf),
    };
    if (!apply) return NextResponse.json({ applied: false, ...report });

    // ── write, one order per transaction ──
    const ctx = {
      companyId, storeId, countryId: country.id, orderPrefix: country.orderPrefix, currency: country.currencyCode,
      minorUnit: country.minorUnit, allowNegativeStock: country.allowNegativeStock,
      user: { id: user.id, name: user.name, role: user.role },
    };
    const deps = {
      findOrCreateCustomer: (tx: never, seed: never) => findOrCreateCustomer(tx, seed),
      orderRefFields: (tx: never, c: string, prefix: string, attempt: number, now: Date) => orderRefFields(tx, c, prefix, attempt, now),
      unitCost: async (tx: never, c: string, productId: string) => (await unitCostsOf(tx, c, [productId])).get(productId) ?? 0,
      deliveryFee: async (tx: never, p: { deliveryProviderId: string; regionId: string | null; minorUnit: number }) => (await resolveDeliveryFee(tx, p)).fee,
      reserve: (tx: never, orderId: string, opts: { allowNegativeStock: boolean }) => reserveOrderLines(tx, orderId, opts),
    };
    let written = 0;
    let shortages = 0;
    const failed: { file: string; line: number; why: string }[] = [];
    for (const p of planned) {
      if (p.verdict !== 'NEW') continue;
      try {
        const out = await db.$transaction((tx) => writeMigratedOrder(tx, ctx, p, deps as never), { timeout: 20_000 });
        written++;
        if (out.shortage) shortages++;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        failed.push({ file: p.row.file, line: p.row.line, why: code === 'P2002' ? 'رقم الطلب مستعمل لطلب آخر' : 'تعذّر الحفظ' });
      }
    }

    await logAudit({
      companyId, userId: user.id, action: 'ORDERS_MIGRATED', entity: 'Store', entityId: storeId,
      newData: { files: files.map((f, i) => ({ name: f.name, date: dates[i] })), matching, written, failed: failed.length, shortages, ...summary.counts },
    });

    return NextResponse.json({ applied: true, written, shortages, failed, ...report });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const lineOf = (p: PlannedRow) => ({ file: p.row.file, line: p.row.line, verdict: p.verdict, reasons: p.reasons });

/** The orders this upload could collide with: every order of the company carrying one of its numbers, and the store's customers who already ordered. */
async function knownOrders(companyId: string, storeId: string, rows: SourceRow[]): Promise<Known> {
  const refs = [...new Set(rows.map((r) => r.ref).filter(Boolean))];
  const phones = [...new Set(rows.map((r) => r.phone).filter(Boolean))];
  const [byRef, byPhone] = await Promise.all([
    refs.length
      ? db.order.findMany({ where: { companyId, merchantRef: { in: refs } }, select: { merchantRef: true, customer: { select: { phone: true } } } })
      : [],
    phones.length
      ? db.order.findMany({ where: { companyId, storeId, customer: { phone: { in: phones } } }, select: { customer: { select: { phone: true } } } })
      : [],
  ]);
  return {
    refs: new Map(byRef.map((o) => [o.merchantRef ?? '', o.customer?.phone ?? ''])),
    phones: new Set(byPhone.map((o) => o.customer?.phone ?? '').filter(Boolean)),
  };
}
