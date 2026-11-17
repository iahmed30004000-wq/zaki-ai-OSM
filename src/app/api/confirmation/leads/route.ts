import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { leadsV2Switch } from '@/lib/leads/leads-v2-switch';
import { convertLead, convertSchema, dismissLead, readLeadLane } from '@/lib/leads/lead-lane';

/**
 * GET/POST /api/confirmation/leads — THE LEAD LANE (step E2 of Confirmation Center v2): the leads the pages system sent, oldest first, each with the live offers its product is sold by; convert one
 * into a NORMAL order through the existing landing door, or dismiss it.
 *
 * OFF unless the owner turned «ليدز الصفحات» on (\`leads-v2-switch.ts\`): GET answers \`{ enabled: false }\` and POST is refused. Whoever works the queue (\`confirmation.pull\`) or supervises it
 * (\`confirmation.supervise\`) may read and work the lane. A conversion takes an OFFER id and the address (the only things the agent chooses): the price is the offer's, the order is made by
 * \`takeLandingOrder\` — nothing here prices or writes an order. One audit line each (\`LEAD_CONVERTED\`, \`LEAD_DISMISSED\`).
 */
const refuse = (said: string, code: string, status = 400) => NextResponse.json({ error: said, errorAr: said, code }, { status });

async function minorUnitOf(storeId: string): Promise<number> {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { country: { select: { minorUnit: true } } } });
  return store?.country.minorUnit ?? 2;
}

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'confirmation.pull')) await requirePermission('confirmation.supervise');
    if (!(await leadsV2Switch(db, companyId)).enabled) return NextResponse.json({ enabled: false });
    const leads = await readLeadLane(db, { companyId, storeId }, await minorUnitOf(storeId), new Date());
    return NextResponse.json({ enabled: true, leads });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    if (!can(user, 'confirmation.pull')) await requirePermission('confirmation.supervise');
    if (!(await leadsV2Switch(db, companyId)).enabled) return refuse('ليدز الصفحات مش مفعّل.', 'LEADS_V2_OFF', 409);

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const scope = { companyId, storeId };

    if (body?.action === 'dismiss') {
      if (typeof body.leadId !== 'string') return refuse('حدّد الليد.', 'INVALID_LEAD');
      if (!(await dismissLead(db, scope, body.leadId))) return refuse('الليد مش بالقايمة.', 'LEAD_NOT_FOUND', 404);
      await logAudit({ companyId, userId: user.id, action: 'LEAD_DISMISSED', entity: 'Lead', entityId: body.leadId });
      return NextResponse.json({ ok: true });
    }

    if (body?.action === 'convert') {
      const parsed = convertSchema.safeParse(body);
      if (!parsed.success) return refuse('اختار العرض واكتب العنوان.', 'INVALID_CONVERSION');
      const done = await convertLead(db, scope, parsed.data, await minorUnitOf(storeId));
      if (!done.ok) return refuse(done.message, done.code, done.status);
      await logAudit({ companyId, userId: user.id, action: 'LEAD_CONVERTED', entity: 'Lead', entityId: parsed.data.leadId, newData: { orderNumber: done.orderNumber, offerId: parsed.data.offerId } });
      return NextResponse.json({ ok: true, orderNumber: done.orderNumber });
    }

    return refuse('الإجراء غير معروف.', 'INVALID_ACTION');
  } catch (error) {
    return apiErrorResponse(error);
  }
}
