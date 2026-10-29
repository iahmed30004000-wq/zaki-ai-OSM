import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import {
  isValidSettlementTransition,
  computeFinancials,
  orderGoodsCost,
  TRANSACTION_TYPES,
} from '@/lib/finance-workflow';
import { logAudit } from '@/lib/audit';
import { apiError } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { commissionCostForOrders } from '@/lib/commission';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { STATUS_VALUE_AR } from '@/lib/order-timeline';
import { money as moneyInput } from '@/lib/numeric-input';

const D = (v: any) => new Prisma.Decimal(v ?? 0);
const toMoney = (v: any) => (v === null || v === undefined ? null : new Prisma.Decimal(v));

/**
 * EVERY FIGURE THIS DOOR WRITES, READ BY ONE RULE — AND `isNaN` IS NOT
 * `isFinite`.
 *
 * This file read its numbers three different ways, all of them `Number()`:
 *
 *     numOrReject   `if (isNaN(n) || n < 0) throw`   — six money columns
 *     refundAmount  `Number(refundAmount)`           + `!isFinite`
 *     amount        `Number(amount)`                 + `!isFinite`
 *
 * The first was the live one, and the defect is the whole of it: MEASURED,
 * `Number('1e400')` is `Infinity`, `isNaN(Infinity)` is **false**, and
 * `Infinity < 0` is **false**. So `'1e400'` passed both guards and reached
 * `new Prisma.Decimal(Infinity)` for `productCost`, `packagingCost`,
 * `advertisingCost`, `otherCost`, `discount` and `shippingRevenue`.
 *
 * WHAT THAT ACTUALLY DID, measured rather than reasoned — an `updateMany`
 * against an id proved to match no rows, so the client's argument layer
 * answers without anything being written:
 *
 *     data: { productCost: new Prisma.Decimal(Infinity) }
 *       → PrismaClientUnknownRequestError: Could not convert argument value
 *         Object {"$type": "Decimal", "value": "Infinity"} to ArgumentValue
 *
 * The constructor itself does NOT throw — `new Prisma.Decimal(Infinity)` is
 * a Decimal whose `toString()` is `'Infinity'` and whose `isFinite()` is
 * false — and Prisma refuses it in the client, before any SQL. So no column
 * was ever corrupted by `'1e400'`: the door answered **500 «حدث خطأ
 * داخلي»** where it owed a 400, and told the operator to call the
 * administrator over a typo in a cost field. (For contrast, and because the
 * two look alike and are not: `new Prisma.Decimal('1e400')` is a FINITE
 * Decimal with a large exponent, Prisma passes it through, and Postgres
 * refuses it with `22003 numeric field overflow — a field with precision
 * 14, scale 3 must round to an absolute value less than 10^11`. Same 500,
 * one step later.)
 *
 * THE FIGURE THAT REALLY WAS STORED is the other half of the same gap:
 * `isNaN` is happy with sixteen, so `productCost: '0x10'` was **16.00** in
 * the column with a 200 — and `'0b11'` three, and `'0o17'` fifteen. That is
 * a cost nobody typed, in a column a margin is computed from.
 *
 * So all three sites read through `money()` from `numeric-input`, the same
 * reader `POST /api/orders` and the inventory, production and shipping
 * doors use. The notation is decided there, once; this constant decides
 * only the BOUND.
 *
 * THE BOUND, 100_000_000: the six columns are `Decimal(14, 3)`, which
 * Postgres refuses at 10^11 — so a door with no ceiling hands a 500 back
 * for a figure it could have refused with a 400 and a field name. 10^8 sits
 * an order of magnitude inside that, and it is not a new number in this
 * system: `production/route.ts` and `campaigns.ts` already declare
 * `100_000_000` for money a person types at this precision.
 */
const MONEY = moneyInput(100_000_000);

/**
 * GET /api/orders/[id]/finance — financial snapshot + transaction ledger
 * PATCH /api/orders/[id]/finance — update costs / settlement (permission-gated)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    /*
     * THE MONEY KEYS ONLY.
     *
     * Anyone who could open the order used to fall through to this snapshot:
     * cost of goods, gross and net profit, refunds and the ledger with the
     * names of who moved what — including on orders in the unclaimed pool,
     * which the read envelope lets an agent open. No screen asks for it
     * without a money key; the order window carries no finance tab. So it is
     * the finance and settlement keys' alone, inside this store.
     */
    if (!can(user, 'finance.view') && !can(user, 'settlement.view')) {
      return NextResponse.json(
        { error: 'لا تملك صلاحية عرض المالية.', errorAr: 'لا تملك صلاحية عرض المالية.' },
        { status: 403 },
      );
    }
    const exists = await db.order.findFirst({ where: { id, companyId, storeId }, select: { id: true } });
    if (!exists) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: 404 });
    }

    const order = await db.order.findUnique({
      where: { id },
      select: {
        id: true, companyId: true, currency: true,
        sellingPrice: true, quantity: true, totalAmount: true,
        estimatedCostOfGoods: true, shippingCost: true,
        subtotal: true, discount: true, shippingRevenue: true, totalRevenue: true,
        productCost: true, packagingCost: true, advertisingCost: true, otherCost: true,
        refundAmount: true, grossProfit: true, netProfit: true,
        settlementStatus: true, financeFinalizedAt: true,
        financialTransactions: {
          orderBy: { createdAt: 'desc' },
          include: { actor: { select: { id: true, name: true } } },
        },
      },
    });

    return NextResponse.json({ finance: order });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    const body = await req.json();
    const {
      productCost, packagingCost, advertisingCost, otherCost,
      discount, shippingRevenue, refundAmount, amount,
      settlementStatus, settlementNote, expectedVersion,
    } = body as Record<string, any>;

    const access = await assertOrderAccess(id, user, { companyId, storeId }, 'orders.view');
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    // ── Refund amount validation: ≥0 and ≤ totalAmount ──
    let refundNum: number | undefined;
    if (refundAmount !== undefined && refundAmount !== null) {
      const read = MONEY.safeParse(refundAmount);
      if (!read.success) {
        return NextResponse.json({ error: 'refundAmount must be a finite number ≥ 0', errorAr: 'مبلغ الاسترداد يجب أن يكون رقماً صفراً أو أكثر.' }, { status: 400 });
      }
      refundNum = read.data;
      if (refundNum > Number(order.totalAmount)) {
        return NextResponse.json({ error: 'refundAmount cannot exceed the order total', errorAr: 'مبلغ الاسترداد أكبر من قيمة الطلب.' }, { status: 400 });
      }
    }

    // ── Permission model (Section: roles) ──
    const isFinanceAuth = can(user, 'finance.create') || can(user, 'finance.update');
    const isSettlementAuth = can(user, 'settlement.review') || can(user, 'finance.update');
    if (!isFinanceAuth && !isSettlementAuth) {
      return NextResponse.json({ error: 'Forbidden: no financial authority', errorAr: 'لا تملك صلاحية على أرقام المال في الطلب.' }, { status: 403 });
    }

    if (typeof expectedVersion !== 'number') {
      return NextResponse.json({ error: 'expectedVersion is required', code: 'VERSION_REQUIRED' }, { status: 400 });
    }
    if (expectedVersion !== order.version) {
      return NextResponse.json(
        {
          error: 'This order was updated by another user. Please refresh before saving.',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }

    const updateData: Record<string, unknown> = {};
    const now = new Date();

    // ── Cost/revenue updates: finance authority only ──
    if (productCost !== undefined || packagingCost !== undefined || advertisingCost !== undefined ||
        otherCost !== undefined || discount !== undefined || shippingRevenue !== undefined) {
      if (!isFinanceAuth) {
        return NextResponse.json({ error: 'Forbidden: finance.update required to modify costs', errorAr: 'تعديل التكاليف يحتاج صلاحية المال.' }, { status: 403 });
      }
      // validate numerics (fail closed) — the notation and the bound both
      // come from `MONEY` above, so this decides nothing of its own.
      const numOrReject = (v: unknown, name: string) => {
        if (v === undefined) return undefined;
        const read = MONEY.safeParse(v);
        if (!read.success) throw new Error(`Invalid ${name}`);
        return read.data;
      };
      try {
        const pc = numOrReject(productCost, 'productCost');
        const pk = numOrReject(packagingCost, 'packagingCost');
        const ad = numOrReject(advertisingCost, 'advertisingCost');
        const oc = numOrReject(otherCost, 'otherCost');
        const dis = numOrReject(discount, 'discount');
        const sr = numOrReject(shippingRevenue, 'shippingRevenue');
        if (pc !== undefined) updateData.productCost = toMoney(pc);
        if (pk !== undefined) updateData.packagingCost = toMoney(pk);
        if (ad !== undefined) updateData.advertisingCost = toMoney(ad);
        if (oc !== undefined) updateData.otherCost = toMoney(oc);
        if (dis !== undefined) updateData.discount = toMoney(dis);
        if (sr !== undefined) updateData.shippingRevenue = toMoney(sr);
      } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
    }

    // ── Settlement transition: settlement authority only, controlled map ──
    let settlementAmount: number | undefined;
    if (settlementStatus !== undefined) {
      if (!isSettlementAuth) {
        return NextResponse.json({ error: 'Forbidden: settlement authority required', errorAr: 'التسوية لمراجع التسويات وحده.' }, { status: 403 });
      }
      if (!isValidSettlementTransition(order.settlementStatus, settlementStatus)) {
        return NextResponse.json(
          {
            error: `Invalid settlement transition: ${order.settlementStatus} → ${settlementStatus}`,
            errorAr: `لا يمكن الانتقال من «${STATUS_VALUE_AR[order.settlementStatus] ?? order.settlementStatus}» إلى «${STATUS_VALUE_AR[settlementStatus] ?? settlementStatus}».`,
            code: 'INVALID_TRANSITION',
          },
          { status: 409 }
        );
      }

      /*
       * «SETTLED» IS NOT A LABEL THIS DOOR MAY PUT ON AN ORDER.
       *
       * It is what four readers take as «the cash is in»: `ops/tracking/collect` refuses a second collection
       * of it, `settlement.ts` refuses a statement line for it, `agent-custody-totals` drops it from what the
       * courier still holds, and `commission.ts` makes its commission PAYABLE. This door writes no wallet
       * movement, no amount and no proof, so a holder of `finance.update` could mark an order settled with
       * not one coin received and then pay out its commission — and the real collection would afterwards be
       * refused as «already settled».
       *
       * The only two writers are the ones that put the money in a wallet in the same transaction: the
       * approval of a courier statement, and «استلمت منه». Routing this to either would make a third
       * door to the same money, so it is refused and says where to go. Nothing is written.
       */
      if (settlementStatus === 'SETTLED') {
        return NextResponse.json(
          {
            error: 'Settle where the money lands: this door moves no money into a wallet',
            errorAr:
              'تسوية الطلب تكون حين يدخل ماله محفظة: «استلمت منه» في «متابعة الشحن» أو «المطابقة»، أو باعتماد كشف شركة الشحن في «التحصيل والكشوف». هذا الباب لا يُدخل مالاً إلى أي محفظة، فلا يسوّي. إن لم تكن تلك الشاشات من صلاحياتك فيسوّيه من يملكها.',
            code: 'SETTLE_THROUGH_COLLECTION',
          },
          { status: 409 }
        );
      }

      // PARTIALLY_SETTLED requires an explicit, positive amount within the remaining balance
      if (settlementStatus === 'PARTIALLY_SETTLED') {
        // `MONEY` refuses `undefined` on its own — `z.number()` does — so the
        // explicit absence check that stood here is subsumed, not dropped.
        const read = MONEY.safeParse(amount);
        if (!read.success || read.data <= 0) {
          return NextResponse.json({ error: 'PARTIALLY_SETTLED requires a positive amount', errorAr: 'التسوية الجزئية تحتاج مبلغاً أكبر من صفر.' }, { status: 400 });
        }
        const amt = read.data;
        const total = Number(order.totalAmount);
        const alreadyRefunded = Number(order.refundAmount ?? 0);
        const remaining = Math.max(0, total - alreadyRefunded);
        if (amt > remaining) {
          return NextResponse.json({ error: `Amount exceeds the remaining balance (${remaining})`, errorAr: `المبلغ أكبر من المتبقّي (${remaining}).` }, { status: 400 });
        }
        settlementAmount = amt;
      }

      /*
       * THE REFUND IS WRITTEN WHERE IT IS DECIDED.
       *
       * `Order.refundAmount` had no writer: the figure was validated, put in the ledger row, and thrown away,
       * so the one reader of the column (the remaining balance of a partial settlement, above) always saw
       * «nothing refunded». A partial refund with no amount was also accepted, and the ledger then recorded
       * the WHOLE order total as «partially refunded» — a refund of everything under a name that says less.
       * The column is the running total refunded: a full refund with no figure is the order's total, and any
       * typed figure is added to what was already refunded and may not pass the total. Decimal throughout.
       */
      if (settlementStatus === 'REFUNDED' || settlementStatus === 'PARTIALLY_REFUNDED') {
        if (settlementStatus === 'PARTIALLY_REFUNDED' && !(refundNum !== undefined && refundNum > 0)) {
          return NextResponse.json(
            { error: 'PARTIALLY_REFUNDED requires a positive refundAmount', errorAr: 'الاسترداد الجزئي يحتاج مبلغاً أكبر من صفر.', code: 'REFUND_AMOUNT_REQUIRED' },
            { status: 400 }
          );
        }
        const total = D(order.totalAmount);
        const refundedAfter = refundNum === undefined ? total : D(order.refundAmount).add(D(refundNum));
        if (refundedAfter.gt(total)) {
          return NextResponse.json(
            { error: 'Total refunded would exceed the order total', errorAr: `مجموع المسترَد (${refundedAfter.toString()}) أكبر من قيمة الطلب (${total.toString()}).`, code: 'REFUND_EXCEEDS_TOTAL' },
            { status: 400 }
          );
        }
        updateData.refundAmount = refundedAfter;
      }

      updateData.settlementStatus = settlementStatus;
    }

    // ── Recompute financials (Decimal-safe) whenever components change ──
    const needsRecompute =
      updateData.productCost !== undefined || updateData.packagingCost !== undefined ||
      updateData.advertisingCost !== undefined || updateData.otherCost !== undefined ||
      updateData.discount !== undefined || updateData.shippingRevenue !== undefined;

    if (needsRecompute) {
      const fin = computeFinancials({
        /*
         * THE SUBTOTAL, NOT A UNIT PRICE, AND NO QUANTITY PASSED.
         *
         * `Order.sellingPrice` IS the subtotal — proved against the lines:
         * a three-unit order stores 36 and its lines sum to 36. This used
         * to pass it with `quantity: order.quantity` and the function
         * multiplied, so a three-unit order's revenue came out 108.
         */
        subtotal: order.sellingPrice,
        discount: updateData.discount ?? order.discount ?? 0,
        shippingRevenue: updateData.shippingRevenue ?? order.shippingRevenue ?? 0,
        /*
         * And the goods cost for the WHOLE order, answered in one place.
         * The old `productCost ?? order.productCost ?? estimatedCostOfGoods`
         * chain fell between a per-unit column and an order total, and was
         * then multiplied by quantity a second time.
         */
        goodsCost: orderGoodsCost({
          productCost: updateData.productCost ?? order.productCost,
          estimatedCostOfGoods: order.estimatedCostOfGoods,
        }),
        packagingCost: updateData.packagingCost ?? order.packagingCost ?? 0,
        shippingCost: order.shippingCost,
        advertisingCost: updateData.advertisingCost ?? order.advertisingCost ?? 0,
        otherCost: updateData.otherCost ?? order.otherCost ?? 0,
        // From the LEDGER, so this order's net profit subtracts the same
        // commission the commission screen and the payout show for it.
        commission: await commissionCostForOrders({ id }),
      });
      updateData.subtotal = fin.subtotal;
      updateData.totalRevenue = fin.totalRevenue;
      updateData.grossProfit = fin.grossProfit;
      updateData.netProfit = fin.netProfit;
    }

    updateData.version = { increment: 1 };

    const saved = await db.order.updateMany({
      where: { id, companyId, version: expectedVersion },
      data: updateData,
    });
    if (saved.count !== 1) {
      return NextResponse.json(
        {
          error: 'This order was updated by another user. Please refresh before saving.',
          errorAr: 'تم تعديل هذا الطلب بواسطة مستخدم آخر. يرجى تحديث الصفحة قبل الحفظ.',
          code: 'VERSION_CONFLICT',
        },
        { status: 409 }
      );
    }

    // ── Append-only ledger entry for settlement/refund movements ──
    if (settlementStatus !== undefined && ['SETTLED', 'REFUNDED', 'PARTIALLY_SETTLED', 'PARTIALLY_REFUNDED'].includes(settlementStatus)) {
      const type = settlementStatus === 'REFUNDED' || settlementStatus === 'PARTIALLY_REFUNDED' ? 'REFUND' : 'SETTLEMENT';
      // PARTIALLY_SETTLED uses the explicit validated amount; everything else
      // uses refundAmount (if given) or the full order total — never a hardcoded 50%.
      const amountForLedger =
        settlementStatus === 'PARTIALLY_SETTLED'
          ? toMoney(settlementAmount) ?? D(0)
          : refundNum !== undefined
          ? toMoney(refundNum) ?? D(0)
          : toMoney(order.totalAmount) ?? D(0);
      await db.financialTransaction.create({
        data: {
          companyId, orderId: id,
          type,
          amount: amountForLedger,
          currency: order.currency,
          note: settlementNote?.trim() || `Settlement → ${settlementStatus}`,
          createdById: user.id,
        },
      });
    }

    // Status log for every settlement-status change
    if (settlementStatus !== undefined && settlementStatus !== order.settlementStatus) {
      await db.orderStatusLog.create({
        data: {
          companyId,
          orderId: id,
          statusType: 'SETTLEMENT',
          previousValue: order.settlementStatus,
          newValue: settlementStatus,
          changedById: user.id,
          changedByRole: user.role,
          note: settlementNote?.trim() || null,
        },
      });
    }

    await db.orderActivity.create({
      data: {
        companyId, orderId: id, userId: user.id, action: 'ORDER_UPDATED',
        metadata: JSON.stringify({
          financeUpdate: true, by: user.name, role: user.role,
          settlementStatus: settlementStatus ?? undefined,
          fields: Object.keys(updateData).filter((k) => !k.startsWith('version')),
        }),
      },
    });
    await logAudit({
      companyId, userId: user.id, action: 'FINANCE_UPDATED',
      entity: 'Order', entityId: id,
      previousData: { settlementStatus: order.settlementStatus, version: order.version },
      newData: { settlementStatus, by: user.name },
    });

    const fresh = await db.order.findUnique({ where: { id } });
    return NextResponse.json({ success: true, order: fresh });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}
