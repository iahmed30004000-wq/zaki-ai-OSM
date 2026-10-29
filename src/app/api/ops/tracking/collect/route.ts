import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { recordMovement } from '@/lib/wallets';
import { markPayableForOrders } from '@/lib/commission';
import { roundMinor } from '@/lib/money';
import { zodMessage } from '@/lib/zod-message';
import { expectedAmountFor, SETTLEMENT_ORDER_SELECT } from '@/lib/settlement';
import { collectTotalRefusal, statementNamingRefusal } from '@/lib/settlement-gates';

/**
 * POST /api/ops/tracking/collect — settle by hand.
 *
 * A مندوب hands the money over in person and a company without an API sends
 * no file, so for both there is no statement to import and no barcode to
 * match on. Settlement for them is a person saying "I took the money from
 * him", against named orders, into a named wallet.
 *
 * It is the same gate as a statement approval, not a shortcut around it:
 * the wallet movement is written here and nowhere earlier, commission
 * becomes payable only now, and the amount is the NET — what the courier
 * actually hands over, after their fee. Orders already settled are refused
 * rather than counted twice.
 */

const schema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(500),
  walletId: z.string().uuid(),
  /** What was actually handed over. Defaults to the expected net. */
  amount: z.number().positive().max(100_000_000).optional(),
  note: z.string().trim().min(3, 'الملاحظة إلزامية').max(300),
});

/** A refusal found inside the transaction: it rolls back and this is the answer. */
class CollectStopped extends Error {
  constructor(readonly body: { code: string; error: string; orders?: string[] }) {
    super(body.code);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('finance.cashbox');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // This store's wallet or one not placed yet — never another store's: the money goes into the drawer of the
    // store whose orders these are (the orders are read with `storeId` below).
    const wallet = await db.wallet.findFirst({
      where: { id: parsed.data.walletId, companyId, isActive: true, OR: [{ storeId }, { storeId: null }] },
      select: { id: true, name: true, currencyCode: true },
    });
    if (!wallet) return NextResponse.json({ error: 'المحفظة غير موجودة' }, { status: 404 });

    const orders = await db.order.findMany({
      where: { id: { in: parsed.data.orderIds }, companyId, storeId },
      select: {
        id: true, orderNumber: true, currency: true, settlementStatus: true,
        // How a statement line could name the order: our reference, or the courier's barcode.
        merchantRef: true, trackingNumber: true, deliveryProviderId: true,
        // Everything the settlement rule reads, in one spread. The delivered
        // lines are part of it: without them a partial delivery's expected
        // net falls back to the whole order and this dialog asks the operator
        // to take money the courier never collected.
        ...SETTLEMENT_ORDER_SELECT,
        deliveryProvider: { select: { id: true, name: true, kind: true } },
      },
    });
    if (orders.length === 0) return NextResponse.json({ error: 'لا توجد طلبات' }, { status: 404 });

    const alreadySettled = orders.filter((o) => o.settlementStatus === 'SETTLED');
    if (alreadySettled.length > 0) {
      return NextResponse.json(
        {
          error: `طلبات مسوّاة مسبقاً: ${alreadySettled.map((o) => o.orderNumber).join('، ')}`,
          code: 'ALREADY_SETTLED',
        },
        { status: 409 }
      );
    }

    // Only a delivered parcel owes anything. A returned one owes nothing, and
    // one still in transit has not been collected yet.
    //
    // A PARTIAL delivery owes too, and this refused it. The customer took
    // some lines and paid for them at the door, and the agent-custody report
    // already counts that among what the courier is holding. But the money
    // could never be recorded as arrived: the one endpoint that takes cash
    // in refused the order, so it sat in the courier's owing list for ever
    // with no way to clear it.
    //
    // This comment used to say `collectedAmount` holds the exact figure. It
    // does not: the door deliberately leaves that column NULL — the money is
    // the courier's statement's to write — so the expectation below is
    // rebuilt from the DELIVERED LINES. The statement's figure wins only
    // once a statement exists.
    const DELIVERED = ['DELIVERED', 'PARTIALLY_DELIVERED'];
    const notDelivered = orders.filter((o) => !DELIVERED.includes(o.shippingStatus));
    if (notDelivered.length > 0) {
      return NextResponse.json(
        {
          error: `طلبات غير مسلَّمة: ${notDelivered.map((o) => o.orderNumber).join('، ')}`,
          code: 'NOT_DELIVERED',
        },
        { status: 409 }
      );
    }

    /*
     * ONE COURIER PER HANDOVER, CHECKED HERE AND NOT ONLY BY THE SCREEN.
     *
     * The movement is written once, in the name of `orders[0]`'s courier. Orders of two couriers in one request
     * book both couriers' money under the first one's name — the second courier's cash is then nobody's on the
     * wallet statement, and the agent-custody report cannot tell who handed over what. The screen groups by
     * courier, but an API client (or a stale screen) does not. A null courier is its own group: a parcel with
     * no courier named is not the first courier's.
     */
    const couriers = new Set(orders.map((o) => o.deliveryProviderId ?? null));
    if (couriers.size > 1) {
      return NextResponse.json(
        {
          error: 'الطلبات من أكثر من شركة شحن أو مندوب — سجّل استلام كل واحد لحاله حتى يُكتب المبلغ باسمه.',
          code: 'MIXED_COURIER',
        },
        { status: 409 }
      );
    }

    const currencies = new Set(orders.map((o) => o.currency));
    if (currencies.size > 1) {
      return NextResponse.json({ error: 'الطلبات بعملات مختلفة', code: 'MIXED_CURRENCY' }, { status: 409 });
    }
    if (wallet.currencyCode !== orders[0].currency) {
      return NextResponse.json(
        {
          error: `عملة المحفظة (${wallet.currencyCode}) تختلف عن عملة الطلبات (${orders[0].currency})`,
          code: 'WALLET_CURRENCY_MISMATCH',
        },
        { status: 400 }
      );
    }

    // The net: what the courier hands over after keeping their fee.
    const expected = roundMinor(
      // `expectedAmountFor` is the settlement matcher's own rule, reused
      // rather than restated: what the customer actually handed over, net of
      // the courier's fee and of any return fee they charged. On a PARTIAL
      // delivery that comes from the DELIVERED LINES — computing it from
      // `totalAmount` would make every partial look like the courier came up
      // short, and accuse him of a shortfall that only exists in the
      // arithmetic. Each order is rounded by the country's minor unit before
      // the sum, so the total is a sum of real per-order figures.
      orders.reduce((sum, o) => sum + expectedAmountFor(o, country.minorUnit), 0),
      country.minorUnit
    );
    const amount = roundMinor(parsed.data.amount ?? expected, country.minorUnit);
    const difference = roundMinor(amount - expected, country.minorUnit);

    /**
     * A COLLECTION DOOR CAN ONLY TAKE MONEY IN.
     *
     * `expectedAmountFor` subtracts the courier's fee AND the return fee the
     * returns desk charged him, and returns a negative answer as it stands —
     * deliberately, because rounding a real debt up to zero would hide it.
     * Measured on 2026-10-02: 3 units at 1.000 with a 2.5 fee, the customer
     * took one, the returns desk charged 2.5 to carry the rest back. At the
     * door 1.000 + 2.5 = 3.5, and 3.5 − 2.5 − 2.5 = −1.5.
     *
     * That 2.5 came from `fee.returnFee || fee.fee`, which turned a row
     * configuring 0 into the whole outbound fee; `2aa703a` deleted the
     * fallback, so `returns/route.ts:230` now charges the row's `returnFee`
     * as written and THAT route to a negative sum is closed. A configured
     * return fee still reaches one: 12 of the 25 active fee rows hold 1.5,
     * and the same parcel against one of them is 3.5 − 2.5 − 1.5 = −0.5.
     *
     * That figure went straight to `recordMovement`, which refuses anything
     * at or below zero (`wallets.ts:83`) with an English sentence no branch
     * in `api-error.ts` matches — so the operator read a 500
     * «حدث خطأ داخلي», and could not correct it by hand either: the schema
     * above is `positive()` and the dialog's field carries `min="0.001"`.
     * The order could be closed by NO amount at all, which is the very
     * failure this route was changed to prevent.
     *
     * So the refusal is named and says which way the money runs. Whether to
     * open a real negative movement — paying the courier from this screen —
     * is a product decision and is NOT taken here.
     *
     * The test is the BATCH total, not each order: a courier settles a
     * handful of parcels in one handover, and −1.5 on one against 17 on
     * another is 15.5 in the hand. Netting is what a settlement is.
     */
    /*
     * The two sentences live in `settlement-gates` (`collectTotalRefusal`): the manual statement answers with the
     * same words when its lines add up to either, so there is one text for «nothing to take in», not two.
     */
    const noMoneyIn = collectTotalRefusal({
      expected,
      owed: roundMinor(-expected, country.minorUnit),
      currency: wallet.currencyCode,
      count: orders.length,
    });
    if (noMoneyIn) return NextResponse.json(noMoneyIn, { status: 409 });
    /*
     * The second road to the same wall: `positive()` accepts 0.004, and
     * rounding it by the country's minor unit leaves 0 — a figure the wallet
     * refuses. Named rather than 500-ed, and the sentence says the amount
     * the empty field would have recorded.
     */
    if (amount <= 0) {
      return NextResponse.json(
        {
          error:
            `المبلغ المُدخَل (${parsed.data.amount}) أصغر من أصغر وحدة في ${wallet.currencyCode}، ` +
            `فيُقرَّب إلى صفر ولا يمكن تسجيله. أدخل مبلغاً أكبر، ` +
            `أو اترك الحقل فارغاً ليُسجَّل المتوقَّع (${expected}).`,
          code: 'AMOUNT_TOO_SMALL',
          expected,
          currency: wallet.currencyCode,
        },
        { status: 409 }
      );
    }

    const party = orders[0].deliveryProvider?.name ?? 'تحصيل يدوي';

    let result;
    try {
      result = await db.$transaction(async (tx) => {
      /**
       * AN ORDER A STATEMENT SPEAKS FOR IS NOT COLLECTED BY HAND.
       *
       * The statement writes this money at its approval (or already did, with a MISMATCHED line too), so a
       * hand collection of the same order books it twice — once as «تحصيل شركة الشحن» from the statement,
       * once as «تحصيل يدوي» from here. Read inside the transaction, with the lines of THIS store's
       * statements only. A sweep row «MISSING_IN_STATEMENT» is not a line, so it never blocks.
       */
      const refs = orders.map((o) => o.merchantRef).filter((r): r is string => !!r);
      const barcodes = orders.map((o) => o.trackingNumber).filter((b): b is string => !!b);
      const readLines = () =>
        refs.length + barcodes.length === 0
          ? Promise.resolve([])
          : tx.statementLine.findMany({
              where: {
                statement: { companyId, storeId },
                OR: [
                  ...(refs.length ? [{ merchantRef: { in: refs } }] : []),
                  ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
                ],
              },
              select: {
                merchantRef: true,
                barcode: true,
                statement: { select: { reference: true, status: true, approvedAt: true, deliveryProviderId: true } },
              },
            });
      const lines = await readLines();
      /**
       * AND A LINE A PERSON TIED TO THE ORDER BY HAND.
       *
       * «اربطه بطلب» ties a line whose reference named nothing of ours, so that line carries neither the
       * order's reference nor its barcode and the read above cannot see it. It is found through the match row
       * that holds the link: any row of any statement that has a line and this order. Without it a linked
       * order could be collected here and then paid again when the statement is approved.
       */
      const tiedLines = () =>
        tx.settlementMatch.findMany({
          where: { companyId, orderId: { in: orders.map((o) => o.id) }, statementLineId: { not: null } },
          select: {
            orderId: true,
            statement: { select: { reference: true, status: true, approvedAt: true, deliveryProviderId: true } },
          },
        });
      const covered = statementNamingRefusal(orders, lines, await tiedLines());
      if (covered) throw new CollectStopped(covered);

      /**
       * ONE PRESS BOOKS THE MONEY, EVEN IF TWO ARE IN FLIGHT.
       *
       * The SETTLED check above was read outside this transaction, so two simultaneous presses both passed it
       * and both wrote the money. The orders are claimed here, conditionally — only those not yet SETTLED —
       * and the claim must take every one of them: the second press waits on the rows, finds them settled,
       * gets a short count and rolls back before it writes a movement.
       */
      const claimed = await tx.order.updateMany({
        where: { id: { in: orders.map((o) => o.id) }, settlementStatus: { not: 'SETTLED' } },
        data: { settlementStatus: 'SETTLED' },
      });
      if (claimed.count !== orders.length) {
        throw new CollectStopped({ code: 'ALREADY_SETTLED', error: 'انحصّل من قبل — حدّث الصفحة' });
      }
      // The claim holds the orders' rows, and a link takes the same row before it reads the order's state.
      // So a link that committed while this press waited is visible HERE, and one that has not yet read the
      // order will find it settled: asked again after the claim, the two cannot both succeed.
      // The statements' own lines are read again too: a «مطابق يدوي» that added this order to a draft while this
      // press waited on the row is visible now (review of #67, 29/10), so the two cannot both book the money.
      const lateCover = statementNamingRefusal(orders, await readLines(), await tiedLines());
      if (lateCover) throw new CollectStopped(lateCover);

      const movement = await recordMovement(tx, {
        companyId,
        walletId: wallet.id,
        direction: 'IN',
        amount,
        party: `تحصيل يدوي — ${party}`,
        category: 'COURIER_SETTLEMENT',
        note: parsed.data.note,
        referenceType: 'MANUAL_COLLECTION',
        referenceId: orders[0].id,
        createdById: user.id,
      });

      // Settled orders make their commission payable — the same rule as a
      // statement approval, reached by a different road.
      await markPayableForOrders(tx, companyId, orders.map((o) => o.id));

      for (const order of orders) {
        await tx.orderActivity.create({
          data: {
            companyId, orderId: order.id, userId: user.id,
            action: 'MANUAL_COLLECTION',
            metadata: JSON.stringify({
              wallet: wallet.name, party, movementId: movement.id, note: parsed.data.note,
            }),
          },
        });
      }

      return movement;
      });
    } catch (e) {
      if (e instanceof CollectStopped) return NextResponse.json(e.body, { status: 409 });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'MANUAL_COLLECTION',
      entity: 'WalletMovement', entityId: result.id,
      newData: {
        orders: orders.map((o) => o.orderNumber),
        wallet: wallet.name, party, expected, amount, difference, note: parsed.data.note,
      },
    });

    return NextResponse.json({
      orders: orders.length,
      expected,
      amount,
      difference,
      currency: wallet.currencyCode,
      message:
        difference === 0
          ? `استُلم ${amount} ${wallet.currencyCode} عن ${orders.length} طلباً`
          : `استُلم ${amount} ${wallet.currencyCode} عن ${orders.length} طلباً — بفارق ${difference} عن المتوقَّع`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
