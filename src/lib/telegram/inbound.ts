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
import { isValidPhoneFor } from '../phone-rules';
import { activeOffersFor } from '../offers';
import { resolvePublicLines } from '../public-order';
import { resolveProductText } from './product-text';
import { readLabeledOrder } from './labeled-order';
import { createTelegramOrder, parseAdvertisedPrice, priceTelegramLine } from './order-creation';
import { currenciesIn, matchOfferText, offersForQuantity } from './offer-text';
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
 *
 * THE ONLY MESSAGE THAT BECOMES AN ORDER is the one in the owner's labeled format (`labeled-order.ts`). A message that
 * does not claim it is IGNORED with «الرسالة مش بصيغة الطلب»; one that claims it and is wrong goes to review, naming the
 * field. Nothing else is read as an order.
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

  // ── To a person, with the reason (server-side validation never trusts message content for
  //    companyId/productId/price/status/total) ──
  const review: (reason: string) => Promise<StoredProcessingResult> = async (reason) => {
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'NEEDS_REVIEW', reviewReason: reason, processedAt: new Date() },
    });
    return { status: 'NEEDS_REVIEW', reason };
  };

  /** Not an order: set aside, shown under «متجاهلة» with the reason, and never blacklisted or counted. */
  const ignore: (reason: string) => Promise<StoredProcessingResult> = async (reason) => {
    await db.telegramMessage.update({
      where: { id: message.id },
      data: { processingStatus: 'IGNORED', reviewReason: reason, processedAt: new Date() },
    });
    return { status: 'IGNORED', reason };
  };

  return processLabeledMessage(message, review, ignore);
}

/**
 * Two presses of «إعادة المعالجة» at the same moment: the other one made the order and linked this message to it first.
 * That is not a failure to show anybody — the message IS processed, by the order the other press made.
 */
async function linkedElsewhere(messageRowId: string): Promise<StoredProcessingResult> {
  const linked = await db.telegramMessage.findUnique({ where: { id: messageRowId }, select: { orderId: true } });
  return { status: 'PROCESSED', orderId: linked?.orderId ?? undefined };
}

/** The message fields the door reads — the stored row, never the payload. */
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
 * THE DOOR (labeled format).
 *
 * Every refusal comes before anything is written, in this order: not the format → the store → the fields (the catalogue
 * and the price ceiling included) → the duplicate → the blacklist → the customer → the order. A message refused at any
 * step leaves no customer and no order behind.
 *
 * THE OFFER IS BOUND (28/10: «نص العرض مربوط بالعرض»). «إسم العرض» is matched to ONE active offer of THIS product; the
 * order is then priced by the storefront door's own functions over that offer row (`resolvePublicLines`, `basketDiscount`,
 * `computeCod`): the offer's price, its gift units, its `deliveryIncluded`. «السعر» is a claim checked against that price
 * (PRICE_MISMATCH) and never the money; «الكمية» is the product's pieces: 1 or the offer's paid pieces is ONE offer, a whole
 * multiple k is k offers, anything else is QUANTITY_NOT_OFFER. No offer found = no order.
 *
 * THE PHONE AND THE ADDRESS ARE TAKEN LENIENTLY (`phone-text.ts`, `labeled-order.ts`): no message is refused for how its number
 * is written, for a number a digit short (6 digits or more is taken, and the order's notes say it does not fit the country's
 * shape), or for what its address says («سوريا» alone, another country's word). Only a stub of a number is held (INVALID_PHONE,
 * with the number as written), and no digit at all is missing.
 */
async function processLabeledMessage(
  message: StoredMessage,
  review: (reason: string) => Promise<StoredProcessingResult>,
  ignore: (reason: string) => Promise<StoredProcessingResult>
): Promise<StoredProcessingResult> {
  const companyId = message.companyId;
  const text = message.text ?? '';

  // 0 — a message that does not claim the format is not an order (chit-chat, a question, a photo caption).
  if (!readLabeledOrder(text).claimed) return ignore('NOT_IN_FORMAT');

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

  // 2 — the fields, each by the rule of its label.
  const reading = readLabeledOrder(text, { country, receivedAt: message.createdAt });
  if (!reading.claimed) return ignore('NOT_IN_FORMAT');
  // A phone that fails the store country's rule says which one, as the seller wrote it (the cell is marked on the screen).
  if (!reading.ok) return review(reading.reason === 'INVALID_PHONE' ? `INVALID_PHONE:${(reading.fields.phone ?? '').slice(0, 40)}` : reading.reason);
  const { fields, place, quantity, priceText, phone } = reading;

  // The product — THIS store's active products only. Another store's shelf, or a guess, is never an order.
  const products = await db.product.findMany({
    where: { companyId, storeId, status: 'ACTIVE' },
    select: { id: true, name: true, nameEn: true, sku: true, basePrice: true, image: true },
  });
  const productText = fields.product;
  // The decision lives in `product-text.ts`, where it can be asked a question without a database behind it.
  const resolved = resolveProductText(productText, products);
  if (resolved.kind === 'ambiguous') return review('AMBIGUOUS_PRODUCT');
  if (resolved.kind === 'none') return review('PRODUCT_NOT_FOUND');
  if (resolved.how === 'fuzzy') return review('PRODUCT_GUESSED');
  const product = resolved.product;

  // The price is the creator's own reader and its 100,000 ceiling, asked now, before a customer is written.
  const written = parseAdvertisedPrice(priceText, country.minorUnit);
  if (written === null) return review('MISSING_PRICE');

  // The offer: a currency in its text must be the store's own (never converted), then ONE active offer of this product.
  const storeCurrency = country.currencyCode.trim().toUpperCase();
  if (currenciesIn(fields.offer).some((code) => code !== storeCurrency)) return review('CURRENCY_MISMATCH');
  const offers = await activeOffersFor(db, companyId, product.id, country.minorUnit);
  const matched = matchOfferText(fields.offer, offers);
  if (matched.kind === 'ambiguous') return review('OFFER_AMBIGUOUS');
  if (matched.kind === 'none') return review('OFFER_NOT_FOUND');

  // «الكمية» is pieces of the product: 1 or the offer's paid pieces = one offer, k × those = k offers, else not an offer.
  const bundles = offersForQuantity(quantity, matched.offer.quantity);
  if (bundles === null) return review('QUANTITY_NOT_OFFER');

  // The line, priced from the offer ROW by the storefront door's own function — and the written price must be its total.
  const priced = await resolvePublicLines(
    companyId,
    [product],
    [{ productId: product.id, offerId: matched.offer.id, count: bundles }],
    country.minorUnit
  );
  if (!priced.ok) return review('OFFER_NOT_FOUND');
  const line = priced.lines[0];
  const expected = priceTelegramLine(line, country.minorUnit).cod;
  if (written !== expected) return review(`PRICE_MISMATCH:${expected.toFixed(country.minorUnit)}`);

  // 3 — the same customer, the same time and the same product already made an order.
  const twin = await findTwinOrder({
    companyId,
    storeId,
    messageRowId: message.id,
    receivedAt: message.createdAt,
    orderedAt: fields.orderedAt,
    phone: fields.phone,
    countryCode: country.code,
    productId: product.id,
  });
  if (twin) return review('DUPLICATE_ORDER');

  // 4 — the blacklist, company-wide, on every number of the line: as written, and cleaned (a + kept).
  // Held for review rather than dropped: a human should see that a blocked number tried again, and decide.
  for (const number of [fields.phone, phone.primary, ...phone.others]) {
    if (await isBlocked(db, companyId, number, country.code)) return review('CUSTOMER_BLOCKED');
  }

  // 5 — the customer, the shared way: found by this store's phone, or made. A second valid number is the second phone.
  const second = phone.others.find((n) => isValidPhoneFor(country.code, n));
  const customer = await findOrCreateCustomer(db, {
    companyId,
    storeId,
    phone: normalizePhoneNumber(phone.primary, country.code),
    rawPhone: phone.primary.slice(0, 20),
    altPhone: second ? normalizePhoneNumber(second, country.code) : null,
    fullName: fields.customer.slice(0, 80),
    address: place.slice(0, 200),
    city: place.slice(0, 60),
  });

  // 6 — the order, through the one door and its one calculator. The source time, the offer's name and any other numbers
  // go to the internal notes only; the order number was dropped by the reader and is nowhere.
  const created = await createTelegramOrder({
    companyId,
    storeId,
    customer,
    product,
    line,
    address: place.slice(0, 200),
    governorate: place,
    priceText,
    sourceNote: [
      `وقت الطلب بالمصدر: ${fields.orderedAt}`,
      `العرض: ${line.offer?.name ?? ''}`.slice(0, 120),
      phone.others.length ? `أرقام أخرى: ${phone.others.join(' ، ')}` : null,
      phone.valid ? null : `⚠ رقم الهاتف ما بيطابق شكل أرقام البلد (كما انكتب: ${fields.phone.slice(0, 40)}) — تأكدوا منه بالاتصال`,
    ]
      .filter(Boolean)
      .join(' · '),
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
