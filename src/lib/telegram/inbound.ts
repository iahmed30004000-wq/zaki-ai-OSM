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
import { roundMinor } from '../money';
import { resolvePublicLines, type ResolvedLine } from '../public-order';
import { resolveProductText } from './product-text';
import { readLabeledOrder, type LabeledReading } from './labeled-order';
import { createTelegramOrder, parseAdvertisedPrice, priceTelegramLine } from './order-creation';
import { currenciesIn, matchOfferText, offersForQuantity } from './offer-text';
import { findTwinOrder } from './twin';
import { phoneKeyOf } from './phone-text';
import { typed } from '../text-search';
import { aliasFor, offerAliasFor, pickAliasedOffer, type AliasRow } from './aliases';
import { loadAliases } from './alias-store';
import { UPSELL_COUNT_MAX, UPSELL_HOLD_MS, holdUntil, judgePair } from './upsell-pair';

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

/** How a message is read: live (it may wait for its upsell partner) or not, and how far apart a pair may arrive. */
export interface ProcessOptions {
  /**
   * false: the message never waits for its partner — what releasing an expired hold (`holds.ts`) and the dry-run
   * («دمج الأب سيل — تجربة») ask. Default true: a message that is half of an upsell pair waits up to `UPSELL_HOLD_MS`.
   */
  holds?: boolean;
  /** How far apart (by arrival) the two messages of a pair may be. Default `UPSELL_HOLD_MS`; the dry-run uses `UPSELL_RETRO_MS`. */
  pairWindowMs?: number;
  /** The clock, for the hold. */
  now?: Date;
}

/**
 * Core processing for one stored TelegramMessage. Idempotent: only a message
 * still in PENDING state is processed (retry endpoint reuses this safely).
 *
 * THE ONLY MESSAGE THAT BECOMES AN ORDER is the one in the owner's labeled format (`labeled-order.ts`). A message that
 * does not claim it is IGNORED with «الرسالة مش بصيغة الطلب»; one that claims it and is wrong goes to review, naming the
 * field. Nothing else is read as an order.
 */
export async function processStoredMessage(messageId: string, options: ProcessOptions = {}): Promise<StoredProcessingResult> {
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
  //
  // Written only while the message has NO order (10/11): the other half of an upsell pair may have made the order and linked
  // this message to it a moment ago, in its own transaction. A hold or a reason written over that link would hide the order;
  // the write finds nothing instead, and the answer is the order the other one made.
  const review: (reason: string) => Promise<StoredProcessingResult> = async (reason) => {
    const written = await db.telegramMessage.updateMany({
      where: { id: message.id, orderId: null },
      data: { processingStatus: 'NEEDS_REVIEW', reviewReason: reason, processedAt: new Date() },
    });
    if (written.count !== 1) return linkedElsewhere(message.id);
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

  return processLabeledMessage(message, review, ignore, options);
}

/**
 * WHAT THE DOOR WOULD DO WITH ONE MESSAGE — AND WRITE NOTHING («دمج الأب سيل — تجربة», 10/11).
 *
 * The same decision function the live door runs (`decideLabeledMessage`), with holds off: the catalogue, the offers, the
 * aliases, the partner, the duplicate check and the blacklist are READ, and nothing is written — no status, no customer, no
 * order. `null` for a message that already has its order. The message's own arrival time is the reference for the date window
 * exactly as «إعادة المعالجة» has it, so a message of any age is planned like a new one.
 */
export async function planStoredMessage(messageId: string, options: ProcessOptions = {}): Promise<Decision | null> {
  const message = await db.telegramMessage.findUnique({ where: { id: messageId } });
  if (!message || message.processingStatus === 'PROCESSED' || message.orderId) return null;
  return decideLabeledMessage(message, { ...options, holds: false });
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

/** The columns of a stored message the door reads — for the message itself and for its upsell partner alike. */
const STORED_MESSAGE_SELECT = {
  id: true,
  companyId: true,
  sourceId: true,
  text: true,
  createdAt: true,
  messageId: true,
  chatId: true,
  threadId: true,
  threadName: true,
} as const;

type Country = { code: string; name: string; currencyCode: string; minorUnit: number };
type CatalogueProduct = { id: string; name: string; nameEn: string | null; sku: string; basePrice: number; image: string | null };
type OkReading = Extract<LabeledReading, { ok: true }>;

/** What the dry-run shows about a decision, and how the door got there. */
export interface DecisionInfo {
  /** What the new rules did here: an alias named the product, the message is an upsell, or two messages were paired. Null = untouched. */
  via: 'pair' | 'alias' | 'upsell' | null;
  /** «رقم الطلب» (pairing key only). */
  orderNumber: string | null;
  /** The CATALOGUE product's name once known (never the old text), else the text as written. */
  productName: string | null;
  /** «السعر» as read. */
  written: number | null;
  /** The other message of the pair, when one was found. */
  partnerId: string | null;
  /** Which half of a pair this message is. */
  role: 'base' | 'upsell' | null;
}

/** An order, ready to be written: everything but the customer, which is found or made only when it is written. */
export interface OrderDraft {
  storeId: string;
  country: Country;
  /** The base message (the one whose offer heads the order) and its reading. */
  base: StoredMessage;
  reading: OkReading;
  product: CatalogueProduct;
  line: ResolvedLine;
  /** The upsell's line, for a merged order. */
  extraLines: ResolvedLine[];
  /** Every message the order is made from (one, or the base and its upsell). */
  linkIds: string[];
  /** The order's total (`computeCod`) and every unit in it (paid + gift + upsell). */
  total: number;
  units: number;
  /** The old name an alias resolved, for the notes. */
  aliasName: string | null;
  mergeNote: string | null;
}

export type Decision =
  | { kind: 'ignore'; reason: string; info: DecisionInfo }
  | { kind: 'review'; reason: string; info: DecisionInfo }
  | { kind: 'order'; draft: OrderDraft; info: DecisionInfo };

/** A message read up to its money: refused, an upsell (waiting for its base), or a base line priced from its offer. */
type Prepared =
  | { kind: 'refused'; decision: Decision }
  | {
      kind: 'upsell';
      message: StoredMessage;
      reading: OkReading;
      alias: AliasRow;
      aliases: AliasRow[];
      product: CatalogueProduct;
      storeId: string;
      country: Country;
      written: number;
    }
  | {
      kind: 'base';
      message: StoredMessage;
      reading: OkReading;
      alias: AliasRow | null;
      aliases: AliasRow[];
      product: CatalogueProduct;
      line: ResolvedLine;
      storeId: string;
      country: Country;
      written: number;
      expected: number;
    };

const blankInfo = (): DecisionInfo => ({ via: null, orderNumber: null, productName: null, written: null, partnerId: null, role: null });

/**
 * The generic product matcher, as it always was (`product-text.ts`): exact → contains → fuzzy, and each answer turned into the
 * review reason it always gave. Asked only when no ALIAS of the store named the product.
 */
function catalogueProduct(productText: string, products: CatalogueProduct[]): { product: CatalogueProduct } | { reason: string } {
  const review = (reason: string) => ({ reason });
  // The decision lives in `product-text.ts`, where it can be asked a question without a database behind it.
  const resolved = resolveProductText(productText, products);
  if (resolved.kind === 'ambiguous') return review('AMBIGUOUS_PRODUCT');
  if (resolved.kind === 'none') return review('PRODUCT_NOT_FOUND');
  if (resolved.how === 'fuzzy') return review('PRODUCT_GUESSED');
  const product = resolved.product;
  return { product };
}

/**
 * ONE MESSAGE, READ UP TO ITS MONEY — every step before the duplicate check, and nothing written.
 *
 * Every refusal comes in this order: not the format → the store → the fields → the product (an ALIAS of this store first,
 * `aliases.ts`, then the generic matcher) → the price → the offer (the normal match first; for a renamed product, its old
 * offer texts when the normal match found none) → the quantity → the line. An UPSELL alias stops after the fields: its line is
 * priced only together with its base (`upsell-pair.ts`).
 */
async function prepareMessage(message: StoredMessage, info: DecisionInfo): Promise<Prepared> {
  const companyId = message.companyId;
  const text = message.text ?? '';
  const review = (reason: string): Prepared => ({ kind: 'refused', decision: { kind: 'review', reason, info } });
  const ignore = (reason: string): Prepared => ({ kind: 'refused', decision: { kind: 'ignore', reason, info } });

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
  const { fields, priceText } = reading;
  info.orderNumber = reading.orderNumber;
  info.productName = fields.product;

  // The product — THIS store's active products only. Another store's shelf, or a guess, is never an order.
  const products = await db.product.findMany({
    where: { companyId, storeId, status: 'ACTIVE' },
    select: { id: true, name: true, nameEn: true, sku: true, basePrice: true, image: true },
  });
  // THE STORE'S OWN NAMES FIRST (10/11): an upsell's name, or a product's old name. An alias always wins, even over a product
  // the generic matcher would have found; a name no ACTIVE alias carries goes on exactly as before.
  const aliases = await loadAliases(companyId, storeId);
  const alias = aliasFor(fields.product, aliases);
  const productText = fields.product;

  // The price is the creator's own reader and its 100,000 ceiling, asked now, before a customer is written.
  const written = parseAdvertisedPrice(priceText, country.minorUnit);

  if (alias?.kind === 'UPSELL') {
    // AN UPSELL MESSAGE: its product must be on this store's shelf; «إسم العرض» («default») is not read; its line is priced only
    // with its base, by the pair's own rule.
    info.via = 'upsell';
    info.role = 'upsell';
    const upsellProduct = products.find((p) => p.id === alias.productId);
    if (!upsellProduct) return review('UPSELL_PRODUCT_UNAVAILABLE');
    info.productName = upsellProduct.name;
    if (written === null) return review('MISSING_PRICE');
    info.written = written;
    if (reading.quantity > UPSELL_COUNT_MAX) return review('UPSELL_QUANTITY_INVALID');
    return { kind: 'upsell', message, reading, alias, aliases, product: upsellProduct, storeId, country, written };
  }

  // A RENAMED product is the catalogue product it points at — which must still be ACTIVE in this store.
  const renamed = alias ? products.find((p) => p.id === alias.productId) ?? null : null;
  if (alias) info.via = 'alias';
  if (alias && !renamed) return review('ALIAS_PRODUCT_UNAVAILABLE');
  const found = renamed ? { product: renamed } : catalogueProduct(productText, products);
  if ('reason' in found) return review(found.reason);
  const product = found.product;
  info.productName = product.name;

  if (written === null) return review('MISSING_PRICE');
  info.written = written;

  // The offer: a currency in its text must be the store's own (never converted), then ONE active offer of this product.
  const storeCurrency = country.currencyCode.trim().toUpperCase();
  if (currenciesIn(fields.offer).some((code) => code !== storeCurrency)) return review('CURRENCY_MISMATCH');
  const offers = await activeOffersFor(db, companyId, product.id, country.minorUnit);
  let matched: { kind: 'found'; offer: (typeof offers)[number] } | { kind: 'ambiguous' } | { kind: 'none' } = matchOfferText(fields.offer, offers);
  // An OLD offer text of a renamed product names «QUANTITY q at PRICE p»: the product's active offer with the same paid pieces
  // and the same charged price — asked only when the normal match found none. It names the offer; it never prices anything.
  if (matched.kind === 'none' && alias) {
    const old = offerAliasFor(fields.offer, alias);
    if (old) matched = pickAliasedOffer(offers, old, country.minorUnit);
  }
  if (matched.kind === 'ambiguous') return review('OFFER_AMBIGUOUS');
  if (matched.kind === 'none') return review('OFFER_NOT_FOUND');

  // «الكمية» is pieces of the product: 1 or the offer's paid pieces = one offer, k × those = k offers, else not an offer.
  const bundles = offersForQuantity(reading.quantity, matched.offer.quantity);
  if (bundles === null) return review('QUANTITY_NOT_OFFER');

  // The line, priced from the offer ROW by the storefront door's own function — and the written price is checked against it.
  const priced = await resolvePublicLines(
    companyId,
    [product],
    [{ productId: product.id, offerId: matched.offer.id, count: bundles }],
    country.minorUnit
  );
  if (!priced.ok) return review('OFFER_NOT_FOUND');
  const line = priced.lines[0];
  const expected = priceTelegramLine(line, country.minorUnit).cod;
  return { kind: 'base', message, reading, alias, aliases, product, line, storeId, country, written, expected };
}

/**
 * THE OTHER HALF OF AN UPSELL PAIR: the messages of the same source with the same «رقم الطلب», arrived within `windowMs` of
 * this one, with no order yet and not set aside (PENDING counts: two webhooks can race) — of the kind wanted (an upsell for a
 * base, a base for an upsell). The same phone makes a partner; the same number with another phone is a mismatch, two partners
 * are ambiguous. Read again with the same reader, so the key is compared exactly as the door read it.
 */
async function findPartners(
  self: Extract<Prepared, { kind: 'upsell' | 'base' }>,
  want: 'base' | 'upsell',
  windowMs: number
): Promise<{ kind: 'none' } | { kind: 'mismatch' } | { kind: 'ambiguous' } | { kind: 'one'; message: StoredMessage }> {
  const number = self.reading.orderNumber;
  if (!number || !self.message.sourceId) return { kind: 'none' };
  const at = self.message.createdAt.getTime();
  const keypad = number.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const rows: StoredMessage[] = await db.telegramMessage.findMany({
    where: {
      companyId: self.message.companyId,
      sourceId: self.message.sourceId,
      id: { not: self.message.id },
      orderId: null,
      processingStatus: { in: ['PENDING', 'NEEDS_REVIEW'] },
      createdAt: { gte: new Date(at - windowMs), lte: new Date(at + windowMs) },
      OR: [...new Set([number, keypad])].map((needle) => ({ text: typed(needle) })),
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: STORED_MESSAGE_SELECT,
  });
  const phone = phoneKeyOf(self.reading.fields.phone, self.country.code);
  const partners: StoredMessage[] = [];
  let otherPhone = false;
  for (const row of rows) {
    const other = readLabeledOrder(row.text ?? '', { country: self.country, receivedAt: row.createdAt });
    if (!other.claimed || !other.ok || other.orderNumber !== number) continue;
    const isUpsell = aliasFor(other.fields.product, self.aliases)?.kind === 'UPSELL';
    if (isUpsell !== (want === 'upsell')) continue;
    if (phoneKeyOf(other.fields.phone, self.country.code) !== phone) {
      otherPhone = true;
      continue;
    }
    partners.push(row);
  }
  if (partners.length > 1) return { kind: 'ambiguous' };
  if (partners.length === 1) return { kind: 'one', message: partners[0] };
  return otherPhone ? { kind: 'mismatch' } : { kind: 'none' };
}

/**
 * THE DOOR (labeled format) — THE DECISION, WITH NOTHING WRITTEN.
 *
 * Every refusal comes before anything is written, in this order: not the format → the store → the fields (the catalogue
 * and the price ceiling included) → the duplicate → the blacklist → the customer → the order. A message refused at any
 * step leaves no customer and no order behind. `processLabeledMessage` writes what this decides; the dry-run only reads it.
 *
 * THE OFFER IS BOUND (28/10: «نص العرض مربوط بالعرض»). «إسم العرض» is matched to ONE active offer of THIS product; the
 * order is then priced by the storefront door's own functions over that offer row (`resolvePublicLines`, `basketDiscount`,
 * `computeCod`): the offer's price, its gift units, its `deliveryIncluded`. «السعر» is a claim checked against that price
 * (PRICE_MISMATCH) and never the money; «الكمية» is the product's pieces: 1 or the offer's paid pieces is ONE offer, a whole
 * multiple k is k offers, anything else is QUANTITY_NOT_OFFER. No offer found = no order.
 *
 * THE UPSELL (10/11). A base whose written price is ABOVE its offer's, in a store that has upsell names, is half of a pair: with
 * the upsell message of the same source, number and phone it is ONE order (`upsell-pair.ts`); without it, it waits up to ten
 * minutes (`WAITING_FOR_UPSELL:<until>`) and then gets its own reason (PRICE_MISMATCH). An upsell message waits for its base the
 * same way (`WAITING_FOR_BASE:<until>`, then UPSELL_WITHOUT_BASE). A wait is a review with a reason — no new status, no job.
 * A message that is not an upsell and whose price is its offer's is exactly what it was before.
 *
 * THE PHONE AND THE ADDRESS ARE TAKEN LENIENTLY (`phone-text.ts`, `labeled-order.ts`): no message is refused for how its number
 * is written, for a number a digit short (6 digits or more is taken, and the order's notes say it does not fit the country's
 * shape), or for what its address says («سوريا» alone, another country's word). Only a stub of a number is held (INVALID_PHONE,
 * with the number as written), and no digit at all is missing.
 */
async function decideLabeledMessage(message: StoredMessage, options: ProcessOptions = {}): Promise<Decision> {
  const holds = options.holds !== false;
  const now = options.now ?? new Date();
  const windowMs = options.pairWindowMs ?? UPSELL_HOLD_MS;
  const info = blankInfo();
  const review = (reason: string): Decision => ({ kind: 'review', reason, info });

  const prepared = await prepareMessage(message, info);
  if (prepared.kind === 'refused') return prepared.decision;
  const until = holdUntil(message.createdAt);
  const mayWait = holds && now.getTime() < until.getTime();

  if (prepared.kind === 'upsell') {
    if (!prepared.reading.orderNumber) return review('UPSELL_WITHOUT_BASE');
    const found = await findPartners(prepared, 'base', windowMs);
    if (found.kind === 'ambiguous') return review('UPSELL_PAIR_AMBIGUOUS');
    if (found.kind === 'mismatch') return review('UPSELL_PAIR_MISMATCH');
    if (found.kind === 'none') return mayWait ? review(`WAITING_FOR_BASE:${until.toISOString()}`) : review('UPSELL_WITHOUT_BASE');
    info.via = 'pair';
    info.partnerId = found.message.id;
    const base = await prepareMessage(found.message, blankInfo());
    if (base.kind !== 'base') return review('UPSELL_BASE_REFUSED');
    return finishOrder(base, info, prepared);
  }

  const { written, expected, country } = prepared;
  if (written === expected) return finishOrder(prepared, info, null);

  // Above the offer, with a number, in a store that sells upsells: half of a pair, maybe.
  const sellsUpsells = prepared.aliases.some((a) => a.kind === 'UPSELL');
  if (written > expected && prepared.reading.orderNumber && sellsUpsells) {
    info.role = 'base';
    const found = await findPartners(prepared, 'upsell', windowMs);
    if (found.kind === 'ambiguous') return review('UPSELL_PAIR_AMBIGUOUS');
    if (found.kind === 'mismatch') return review('UPSELL_PAIR_MISMATCH');
    if (found.kind === 'one') {
      info.via = 'pair';
      info.partnerId = found.message.id;
      const upsell = await prepareMessage(found.message, blankInfo());
      if (upsell.kind === 'refused') return review(upsell.decision.kind === 'order' ? 'UPSELL_PAIR_MISMATCH' : upsell.decision.reason);
      if (upsell.kind !== 'upsell') return review('UPSELL_PAIR_MISMATCH');
      return finishOrder(prepared, info, upsell);
    }
    if (mayWait) return review(`WAITING_FOR_UPSELL:${until.toISOString()}`);
  }
  return review(`PRICE_MISMATCH:${expected.toFixed(country.minorUnit)}`);
}

/**
 * The order, once the money is right: the duplicate, then the blacklist — both READ — and the draft the writer turns into a
 * customer and an order. For a pair, the pair's own rule (`judgePair`) decides the lines and the total first.
 */
async function finishOrder(
  base: Extract<Prepared, { kind: 'base' }>,
  info: DecisionInfo,
  upsell: Extract<Prepared, { kind: 'upsell' }> | null
): Promise<Decision> {
  const review = (reason: string): Decision => ({ kind: 'review', reason, info });
  const { companyId } = base.message;
  const { storeId, country, reading, product, line } = base;
  const { fields, phone } = reading;

  let extraLines: ResolvedLine[] = [];
  let total = base.expected;
  let units = line.quantity + line.freeQuantity;
  let mergeNote: string | null = null;
  if (upsell) {
    const verdict = judgePair({
      base: { written: base.written, phoneKey: phoneKeyOf(fields.phone, country.code), line },
      upsell: {
        written: upsell.written,
        phoneKey: phoneKeyOf(upsell.reading.fields.phone, country.code),
        count: upsell.reading.quantity,
        alias: upsell.alias,
        product: { id: upsell.product.id, name: upsell.product.name, image: upsell.product.image, basePrice: Number(upsell.product.basePrice) },
      },
      minorUnit: country.minorUnit,
    });
    if (!verdict.ok) return review(verdict.reason);
    extraLines = [verdict.lines[1]];
    total = verdict.total;
    units = verdict.units;
    const extra = verdict.lines[1];
    const amount = roundMinor(extra.quantity * extra.unitPrice, country.minorUnit);
    mergeNote = [
      `دمج أب سيل: ${upsell.alias.incomingName.slice(0, 80)} · +${extra.quantity} عبوات · ${amount.toFixed(country.minorUnit)}`,
      `رسائل تلجرام: ${base.message.messageId} + ${upsell.message.messageId}`,
    ].join(' · ');
  }

  // 3 — the same customer, the same time and the same product already made an order.
  const twin = await findTwinOrder({
    companyId,
    storeId,
    messageRowId: base.message.id,
    receivedAt: base.message.createdAt,
    orderedAt: fields.orderedAt,
    phone: fields.phone,
    countryCode: country.code,
    productId: product.id,
  });
  if (twin) return review('DUPLICATE_ORDER');

  // 4 — the blacklist, company-wide, on every number of the line: as written, and cleaned (a + kept) — of both messages of a pair.
  // Held for review rather than dropped: a human should see that a blocked number tried again, and decide.
  const numbers = [fields.phone, phone.primary, ...phone.others];
  if (upsell) numbers.push(upsell.reading.fields.phone, upsell.reading.phone.primary, ...upsell.reading.phone.others);
  for (const number of numbers) {
    if (await isBlocked(db, companyId, number, country.code)) return review('CUSTOMER_BLOCKED');
  }

  return {
    kind: 'order',
    info,
    draft: {
      storeId,
      country,
      base: base.message,
      reading,
      product,
      line,
      extraLines,
      linkIds: upsell ? [base.message.id, upsell.message.id] : [base.message.id],
      total,
      units,
      aliasName: base.alias ? base.alias.incomingName : null,
      mergeNote,
    },
  };
}

/** THE DOOR, WRITING: what `decideLabeledMessage` decided — a reason on the message, or a customer and an order. */
async function processLabeledMessage(
  message: StoredMessage,
  review: (reason: string) => Promise<StoredProcessingResult>,
  ignore: (reason: string) => Promise<StoredProcessingResult>,
  options: ProcessOptions = {}
): Promise<StoredProcessingResult> {
  const decision = await decideLabeledMessage(message, options);
  if (decision.kind === 'ignore') return ignore(decision.reason);
  if (decision.kind === 'review') return review(decision.reason);

  const { storeId, country, reading, product, line, base } = decision.draft;
  const { fields, place, priceText, phone } = reading;

  // 5 — the customer, the shared way: found by this store's phone, or made. A second valid number is the second phone.
  const second = phone.others.find((n) => isValidPhoneFor(country.code, n));
  const customer = await findOrCreateCustomer(db, {
    companyId: message.companyId,
    storeId,
    phone: normalizePhoneNumber(phone.primary, country.code),
    rawPhone: phone.primary.slice(0, 20),
    altPhone: second ? normalizePhoneNumber(second, country.code) : null,
    fullName: fields.customer.slice(0, 80),
    address: place.slice(0, 200),
    city: place.slice(0, 60),
  });

  // 6 — the order, through the one door and its one calculator. The source time, the offer's name and any other numbers
  // go to the internal notes only; the order number is a pairing key and is written nowhere.
  const created = await createTelegramOrder({
    companyId: message.companyId,
    storeId,
    customer,
    product,
    line,
    extraLines: decision.draft.extraLines,
    address: place.slice(0, 200),
    governorate: place,
    priceText,
    sourceNote: [
      `وقت الطلب بالمصدر: ${fields.orderedAt}`,
      `العرض: ${line.offer?.name ?? ''}`.slice(0, 120),
      decision.draft.aliasName ? `الاسم القديم: ${decision.draft.aliasName}`.slice(0, 120) : null,
      phone.others.length ? `أرقام أخرى: ${phone.others.join(' ، ')}` : null,
      phone.valid ? null : `تنبيه: رقم الهاتف ما بيطابق شكل أرقام البلد (كما انكتب: ${fields.phone.slice(0, 40)}) — تأكدوا منه بالاتصال`,
    ]
      .filter(Boolean)
      .join(' · '),
    linkMessageId: base.id,
    linkMessageIds: decision.draft.linkIds,
    mergeNote: decision.draft.mergeNote ?? undefined,
    telegram: {
      messageId: base.messageId,
      chatId: base.chatId,
      threadId: base.threadId ?? null,
      chatTitle: base.threadName ?? undefined,
    },
  });

  if (!created.ok) {
    if (created.reason === 'ALREADY_LINKED') return linkedElsewhere(message.id);
    return review(created.reason);
  }
  return { status: 'PROCESSED', orderId: created.orderId };
}
