/**
 * POST /api/whatsapp/conversations/[id]/media — send a photo or a file from the staff's device.
 *
 * multipart/form-data: `file` (the bytes), `kind` («image» | «file»), `caption` (optional, ≤ 1024).
 * The type is sniffed from the bytes and the size capped per kind (`validateOutboundFile`) before anything reaches Meta; the
 * upload, the send and the record are `sendOutboundMedia`'s. The body is refused above ~9 MB before it is read whole
 * (the app's proxy buffers request bodies up to 10 MB — see `OUTBOUND_UPLOAD_MAX`).
 */
import { NextResponse } from 'next/server';
import { sendOutboundMedia } from '@/lib/whatsapp/send';
import { viewOf } from '@/lib/whatsapp/message-view';
import { OUTBOUND_UPLOAD_MAX } from '@/lib/whatsapp/media';
import { apiErrorResponse } from '@/lib/api-error';

/** The file plus the form's own bytes; the file itself is judged per kind by `validateOutboundFile`. */
const BODY_CAP = OUTBOUND_UPLOAD_MAX + 256 * 1024;
const TOO_BIG = 'حجم الملف يتجاوز الحد المسموح (9 ميجابايت، والصورة 5)';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const declared = Number(req.headers.get('content-length') || '0');
    if (declared > BODY_CAP) {
      return NextResponse.json({ error: TOO_BIG, code: 'BAD_FILE' }, { status: 413 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: 'تعذّر قراءة الملف', code: 'BAD_FILE' }, { status: 400 });
    }
    const file = form.get('file');
    const kind = form.get('kind');
    const caption = form.get('caption');
    if (!(file instanceof Blob) || (kind !== 'image' && kind !== 'file')) {
      return NextResponse.json({ error: 'اختر صورة أو ملفاً لإرساله', code: 'BAD_FILE' }, { status: 400 });
    }
    if (file.size > BODY_CAP) {
      return NextResponse.json({ error: TOO_BIG, code: 'BAD_FILE' }, { status: 413 });
    }
    if (caption !== null && (typeof caption !== 'string' || caption.length > 1024)) {
      return NextResponse.json({ error: 'التعليق أطول من المسموح (1024 حرفاً)', code: 'BAD_FILE' }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await sendOutboundMedia(id, {
      bytes,
      declaredMime: file.type || '',
      fileName: (file as File).name || '',
      caption: typeof caption === 'string' ? caption : null,
      want: kind,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
    }
    return NextResponse.json({ message: viewOf(result.message) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
