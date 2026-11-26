/**
 * THE WHATSAPP ORDER BOT — one customer turn, from a message that arrived to the reply that leaves.
 *
 * ── WHEN IT SPEAKS ──
 *
 * Only to a customer who wrote (the webhook calls it after its 200, for the messages that arrived), only when the company
 * switched it on with a working key, only in an OPEN conversation it is not paused in, and only inside Meta's 24-hour
 * window. It never starts a conversation and never sends a template.
 *
 * ── HOW ──
 *
 * It waits a few seconds so a customer who writes in three bursts gets one answer (the newest message's wait answers all
 * of them), takes the conversation's lock (one turn at a time; the inbox draws «يكتب…» from it), shows «يكتب…» on the
 * customer's phone, and asks the model with the fixed rules, the owner's words, the customer's orders and the recent
 * thread. The model's tool calls go through `tools.ts`, which checks them in code and changes orders only through the
 * door (`order-door.ts`). The answer leaves as a normal WhatsApp text marked as the bot's.
 *
 * ── HARD CAPS ──
 *
 * At most MAX_ROUNDS model calls and MAX_TOOL_CALLS tool calls per turn; at most MAX_REPLIES_PER_HOUR bot replies per
 * conversation per hour; a timeout on every model call. ANY failure stops the bot in that conversation and marks it for
 * staff — no retry, no apology loop: a silent bot and a flagged chat, never spam.
 *
 * The customer's messages, name and orders go to the configured model: the owner's exception for this bot (2026-11-26,
 * AGENTS.md), the same model as Sarah's. Nothing goes to any other provider.
 */
import { db } from '../../db';
import { serviceWindow } from '../service-window';
import { botTyping, sendBotText } from '../send';
import { complete, LlmError, type LlmMessage, type ModelConn } from './llm';
import { TOOLS, SYSTEM_NOTE, ordersBrief, systemPromptFor } from './prompt';
import { runTool, type ToolContext } from './tools';
import { botActive, loadBotSettings, type BotSettings } from './settings';
import { realDoor } from './order-door';
import { sandboxDoor, type SandboxState } from './sandbox-door';
import { PAUSE_REASON, pauseBot } from './state';
import { cleanReply, mentionsAmount } from './words';
import type { BotDoor } from './door';

export const DEBOUNCE_MS = 4_000;
export const LOCK_MS = 150_000;
export const MAX_ROUNDS = 5;
export const MAX_TOOL_CALLS = 8;
export const MAX_REPLIES_PER_HOUR = 20;
/** How much of the thread the model reads. */
export const HISTORY_MESSAGES = 40;

/** What the bot says when it hands over and the model wrote nothing itself. */
export const HANDOFF_LINE = 'تمام، رح يكمل معك حدا من فريقنا هون بأقرب وقت.';

export interface TraceLine {
  name: string;
  args: string;
  ok: boolean;
  error: string;
}

export interface TurnOutcome {
  reply: string;
  handoff: string | null;
  trace: TraceLine[];
}

/** A message of the thread as the model reads it. */
interface ThreadLine {
  direction: string;
  messageType: string;
  text: string | null;
  sentByBot: boolean;
  meta?: unknown;
}

/** What the model is told about a message it cannot open. Captions are text and are kept. */
export function lineForModel(m: ThreadLine): string | null {
  const t = (m.text || '').trim();
  switch (m.messageType) {
    case 'REACTION':
      return null;
    case 'TEXT':
    case 'BUTTON':
    case 'INTERACTIVE':
    case 'TEMPLATE':
      return t || null;
    case 'AUDIO':
      return '[رسالة صوتية — ما بتقدر تسمعها]';
    case 'IMAGE':
      return t ? `[صورة — ما بتقدر تشوفها] التعليق: ${t}` : '[صورة — ما بتقدر تشوفها]';
    case 'VIDEO':
      return t ? `[فيديو — ما بتقدر تشوفه] التعليق: ${t}` : '[فيديو — ما بتقدر تشوفه]';
    case 'DOCUMENT':
      return t ? `[ملف — ما بتقدر تفتحه] التعليق: ${t}` : '[ملف — ما بتقدر تفتحه]';
    case 'STICKER':
      return '[ملصق]';
    case 'LOCATION': {
      const meta = (m.meta && typeof m.meta === 'object' ? m.meta : {}) as { placeName?: string; placeAddress?: string };
      return `[موقع على الخريطة${meta.placeName ? `: ${meta.placeName}` : ''}${meta.placeAddress ? ` — ${meta.placeAddress}` : ''}]`;
    }
    case 'CONTACTS':
      return '[جهة اتصال]';
    default:
      return t || '[رسالة ما بتنعرض]';
  }
}

/**
 * The thread for the model: the customer's lines as the user, the bot's as the assistant, a person's as a note from the
 * system (the bot must know what the team said, and must not imitate it). Consecutive user lines are one message.
 */
export function historyFor(lines: ThreadLine[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of lines) {
    const said = lineForModel(m);
    if (!said) continue;
    let next: LlmMessage;
    if (m.direction === 'INBOUND') next = { role: 'user', content: said };
    else if (m.sentByBot) next = { role: 'assistant', content: said };
    else next = { role: 'user', content: `${SYSTEM_NOTE} موظف من الفريق كتب للزبون: «${said}»` };
    const prev = out[out.length - 1];
    if (next.role === 'user' && prev?.role === 'user') {
      prev.content = `${prev.content}\n\n${next.content}`;
      continue;
    }
    if (next.role === 'assistant' && prev?.role === 'assistant' && typeof prev.content === 'string') {
      prev.content = `${prev.content}\n\n${next.content}`;
      continue;
    }
    out.push(next);
  }
  // A request must end on the customer's words; a leading assistant line is fine for every compatible server.
  return out;
}

/**
 * THE MODEL AND THE TOOLS, ONE TURN — shared by the real chat and the owner's practice chat.
 * Returns the reply to send (possibly empty), the hand-off reason when the model handed over, and a trace for the screen.
 */
export async function converse(
  conn: ModelConn,
  system: string,
  history: LlmMessage[],
  ctx: Omit<ToolContext, 'onHandoff'>,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<TurnOutcome> {
  const messages: LlmMessage[] = [{ role: 'system', content: system }, ...history];
  const trace: TraceLine[] = [];
  let handoff: string | null = null;
  let lastText = '';
  let calls = 0;
  const toolCtx: ToolContext = {
    ...ctx,
    onHandoff: async (reason) => {
      handoff = reason;
    },
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await complete(conn, messages, TOOLS, { fetchImpl: opts.fetchImpl });
    // A tool call cut off by the length limit is never run: its arguments are half a sentence.
    const toolCalls = r.finish === 'length' ? [] : r.toolCalls;
    if (r.content) lastText = r.content;
    if (toolCalls.length === 0) return { reply: cleanReply(lastText), handoff, trace };
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: toolCalls });
    for (const c of toolCalls) {
      let out: { data?: unknown; error?: string };
      if (++calls > MAX_TOOL_CALLS) {
        out = { error: 'Too many tool calls in this turn. Answer the customer now with what you have, or call nothing more.' };
      } else {
        try {
          out = await runTool(c.function.name, JSON.parse(c.function.arguments || '{}'), toolCtx);
        } catch (e) {
          out = { error: e instanceof SyntaxError ? 'The tool arguments were not valid JSON. Call the tool again with valid arguments.' : 'The order system did not answer. Nothing was changed. Do not say it worked; tell the customer a colleague will help.' };
        }
      }
      trace.push({ name: c.function.name, args: c.function.arguments.slice(0, 400), ok: !out.error, error: out.error ?? '' });
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out.error ? { error: out.error } : out.data) });
    }
    // After a hand-off the model only says goodbye: one last call without tools.
    if (handoff) break;
  }
  const last = await complete(conn, messages, [], { fetchImpl: opts.fetchImpl });
  return { reply: cleanReply(last.content || lastText), handoff, trace };
}

const connOf = (s: BotSettings): ModelConn => ({ baseUrl: s.baseUrl, apiKey: s.apiKey ?? '', model: s.model });

/** The owner's facts for the products of these orders, by product name. */
function notesFor(s: BotSettings, orders: Array<{ product: { id: string; name: string } | null }>) {
  const seen = new Set<string>();
  const out: Array<{ name: string; notes: string }> = [];
  for (const o of orders) {
    if (!o.product || seen.has(o.product.id)) continue;
    seen.add(o.product.id);
    const n = s.productNotes.find((x) => x.productId === o.product!.id);
    if (n) out.push({ name: o.product.name, notes: n.notes });
  }
  return out;
}

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  send?: typeof sendBotText;
  typing?: typeof botTyping;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const sleepMs = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export type TurnResult = 'OFF' | 'PAUSED' | 'BUSY' | 'NOTHING' | 'SENT' | 'HANDOFF' | 'FAILED' | 'RATE_LIMIT' | 'CLOSED';

/**
 * ONE REAL TURN in one conversation. Every exit releases the lock; every failure pauses the bot there and flags the
 * conversation for staff. Logs carry a code, never a message text, a key or a customer's words.
 */
export async function runBotTurn(conversationId: string, deps: EngineDeps = {}): Promise<TurnResult> {
  const now = deps.now?.() ?? new Date();
  const conv = await db.whatsAppConversation.findUnique({ where: { id: conversationId } });
  if (!conv) return 'NOTHING';
  const settings = await loadBotSettings(conv.companyId);
  if (!botActive(settings)) return 'OFF';
  if (conv.botPaused) return 'PAUSED';
  if (conv.status !== 'OPEN' || !serviceWindow(conv.lastInboundAt ?? null, now.getTime()).open) return 'CLOSED';

  // One turn at a time. A lock left by a crashed turn frees itself after LOCK_MS.
  const took = await db.whatsAppConversation.updateMany({
    where: { id: conv.id, botPaused: false, OR: [{ botBusyUntil: null }, { botBusyUntil: { lt: now } }] },
    data: { botBusyUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (took.count === 0) return 'BUSY';

  try {
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const recentReplies = await db.whatsAppMessage.count({ where: { conversationId: conv.id, sentByBot: true, createdAt: { gte: hourAgo } } });
    if (recentReplies >= MAX_REPLIES_PER_HOUR) {
      await pauseBot(conv.id, PAUSE_REASON.RATE_LIMIT, { handoff: true, note: `البوت ردّ ${MAX_REPLIES_PER_HOUR} مرة بساعة وحدة ووقف` });
      return 'RATE_LIMIT';
    }

    const rows = await db.whatsAppMessage.findMany({
      where: { conversationId: conv.id, companyId: conv.companyId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MESSAGES,
      select: { id: true, direction: true, messageType: true, text: true, sentByBot: true, meta: true, createdAt: true, externalMessageId: true },
    });
    const thread = rows.reverse();
    // What the customer wrote since anything left this side: the turn answers all of it.
    let cut = thread.length;
    while (cut > 0 && thread[cut - 1].direction === 'INBOUND') cut--;
    const pending = thread.slice(cut).filter((m) => m.messageType !== 'REACTION');
    if (pending.length === 0) return 'NOTHING';

    const typing = deps.typing ?? botTyping;
    void typing(conv.companyId, pending[pending.length - 1].externalMessageId).catch(() => false);

    const door: BotDoor = realDoor({ companyId: conv.companyId, customerId: conv.customerId, waId: conv.customerPhone }, settings.productNotes);
    const orders = await door.orders();
    const system = systemPromptFor({
      name: settings.name,
      persona: settings.persona,
      ordersLine: ordersBrief(orders),
      productNotes: notesFor(settings, orders),
      customerName: conv.customerName,
      now,
    });

    let changedAt = conv.botChangedAt ?? new Date(0);
    const firstPendingAt = pending[0].createdAt;
    const lines = pending.map((m) => lineForModel(m)).filter((x): x is string => !!x);
    const outcome = await converse(
      connOf(settings),
      system,
      historyFor(thread),
      {
        door,
        customerText: lines.join('\n'),
        lastCustomerText: lines[lines.length - 1] ?? '',
        amountSaid: async (amount) => {
          const said = await db.whatsAppMessage.findMany({
            where: { conversationId: conv.id, sentByBot: true, createdAt: { gt: changedAt, lt: firstPendingAt } },
            select: { text: true },
          });
          return said.some((m) => !!m.text && mentionsAmount(m.text, amount));
        },
        onChanged: async () => {
          changedAt = new Date();
          await db.whatsAppConversation.update({ where: { id: conv.id }, data: { botChangedAt: changedAt } });
        },
      },
      { fetchImpl: deps.fetchImpl }
    );

    const reply = outcome.reply || (outcome.handoff ? HANDOFF_LINE : '');
    if (!reply) {
      await pauseBot(conv.id, PAUSE_REASON.FAILED, { handoff: true, note: 'الموديل ما كتب رد' });
      return 'FAILED';
    }
    const send = deps.send ?? sendBotText;
    const sent = await send(conv.companyId, conv.id, reply);
    if (!sent.ok) {
      // Paused by a person while the model was thinking: their word stands, and nothing is flagged.
      if (sent.code === 'BOT_PAUSED') return 'PAUSED';
      await pauseBot(conv.id, PAUSE_REASON.FAILED, { handoff: true, note: 'ما قدر البوت يبعت الرد' });
      return 'FAILED';
    }
    if (outcome.handoff) {
      await pauseBot(conv.id, PAUSE_REASON.HANDOFF, { handoff: true, note: outcome.handoff });
      return 'HANDOFF';
    }
    return 'SENT';
  } catch (e) {
    const code = e instanceof LlmError ? e.code : ((e as { code?: unknown })?.code as string) || (e as Error)?.name || 'error';
    console.error('[whatsapp-bot] turn failed:', String(code).slice(0, 40));
    await pauseBot(conv.id, PAUSE_REASON.FAILED, { handoff: true, note: e instanceof LlmError ? e.message : 'البوت تعطّل' }).catch(() => false);
    return 'FAILED';
  } finally {
    await db.whatsAppConversation.updateMany({ where: { id: conv.id }, data: { botBusyUntil: null } }).catch(() => {});
  }
}

/**
 * After the webhook's 200: for each conversation that received a customer message, wait the debounce, and let the newest
 * message's wait run the turn. A message that arrives during a turn is answered by one more turn right after it.
 */
export async function botAfterInbound(items: Array<{ conversationId: string; messageId: string }>, deps: EngineDeps = {}): Promise<void> {
  const newest = new Map<string, string>();
  for (const it of items) newest.set(it.conversationId, it.messageId);
  await Promise.all(
    [...newest].map(async ([conversationId, messageId]) => {
      try {
        const conv = await db.whatsAppConversation.findUnique({ where: { id: conversationId }, select: { companyId: true, botPaused: true, status: true } });
        if (!conv || conv.botPaused || conv.status !== 'OPEN') return;
        if (!botActive(await loadBotSettings(conv.companyId))) return;
        await (deps.sleep ?? sleepMs)(DEBOUNCE_MS);
        const latest = await db.whatsAppMessage.findFirst({
          where: { conversationId, direction: 'INBOUND', messageType: { not: 'REACTION' } },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (latest?.id !== messageId) return; // a later message's own wait answers both
        for (let pass = 0; pass < 3; pass++) {
          const startedAt = new Date();
          const result = await runBotTurn(conversationId, deps);
          if (result !== 'SENT') return;
          // Something new arrived while the bot was answering: one more turn for it.
          const more = await db.whatsAppMessage.count({
            where: { conversationId, direction: 'INBOUND', messageType: { not: 'REACTION' }, createdAt: { gt: startedAt } },
          });
          if (more === 0) return;
        }
      } catch (e) {
        console.error('[whatsapp-bot] schedule failed:', (e as Error)?.name || 'error');
      }
    })
  );
}

/* ───────────────────────────── «جرّبه» — the owner's practice chat ───────────────────────────── */

export interface SandboxLine {
  role: 'customer' | 'bot';
  text: string;
}

export interface SandboxTurn {
  reply: string;
  handoff: string | null;
  trace: TraceLine[];
  state: SandboxState;
  /** The index in the transcript from which a bot message counts as «said after the last change». */
  changedAt: number;
}

/**
 * The practice turn: the same rules, tools and caps, a made-up customer on a real product, nothing written and nothing
 * sent. The screen holds the transcript and the made-up order and sends both back each time.
 */
export async function runSandboxTurn(
  settings: BotSettings,
  input: { transcript: SandboxLine[]; state: SandboxState; changedAt: number },
  deps: { fetchImpl?: typeof fetch; now?: Date } = {}
): Promise<SandboxTurn> {
  const transcript = input.transcript;
  let first = transcript.length;
  while (first > 0 && transcript[first - 1].role === 'customer') first--;
  const pending = transcript.slice(first).map((l) => l.text.trim()).filter(Boolean);
  const state: SandboxState = { productId: input.state.productId, order: { ...input.state.order } };
  let changedAt = Math.max(0, Math.min(input.changedAt, transcript.length));
  const door = sandboxDoor(settings.companyId, state, settings.productNotes);
  const system = systemPromptFor({
    name: settings.name,
    persona: settings.persona,
    ordersLine: ordersBrief([state.order]),
    productNotes: notesFor(settings, [state.order]),
    customerName: state.order.customer.name,
    now: deps.now ?? new Date(),
  });
  const outcome = await converse(
    connOf(settings),
    system,
    historyFor(transcript.slice(-HISTORY_MESSAGES).map((l) => ({ direction: l.role === 'customer' ? 'INBOUND' : 'OUTBOUND', messageType: 'TEXT', text: l.text, sentByBot: true }))),
    {
      door,
      sandbox: true,
      customerText: pending.join('\n'),
      lastCustomerText: pending[pending.length - 1] ?? '',
      amountSaid: async (amount) => transcript.slice(changedAt, first).some((l) => l.role === 'bot' && mentionsAmount(l.text, amount)),
      onChanged: async () => {
        changedAt = transcript.length;
      },
    },
    { fetchImpl: deps.fetchImpl }
  );
  return { reply: outcome.reply || (outcome.handoff ? HANDOFF_LINE : ''), handoff: outcome.handoff, trace: outcome.trace, state, changedAt };
}
