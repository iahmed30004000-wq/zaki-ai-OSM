import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { applyPenalty, retargetShortfall, reversePenalty, waivePenalty, PenaltyRefused } from '@/lib/penalty-service';
import { PENALTY_KINDS, PENALTY_STATUSES, SHORTFALL_KIND_INFO } from '@/lib/penalties';
import { NEVER_CHARGED_ROLES } from '@/lib/shortfall';
import { notify } from '@/lib/notify';

/**
 * GET/POST /api/team/penalties — what the system proposed, and what a
 * person decided about it.
 *
 * Reading and deciding are two permissions on purpose. Looking at a list of
 * who was late is supervision; taking money off somebody is not, and one
 * key for both would hand the second to everybody who needed the first.
 *
 * Nothing here deletes. A deduction is waived before it becomes money or
 * reversed after, and both leave a row saying so.
 */

const REFUSAL_AR: Record<string, string> = {
  NOT_FOUND: 'الخصم غير موجود',
  BAD_TRANSITION: 'لا يمكن نقل الخصم من حالته الحالية إلى هذه',
  REASON_REQUIRED: 'اكتب السبب — خصمٌ يُلغى بلا سبب لا يُفرَّق عن محاباة',
  ALREADY_PAID: 'سُوّي هذا الخصم مع صرفية سابقة — تصحيحه حركة جديدة لا تعديل للماضي',
  NO_RULE: 'لا قاعدة خصم سارية',
  ESTIMATED: 'وقت الوصول مُقدَّر لا مُسجَّل — لا يُخصم عليه',
  SELF_DECISION: 'لا تقرّر في خصمٍ عليك أنت — يقرّره غيرك',
  NOT_SHORTFALL: 'التحويل لموظف آخر لفرق التحصيل وحده',
  BAD_TARGET: 'اختر موظفاً فعّالاً غير المالك والمدراء وغيرك وغير الحالي',
  CHANGED: 'الخصم تغيّر هلّق — حدّث الصفحة',
};

export async function GET(req: Request) {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('penalties.view');

    const q = new URL(req.url).searchParams;

    // The people a «فرق تحصيل» may be moved to — read by the one who decides, for the «حوّل» box. A roster is not
    // what supervision needs, so it takes the deciding key too.
    if (q.get('people') === '1') {
      await requirePermission('penalties.decide');
      const people = await db.user.findMany({
        where: { companyId, status: 'ACTIVE', role: { notIn: [...NEVER_CHARGED_ROLES] } },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      });
      return NextResponse.json({ people });
    }

    const status = q.get('status');
    const userId = q.get('userId');

    const rows = await db.penalty.findMany({
      where: {
        companyId,
        storeId,
        ...(status && (PENALTY_STATUSES as readonly string[]).includes(status) ? { status } : {}),
        ...(userId ? { userId } : {}),
      },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
      take: 300,
      select: {
        id: true, kind: true, occurredOn: true, units: true, chargedUnits: true,
        amount: true, currencyCode: true, status: true, note: true, decisionNote: true,
        decidedAt: true, payslipId: true, reversesId: true,
        // A «فرق تحصيل» says which statement line it is about; the others have none.
        settlementMatchId: true,
        user: { select: { id: true, name: true, role: true } },
        decidedById: true,
      },
    });

    return NextResponse.json({
      kinds: [...PENALTY_KINDS, SHORTFALL_KIND_INFO],
      penalties: rows.map((r) => ({ ...r, amount: Number(r.amount) })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const schema = z
  .object({
    penaltyId: z.string().uuid(),
    action: z.enum(['apply', 'waive', 'reverse', 'retarget']),
    note: z.string().trim().max(500).optional(),
    /** `retarget` only: the person the «فرق تحصيل» really belongs to. */
    userId: z.string().uuid().optional(),
  })
  .refine((v) => v.action !== 'retarget' || !!v.userId, { message: 'حدّد الموظف المسؤول', path: ['userId'] });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    // Deciding is its own key. Seeing the list is not permission to charge.
    await requirePermission('penalties.decide');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // This company and this store — an id is not an authority.
    const target = await db.penalty.findFirst({
      where: { id: parsed.data.penaltyId, companyId, storeId },
      select: { id: true, userId: true, kind: true, amount: true, currencyCode: true, status: true },
    });
    if (!target) return NextResponse.json({ error: REFUSAL_AR.NOT_FOUND }, { status: 404 });

    const input = { penaltyId: target.id, decidedById: user.id, note: parsed.data.note };
    let movedTo: string | null = null;
    try {
      if (parsed.data.action === 'retarget') {
        // The old row is waived «ليس المسؤول» and a new PROPOSED one is written, in one transaction.
        const moved = await db.$transaction((tx) =>
          retargetShortfall(tx, { ...input, companyId, toUserId: parsed.data.userId! })
        );
        movedTo = moved.userId;
      } else {
        const run =
          parsed.data.action === 'apply' ? applyPenalty : parsed.data.action === 'waive' ? waivePenalty : reversePenalty;
        await db.$transaction((tx) => run(tx, input));
      }
    } catch (e) {
      if (e instanceof PenaltyRefused) {
        return NextResponse.json({ error: REFUSAL_AR[e.reason] ?? e.reason, code: e.reason }, { status: 409 });
      }
      throw e;
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: `PENALTY_${parsed.data.action.toUpperCase()}`,
      entity: 'Penalty',
      entityId: target.id,
      previousData: { status: target.status },
      newData: {
        employeeId: target.userId,
        kind: target.kind,
        amount: Number(target.amount),
        currency: target.currencyCode,
        reason: parsed.data.note ?? null,
        ...(movedTo ? { movedTo } : {}),
      },
    });

    if (movedTo) {
      // The person it now belongs to hears of it, like the first one did at the approval.
      notify({
        companyId,
        storeId,
        audience: { userIds: [movedTo] },
        actorId: user.id,
        title: 'فرق تحصيل عليك — بانتظار القرار',
        message: `${target.currencyCode} ${Number(target.amount)} — حُوّل إليك لأنك من سلّم الطرد. إن كان عندك تفسير فاحكِ مع المحاسب أو المالك.`,
        type: 'SYSTEM_ALERT',
        link: '/control/penalties',
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
