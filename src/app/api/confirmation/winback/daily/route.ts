import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { winbackV2Switch } from '@/lib/winback-v2-switch';
import { readDailyList } from '@/lib/winback-daily';
import { CALL_RESULTS, DAILY_FROM_HOURS, DAILY_TO_HOURS, MAX_CALL_NOTE } from '@/lib/winback-daily-words';

/**
 * GET/POST /api/confirmation/winback/daily — the DAILY WINBACK LIST (step F1 of Confirmation Center v2): orders lost for a changed mind, a price or five unanswered calls, and postponed
 * orders whose date was missed, each 24 to 72 hours after it happened, with who should call and what the last call came to.
 *
 * OFF unless the owner turned «الاسترجاع اليومي» on (\`winback-v2-switch.ts\`): then GET answers \`{ enabled: false }\` and POST is refused. GET needs the tab's own key, \`confirmation.supervise\`.
 *   POST { action: 'assign', orderId, userId }  names who calls — \`confirmation.reassign\`, the key of handing an order to somebody;
 *   POST { action: 'call', orderId, result, note? }  records what a call came to — \`confirmation.winback\`, the key of the winback itself.
 * Both only for an order that is ON TODAY'S LIST (re-read here), and both write ONE append-only audit line (\`WINBACK_ASSIGNED\`, \`WINBACK_CALLED\`) — never an order, a note to the customer, a
 * discount or a commission. The existing offer door is unchanged. No customer field is read: names, phones and addresses are on the order, which opens under the usual access.
 */
const ASSIGNABLE = ['CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT', 'CONFIRMATION_SUPERVISOR', 'TEAM_LEADER'];

const refuse = (said: string, code: string, status = 400) => NextResponse.json({ error: said, errorAr: said, code }, { status });

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('confirmation.supervise');
    if (!(await winbackV2Switch(db, companyId)).enabled) return NextResponse.json({ enabled: false });

    const [items, assignees] = await Promise.all([
      readDailyList(db, { companyId, storeId }),
      db.user.findMany({ where: { companyId, status: 'ACTIVE', role: { in: ASSIGNABLE } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return NextResponse.json({
      enabled: true,
      window: { fromHours: DAILY_FROM_HOURS, toHours: DAILY_TO_HOURS },
      canAssign: can(user, 'confirmation.reassign'),
      canCall: can(user, 'confirmation.winback'),
      assignees: assignees.map((a) => ({ id: a.id, name: a.name ?? '—' })),
      items,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = body?.action;
    if (action !== 'assign' && action !== 'call') return refuse('الإجراء غير معروف.', 'INVALID_ACTION');
    await requirePermission(action === 'assign' ? 'confirmation.reassign' : 'confirmation.winback');

    if (!(await winbackV2Switch(db, companyId)).enabled) return refuse('الاسترجاع اليومي مش مفعّل.', 'WINBACK_V2_OFF', 409);
    if (typeof body?.orderId !== 'string') return refuse('حدّد الطلب.', 'INVALID_ORDER');

    // only an order that is on today's list: the audit line is a record of work, not a way to write about any order
    const items = await readDailyList(db, { companyId, storeId });
    const item = items.find((i) => i.orderId === body.orderId);
    if (!item) return refuse('الطلب مش بقايمة اليوم.', 'NOT_ON_TODAYS_LIST', 409);

    if (action === 'assign') {
      if (typeof body.userId !== 'string') return refuse('حدّد مين بيتصل.', 'INVALID_ASSIGNEE');
      const who = await db.user.findFirst({ where: { id: body.userId, companyId, status: 'ACTIVE', role: { in: ASSIGNABLE } }, select: { id: true } });
      if (!who) return refuse('هالشخص مش من الفريق اللي بيتّصل.', 'INVALID_ASSIGNEE');
      await logAudit({ companyId, userId: user.id, action: 'WINBACK_ASSIGNED', entity: 'Order', entityId: item.orderId, previousData: { assigneeId: item.assignee?.id ?? null }, newData: { assigneeId: who.id } });
      return NextResponse.json({ ok: true });
    }

    const result = body.result;
    if (typeof result !== 'string' || !(CALL_RESULTS as readonly string[]).includes(result)) return refuse('اختار نتيجة الاتصال.', 'INVALID_RESULT');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_CALL_NOTE) : '';
    await logAudit({ companyId, userId: user.id, action: 'WINBACK_CALLED', entity: 'Order', entityId: item.orderId, newData: { result, ...(note ? { note } : {}) } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
