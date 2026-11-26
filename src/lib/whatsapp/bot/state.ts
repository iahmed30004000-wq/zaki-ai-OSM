/**
 * THE BOT'S STATE IN ONE CONVERSATION — paused or not, why, and whether staff should look (`whatsapp_conversations.bot*`).
 *
 * The owner's rules (2026-11-26): the bot goes silent in a conversation the moment an employee sends anything there; staff
 * give it back («رجّع البوت») or stop it («أوقف البوت») with a press; a customer who asks for a person is handed over (the
 * bot stops and the conversation is marked for staff); and any failure stops it the same way — never a second try that
 * could spam the customer.
 */
import { db } from '../../db';
import { logAudit } from '../../audit';
import { notify } from '../../notify';

export const PAUSE_REASON = {
  STAFF_REPLIED: 'STAFF_REPLIED',
  STAFF_PAUSED: 'STAFF_PAUSED',
  HANDOFF: 'HANDOFF',
  FAILED: 'FAILED',
  RATE_LIMIT: 'RATE_LIMIT',
} as const;
export type PauseReason = (typeof PAUSE_REASON)[keyof typeof PAUSE_REASON];

/** The inbox's status line, after «موقوف — ». */
export const PAUSE_REASON_AR: Record<string, string> = {
  STAFF_REPLIED: 'رد موظف',
  STAFF_PAUSED: 'أوقفه موظف',
  HANDOFF: 'الزبون بدّه موظف',
  FAILED: 'تعطّل — راجع المحادثة',
  RATE_LIMIT: 'رسائل كتير بساعة',
};

export const INBOX_PATH = '/growth/whatsapp/inbox';

/** What a screen is told about the bot in one conversation. */
export interface ConversationBotView {
  paused: boolean;
  reason: string | null;
  reasonAr: string | null;
  handoff: boolean;
  /** A turn is running now: the screen draws «يكتب…». */
  typing: boolean;
}

export function conversationBotView(
  c: { botPaused?: boolean | null; botPausedReason?: string | null; botHandoff?: boolean | null; botBusyUntil?: Date | string | null },
  now: number = Date.now()
): ConversationBotView {
  const busy = c.botBusyUntil ? new Date(c.botBusyUntil).getTime() > now : false;
  return {
    paused: c.botPaused === true,
    reason: c.botPausedReason ?? null,
    reasonAr: c.botPaused && c.botPausedReason ? PAUSE_REASON_AR[c.botPausedReason] ?? null : null,
    handoff: c.botHandoff === true,
    typing: busy && c.botPaused !== true,
  };
}

/**
 * Stop the bot in this conversation. The same state twice writes nothing (a second staff reply does not move the time).
 * `handoff` also marks the conversation for staff and tells the people who answer WhatsApp.
 */
export async function pauseBot(
  conversationId: string,
  reason: PauseReason,
  opts: { handoff?: boolean; userId?: string | null; note?: string } = {}
): Promise<boolean> {
  const now = new Date();
  const done = await db.whatsAppConversation.updateMany({
    where: { id: conversationId, botPaused: false },
    data: { botPaused: true, botPausedReason: reason, botPausedAt: now, ...(opts.handoff ? { botHandoff: true } : {}) },
  });
  if (done.count === 0) {
    // Already paused: a hand-off still raises the flag (a staff pause, then a failure, is still «look here»).
    if (opts.handoff) await db.whatsAppConversation.updateMany({ where: { id: conversationId }, data: { botHandoff: true } });
    return false;
  }
  const conv = await db.whatsAppConversation.findUnique({
    where: { id: conversationId },
    select: { companyId: true, customerName: true, customerPhone: true },
  });
  if (!conv) return true;
  await logAudit({
    companyId: conv.companyId,
    userId: opts.userId ?? null,
    action: 'WHATSAPP_BOT_PAUSED',
    entity: 'WhatsAppConversation',
    entityId: conversationId,
    previousData: { botPaused: false },
    newData: { botPaused: true, reason, handoff: opts.handoff === true },
  }).catch(() => {});
  if (opts.handoff) {
    notify({
      companyId: conv.companyId,
      storeId: null,
      audience: { permission: 'whatsapp.send' },
      actorId: opts.userId ?? null,
      title: 'محادثة واتساب بدها موظف',
      message: `${conv.customerName || conv.customerPhone}: ${opts.note || PAUSE_REASON_AR[reason] || 'البوت وقف'} — البوت ساكت بهالمحادثة لحتى ترجّعوه.`,
      type: 'SYSTEM_ALERT',
      link: INBOX_PATH,
    });
  }
  return true;
}

/** «رجّع البوت»: it answers again from the customer's next message; the hand-off flag is cleared with it. */
export async function resumeBot(conversationId: string, userId: string): Promise<boolean> {
  const done = await db.whatsAppConversation.updateMany({
    where: { id: conversationId, OR: [{ botPaused: true }, { botHandoff: true }] },
    data: { botPaused: false, botPausedReason: null, botPausedAt: null, botHandoff: false },
  });
  if (done.count === 0) return false;
  const conv = await db.whatsAppConversation.findUnique({ where: { id: conversationId }, select: { companyId: true } });
  if (conv) {
    await logAudit({
      companyId: conv.companyId,
      userId,
      action: 'WHATSAPP_BOT_RESUMED',
      entity: 'WhatsAppConversation',
      entityId: conversationId,
      previousData: { botPaused: true },
      newData: { botPaused: false },
    }).catch(() => {});
  }
  return true;
}
