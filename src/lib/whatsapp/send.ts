/**
 * WHATSAPP OUTBOUND SEND — server-side send flow used by the messages, media, reaction and template doors.
 * Authorization, tenant scoping and Meta credentials are all resolved here;
 * the frontend can never supply token / phoneNumberId / companyId.
 *
 * Every free-form send (text, photo, file, reaction) checks Meta's 24-hour window first (`service-window.ts`) and refuses with
 * `WINDOW_CLOSED` in Arabic; the template door is the one way out of a closed window.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { requireCompanyTenant, requirePermission } from '../auth';
import { getAccessToken, getPhoneNumberId } from './config';
import { getActiveConnection, effectiveStatus } from './connection';
import { sendMediaMessage, sendReaction, sendTemplateMessage, sendTextMessage, sendTypingIndicator, uploadMedia } from './cloud-api';
import { rateLimit } from '../rate-limit';
import { logAudit } from '../audit';
import { inboxScopeWhere } from './inbox-scope';
import { previewOf, type MessageKind, type MessageMeta } from './message-kinds';
import { serviceWindow, WINDOW_CLOSED_MESSAGE } from './service-window';
import { keepOutboundFile, validateOutboundFile } from './media';
import { afterNoAnswer, templateBodyValues } from './after-no-answer';

export type SendResult =
  | { ok: true; message: any }
  | { ok: false; error: string; status: number; code?: string };

/** Max 4096 chars — Meta text body limit; short preview handled at DB. */
const MAX_TEXT = 4096;
/** Meta's caption limit. */
const MAX_CAPTION = 1024;

type Ready = {
  /** The person sending; null = the order bot (`sendBotText`). */
  user: Awaited<ReturnType<typeof requirePermission>> | null;
  companyId: string;
  conv: {
    id: string;
    customerPhone: string;
    customerName: string | null;
    customerId: string | null;
    connectionId: string;
    lastInboundAt: Date | null;
    botPaused?: boolean;
  };
  conn: { id: string };
  token: string;
  phoneNumberId: string;
};

type Sender = Awaited<ReturnType<typeof requirePermission>>;

/**
 * Which conversation, which connection, which credentials — and the window, unless `template`. The caller has already asked
 * for `whatsapp.send` (each exported send asks it in its own first line, so the door is visible where it is called).
 */
async function prepare(user: Sender, conversationId: string, opts: { template?: boolean } = {}): Promise<{ ok: true; ready: Ready } | Extract<SendResult, { ok: false }>> {
  const { companyId } = await requireCompanyTenant();

  const rl = rateLimit(`wa-send:${companyId}:${user.id}`, 30, 60 * 1000);
  if (!rl.allowed) {
    return { ok: false, error: `محاولات إرسال كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية`, status: 429 };
  }

  // Only into a conversation the sender's `whatsapp.view` reaches (ASSIGNED = hers and unassigned) — PR-13.
  const mine = inboxScopeWhere(user);
  const conv = await db.whatsAppConversation.findFirst({
    where: { id: conversationId, companyId, ...(mine ? { AND: [mine] } : {}) },
  });
  if (!conv) {
    return { ok: false, error: 'المحادثة غير موجودة', status: 404 };
  }

  const conn = await getActiveConnection(companyId);
  if (!conn || conv.connectionId !== conn.id) {
    return { ok: false, error: 'لم يتم ربط واتساب بعد', status: 400 };
  }
  if ((await effectiveStatus(conn)) !== 'CONNECTED') {
    return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  }
  if (!opts.template && !serviceWindow(conv.lastInboundAt ?? null).open) {
    return { ok: false, error: WINDOW_CLOSED_MESSAGE, status: 409, code: 'WINDOW_CLOSED' };
  }
  const token = await getAccessToken();
  const phoneNumberId = await getPhoneNumberId();
  if (!token || !phoneNumberId) {
    return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  }
  return { ok: true, ready: { user, companyId, conv, conn, token, phoneNumberId } };
}

async function metaRefused(ready: Ready, res: { error?: string; code?: string }): Promise<Extract<SendResult, { ok: false }>> {
  const safe = res.error || 'تعذر إرسال الرسالة';
  await db.whatsAppConnection.update({ where: { id: ready.conn.id }, data: { lastError: safe } }).catch(() => {});
  return { ok: false, error: safe, status: res.code === 'RATE_LIMIT' ? 429 : 502 };
}

/** The row, the conversation's preview and the connection's clock, once Meta said yes. */
async function record(
  ready: Ready,
  data: {
    id?: string;
    wamid: string;
    messageType: MessageKind;
    text: string | null;
    meta?: MessageMeta | null;
    media?: { mediaId: string; mimeType: string; fileName: string | null; mediaKey: string | null; mediaSize: number };
    reactionToExternalId?: string | null;
  },
  movesPreview = true
) {
  const { companyId, conv, conn, user } = ready;
  const byBot = user === null;
  const message = await db.whatsAppMessage.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      companyId,
      conversationId: conv.id,
      connectionId: conn.id,
      externalMessageId: data.wamid,
      direction: 'OUTBOUND',
      messageType: data.messageType,
      text: data.text,
      status: 'SENT',
      senderPhone: null,
      recipientPhone: conv.customerPhone,
      ...(byBot ? { sentByBot: true } : {}),
      meta: (data.meta ?? undefined) as Prisma.InputJsonObject | undefined,
      reactionToExternalId: data.reactionToExternalId ?? null,
      ...(data.media
        ? {
            mediaId: data.media.mediaId,
            mimeType: data.media.mimeType,
            fileName: data.media.fileName,
            mediaKey: data.media.mediaKey,
            mediaSize: data.media.mediaSize,
            mediaStatus: data.media.mediaKey ? 'STORED' : 'FAILED',
          }
        : {}),
    },
  });
  const now = new Date();
  /*
   * ANY MESSAGE A PERSON SENDS SILENCES THE ORDER BOT HERE (the owner, 2026-11-26): text, photo, file, reaction, template.
   * In the same write as the preview, and only when it was not already silent — a second reply does not move the time.
   */
  const silence = !byBot && conv.botPaused === false ? { botPaused: true, botPausedReason: 'STAFF_REPLIED', botPausedAt: now } : {};
  await db.whatsAppConversation.update({
    where: { id: conv.id },
    data: movesPreview
      ? { lastMessageAt: now, lastMessagePreview: previewOf(data.messageType, data.text, data.meta), lastMessageType: data.messageType, ...silence }
      : { lastMessageAt: now, ...silence },
  });
  await db.whatsAppConnection.update({
    where: { id: conn.id },
    data: { lastMessageAt: now, lastError: null },
  });
  logAudit({
    companyId,
    userId: user?.id ?? null,
    action: byBot ? 'whatsapp.bot.message.send' : data.messageType === 'TEXT' ? 'whatsapp.message.send' : `whatsapp.${data.messageType.toLowerCase()}.send`,
    entity: 'WhatsAppMessage',
    entityId: message.id,
    newData: { conversationId: conv.id, ...(Object.keys(silence).length ? { botPaused: 'STAFF_REPLIED' } : {}) },
  }).catch(() => {});
  return message;
}

/**
 * THE ORDER BOT'S REPLY — a plain text, through the same checks as a person's (the connection, Meta's 24-hour window) and
 * the same record, marked `sentByBot`. No session and no permission: the bot is not a person, and the conversation is
 * found by its id and company only. It refuses when the conversation was paused meanwhile (a person answered while the
 * model was thinking). Never a template: the bot only answers a customer who wrote, inside the window.
 */
export async function sendBotText(companyId: string, conversationId: string, text: string): Promise<SendResult> {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length > MAX_TEXT) return { ok: false, error: 'الرسالة غير صالحة', status: 400 };
  const conv = await db.whatsAppConversation.findFirst({ where: { id: conversationId, companyId } });
  if (!conv) return { ok: false, error: 'المحادثة غير موجودة', status: 404 };
  if (conv.botPaused) return { ok: false, error: 'البوت موقوف بهالمحادثة', status: 409, code: 'BOT_PAUSED' };
  const conn = await getActiveConnection(companyId);
  if (!conn || conv.connectionId !== conn.id || (await effectiveStatus(conn)) !== 'CONNECTED') {
    return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  }
  if (!serviceWindow(conv.lastInboundAt ?? null).open) {
    return { ok: false, error: WINDOW_CLOSED_MESSAGE, status: 409, code: 'WINDOW_CLOSED' };
  }
  const token = await getAccessToken();
  const phoneNumberId = await getPhoneNumberId();
  if (!token || !phoneNumberId) return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  const ready: Ready = { user: null, companyId, conv, conn, token, phoneNumberId };
  const res = await sendTextMessage({ phoneNumberId, token, to: conv.customerPhone, text: trimmed });
  if (!res.ok || !res.wamid) return metaRefused(ready, res);
  const message = await record(ready, { wamid: res.wamid, messageType: 'TEXT', text: trimmed });
  return { ok: true, message };
}

/** «يكتب…» on the customer's phone while the bot prepares its answer. Best-effort: false on anything missing. */
export async function botTyping(companyId: string, inboundWamid: string): Promise<boolean> {
  try {
    const conn = await getActiveConnection(companyId);
    if (!conn || (await effectiveStatus(conn)) !== 'CONNECTED') return false;
    const token = await getAccessToken();
    const phoneNumberId = await getPhoneNumberId();
    if (!token || !phoneNumberId) return false;
    return await sendTypingIndicator({ phoneNumberId, token, messageId: inboundWamid });
  } catch {
    return false;
  }
}

export async function sendOutboundMessage(conversationId: string, text: string): Promise<SendResult> {
  const user = await requirePermission('whatsapp.send');
  const trimmed = (text || '').trim();
  const p = await prepare(user, conversationId);
  if (!p.ok) return p;
  if (!trimmed || trimmed.length > MAX_TEXT) {
    return { ok: false, error: 'الرسالة غير صالحة', status: 400 };
  }
  const { ready } = p;
  const res = await sendTextMessage({ phoneNumberId: ready.phoneNumberId, token: ready.token, to: ready.conv.customerPhone, text: trimmed });
  if (!res.ok || !res.wamid) return metaRefused(ready, res);
  const message = await record(ready, { wamid: res.wamid, messageType: 'TEXT', text: trimmed });
  return { ok: true, message };
}

/**
 * A PHOTO OR A FILE FROM THE STAFF'S DEVICE. Judged first (sniffed type, Meta's size per kind), uploaded to Meta, sent by its
 * media id, and kept on our disk so the thread shows what left.
 */
export async function sendOutboundMedia(
  conversationId: string,
  file: { bytes: Buffer; declaredMime: string; fileName: string; caption?: string | null; want: 'image' | 'file' }
): Promise<SendResult> {
  const user = await requirePermission('whatsapp.send');
  const p = await prepare(user, conversationId);
  if (!p.ok) return p;
  const check = validateOutboundFile(file);
  if (!check.ok) return { ok: false, error: check.error, status: 400, code: 'BAD_FILE' };
  const caption = (file.caption || '').trim().slice(0, MAX_CAPTION) || null;
  const { ready } = p;

  const up = await uploadMedia({ phoneNumberId: ready.phoneNumberId, token: ready.token, bytes: file.bytes, mimeType: check.mime, fileName: check.fileName });
  if (!up.ok || !up.mediaId) return metaRefused(ready, up);
  const res = await sendMediaMessage({
    phoneNumberId: ready.phoneNumberId,
    token: ready.token,
    to: ready.conv.customerPhone,
    kind: check.kind,
    mediaId: up.mediaId,
    caption: check.kind === 'audio' ? null : caption,
    fileName: check.kind === 'document' ? check.fileName : null,
  });
  if (!res.ok || !res.wamid) return metaRefused(ready, res);

  const id = randomUUID();
  const mediaKey = await keepOutboundFile(ready.companyId, id, check.mime, file.bytes);
  const messageType = check.kind.toUpperCase() as MessageKind;
  const message = await record(ready, {
    id,
    wamid: res.wamid,
    messageType,
    text: check.kind === 'audio' ? null : caption,
    media: { mediaId: up.mediaId, mimeType: check.mime, fileName: check.kind === 'document' ? check.fileName : null, mediaKey, mediaSize: check.size },
  });
  return { ok: true, message };
}

/** One emoji on a message of this conversation; an empty emoji takes the reaction away. */
export async function sendOutboundReaction(conversationId: string, messageId: string, emoji: string): Promise<SendResult> {
  const user = await requirePermission('whatsapp.send');
  const e = (emoji || '').trim();
  if (e.length > 16) return { ok: false, error: 'تفاعل غير صالح', status: 400 };
  const p = await prepare(user, conversationId);
  if (!p.ok) return p;
  const { ready } = p;
  const target = await db.whatsAppMessage.findFirst({
    where: { id: messageId, conversationId: ready.conv.id, companyId: ready.companyId, messageType: { not: 'REACTION' } },
    select: { externalMessageId: true },
  });
  if (!target) return { ok: false, error: 'الرسالة غير موجودة', status: 404 };
  const res = await sendReaction({ phoneNumberId: ready.phoneNumberId, token: ready.token, to: ready.conv.customerPhone, targetWamid: target.externalMessageId, emoji: e });
  if (!res.ok || !res.wamid) return metaRefused(ready, res);
  const message = await record(ready, { wamid: res.wamid, messageType: 'REACTION', text: e || null, reactionToExternalId: target.externalMessageId }, false);
  return { ok: true, message };
}

/**
 * THE WAY OUT OF A CLOSED WINDOW: the company's approved template (named on «بعد لا يرد» — the same one the call sheet sends),
 * filled with the customer's name and last order number when the template asks for them.
 */
export async function sendWindowTemplate(conversationId: string): Promise<SendResult> {
  const user = await requirePermission('whatsapp.send');
  const p = await prepare(user, conversationId, { template: true });
  if (!p.ok) return p;
  const { ready } = p;
  const setting = await afterNoAnswer(db, ready.companyId);
  if (!setting.templateName) {
    return { ok: false, error: 'ما في قالب معتمد مسمّى بالإعدادات («بعد لا يرد») — اطلب من المدير تسميته أولاً.', status: 409, code: 'NO_TEMPLATE' };
  }
  let orderNumber: string | null = null;
  if (setting.templateParams === 'name_order' && ready.conv.customerId) {
    const last = await db.order.findFirst({
      where: { companyId: ready.companyId, customerId: ready.conv.customerId },
      orderBy: { createdAt: 'desc' },
      select: { orderNumber: true },
    });
    orderNumber = last?.orderNumber ?? null;
  }
  const res = await sendTemplateMessage({
    phoneNumberId: ready.phoneNumberId,
    token: ready.token,
    to: ready.conv.customerPhone,
    templateName: setting.templateName,
    templateLang: setting.templateLang,
    bodyValues: templateBodyValues(setting.templateParams, { customerName: ready.conv.customerName, orderNumber }),
  });
  if (!res.ok || !res.wamid) return metaRefused(ready, res);
  const message = await record(ready, { wamid: res.wamid, messageType: 'TEMPLATE', text: `قالب «${setting.templateName}»` });
  return { ok: true, message };
}

/** Is the window's way out there for this company — a template named? Any failure: no. */
export async function templateReady(companyId: string): Promise<boolean> {
  try {
    return Boolean((await afterNoAnswer(db, companyId)).templateName);
  } catch {
    return false;
  }
}
