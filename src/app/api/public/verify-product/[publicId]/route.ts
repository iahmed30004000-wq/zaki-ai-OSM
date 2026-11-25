import { NextResponse } from 'next/server';
import { activePageByPublicId, isGenuineForProduct, productCodeCandidates, PUBLIC_ID } from '@/lib/product-verify';
import { getClientIp, rateLimit, rateLimitByIp, UNKNOWN_IP } from '@/lib/rate-limit';

/**
 * POST /api/public/verify-product/[publicId] `{ code }` → `{ genuine }` — «هل هذه القطعة أصلية؟» on ONE product's page.
 *
 * The same door as `/api/public/verify-barcode/[id]` (no auth, CORS open, a 2,000-byte body, 20 a minute per address
 * and 600 per page), and the same rule about what leaks: NOTHING but `{ genuine: boolean }`. An unknown page, a page
 * switched off, a code that does not exist, and a code tagged to another product all answer `{ genuine: false }` —
 * a script cannot tell which one it hit. A `publicId` not even shaped like one never reaches the database.
 *
 * Genuine here means: the code exists in the page's company AND it is tagged to this page's product, or to none
 * (`isGenuineForProduct`). The product barcode alone (the page link) proves nothing; the piece's own code does.
 */

const MAX_BODY_BYTES = 2_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const tooMany = (sec: number) =>
  NextResponse.json(
    { error: `محاولات كثيرة. أعد المحاولة بعد ${sec} ثانية` },
    { status: 429, headers: { ...CORS, 'Retry-After': String(sec) } }
  );

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'طلب كبير جداً' }, { status: 413, headers: CORS });
    }

    const ip = getClientIp(req);
    // One bucket for the caller (shared with the store-level checker: one person, one allowance), one for the page.
    const byIp = ip === UNKNOWN_IP ? { allowed: true, retryAfterSec: 0 } : rateLimitByIp('verify_barcode', ip, 20, 60_000);
    if (!byIp.allowed) return tooMany(byIp.retryAfterSec);

    const { publicId } = await params;
    const byPage = rateLimit(`verify_product:page:${publicId}`, 600, 60_000);
    if (!byPage.allowed) return tooMany(byPage.retryAfterSec);

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'طلب كبير جداً' }, { status: 413, headers: CORS });
    }
    let body: { code?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400, headers: CORS });
    }
    const raw = body && typeof body.code === 'string' ? body.code : '';
    if (!raw.trim()) {
      return NextResponse.json({ error: 'أدخل رمزاً' }, { status: 400, headers: CORS });
    }

    if (!PUBLIC_ID.test(publicId)) return NextResponse.json({ genuine: false }, { status: 200, headers: CORS });
    const page = await activePageByPublicId(publicId);
    if (!page) {
      // Same shape as "code didn't match" — see the note above.
      return NextResponse.json({ genuine: false }, { status: 200, headers: CORS });
    }

    // Any saved code matches: a plain code, or a link of any shape (25/11, owner): see productCodeCandidates.
    let genuine = false;
    for (const code of productCodeCandidates(raw)) {
      if (await isGenuineForProduct(page.companyId, page.productId, code)) {
        genuine = true;
        break;
      }
    }
    return NextResponse.json({ genuine }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('POST /api/public/verify-product', e);
    return NextResponse.json({ error: 'تعذر التحقق الآن' }, { status: 500, headers: CORS });
  }
}
