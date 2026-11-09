import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { settleCleanRefusal } from '@/lib/settlement-gates';
import { perLineSettlementOn } from '@/lib/per-line-settlement-switch';
import { pressMessage } from '@/lib/per-line-settlement-words';
import { StatementStopped, approvedBeforeTheSplit, closeRowsSelect, earlyAnswer, settleCleanLines } from '@/lib/statement-close';

/**
 * POST /api/finance/statements/:id/settle-clean — «سوّي الطلبات النظيفة هلّق».
 *
 * «طلبات بتاخد أسبوع تفسير» (the owner, 9/11). The approval settles a statement's clean lines by itself when the switch
 * «تسوية السطور النظيفة عند الاعتماد» is on (`settleCleanLines`) — but the statements that hurt are the ones ALREADY approved and
 * stuck open, approved before the switch was turned on or with an order that was not settlable at the time. This is the press
 * that settles their clean lines now, with the very function the approval calls.
 *
 * ── WHAT IT DOES, AND WHAT IT DOES NOT ──
 *
 * It settles the lines that matched (and have an order, and were not settled yet) — their orders become settled and delivered, their
 * commission payable, their stock consumed — and marks each row applied. It moves NO money (the wallet is the approval's, behind its
 * own claim; this file does not import the wallet writer), answers no line, links nothing, and does not run the matching again. A line
 * that needs an answer keeps waiting, and so does its order; «إغلاق المطابقة» is still the press that settles the rest.
 *
 * ── THE GATES ── the owner's switch on · the money posted · the matching not closed — in that order, with a sentence each.
 *
 * ── ONE TRANSACTION, WITH A CLOCK ──
 *
 * It runs in one database transaction with a hard timeout, like the approval, and `settleCleanLines` works in slices that start only
 * while its share of that timeout is not spent (counted from the first line of this transaction, `startedAt`). What the clock does not
 * reach stays for the next press — the answer says how many are left and, when the time was the reason, `stoppedForTime`.
 *
 * ── ONE WINNER, HOWEVER MANY PRESSES ──
 *
 * The statement's row is locked first (the lock the answer doors, the hand link, the swap and the close's own claim all wait on) and
 * the gates are asked again after it: two presses, or a press beside «إغلاق المطابقة», are taken one after the other, and the second
 * finds the rows applied (nothing left to settle) or the matching closed (refused). An order that is not settlable now — settled by
 * another door, a cancel or a postponement asked for — is left for the close, which reports it as it always did; it is named on the
 * answer with the reason. The key is the close's own (`settlement.approve`): this makes commission payable and consumes stock.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.approve');

    if (!(await perLineSettlementOn(db, companyId))) {
      return NextResponse.json(
        { code: 'PER_LINE_OFF', error: 'مفتاح «تسوية السطور النظيفة عند الاعتماد» مطفي — شغّله من الإعدادات أول' },
        { status: 409 }
      );
    }

    const statement = await db.courierStatement.findFirst({
      where: { id, companyId, storeId },
      select: { id: true, status: true, approvedAt: true, matchingClosedAt: true },
    });
    if (!statement) return NextResponse.json({ error: 'الكشف غير موجود' }, { status: 404 });
    // The read before the act: the screen draws the button only where this would pass.
    const before = settleCleanRefusal(statement);
    if (before) return NextResponse.json(before, { status: 409 });

    let done;
    try {
      done = await db.$transaction(
        async (tx) => {
          // WHEN THIS TRANSACTION BEGAN — the step is given a share of the timeout below, counted from here, so a wait for the lock
          // that follows is in the count (`settleCleanLines`).
          const startedAt = Date.now();
          // The lock first, then everything is read: a close or an answer that began before waits for this to commit, and one that
          // begins after reads what this wrote.
          await tx.$queryRaw`SELECT "id" FROM "courier_statements" WHERE "id" = ${id} FOR UPDATE`;
          const now = await tx.courierStatement.findFirst({
            where: { id, companyId, storeId },
            select: { id: true, reference: true, status: true, approvedAt: true, matchingClosedAt: true, currencyCode: true, createdAt: true, periodTo: true },
          });
          if (!now) throw new StatementStopped(404, { error: 'الكشف غير موجود' });
          const refused = settleCleanRefusal(now);
          if (refused) throw new StatementStopped(409, { ...refused });
          // Approved by the old code during a Redeploy: its orders are settled already, and only «إغلاق المطابقة» stamps it.
          if (await approvedBeforeTheSplit(tx, { companyId, statementId: id })) {
            throw new StatementStopped(409, {
              code: 'APPROVED_BEFORE_THE_SPLIT',
              error: 'هالكشف اعتمدته النسخة القديمة وطلباته مُسوّاة أصلاً — اضغط «إغلاق المطابقة» بس',
            });
          }

          const rows = await tx.settlementMatch.findMany({ where: { statementId: id, companyId }, select: closeRowsSelect(id) });
          const early = await settleCleanLines(tx, {
            companyId, storeId, userId: user.id, minorUnit: country.minorUnit, at: new Date(), startedAt,
            statement: { id, reference: now.reference, currencyCode: now.currencyCode, createdAt: now.createdAt, periodTo: now.periodTo },
            matches: rows,
          });
          // Never a half answer: when the very first slice failed it undid itself to its savepoint and NOTHING was settled — this press
          // says so instead of claiming it did. A later slice that failed leaves the earlier ones settled (each is complete): that is
          // answered as it is, with what went through, what is left and `failed`.
          if (early.failed && early.settled === 0) {
            throw new StatementStopped(409, {
              code: 'CLEAN_SETTLE_FAILED',
              error: 'تعذّرت تسوية الطلبات النظيفة هلّق وما انكتب شي — جرّب بعد شوي، أو اضغط «إغلاق المطابقة» لما تخلص الأسطر',
            });
          }
          return { early, reference: now.reference };
        },
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof StatementStopped) return NextResponse.json(e.body, { status: e.status });
      throw e;
    }

    // An act with nothing to do (no clean line was waiting) leaves no audit row: nothing was done.
    if (done.early.ran) {
      await logAudit({
        companyId, userId: user.id, action: 'STATEMENT_CLEAN_LINES_SETTLED',
        entity: 'CourierStatement', entityId: id,
        newData: { reference: done.reference, ...earlyAnswer(done.early) },
      });
    }

    const { early } = done;
    return NextResponse.json({
      settled: early.settled,
      delivered: early.delivered,
      heldBack: early.heldBack,
      remaining: early.remaining,
      rows: early.rows.map((r) => ({ matchId: r.matchId, orderNumber: r.orderNumber, outcome: r.outcome, why: r.why })),
      // Said only when it happened: the step ran out of its share of the transaction's time (press again), or a later slice failed.
      ...(early.stoppedForTime ? { stoppedForTime: true } : {}),
      ...(early.failed ? { failed: true } : {}),
      message: pressMessage(early),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
