import { NextResponse } from 'next/server';
import { draftMode } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { storeShelf } from '@/lib/storefront';
import { PREVIEW_COOKIE, PREVIEW_PAGES, type PreviewPage } from '@/lib/store-preview';

/**
 * «المعاينة الحقيقية» — THE DOOR INTO IT.
 *
 * POST `{ page }` checks the session, the company and `storefront.view` (the
 * same permission that reads the draft on «القالب والألوان»), turns on
 * Next's draft mode, names the store the session stands in, and answers with
 * the address of that page of the shop — which the screen loads in a frame.
 * The shop's pages then draw the DRAFT for that frame only (store-preview.ts).
 *
 * Anybody else gets «not found», as `/lp/design-preview` answers: a stranger
 * learns nothing, not even that the door is here. Nothing is cached, and
 * nothing here is for an index.
 *
 * `{ off: true }` turns it off again — a POST like the rest, by the same
 * signed-in seller: leaving a preview deletes nothing.
 */
const NO_INDEX = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } as const;
const notFound = () => NextResponse.json({ error: 'غير موجود' }, { status: 404, headers: NO_INDEX });

const bodySchema = z.union([z.object({ page: z.enum(PREVIEW_PAGES) }), z.object({ off: z.literal(true) })]);

/** Which address of the shop each of the six is — drawn from THIS shop's own products. */
async function addressOf(page: PreviewPage, store: { slug: string; companyId: string; id: string }) {
  const base = `/s/${store.slug}`;
  if (page === 'home') return base;
  if (page === 'products') return `${base}/shop`;
  if (page === 'cart') return `${base}/cart`;
  if (page === 'search') return `${base}/shop?q=`;
  const shelf = await storeShelf(store.companyId, store.id, 12);
  if (page === 'product') return shelf[0] ? `${base}/p/${encodeURIComponent(shelf[0].handle)}` : `${base}/shop`;
  const withCategory = shelf.find((p) => p.category);
  return withCategory ? `${base}/shop?cat=${encodeURIComponent(withCategory.category!.id)}` : `${base}/shop`;
}

export async function POST(req: Request) {
  let ctx: Awaited<ReturnType<typeof requireContext>>;
  try {
    ctx = await requireContext();
    await requirePermission('storefront.view');
  } catch {
    return notFound();
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return notFound();
  if ('off' in parsed.data) {
    (await draftMode()).disable();
    const off = new NextResponse(null, { status: 204, headers: NO_INDEX });
    off.cookies.delete(PREVIEW_COOKIE);
    return off;
  }
  const page = parsed.data.page;

  const store = await db.store.findFirst({
    where: { id: ctx.storeId, companyId: ctx.companyId },
    select: { id: true, slug: true, companyId: true },
  });
  if (!store) return notFound();

  (await draftMode()).enable();
  const res = NextResponse.json({ href: await addressOf(page, store) }, { headers: NO_INDEX });
  // Names the ONE store this preview is of; a page of any other shop ignores it.
  res.cookies.set(PREVIEW_COOKIE, store.id, { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' });
  return res;
}
