import { db } from '../db';
import { logAudit } from '../audit';
import { typed } from '../text-search';
import { normalizePhoneNumber } from '../phone';
import { DIRECTION, EVENT, LANDING_INBOX_PATH } from '../v1/landing-chat-inbox';

/**
 * «رسائل اللاندينج» — THE STAFF SIDE OF THE LANDING CHAT INBOX.
 *
 * The threads Zaki pages relays (`src/lib/v1/landing-chat-inbox.ts`, contract oms-lp.v1 §11), read and answered here.
 * The permissions are the WhatsApp inbox's own — `whatsapp.view` to read, `whatsapp.send` to answer and to pause or give
 * back the bot — so nobody gains or loses a screen and no role has to be edited (the owner's default, 18/11).
 *
 * THE PAUSE. A staff reply pauses the bot for its thread (one `BOT_PAUSED` line, then the reply, in one transaction), and
 * «رجّع للبوت» gives it back (`BOT_RESUMED`). Zaki pages reads both lines in order from `GET /chat/updates` and the
 * customer's window shows the reply under «فريق الدعم».
 *
 * Nothing here logs a message's text or a phone.
 */

export type ThreadFilter = 'all' | 'unread' | 'staff';

const LIST_SELECT = {
  id: true,
  mode: true,
  pageName: true,
  pageSlug: true,
  productName: true,
  orderNumber: true,
  orderId: true,
  customerName: true,
  customerPhone: true,
  botPaused: true,
  unreadCount: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  createdAt: true,
} as const;

export async function listLandingThreads(companyId: string, opts: { filter?: ThreadFilter; q?: string; cursor?: string }) {
  const where: Record<string, unknown> = { companyId };
  if (opts.filter === 'unread') where.unreadCount = { gt: 0 };
  if (opts.filter === 'staff') where.botPaused = true;
  const q = opts.q?.trim();
  if (q) {
    const norm = normalizePhoneNumber(q);
    where.OR = [
      { customerPhone: typed(norm || q) },
      { customerName: typed(q) },
      { orderNumber: typed(q) },
      { pageName: typed(q) },
      { productName: typed(q) },
    ];
  }
  const take = 50;
  const rows = await db.landingChatThread.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: LIST_SELECT,
  });
  return { threads: rows.slice(0, take), nextCursor: rows.length > take ? rows[take - 1].id : null };
}

/** How many threads wait on somebody: for the tab's own number. */
export async function unreadLandingThreads(companyId: string): Promise<number> {
  return db.landingChatThread.count({ where: { companyId, unreadCount: { gt: 0 } } });
}

const MESSAGE_SELECT = { id: true, seq: true, direction: true, text: true, event: true, authorName: true, sentAt: true } as const;

function lineOut(m: { id: string; seq: bigint; direction: string; text: string | null; event: string | null; authorName: string | null; sentAt: Date }) {
  return { id: m.id, seq: m.seq.toString(), direction: m.direction, text: m.text, event: m.event, authorName: m.authorName, at: m.sentAt.toISOString() };
}

/** One thread and its lines — all of them, or those after `afterSeq` (the open thread's poll). Null when it is not this company's. */
export async function readLandingThread(companyId: string, id: string, afterSeq?: string) {
  const thread = await db.landingChatThread.findFirst({ where: { companyId, id }, select: { ...LIST_SELECT, pageUrl: true, botPausedAt: true } });
  if (!thread) return null;
  const after = afterSeq && /^\d{1,18}$/.test(afterSeq) ? BigInt(afterSeq) : null;
  const rows = await db.landingChatMessage.findMany({
    where: { threadId: thread.id, ...(after !== null ? { seq: { gt: after } } : {}) },
    orderBy: { seq: 'asc' },
    take: 500,
    select: MESSAGE_SELECT,
  });
  return { thread, messages: rows.map(lineOut) };
}

export type StaffAnswer =
  | { ok: true; message: ReturnType<typeof lineOut>; botPaused: boolean }
  | { ok: false; status: number; error: string };

/** A staff reply. The first one pauses the bot (the pause line first, then the reply, together). */
export async function replyAsStaff(
  companyId: string,
  user: { id: string; name?: string | null },
  id: string,
  text: string
): Promise<StaffAnswer> {
  const thread = await db.landingChatThread.findFirst({ where: { companyId, id }, select: { id: true, botPaused: true } });
  if (!thread) return { ok: false, status: 404, error: 'المحادثة غير موجودة' };
  const now = new Date();
  const authorName = user.name?.trim() || null;
  const message = await db.$transaction(async (tx) => {
    if (!thread.botPaused) {
      await tx.landingChatMessage.create({
        data: { companyId, threadId: thread.id, direction: DIRECTION.EVENT, event: EVENT.PAUSED, authorId: user.id, authorName, sentAt: now },
      });
    }
    const made = await tx.landingChatMessage.create({
      data: { companyId, threadId: thread.id, direction: DIRECTION.STAFF, text, authorId: user.id, authorName, sentAt: now },
      select: MESSAGE_SELECT,
    });
    await tx.landingChatThread.update({
      where: { id: thread.id },
      data: {
        ...(thread.botPaused ? {} : { botPaused: true, botPausedAt: now, botPausedById: user.id }),
        unreadCount: 0,
        lastMessageAt: now,
        lastMessagePreview: text.replace(/\s+/g, ' ').trim().slice(0, 120),
      },
    });
    return made;
  });
  if (!thread.botPaused) {
    await logAudit({ companyId, userId: user.id, action: 'LANDING_CHAT_BOT_PAUSED', entity: 'LandingChatThread', entityId: thread.id, previousData: { botPaused: false }, newData: { botPaused: true, via: 'staff_reply' } });
  }
  return { ok: true, message: lineOut(message), botPaused: true };
}

/** «رجّع للبوت» (paused = false), or «أوقف البوت» without a reply (paused = true). The same state twice writes nothing. */
export async function setLandingBotPaused(
  companyId: string,
  user: { id: string; name?: string | null },
  id: string,
  paused: boolean
): Promise<{ ok: true; botPaused: boolean; changed: boolean } | { ok: false; status: number; error: string }> {
  const thread = await db.landingChatThread.findFirst({ where: { companyId, id }, select: { id: true, botPaused: true } });
  if (!thread) return { ok: false, status: 404, error: 'المحادثة غير موجودة' };
  if (thread.botPaused === paused) return { ok: true, botPaused: paused, changed: false };
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.landingChatMessage.create({
      data: {
        companyId,
        threadId: thread.id,
        direction: DIRECTION.EVENT,
        event: paused ? EVENT.PAUSED : EVENT.RESUMED,
        authorId: user.id,
        authorName: user.name?.trim() || null,
        sentAt: now,
      },
    });
    await tx.landingChatThread.update({
      where: { id: thread.id },
      data: paused ? { botPaused: true, botPausedAt: now, botPausedById: user.id } : { botPaused: false, botPausedAt: null, botPausedById: null },
    });
  });
  await logAudit({
    companyId,
    userId: user.id,
    action: paused ? 'LANDING_CHAT_BOT_PAUSED' : 'LANDING_CHAT_BOT_RESUMED',
    entity: 'LandingChatThread',
    entityId: thread.id,
    previousData: { botPaused: !paused },
    newData: { botPaused: paused },
  });
  return { ok: true, botPaused: paused, changed: true };
}

/** The thread read: its unread count back to zero, and this person's notices of the inbox read with it. */
export async function markLandingThreadRead(companyId: string, userId: string, id: string): Promise<boolean> {
  const done = await db.landingChatThread.updateMany({ where: { companyId, id }, data: { unreadCount: 0 } });
  if (done.count === 0) return false;
  await db.notification.updateMany({ where: { companyId, userId, isRead: false, type: 'LANDING_CHAT', link: LANDING_INBOX_PATH }, data: { isRead: true } });
  return true;
}
