import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { orderGoodsCost } from '@/lib/finance-workflow';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { reportRange, type DateFilter } from '@/lib/analytics';
import { summariseLoss, type LossRow } from '@/lib/loss-analysis';
import { notSuperseded } from '@/lib/superseded';

/**
 * GET /api/analytics/loss — why orders died, and which of it cost money.
 *
 * The reading itself is `summariseLoss`, which takes rows and no database.
 * This route's only job is to say what the rows are, and the only part of
 * that worth arguing about is the money.
 *
 * WHAT AN AFTER-SHIPPING LOSS ACTUALLY COST:
 *
 *   the delivery fee on the order — a snapshot taken when it shipped, so it
 *   is what was agreed for that parcel and not what the table says today;
 *
 *   plus the courier's return fee for bringing it back, which lives per
 *   (courier, region) in `delivery_fees`. The row's own `returnFee`, read
 *   the same way the returns desk reads it — as written, with nothing
 *   behind it — so the two never disagree about one invoice;
 *
 *   plus the goods themselves when the parcel comes back damaged, which is
 *   the only case where the product does not go back on the shelf.
 *
 * Nothing is estimated. A fee we do not hold contributes zero and the row
 * still counts, because inventing an average would put a number on the
 * report that no invoice backs.
 */

/** Rows read per request. Past this the report says so rather than lying by omission. */
const MAX_ROWS = 5000;

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('reports.view');

    const { searchParams } = new URL(req.url);
    const filter: DateFilter = {
      period: (searchParams.get('period') as DateFilter['period']) || 'all',
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
    };
    // The same window the dashboard tiles above this panel read: under «الكل»
    // both count the whole history, or the page would say two things at once.
    // MAX_ROWS still bounds what is read.
    const { start, end } = reportRange(filter);
    const createdAt = start || end ? { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } : undefined;

    const where = {
      companyId,
      ...(storeId ? { storeId } : {}),
      ...(createdAt ? { createdAt } : {}),
      /*
       * AN ORDER THAT WAS REPLACED IS NOT A LOSS.
       *
       * A parcel taken back from a courier company, or cancelled at the
       * courier for a change to the goods, ends as a return with a reason —
       * and the reorder door writes `CUSTOMER_REQUEST` on it, which the
       * classification below reads as «قرارُ العميل». The customer decided
       * nothing: the sale went on in the replacement, which is counted (and
       * counted as a loss if IT fails). Leaving the old one in blamed the
       * customer for our own re-routing and charged the wasted leg's fees to
       * a failure that did not happen.
       *
       * Only the three reasons in `superseded.ts` count: a LOSS WON BACK by
       * the win-back also carries a link to its replacement, and it is still
       * a loss.
       */
      ...notSuperseded,
      OR: [
        { rejectionReason: { not: null } },
        { deliveryFailureReason: { not: null } },
        { returnReason: { not: null } },
      ],
    };

    const [orders, total, fees] = await Promise.all([
      db.order.findMany({
        where,
        select: {
          rejectionReason: true,
          deliveryFailureReason: true,
          returnReason: true,
          deliveryFee: true,
          productCost: true,
          // The column every order door actually fills in — see the
          // note beside `goods` below. Without it the goods on a
          // damaged return were priced at zero on every row.
          estimatedCostOfGoods: true,
          quantity: true,
          regionId: true,
          deliveryProviderId: true,
        },
        take: MAX_ROWS,
      }),
      db.order.count({ where }),
      db.deliveryFee.findMany({
        where: { companyId, isActive: true },
        select: { regionId: true, deliveryProviderId: true, fee: true, returnFee: true },
      }),
    ]);

    /**
     * «this courier, this region» — the same key the row itself means — and
     * THE ROW'S OWN `returnFee`, with nothing behind it.
     *
     * `delivery_fees.returnFee` is `numeric NOT NULL DEFAULT 0` in the
     * schema, in the migration and in the live database, and the settings
     * form posts 0 when the box is left empty. So by the time `Number()` has
     * run this is a finite number that is never absent, and the only falsy
     * value it can hold is a REAL, configured 0: «we charge nothing to carry
     * goods back». Measured on the live database 2026-10-03: of 25 active
     * rows, 13 hold returnFee 0 against a fee of 3, 4 or 5, 12 hold 1.5,
     * and none hold NULL.
     *
     * It used to read `returnFee || fee`, which billed each of those 13 the
     * whole OUTBOUND leg a second time — the delivery fee counted once as
     * `outbound` and again as the cost of bringing the parcel back. The
     * returns desk charged the same way until `2aa703a`, and that commit did
     * not swap the operator: `??` on a value that is never nullish is a
     * fallback that reads as live policy and cannot fire once. So the
     * fallback is gone here too rather than re-operatored.
     *
     * Absence is a MISSING ROW, not a value in one, and that case is handled
     * where it actually arises — `?? 0` on the lookup below.
     */
    const returnFeeOf = new Map(
      fees.map((f) => [`${f.deliveryProviderId}:${f.regionId}`, Number(f.returnFee)])
    );

    const rows: LossRow[] = [];
    const add = (row: LossRow) => {
      const at = rows.find((r) => r.field === row.field && r.reason === row.reason);
      if (at) {
        at.count += row.count;
        at.money += row.money;
      } else {
        rows.push({ ...row });
      }
    };

    for (const o of orders) {
      // Before confirmation, and it is counted whatever else is set: an order
      // rejected on the phone never reached a courier, so the two halves
      // cannot both be true of the same order.
      if (o.rejectionReason) {
        add({ field: 'rejectionReason', reason: o.rejectionReason, count: 1, money: 0 });
        continue;
      }

      const outbound = Number(o.deliveryFee ?? 0);
      const back =
        o.deliveryProviderId && o.regionId
          ? (returnFeeOf.get(`${o.deliveryProviderId}:${o.regionId}`) ?? 0)
          : 0;
      /*
       * WHAT A DAMAGED PARCEL COST US, FROM A COLUMN THAT IS ACTUALLY
       * FILLED IN.
       *
       * This read `Number(o.productCost ?? 0) * (o.quantity ?? 1)` and was
       * wrong twice over. MEASURED: `productCost` is null on all 56 live
       * orders — it is written only by a finance route that has no screen —
       * so the goods on a damaged return were priced at ZERO, every time.
       * And `estimatedCostOfGoods`, which every order door fills in, holds
       * the answer on all 56.
       *
       * The second half was the multiplication: both columns hold the
       * WHOLE ORDER's cost, so `× quantity` charged a three-unit order
       * three times over had the first column ever been filled.
       *
       * `orderGoodsCost` is the one place that answers this now, and it is
       * the same answer the profit snapshot uses.
       */
      const goods =
        o.returnReason === 'DAMAGED_PRODUCT'
          ? Number(orderGoodsCost({ productCost: o.productCost, estimatedCostOfGoods: o.estimatedCostOfGoods }))
          : 0;

      /**
       * ONE PARCEL, ONE BILL.
       *
       * A failed attempt that ends in a return has both fields set, and
       * charging the fees to each of them would double the money on the
       * report. The return is the later, final fact, so it carries the
       * invoice and the attempt keeps its count — which is what makes
       * «فشل التوصيل × ٩» readable beside «الإرجاع كلّفنا ٥٤».
       */
      if (o.returnReason) {
        add({ field: 'returnReason', reason: o.returnReason, count: 1, money: outbound + back + goods });
        if (o.deliveryFailureReason) {
          add({ field: 'deliveryFailureReason', reason: o.deliveryFailureReason, count: 1, money: 0 });
        }
        continue;
      }
      if (o.deliveryFailureReason) {
        add({ field: 'deliveryFailureReason', reason: o.deliveryFailureReason, count: 1, money: outbound });
      }
    }

    /*
     * THE COUNTS FOR THE PANEL'S READERS; THE MONEY FOR THE MONEY KEY.
     *
     * What a failed parcel cost — both fees and the goods — is money, and
     * it went to anyone holding the reports key, beside a dashboard that
     * hides every money tile from them. The counts, the reasons and whose
     * fault each was stay: that is what the panel is for. Every money figure
     * is zero for them, and the answer says it was withheld, so the screen
     * says so instead of printing «٠».
     */
    const summary = summariseLoss(rows);
    const maySeeMoney = can(user, 'finance.view');

    return NextResponse.json({
      ...(maySeeMoney ? summary : withoutMoney(summary)),
      ...(maySeeMoney ? {} : { moneyWithheld: true }),
      period: filter.period || 'all',
      // Never a silent cap: a report that quietly dropped rows reads exactly
      // like one that found nothing more.
      scanned: orders.length,
      total,
      truncated: total > orders.length,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Every money figure in the report set to zero, every count left as it is. */
function withoutMoney<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutMoney) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        /money/i.test(k) && typeof v === 'number' ? [k, 0] : [k, withoutMoney(v)],
      ),
    ) as T;
  }
  return value;
}
