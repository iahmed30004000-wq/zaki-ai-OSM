import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { hasFullAccess, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { roundMinor } from '@/lib/money';
import { numeric } from '@/lib/numeric-input';
import { zodMessage } from '@/lib/zod-message';
import { BACKFILL_SOURCE, applyBackfill, editBackfilled, planBackfill } from '@/lib/draw-backfill';

/**
 * «عبّي السعر للقديم بسعر اليوم» (23/11, F8) — THE OWNER'S EXCEPTION, `lib/draw-backfill.ts`.
 *
 *   GET    the preview: this store's old draws with no equivalent, each at today's rate, their total, and the currencies skipped
 *   POST   `{ confirm: true, expectedIds, expectedTotal }` — write exactly the previewed plan, in one transaction
 *   PATCH  `{ movementId, value }` — edit one row the exception filled, or clear it (`value: null`)
 *
 * OWNER ONLY: `finance.partners` (asked first, before the body), AND every key (`hasFullAccess`, the engine's own flag — the same
 * owner check as «ربط صفحات ذكي»). Anybody else is refused with `OWNER_ONLY` and nothing is read or written.
 */

const ownerOnly = () =>
  NextResponse.json({ error: 'تعبئة السعر للقديم للمالك وحده.', code: 'OWNER_ONLY' }, { status: 403 });

const confirmSchema = z.object({
  confirm: z.literal(true, { message: 'لازم تأكّد قبل الكتابة' }),
  expectedIds: z.array(z.string().uuid()).min(1).max(5000),
  expectedTotal: numeric(),
});
const editSchema = z.object({
  movementId: z.string().uuid(),
  value: numeric()
    .refine((v) => v > 0, { message: 'المبلغ أكبر من صفر' })
    .refine((v) => v <= 1_000_000_000, { message: 'المبلغ 1000000000 على الأكثر' })
    .nullable(),
});

export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('finance.partners');
    if (!hasFullAccess(user)) return ownerOnly();
    const plan = await planBackfill(db, { companyId, storeId, storeCode: country.currencyCode, storeMinor: country.minorUnit });
    return NextResponse.json({ ...plan, source: BACKFILL_SOURCE });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('finance.partners');
    if (!hasFullAccess(user)) return ownerOnly();
    const parsed = confirmSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error), code: 'CONFIRM_REQUIRED' }, { status: 400 });

    const out = await applyBackfill({
      companyId,
      storeId,
      storeCode: country.currencyCode,
      storeMinor: country.minorUnit,
      expectedIds: parsed.data.expectedIds,
      expectedTotal: parsed.data.expectedTotal,
    });
    if (!out.ok) return NextResponse.json({ error: out.errorAr, code: out.code }, { status: 409 });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_DRAWS_BACKFILLED',
      entity: 'WalletMovement',
      entityId: storeId,
      newData: { count: out.written, total: out.total, storeCurrency: country.currencyCode, source: BACKFILL_SOURCE, ids: out.ids },
    });
    return NextResponse.json({ written: out.written, total: out.total, skipped: out.skipped });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('finance.partners');
    if (!hasFullAccess(user)) return ownerOnly();
    const parsed = editSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error), code: 'INVALID_EDIT' }, { status: 400 });
    const { movementId, value } = parsed.data;
    if (value !== null && roundMinor(value, country.minorUnit) !== value) {
      return NextResponse.json(
        { error: `«ما يعادله» بأكثر من ${country.minorUnit} خانات عشرية — عملة المتجر (${country.currencyCode}).`, code: 'VALUE_DECIMALS' },
        { status: 400 }
      );
    }
    const out = await editBackfilled({ companyId, storeId, storeMinor: country.minorUnit, movementId, value });
    if (!out.ok) return NextResponse.json({ error: out.errorAr, code: out.code }, { status: out.status });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_DRAW_EQUIVALENT_EDITED',
      entity: 'WalletMovement',
      entityId: movementId,
      previousData: { valueInStoreCurrency: out.before },
      newData: { valueInStoreCurrency: out.after, storeCurrency: country.currencyCode },
    });
    return NextResponse.json({ movementId, before: out.before, after: out.after });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
