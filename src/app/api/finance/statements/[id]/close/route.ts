import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { runMatching } from '@/lib/settlement';
import { isManualHash } from '@/lib/manual-statement-rules';
import { closeRefusal } from '@/lib/settlement-gates';
import { countOpenLines } from '@/lib/statement-open-lines';
import { ON_THE_COMPANY } from '@/lib/shortfall';
import { zodMessage } from '@/lib/zod-message';
import {
  OrdersChanged, StatementStopped, approvedBeforeTheSplit, closeRowsSelect, ordersChangedBody, settleStatement,
  tellShortfalls,
} from '@/lib/statement-close';

/**
 * POST /api/finance/statements/:id/close — «إغلاق المطابقة».
 *
 * «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل» (the owner, 2/11).
 *
 * The approval posted the money and left the matching open, because a line was still a question. Once every line is
 * answered this door settles what the statement settles — the orders, their delivery, their commission, the
 * shortfalls, the claims (`statement-close`) — and WRITES NO MONEY: the wallet movements are the approval's, behind
 * its own one-winner claim, and this file does not import the wallet writer.
 *
 * ── THE GATES ── (`closeRefusal`, the same rule the button reads)
 *
 *   the money first · not closed already · the matching has run · no line is a question.
 *
 * ── ONE CLOSE, HOWEVER MANY PRESSES ──
 *
 * The close is taken as a conditional write — only a statement whose money is posted and whose matching is still
 * open is claimed — so two presses cannot both settle: the second waits on the row, finds it closed, and rolls back
 * before it writes anything. Every matching door (re-match, decide, link, swap) writes with
 * `matchingClosedAt: null` in its own WHERE, so none of them lands after this.
 *
 * ── A STATEMENT THE OLD APPROVAL ALREADY SETTLED ──
 *
 * One approved by the old code while the Redeploy was swapping containers has its money posted, its orders settled,
 * and no close stamped. It is recognised by its movements, which name no receipt (`approvedBeforeTheSplit`), and this
 * door only stamps it: settling its orders again would stop on «تغيّر وضع طلب» for ever. No second backfill is run.
 *
 * The key is the approval's own (`settlement.approve`): closing makes commission payable and proposes shortfalls.
 */

const schema = z.object({
  /** «من يتحمّل الفرق؟» — the same answer the approval takes, for the short lines the door could not name. */
  shortfallPeople: z.record(z.string().uuid(), z.union([z.string().uuid(), z.literal(ON_THE_COMPANY)])).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.approve');

    const raw: unknown = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      select: {
        id: true, reference: true, status: true, approvedAt: true, matchingClosedAt: true, fileHash: true,
        currencyCode: true, createdAt: true, periodTo: true,
        matches: { select: { result: true, resolution: true, orderId: true } },
      },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });

    // The read before the act: the screen greys the button out with the same sentence.
    const before = closeRefusal({
      status: statement.status,
      approvedAt: statement.approvedAt,
      matchingClosedAt: statement.matchingClosedAt,
      matches: statement.matches.length,
      // A statement the old approval settled may show anything here; it is only stamped (below).
      openLines: 0,
    });
    if (before) return NextResponse.json(before, { status: 409 });

    const closedAt = new Date();
    let done;
    try {
      done = await db.$transaction(
        async (tx) => {
          // The claim FIRST: only a statement whose money is posted and whose matching is open.
          const claimed = await tx.courierStatement.updateMany({
            where: { id, companyId, storeId, approvedAt: { not: null }, matchingClosedAt: null },
            data: { matchingClosedAt: closedAt, matchingClosedById: user.id },
          });
          if (claimed.count !== 1) {
            const now = await tx.courierStatement.findFirst({
              where: { id, companyId, storeId },
              select: { status: true, approvedAt: true, matchingClosedAt: true },
            });
            const why = closeRefusal({ ...(now ?? { status: '' }), matches: 1, openLines: 0 });
            throw new StatementStopped(409, { ...(why ?? { code: 'CHANGED', error: 'تغيّر الكشف قبل لحظات — حدّث الصفحة' }) });
          }

          if (await approvedBeforeTheSplit(tx, { companyId, statementId: id })) {
            return { legacy: true as const };
          }

          // A statement gathered by hand is matched again here, as the approval did before the split: the orders it
          // settles are the ones that are clean at the moment of the close. Answers a person gave are kept.
          if (isManualHash(statement.fileHash)) {
            await runMatching(tx, { companyId, storeId, statementId: id, minorUnit: country.minorUnit });
          }

          const rows = await tx.settlementMatch.findMany({
            where: { statementId: id, companyId },
            select: closeRowsSelect(id),
          });
          const refused = closeRefusal({
            status: statement.status,
            approvedAt: statement.approvedAt,
            matchingClosedAt: null,
            matches: rows.length,
            // Counted on the rows THIS transaction read, after the claim: the rows nobody can change any more.
            openLines: countOpenLines(rows),
          });
          if (refused) throw new StatementStopped(409, { ...refused });

          const settled = await settleStatement(tx, {
            companyId, storeId, userId: user.id, minorUnit: country.minorUnit,
            statement: {
              id, reference: statement.reference, currencyCode: statement.currencyCode,
              createdAt: statement.createdAt, periodTo: statement.periodTo,
            },
            matches: rows,
            shortfallPeople: parsed.data.shortfallPeople,
          });
          return { legacy: false as const, ...settled };
        },
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof StatementStopped) return NextResponse.json(e.body, { status: e.status });
      if (e instanceof OrdersChanged) {
        // The transaction is gone, so what is read now is what is true: the orders that failed the claim's filter.
        const changed = await db.order.findMany({
          where: { id: { in: e.ids }, companyId, storeId, NOT: e.where },
          select: { orderNumber: true },
        });
        return NextResponse.json(ordersChangedBody((Array.isArray(changed) ? changed : []).map((o) => o.orderNumber)), { status: 409 });
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_MATCHING_CLOSED',
      entity: 'CourierStatement', entityId: id,
      newData: done.legacy
        ? { reference: statement.reference, approvedBeforeTheSplit: true }
        : {
            reference: statement.reference,
            settled: done.settledCount, acceptedByDecision: done.acceptedCount, claimsOpened: done.claimCount,
            deliveredByStatement: done.deliveredCount,
            shortfalls: done.shortfalls.map((c) => ({ penaltyId: c.penaltyId, employeeId: c.userId, amount: c.amount, currency: c.currencyCode })),
            shortfallsOnCompany: done.shortfallsOnCompany,
          },
    });
    if (!done.legacy) {
      tellShortfalls({ companyId, storeId, actorId: user.id, reference: statement.reference, charges: done.shortfalls });
    }

    return NextResponse.json({
      matchingClosed: true,
      approvedBeforeTheSplit: done.legacy,
      deliveredByStatement: done.legacy ? 0 : done.deliveredCount,
      settledOrders: done.legacy ? 0 : done.settledCount,
      claimsOpened: done.legacy ? 0 : done.claimCount,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
