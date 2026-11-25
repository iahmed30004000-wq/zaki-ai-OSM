import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { publicOrigin } from '@/lib/passkey';
import { authenticityQrPng, authenticityQrSvg, verifyLinkFor } from '@/lib/authenticity';

/**
 * GET /api/settings/authenticity-codes/qr — the QR to print on a piece (20/11, owner: «يولد qr code خاص بيه»).
 *
 *   ?id=<code id>&format=svg|png[&download=1]   one code's QR, as an image (or a file to save)
 *   ?all=1                                       every code's QR as SVG, for the print sheet (capped like the list)
 *
 * What the QR holds is `verifyLinkFor`: the store's `/verify/<storeId>?code=…`, so a phone's own camera opens the page
 * and it checks by itself. Made here on the server with the `qrcode` the waybill already uses — nothing is added to a
 * screen's JavaScript. Read on `settings.view`, like the list it draws.
 */

const CAP = 500;

/** A file name that survives every OS: the code's own safe characters, or a neutral word. */
function fileName(code: string, ext: string): string {
  const safe = code.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `qr-${safe || 'code'}.${ext}`;
}

export async function GET(req: Request) {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');

    const url = new URL(req.url);
    // The store the link points at: the one asked for if it is this company's and active, else the first active one.
    const asked = url.searchParams.get('store');
    const stores = await db.store.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    const storeId = (asked && stores.find((s) => s.id === asked)?.id) || stores[0]?.id;
    if (!storeId) {
      return NextResponse.json({ error: 'لا متجر فعّال — رابط التحقق يحتاج متجراً واحداً على الأقل' }, { status: 409 });
    }
    const origin = publicOrigin(req);

    if (url.searchParams.get('all') === '1') {
      const codes = await db.authenticityCode.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: CAP,
        select: { id: true, code: true, note: true },
      });
      const items = await Promise.all(
        codes.map(async (c) => {
          const link = verifyLinkFor(origin, storeId, c.code);
          return { id: c.id, code: c.code, note: c.note, link, svg: await authenticityQrSvg(link) };
        })
      );
      return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const id = url.searchParams.get('id') ?? '';
    const row = id ? await db.authenticityCode.findFirst({ where: { id, companyId }, select: { code: true } }) : null;
    if (!row) return NextResponse.json({ error: 'الرمز غير موجود' }, { status: 404 });

    const link = verifyLinkFor(origin, storeId, row.code);
    const png = url.searchParams.get('format') === 'png';
    const headers: Record<string, string> = {
      'Content-Type': png ? 'image/png' : 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${fileName(row.code, png ? 'png' : 'svg')}"`;
    }
    const body = png ? new Uint8Array(await authenticityQrPng(link)) : await authenticityQrSvg(link);
    return new NextResponse(body, { status: 200, headers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
