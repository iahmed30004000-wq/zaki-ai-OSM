import { NextResponse } from 'next/server';
import { checkAuthenticityCode, normalizeAuthenticityCode, resolveCompanyByStoreId } from '@/lib/authenticity';
import { getClientIp, rateLimit, rateLimitByIp, UNKNOWN_IP } from '@/lib/rate-limit';

/**
 * POST /api/public/verify-barcode/[id] — «هل هذا الرمز أصلي؟». `[id]` is the Store id (see `src/app/verify/[id]/page.tsx`).
 *
 * No auth: the whole point is a link anyone can open and a camera anyone can point at a label. The ONLY thing a
 * caller ever learns is `{ genuine: boolean }` — never the product, the batch, the owner's note, or an internal
 * id (`src/lib/authenticity.ts`). A missing/paused store and a store with no such code answer exactly the same
 * way at the edges that matter: `storeId` not shaped like a store id → 400 (a bug in the caller, not a probe
 * worth hiding); a real-looking but wrong/paused store id, OR a wrong code → `{ genuine: false }`. Nothing here
 * distinguishes "this store doesn't exist" from "this code is fake": a 404 on the store id would let a script
 * tell those two apart, and that script would then know exactly how many codes to try before giving up.
 */

const MAX_BODY_BYTES = 2_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'طلب كبير جداً' }, { status: 413, headers: CORS });
    }

    const ip = getClientIp(req);
    // Two buckets: one per caller, one per store, so a flood aimed at one store's link cannot be dodged by
    // rotating addresses, and a flood from one address cannot be dodged by trying many stores.
    const byIp = ip === UNKNOWN_IP
      ? { allowed: true, retryAfterSec: 0 }
      : rateLimitByIp('verify_barcode', ip, 20, 60_000);
    if (!byIp.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${byIp.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(byIp.retryAfterSec) } }
      );
    }

    const { id: storeId } = await params;
    const byStore = rateLimit(`verify_barcode:store:${storeId}`, 600, 60_000);
    if (!byStore.allowed) {
      return NextResponse.json(
        { error: `محاولات كثيرة. أعد المحاولة بعد ${byStore.retryAfterSec} ثانية` },
        { status: 429, headers: { ...CORS, 'Retry-After': String(byStore.retryAfterSec) } }
      );
    }

    let body: { code?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400, headers: CORS });
    }
    const raw = typeof body.code === 'string' ? body.code : '';
    if (!raw.trim()) {
      return NextResponse.json({ error: 'أدخل رمزاً' }, { status: 400, headers: CORS });
    }

    const store = await resolveCompanyByStoreId(storeId);
    if (!store) {
      // Same shape as "code didn't match" — see the note above.
      return NextResponse.json({ genuine: false }, { status: 200, headers: CORS });
    }

    const code = normalizeAuthenticityCode(raw);
    const genuine = await checkAuthenticityCode(store.companyId, code);
    return NextResponse.json({ genuine }, { status: 200, headers: CORS });
  } catch (e) {
    console.error('POST /api/public/verify-barcode', e);
    return NextResponse.json({ error: 'تعذر التحقق الآن' }, { status: 500, headers: CORS });
  }
}
