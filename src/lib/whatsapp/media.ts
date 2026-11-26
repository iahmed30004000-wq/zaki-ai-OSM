/**
 * WHATSAPP MEDIA — the bytes of a photo, a voice note, a video, a file or a sticker, both ways.
 *
 * ── INBOUND: FETCHED AFTER THE WEBHOOK HAS ANSWERED, AND AGAIN ON FIRST VIEW ──
 *
 * Meta's webhook carries a media ID, not the file. The file is two Graph calls away (GET /{media-id} → a short-lived URL → GET
 * with the token), and Meta keeps it for about 30 days. The webhook must answer 200 quickly (Meta retries otherwise), so:
 *   1. the webhook stores the row with `mediaStatus = PENDING` and answers;
 *   2. right after the answer, `after()` fetches the files of that delivery (best-effort — `prefetchMedia`);
 *   3. the media door (`/api/whatsapp/messages/[id]/media`) fetches on first view if (2) did not happen or failed.
 * Either way the file is written once, under `companies/{companyId}/whatsapp/{messageId}.{ext}`, and served from there.
 *
 * ── THE TOKEN GOES ONLY TO META ──
 *
 * The URL Meta answers is checked (https, a Meta host) BEFORE the token is sent to it, and a redirect is followed only to another
 * Meta host. A file larger than `MEDIA_MAX_BYTES` is never kept (TOO_LARGE): the cap is read from Meta's size and enforced again
 * while the bytes arrive. The sha256 Meta gave is checked when present.
 *
 * ── OUTBOUND: SNIFFED, NOT BELIEVED ──
 *
 * A staff upload is judged by its first bytes, never by its name or the browser's claim (`validateOutboundFile`), and capped by
 * Meta's own limits per kind.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../db';
import { LOCAL_STORAGE_DIR, STORAGE_PROVIDER, detectImageType, isSafeStorageKey } from '../storage';
import { getAccessToken } from './config';
import { getMediaInfo } from './cloud-api';
import { cleanFileName, isMediaKind } from './message-kinds';
import { OUTBOUND_LIMITS, OUTBOUND_MIMES, OUTBOUND_UPLOAD_MAX, type OutboundMediaKind } from './outbound-rules';

/** The largest file kept on our side, either way (Meta: image 5 MB, audio/video 16 MB, sticker 0.5 MB, document 100 MB). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/** Meta's own hosts for media URLs. The token is sent to nothing else. */
export function isMetaMediaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i.test(u.hostname);
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export const baseMime = (m: string | null | undefined): string => (m || '').split(';')[0].trim().toLowerCase();
export const extFor = (m: string | null | undefined): string => EXT[baseMime(m)] ?? 'bin';

export const mediaKeyFor = (companyId: string, messageId: string, mime: string | null): string =>
  `companies/${companyId}/whatsapp/${messageId}.${extFor(mime)}`;

/**
 * WHAT THE MEDIA DOOR MAY DECLARE AS A CONTENT TYPE, and whether the browser may open it in place.
 * Pictures, sound and video open inline; every other type is a download, served as what it is only when it is on the list,
 * and as `application/octet-stream` otherwise — a document from a stranger never runs on our origin.
 */
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'video/mp4', 'video/3gpp']);
export function servedAs(mime: string | null | undefined): { contentType: string; inline: boolean } {
  const m = baseMime(mime);
  if (INLINE.has(m)) return { contentType: m, inline: true };
  if (EXT[m]) return { contentType: m, inline: false };
  return { contentType: 'application/octet-stream', inline: false };
}

async function writeMediaFile(storageKey: string, bytes: Buffer): Promise<void> {
  if (STORAGE_PROVIDER !== 'local') throw new Error(`STORAGE_PROVIDER=${STORAGE_PROVIDER} غير مُهيأ لملفات واتساب`);
  if (!isSafeStorageKey(storageKey)) throw new Error('مسار تخزين غير صالح');
  const abs = path.join(LOCAL_STORAGE_DIR, storageKey);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, bytes);
}

export async function readMediaFile(storageKey: string | null | undefined): Promise<Buffer | null> {
  if (!storageKey || STORAGE_PROVIDER !== 'local' || !isSafeStorageKey(storageKey)) return null;
  try {
    return await fs.promises.readFile(path.resolve(LOCAL_STORAGE_DIR, storageKey));
  } catch {
    return null;
  }
}

/** The bytes at a Meta URL, capped while they arrive. One redirect, to another Meta host only. */
async function downloadCapped(url: string, token: string, cap: number): Promise<Buffer | 'TOO_LARGE' | null> {
  let target = url;
  for (let hop = 0; hop < 2; hop++) {
    if (!isMetaMediaUrl(target)) return null;
    let res: Response;
    try {
      res = await fetch(target, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) return null;
      target = new URL(next, target).toString();
      continue;
    }
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get('content-length') || '0');
    if (declared > cap) return 'TOO_LARGE';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return 'TOO_LARGE';
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
  return null;
}

type MediaRow = {
  id: string;
  companyId: string;
  messageType: string;
  mediaId: string | null;
  mimeType: string | null;
  mediaKey: string | null;
  mediaStatus: string | null;
  mediaSha256: string | null;
};
const MEDIA_SELECT = { id: true, companyId: true, messageType: true, mediaId: true, mimeType: true, mediaKey: true, mediaStatus: true, mediaSha256: true } as const;

const inFlight = new Map<string, Promise<MediaRow | null>>();

/**
 * MAKE SURE A MESSAGE'S FILE IS ON OUR DISK. Returns the row as it stands after trying. Never throws.
 * Concurrent calls for one message share one download.
 */
export function ensureMediaStored(messageId: string): Promise<MediaRow | null> {
  const running = inFlight.get(messageId);
  if (running) return running;
  const p = fetchAndStore(messageId).finally(() => inFlight.delete(messageId));
  inFlight.set(messageId, p);
  return p;
}

async function fetchAndStore(messageId: string): Promise<MediaRow | null> {
  try {
    const row = (await db.whatsAppMessage.findUnique({ where: { id: messageId }, select: MEDIA_SELECT })) as MediaRow | null;
    if (!row || !isMediaKind(row.messageType)) return row;
    if (row.mediaKey && (await readMediaFile(row.mediaKey))) return row;
    if (row.mediaStatus === 'TOO_LARGE' || !row.mediaId) return row;

    const token = await getAccessToken();
    if (!token) return row;
    const info = await getMediaInfo({ mediaId: row.mediaId, token });
    const fail = async (status: 'FAILED' | 'TOO_LARGE') => {
      await db.whatsAppMessage.update({ where: { id: row.id }, data: { mediaStatus: status } }).catch(() => {});
      return { ...row, mediaStatus: status };
    };
    if (!info.ok) return fail('FAILED');
    if (info.size !== null && info.size > MEDIA_MAX_BYTES) return fail('TOO_LARGE');

    const bytes = await downloadCapped(info.url, token, MEDIA_MAX_BYTES);
    if (bytes === 'TOO_LARGE') return fail('TOO_LARGE');
    if (!bytes || bytes.length === 0) return fail('FAILED');
    const expected = (row.mediaSha256 || info.sha256 || '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(expected) && crypto.createHash('sha256').update(bytes).digest('hex') !== expected) {
      return fail('FAILED');
    }

    const mime = row.mimeType || info.mimeType;
    const key = mediaKeyFor(row.companyId, row.id, mime);
    await writeMediaFile(key, bytes);
    await db.whatsAppMessage.update({
      where: { id: row.id },
      data: { mediaKey: key, mediaStatus: 'STORED', mediaSize: bytes.length, ...(row.mimeType ? {} : { mimeType: mime }) },
    });
    return { ...row, mediaKey: key, mediaStatus: 'STORED', mimeType: mime };
  } catch (e) {
    console.error('[whatsapp] media fetch failed:', (e as Error)?.name || 'unknown');
    return null;
  }
}

/** Best-effort: fetch the files of one webhook delivery, one after another, after the 200 has gone. */
export async function prefetchMedia(messageIds: string[]): Promise<void> {
  for (const id of messageIds.slice(0, 20)) {
    await ensureMediaStored(id);
  }
}

// ───────────────────────── outbound ─────────────────────────

const MB = 1024 * 1024;
export { OUTBOUND_UPLOAD_MAX, OUTBOUND_LIMITS };

const OOXML = new Set(OUTBOUND_MIMES.document.filter((m) => m.includes('openxmlformats')));
const LEGACY_OFFICE = new Set(['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint']);

/** The file's type from its first bytes; for container formats (zip, ole, mp4) the declared type picks among the family. */
export function sniffOutbound(b: Buffer, declared: string): string | null {
  const d = baseMime(declared);
  const image = detectImageType(b);
  if (image) return image;
  if (b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return OOXML.has(d) ? d : null;
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1) return LEGACY_OFFICE.has(d) ? d : null;
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 6 && b.toString('ascii', 0, 5) === '#!AMR') return 'audio/amr';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'; // MPEG frame sync
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 11);
    if (brand === '3gp') return 'video/3gpp';
    if (d === 'audio/mp4' || b.toString('ascii', 8, 12) === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (d === 'text/plain' && !b.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}

export type OutboundFileCheck =
  | { ok: true; kind: OutboundMediaKind; mime: string; fileName: string; size: number }
  | { ok: false; error: string };

/**
 * IS THIS UPLOAD SENDABLE, AND AS WHAT? `want` is what the staff picked («صورة» or «ملف»): a photo sent as a file is a document
 * (WhatsApp then keeps its quality), anything sent as «صورة» must be a JPEG or PNG.
 */
export function validateOutboundFile(opts: { bytes: Buffer; declaredMime: string; fileName: string; want: 'image' | 'file' }): OutboundFileCheck {
  const { bytes } = opts;
  if (!bytes.length) return { ok: false, error: 'الملف فارغ' };
  const mime = sniffOutbound(bytes, opts.declaredMime);
  if (!mime) return { ok: false, error: 'نوع الملف غير مدعوم. المسموح: صور JPG/PNG، PDF، ملفات Office، نص، صوت، وفيديو MP4' };

  let kind: OutboundMediaKind | null = null;
  if (opts.want === 'image') {
    kind = OUTBOUND_MIMES.image.includes(mime) ? 'image' : null;
    if (!kind) return { ok: false, error: 'الصورة لازم تكون JPG أو PNG' };
  } else if (OUTBOUND_MIMES.audio.includes(mime)) kind = 'audio';
  else if (OUTBOUND_MIMES.video.includes(mime)) kind = 'video';
  else if (OUTBOUND_MIMES.document.includes(mime) || OUTBOUND_MIMES.image.includes(mime)) kind = 'document';
  if (!kind) return { ok: false, error: 'نوع الملف غير مدعوم' };

  const limit = OUTBOUND_LIMITS[kind];
  if (bytes.length > limit) {
    return { ok: false, error: `حجم الملف يتجاوز الحد المسموح (${Math.round(limit / MB)} ميجابايت)` };
  }
  const name = cleanFileName(opts.fileName) || `file.${extFor(mime)}`;
  return { ok: true, kind, mime, fileName: name, size: bytes.length };
}

/** Keep a staff upload on our disk too, so the thread can show what was sent. */
export async function keepOutboundFile(companyId: string, messageId: string, mime: string, bytes: Buffer): Promise<string | null> {
  try {
    const key = mediaKeyFor(companyId, messageId, mime);
    await writeMediaFile(key, bytes);
    return key;
  } catch {
    return null;
  }
}
