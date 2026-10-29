import { NextResponse } from 'next/server';
import { notify } from '@/lib/notify';
import { z } from 'zod';
import { db } from '@/lib/db';
import { activeOffersFor } from '@/lib/offers';
import { requireContext } from '@/lib/geo-context';
import { findOrCreateCustomer } from '@/lib/customer-identity';
import { orderRefFields } from '@/lib/order-ref';
import { resolveRegionId } from '@/lib/regions';
import { computeCod, roundMinor } from '@/lib/money';
import { priceIncludesDeliveryFor } from '@/lib/delivery-fees';
import { giftUnits } from '@/lib/offer-gift';
import { count, money as amount, readTypedFigure } from '@/lib/numeric-input';
import { productCost } from '@/lib/product-cost';
import { parseOrderText, matchProduct, normalizeArabic, ParsedOrder } from '@/lib/order-parser';
import { normalizePhoneNumber } from '@/lib/phone';
import { phoneKeys } from '@/lib/phone-rules';
import { toLatinDigits } from '@/lib/latin-digits';
import { activeBlock } from '@/lib/blacklist';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { requirePermission, can, getPermissionScope } from '@/lib/authorization';
import { entryOwnership, ownedCounts, recordEntryClaim, ENTRY_CAP_FULL_MESSAGE } from '@/lib/confirmation-queue';
import { zodMessage } from '@/lib/zod-message';
import { AiEndpointMissing, AiNotConfigured, AiNotLocal, aiChat, aiSettings } from '@/lib/ai-provider';
import { resolvePrompt } from '@/lib/ai-prompts';
import { projectOrder } from '@/lib/order-projection';

/**
 * POST /api/orders/ai-intake
 * mode 1: { text, dryRun: true }  -> parse text, match product, return preview (no DB writes)
 * mode 2: { parsed, confirm: true } -> create customer + order from confirmed fields
 */

/** Why the model did not read the text, when it did not. */
export type AiSkipped = 'NOT_LOCAL' | 'NOT_CONFIGURED' | 'FAILED' | null;

/**
 * THE OFFER WHOSE BUNDLE IS EXACTLY THIS MANY PIECES.
 *
 * Its price is that quantity's price, and through this door it is the price
 * the order is written at — the owner's ruling, 27/10 (RV151): «سعر العرض
 * هو اللي بيمشي بإدخال الطلب بالذكاء». A figure the customer typed into
 * their message («السعر: 5» beside a bundle of 22) was a SUGGESTION that
 * beat the offer, and one keystroke from the reviewer made it the charge.
 * Only an exact quantity binds: an offer of two is not the price of three.
 */
function offerForQuantity<T extends { quantity: number }>(offers: T[], qty: number): T | null {
  return offers.find((o) => o.quantity === qty) ?? null;
}

/**
 * THE ONE BUNDLE NEAREST THIS QUANTITY — OR NOTHING (RV173).
 *
 * When no bundle is exactly the quantity pasted, the preview may still NAME the closest one, so the reviewer sees what
 * the shop sells near it. It used to take `offers[0]` — the first row in the seller's own sort order, whatever its size:
 * for «٣ قطع» it filled the box with the price of a bundle of ONE. The nearest is read by the pieces, not by the order
 * of the list; two bundles equally near (a 2 and a 4 for a 3) are no answer at all, and it says nothing rather than
 * pick the cheaper one. Several bundles of the same size are one answer: the first, as `offerForQuantity` reads them.
 */
function nearestOfferForQuantity<T extends { quantity: number }>(offers: T[], qty: number): T | null {
  let best: T | null = null;
  let gap = Infinity;
  let tied = false;
  for (const o of offers) {
    const g = Math.abs(o.quantity - qty);
    if (g < gap) {
      best = o;
      gap = g;
      tied = false;
    } else if (g === gap && best && o.quantity !== best.quantity) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * THE SHAPE THE MODEL MUST ANSWER IN, fixed here and not editable.
 *
 * The company's own wording for this assistant is the VOICE
 * (`resolvePrompt('order_intake', …)`); this is the CONTRACT. A seller who
 * rewrites the prompt must not be able to change the keys the parser reads,
 * because the code below indexes them by name and a renamed key arrives as
 * an empty field with no error anywhere.
 */
const INTAKE_SCHEMA = `
Return ONLY a JSON object with exactly these keys:
{"customerName":"","phone":"","governorate":"","address":"","productQuery":"","quantity":1,"price":null,"notes":"","source":""}
Keep the original Arabic text. quantity is a number. price is a number with no currency symbol. source is the page name.
A missing field is "" — except price, which is null, and quantity, which is 1.`;

/**
 * READ THE PASTED ORDER WITH A MODEL — ON THE OWNER'S OWN MACHINE ONLY.
 *
 * This used to `fetch` OpenRouter directly with `OPENROUTER_API_KEY`, on a
 * free model by default, and it sent the pasted text WHOLE: the customer's
 * name, phone and address, to a vendor, on every paste. It also bypassed the
 * AI settings every other assistant in this product obeys — so the
 * `order_intake` assistant and its prompt existed and nothing used them.
 *
 * Now it goes through `aiChat` like the others, with `localOnly: true`. If
 * the company has not pointed `order_intake` at a LOCAL server, `aiChat`
 * throws BEFORE the first byte leaves and the deterministic parser does the
 * work — which is the same answer the seller got on the day the key was
 * missing, and a worse answer than a leak.
 */
async function aiAssistedParse(
  companyId: string,
  text: string
): Promise<{ parsed: ParsedOrder | null; skipped: AiSkipped }> {
  try {
    const settings = await aiSettings(companyId);
    const answer = await aiChat({
      companyId,
      job: 'order_intake',
      system: resolvePrompt('order_intake', settings.prompts) + INTAKE_SCHEMA,
      user: text,
      json: true,
      timeoutMs: 15000,
      localOnly: true,
    });

    // A local model fences its JSON more often than a vendor does.
    const clean = answer.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(clean);
    /*
     * THE NUMBERS COME OUT OF THE MODEL IN WHATEVER DIGITS IT FELT LIKE — and are made Latin HERE, in code.
     *
     * The owner, 22/10: «ارقام الهواتف بالادخال بال ai حولها برمجيا من عربي لانجليزي». A model that was shown «٠٧٩١٢٣٤٥٦٧» answers
     * with «٠٧٩١٢٣٤٥٦٧» as often as not, and `parseInt('٣', 10)` is NaN — so «الكمية: ٣» silently became a quantity of ONE.
     * The phone, the quantity and the price are converted before they are parsed or returned, whatever the model wrote.
     */
    return {
      parsed: {
        customerName: parsed.customerName || '',
        phone: toLatinDigits(String(parsed.phone ?? '')).trim(),
        governorate: parsed.governorate || '',
        address: parsed.address || '',
        productQuery: parsed.productQuery || '',
        quantity: parseInt(toLatinDigits(String(parsed.quantity ?? '')), 10) || 1,
        // The house reader: Arabic-Indic digits are read, and anything that is not written the way a number is written is NO price
        // (`Number('')` was a price of zero, and `Number('0x10')` was sixteen).
        price: parsed.price != null ? readTypedFigure(parsed.price) : null,
        notes: parsed.notes || '',
        source: parsed.source || '',
      },
      skipped: null,
    };
  } catch (e) {
    if (e instanceof AiNotLocal) return { parsed: null, skipped: 'NOT_LOCAL' };
    if (e instanceof AiNotConfigured || e instanceof AiEndpointMissing) {
      return { parsed: null, skipped: 'NOT_CONFIGURED' };
    }
    // The kind of failure, never its message: a JSON error quotes the start of
    // what it could not read, and that is the model's reading of a pasted
    // message — a customer's name, phone and address, written to a server log.
    console.warn('AI parse failed, using deterministic parser:', e instanceof Error ? e.name : 'unknown');
    return { parsed: null, skipped: 'FAILED' };
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, countryId, country } = await requireContext();
    await requirePermission('orders.create');

    const body = await req.json();

    // ─── Mode 2: Confirm & Create ───
    if (body.confirm) {
      // Server-side Zod validation — the client-confirmed payload is never
      // trusted with raw values (same rules as POST /api/orders).
      const confirmSchema = z.object({
        customerName: z.string().trim().min(2).max(80),
        phone: z.string().trim().min(7).max(20),
        address: z.string().trim().max(200).optional().nullable(),
        governorate: z.string().trim().max(60).optional().nullable(),
        productId: z.string().min(10).max(64),
        /**
         * THE SAME READER AND THE SAME BOUNDS AS `POST /api/orders`.
         *
         * These two were `z.coerce.number()`, which is `Number(value)`, and
         * the text above this schema says «the client-confirmed payload is
         * never trusted with raw values (same rules as POST /api/orders)» —
         * which was not true of the notation. `count(999, 1)` and
         * `amount(100000)` ARE the create door's rules, imported rather
         * than described, so `'0x10'` is a 400 here as it is there instead
         * of sixteen units or sixteen dinars.
         *
         * The bounds are unchanged; only what counts as a number is.
         */
        quantity: count(999, 1),
        finalPrice: amount(100000),
        /**
         * What the customer's message named, when it differed from the offer — kept in the order's history, never charged.
         * A RECORD, SO IT NEVER REFUSES AN ORDER: a figure out of range is dropped, not a 400 about a box the reviewer cannot edit.
         */
        typedPrice: amount(100000).optional().nullable().catch(null),
        moderatorId: z.string().min(10).max(64).optional().nullable(),
        notes: z.string().trim().max(500).optional().nullable(),
        source: z.string().trim().max(40).optional().nullable(),
      });
      const check = confirmSchema.safeParse(body.parsed);
      if (!check.success) {
        return NextResponse.json(
          { error: zodMessage(check.error) },
          { status: 400 }
        );
      }
      const p = check.data;

      if (!p.customerName || !p.phone || !p.productId) {
        return NextResponse.json(
          { error: 'الاسم والرقم والمنتج مطلوبة' },
          { status: 400 }
        );
      }

      // What the reviewer's box held may still be Arabic-Indic digits (they can type them): stored and checked as Latin.
      const phone = toLatinDigits(p.phone);
      const normalizedPhone = normalizePhoneNumber(phone, country.code);

      // Blacklist, company-wide. Staff get the real reason.
      const block = await activeBlock(db, companyId, phone);
      if (block) {
        return NextResponse.json(
          { error: `هذا الرقم محظور: ${block.reason}`, code: 'CUSTOMER_BLOCKED', blockId: block.id },
          { status: 409 }
        );
      }

      /*
       * THE OFFER'S PRICE, AT THE WRITE AND NOT ONLY IN THE PREVIEW.
       *
       * The preview fills the box with the offer's price and locks it; this
       * is the same rule where the money is written, so a box edited around
       * the lock, a product changed after the parse, or a hand-made payload
       * cannot record a bundle at a price it does not have. Refused rather
       * than corrected: the button the reviewer pressed named a figure, and
       * an order saved at a different one is a number nobody confirmed. The
       * answer carries the offer's price so the screen can put it in the box.
       *
       * BEFORE THE CUSTOMER IS WRITTEN: a refused confirmation must leave no
       * customer row behind it. `activeOffersFor` reads this company's offers
       * only, so a product id from another company finds none here and is
       * refused by name below.
       */
      const quantityOffer = offerForQuantity(
        await activeOffersFor(db, companyId, p.productId, country.minorUnit),
        p.quantity,
      );
      if (quantityOffer && roundMinor(p.finalPrice, country.minorUnit) !== roundMinor(quantityOffer.price, country.minorUnit)) {
        return NextResponse.json(
          {
            error: `سعر العرض «${quantityOffer.name}» لهذه الكمية ${quantityOffer.price} — الطلب بالذكاء يُسجَّل بسعر العرض`,
            code: 'OFFER_PRICE',
            offerPrice: quantityOffer.price,
            offerName: quantityOffer.name,
          },
          { status: 409 },
        );
      }

      // The same identity rule every other door uses.
      const customer = await findOrCreateCustomer(db, {
        companyId,
        storeId,
        phone: normalizedPhone,
        rawPhone: phone,
        fullName: p.customerName.trim(),
        address: p.address?.trim() || '',
        city: p.governorate?.trim() || '',
      });

      // Tenant-validate — products must belong to THIS company
      const product = await db.product.findFirst({
        where: { id: p.productId, companyId },
        include: { batches: { where: { quantityRemaining: { gt: 0 } }, orderBy: { productionDate: 'asc' }, take: 1 } },
      });
      if (!product) {
        return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
      }

      const qty = p.quantity;
      /**
       * WHAT THE REVIEWER CONFIRMED, INCLUDING A ZERO.
       *
       * This was `p.finalPrice || product.basePrice`, under a comment
       * claiming it matched `POST /orders`. It did not: that door writes
       * `sellingPrice ?? 0` and stores the zero. And `offers.ts` names this
       * very expression as the one door out of four that disagrees —
       *
       *   landing-page order (createPublicOrder)   0
       *   cart quote                               0
       *   AI intake's suggestion                   0
       *   AI intake's WRITE                       99   ← here
       *
       * — and rules, in writing, that «a price of 0 included: a free bundle
       * is a pricing decision», refusing to reinterpret one.
       *
       * ABSENT IS ALREADY REFUSED and that is what makes the fallback
       * unreachable as a safety net: `finalPrice: amount(100000)` is a
       * REQUIRED field, so a payload without it gets a 400 naming the
       * field. The only value `||` could ever catch is a zero somebody
       * typed on purpose — and turning that into 99 is money this route
       * invented, on an order a person had just confirmed.
       */
      const price = p.finalPrice;
      /**
       * THE SAME ESTIMATE THE OTHER ORDER DOORS MAKE.
       *
       * This took the oldest batch still holding units — a defensible policy
       * on its own, and a different one from `POST /orders`, which averages
       * the stock on hand. Two doors creating the same kind of order and
       * costing it two ways is exactly the drift `product-cost.ts` was
       * written to end; its own comment says a product does not have «a»
       * cost, and that the blend is a choice that shows up in the profit.
       * So the choice is made in one place and read here.
       */
      const unitCost = (await productCost(db, companyId, product.id)).average;
      /*
       * THE GIFT THIS ORDER CARRIES — the bundle bound above, through the one rule.
       *
       * `giftUnits` is the manual door's own function (`POST /orders`), so «3 + 1» typed by hand and «3 + 1» pasted
       * here are the same four units. It is one gift per BUNDLE: this door binds an offer only when the quantity is
       * exactly the bundle's (`offerForQuantity`), so the gift is the offer's `freeQuantity`, once — never × the
       * pieces. No bound offer is no gift: an order at the reviewer's own figure promised the customer nothing.
       */
      const gift = giftUnits(quantityOffer, qty);

      // Moderator assignment — must belong to THIS company (same rule as POST /orders)
      const assignedModeratorId = p.moderatorId || (user.role === 'MODERATOR' ? user.id : null);

      /*
       * WHOSE ORDER IS THIS — the same rule the quick-entry door asks, in
       * the same words. A seller who pastes a message into the extractor is
       * entering an order exactly as much as one who types it into the form.
       */
      const keepsIt = can(user, 'confirmation.work') && !can(user, 'confirmation.supervise');
      const entry = entryOwnership({
        userId: user.id,
        holds: (perm) => can(user, perm as Parameters<typeof can>[1]),
        heldTotal: keepsIt ? (await ownedCounts(db, { companyId, storeId }, user.id)).total : 0,
        now: new Date(),
      });
      if (assignedModeratorId) {
        const mod = await db.user.findFirst({ where: { id: assignedModeratorId, companyId } });
        if (!mod) {
          return NextResponse.json({ error: 'الموديريتور غير موجود في شركتك' }, { status: 404 });
        }
      }
      // Commission is the ledger's and accrues on delivery — see POST /orders.
      /**
       * ONE COD function (contract PART 5); no delivery fee at intake.
       *
       * NO `discount`, AND THAT IS NOT THE PREVIEW'S DEFECT REPEATED. The
       * bundle bound above (RV172) gives this order its `offerId`, its gift
       * and its delivery policy — but NOT its reduction: `price` is the
       * reviewer's confirmed total, and for a bound bundle that total is
       * already the offer's NET figure (the write refuses any other). The
       * reduction is inside it; there is no `discount` left to pass.
       *
       * And passing the chosen offer's discount here would now subtract it
       * TWICE: the preview already hands the reviewer the net figure (25
       * with a discount of 3 is suggested as 22), the modal copies that into
       * `finalPrice`, so a second reduction here would charge 19 for an
       * offer that promises 22. The reviewer's number is final by design —
       * they may edit it, and a door that re-reduced an edited figure would
       * be arguing with the person who typed it.
       *
       * Hence this file's `NO_OFFER_BOUND` entry in
       * `quote/quote-discount.test.ts` stands, with the reason restated
       * there now that the preview does pass a discount of its own.
       */
      const money = computeCod({
        lines: [{ quantity: qty, unitPrice: qty > 0 ? price / qty : price }],
        minorUnit: country.minorUnit,
      });

      // Bind the governorate written in the message to a real Region: the
      // delivery fee is keyed on it, so an order without one cannot be priced
      // or shipped.
      const resolvedRegionId = await resolveRegionId(db, countryId, p.governorate ?? customer.city);

      /**
       * ONE TRANSACTION, BECAUSE THESE FOUR WRITES ARE ONE FACT.
       *
       * They were four separate statements. A failure between the first and
       * the second left an order with NO LINES — and a lineless order is
       * the one shape the whole product cannot price: `computeCod` has
       * nothing to total, settlement reconstructs the delivered goods from
       * the lines, and the reservation lives per line, so nothing was ever
       * taken off a shelf for it either. It was the last door in this
       * repository that could still produce one. Measured today: 0 of 56
       * live orders are lineless, so this closes the way in rather than
       * cleaning up after it.
       *
       * The other two matter less and are still the same fact: a customer
       * whose `totalOrders` counts an order that failed to save, and an
       * order whose activity trail says it was created when it was not.
       *
       * AND THE ORDER NUMBER NOW RETRIES, like the door next door. It was
       * `orderRefFields(db, companyId, prefix)` with no attempt argument —
       * so two intakes in the same second raced for one number and the
       * loser got a P2002 in the face of the person who pasted the order.
       * `nextOrderNumber` takes an attempt precisely so the retry asks for
       * the NEXT one instead of the same one again.
       *
       * The audit row and the notification stay OUTSIDE: one must not be
       * rolled back if it succeeds while something after it fails, and the
       * other talks to the world. `POST /orders` draws the line in the same
       * place.
       */
      const now = new Date();
      const order = await db.$transaction(async (tx) => {
        let created: Awaited<ReturnType<typeof tx.order.create>> | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const refs = await orderRefFields(tx, companyId, country.orderPrefix, attempt, now);
            created = await tx.order.create({
              data: {
                companyId,
                countryId,
                storeId,
                regionId: resolvedRegionId,
                ...refs,
                customerId: customer.id,
                productId: product.id,
                /*
                 * ── THE STORE'S PRICING POLICY, WHICH THIS DOOR NEVER
                 *    ASKED ABOUT ──
                 *
                 * Every other intake asks `priceIncludesDeliveryFor`.
                 * This one wrote nothing, so the column took its schema
                 * default of `false` — and a shop whose prices are
                 * advertised delivery-inclusive had the fee ADDED again
                 * at shipment, on every order pasted in through here. The
                 * customer is then asked for more than the page promised,
                 * and the courier statement disagrees with the order by
                 * exactly the fee.
                 *
                 * AND A BUNDLE THAT CARRIES DELIVERY TURNS IT ON, as at
                 * `POST /orders` (RV172): the offer's `deliveryIncluded`
                 * can only switch it ON, never off. With no bundle bound
                 * the store's own policy is the whole of the answer.
                 */
                priceIncludesDelivery: await priceIncludesDeliveryFor(storeId, quantityOffer?.deliveryIncluded),
                // Which bundle sold this: `null` when the quantity matched none and the reviewer's own figure stood.
                offerId: quantityOffer?.id ?? null,
                quantity: qty,
                sellingPrice: price,
                shippingCost: 0,
                totalAmount: money.cod,
                currency: country.currencyCode,
                moderatorId: assignedModeratorId,
                // Who pasted it in — whatever their role.
                createdById: user.id,
                claimedById: entry.claimedById,
                claimedAt: entry.claimedAt,
                currentOwnerId: entry.currentOwnerId,
                // Rounded by the currency, like the total beside it. The gift is a unit off the shelf like any other: it costs.
                estimatedCostOfGoods: roundMinor(unitCost * (qty + gift), country.minorUnit),
                productNameSnapshot: product.name,
                productImageSnapshot: product.image || null,
                status: 'NEW',
                source: p.source?.trim() || 'AI Intake',
                customerNotes: p.notes?.trim() && p.notes !== '-' ? p.notes.trim() : null,
              },
            });
            break;
          } catch (e: unknown) {
            // Two intakes racing for one order number. Retry asks for the
            // next number, not the same one.
            if ((e as { code?: string })?.code === 'P2002' && attempt < 4) continue;
            throw e;
          }
        }
        if (!created) throw new Error('Failed to generate a unique order number');

        // The claim her entry created, recorded by the one writer both
        // doors use — inside this transaction, like the order itself.
        await recordEntryClaim(tx, { companyId, orderId: created.id, ownership: entry });

        // The order's line. Reservation and the discount share live per line.
        await tx.orderItem.create({
          data: {
            companyId,
            orderId: created.id,
            productId: product.id,
            productName: product.name,
            quantity: qty,
            // Real stock at zero price: the reservation, the delivery deduction and the return all read `quantity + freeQuantity`.
            freeQuantity: gift,
            unitPrice: money.subtotal / qty,
            lineTotal: money.lineTotals[0] ?? money.subtotal,
            addedById: user.id,
            addedStage: 'INTAKE',
          },
        });

        await tx.customer.update({
          where: { id: customer.id },
          data: {
            totalOrders: { increment: 1 },
            lastOrderDate: new Date(),
            firstOrderDate: customer.firstOrderDate || new Date(),
          },
        });

        await tx.orderActivity.create({
          data: {
            companyId,
            orderId: created.id,
            userId: user.id,
            action: 'ORDER_CREATED',
            newStatus: 'NEW',
            metadata: JSON.stringify({
              source: created.source,
              intakeMethod: 'AI_PASTE',
              createdBy: user.name,
              // The figure the customer's message named, when the offer's price was written instead (RV151).
              // Here and not in `customerNotes`: those print on the courier's waybill, beside the amount to collect.
              ...(p.typedPrice != null ? { customerTypedPrice: p.typedPrice } : {}),
            }),
          },
        });

        /**
         * AND NO OPENING ROW IN THE STATE HISTORY, WHICH IS A RULE AND NOT
         * AN OVERSIGHT — IT WAS WRITTEN HERE AND THEN TAKEN BACK OUT.
         *
         * `POST /orders` writes `orderStatusLog` with `previousValue: null`
         * when it creates an order, and this door does not, so two doors
         * create the same kind of order and only one says so in the log the
         * confirmation workflow is measured from. That looked like an
         * inconsistency worth closing.
         *
         * It is not. `ai-proposal-only.test.ts` holds `orderStatusLog` in
         * its NEVER set — «ممنوع على أيّ ملفٍ يسأل نموذجاً، بلا استثناء» —
         * and this file asks a language model in its other mode. The rule
         * is that the file which talks to a model is not the file that
         * writes an order's state history, and a hard stop with no
         * exception is not a hard stop that takes one for tidiness. The
         * guard refused the write the moment it was added, which is the
         * guard doing its job on me.
         *
         * WHAT IS LOST IS LESS THAN IT SOUNDS: `orderActivity` above
         * records the creation with its actor and its metadata, and MEASURED
         * TODAY no reader of `orderStatusLog` looks for an opening row —
         * every one of them looks for a named TRANSITION. The landing-page
         * door cannot write one either, for a different reason
         * (`changedById` is NOT NULL and its visitor is anonymous), which
         * is why 23 of the 56 live orders have no status-log row at all.
         */

        return created;
      });

      await logAudit({
        companyId,
        userId: user.id,
        action: 'ORDER_CREATED_AI_INTAKE',
        entity: 'Order',
        entityId: order.id,
        newData: order,
      });

      // Same audience as every other new order: this store's confirmation
      // supervisors, without the person who pasted it. Never throws.
      notify({
        companyId,
        storeId,
        audience: { permission: 'confirmation.supervise' },
        actorId: user.id,
        title: 'طلب جديد',
        message: `تم إنشاء طلب جديد #${order.orderNumber} عبر الذكاء الاصطناعي بواسطة ${user.name}.`,
        type: 'ORDER_NEW',
        link: ['/confirmation/queue', '/orders'],
      });

      // And the same notice the quick door returns: an entry the cap
      // pushed into the queue is not hers, and silence would let her
      // believe it was.
      return NextResponse.json({
        success: true,
        // The created row, as this person may read it: no cost of goods to a
        // reader without «عرض المالية» (order-projection.ts).
        order: projectOrder(order, user),
        ...(entry.capFull ? { notice: ENTRY_CAP_FULL_MESSAGE } : {}),
      });
    }

    // ─── Mode 1: Parse & Preview ───
    const text: string = body.text || '';
    if (!text.trim()) {
      return NextResponse.json({ error: 'الصق نص الطلب أولاً' }, { status: 400 });
    }

    // Try AI first, fallback to deterministic parser
    const attempt = await aiAssistedParse(companyId, text);
    const aiSkipped = attempt.skipped;
    let parsed = attempt.parsed;
    let engine = 'ai';
    if (!parsed) {
      parsed = parseOrderText(text);
      engine = 'deterministic';
    }
    // Deterministic parser always re-checks to fill any AI gaps
    const deterministic = parseOrderText(text);
    if (engine === 'ai') {
      for (const key of Object.keys(deterministic) as Array<keyof ParsedOrder>) {
        const dv = deterministic[key];
        const av = parsed[key];
        if (
          (typeof dv === 'string' && !av && dv) ||
          (key === 'price' && (av === null || av === undefined) && dv !== null)
        ) {
          (parsed[key] as unknown) = dv;
        }
      }
    }

    // Match product from catalog
    const products = await db.product.findMany({
      where: { companyId },
      select: { id: true, name: true, sku: true },
    });
    const match = parsed.productQuery
      ? matchProduct(parsed.productQuery, products)
      : null;

    // Suggest price from matched product's offers
    let suggestedPrice: number | null = parsed.price;
    let suggestedOfferName: string | null = null;
    /** True when the box holds the offer's price for exactly this quantity — the screen locks it. */
    let priceFromOffer = false;
    /** What the customer's message named, when the offer's price was put in its place. */
    let typedPrice: number | null = null;
    /** The matched product's bundles, so the screen re-prices when the reviewer changes the quantity. */
    let offerPrices: { quantity: number; price: number; name: string }[] = [];
    if (match) {
      const offers = await activeOffersFor(db, companyId, match.id, country.minorUnit);
      offerPrices = offers.map((o) => ({ quantity: o.quantity, price: o.price, name: o.name }));
      const exact = offerForQuantity(offers, parsed.quantity || 1);
      const qtyOffer = exact || nearestOfferForQuantity(offers, parsed.quantity || 1);
      if (exact) {
        // The offer's price, whatever the message said (RV151). A different figure the customer
        // typed is returned beside it, said on the screen and kept in the order's history.
        suggestedPrice = exact.price;
        suggestedOfferName = exact.name;
        priceFromOffer = true;
        if (
          parsed.price !== null &&
          parsed.price > 0 &&
          // the confirm door's own bound on a price: a figure past it is not a price anybody could record
          parsed.price <= 100000 &&
          roundMinor(parsed.price, country.minorUnit) !== roundMinor(exact.price, country.minorUnit)
        ) {
          typedPrice = parsed.price;
        }
      } else if (qtyOffer && (parsed.price === null || parsed.price <= 0)) {
        /*
         * WHAT THE OFFER PROMISES, AND NOW THAT IS WHAT THE VIEW SAYS.
         *
         * A second read of the offer table and a `computeCod` of its own
         * stood here, because `OfferView.price` used to be `sellingPrice` —
         * the figure BEFORE the bundle's own discount — while every door
         * charged the figure after it. Showing the reviewer 25 for a bundle
         * that charges 22 is not harmless: the modal copies this straight
         * into `finalPrice`, and their confirmation is what turns the wrong
         * number into a charge. They cannot catch an error never shown them.
         *
         * `activeOffersFor` now applies the reduction once, through
         * `allocateDiscount`, so `price` IS the charged total and a second
         * subtraction here would charge 19 for a bundle promising 22. The
         * suggestion is simply what the customer would pay.
         */
        suggestedPrice = qtyOffer.price;
        suggestedOfferName = qtyOffer.name;
      } else if (qtyOffer) {
        suggestedOfferName = qtyOffer.name;
      }
    }

    // Duplicate customer check
    //
    // WHAT THE PREVIEW SAYS ABOUT A KNOWN NUMBER — by the reader's own
    // customers key, as the customers list would answer the same number.
    // It answered «name, city, N orders» to anyone allowed to create an
    // order, so pasting number after number made this door an address book
    // for a person the owner had denied «عرض العملاء».
    //   full key, all customers → name, city, count
    //   full key, OWN           → the same, if they brought this customer in
    //   basic key               → name and city, no count
    //   otherwise               → only that the number is known
    let existingCustomer: { fullName?: string; totalOrders?: number; city?: string; exists: true } | null = null;
    if (parsed.phone) {
      const normalizedPhone = normalizePhoneNumber(parsed.phone, country.code);
      // This store's customer. Telling an agent "3 previous orders" from
      // another store's history is a fact about somebody else's shop.
      const found = await db.customer.findFirst({
        where: { companyId, storeId, phone: { in: phoneKeys(normalizedPhone) } },
        select: { id: true, fullName: true, totalOrders: true, city: true },
      });
      if (found) {
        const book = getPermissionScope(user, 'customers.view');
        const own =
          book?.scope === 'OWN' &&
          !!(await db.order.findFirst({ where: { companyId, customerId: found.id, moderatorId: user.id }, select: { id: true } }));
        if (book && (book.scope !== 'OWN' || own)) {
          existingCustomer = { exists: true, fullName: found.fullName, city: found.city, totalOrders: found.totalOrders };
        } else if (can(user, 'customers.view_basic')) {
          existingCustomer = { exists: true, fullName: found.fullName, city: found.city };
        } else {
          existingCustomer = { exists: true };
        }
      }
    }

    return NextResponse.json({
      parsed,
      engine,
      aiSkipped,
      matchedProduct: match,
      productMatchConfident: match ? match.score >= 16 : false,
      suggestedPrice,
      suggestedOfferName,
      priceFromOffer,
      typedPrice,
      offerPrices,
      existingCustomer,
    });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
