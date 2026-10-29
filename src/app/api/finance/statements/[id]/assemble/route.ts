import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';
import { assembleDraft, ManualRefused } from '@/lib/manual-statement';
import { duplicateReferenceSentence } from '@/lib/manual-statement-rules';

/**
 * POST /api/finance/statements/:id/assemble — «تجميع», the second press of the manual statement.
 *
 *   { reference, periodFrom?, periodTo? }
 *
 * Turns the courier's open draft into a statement: the reference is the person's, and it is unique PER COURIER (it
 * is hashed with the company and the courier), so two couriers may both have «كشف الأحد». From here on it is an
 * ordinary statement — the receipt (a wallet, and a rate when its currency differs), the matching and the
 * approval are the existing doors, unchanged.
 *
 * It moves no money. A total of zero or less is refused with the sentences «استلمت منه» uses.
 */
const schema = z
  .object({
    reference: z.string().trim().min(2, 'اكتب مرجعاً للكشف (حرفان على الأقل)').max(80),
    periodFrom: z.string().datetime().optional().nullable(),
    periodTo: z.string().datetime().optional().nullable(),
  })
  .refine((v) => !v.periodFrom || !v.periodTo || new Date(v.periodFrom) <= new Date(v.periodTo), {
    message: 'بداية الفترة بعد نهايتها',
    path: ['periodTo'],
  });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settlement.upload');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    let result;
    try {
      result = await db.$transaction(
        (tx) =>
          assembleDraft(tx, {
            companyId,
            storeId,
            statementId: id,
            reference: input.reference,
            periodFrom: input.periodFrom ? new Date(input.periodFrom) : null,
            periodTo: input.periodTo ? new Date(input.periodTo) : null,
            minorUnit: country.minorUnit,
          }),
        { timeout: 30_000 }
      );
    } catch (e) {
      if (e instanceof ManualRefused) return NextResponse.json(e.body, { status: e.status });
      // The hash is unique in the database too: two presses that both passed the read still cannot both win.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json(
          { code: 'DUPLICATE_REFERENCE', error: duplicateReferenceSentence(input.reference) },
          { status: 409 }
        );
      }
      throw e;
    }

    await logAudit({
      companyId, userId: user.id, action: 'STATEMENT_MANUAL_ASSEMBLED',
      entity: 'CourierStatement', entityId: id,
      newData: { reference: result.reference, courier: result.courier, lines: result.lines, total: result.total },
    });

    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
