import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { differencesByPerson, MIN_SETTLED_ORDERS, type PersonRow } from '@/lib/settlement-difference';

/**
 * GET /api/finance/settlement-differences — whose orders arrive short.
 *
 * «أصلاً في إحصائيات على بنت المتابعة: بتقرأ التعليقات الداخلية وبتشوف إذا
 * عملت خصومات.»
 *
 * The person who agreed the discount is the person whose parcels keep
 * arriving a little short of what the order says, and until it is counted
 * nobody can tell a generous agent from an unlucky one — or from a courier
 * shaving a dinar off a hundred parcels.
 *
 * ── WHO A DIFFERENCE IS COUNTED AGAINST ──
 *
 * The person who CONFIRMED the order, falling back to the moderator who
 * brought it. Confirmation is the call where a price is agreed and where a
 * discount is given, so it is the act the difference belongs to. An order
 * nobody confirmed and nobody sourced is counted against nobody rather
 * than against a guess.
 *
 * ── ONE QUERY, AND THE DENOMINATOR IS THE HONEST ONE ──
 *
 * The rate is differences over the person's orders that REACHED A
 * STATEMENT — not over all their orders. An order still in transit has had
 * no chance to differ, and counting it would make anybody with a busy week
 * look careful.
 */
export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('settlement.review');

    /*
     * «طلب تبديل» IS NOT A DISCOUNT, SO IT IS IN NONE OF THE THREE NUMBERS THAT SAY «DISCOUNT» — and has its own.
     *
     * A line answered as an exchange is `resolution = 'ACCEPTED_COURIER'` with `resolutionKind = 'EXCHANGE'` (the money paths read the
     * first word and never changed). `differences`, `accepted` and `acceptedValue` leave it out, so `rate` (differences over the
     * orders that reached a statement) leaves it out too; `exchanges` counts it. `settledOrders` is unchanged: the order did reach a
     * statement, and that is all that number says.
     *
     * THE TEST IS `(…) IS TRUE`, NOT `<> 'EXCHANGE'`: almost every row has NO kind (NULL), and `NULL <> 'EXCHANGE'` is not true — a
     * filter written that way would drop every plain row from the tally. `IS TRUE` turns NULL into false, so `NOT (… IS TRUE)` keeps
     * the row. It is also the same rule as `isExchange` (the kind counts only beside the courier's figure).
     */
    const rows = await db.$queryRaw<
      {
        personId: string | null;
        settledOrders: bigint;
        differences: bigint;
        accepted: bigint;
        acceptedValue: Prisma.Decimal | null;
        exchanges: bigint;
      }[]
    >`
      SELECT COALESCE(o."confirmedById", o."moderatorId") AS "personId",
             COUNT(DISTINCT o.id) AS "settledOrders",
             COUNT(*) FILTER (
               WHERE m.result = 'MISMATCHED'
                 AND NOT ((m.resolution = 'ACCEPTED_COURIER' AND m."resolutionKind" = 'EXCHANGE') IS TRUE)
             ) AS "differences",
             COUNT(*) FILTER (
               WHERE m.resolution = 'ACCEPTED_COURIER'
                 AND NOT ((m.resolution = 'ACCEPTED_COURIER' AND m."resolutionKind" = 'EXCHANGE') IS TRUE)
             ) AS "accepted",
             COALESCE(SUM(
               CASE WHEN m.resolution = 'ACCEPTED_COURIER'
                         AND NOT ((m.resolution = 'ACCEPTED_COURIER' AND m."resolutionKind" = 'EXCHANGE') IS TRUE)
                    THEN COALESCE(m."expectedAmount", 0) - COALESCE(m."statementAmount", 0)
                    ELSE 0 END
             ), 0) AS "acceptedValue",
             COUNT(*) FILTER (
               WHERE (m.resolution = 'ACCEPTED_COURIER' AND m."resolutionKind" = 'EXCHANGE') IS TRUE
             ) AS "exchanges"
      FROM settlement_matches m
      JOIN orders o ON o.id = m."orderId"
      WHERE m."companyId" = ${companyId}
        AND o."storeId" = ${storeId}
        -- A parcel no statement names reached no statement: it is neither a difference nor a settled order.
        AND m.result IN ('MATCHED', 'MISMATCHED')
      GROUP BY 1
    `;

    const people: PersonRow[] = rows
      .filter((r) => r.personId)
      .map((r) => ({
        personId: r.personId as string,
        settledOrders: Number(r.settledOrders),
        differences: Number(r.differences),
        accepted: Number(r.accepted),
        acceptedValue: Number(r.acceptedValue ?? 0),
        exchanges: Number(r.exchanges ?? 0),
      }));

    const names = new Map(
      (
        await db.user.findMany({
          where: { id: { in: people.map((p) => p.personId) } },
          select: { id: true, name: true, role: true },
        })
      ).map((u) => [u.id, u])
    );

    const unattributed = rows.find((r) => !r.personId);

    return NextResponse.json({
      people: differencesByPerson(people).map((p) => ({
        ...p,
        name: names.get(p.personId)?.name ?? null,
        role: names.get(p.personId)?.role ?? null,
      })),
      minSettledOrders: MIN_SETTLED_ORDERS,
      /**
       * Orders that reached a statement with nobody named on them. Reported
       * rather than dropped: a large number here means the people table
       * above is a minority of the differences, and a reader must know that
       * before ranking anybody by it.
       */
      unattributed: unattributed
        ? { settledOrders: Number(unattributed.settledOrders), differences: Number(unattributed.differences) }
        : { settledOrders: 0, differences: 0 },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
