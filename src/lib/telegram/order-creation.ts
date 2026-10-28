/**
 * TELEGRAM ORDER CREATION SERVICE
 *
 * Mirrors the existing order-creation transaction (POST /api/orders) so
 * Telegram orders obey the exact same business rules: server-set price
 * (product.basePrice), server-set statuses, sequential order number with
 * P2002 retry, customer counters, activity timeline, status log, and the
 * claimable-queue workflow entry point.
 *
 * The Telegram caller can NEVER influence price, status, total, or
 * companyId — only the extracted quantity/notes, already validated.
 */
import { toLatinDigits } from '../latin-digits';
import { priceIncludesDeliveryFor } from '../delivery-fees';
import { db } from '../db';
import { notify } from '../notify';
import { logAudit } from '../audit';
import { resolveRegionId } from '@/lib/regions';
import { orderRefFields } from '../order-ref';
import { computeCod, roundMinor } from '../money';

export interface CreateTelegramOrderInput {
  companyId: string;
  /** Store of the Telegram source (null = source not bound to a store yet). */
  storeId: string | null;
  customer: { id: string; firstOrderDate: Date | null; totalOrders: number };
  product: { id: string; name: string; image: string | null; basePrice: number };
  quantity: number;
  address: string;
  governorate?: string;
  notes?: string;
  /** السعر كما ورد في الرسالة — audit فقط، لا يُستخدم سعرًا نهائيًا */
  priceText?: string;
  /** اسم الصفحة التجارية من الرسالة = المصدر في Orders (غير مجموعة تيليجرام) */
  pageName?: string;
  /**
   * The message said «توصيل مجاني» / «التوصيل مجاني» / «شامل التوصيل»: THIS order's price includes delivery, exactly as
   * an offer's `deliveryIncluded` does — handed to the same `priceIncludesDeliveryFor`, which only ever turns it ON.
   * Absent, the store's own policy decides, as it always did. Nothing here writes the store.
   */
  deliveryIncluded?: boolean;
  /** «مرجع المصدر: … · وقت الطلب بالمصدر: … · العرض: …» — kept in the internal notes and nowhere else. */
  sourceNote?: string;
  /**
   * The TelegramMessage row this order is made from. Linked INSIDE the order's transaction, and only while it has no
   * order: two presses of «إعادة المعالجة» at the same moment make one order, and the second one rolls back.
   */
  linkMessageId?: string;
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
      reason: 'NO_SYSTEM_ACTOR' | 'CREATION_FAILED' | 'PRODUCT_NOT_FOUND' | 'MISSING_PRICE' | 'NO_STORE' | 'ALREADY_LINKED';
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

export async function createTelegramOrder(input: CreateTelegramOrderInput): Promise<CreateTelegramOrderResult> {
  const actor = await resolveSystemActor(input.companyId);
  if (!actor) return { ok: false, reason: 'NO_SYSTEM_ACTOR' };

  const { companyId, storeId, customer, product, quantity, address, notes, priceText, pageName, telegram } = input;

  if (!storeId) return { ok: false, reason: 'NO_STORE' };
  const store = await db.store.findFirst({
    where: { id: storeId, companyId },
    select: { id: true, countryId: true, country: { select: { currencyCode: true, orderPrefix: true, minorUnit: true } } },
  });
  if (!store) return { ok: false, reason: 'NO_STORE' };

  /**
   * PRICING (business rule): the Telegram message price is the TOTAL ORDER
   * AMOUNT (for the whole quantity), NOT a unit price. The server validates
   * it (numeric, finite, > 0, sane upper bound) — never trusts raw text.
   *   - valid price   → totalAmount = telegram price (DB basePrice ignored)
   *   -               → sellingPrice (unit) = totalAmount / quantity
   *   - missing/invalid price → NEEDS_REVIEW (MISSING_PRICE), never silent
   *     fallback to DB.
   * totalAmount is NEVER multiplied by quantity anywhere else.
   */
  const parsedTotal = parseAdvertisedPrice(priceText, store.country.minorUnit);
  if (parsedTotal === null) {
    return { ok: false, reason: 'MISSING_PRICE' };
  }
  const totalAmount = parsedTotal;
  const shipCost = 0;
  /*
   * Unit price derived server-side: total / quantity (quantity already
   * validated ≥ 1 — no division by zero possible), and DELIBERATELY NOT
   * ROUNDED.
   *
   * «العرض ع ٣ بـ١٠ بنحصّل ع ١٠» — the advertised total is what the customer
   * pays, and the unit price is a derived figure that exists so the line can
   * be priced. Rounding it first is what broke that: 10.000 JOD over three
   * pieces became 3.333 a piece, and `computeCod` then multiplied back to
   * 9.999. The shop lost a fils to arithmetic nobody asked for, and the
   * first edit through the orders PATCH moved the stored total down to match.
   *
   * Unrounded, the division carries its own precision and the PRODUCT is
   * what gets rounded: 3 × (10/3) is 10.000000000000002, which `roundMinor`
   * returns as exactly 10. The hair is gone — not absorbed by anybody.
   *
   * This is also what `resolvePublicLines` already does for an offer, whose price
   * is likewise the total for its own quantity. One rule at every door.
   */
  const price = totalAmount / quantity;

  const productRow = await db.product.findFirst({
    where: { id: product.id, companyId },
    include: { batches: { where: { companyId }, orderBy: { productionDate: 'desc' }, take: 1 } },
  });
  if (!productRow) return { ok: false, reason: 'PRODUCT_NOT_FOUND' };

  // `order.totalAmount` stores the Telegram total as-is.
  //
  // This note used to say the orders PATCH «recomputes total on later edits
  // via its own formula». It does not, and has not since the PATCH was moved
  // onto `computeCod` — it calls the same function this does. The sentence
  // outlived the thing it described, which is the worst kind of comment:
  // it sends the next reader to fix what is already fixed, and it reads as
  // permission for a second formula.
  //
  // ONE COD function (contract PART 5). Telegram orders carry no fee yet.
  const money = computeCod({
    lines: [{ quantity, unitPrice: price }],
    deliveryFee: shipCost,
    minorUnit: store.country.minorUnit,
  });

  const unitCost = productRow.batches[0]?.costPerUnit || 0;
  const estimatedCostOfGoods = roundMinor(unitCost * quantity, store.country.minorUnit);
  const now = new Date();

  try {
    // The delivery fee is keyed on the region, so bind it at intake.
    const resolvedRegionId = await resolveRegionId(db, store.countryId, input.governorate ?? address);
    // The store's pricing policy — the same rule every other door follows; the message's «توصيل مجاني» turns it on
    // for this order the way an offer's `deliveryIncluded` does, and can never turn it off.
    const priceIncludesDelivery = await priceIncludesDeliveryFor(store.id, input.deliveryIncluded);

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
              productId: productRow.id,
              quantity,
              sellingPrice: price,
              shippingCost: shipCost,
              priceIncludesDelivery,
              totalAmount,
              currency: store.country.currencyCode,
              moderatorId: null,
              estimatedCostOfGoods,
              productNameSnapshot: productRow.name,
              productImageSnapshot: productRow.image || null,
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
      if (input.linkMessageId) {
        const linked = await tx.telegramMessage.updateMany({
          where: { id: input.linkMessageId, orderId: null },
          data: { orderId: created.id, processingStatus: 'PROCESSED', processedAt: now, reviewReason: null },
        });
        if (linked.count !== 1) throw new MessageAlreadyLinked();
      }

      // Order line: the Telegram price is the order TOTAL, so the unit price
      // is derived once here and never multiplied again.
      await tx.orderItem.create({
        data: {
          companyId,
          orderId: created.id,
          productId: productRow.id,
          productName: productRow.name,
          quantity,
          unitPrice: money.subtotal / quantity,
          lineTotal: money.lineTotals[0] ?? money.subtotal,
          addedStage: 'INTAKE',
        },
      });

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
      },
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
    });

    return { ok: true, orderId: order.id, orderNumber: (order as any).orderNumber };
  } catch (e) {
    if (e instanceof MessageAlreadyLinked) return { ok: false, reason: 'ALREADY_LINKED' };
    console.error('[telegram] order creation failed:', (e as Error)?.name || 'unknown');
    return { ok: false, reason: 'CREATION_FAILED' };
  }
}
