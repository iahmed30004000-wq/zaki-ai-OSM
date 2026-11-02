import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { WAYBILL_SELECT } from '@/lib/waybill';
import { BATCH_SHEET_HEADER, batchSheetRows } from '@/lib/batch-sheet';
import { cityIdsForRegions, storedCityIds } from '@/lib/couriers/city-id';
import { XLSX_CONTENT_TYPE, buildXlsx } from '@/lib/xlsx-writer';

/**
 * GET /api/shipping-batches/:id/export — the batch's orders as an Excel file.
 *
 * For making the parcels at the courier by hand: the file lists EVERY order of the batch, with or without the courier's
 * barcode, and carries what the dispatch sends the courier's API (see `lib/batch-sheet`). The waybill CSV cannot serve
 * this — it refuses an order that has no barcode yet — and a batch handed over before it was sent (the owner, 31/10:
 * 147 orders, the dispatch closed for good) has nothing else to give the courier's portal.
 *
 * It is a file of names, phones and addresses leaving the building, so it asks two keys and is counted:
 *   · `ops.batches` — the batches screen's own key;
 *   · `customers.view` — the address-book key, as the batch's own read asks it before it shows a phone.
 * Both are asked per request, the batch is read inside the session's company and store, and every customer in the file
 * goes into the harvest tally.
 */
const NO_BATCHES = 'دفعات الشحن ليست من صلاحيّاتك.';
const NO_CONTACTS = 'ملف الدفعة فيه أسماء وأرقام وعناوين الزبائن، فيحتاج صلاحية «عرض العملاء». اطلبها من مدير النظام.';
/** A trolley is a day's work; this is a ceiling against a runaway, not a limit anyone meets. */
const MAX_ORDERS = 2000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    if (!can(user, 'ops.batches')) return NextResponse.json({ error: NO_BATCHES, errorAr: NO_BATCHES }, { status: 403 });
    if (!can(user, 'customers.view')) return NextResponse.json({ error: NO_CONTACTS, errorAr: NO_CONTACTS }, { status: 403 });
    if (!storeId) return NextResponse.json({ error: 'اختر المتجر أولاً.', errorAr: 'اختر المتجر أولاً.' }, { status: 400 });

    const batch = await db.shippingBatch.findFirst({
      where: { id, companyId, storeId },
      // The courier's code decides which list of its own city ids is asked for a governorate nobody typed one for.
      select: { id: true, batchNumber: true, deliveryProviderId: true, provider: { select: { code: true } } },
    });
    if (!batch) return NextResponse.json({ error: 'الدفعة غير موجودة. أعد تحميل القائمة.', errorAr: 'الدفعة غير موجودة. أعد تحميل القائمة.' }, { status: 404 });

    const orders = await db.order.findMany({
      where: { shippingBatchId: batch.id, companyId, storeId },
      orderBy: { createdAt: 'asc' },
      take: MAX_ORDERS,
      select: WAYBILL_SELECT,
    });
    if (orders.length === 0) {
      return NextResponse.json({ error: 'الدفعة فاضية — ما في طلبات لتصديرها.', errorAr: 'الدفعة فاضية — ما في طلبات لتصديرها.' }, { status: 409 });
    }

    // The courier's own id for each governorate: the same answer the dispatch gets for the API (`couriers/city-id`) — the
    // id typed on the fees screen, else the one in the courier's own list. The typed ones are read once.
    const typedCityIds = storedCityIds(
      batch.deliveryProviderId
        ? await db.deliveryFee.findMany({
            where: { deliveryProviderId: batch.deliveryProviderId, courierCityId: { not: null } },
            select: { regionId: true, courierCityId: true },
          })
        : []
    );
    const cityIds = cityIdsForRegions({
      providerCode: batch.provider?.code,
      stored: typedCityIds,
      regions: orders.map((o) => ({ id: o.regionId, name: o.region?.name })),
    });

    // Counted before the file is built, so the tally does not depend on what the file turns out to hold.
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'ملف إكسل لدفعة شحن', rows: orders });

    const rows = await batchSheetRows(orders, { minorUnit: country.minorUnit, countryCode: country.code, cityIds });
    const file = buildXlsx({ name: batch.batchNumber, header: [...BATCH_SHEET_HEADER], rows });

    // An ASCII file name: a header cannot carry Arabic bytes, and the batch number is ASCII already.
    const name = `${batch.batchNumber.replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': XLSX_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
