/**
 * TELEGRAM INBOUND PIPELINE
 *
 * Telegram webhook → secret verification (route) → this module:
 *   resolve source (topic-exact → group-level) → idempotent message insert
 *   (DB unique = source of truth) → deterministic parse → validation →
 *   product matching (tenant-scoped) → existing-order-creation transaction
 *   → audit-safe status updates.
 *
 * Unknown chats are silently ignored. No secrets are ever logged. Errors
 * never fail the webhook with sensitive details — Telegram may retry 5xx,
 * so permanent failures are recorded as FAILED instead of thrown.
 */
import { db } from '../db';
import { findOrCreateCustomer } from '../customer-identity';
import { isBlocked } from '../blacklist';
import { normalizePhoneNumber } from '../phone';
import { resolveProductText } from './product-text';
import { parseTelegramOrderMessage, readLineRoleOrder } from './parser';
import { createTelegramOrder, parseAdvertisedPrice } from './order-creation';
import { findTwinOrder } from './twin';

const RECENT_MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000; // ignore stale updates

export interface TelegramInboundResult {
  handled: boolean; // false = event type not processed as an order
  status?: 'PROCESSED' | 'IGNORED' | 'NEEDS_REVIEW' | 'FAILED' | 'DUPLICATE' | 'NO_SOURCE' | 'NON_TEXT';
  reason?: string;
  orderId?: string;
}

/** Update-update envelope types we accept. */
const SUPPORTED_UPDATE_KEYS = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const;

interface NormalizedUpdate {
  chatId: string;
  chatType: string;
  chatTitle?: string;
  messageId: string;
  threadId?: number;
  threadName?: string;
  senderUserId?: string;
  senderUsername?: string;
  senderName?: string;
  text?: string;
  date?: Date;
  isEdited: boolean;
}

/** Extract + validate the message envelope from any supported update shape. */
function normalizeUpdate(update: any): NormalizedUpdate | null {
  for (const key of SUPPORTED_UPDATE_KEYS) {
    const msg = update?.[key];
    if (!msg || typeof msg !== 'object') continue;
    const chat = msg.chat;
    const messageId = msg.message_id;
    if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) return null;
    if (typeof messageId !== 'number' && typeof messageId !== 'string') return null;
    const type = typeof chat.type === 'string' ? chat.type : 'unknown';
    // Only group-like chats are processed as order sources in this phase
    if (!['group', 'supergroup', 'channel'].includes(type)) return null;
    const sender = msg.from;
    return {
      chatId: String(chat.id),
      chatType: type,
      chatTitle: typeof chat.title === 'string' ? chat.title : undefined,
      messageId: String(messageId),
      threadId: typeof msg.message_thread_id === 'number' ? msg.message_thread_id : undefined,
      senderUserId: sender?.id !== undefined ? String(sender.id) : undefined,
      senderUsername: typeof sender?.username === 'string' ? sender.username : undefined,
      senderName:
        typeof sender?.first_name === 'string'
          ? [sender.first_name, sender.last_name].filter(Boolean).join(' ')
          : undefined,
      text: typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : undefined,
      date: typeof msg.date === 'number' ? new Date(msg.date * 1000) : undefined,
      isEdited: key.startsWith('edited'),
    };
  }
  return null;
}

/** Resolve the source for a message: exact topic mapping first, then group-level. */
async function resolveSource(chatId: string, threadId?: number) {
  if (threadId !== undefined) {
    const topic = await db.telegramSource.findFirst({
      where: { chatId, topicId: threadId, isActive: true },
    });
    if (topic) return topic;
  }
  return db.telegramSource.findFirst({ where: { chatId, topicId: null, isActive: true } });
}

/**
 * Process one Telegram update. Never throws for expected conditions.
 */
export async function processTelegramUpdate(update: unknown): Promise<TelegramInboundResult> {
  const norm = normalizeUpdate(update);
  // Unsupported events (private chats, non-text, unsupported types) → ignore
  if (!norm || !norm.text || !norm.text.trim()) {
    return { handled: false };
  }
  // Edited messages are never re-processed into orders (phase 1 policy)
  if (norm.isEdited) {
    return { handled: false };
  }
  // Old messages (clock-skew / replayed backfills) are ignored
  if (norm.date && Date.now() - norm.date.getTime() > RECENT_MESSAGE_WINDOW_MS) {
    return { handled: false };
  }

  // ── Source resolution: tenant comes from the DB mapping, never the payload ──
  const source = await resolveSource(norm.chatId, norm.threadId);
  if (!source) {
    return { handled: false, status: 'NO_SOURCE' };
  }
  const companyId = source.companyId;

  // ── Idempotency: unique(companyId, chatId, messageId) is the source of truth ──
  let message;
  try {
    message = await db.telegramMessage.create({
      data: {
        companyId,
        sourceId: source.id,
        chatId: norm.chatId,
        messageId: norm.messageId,
        threadId: norm.threadId ?? null,
        threadName: source.topicName ?? null,
        senderUserId: norm.senderUserId ?? null,
        senderUsername: norm.senderUsername ?? null,
        senderName: norm.senderName ?? null,
        text: norm.text.slice(0, 4000),
        messageType: 'TEXT',
        processingStatus: 'PENDING',
      },
    });
  } catch {
    // Unique violation → duplicate webhook delivery; no second order, ever.
    return { handled: true, status: 'DUPLICATE' };
  }

  try {
    const result = await processStoredMessage(message.id);
    return { handled: true, status: result.status, reason: result.reason, orderId: result.orderId };
  } catch (e) {
    // Persist a safe failure state — Telegram must not retry-spam duplicates
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'FAILED', internalError: 'PROCESSING_ERROR', processedAt: new Date() },
    }).catch(() => undefined);
    return { handled: true, status: 'FAILED' };
  }
}

export interface StoredProcessingResult {
  status: 'PROCESSED' | 'IGNORED' | 'NEEDS_REVIEW' | 'FAILED';
  reason?: string;
  orderId?: string;
}

/**
 * Core processing for one stored TelegramMessage. Idempotent: only a message
 * still in PENDING state is processed (retry endpoint reuses this safely).
 */
export async function processStoredMessage(messageId: string): Promise<StoredProcessingResult> {
  const message = await db.telegramMessage.findUnique({ where: { id: messageId } });
  if (!message) return { status: 'FAILED', reason: 'NOT_FOUND' };
  if (message.processingStatus === 'PROCESSED') {
    return { status: 'PROCESSED', reason: 'ALREADY_PROCESSED', orderId: message.orderId ?? undefined };
  }
  if (message.orderId) {
    // Reprocessing guard: linked order exists → mark processed, never duplicate
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'PROCESSED', processedAt: new Date(), reviewReason: null, internalError: null },
    });
    return { status: 'PROCESSED', orderId: message.orderId };
  }

  const companyId = message.companyId;

  // ── To a person, with the reason (server-side validation never trusts message content for
  //    companyId/productId/price/status/total) ──
  const review: (reason: string) => Promise<StoredProcessingResult> = async (reason) => {
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'NEEDS_REVIEW', reviewReason: reason, processedAt: new Date() },
    });
    return { status: 'NEEDS_REVIEW', reason };
  };

  // ── His seven lines: a message in that shape is read by its own rules and never falls back (T1) ──
  if (readLineRoleOrder(message.text ?? '').claimed) {
    return processLineRoleMessage(message, review);
  }

  const parsed = parseTelegramOrderMessage(message.text ?? '');

  // Persist the extracted commercial page name (source) for dashboard display
  const pageName = parsed.pageName?.trim() || null;
  if (pageName && message.pageName !== pageName) {
    await db.telegramMessage.update({ where: { id: message.id }, data: { pageName } }).catch(() => undefined);
  }

  // ── Non-order → IGNORED ──
  if (!parsed.isOrder) {
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'IGNORED', processedAt: new Date() },
    });
    return { status: 'IGNORED' };
  }

  const customerName = parsed.customerName?.trim();
  if (!customerName || customerName.length < 2) return review('MISSING_CUSTOMER_NAME');

  const phone = parsed.phone ? normalizePhoneNumber(parsed.phone) : '';
  if (!phone || phone.length < 7 || phone.length > 15) return review('INVALID_PHONE');

  const address = parsed.address?.trim() || parsed.governorate?.trim();
  if (!address) return review('MISSING_ADDRESS');

  const quantity = parsed.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return review('INVALID_QUANTITY');

  const productText = parsed.productText?.trim();
  if (!productText) return review('MISSING_PRODUCT');

  // pageName is the commercial source; optional — missing → review reason but
  // the order is NOT lost if everything else is valid.
  const sourcePageName = pageName ?? undefined;

  // ── Product matching (same-company only) ──
  const products = await db.product.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: { id: true, name: true, nameEn: true, sku: true, basePrice: true, image: true },
  });
  // The decision lives in `product-text.ts`, where it can be asked a question without a database behind it.
  const resolved = resolveProductText(productText, products);
  if (resolved.kind === 'ambiguous') return review('AMBIGUOUS_PRODUCT');
  if (resolved.kind === 'none') return review('PRODUCT_NOT_FOUND');
  const product = resolved.product;

  // ── Blacklist, company-wide ──
  // Held for review rather than dropped: a human should see that a blocked
  // number tried again, and decide.
  // The RAW phone, not the normalized one: normalizing drops the leading
  // + that says the number was written internationally, and without it a
  // block stored from "+963…" would not match a local "0…".
  if (await isBlocked(db, companyId, parsed.phone ?? phone)) return review('CUSTOMER_BLOCKED');

  // ── Which store this message belongs to ──
  //
  // Resolved BEFORE the customer, because a customer belongs to a store.
  // A source nobody has linked to one has no store, and a message from it
  // cannot become anybody's customer or anybody's order — it goes to review
  // rather than landing in whichever store happens to be open.
  const source = message.sourceId
    ? await db.telegramSource.findUnique({
        where: { id: message.sourceId },
        select: { storeId: true, store: { select: { country: { select: { code: true } } } } },
      })
    : null;
  const storeId = source?.storeId ?? null;
  if (!storeId) return review('NO_STORE');
  // Read again as THIS store reads it, now that it is known: a foreign number keeps its own code (RV136).
  const storedPhone = normalizePhoneNumber(parsed.phone!, source?.store?.country?.code);

  // ── Customer matching / creation (the shared one) ──
  const customer = await findOrCreateCustomer(db, {
    companyId,
    storeId,
    phone: storedPhone,
    rawPhone: parsed.phone!.slice(0, 20),
    fullName: customerName.slice(0, 80),
    address: address.slice(0, 200),
    city: (parsed.governorate?.trim() || address).slice(0, 60),
  });

  // ── Order creation via the shared ingestion service (server-set price/status) ──
  const created = await createTelegramOrder({
    companyId,
    storeId,
    customer,
    product,
    quantity,
    address,
    governorate: parsed.governorate?.trim(),
    notes: parsed.notes,
    priceText: parsed.priceText,
    pageName: sourcePageName,
    linkMessageId: message.id,
    telegram: {
      messageId: message.messageId,
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      chatTitle: message.threadName ?? undefined,
    },
  });

  if (!created.ok) {
    if (created.reason === 'ALREADY_LINKED') return linkedElsewhere(message.id);
    return review(created.reason!);
  }

  // The message was linked to its order inside the order's own transaction.
  return { status: 'PROCESSED', orderId: created.orderId! };
}

/**
 * Two presses of «إعادة المعالجة» at the same moment: the other one made the order and linked this message to it first.
 * That is not a failure to show anybody — the message IS processed, by the order the other press made.
 */
async function linkedElsewhere(messageRowId: string): Promise<StoredProcessingResult> {
  const linked = await db.telegramMessage.findUnique({ where: { id: messageRowId }, select: { orderId: true } });
  return { status: 'PROCESSED', orderId: linked?.orderId ?? undefined };
}

/** The message fields the seven-line door reads — the stored row, never the payload. */
interface StoredMessage {
  id: string;
  companyId: string;
  sourceId: string | null;
  text: string | null;
  createdAt: Date;
  messageId: string;
  chatId: string;
  threadId: number | null;
  threadName: string | null;
}

/**
 * THE SEVEN-LINE DOOR (T1–T10).
 *
 * Every refusal comes before anything is written, in this order: the store → lines 2 to 7 (the catalogue and the price
 * ceiling included) → the duplicate → the blacklist → the customer → the order. A message refused at any step leaves no
 * customer and no order behind.
 *
 * The money is the existing door's: the TOTAL from line 7 goes to `createTelegramOrder` as plain digits, and from there
 * `parseAdvertisedPrice` → total ÷ quantity → `computeCod`, unchanged. «توصيل مجاني» sets this order's
 * `priceIncludesDelivery` exactly as an offer's `deliveryIncluded` does, through the same `priceIncludesDeliveryFor`.
 */
async function processLineRoleMessage(
  message: StoredMessage,
  review: (reason: string) => Promise<StoredProcessingResult>
): Promise<StoredProcessingResult> {
  const companyId = message.companyId;

  // 1 — the store, from the source the message came through (never from the text), and the country it is read against.
  const source = message.sourceId
    ? await db.telegramSource.findUnique({
        where: { id: message.sourceId },
        select: {
          storeId: true,
          store: { select: { country: { select: { code: true, name: true, currencyCode: true, minorUnit: true } } } },
        },
      })
    : null;
  const storeId = source?.storeId ?? null;
  const country = source?.store?.country ?? null;
  if (!storeId || !country) return review('NO_STORE');

  // 2 — lines 2 to 7.
  const reading = readLineRoleOrder(message.text ?? '', { country, receivedAt: message.createdAt });
  if (!reading.claimed) return review('LINE_COUNT');
  if (!reading.ok) return review(reading.reason);
  const { lines, offer, place } = reading;

  // Line 6 — THIS store's active products only (T5). Another store's shelf, or a guess, is never an order.
  const shelf = await db.product.findMany({
    where: { companyId, storeId, status: 'ACTIVE' },
    select: { id: true, name: true, nameEn: true, sku: true, basePrice: true, image: true },
  });
  const match = resolveProductText(lines.product, shelf);
  if (match.kind === 'ambiguous') return review('AMBIGUOUS_PRODUCT');
  if (match.kind === 'none') return review('PRODUCT_NOT_FOUND');
  if (match.how === 'fuzzy') return review('PRODUCT_GUESSED');

  // Line 7 — the creator's own reader and its 100,000 ceiling, asked now, before a customer is written.
  if (parseAdvertisedPrice(offer.priceText, country.minorUnit) === null) return review('MISSING_PRICE');

  // 3 — the same reference at the same time already made an order.
  const twin = await findTwinOrder({
    companyId,
    storeId,
    messageRowId: message.id,
    receivedAt: message.createdAt,
    ref: lines.ref,
    orderedAt: lines.orderedAt,
  });
  if (twin) return review('DUPLICATE_REF');

  // 4 — the blacklist, company-wide, on the number as written (a + kept).
  if (await isBlocked(db, companyId, lines.phone, country.code)) return review('CUSTOMER_BLOCKED');

  // 5 — the customer, the shared way: found by this store's phone, or made.
  const customer = await findOrCreateCustomer(db, {
    companyId,
    storeId,
    phone: normalizePhoneNumber(lines.phone, country.code),
    rawPhone: lines.phone.slice(0, 20),
    fullName: lines.customer.slice(0, 80),
    address: place.slice(0, 200),
    city: place.slice(0, 60),
  });

  // 6 — the order, through the one door and its one calculator. Line 1 and line 2 go to the internal notes only (T3, T8).
  const created = await createTelegramOrder({
    companyId,
    storeId,
    customer,
    product: match.product,
    quantity: offer.quantity,
    address: place.slice(0, 200),
    governorate: place,
    priceText: offer.priceText,
    deliveryIncluded: offer.deliveryIncluded || undefined,
    sourceNote: `مرجع المصدر: ${lines.ref.slice(0, 40)} · وقت الطلب بالمصدر: ${lines.orderedAt} · العرض: ${lines.offer}`,
    linkMessageId: message.id,
    telegram: {
      messageId: message.messageId,
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      chatTitle: message.threadName ?? undefined,
    },
  });

  if (!created.ok) {
    if (created.reason === 'ALREADY_LINKED') return linkedElsewhere(message.id);
    return review(created.reason);
  }
  return { status: 'PROCESSED', orderId: created.orderId };
}
