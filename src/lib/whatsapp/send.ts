/**
 * WHATSAPP OUTBOUND SEND — server-side send flow used by the messages API.
 * Authorization, tenant scoping and Meta credentials are all resolved here;
 * the frontend can never supply token / phoneNumberId / companyId.
 */
import { db } from '../db';
import { requireCompanyTenant, requirePermission } from '../auth';
import { getAccessToken, getPhoneNumberId } from './config';
import { getActiveConnection, effectiveStatus } from './connection';
import { sendTextMessage } from './cloud-api';
import { rateLimit } from '../rate-limit';
import { logAudit } from '../audit';
import { inboxScopeWhere } from './inbox-scope';

export type SendResult =
  | { ok: true; message: any }
  | { ok: false; error: string; status: number };

/** Max 4096 chars — Meta text body limit; short preview handled at DB. */
const MAX_TEXT = 4096;

export async function sendOutboundMessage(
  conversationId: string,
  text: string
): Promise<SendResult> {
  const user = await requirePermission('whatsapp.send');
  const { companyId } = await requireCompanyTenant();

  const rl = rateLimit(`wa-send:${companyId}:${user.id}`, 30, 60 * 1000);
  if (!rl.allowed) {
    return { ok: false, error: `محاولات إرسال كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية`, status: 429 };
  }

  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length > MAX_TEXT) {
    return { ok: false, error: 'الرسالة غير صالحة', status: 400 };
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
  if (effectiveStatus(conn) !== 'CONNECTED') {
    return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  }
  const token = getAccessToken();
  const phoneNumberId = getPhoneNumberId();
  if (!token || !phoneNumberId) {
    return { ok: false, error: 'الاتصال غير مكتمل', status: 400 };
  }

  const res = await sendTextMessage({ phoneNumberId, token, to: conv.customerPhone, text: trimmed });
  if (!res.ok || !res.wamid) {
    const safe = res.error || 'تعذر إرسال الرسالة';
    await db.whatsAppConnection.update({
      where: { id: conn.id },
      data: { lastError: safe },
    });
    return { ok: false, error: safe, status: res.code === 'RATE_LIMIT' ? 429 : 502 };
  }

  const message = await db.whatsAppMessage.create({
    data: {
      companyId,
      conversationId: conv.id,
      connectionId: conn.id,
      externalMessageId: res.wamid,
      direction: 'OUTBOUND',
      messageType: 'TEXT',
      text: trimmed,
      status: 'SENT',
      senderPhone: null,
      recipientPhone: conv.customerPhone,
    },
  });
  const preview = trimmed.slice(0, 120);
  await db.whatsAppConversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: new Date(), lastMessagePreview: preview },
  });
  await db.whatsAppConnection.update({
    where: { id: conn.id },
    data: { lastMessageAt: new Date(), lastError: null },
  });

  logAudit({
    companyId,
    userId: user.id,
    action: 'whatsapp.message.send',
    entity: 'WhatsAppMessage',
    entityId: message.id,
    newData: { conversationId: conv.id },
  }).catch(() => {});

  return { ok: true, message };
}
