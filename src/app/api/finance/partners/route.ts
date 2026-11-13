import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { numeric } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { activeSharesTotal, shareHundredths, sharesProblem } from '@/lib/partner-statement-core';

/**
 * THE PARTNERS AND THEIR SHARES — «الشركاء والنسب» (13/11).
 *
 *   GET  /api/finance/partners   the saved list, for the settings card
 *   PUT  /api/finance/partners   save the whole list
 *
 * «هلأ احنا ٤ شركاء … الربح لازم يتم توزيعه وفق هاي النسب» (the owner; the four are typed on the settings card). EVERY handler asks
 * `finance.partners` FIRST, before the body is read — the key is granted to nobody by any migration, seed or fallback: the owner's
 * full access holds it and he ticks it for whoever he wants.
 *
 * THE LIST IS SAVED AS A WHOLE, AND ONLY IF IT IS WHOLE. The active shares must total exactly 100.00 (`sharesProblem`, the very
 * function the card validates with, so the sentence read before pressing is the sentence answered here). Every partner already saved
 * must be in the request: a stale tab that never saw a partner added elsewhere is told to reload instead of silently dropping him
 * from the split. A partner is never deleted — there is no way to ask for it here, and `wallet_movements.partnerId` is RESTRICT, so a
 * partner with a draw could not be removed even from the database; he is switched off, and stays in the statement while his draws stand.
 *
 * No row is written by a migration or by this file on its own: the four are typed on the card and saved by the owner's press.
 */

const bodySchema = z.object({
  partners: z
    .array(
      z.object({
        // Present on a partner already saved, absent on a new row.
        id: z.string().uuid().optional(),
        name: z.string(),
        // The characters a box holds, read by the strict reader (no «0x10», no «2,5»); the range and the decimals are `sharesProblem`'s.
        sharePercent: numeric(),
        isActive: z.boolean(),
      })
    )
    .max(100),
});

const ORDER = [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];

const view = (p: { id: string; name: string; sharePercent: unknown; isActive: boolean; sortOrder: number }) => ({
  id: p.id,
  name: p.name,
  sharePercent: Number(p.sharePercent),
  isActive: p.isActive,
  sortOrder: p.sortOrder,
});

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('finance.partners');

    const partners = (await db.partner.findMany({ where: { companyId }, orderBy: ORDER })).map(view);
    return NextResponse.json({ partners, sharesTotal: activeSharesTotal(partners) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('finance.partners');

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error), code: 'INVALID_PARTNERS' }, { status: 400 });
    }
    const rows = parsed.data.partners;

    const refusal = sharesProblem(rows);
    if (refusal) return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 400 });

    const before = await db.partner.findMany({ where: { companyId }, orderBy: ORDER });
    const known = new Set(before.map((p) => p.id));
    const named = rows.flatMap((r) => (r.id ? [r.id] : []));
    if (named.some((id) => !known.has(id)) || new Set(named).size !== named.length) {
      return NextResponse.json(
        { error: 'في شريك ما بينعرف أو انذكر مرتين — حدّث الصفحة وجرّب من جديد.', code: 'UNKNOWN_PARTNER' },
        { status: 409 }
      );
    }
    if (before.some((p) => !named.includes(p.id))) {
      return NextResponse.json(
        { error: 'القائمة ناقصة: في شريك محفوظ ما انبعت — حدّث الصفحة وجرّب من جديد.', code: 'STALE_LIST' },
        { status: 409 }
      );
    }

    const saved = await db.$transaction(async (tx) => {
      const out = [];
      for (const [i, r] of rows.entries()) {
        const data = {
          name: r.name.trim(),
          // hundredths of a percent, read back as a percent: 33.33 and never 33.330000000000005
          sharePercent: (shareHundredths(r.sharePercent) as number) / 100,
          isActive: r.isActive,
          sortOrder: i,
        };
        out.push(r.id ? await tx.partner.update({ where: { id: r.id }, data }) : await tx.partner.create({ data: { companyId, ...data } }));
      }
      return out;
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNERS_SAVED',
      entity: 'Partner',
      entityId: companyId,
      previousData: { partners: before.map(view) },
      newData: { partners: saved.map(view) },
    });

    const partners = saved.map(view);
    return NextResponse.json({ partners, sharesTotal: activeSharesTotal(partners) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'في شريك بنفس الاسم — غيّر اسم وحد منهم وجرّب من جديد.', code: 'NAME_TAKEN' },
        { status: 409 }
      );
    }
    return apiErrorResponse(error);
  }
}
