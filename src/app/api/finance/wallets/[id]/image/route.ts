import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { saveProductImage, validateImageFile } from '@/lib/storage';
import { WALLET_IMAGE_MAX_BYTES, WALLET_IMAGE_SIDE, WALLET_IMAGE_TOO_BIG } from '@/lib/wallet-look';

/**
 * POST /api/finance/wallets/{id}/image — the picture of ONE wallet, as a file.
 *
 * It does not save the picture ON the wallet. It stores the file and answers with its key; the wallet's PATCH door puts
 * a key on the wallet, and accepts only a key this door wrote for that wallet. Two steps, so that a picture can be
 * looked at before it is kept, and so that every write onto a wallet goes through the one door that asks for the key.
 *
 * THE SAME STORAGE PIPELINE AS EVERY OTHER UPLOAD (`saveProductImage`): the MIME allowlist (png, jpeg, webp — no SVG,
 * which can carry a script), the magic-byte sniff (the client's `Content-Type` is not believed), the sharp pass, the
 * tenant folder. It is not a second uploader; it is a second DOOR onto the one, because the shop's door asks
 * `storefront.manage` and a person who keeps the books is not the person who designs the shop.
 *
 * The folder is `companies/{company}/products/{wallet}/`: the wallet's own id is the namespace, which is what lets the
 * PATCH door say «this picture belongs to this wallet». The media door already serves that shape, to that company only.
 *
 * WHAT IS NOT DONE HERE: a picture that is replaced or cleared is not deleted from the volume. It is a few kilobytes and
 * the key may still be on a screen somebody has open; sweeping the orphans is a job of its own (BACKLOG_P2).
 */

const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_RATE_WINDOW_MS = 5 * 60_000;
/** What a multipart form weighs besides the file itself: the boundaries and the part's headers are a few hundred bytes. */
const FORM_FRAMING_BYTES = 64 * 1024;

const ARABIC = /[؀-ۿ]/;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId } = await requireContext();
    await requirePermission('finance.wallets_manage');

    const rl = rateLimit(`wallet_image_upload:${user.id}`, UPLOAD_RATE_LIMIT, UPLOAD_RATE_WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات رفع كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    // Another company's wallet, and one that does not exist, answer alike.
    const wallet = await db.wallet.findFirst({ where: { id, companyId }, select: { id: true, name: true } });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    if (!(req.headers.get('content-type') || '').includes('multipart/form-data')) {
      return NextResponse.json({ error: 'لازم يوصل الملف كنموذج ملفات، مش كنص' }, { status: 400 });
    }
    // Said BEFORE the body is read: reading a form buffers all of it, and a form is the picture plus a little framing. A
    // client that declares more than the limit allows is refused without being listened to. (A body of no declared length
    // is still held to the limit below, once it is read.)
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > WALLET_IMAGE_MAX_BYTES + FORM_FRAMING_BYTES) {
      return NextResponse.json({ error: WALLET_IMAGE_TOO_BIG }, { status: 413 });
    }
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'اختر صورة أولاً' }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    // The shop's own check first (type, and its own size ceiling), then this door's smaller one: a picture drawn at 44px.
    const check = validateImageFile({ mimeType: file.type || 'application/octet-stream', size: buffer.length });
    if (!check.valid) return NextResponse.json({ error: check.error }, { status: 400 });
    if (buffer.length > WALLET_IMAGE_MAX_BYTES) return NextResponse.json({ error: WALLET_IMAGE_TOO_BIG }, { status: 400 });

    let stored;
    try {
      stored = await saveProductImage({
        companyId,
        productId: wallet.id, // the wallet's own namespace
        buffer,
        mimeType: file.type || 'image/jpeg',
        originalName: file.name,
        maxDimension: WALLET_IMAGE_SIDE,
      });
    } catch (e) {
      // The storage helper's own Arabic sentences («محتوى الملف ليس صورة صالحة») are the answer; anything else is not.
      const said = e instanceof Error ? e.message : '';
      if (said && ARABIC.test(said) && said.length < 200) return NextResponse.json({ error: said }, { status: 400 });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'WALLET_PICTURE_UPLOADED',
      entity: 'Wallet', entityId: wallet.id, newData: { imageKey: stored.storageKey, bytes: stored.fileSize, by: user.name },
    });

    return NextResponse.json({ success: true, imageKey: stored.storageKey });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
