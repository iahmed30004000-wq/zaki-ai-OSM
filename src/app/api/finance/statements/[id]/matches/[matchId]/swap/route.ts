import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { announceSwap } from '@/lib/parcel-swap-events';
import { SwapRefused, findSwapCandidates, recordParcelSwap } from '@/lib/parcel-swap';

/**
 * /api/finance/statements/:id/matches/:matchId/swap — «كان من طرد طلب آخر».
 *
 *   GET  ?q=…                                  the orders that might have taken the box: by the customer's phone
 *                                              or the order number. Each one carries the reasons it would be refused.
 *   POST { ownerOrderId, pieces, ownerBoxBack } record the swap, in ONE transaction (see lib/parcel-swap).
 *
 * ── WHO MAY ──
 *
 * `settlement.review`: the permission of the screen it is pressed on and of the answers beside it. The search
 * hands out customers' names and phones, so every reading is counted in the person's tally like any other list.
 *
 * ── THE ANNOUNCEMENTS COME AFTER THE COMMIT ──
 *
 * The sale is told to the replies system as delivered, the box's order as returned. A failure to tell never
 * undoes the swap, and an order-number clash retries the whole transaction from outside (a failed statement
 * poisons a Postgres transaction, so the retry cannot live inside it).
 */

const swapSchema = z.object({
  ownerOrderId: z.string().min(1),
  pieces: z.number().int().min(1).max(10_000),
  ownerBoxBack: z.boolean(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const query = new URL(req.url).searchParams.get('q') ?? '';
    const found = await db.$transaction((tx) =>
      findSwapCandidates(tx, { companyId, storeId, statementId: id, matchId, query, minorUnit: country.minorUnit })
    );

    await noteCustomersHandedOut({
      companyId, storeId, user, where: 'تبديل طرد على سطر كشف',
      rows: found.candidates.map((c) => ({ customer: c.customer })),
    });

    return NextResponse.json(found);
  } catch (error) {
    if (error instanceof SwapRefused) return NextResponse.json(error.body, { status: error.status });
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const { id, matchId } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.review');

    const parsed = swapSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    let result: Awaited<ReturnType<typeof recordParcelSwap>> | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await db.$transaction(
          (tx) =>
            recordParcelSwap(tx, {
              companyId, storeId, statementId: id, matchId,
              ownerOrderId: parsed.data.ownerOrderId,
              pieces: parsed.data.pieces,
              ownerBoxBack: parsed.data.ownerBoxBack,
              user: { id: user.id, name: user.name, role: user.role },
              minorUnit: country.minorUnit,
              orderPrefix: country.orderPrefix,
              attempt,
              allowNegativeStock: country.allowNegativeStock,
            }),
          { timeout: 30_000 }
        );
        break;
      } catch (e) {
        // A duplicate order number means somebody took it between reading the highest and inserting.
        if ((e as { code?: string }).code === 'P2002') {
          if (attempt < 4) continue;
          break; // five clashes: answered in words below, not as a crash
        }
        throw e;
      }
    }
    if (!result) {
      return NextResponse.json({ error: 'تعذّر إصدار رقم للطلب البديل — أعد المحاولة', code: 'NUMBER_CLASH' }, { status: 409 });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARCEL_SWAPPED',
      entity: 'SettlementMatch',
      entityId: result.line.matchId,
      newData: {
        statement: result.reference,
        sale: result.sale.orderNumber,
        owner: result.owner.orderNumber,
        box: result.box.orderNumber,
        pieces: result.box.pieces,
        boxTotal: result.box.total,
        boxEndedAs: result.box.endedAs,
        ownerBoxBack: result.owner.boxBack,
        reshaped: result.sale.reshaped,
        lineResult: result.line.result,
        stock: result.stock,
        counters: result.counters,
        commission: result.commission,
        closedRequests: result.closedRequests,
      },
    });

    await announceSwap({
      companyId,
      sale: {
        id: result.sale.id,
        orderNumber: result.sale.orderNumber,
        total: result.sale.total,
        currency: result.sale.currency,
        replacesOrderNumber: result.owner.orderNumber,
      },
      box: {
        id: result.box.id,
        orderNumber: result.box.orderNumber,
        totalAmount: result.boxRow.totalAmount,
        currency: result.boxRow.currency,
        trackingNumber: result.boxRow.trackingNumber,
        previousStatus: result.boxRow.shippingStatus,
        endedAs: result.box.endedAs,
      },
    });

    return NextResponse.json({
      swap: {
        sale: result.sale,
        owner: result.owner,
        box: result.box,
        line: result.line,
        commission: result.commission,
      },
      message: `سُجّل التبديل: بضاعة ${result.box.orderNumber} صارت بيعة زبون ${result.owner.orderNumber} بالطلب ${result.sale.orderNumber}`,
    });
  } catch (error) {
    if (error instanceof SwapRefused) return NextResponse.json(error.body, { status: error.status });
    return apiErrorResponse(error);
  }
}
