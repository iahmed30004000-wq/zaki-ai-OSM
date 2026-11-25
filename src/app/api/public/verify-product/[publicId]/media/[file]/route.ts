import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isSafeStorageKey, readStoredFile } from '@/lib/storage';
import { PUBLIC_MEDIA_FILE } from '@/lib/public-media';
import { PUBLIC_ID } from '@/lib/product-verify';

/**
 * GET /api/public/verify-product/[publicId]/media/[file] — the pictures a product's own page shows, to a visitor with no
 * session (`/api/media` needs one).
 *
 * Serves a file only while the page is ACTIVE and only when the page shows it right now: its own picture or logo
 * override, or the product's main/gallery picture — never anything else in the product's folder (a replaced picture,
 * a draft). The storage key is built from the page's own row; the URL never carries a company id. Everything that is
 * not served is the same 404, with no difference between "no such file" and "not shown".
 */
const NOT_FOUND = () => new NextResponse('Not found', { status: 404 });

export async function GET(_req: Request, ctx: { params: Promise<{ publicId: string; file: string }> }) {
  const { publicId, file } = await ctx.params;
  if (!PUBLIC_ID.test(publicId) || !PUBLIC_MEDIA_FILE.test(file)) return NOT_FOUND();

  const page = await db.productVerifyPage.findUnique({
    where: { publicId },
    select: {
      active: true,
      companyId: true,
      productId: true,
      imageUrl: true,
      logoUrl: true,
      product: { select: { image: true, images: { select: { url: true } } } },
    },
  });
  if (!page?.active) return NOT_FOUND();

  const name = file.toLowerCase();
  const shown = [page.imageUrl, page.logoUrl, page.product.image, ...page.product.images.map((i) => i.url)].some(
    (u) => typeof u === 'string' && u.toLowerCase().endsWith(`/products/${page.productId.toLowerCase()}/${name}`)
  );
  if (!shown) return NOT_FOUND();

  const storageKey = `companies/${page.companyId}/products/${page.productId}/${name}`;
  if (!isSafeStorageKey(storageKey)) return NOT_FOUND();
  const stored = await readStoredFile(storageKey);
  if (!stored) return NOT_FOUND();

  const body = new ReadableStream({
    start(controller) {
      stored.stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stored.stream.on('end', () => controller.close());
      stored.stream.on('error', () => controller.error());
    },
  });
  return new NextResponse(body, {
    headers: {
      'Content-Type': stored.mimeType,
      'Content-Length': String(stored.size),
      // A page may be switched off, so an hour — not the immutable year a store logo gets.
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
