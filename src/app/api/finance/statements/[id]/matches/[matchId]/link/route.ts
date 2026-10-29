import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { LinkRefused, findLinkCandidates, linkLineToOrder } from '@/lib/hand-link';

/**
 * /api/finance/statements/:id/matches/:matchId/link — «اربطه بطلب».
 *
 *   GET  ?q=…            the orders this line might be: by the customer's phone, our order number, or the
 *                        company's barcode. Nearest to the line's amount first, with the count of that number's
 *                        orders (how many are closed, how many open) at the top.
 *   POST { orderId }     tie the line to that order, by hand.
 *
 * ── A SEPARATE DOOR, NOT THE MATCHER ──
 *
 * `runMatching` never reads a phone, and this is why this route exists: the phone is searched here, by a person,
 * who sees the candidates and chooses. Nothing the matcher does changes.
 *
 * ── IT MOVES NO MONEY ──
 *
 * It writes one match row (`matchedBy: MANUAL`), judged by the matcher's own function. Receipts, approval,
 * «استلمت منه» and the settlement of the order stay where they are; approval settles a row that is MATCHED, and
 * a MISMATCHED one waits for a person's answer exactly as an automatic one does.
 *
 * ── WHO MAY ──
 *
 * `settlement.review`: the permission of the screen it is pressed on, and of the answers beside it. The search
 * hands out customers' names and phones, so every reading is counted in the person's tally like any other list.
 */

const linkSchema = z.object({
  orderId: z.string().min(1),
  /** The person read the warning that this order is with another courier and went on. */
  acceptOtherCourier: z.boolean().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const query = new URL(req.url).searchParams.get('q') ?? '';
    const found = await findLinkCandidates(db, {
      companyId, storeId, statementId: id, matchId, query, minorUnit: country.minorUnit,
    });

    // Names and phones left the building; the tally is the person's, not this screen's.
    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'ربط سطر كشف بطلب',
      rows: found.candidates.map((c) => ({ customer: c.customer })),
    });

    return NextResponse.json(found);
  } catch (error) {
    if (error instanceof LinkRefused) return NextResponse.json(error.body, { status: error.status });
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = linkSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const linked = await db.$transaction(
      (tx) =>
        linkLineToOrder(tx, {
          companyId, storeId, statementId: id, matchId,
          orderId: parsed.data.orderId,
          userId: user.id,
          minorUnit: country.minorUnit,
          acceptOtherCourier: parsed.data.acceptOtherCourier === true,
        }),
      { timeout: 30_000 }
    );

    await logAudit({
      companyId,
      userId: user.id,
      action: 'STATEMENT_LINE_LINKED_BY_HAND',
      entity: 'SettlementMatch',
      entityId: linked.matchId,
      newData: {
        statement: linked.reference,
        orderNumber: linked.orderNumber,
        result: linked.result,
        difference: linked.difference,
        otherCourier: linked.otherCourier,
      },
    });

    return NextResponse.json({
      linked,
      message:
        linked.result === 'MATCHED'
          ? `رُبط السطر بالطلب ${linked.orderNumber} — والأرقام متطابقة`
          : `رُبط السطر بالطلب ${linked.orderNumber} — وفيه ما يحتاج نظرة: ${linked.note ?? ''}`,
    });
  } catch (error) {
    if (error instanceof LinkRefused) return NextResponse.json(error.body, { status: error.status });
    return apiErrorResponse(error);
  }
}
