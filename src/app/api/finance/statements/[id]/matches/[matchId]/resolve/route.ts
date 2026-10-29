import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import {
  isDifference,
  MISSING_RESULTS,
  RESOLUTIONS,
  RESOLUTION_AR,
  shortfall,
  type Resolution,
} from '@/lib/settlement-difference';

/**
 * POST /api/finance/statements/:id/matches/:matchId/resolve
 *
 * «ممكن عادي صار خصم، بس يعتمد رقم الشركة. وإذا غير معتمد أنا رح أتواصل مع
 * الشركة وخط اعتماد رقمنا. بس بضل الطلب معلّم.»
 *
 * Two answers to one question, and the order keeps saying it was asked.
 *
 * ── IT MOVES NO MONEY ──
 *
 * Deliberately. A resolution records WHY two figures differ; the money is
 * moved by the receipt and the approval, which are their own steps with
 * their own permission and their own audit. Writing a wallet movement from
 * here would be a second money path into settlement — the thing this
 * codebase refuses above all others — and it would do it from a button
 * whose label says «record the reason».
 *
 * ── AND IT IS ALLOWED AFTER APPROVAL ──
 *
 * Re-MATCHING an approved statement is refused, because matching rewrites
 * the rows that decided which orders were settled. This does not rewrite
 * any of them. A difference noticed a week after approval is still worth
 * recording — the count per person is the point — and refusing it would
 * only mean the reason is never written down at all.
 *
 * ── AND IT WRITES BACK TO THE ORDER ──
 *
 * The answer is usually already in the order's internal notes: an agent
 * agreed a discount on the phone and wrote it there, where finance never
 * looks. So the decision goes back the same way, to the same place, and the
 * person who reads the order sees that finance accepted it — or did not.
 */
const schema = z.object({
  resolution: z.enum(RESOLUTIONS),
  note: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const resolution = parsed.data.resolution as Resolution;

    const match = await db.settlementMatch.findFirst({
      where: { id: matchId, statementId: id, companyId, statement: { storeId } },
      select: {
        id: true,
        result: true,
        resolution: true,
        orderId: true,
        expectedAmount: true,
        statementAmount: true,
        difference: true,
        statement: { select: { reference: true } },
        order: { select: { orderNumber: true } },
      },
    });
    if (!match) return NextResponse.json({ error: 'سطر المطابقة غير موجود' }, { status: 404 });

    // A clean match has nothing to answer. Recording a reason on one would
    // put it in the count of differences and in somebody's statistics.
    if (!isDifference(match)) {
      /*
       * A parcel one side does not have has ONE figure, so there is nothing to choose between: «رقمنا /
       * رقمهم» is offered only on «فرق في المبلغ». It is answered on the order («طلبات لم يذكرها أي كشف»)
       * or by linking the line to an order, and it is never counted as a difference in money.
       */
      const missing = (MISSING_RESULTS as readonly string[]).includes(match.result);
      return NextResponse.json(
        {
          error: missing
            ? 'هذا السطر طرف واحد فقط — لا رقمين يُختار بينهما. «رقمنا / رقمهم» لسطر «فرق في المبلغ» وحده'
            : 'هذا السطر مطابق — لا فرق فيه يُبتّ',
          code: 'NOT_A_DIFFERENCE',
        },
        { status: 409 }
      );
    }

    const gap = shortfall({
      expectedAmount: match.expectedAmount === null ? null : Number(match.expectedAmount),
      statementAmount: match.statementAmount === null ? null : Number(match.statementAmount),
      difference: match.difference === null ? null : Number(match.difference),
    });

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.settlementMatch.update({
        where: { id: match.id },
        data: {
          resolution,
          resolutionNote: parsed.data.note?.trim() || null,
          resolvedById: user.id,
          resolvedAt: new Date(),
        },
        select: { id: true, resolution: true, resolutionNote: true, resolvedAt: true },
      });

      if (match.orderId) {
        await tx.orderNote.create({
          data: {
            companyId,
            orderId: match.orderId,
            authorId: user.id,
            kind: 'internal',
            body:
              `مطابقة كشف ${match.statement.reference}: ${RESOLUTION_AR[resolution]}` +
              (gap !== null ? ` — الفرق ${gap}` : '') +
              (parsed.data.note?.trim() ? `. ${parsed.data.note.trim()}` : ''),
          },
        });
      }
      return row;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'SETTLEMENT_DIFFERENCE_RESOLVED',
      entity: 'SettlementMatch',
      entityId: match.id,
      previousData: { resolution: match.resolution },
      newData: {
        resolution,
        orderNumber: match.order?.orderNumber ?? null,
        statement: match.statement.reference,
        gap,
      },
    });

    return NextResponse.json({
      match: updated,
      gap,
      message: `${RESOLUTION_AR[resolution]}${match.order?.orderNumber ? ` — ${match.order.orderNumber}` : ''}. يبقى الطلب معلَّماً.`,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
