import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { saveProductImage, validateImageFile } from '@/lib/storage';

/**
 * POST /api/settings/product-verify-pages/image — a picture or a logo for a product's page («باركود المنتجات»), as
 * multipart `{ file, productId, kind: 'image' | 'logo' }`. On `settings.edit`, like every write of the screen.
 *
 * Stored by the same pipeline as a product's own photos (`saveProductImage`: sniffed, capped, WebP) in THAT product's
 * folder, and returned as its private `/api/media/...` link. Nothing is public by being uploaded: the page's own media
 * route serves it only while the page is active and names it. A product's gallery is not touched.
 */
const RATE = 20;
const WINDOW_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.edit');

    const rl = rateLimit(`uploads:${user.id}`, RATE, WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'عدد محاولات رفع الصور كبير جداً، يرجى المحاولة لاحقاً' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const form = await req.formData();
    const productId = String(form.get('productId') ?? '');
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'لم يتم اختيار أي صورة' }, { status: 400 });

    const product = productId ? await db.product.findFirst({ where: { id: productId, companyId }, select: { id: true } }) : null;
    if (!product) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });

    const check = validateImageFile({ mimeType: file.type, size: file.size });
    if (!check.valid) return NextResponse.json({ error: check.error }, { status: 400 });

    const stored = await saveProductImage({
      companyId,
      productId: product.id,
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type,
      originalName: file.name,
      maxDimension: form.get('kind') === 'logo' ? 600 : 1200,
    });
    return NextResponse.json({ url: stored.url }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
