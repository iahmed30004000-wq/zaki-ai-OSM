/**
 * GET /api/whatsapp/messages/[id]/media — the photo, voice note, video, file or sticker of one WhatsApp message.
 *
 * ── NEVER A PUBLIC URL ──
 *
 * Asked with `whatsapp.view`, for a message of the caller's company, in a conversation her view reaches (ASSIGNED = hers and
 * the unassigned ones) — one `findFirst`, three scopes. Another company's id, a conversation outside her reach and a message with
 * no file all answer the same 404. The caller names a message, never a path: the storage key comes from the row.
 *
 * ── FETCHED ON FIRST VIEW ──
 *
 * When the webhook's after-answer fetch did not happen or failed, the file is fetched from Meta here (`ensureMediaStored`) and
 * kept, so the next view is served from our disk. A file Meta no longer has answers 410; one larger than we keep answers 413.
 *
 * ── WHAT IT IS DECLARED AS ──
 *
 * Pictures, sound and video are served inline as their own type (an <img>, an <audio>, a <video> need that); every other file is
 * an attachment, and a type off the list is `application/octet-stream` (`servedAs`). Always `nosniff`, never in a shared cache.
 * `Range` is honoured, so a voice note or a video can be sought.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { inboxScopeWhere } from '@/lib/whatsapp/inbox-scope';
import { ensureMediaStored, extFor, readMediaFile, servedAs } from '@/lib/whatsapp/media';
import { isMediaKind, KIND_LABEL, type MessageKind } from '@/lib/whatsapp/message-kinds';

export const dynamic = 'force-dynamic';

const NOT_FOUND = () => NextResponse.json({ error: 'الملف غير موجود' }, { status: 404 });

function disposition(inline: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'file';
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(viewer);
    const { id } = await params;
    const mine = inboxScopeWhere(viewer);

    const row = await db.whatsAppMessage.findFirst({
      where: { id, companyId, ...(mine ? { conversation: mine } : {}) },
      select: { id: true, messageType: true, mediaId: true, mediaKey: true, mimeType: true, fileName: true, mediaStatus: true },
    });
    if (!row || !isMediaKind(row.messageType) || (!row.mediaId && !row.mediaKey)) return NOT_FOUND();

    let key = row.mediaKey;
    let mime = row.mimeType;
    let bytes = await readMediaFile(key);
    if (!bytes) {
      if (row.mediaStatus === 'TOO_LARGE') {
        return NextResponse.json({ error: 'الملف أكبر من الحد الذي نحفظه — اطلب من الزبون إرساله بطريقة أخرى', code: 'TOO_LARGE' }, { status: 413 });
      }
      const stored = await ensureMediaStored(row.id);
      if (stored?.mediaStatus === 'TOO_LARGE') {
        return NextResponse.json({ error: 'الملف أكبر من الحد الذي نحفظه — اطلب من الزبون إرساله بطريقة أخرى', code: 'TOO_LARGE' }, { status: 413 });
      }
      key = stored?.mediaKey ?? null;
      mime = stored?.mimeType ?? mime;
      bytes = await readMediaFile(key);
      if (!bytes) {
        return NextResponse.json({ error: 'تعذّر جلب الملف من واتساب — قد يكون انتهى حفظه لديهم', code: 'MEDIA_UNAVAILABLE' }, { status: 410 });
      }
    }

    const { contentType, inline } = servedAs(mime);
    const download = new URL(req.url).searchParams.get('download') === '1';
    const name = row.fileName || `${KIND_LABEL[row.messageType as MessageKind]}.${extFor(mime)}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': disposition(inline && !download, name),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    const total = bytes.length;
    const range = req.headers.get('range');
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : total - 1;
      if (start >= total || start > end) {
        return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${total}` } });
      }
      end = Math.min(end, total - 1);
      start = Math.max(0, start);
      const part = bytes.subarray(start, end + 1);
      return new NextResponse(new Uint8Array(part), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(part.length) },
      });
    }
    return new NextResponse(new Uint8Array(bytes), { status: 200, headers: { ...headers, 'Content-Length': String(total) } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
