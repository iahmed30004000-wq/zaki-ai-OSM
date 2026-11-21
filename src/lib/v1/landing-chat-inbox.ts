import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { notify } from '../notify';

/**
 * «رسائل اللاندينج» AT THE LANDING DOOR (contract `oms-lp.v1` §11).
 *
 * Zaki pages runs a chat assistant on its landing and store pages. Every conversation of it comes here, from its first
 * message, live: the customer's lines and the assistant's (text only — never a tool call), with the page, the product,
 * the order number once there is one, and the name and phone once the customer gave them. The staff read and answer them
 * in «المحادثات ← رسائل اللاندينج», and Zaki pages shows the staff's answers in the customer's chat window.
 *
 * ── TWO DOORS, BOTH ON THE LANDING KEY'S `orders.create` ──
 *
 *   · `POST /chat/messages` — one thread (Zaki pages' session id) and the lines it has not sent yet. Upserted per company on
 *     the session id, and each line is unique per thread on Zaki pages' own message id: a relay sent twice, under the
 *     same `Idempotency-Key` or under a new one, writes nothing twice. The answer carries the pause as it stands here.
 *   · `GET /chat/updates?after=<seq>` — what the staff did, in order, for every thread of the company: their replies, and
 *     the bot paused or given back. Zaki pages reads it every few seconds and keeps the cursor.
 *
 * ── THE PAUSE ──
 *
 * The first staff reply in a thread pauses the bot for it (`BOT_PAUSED`, then the reply), and only «رجّع للبوت» gives it
 * back (`BOT_RESUMED`). It lives HERE; Zaki pages mirrors it from the updates and asks nothing of the model meanwhile.
 *
 * ── WHAT IT NEVER DOES ──
 *
 *   · Read a company from the request: it is the key's (`requireSystemToken`).
 *   · Write an order, a customer or a figure. A thread names its order by number and links it when this company has it.
 *   · Log a message's text or a phone. Nothing here writes to the console at all.
 */

export const DIRECTION = { CUSTOMER: 'CUSTOMER', BOT: 'BOT', STAFF: 'STAFF', EVENT: 'EVENT' } as const;
export const EVENT = { PAUSED: 'BOT_PAUSED', RESUMED: 'BOT_RESUMED' } as const;

/** The screen every notice of this inbox points at — the plain path, so the menu's unread count finds it. */
export const LANDING_INBOX_PATH = '/growth/landing-chats';

/** At most this many lines in one relay; Zaki pages sends the rest in the next one. */
export const RELAY_MAX_LINES = 100;
/** At most this many updates per read; the cursor carries on from the last one. */
export const UPDATES_PAGE = 200;
/**
 * A line written in the last moment is not handed out yet: a cursor must never pass a line whose transaction has not
 * committed, or that line would be skipped for good. Zaki pages reads again a few seconds later anyway.
 */
export const SETTLE_MS = 1500;

export const CHAT_INBOX_REFUSAL_AR = {
  NOT_JSON: 'بيانات المحادثة غير مقروءة.',
  MISSING: 'المحادثة تحتاج معرّفها (sessionId).',
  INVALID: 'بيانات المحادثة غير صالحة.',
} as const;

/** A text field the page may send empty, as null or not at all: all three are «nothing». */
const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const t = typeof v === 'string' ? v.trim() : '';
      return t ? t.slice(0, max) : null;
    });

const lineSchema = z.object({
  id: z.string().trim().min(1).max(64),
  role: z.enum(['customer', 'bot']),
  text: z.string().max(4000),
  at: z
    .union([z.string().max(64), z.null()])
    .optional()
    .refine((v) => v == null || v === '' || !Number.isNaN(new Date(v).getTime()), { message: 'date' }),
});

export const relaySchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  mode: z.enum(['confirm', 'intake']).optional(),
  page: z
    .object({ id: optionalText(200), slug: optionalText(200), name: optionalText(200), url: optionalText(2000) })
    .optional()
    .nullable(),
  productId: optionalText(64),
  productName: optionalText(300),
  orderNumber: optionalText(64),
  customerName: optionalText(120),
  customerPhone: optionalText(40),
  messages: z.array(lineSchema).max(RELAY_MAX_LINES).optional(),
});

export type RelayInput = z.infer<typeof relaySchema>;
export type ChatInboxRefusal = { ok: false; status: 400; body: { error: string } };
const refuse = (error: string): ChatInboxRefusal => ({ ok: false, status: 400, body: { error } });

/** The body, read and checked — or the sentence that says why not. Field values are never echoed back. */
export function readRelay(raw: string): { ok: true; data: RelayInput } | ChatInboxRefusal {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refuse(CHAT_INBOX_REFUSAL_AR.NOT_JSON);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse(CHAT_INBOX_REFUSAL_AR.NOT_JSON);
  const p = payload as Record<string, unknown>;
  if (typeof p.sessionId !== 'string' || p.sessionId.trim() === '') return refuse(CHAT_INBOX_REFUSAL_AR.MISSING);
  const parsed = relaySchema.safeParse(payload);
  if (!parsed.success) return refuse(CHAT_INBOX_REFUSAL_AR.INVALID);
  return { ok: true, data: parsed.data };
}

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120);

/** What the page knows about the thread — only the fields it sent, so a later relay never empties a known phone. */
function threadFacts(input: RelayInput) {
  const facts: Record<string, string> = {};
  const put = (k: string, v: string | null | undefined) => {
    if (v) facts[k] = v;
  };
  put('mode', input.mode ?? null);
  put('pageId', input.page?.id);
  put('pageSlug', input.page?.slug);
  put('pageName', input.page?.name);
  put('pageUrl', input.page?.url);
  put('productId', input.productId);
  put('productName', input.productName);
  put('orderNumber', input.orderNumber);
  put('customerName', input.customerName);
  put('customerPhone', input.customerPhone);
  return facts;
}

const THREAD_ANSWER = { id: true, botPaused: true, unreadCount: true, orderNumber: true, orderId: true, pageName: true, productName: true } as const;

/** The thread of this session, made the first time it is seen. Two first relays at once: one creates, the other reads it. */
async function threadFor(companyId: string, externalId: string, facts: Record<string, string>, countryId: string | null) {
  const known = await db.landingChatThread.findUnique({ where: { companyId_externalId: { companyId, externalId } }, select: THREAD_ANSWER });
  if (known) return { thread: known, created: false };
  try {
    // A key bound to one country opens its country's thread (`landing-country.ts`); a key of every country, as before.
    const thread = await db.landingChatThread.create({
      data: { companyId, externalId, ...facts, ...(countryId ? { countryId } : {}) },
      select: THREAD_ANSWER,
    });
    return { thread, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await db.landingChatThread.findUnique({ where: { companyId_externalId: { companyId, externalId } }, select: THREAD_ANSWER });
      if (again) return { thread: again, created: false };
    }
    throw e;
  }
}

/**
 * ONE RELAY: the thread upserted, the lines not yet here written, the unread count and the preview moved on.
 * `201` when the thread is new, `200` otherwise. The answer is `{ threadId, botPaused, written }`.
 */
export async function relayChatLines(
  companyId: string,
  input: RelayInput,
  now: Date = new Date(),
  /** The key's country (`landing-country.ts`, which has already kept the input to it); null for a key of every country. */
  countryId: string | null = null
): Promise<{ status: 200 | 201; body: { threadId: string; botPaused: boolean; written: number } }> {
  const facts = threadFacts(input);
  const { thread, created } = await threadFor(companyId, input.sessionId, facts, countryId);

  // The order is linked once its number is this company's.
  let orderId: string | null = thread.orderId;
  if (facts.orderNumber && (facts.orderNumber !== thread.orderNumber || !orderId)) {
    const order = await db.order.findFirst({ where: { companyId, orderNumber: facts.orderNumber }, select: { id: true } });
    orderId = order?.id ?? null;
  }

  // Only lines with words; the same id twice in one body counts once.
  const seen = new Set<string>();
  const lines = (input.messages ?? []).filter((m) => m.text.trim() && !seen.has(m.id) && seen.add(m.id));
  const already = lines.length
    ? await db.landingChatMessage.findMany({
        where: { threadId: thread.id, externalId: { in: lines.map((m) => m.id) } },
        select: { externalId: true },
      })
    : [];
  const here = new Set(already.map((m) => m.externalId));
  const fresh = lines.filter((m) => !here.has(m.id));

  let written = 0;
  if (fresh.length) {
    const made = await db.landingChatMessage.createMany({
      data: fresh.map((m) => ({
        companyId,
        threadId: thread.id,
        externalId: m.id,
        direction: m.role === 'customer' ? DIRECTION.CUSTOMER : DIRECTION.BOT,
        text: m.text.slice(0, 4000),
        sentAt: m.at ? new Date(m.at) : now,
      })),
      skipDuplicates: true,
    });
    written = made.count;
  }

  const customerLines = fresh.filter((m) => m.role === 'customer').length;
  const last = fresh.at(-1);
  // A line already here (a race between two relays) is not counted twice: the unread count follows what was written.
  const unreadBy = written === fresh.length ? customerLines : Math.min(customerLines, written);
  await db.landingChatThread.update({
    where: { id: thread.id },
    data: {
      ...(created ? {} : facts),
      orderId,
      ...(last && written ? { lastMessageAt: last.at ? new Date(last.at) : now, lastMessagePreview: preview(last.text) } : {}),
      ...(unreadBy ? { unreadCount: { increment: unreadBy } } : {}),
    },
  });

  // Tell the people who answer: a conversation that has just started talking, or a customer writing again after the
  // staff read the thread. Once per unread run, never once per line — and never the text itself.
  if (unreadBy > 0 && thread.unreadCount === 0) {
    const before = await db.landingChatMessage.count({ where: { threadId: thread.id, direction: DIRECTION.CUSTOMER } });
    const first = before <= unreadBy;
    const where = [facts.pageName ?? thread.pageName, facts.productName ?? thread.productName].filter(Boolean).join(' — ');
    notify({
      companyId,
      audience: { permission: 'whatsapp.view' },
      type: 'LANDING_CHAT',
      title: first ? 'محادثة جديدة من صفحة الهبوط' : thread.botPaused ? 'الزبون ردّ — الموظفة ماسكة المحادثة' : 'رسالة جديدة من صفحة الهبوط',
      message: where || 'رسائل اللاندينج',
      link: LANDING_INBOX_PATH,
    });
  }

  return { status: created ? 201 : 200, body: { threadId: thread.id, botPaused: thread.botPaused, written } };
}

/** One update Zaki pages applies, in `seq` order. */
export interface ChatUpdate {
  seq: string;
  id: string;
  sessionId: string;
  kind: 'staff' | 'paused' | 'resumed';
  text?: string;
  at: string;
}

export const updatesQuery = z.object({ after: z.string().regex(/^\d{1,18}$/).optional() });

/** What the staff did since `after`, for every thread of this company. `cursor` is the last `seq` handed out (or `after`). */
export async function chatUpdates(companyId: string, after: string | undefined, now: Date = new Date(), countryId: string | null = null) {
  const from = BigInt(after ?? '0');
  const rows = await db.landingChatMessage.findMany({
    where: {
      companyId,
      // A key bound to one country reads its country's threads only; a key of every country reads them all, as before.
      ...(countryId ? { thread: { countryId } } : {}),
      seq: { gt: from },
      direction: { in: [DIRECTION.STAFF, DIRECTION.EVENT] },
      createdAt: { lte: new Date(now.getTime() - SETTLE_MS) },
    },
    orderBy: { seq: 'asc' },
    take: UPDATES_PAGE,
    select: { seq: true, id: true, direction: true, text: true, event: true, sentAt: true, thread: { select: { externalId: true } } },
  });
  const updates: ChatUpdate[] = rows.map((r) => ({
    seq: r.seq.toString(),
    id: r.id,
    sessionId: r.thread.externalId,
    kind: r.direction === DIRECTION.STAFF ? 'staff' : r.event === EVENT.RESUMED ? 'resumed' : 'paused',
    ...(r.direction === DIRECTION.STAFF ? { text: r.text ?? '' } : {}),
    at: r.sentAt.toISOString(),
  }));
  return { updates, cursor: rows.length ? rows[rows.length - 1].seq.toString() : from.toString(), more: rows.length === UPDATES_PAGE };
}
