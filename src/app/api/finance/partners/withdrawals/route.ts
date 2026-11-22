import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { cancelWithdrawal, recordWithdrawal, saveStanding, withdrawalsBook } from '@/lib/partner-withdrawals';
import type { Refusal } from '@/lib/partner-withdrawals-core';

/**
 * «المسحوبات» — THE PARTNERS' WITHDRAWALS, RECORDED PER STORE AND CURRENCY (22/11).
 *
 *   GET   the tab: the partners, the stores' currencies, the standing amounts, this store's rows and the totals
 *   POST  «سجّل مسحوب» — one row (from the standing amount, or a typed one)
 *   PATCH «إلغاء» — a reversing row with the written reason, never a delete
 *   PUT   the standing amounts of one partner, one per currency
 *
 * «الأرباح: حط شاشة مسحوبات وحط العملات» (the owner). EVERY handler asks `finance.partners` («الشركاء والسحوبات») FIRST, before the
 * body is read: the key that already holds the partners' whole business, granted to nobody by any migration — the owner's full access
 * holds it and he ticks it for whoever he wants. No second key is asked because no cash moves: this is a record, not a wallet movement
 * (the wallet dialog's draw asks the cash box's key because cash leaves a wallet there).
 */

const refuse = (r: Refusal) => NextResponse.json({ error: r.errorAr, errorAr: r.errorAr, code: r.code }, { status: r.status });
const readBody = async (req: Request) => {
  const b = await req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
};
const BAD_BODY: Refusal = { status: 400, code: 'INVALID_BODY', errorAr: 'الطلب مش مفهوم.' };

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.partners');

    return NextResponse.json(await withdrawalsBook({ user, companyId, storeId }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.partners');

    const body = await readBody(req);
    if (!body) return refuse(BAD_BODY);
    const done = await recordWithdrawal({ user, companyId, storeId, body });
    if (!done.ok) return refuse(done.refusal);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_WITHDRAWAL_RECORDED',
      entity: 'PartnerWithdrawal',
      entityId: done.value.id,
      newData: { ...done.value, storeId },
    });
    return NextResponse.json({ withdrawal: done.value }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('finance.partners');

    const body = await readBody(req);
    if (!body) return refuse(BAD_BODY);
    const done = await cancelWithdrawal({ user, companyId, storeId, body });
    if (!done.ok) return refuse(done.refusal);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_WITHDRAWAL_CANCELLED',
      entity: 'PartnerWithdrawal',
      entityId: done.value.originalId,
      newData: { ...done.value, storeId },
    });
    return NextResponse.json({ cancel: done.value });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('finance.partners');

    const body = await readBody(req);
    if (!body) return refuse(BAD_BODY);
    const done = await saveStanding({ user, companyId, body });
    if (!done.ok) return refuse(done.refusal);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PARTNER_STANDING_SAVED',
      entity: 'PartnerStandingAmount',
      entityId: done.value.partnerId,
      newData: done.value,
    });
    return NextResponse.json({ standing: done.value });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
