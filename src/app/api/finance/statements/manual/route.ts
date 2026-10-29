import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { addOrdersToDraft, ManualRefused } from '@/lib/manual-statement';

/**
 * POST /api/finance/statements/manual — «مطابق يدوي», the first press of the manual statement.
 *
 *   { orders: [{ orderId, amount? }] }
 *
 * The delivered orders of ONE courier join that courier's open draft statement (the draft is made by the first
 * press). A line carries the order's reference and the amount the courier handed over for it — the expected net
 * unless one was typed — so a short handover is recorded order by order.
 *
 * ── IT MOVES NO MONEY ──
 *
 * Nothing is settled, no wallet is touched, no commission becomes payable. The second press («تجميع») gives the
 * draft its reference and period, and the receipt, the matching and the approval that follow are the existing
 * ones — the money moves at the approval and nowhere earlier.
 *
 * The permission is the one that makes a statement (`settlement.upload`), not the cash box: this writes lines of a
 * statement, and the cash box is what «استلمت منه» asks for because THAT door takes cash.
 */
const schema = z.object({
  orders: z
    .array(
      z.object({
        orderId: z.string().uuid(),
        /** What the courier handed over for this order. Omitted = what we expect. */
        amount: z.number().min(-100_000_000).max(100_000_000).optional(),
      })
    )
    .min(1, 'اختر طلباً واحداً على الأقل')
    .max(500),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    let result;
    try {
      result = await db.$transaction(
        (tx) =>
          addOrdersToDraft(tx, {
            companyId,
            storeId,
            userId: user.id,
            currencyCode: country.currencyCode,
            minorUnit: country.minorUnit,
            items: parsed.data.orders,
          }),
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof ManualRefused) return NextResponse.json(e.body, { status: e.status });
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_MANUAL_ADDED',
      entity: 'CourierStatement', entityId: result.statementId,
      newData: {
        courier: result.courier, added: result.added, updated: result.updated,
        lines: result.lines, total: result.total, draftCreated: result.created,
      },
    });

    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
