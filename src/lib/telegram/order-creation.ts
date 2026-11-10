/**
 * TELEGRAM ORDER CREATION SERVICE
 *
 * Mirrors the existing order-creation transaction (POST /api/orders and the
 * storefront door) so Telegram orders obey the exact same business rules:
 * server-set price, server-set statuses, sequential order number with P2002
 * retry, customer counters, activity timeline, status log, and the
 * claimable-queue workflow entry point.
 *
 * THE MONEY IS THE OFFER'S (28/10: «نص العرض مربوط بالعرض»). The door binds the
 * message's «إسم العرض» to one active offer of the product and hands this
 * function the line `resolvePublicLines` priced from that offer row: paid
 * pieces, gift units, unit price, the offer's reduction. The total, the line
 * totals and the discount share come from the one calculator over that line
 * (`priceTelegramLine`), exactly as `createPublicOrder` does — the price the
 * seller WROTE is checked against it by the door and written nowhere as money.
 *
 * The Telegram caller can NEVER influence price, status, total, or
 * companyId.
 */
import { toLatinDigits } from '../latin-digits';
import { priceIncludesDeliveryFor } from '../delivery-fees';
import { db } from '../db';
import { notify } from '../notify';
import { logAudit } from '../audit';
import { flagRecentTwins } from '../recent-twin-order';
import { resolveRegionId } from '@/lib/regions';
import { orderRefFields } from '../order-ref';
import { computeCod, roundMinor } from '../money';
import { unitCostsOf } from '../product-fixed-cost';
import { basketDiscount, type ResolvedLine } from '../public-order';
import { priceLines } from './upsell-pair';

export interface CreateTelegramOrderInput {
  companyId: string;
  /** Store of the Telegram source (null = source not bound to a store yet). */
  storeId: string | null;
  customer: { id: string; firstOrderDate: Date | null; totalOrders: number };
  product: { id: string; name: string; image: string | null; basePrice: number };
  /**
   * WHAT WAS ORDERED, priced by the server from the offer row the message named: paid pieces, gift units, the unit price
   * before the offer's own reduction, and the reduction. Never built from the message's text.
   */
  line: ResolvedLine;
  address: string;
  governorate?: string;
  notes?: string;
  /** السعر كما ورد في الرسالة — audit فقط، لا يُستخدم سعرًا نهائيًا: السعر من العرض */
  priceText?: string;
  /** اسم الصفحة التجارية من الرسالة = المصدر في Orders (غير مجموعة تيليجرام) */
  pageName?: string;
  /**
   * Turns delivery-inclusive ON for this order, as an offer's `deliveryIncluded` does — the same `priceIncludesDeliveryFor`,
   * which only ever turns it ON. The bound offer's own `deliveryIncluded` is read from `line.offer` regardless of this.
   * Absent, the store's own policy decides. Nothing here writes the store.
   */
  deliveryIncluded?: boolean;
  /** «مرجع المصدر: … · وقت الطلب بالمصدر: … · العرض: …» — kept in the internal notes and nowhere else. */
  sourceNote?: string;
  /**
   * The TelegramMessage row this order is made from. Linked INSIDE the order's transaction, and only while it has no
   * order: two presses of «إعادة المعالجة» at the same moment make one order, and the second one rolls back.
   */
  linkMessageId?: string;
  /**
   * THE YOUCAN UPSELL (10/11): the lines a SECOND message of the same order adds — priced by the door (`upsell-pair.ts`), no
   * offer, no gift. The order is then ONE `computeCod` over `line` and these, the head is the principal line exactly as
   * `createPublicOrder` takes it, and the cost of goods is the sum over every line. Absent, the order is the one line, as always.
   */
  extraLines?: ResolvedLine[];
  /**
   * Every TelegramMessage the order is made from, when it is more than one (the base and its upsell). Each is linked inside the
   * transaction, only while it has no order: if ANY of them already has one, the whole order rolls back (`ALREADY_LINKED`).
   * Takes the place of `linkMessageId` when given.
   */
  linkMessageIds?: string[];
  /** One line for the internal notes and the timeline when the order was merged: «دمج أب سيل: … · +n عبوات · المبلغ». */
  mergeNote?: string;
  telegram: {
    messageId: string;
    chatId: string;
    threadId: number | null;
    chatTitle?: string;
  };
}

export type CreateTelegramOrderResult =
  | { ok: true; orderId: string; orderNumber: string }
  | {
      ok: false;
      reason: 'NO_SYSTEM_ACTOR' | 'CREATION_FAILED' | 'PRODUCT_NOT_FOUND' | 'NO_STORE' | 'ALREADY_LINKED';
    };

/** Thrown inside the transaction when the message already has its order — so this one is rolled back, not kept. */
class MessageAlreadyLinked extends Error {}

/** Sane upper bound for a Telegram-provided order total. */
const MAX_UNIT_PRICE = 100_000;

/**
 * Parse the advertised TOTAL order price text ("45 دولار" / "$45" / "45 USD" /
 * "٤٥ دولار") → validated number. Returns null when missing/invalid — the
 * caller must NOT fall back silently to DB pricing.
 *
 * TWO DECIMALS WAS A GUESS ABOUT THE CURRENCY, AND IT COST A FILS.
 *
 * The pattern accepted at most two decimal places and the result was then
 * `.toFixed(2)`. On the Jordanian store in this database the currency is JOD,
 * **minorUnit 3** — so an advertised «14.250» was read as 14.25 and «14.255»
 * was refused as unparseable. The money is rounded by the currency now, the
 * way `computeCod`, `allocateDiscount` and the waybill all round.
 *
 * `minorUnit` defaults to 2 so the function keeps its old behaviour for a
 * caller that does not know the store — but the one caller does.
 */
export function parseAdvertisedPrice(
  priceText: string | undefined | null,
  minorUnit = 2
): number | null {
  if (!priceText || !priceText.trim()) return null;
  const t = toLatinDigits(priceText);
  // Negative prices are invalid (reject before the digits match)
  if (/(?:^|\s)[-–—]\s*\d/.test(t)) return null;
  const places = Math.max(0, Math.min(6, Math.trunc(minorUnit)));
  const m = t.match(places > 0 ? new RegExp(`\\d+(?:[.,]\\d{1,${places}})?`) : /\d+/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_UNIT_PRICE) return null;
  return roundMinor(n, places);
}

/**
 * Resolve a company user to act as the bookkeeping actor for
 * OrderStatusLog (changedById is NOT NULL in the schema). This is a
 * server-resolved system actor — never a client-supplied identity.
 */
async function resolveSystemActor(companyId: string) {
  const admin = await db.user.findFirst({
    where: { companyId, role: 'COMPANY_ADMIN', status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  if (admin) return admin;
  return db.user.findFirst({
    where: { companyId, role: 'SUPER_ADMIN', status: 'ACTIVE' },
    select: { id: true, role: true },
  });
}

/**
 * WHAT THIS LINE COSTS — the one calculator, over the line the offer priced.
 *
 * `createPublicOrder` calls `computeCod` over `resolvePublicLines`' lines with `basketDiscount(lines)`; this is the same
 * call for the one line of a Telegram order. The door asks it BEFORE any customer is written (the written price must equal
 * `.cod`), and `createTelegramOrder` asks it again to write the order, so the two cannot differ. Gift units are real stock at
 * zero price: they never enter the money, only the stock and the cost of goods.
 */
export function priceTelegramLine(line: ResolvedLine, minorUnit: number) {
  return computeCod({
    lines: [{ quantity: line.quantity, unitPrice: line.unitPrice, freeQuantity: line.freeQuantity }],
    discount: basketDiscount([line]),
    minorUnit,
  });
}

/** The same calculator over every line of a merged order (the base and its upsell) — `upsell-pair.ts` asked it first. */
export function priceTelegramLines(lines: ResolvedLine[], minorUnit: number) {
  return priceLines(lines, minorUnit);
}

export async function createTelegramOrder(input: CreateTelegramOrderInput): Promise<CreateTelegramOrderResult> {
  const actor = await resolveSystemActor(input.companyId);
  if (!actor) return { ok: false, reason: 'NO_SYSTEM_ACTOR' };

  const { companyId, storeId, customer, product, line, address, notes, priceText, pageName, telegram } = input;
  const extraLines = input.extraLines ?? [];
  // Every line of the order: the offer's line first, then what an upsell message added (none, for every order but a merge).
  const lines: ResolvedLine[] = [line, ...extraLines];

  if (!storeId) return { ok: false, reason: 'NO_STORE' };
  const store = await db.store.findFirst({
    where: { id: storeId, companyId },
    select: { id: true, countryId: true, country: { select: { currencyCode: true, orderPrefix: true, minorUnit: true } } },
  });
  if (!store) return { ok: false, reason: 'NO_STORE' };

  const productRow = await db.product.findFirst({ where: { id: product.id, companyId } });
  if (!productRow) return { ok: false, reason: 'PRODUCT_NOT_FOUND' };
  // The product row of every line, this company's only (an upsell line names a product of the same store; the door checked it).
  const rowsById = new Map([[productRow.id, productRow]]);
  for (const extra of extraLines) {
    if (rowsById.has(extra.product.id)) continue;
    const row = await db.product.findFirst({ where: { id: extra.product.id, companyId } });
    if (!row) return { ok: false, reason: 'PRODUCT_NOT_FOUND' };
    rowsById.set(row.id, row);
  }

  // ONE COD function (contract PART 5), over the offer's line — and, for a merged upsell order, over every line at once. The
  // total is what it says — the message's «السعر» is a claim the door has already checked against this very figure, and it is
  // only an audit note on the order.
  const money = extraLines.length
    ? priceTelegramLines(lines, store.country.minorUnit)
    : priceTelegramLine(line, store.country.minorUnit);
  const totalAmount = money.cod;

  // THE HEAD OF THE ORDER IS ITS PRINCIPAL LINE (as `createPublicOrder`): the largest line total, a tie going to the earlier
  // line — so the offer's line heads a merged order unless the upsell is worth more. One line: the line itself.
  let principal = 0;
  for (let i = 1; i < lines.length; i++) {
    if ((money.lineTotals[i] ?? 0) > (money.lineTotals[principal] ?? 0)) principal = i;
  }
  const head = lines[principal];
  const headRow = rowsById.get(head.product.id) ?? productRow;
  const quantity = head.quantity;
  const freeQuantity = head.freeQuantity;

  // The gift is a real unit in the box: the goods cost what the paid pieces AND the gift cost (as `createPublicOrder`).
  //
  // ONE UNIT COSTS WHAT IT COSTS AT EVERY OTHER DOOR (the owner, 1/11 «ثابت لكل الطلبات» · 3/11 «صلّحهن»): `unitCostsOf` — the
  // product's FIXED figure when an admin set one (zero included), else the weighted average of what is on hand, else 0.
  //
  // This door used to read the unit cost of the product's NEWEST batch instead (`batches[0]` by `productionDate desc`, an empty
  // batch included): the same product, raised the same minute, cost one figure from Telegram and another from the manual door
  // (RV574). The batches are not read here any more, so nothing of that reading is left to drift back.
  // Every line, gift units included: the sum of unit cost x (paid + gift) over the order's lines, rounded once by the currency.
  const unitCosts = await unitCostsOf(db, companyId, [...rowsById.keys()]);
  const estimatedCostOfGoods = roundMinor(
    lines.reduce((sum, l) => sum + (unitCosts.get(l.product.id) ?? 0) * (l.quantity + l.freeQuantity), 0),
    store.country.minorUnit
  );
  const linkIds = input.linkMessageIds?.length ? input.linkMessageIds : input.linkMessageId ? [input.linkMessageId] : [];
  const now = new Date();

  try {
    // The delivery fee is keyed on the region, so bind it at intake.
    const resolvedRegionId = await resolveRegionId(db, store.countryId, input.governorate ?? address);
    // The store's pricing policy — the same rule every other door follows; the offer's `deliveryIncluded` turns it on
    // for this order, as at the storefront, and can never turn it off.
    const priceIncludesDelivery = await priceIncludesDeliveryFor(
      store.id,
      line.offer?.deliveryIncluded === true || input.deliveryIncluded === true ? true : undefined
    );

    const order = await db.$transaction(async (tx) => {
      let created: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const refs = await orderRefFields(tx, companyId, store.country.orderPrefix, attempt, now);
          created = await tx.order.create({
            data: {
              companyId,
              countryId: store.countryId,
              storeId: store.id,
              regionId: resolvedRegionId,
              ...refs,
              customerId: customer.id,
              productId: headRow.id,
              quantity,
              freeQuantity,
              offerId: head.offer?.id ?? null,
              sellingPrice: money.lineTotals[principal] ?? money.subtotal,
              shippingCost: 0,
              priceIncludesDelivery,
              totalAmount,
              currency: store.country.currencyCode,
              moderatorId: null,
              estimatedCostOfGoods,
              productNameSnapshot: headRow.name,
              productImageSnapshot: headRow.image || null,
              status: 'NEW',
              confirmationStatus: 'NEW',
              shippingStatus: 'NOT_READY',
              settlementStatus: 'NOT_APPLICABLE',
              assignedToId: null,
              claimedById: null,
              currentOwnerId: null,
              signatureStatus: 'UNSIGNED',
              version: 1,
              // Channel + commercial source: Order.source = "Telegram → <page>"
              // (page from the message only; the Telegram group is stored in
              // internalNotes — three distinct facts, never mixed)
              source: pageName?.trim() ? `Telegram → ${pageName.trim().slice(0, 30)}` : 'Telegram',
              customerNotes: notes?.trim()?.slice(0, 500) || null,
              internalNotes: [
                `Telegram: chat ${telegram.chatId}${telegram.threadId ? ` topic ${telegram.threadId}` : ''} msg ${telegram.messageId}`,
                pageName?.trim() ? `page: ${pageName.trim().slice(0, 60)}` : null,
                priceText?.trim() ? `advertised total price: ${priceText.trim().slice(0, 30)}` : null,
                input.sourceNote?.trim() ? input.sourceNote.trim().slice(0, 300) : null,
                input.mergeNote?.trim() ? input.mergeNote.trim().slice(0, 300) : null,
                telegram.chatTitle ? `group: ${telegram.chatTitle.slice(0, 60)}` : null,
              ].filter(Boolean).join(' | '),
            },
          });
          break;
        } catch (e: any) {
          if (e?.code === 'P2002' && attempt < 4) continue;
          throw e;
        }
      }
      if (!created) throw new Error('Failed to generate a unique order number');

      // One message, one order. The row lock taken here makes a second, simultaneous press wait; when it reads the row
      // again the order is already set, it touches nothing, and its whole transaction — its order included — rolls back.
      // A merged order links BOTH its messages here, and either one already linked rolls the whole of it back.
      for (const messageRowId of linkIds) {
        const linked = await tx.telegramMessage.updateMany({
          where: { id: messageRowId, orderId: null },
          data: { orderId: created.id, processingStatus: 'PROCESSED', processedAt: now, reviewReason: null },
        });
        if (linked.count !== 1) throw new MessageAlreadyLinked();
      }

      // Order lines: the offer's, gift units included (real stock at zero price), the reduction as its discount share — and,
      // for a merged order, the upsell's line after it. One `create` per line, in order.
      for (const [i, line] of lines.entries()) {
        const row = rowsById.get(line.product.id) ?? productRow;
        await tx.orderItem.create({
          data: {
            companyId,
            orderId: created.id,
            productId: row.id,
            productName: row.name,
            quantity: line.quantity,
            freeQuantity: line.freeQuantity,
            unitPrice: line.unitPrice,
            discountShare: money.discountShares[i] ?? 0,
            lineTotal: money.lineTotals[i] ?? (lines.length === 1 ? money.subtotal : 0),
            addedStage: 'INTAKE',
          },
        });
      }

      await tx.customer.update({
        where: { id: customer.id },
        data: {
          totalOrders: { increment: 1 },
          lastOrderDate: now,
          firstOrderDate: customer.firstOrderDate || now,
        },
      });

      await tx.orderActivity.create({
        data: {
          companyId,
          orderId: created.id,
          userId: actor.id,
          action: 'ORDER_CREATED',
          newStatus: 'NEW',
          metadata: JSON.stringify({
            source: 'Telegram',
            telegramMessageId: telegram.messageId,
            telegramChatId: telegram.chatId,
            telegramThreadId: telegram.threadId,
            ...(linkIds.length > 1 ? { telegramMessageRowIds: linkIds, merge: input.mergeNote ?? null } : {}),
          }),
        },
      });

      await tx.orderStatusLog.create({
        data: {
          companyId,
          orderId: created.id,
          statusType: 'CONFIRMATION',
          previousValue: null,
          newValue: 'NEW',
          changedById: actor.id,
          changedByRole: actor.role,
          note: 'Order created automatically from Telegram group message',
        },
      });

      return created;
    });

    await logAudit({
      companyId,
      userId: actor.id,
      action: 'ORDER_CREATED_TELEGRAM',
      entity: 'Order',
      entityId: order.id,
      newData: {
        orderNumber: (order as any).orderNumber,
        source: (order as any).source,
        pageName: pageName?.trim()?.slice(0, 60) || null,
        telegramMessageId: telegram.messageId,
        telegramChatId: telegram.chatId,
        telegramThreadId: telegram.threadId,
        ...(linkIds.length > 1 ? { telegramMessageRowIds: linkIds, merge: input.mergeNote ?? null } : {}),
      },
    });

    // Same customer, same product, minutes apart: a flag on the history for the person who calls — never a refusal.
    await flagRecentTwins(db, {
      companyId,
      orderId: order.id,
      customerId: customer.id,
      productIds: [...new Set([product.id, ...extraLines.map((l) => l.product.id)])],
      at: (order as any).createdAt ?? now,
      userId: actor.id,
    });

    // This store's confirmation supervisors; nobody acted, so nobody is
    // left out. createNotification never throws.
    notify({
      companyId,
      storeId: store.id,
      audience: { permission: 'confirmation.supervise' },
      title: 'طلب جديد من تيليجرام',
      message: `تم إنشاء طلب جديد #${(order as any).orderNumber} تلقائيًا من تيليجرام.`,
      type: 'ORDER_NEW',
      link: ['/confirmation/queue', '/confirmation/mine', '/orders'],
      orderId: (order as any).id,
    });

    return { ok: true, orderId: order.id, orderNumber: (order as any).orderNumber };
  } catch (e) {
    if (e instanceof MessageAlreadyLinked) return { ok: false, reason: 'ALREADY_LINKED' };
    console.error('[telegram] order creation failed:', (e as Error)?.name || 'unknown');
    return { ok: false, reason: 'CREATION_FAILED' };
  }
}
