import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { WAYBILL_SELECT, csvCell } from '@/lib/waybill';
import { BATCH_SHEET_HEADER, batchSheetRows, sheetCityIds } from '@/lib/batch-sheet';
import { shipmentListWhere } from '@/lib/batching-guard';
import { assertReadyToShip, type StateSource } from '@/lib/order-state';
import { guardLines } from '@/lib/reservation';
import { activeFeeRowWhere, deliveryFeeBlock } from '@/lib/operations';
import { zodMessage } from '@/lib/zod-message';

/**
 * GET /api/ops/shipments/export?courier&q&region&from&to — «جاهزة للشحن» as a CSV file (the owner, 3/11).
 *
 * «csv عند انشاء الشحنة استخرج الطلبات الجاهزة للشحن مش المؤجلة». The file of the «إنشاء شحنة» screen, before any
 * batch exists: the orders of the «جاهزة للشحن» tab under the same filters and search, and not one of «مؤجَّلة الشحن».
 *
 *   · WHICH ORDERS — the tab's own question (`shipmentListWhere`, `held: false`), never a copy of it; and of those only
 *     the ones the shipment door would take (`assertReadyToShip`, the same lines and add-ons it asks). A postponed order is
 *     not in the question at all; an order whose units are not reserved is in the tab with its warning and not in the file.
 *     Nor one the door refuses for its delivery fee (`deliveryFeeBlock`, the same rule `shipmentBlocks` asks): no
 *     governorate, or no active fee row at THIS courier — its amount would print without the delivery.
 *   · HOW MANY WERE LEFT OUT, AND WHY — said in the answer's headers, not in the file: `X-Left-Held` (the «مؤجَّلة الشحن»
 *     tab under the same filters), `X-Left-Unready` (units not reserved) and `X-Left-Blocked` (no governorate or no fee
 *     row). The file stays a clean sheet for the courier's import.
 *   · THE COLUMNS — the batch's Excel columns exactly (`BATCH_SHEET_HEADER`, `batchSheetRows`): the sheet for making the
 *     parcels at the courier's portal by hand, which is what a file of not-yet-batched orders is for.
 *   · THE AMOUNT — read, not worked out here: `waybillCod`, with the courier this shipment is for, which is the very
 *     computation the shipment's creation records (the courier's fee for the governorate, through `codForOrder`).
 *
 * Names, phones and addresses leaving the building: the screen's key (`ops.ship`) AND the address-book key
 * (`customers.view`), both asked per request, read inside the session's company and store, and counted.
 */
const NO_SHIP = 'إنشاء الشحنات ليس من صلاحيّاتك.';
const NO_CONTACTS = 'الملف فيه أسماء وأرقام وعناوين الزبائن، فيحتاج صلاحية «عرض العملاء». اطلبها من مدير النظام.';
const NO_COURIER = 'اختر شركة الشحن أولاً — المبلغ ورمز المدينة بالملف من أجورها.';
/** A day's work, not a limit anyone meets: a ceiling against a runaway. */
const MAX_ORDERS = 2000;

/**
 * POST /api/ops/shipments/export — THE ORDERS TICKED ON THE SCREEN, from either tab (the owner, 3/11: «خليها تنزل الي بحددو
 * من المؤجل او جاهز»).
 *
 * The ids are the file: each must still be in one of the screen's two lists (`shipmentListWhere`, held or not — the same
 * company, store and «waiting for a trolley» question), and an id that left the list since (shipped, cancelled) is counted
 * out in `X-Left-Gone`, never printed. A ticked order is the owner's own choice, so the stock question is not asked of it: a
 * postponed one gave its units back on purpose, and a ready one that has not is drawn with no checkbox to tick. The fee
 * question IS asked — without a fee row the amount would print without the delivery. A body, not a query: three hundred ids
 * do not fit in an address.
 *
 * WITHOUT A COURIER (the owner, 3/11: «بدي بهاي الخانة فقط أقدر انزل ال csv بدون ما اختار شركة … الهدف اسحب الطلبات فقط
 * اوزع المناطق ع شركات الشحن»): the ticked orders, and only they, may be had with no courier chosen — a sheet for sharing
 * the governorates out between the couriers, not for collecting. It carries NO money: «المبلغ المطلوب» and «العملة» are
 * empty for every order and nothing is read or worked out for them, and «رمز المدينة عند الشركة» is empty (it is a
 * courier's own id). The fee question is a courier's, so it is not asked; the rest is the same sheet, the same keys, the
 * same store and the same tally. The answer says so in `X-No-Courier: 1`. The whole tab (GET) still needs its courier.
 */
const pickedSchema = z.object({
  courier: z.string().min(1).max(64).optional(),
  ids: z.array(z.string().uuid()).min(1).max(MAX_ORDERS),
});

export async function POST(req: Request) {
  const parsed = pickedSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const said = zodMessage(parsed.error);
    return NextResponse.json({ error: said, errorAr: said }, { status: 400 });
  }
  const q = new URLSearchParams(parsed.data.courier ? { courier: parsed.data.courier } : {});
  return fileOf(q, [...new Set(parsed.data.ids)]);
}

export async function GET(req: Request) {
  return fileOf(new URL(req.url).searchParams, null);
}

/** The one builder of the file: `picked` is the ticked ids (POST), or null for the whole «جاهزة للشحن» tab (GET). */
async function fileOf(q: URLSearchParams, picked: string[] | null) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    if (!can(user, 'ops.ship')) return NextResponse.json({ error: NO_SHIP, errorAr: NO_SHIP }, { status: 403 });
    if (!can(user, 'customers.view')) return NextResponse.json({ error: NO_CONTACTS, errorAr: NO_CONTACTS }, { status: 403 });
    if (!storeId) return NextResponse.json({ error: 'اختر المتجر أولاً.', errorAr: 'اختر المتجر أولاً.' }, { status: 400 });

    const courierId = q.get('courier');
    // Only the ticked orders may go without a courier: the whole tab's file is still the courier's sheet.
    if (!courierId && !picked) {
      return NextResponse.json({ error: NO_COURIER, errorAr: NO_COURIER, code: 'NO_COURIER' }, { status: 400 });
    }
    const courier = courierId
      ? await db.deliveryProvider.findFirst({
          where: { id: courierId, companyId },
          select: { id: true, code: true, adapterCode: true },
        })
      : null;
    if (courierId && !courier) {
      return NextResponse.json({ error: 'شركة الشحن غير موجودة', errorAr: 'شركة الشحن غير موجودة' }, { status: 404 });
    }

    // The list's own filters, read the way the list reads them.
    const filters = {
      companyId,
      storeId,
      regionId: q.get('region'),
      productId: q.get('product'),
      search: q.get('q')?.trim() || null,
      from: q.get('from') ? new Date(q.get('from')!) : null,
      to: q.get('to') ? new Date(q.get('to')!) : null,
    };
    const now = new Date();

    const base = { companyId, storeId, now };
    const listed = await db.order.findMany({
      where: picked
        ? { AND: [{ id: { in: picked } }, { OR: [shipmentListWhere({ ...base, held: false }), shipmentListWhere({ ...base, held: true })] }] }
        : shipmentListWhere({ ...filters, held: false, now }),
      orderBy: { createdAt: 'asc' },
      take: MAX_ORDERS,
      select: {
        ...WAYBILL_SELECT,
        // What `assertReadyToShip` asks of the lines and the add-ons, beside what the file prints.
        items: { select: { ...WAYBILL_SELECT.items.select, reservedQty: true } },
        addOns: { select: { ...WAYBILL_SELECT.addOns.select, reservedQty: true } },
      },
    });
    // Ticked by hand, nothing was left out for being postponed; what left the lists since the tick is said instead.
    const held = picked ? 0 : await db.order.count({ where: shipmentListWhere({ ...filters, held: true, now }) });
    const gone = picked ? picked.length - listed.length : 0;

    const reserved = picked
      ? listed
      : listed.filter((o) => assertReadyToShip(o as StateSource, guardLines(o.items, o.addOns)).allowed);
    const unready = listed.length - reserved.length;

    // The door's two hard blocks about the fee, for THIS courier: the fee rows of all the governorates, read once.
    // With no courier there is no fee to ask about and no amount in the file, so nothing is held back for it.
    const regionIds = [...new Set(reserved.map((o) => o.regionId).filter((id): id is string => !!id))];
    const priced = new Set(
      courier && regionIds.length > 0
        ? (
            await db.deliveryFee.findMany({
              where: activeFeeRowWhere(courier.id, { in: regionIds }),
              select: { regionId: true },
            })
          ).map((f) => f.regionId)
        : []
    );
    const ready = courier
      ? reserved.filter((o) => !deliveryFeeBlock(o.regionId, !!o.regionId && priced.has(o.regionId)))
      : reserved;
    const blocked = reserved.length - ready.length;

    if (ready.length === 0) {
      const said = picked ? 'ولا طلب من المحدَّدة بيصلح للملف — ما في ملف.' : 'ما في طلب جاهز للشحن بهالفلاتر — ما في ملف.';
      return NextResponse.json({ error: said, errorAr: said, code: 'NOTHING_READY', held, unready, blocked, gone }, { status: 409 });
    }

    // The courier this shipment is for, as the shipment's creation will record it: the amount and the city id are its.
    // With none, no courier is written onto the rows and no city id is looked up: the column stays empty.
    const rowsFor = courier ? ready.map((o) => ({ ...o, deliveryProviderId: courier.id })) : ready;
    const cityIds = courier ? await sheetCityIds({ id: courier.id, identity: courier }, rowsFor) : new Map<string, number>();

    // Counted before the file is built, so the tally does not depend on what the file turns out to hold.
    await noteCustomersHandedOut({
      companyId, storeId, user, where: picked ? 'ملف الطلبات المحدَّدة للشحن' : 'ملف الطلبات الجاهزة للشحن', rows: rowsFor,
    });

    const rows = await batchSheetRows(rowsFor, {
      minorUnit: country.minorUnit, countryCode: country.code, cityIds, ...(courier ? {} : { withoutMoney: true }),
    });
    const csv = [BATCH_SHEET_HEADER.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');

    return new NextResponse(`﻿${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${!courier ? 'picked-no-courier' : picked ? 'picked' : 'ready'}-to-ship-${now.toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
        'X-Rows': String(ready.length),
        'X-Left-Held': String(held),
        'X-Left-Unready': String(unready),
        'X-Left-Blocked': String(blocked),
        'X-Left-Gone': String(gone),
        ...(courier ? {} : { 'X-No-Courier': '1' }),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
