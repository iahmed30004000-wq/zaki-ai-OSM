import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';

/**
 * «من صور منتجاتك» — the photographs a slide may be picked from: THIS
 * store's own active products, in this company, and nothing else.
 *
 * Their slider offers «صور المتجر» beside an upload; here it is the same
 * idea with the one rule this system keeps everywhere: an image belongs to
 * the company that uploaded it, so the list is read by `companyId` AND the
 * store the session stands in. Paths only — the editor shows them as it
 * shows every other picture, and the storefront makes them public at render.
 */
const MAX = 48;

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('storefront.view');

    const products = await db.product.findMany({
      where: { companyId, storeId, status: 'ACTIVE' },
      select: { image: true, images: { select: { url: true }, orderBy: { sortOrder: 'asc' }, take: 4 } },
      orderBy: { createdAt: 'desc' },
      take: MAX,
    });

    const seen = new Set<string>();
    const photos: string[] = [];
    for (const p of products) {
      for (const url of [p.image, ...p.images.map((i) => i.url)]) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        photos.push(url);
        if (photos.length >= MAX) break;
      }
      if (photos.length >= MAX) break;
    }

    return NextResponse.json({ photos }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
