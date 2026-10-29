import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { verifyLabelBatch } from '@/lib/labels';
import { renderLabelSheet, storeLogoForPrint } from '@/lib/label-sheet';
import { altPhoneForLabel, csvCell, loadWaybillOrders, printRefusal, toLabelView, waybillCod } from '@/lib/waybill';
import { formatMoney } from '@/lib/money';
import { placeLine } from '@/lib/address';
import { noteCustomersHandedOut } from '@/lib/pii-alert';

/**
 * GET /api/ops/labels/print?t=<batch token>[&mode=pdf|&format=csv]
 *
 * The waybills as a print-ready page (the browser's own dialog prints them,
 * or saves the PDF — no third-party service ever sees an address), or as a
 * CSV for the courier's bulk upload.
 *
 * READING THIS PAGE COMMITS NOTHING. It used to stamp labelPrintedAt on
 * every order the moment the page — or the CSV — was requested, and that
 * stamp seals the order and turns a cancellation into a return. Opening a
 * preview, reloading it, or downloading a file sealed orders that were never
 * printed, including unconfirmed ones. Printing is reported by the page
 * itself when it actually prints (POST /api/ops/labels/printed).
 *
 * Authorisation is per order, not per token: the session must hold
 * ops.labels, and every order is re-read inside the session's company and
 * store before a label is drawn.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('ops.labels');

    const url = new URL(req.url);
    const token = url.searchParams.get('t');
    const batch = token ? await verifyLabelBatch(token) : null;
    if (!batch || !token) return NextResponse.json({ error: 'رابط الطباعة غير صالح أو منتهٍ' }, { status: 400 });
    if (!storeId || batch.storeId !== storeId) {
      return NextResponse.json({ error: 'رابط الطباعة يخص متجراً آخر' }, { status: 403 });
    }

    const all = await loadWaybillOrders(batch, { companyId, storeId });
    if (all.length === 0) return NextResponse.json({ error: 'لا توجد طلبات' }, { status: 404 });

    // The same rule the token route applied, checked again here: a token is
    // thirty minutes old at most, and an order can be cancelled in that time.
    const skipped: { orderNumber: string; reason: string }[] = [];
    const printable = all.filter((o) => {
      const reason = printRefusal(o);
      if (reason) skipped.push({ orderNumber: o.orderNumber, reason });
      return !reason;
    });
    if (printable.length === 0) {
      return NextResponse.json({ error: 'لا يوجد طلب صالح للطباعة', skipped }, { status: 409 });
    }

    /*
     * A sheet of waybills and the courier's CSV are both a list of names,
     * phones and addresses — the CSV is a file that walks out of the
     * building. Counted before either is built, so the tally does not
     * depend on which format was asked for.
     */
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'طباعة البوالص', rows: printable,
    });

    const minorUnit = country.minorUnit;

    if (url.searchParams.get('format') === 'csv') {
      const header = ['merchant_ref', 'courier_barcode', 'customer', 'phone', 'alt_phone', 'region', 'address', 'cod', 'currency', 'items', 'note'];
      const lines = await Promise.all(
        printable.map(async (o) => {
          const cod = await waybillCod(o, minorUnit);
          return [
            o.merchantRef ?? o.orderNumber,
            o.trackingNumber ?? '',
            o.customer.fullName,
            o.customer.rawPhone || o.customer.phone,
            altPhoneForLabel(o.customer.altPhone, country.code),
            o.region?.name ?? o.customer.city,
            // The address without the governorate repeated in front of it —
            // the region has its own column.
            placeLine(o.region?.name ?? o.customer.city, null, o.customer.address).replace(/^[^—]*—\s*/, ''),
            // The amount with the currency's decimals, not a raw float.
            formatMoney(cod, o.currency, minorUnit).split(' ')[0],
            o.currency,
            [
              ...o.items.map((i) => `${i.productName} x${i.quantity + i.freeQuantity}`),
              ...o.addOns.map((a) => `${a.productName} x${a.quantity} (إضافة)`),
            ].join(' | '),
            o.customerNotes ?? '',
          ]
            .map(csvCell)
            .join(',');
        })
      );
      return new NextResponse(`﻿${[header.join(','), ...lines].join('\r\n')}`, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="labels-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    const store = await db.store.findFirst({
      where: { id: storeId, companyId },
      select: { name: true, logo: true, supportPhone: true },
    });

    const labels = await Promise.all(printable.map((o) => toLabelView(o, minorUnit, country.code)));
    const mode = url.searchParams.get('mode') === 'pdf' ? 'pdf' : 'print';
    const day = new Date().toISOString().slice(0, 10);

    const html = renderLabelSheet(labels, batch, {
      store: {
        name: store?.name ?? '',
        logoUrl: storeLogoForPrint(store?.logo),
        supportPhone: store?.supportPhone ?? null,
      },
      mode,
      token,
      stampUrl: '/api/ops/labels/printed',
      skipped,
      // Chromium suggests the page title as the file name when saving a PDF.
      title: `بوالص-${store?.name ?? 'الشحن'}-${day}-${labels.length}`,
    });

    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
