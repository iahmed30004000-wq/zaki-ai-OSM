/**
 * META CLOUD API CLIENT — official WhatsApp Business Cloud API only.
 * Never logs or throws with the token; error surfaces are sanitized.
 */
import { GRAPH_BASE, GRAPH_VERSION } from './config';
import type { OutboundMediaKind } from './outbound-rules';

export interface MetaResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  /** Sanitized Arabic-safe error (never contains the token). */
  error?: string;
}

async function metaFetch<T = any>(
  url: string,
  init: RequestInit
): Promise<MetaResult<T>> {
  let token: string | null = null;
  try {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      return { ok: false, status: 0, error: 'تعذر الاتصال بواتساب' };
    }
    // Extract token from init headers to redact it from any error path
    const auth = (init.headers as Record<string, string>)?.Authorization || '';
    token = auth.replace(/^Bearer\s+/i, '') || null;

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-json response */
    }
    if (res.ok) return { ok: true, status: res.status, data: json as T };

    // Meta error: { error: { message, type, code, ... } } — sanitize
    const metaMsg = json?.error?.error_user_msg || json?.error?.message;
    let safe: string;
    if (res.status === 401 || /access token|session/i.test(metaMsg || '')) {
      safe = 'بيانات الاتصال بواتساب غير صالحة';
    } else if (res.status === 429) {
      safe = 'تم تجاوز الحد المسموح من رسائل واتساب، حاول لاحقًا';
    } else if (metaMsg) {
      safe = 'تعذر الاتصال بواتساب';
    } else {
      safe = 'تعذر الاتصال بواتساب';
    }
    console.error('[whatsapp] meta api error:', res.status, json?.error?.code ?? '');
    return { ok: false, status: res.status, error: safe };
  } catch (e) {
    // Defense in depth: strip anything token-like before logging
    const msg = String((e as Error)?.message || e);
    console.error('[whatsapp] meta fetch failed:', msg.replace(token || '', '[REDACTED]'));
    return { ok: false, status: 0, error: 'تعذر الاتصال بواتساب' };
  }
}

function authHeaders(token: string): RequestInit['headers'] {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Send a text message. Returns the Meta wamid on success. */
export async function sendTextMessage(opts: {
  phoneNumberId: string;
  token: string;
  to: string; // customer wa_id
  text: string;
}): Promise<{ ok: boolean; wamid?: string; error?: string; code?: string }> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'text',
      text: { preview_url: false, body: opts.text },
    }),
  });
  if (!res.ok) return { ok: false, error: res.error, code: res.status === 429 ? 'RATE_LIMIT' : 'META_ERROR' };
  const wamid = res.data?.messages?.[0]?.id;
  if (!wamid) return { ok: false, error: 'تعذر إرسال الرسالة', code: 'NO_WAMID' };
  return { ok: true, wamid };
}

/**
 * Send an approved TEMPLATE — the only message Meta accepts from a business outside the 24-hour window (after a call nobody
 * answered, the customer has written nothing). `bodyValues` fill the body's {{1}}, {{2}} … in order; none = no components.
 * Same error mapping as `sendTextMessage`: the token never appears in what comes back.
 */
export async function sendTemplateMessage(opts: {
  phoneNumberId: string;
  token: string;
  to: string; // customer wa_id, digits
  templateName: string;
  templateLang: string;
  bodyValues: string[];
}): Promise<{ ok: boolean; wamid?: string; error?: string; code?: string }> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const template: Record<string, unknown> = { name: opts.templateName, language: { code: opts.templateLang } };
  if (opts.bodyValues.length > 0) {
    template.components = [{ type: 'body', parameters: opts.bodyValues.map((text) => ({ type: 'text', text })) }];
  }
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'template',
      template,
    }),
  });
  if (!res.ok) return { ok: false, error: res.error, code: res.status === 429 ? 'RATE_LIMIT' : 'META_ERROR' };
  const wamid = res.data?.messages?.[0]?.id;
  if (!wamid) return { ok: false, error: 'تعذر إرسال الرسالة', code: 'NO_WAMID' };
  return { ok: true, wamid };
}

export type { OutboundMediaKind };

/**
 * UPLOAD A FILE TO META — `POST /{phone-number-id}/media` (multipart), the media id comes back. The bytes were validated by the
 * caller (type sniffed, size capped); this only carries them. The token goes in the header and never into an error.
 */
export async function uploadMedia(opts: {
  phoneNumberId: string;
  token: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{ ok: boolean; mediaId?: string; error?: string; code?: string }> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', opts.mimeType);
  form.append('file', new Blob([new Uint8Array(opts.bytes)], { type: opts.mimeType }), opts.fileName);
  // No Content-Type here: fetch writes the multipart boundary itself.
  const res = await metaFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${opts.token}` }, body: form });
  if (!res.ok) return { ok: false, error: res.error, code: res.status === 429 ? 'RATE_LIMIT' : 'META_ERROR' };
  const mediaId = typeof res.data?.id === 'string' ? res.data.id : null;
  if (!mediaId) return { ok: false, error: 'تعذر رفع الملف إلى واتساب', code: 'NO_MEDIA_ID' };
  return { ok: true, mediaId };
}

/** Send an uploaded media by its id, with an optional caption (image/video/document) and a file name (document). */
export async function sendMediaMessage(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  kind: OutboundMediaKind;
  mediaId: string;
  caption?: string | null;
  fileName?: string | null;
}): Promise<{ ok: boolean; wamid?: string; error?: string; code?: string }> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const media: Record<string, unknown> = { id: opts.mediaId };
  if (opts.caption && opts.kind !== 'audio') media.caption = opts.caption;
  if (opts.kind === 'document' && opts.fileName) media.filename = opts.fileName;
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: opts.kind,
      [opts.kind]: media,
    }),
  });
  if (!res.ok) return { ok: false, error: res.error, code: res.status === 429 ? 'RATE_LIMIT' : 'META_ERROR' };
  const wamid = res.data?.messages?.[0]?.id;
  if (!wamid) return { ok: false, error: 'تعذر إرسال الرسالة', code: 'NO_WAMID' };
  return { ok: true, wamid };
}

/** React to a message (an empty emoji removes the reaction). */
export async function sendReaction(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  targetWamid: string;
  emoji: string;
}): Promise<{ ok: boolean; wamid?: string; error?: string; code?: string }> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'reaction',
      reaction: { message_id: opts.targetWamid, emoji: opts.emoji },
    }),
  });
  if (!res.ok) return { ok: false, error: res.error, code: res.status === 429 ? 'RATE_LIMIT' : 'META_ERROR' };
  const wamid = res.data?.messages?.[0]?.id;
  if (!wamid) return { ok: false, error: 'تعذر إرسال التفاعل', code: 'NO_WAMID' };
  return { ok: true, wamid };
}

/**
 * WHERE META KEEPS A MEDIA FILE — `GET /{media-id}` answers a short-lived URL, the type, the size and the sha256.
 * Only the fields are returned; the URL is checked by the caller before any byte is asked of it.
 */
export async function getMediaInfo(opts: {
  mediaId: string;
  token: string;
}): Promise<{ ok: true; url: string; mimeType: string | null; size: number | null; sha256: string | null } | { ok: false; error: string; status: number }> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(opts.mediaId)) return { ok: false, error: 'معرّف ملف غير صالح', status: 400 };
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(opts.mediaId)}`;
  const res = await metaFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${opts.token}` } });
  if (!res.ok) return { ok: false, error: res.error || 'تعذر الاتصال بواتساب', status: res.status };
  const d = res.data ?? {};
  if (typeof d.url !== 'string') return { ok: false, error: 'تعذر الاتصال بواتساب', status: 502 };
  const size = typeof d.file_size === 'number' ? d.file_size : typeof d.file_size === 'string' ? Number(d.file_size) : null;
  return {
    ok: true,
    url: d.url,
    mimeType: typeof d.mime_type === 'string' ? d.mime_type : null,
    size: size !== null && Number.isFinite(size) ? size : null,
    sha256: typeof d.sha256 === 'string' ? d.sha256 : null,
  };
}

/** Mark an inbound message as read on Meta (best-effort). */
export async function markMessageRead(opts: {
  phoneNumberId: string;
  token: string;
  messageId: string;
}): Promise<boolean> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: opts.messageId,
    }),
  });
  return res.ok;
}

/**
 * «يكتب…» ON THE CUSTOMER'S PHONE while the order bot prepares its answer — one call that also marks their message read
 * (Meta's typing indicator rides on the read receipt and lasts up to 25 seconds or until the reply). Best-effort.
 */
export async function sendTypingIndicator(opts: {
  phoneNumberId: string;
  token: string;
  messageId: string;
}): Promise<boolean> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.phoneNumberId}/messages`;
  const res = await metaFetch(url, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: opts.messageId,
      typing_indicator: { type: 'text' },
    }),
  });
  return res.ok;
}

/** Fetch phone-number metadata for the WABA (used by test/reconnect). */
export async function getPhoneNumberInfo(opts: {
  wabaId: string;
  token: string;
}): Promise<
  | {
      ok: true;
      phones: Array<{ id: string; display_phone_number?: string; verified_name?: string; name?: string }>;
    }
  | { ok: false; error: string; code: string }
> {
  const url = `${GRAPH_BASE}/${GRAPH_VERSION}/${opts.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,name,quality_rating`;
  const res = await metaFetch(url, { method: 'GET', headers: authHeaders(opts.token) });
  if (!res.ok) return { ok: false, error: res.error || 'تعذر الاتصال بواتساب', code: res.status === 401 ? 'AUTH' : 'META_ERROR' };
  const phones = res.data?.data;
  if (!Array.isArray(phones)) {
    return { ok: false, error: 'تعذر الاتصال بواتساب', code: 'BAD_RESPONSE' };
  }
  return { ok: true, phones };
}
