import { z } from 'zod';
import { db } from '../db';
import { count } from '../numeric-input';
import { findOrCreateCustomer } from '../customer-identity';
import { activeBlock } from '../blacklist';
import { activeOffersFor, type OfferView } from '../offers';
import { computeCod, roundMinor } from '../money';
import { orderRefFields } from '../order-ref';
import { priceIncludesDeliveryFor } from '../delivery-fees';
import { productCosts } from '../product-cost';
import { resolveRegionId } from '../regions';
import { normalizePhoneNumber } from '../phone';
import { isValidPhoneFor, phoneErrorFor } from '../phone-rules';
import { realStoresOnly } from '../test-store';
import { encryptSecret, encryptionAvailable } from '../secrets';
import { logAudit } from '../audit';
import { notify } from '../notify';
import { flagRecentTwins } from '../recent-twin-order';
import { V1_CODE, V1Fault } from './door';
import type { SystemCaller } from './system-token';

/**
 * AN ORDER THAT ANOTHER SYSTEM TOOK, LANDING IN THIS ONE.
 *
 * ── WHAT WAS SPECIFIED, AND WHAT IS BUILT INSTEAD ──
 *
 * `OMS-DOOR-V1.md` says: «استخرج المنطق المشترك لدالة وحدة إذا لزم،
 * والمسارين القديمين ينادوها — بلا تغيير سلوكهم». Discovery says that is
 * not a refactor, it is a behaviour change to order creation.
 *
 * MEASURED: three doors create orders today — `POST /api/orders`,
 * `POST /api/orders/ai-intake` and `createPublicOrder` — and they DISAGREE,
 * deliberately, in writing, each difference carrying its own comment and in
 * most cases its own test:
 *
 *   · the head line      — the FIRST line here, the LARGEST line in
 *                          `public-order.ts` (and the comment says why)
 *   · `shippingCost`     — the caller's at `/api/orders`, 0 at the other two
 *   · the discount       — the single offer's, the basket's, or none
 *                          (`quote-discount.test.ts` names ai-intake's
 *                          `NO_OFFER_BOUND` and the reason it may not pass one)
 *   · `orderStatusLog`   — written by `/api/orders` only, and
 *                          `ai-proposal-only.test.ts` holds it as FORBIDDEN
 *                          to the file that asks a model
 *   · ownership          — `entryOwnership` at the two staff doors,
 *                          nobody's at the public one
 *
 * Folding those into one function means choosing one of each, which changes
 * what at least two existing doors write. «Order creation changed» is a
 * FIXED BLOCKER in AGENTS.md, and this task does not say to change it.
 *
 * ── SO WHAT IS REUSED IS EVERY RULE, AND NOT THE ROUTE BODY ──
 *
 * Nothing here decides anything that is already decided somewhere else.
 * `findOrCreateCustomer` · `activeBlock` · `resolveRegionId` ·
 * `activeOffersFor` · `computeCod` · `priceIncludesDeliveryFor` ·
 * `orderRefFields` · `productCosts` · `logAudit` — the
 * shared rules, called in the order `POST /api/orders` calls them in. A
 * guard (`the-systems-door.test.ts`) asserts this file imports each of them,
 * so a future edit cannot quietly grow a second pricing or identity rule
 * here.
 *
 * ── AND NOT ONE BYTE OF THIS REACHES A MODEL ──
 *
 * The body carries a name, a phone and an address. `aiChat` is not imported
 * and never may be: «ولا مسار بالباب بيبعت نص لأي موديل ذكاء».
 */

/**
 * A DECIMAL STRING AS THE CONTRACT SENDS MONEY — «"15.00"».
 *
 * A string and not `z.coerce.number()`: `a-column-has-one-rule.test.ts`
 * refuses coercion on anything money-shaped, for the measured reason that
 * `z.coerce.number()` turns `''`, `'  '`, `null` and `[]` into `0` and
 * writes it. This refuses anything that is not written like a decimal, and
 * the conversion happens once, below, on a value already proved to be one.
 */
const decimalString = z
  .string()
  .trim()
  .regex(/^\d{1,9}(?:\.\d{1,3})?$/, 'an amount is a decimal string like "15.00"');

/** `Number()` on text already proved to be a bounded decimal literal. */
function fromDecimalString(text: string): number {
  return Number(text);
}

/** ISO 8601, with or without an offset. Absent is absent, never «now». */
const isoMoment = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'not an ISO 8601 moment');

/**
 * THE BODY, AND NOTHING OUTSIDE IT IS READ.
 *
 * There is no `companyId` and there never may be: the company comes from
 * the token (`requireSystemToken`). There is no `store_id` either — the
 * store is derived from the PRODUCTS, which is how `createPublicOrder`
 * derives it from the page: the server decides whose shop this is.
 *
 * The quantity bound is the one `POST /api/orders` uses — `count(999, 1)` —
 * on purpose. Two order doors with two ceilings is the drift
 * `a-column-has-one-rule.test.ts` pins between the existing pair. There is
 * no price bound to match, because no price sent here is ever written.
 */
export const v1OrderSchema = z.object({
  external_ref: z.string().trim().max(120).optional().nullable(),
  source: z.string().trim().max(60).optional().nullable(),
  channel: z.string().trim().max(40).optional().nullable(),
  customer: z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(7).max(20),
    city: z.string().trim().max(60).optional().nullable(),
    address: z.string().trim().max(200).optional().nullable(),
  }),
  items: z
    .array(
      z.object({
        product_code: z.string().trim().min(1).max(64),
        /** The caller's own name for it. Recorded nowhere: ours is the name. */
        name: z.string().trim().max(200).optional().nullable(),
        quantity: count(999, 1),
        unit_price: decimalString.optional().nullable(),
        line_total: decimalString.optional().nullable(),
      })
    )
    .min(1)
    .max(20),
  totals: z
    .object({
      subtotal: decimalString.optional().nullable(),
      discount: decimalString.optional().nullable(),
      delivery_fee: decimalString.optional().nullable(),
      total: decimalString.optional().nullable(),
      currency: z.string().trim().max(8).optional().nullable(),
    })
    .optional()
    .nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  attribution: z
    .object({
      method: z.string().trim().max(20).optional().nullable(),
      ad_id: z.string().trim().max(120).optional().nullable(),
      ad_source_type: z.string().trim().max(20).optional().nullable(),
      ctwa_clid: z.string().trim().max(200).optional().nullable(),
      ref_code: z.string().trim().max(40).optional().nullable(),
      ref_code_at: isoMoment.optional().nullable(),
      touch_at: isoMoment.optional().nullable(),
      page_id: z.string().trim().max(64).optional().nullable(),
      psid: z.string().trim().max(120).optional().nullable(),
      waba_id: z.string().trim().max(64).optional().nullable(),
      conversation_ref: z.string().trim().max(120).optional().nullable(),
    })
    .optional()
    .nullable(),
});

export type V1OrderInput = z.infer<typeof v1OrderSchema>;

export interface V1OrderResult {
  orderId: string;
  orderNumber: string;
  status: string;
  /** True when our catalogue priced this differently from what was sent. */
  priceAdjusted: boolean;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number };
  currency: string;
  minorUnit: number;
}

/** One line, priced by this system's catalogue and by nothing the caller sent. */
interface PricedLine {
  productId: string;
  productName: string;
  productImage: string | null;
  quantity: number;
  freeQuantity: number;
  unitPrice: number;
  offer: OfferView | null;
  offerDiscount: number;
}

/**
 * WHAT A LINE COSTS — ours, always.
 *
 * «السعر: الـ OMS بيعيد الحساب من كتالوجه؛ اختلاف عن `totals` = يقبل بسعره
 * … ما بيثق بأرقام نظام تاني.» So `unit_price` and `line_total` in the body
 * are read for ONE purpose: to answer whether they agreed, which comes back
 * as `price_adjusted`. They are never written.
 *
 * AN ADVERTISED BUNDLE IS STILL HONOURED. `GET /api/v1/products` publishes
 * this product's live offers — «حبتين بـ 25» — so the calling system quotes
 * from them. Charging `basePrice × 2` for a two-piece bundle it had just
 * read off our own endpoint would break a promise at the door, which is the
 * defect `public-order.ts` documents at length under
 * `anyLineIncludesDelivery`. So when an active offer's quantity is EXACTLY
 * the quantity asked for, that offer is the price — the same figures
 * `resolvePublicLines` reads, through the same `activeOffersFor`.
 *
 * Matching on an exact quantity and not «the best offer under it» is
 * deliberate: a cheaper combination is a pricing POLICY and the owner's to
 * make, and inventing one here would quietly undercut the seller's own
 * advertised prices.
 */
async function priceLines(
  companyId: string,
  minorUnit: number,
  products: Map<string, { id: string; name: string; image: string | null; basePrice: number }>,
  wanted: { code: string; quantity: number }[]
): Promise<PricedLine[]> {
  const lines: PricedLine[] = [];
  for (const want of wanted) {
    const product = products.get(want.code)!;
    const offers = await activeOffersFor(db, companyId, product.id, minorUnit);
    const offer = offers.find((o) => o.quantity === want.quantity) ?? null;

    // The same two readings `resolvePublicLines` takes: the price BEFORE the
    // bundle's own reduction goes to `computeCod`, and the reduction is
    // passed separately so it lands in `OrderItem.discountShare` — the
    // figure a partial return refunds against.
    const listTotal = offer ? (offer.listPrice ?? offer.price) : product.basePrice;
    lines.push({
      productId: product.id,
      productName: product.name,
      productImage: product.image,
      quantity: offer ? offer.quantity : want.quantity,
      freeQuantity: offer ? offer.freeQuantity : 0,
      unitPrice: offer ? listTotal / offer.quantity : product.basePrice,
      offer,
      offerDiscount: offer ? Math.max(0, listTotal - offer.price) : 0,
    });
  }
  return lines;
}

/**
 * The basket's discount — once per OFFER, never once per line.
 *
 * The same rule and the same reason as `basketDiscount` in
 * `public-order.ts`: without the de-duplication a caller could split one
 * bundle across two lines and claim its reduction twice.
 */
function offersDiscount(lines: PricedLine[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const line of lines) {
    const id = line.offer?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    total += line.offerDiscount;
  }
  return total;
}

/**
 * A CLICK ID OR A CHAT ACCOUNT, SEALED BEFORE IT IS STORED.
 *
 * `encryptSecret` throws when no key is configured, and an ad click id is
 * not worth refusing a customer's order over. So a missing key drops the
 * value rather than losing the order — and it is dropped, never written in
 * the clear, because a column named `…Enc` holding plaintext is worse than
 * an empty one: every reader afterwards believes it is sealed.
 */
function sealed(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!encryptionAvailable()) {
    console.error('the systems door: APP_ENCRYPTION_KEY is not set — an attribution id was dropped, not stored');
    return null;
  }
  try {
    return encryptSecret(value);
  } catch {
    return null;
  }
}

/**
 * CREATE THE ORDER. One transaction, and the same shape as the door next
 * door: the order, its lines, the customer's counters and the activity row
 * are one fact, and `orderRefFields` retries on a P2002 so two systems
 * racing for one number do not hand a failure to a customer.
 */
export async function createSystemOrder(
  caller: SystemCaller,
  input: V1OrderInput
): Promise<V1OrderResult> {
  const { companyId } = caller;

  /*
   * ── THE STORE AND THE COUNTRY, DERIVED FROM THE CATALOGUE ──
   *
   * There is no session, so there is no selected store. The products say
   * which shop this is — exactly as the landing page says it in
   * `createPublicOrder` — and a code that is not in this company's real
   * catalogue simply is not found, so another company's SKU cannot be
   * priced. `realStoresOnly()` keeps a TEST BENCH out: a bench's figures
   * «أرقامٌ لا تدخل أيَّ حسبة», and an outside system selling from one
   * would put real orders on it.
   */
  const codes = [...new Set(input.items.map((i) => i.product_code))];
  const rows = await db.product.findMany({
    where: { companyId, sku: { in: codes }, status: 'ACTIVE', ...realStoresOnly() },
    select: {
      id: true,
      name: true,
      image: true,
      basePrice: true,
      sku: true,
      storeId: true,
      store: {
        select: {
          id: true,
          countryId: true,
          country: {
            select: {
              id: true,
              code: true,
              currencyCode: true,
              minorUnit: true,
              orderPrefix: true,
              timezone: true,
            },
          },
        },
      },
    },
  });

  const missing = codes.filter((c) => !rows.some((r) => r.sku === c));
  if (missing.length > 0) {
    throw new V1Fault(422, V1_CODE.PRODUCT_UNKNOWN, 'One or more product_code values are not on sale', {
      product_codes: missing,
    });
  }

  const stores = new Set(rows.map((r) => r.storeId));
  if (stores.size > 1) {
    throw new V1Fault(
      422,
      V1_CODE.ITEMS_SPAN_STORES,
      'All items in one order must belong to one store'
    );
  }
  const store = rows[0].store;
  if (!store?.country) {
    throw new V1Fault(422, V1_CODE.PRODUCT_UNKNOWN, 'This product is not placed in a store yet');
  }
  const country = store.country;

  // ─── The phone, against THIS country's rule ───
  // The same rule the landing page and the manual door apply. Without it the
  // door accepts seven characters, and nothing refuses the number until
  // somebody tries to call it.
  if (!isValidPhoneFor(country.code, input.customer.phone)) {
    throw new V1Fault(422, V1_CODE.INVALID_PHONE, phoneErrorFor(country.code), { field: 'customer.phone' });
  }

  /*
   * ── THE BLACKLIST, BEFORE ANYTHING IS WRITTEN ──
   *
   * Company-wide and checked on the RAW phone as sent, which is what
   * `activeBlock` canonicalises — normalising first would drop the leading
   * `+` that marks an international form, and that is the exact way round a
   * block. The contract's own code: «زبون محظور = 422 CUSTOMER_BLACKLISTED».
   *
   * The reason is NOT sent. A seller on a screen is told why, because they
   * decide whether to release it; a program on the other side of a webhook
   * is not, and a reason travelling into another system's log is a reason
   * nobody here decided to publish.
   */
  const block = await activeBlock(db, companyId, input.customer.phone);
  if (block) {
    throw new V1Fault(422, V1_CODE.CUSTOMER_BLACKLISTED, 'This phone may not place an order');
  }

  const normalizedPhone = normalizePhoneNumber(input.customer.phone, country.code);
  const customer = await findOrCreateCustomer(db, {
    companyId,
    storeId: store.id,
    phone: normalizedPhone,
    rawPhone: input.customer.phone,
    fullName: input.customer.name,
    address: input.customer.address?.trim() || '',
    city: input.customer.city?.trim() || '',
  });

  // The governorate the other system wrote, bound to a real Region — the
  // delivery fee table is keyed on it, so an order without one cannot be
  // priced or shipped.
  const regionId = await resolveRegionId(db, country.id, input.customer.city ?? customer.city);

  const bySku = new Map(
    rows.map((r) => [r.sku, { id: r.id, name: r.name, image: r.image, basePrice: r.basePrice }])
  );
  const lines = await priceLines(
    companyId,
    country.minorUnit,
    bySku,
    input.items.map((i) => ({ code: i.product_code, quantity: i.quantity }))
  );

  /*
   * THE FEE IS NOT THE CALLER'S TO SET, AND NOT THIS DOOR'S TO GUESS.
   *
   * `totals.delivery_fee` arrives and is not written. A fee belongs to a
   * COURIER in a REGION (`resolveDeliveryFee`), and no courier is chosen
   * until a shipment is built — which is why both of the other doors that
   * take an order from outside this building write `shippingCost: 0` and let
   * shipment creation put the real figure on. Accepting another system's
   * number here would be money arithmetic taken from a client.
   */
  const shippingCost = 0;
  const priceIncludesDelivery = await priceIncludesDeliveryFor(
    store.id,
    lines.some((l) => l.offer?.deliveryIncluded === true) ? true : undefined
  );

  // ONE COD function, used by every screen and service (contract PART 5).
  const cod = computeCod({
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      freeQuantity: l.freeQuantity,
    })),
    discount: offersDiscount(lines),
    deliveryFee: shippingCost,
    priceIncludesDelivery,
    minorUnit: country.minorUnit,
  });

  /*
   * DID OUR CATALOGUE AGREE WITH WHAT THEY QUOTED?
   *
   * Compared on the GOODS, not on the total: the total they sent includes a
   * delivery fee this door does not accept, so comparing totals would report
   * every single order as adjusted and the flag would mean nothing. The
   * subtotal is the part both systems are talking about.
   *
   * No `totals` sent at all is not a disagreement — it is a caller that did
   * not claim a price, and there is nothing to adjust.
   */
  const quoted = input.totals?.subtotal ? fromDecimalString(input.totals.subtotal) : null;
  const priceAdjusted =
    quoted !== null && roundMinor(quoted, country.minorUnit) !== cod.subtotal;

  // Cost of goods at the weighted average of the stock on hand — the one
  // helper every other door reads, so two doors never cost one order two
  // ways.
  const costByProduct = await productCosts(db, companyId, [...new Set(lines.map((l) => l.productId))]);
  const costOfGoods = roundMinor(
    lines.reduce(
      (sum, l) => sum + (costByProduct.get(l.productId)?.average ?? 0) * (l.quantity + l.freeQuantity),
      0
    ),
    country.minorUnit
  );

  // The head of the order is its FIRST line — the reading `POST /api/orders`
  // takes, because the calling system sends the lines in the order the
  // customer agreed to them.
  const head = lines[0];
  const attribution = input.attribution ?? null;
  const now = new Date();

  const order = await db.$transaction(async (tx) => {
    let created: Awaited<ReturnType<typeof tx.order.create>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const refs = await orderRefFields(tx, companyId, country.orderPrefix, attempt, now);
        created = await tx.order.create({
          data: {
            companyId,
            countryId: country.id,
            storeId: store.id,
            regionId,
            ...refs,
            customerId: customer.id,
            productId: head.productId,
            offerId: head.offer?.id ?? null,
            quantity: lines.reduce((n, l) => n + l.quantity, 0),
            freeQuantity: head.freeQuantity,
            sellingPrice: cod.subtotal,
            shippingCost,
            totalAmount: cod.cod,
            currency: country.currencyCode,
            priceIncludesDelivery,
            // No staff account took this order, so none is recorded as having
            // done so. `createdById` null is the same answer the public door
            // gives, and inventing a user here would put an employee's name
            // on work they never did.
            createdById: null,
            moderatorId: null,
            assignedToId: null,
            claimedById: null,
            claimedAt: null,
            currentOwnerId: null,
            estimatedCostOfGoods: costOfGoods,
            productNameSnapshot: head.productName,
            productImageSnapshot: head.productImage,
            status: 'NEW',
            confirmationStatus: 'NEW',
            shippingStatus: 'NOT_READY',
            settlementStatus: 'NOT_APPLICABLE',
            signatureStatus: 'UNSIGNED',
            version: 1,
            source: input.source?.trim() || caller.system,
            customerNotes: input.notes?.trim() || null,
            // ── The ad evidence, exactly as reported, written once ──
            externalRef: input.external_ref?.trim() || null,
            externalChannel: input.channel?.trim() || null,
            adId: attribution?.ad_id?.trim() || null,
            adSourceType: attribution?.ad_source_type?.trim() || attribution?.method?.trim() || null,
            ctwaClidEnc: sealed(attribution?.ctwa_clid),
            refCode: attribution?.ref_code?.trim() || null,
            refCodeAt: attribution?.ref_code_at ? new Date(attribution.ref_code_at) : null,
            touchAt: attribution?.touch_at ? new Date(attribution.touch_at) : null,
            pageId: attribution?.page_id?.trim() || null,
            psidEnc: sealed(attribution?.psid),
            wabaId: attribution?.waba_id?.trim() || null,
            conversationRef: attribution?.conversation_ref?.trim() || null,
          },
        });
        break;
      } catch (e: unknown) {
        // Two intakes racing for one order number. The retry asks for the
        // NEXT number, not the same one again.
        if ((e as { code?: string })?.code === 'P2002' && attempt < 4) continue;
        throw e;
      }
    }
    if (!created) throw new Error('Failed to generate a unique order number');

    // The order's lines, in one statement. A lineless order is the one shape
    // this product cannot price — settlement rebuilds the delivered goods
    // from the lines and the reservation lives per line.
    await tx.orderItem.createMany({
      data: lines.map((l, i) => ({
        companyId,
        orderId: created!.id,
        productId: l.productId,
        productName: l.productName,
        quantity: l.quantity,
        freeQuantity: l.freeQuantity,
        unitPrice: l.unitPrice,
        discountShare: cod.discountShares[i] ?? 0,
        lineTotal: cod.lineTotals[i] ?? 0,
        addedStage: 'INTAKE',
      })),
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
        // No user: the caller is a system, and `userId` naming an employee
        // who never saw this order would be a false trail.
        userId: null,
        action: 'ORDER_CREATED',
        newStatus: 'NEW',
        metadata: JSON.stringify({
          source: created.source,
          via: 'api/v1',
          system: caller.system,
          externalRef: input.external_ref ?? null,
          priceAdjusted,
          lines: lines.map((l) => ({
            product: l.productName,
            quantity: l.quantity,
            freeQuantity: l.freeQuantity,
            offer: l.offer?.name ?? null,
            unitPrice: l.unitPrice,
          })),
        }),
      },
    });

    return created;
  });

  await logAudit({
    companyId,
    userId: null,
    action: 'ORDER_CREATED_API_V1',
    entity: 'Order',
    entityId: order.id,
    // The system and its token, never the token's value. `logAudit`
    // redacts any key matching /token/i inside the object anyway, and the
    // id is not the secret.
    newData: { system: caller.system, tokenId: caller.tokenId, orderNumber: order.orderNumber },
  });

  // Same customer, same product, minutes apart: a flag on the history for the person who calls — never a refusal.
  await flagRecentTwins(db, {
    companyId,
    orderId: order.id,
    customerId: customer.id,
    productIds: lines.map((l) => l.productId),
    at: order.createdAt,
    userId: null,
  });

  // The same announcement every other new order makes, through the one
  // function that makes it. Never throws — the order is saved whatever
  // happens here.
  notify({
    companyId,
    storeId: store.id,
    audience: { permission: 'confirmation.supervise' },
    title: 'طلب جديد من نظام الردود',
    message: `وصل طلب جديد #${order.orderNumber} من ${caller.system}.`,
    type: 'ORDER_NEW',
    link: ['/confirmation/queue', '/confirmation/mine', '/orders'],
  });

  /*
   * ── NO `order.created` IS ANNOUNCED FROM HERE, AND THAT IS A STOP ──
   *
   * The specification lists `emitAppEvent('order.created')` among the
   * things this door reuses. It is NOT called, deliberately, and this is
   * the one item of O7's Definition of Done that is deferred rather than
   * met.
   *
   * WHY. `src/lib/apps/events-sites.test.ts` is one of the two guards that
   * hold the PUBLISHED contract System 7 reads, and it enumerates the three
   * places an app event may be announced from — «An event announced from a
   * fourth place is an event nobody wrote the data contract for». A fourth
   * site is a change to the events surface, and AGENTS.md makes «the events
   * contract (src/lib/apps/events.ts · contracts/) or anything System 7
   * reads» a STOP-and-ask, not an agent's call. Widening the guard to pass
   * my own change would be the agent marking its own homework on the one
   * contract the owner singled out.
   *
   * WHAT IS LOST, MEASURED RATHER THAN GUESSED. The caller of this door
   * already has the order: it gets `order_id` and `order_number` in the
   * 201. The three events that describe what happens to the order AFTERWARDS
   * — `order.confirmed`, `order.shipped`, `order.delivered`,
   * `order.returned`, `order.cancelled` — all still fire, from the two state
   * doors, unchanged. The gap is exactly one event, for one order, to any
   * OTHER installed app that listens for `order.created`.
   *
   * THE CHANGE WHEN THE OWNER APPROVES IT is one call with the same keys
   * `createPublicOrder` emits (`total: Number(order.totalAmount)` and
   * `currency` among them — «لا تشيلهم من الأحداث») plus
   * `'lib/v1/order-intake.ts'` in that guard's `ALLOWED`. Recorded in
   * BACKLOG_P2.md under «من المراجعات».
   */

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.confirmationStatus,
    priceAdjusted,
    totals: {
      subtotal: cod.subtotal,
      discount: cod.discount,
      deliveryFee: shippingCost,
      total: cod.cod,
    },
    currency: country.currencyCode,
    minorUnit: country.minorUnit,
  };
}
