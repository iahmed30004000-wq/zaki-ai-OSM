import { NextResponse } from 'next/server';
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

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    if (!can(user, 'ops.ship')) return NextResponse.json({ error: NO_SHIP, errorAr: NO_SHIP }, { status: 403 });
    if (!can(user, 'customers.view')) return NextResponse.json({ error: NO_CONTACTS, errorAr: NO_CONTACTS }, { status: 403 });
    if (!storeId) return NextResponse.json({ error: 'اختر المتجر أولاً.', errorAr: 'اختر المتجر أولاً.' }, { status: 400 });

    const q = new URL(req.url).searchParams;
    const courierId = q.get('courier');
    if (!courierId) return NextResponse.json({ error: NO_COURIER, errorAr: NO_COURIER, code: 'NO_COURIER' }, { status: 400 });
    const courier = await db.deliveryProvider.findFirst({
      where: { id: courierId, companyId },
      select: { id: true, code: true, adapterCode: true },
    });
    if (!courier) return NextResponse.json({ error: 'شركة الشحن غير موجودة', errorAr: 'شركة الشحن غير موجودة' }, { status: 404 });

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

    const listed = await db.order.findMany({
      where: shipmentListWhere({ ...filters, held: false, now }),
      orderBy: { createdAt: 'asc' },
      take: MAX_ORDERS,
      select: {
        ...WAYBILL_SELECT,
        // What `assertReadyToShip` asks of the lines and the add-ons, beside what the file prints.
        items: { select: { ...WAYBILL_SELECT.items.select, reservedQty: true } },
        addOns: { select: { ...WAYBILL_SELECT.addOns.select, reservedQty: true } },
      },
    });
    const held = await db.order.count({ where: shipmentListWhere({ ...filters, held: true, now }) });

    const reserved = listed.filter((o) => assertReadyToShip(o as StateSource, guardLines(o.items, o.addOns)).allowed);
    const unready = listed.length - reserved.length;

    // The door's two hard blocks about the fee, for THIS courier: the fee rows of all the governorates, read once.
    const regionIds = [...new Set(reserved.map((o) => o.regionId).filter((id): id is string => !!id))];
    const priced = new Set(
      regionIds.length > 0
        ? (
            await db.deliveryFee.findMany({
              where: activeFeeRowWhere(courier.id, { in: regionIds }),
              select: { regionId: true },
            })
          ).map((f) => f.regionId)
        : []
    );
    const ready = reserved.filter((o) => !deliveryFeeBlock(o.regionId, !!o.regionId && priced.has(o.regionId)));
    const blocked = reserved.length - ready.length;

    if (ready.length === 0) {
      const said = 'ما في طلب جاهز للشحن بهالفلاتر — ما في ملف.';
      return NextResponse.json({ error: said, errorAr: said, code: 'NOTHING_READY', held, unready, blocked }, { status: 409 });
    }

    // The courier this shipment is for, as the shipment's creation will record it: the amount and the city id are its.
    const rowsFor = ready.map((o) => ({ ...o, deliveryProviderId: courier.id }));
    const cityIds = await sheetCityIds({ id: courier.id, identity: courier }, rowsFor);

    // Counted before the file is built, so the tally does not depend on what the file turns out to hold.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'ملف الطلبات الجاهزة للشحن', rows: rowsFor });

    const rows = await batchSheetRows(rowsFor, { minorUnit: country.minorUnit, countryCode: country.code, cityIds });
    const csv = [BATCH_SHEET_HEADER.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');

    return new NextResponse(`﻿${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ready-to-ship-${now.toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
        'X-Rows': String(ready.length),
        'X-Left-Held': String(held),
        'X-Left-Unready': String(unready),
        'X-Left-Blocked': String(blocked),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
