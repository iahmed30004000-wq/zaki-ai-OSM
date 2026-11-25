import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { publicOrigin } from '@/lib/passkey';
import { authenticityQrPng, authenticityQrSvg } from '@/lib/authenticity';
import { productVerifyLink } from '@/lib/product-verify-design';

/**
 * GET /api/settings/product-verify-pages/qr — the QR codes of «باركود المنتجات», drawn on the server with the same
 * `qrcode` settings as the codes' own QR (and the waybill's).
 *
 *   ?id=<page id>&format=svg|png[&download=1]                 THE PRODUCT'S BARCODE: `/v/<slug>`
 *   ?id=<page id>&code=<code id>&format=svg|png[&download=1] A PIECE'S QR: `/v/<slug>?code=<its code>` — only a code
 *                                                              tagged to this product, or to none (one the page would
 *                                                              read «أصلي»)
 *
 * Always the CURRENT short link: a barcode printed with an older one still opens the page through its redirect.
 * Read on `settings.view`, like the screen that shows them.
 */

function fileName(base: string, ext: string): string {
  const safe = base.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `qr-${safe || 'product'}.${ext}`;
}

export async function GET(req: Request) {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');

    const url = new URL(req.url);
    const pageId = url.searchParams.get('id') ?? '';
    const page = pageId
      ? await db.productVerifyPage.findFirst({ where: { id: pageId, companyId }, select: { slug: true, productId: true } })
      : null;
    if (!page) return NextResponse.json({ error: 'الصفحة غير موجودة' }, { status: 404 });

    let code: string | null = null;
    const codeId = url.searchParams.get('code');
    if (codeId) {
      const row = await db.authenticityCode.findFirst({ where: { id: codeId, companyId }, select: { code: true, productId: true } });
      if (!row || (row.productId && row.productId !== page.productId)) {
        return NextResponse.json({ error: 'الرمز غير موجود لهالمنتج' }, { status: 404 });
      }
      code = row.code;
    }

    const link = productVerifyLink(publicOrigin(req), page.slug, code);
    const png = url.searchParams.get('format') === 'png';
    const headers: Record<string, string> = {
      'Content-Type': png ? 'image/png' : 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${fileName(code ? `${page.slug}-${code}` : page.slug, png ? 'png' : 'svg')}"`;
    }
    const body = png ? new Uint8Array(await authenticityQrPng(link)) : await authenticityQrSvg(link);
    return new NextResponse(body, { status: 200, headers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
