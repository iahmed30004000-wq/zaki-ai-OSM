/**
 * META CLOUD API CLIENT — official WhatsApp Business Cloud API only.
 * Never logs or throws with the token; error surfaces are sanitized.
 */
import { GRAPH_BASE, GRAPH_VERSION } from './config';

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
