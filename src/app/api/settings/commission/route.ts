import { ASSIGNABLE_ROLES } from '@/types/auth';
import {
  COMMISSION_METRICS, COMMISSION_PERIODS, COMMISSION_TYPES, tiersProblem,
} from '@/lib/commission-rules';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { zodMessage } from '@/lib/zod-message';

/**
 * Commission rules — DATA, not code.
 *
 *   GET   /api/settings/commission
 *   POST  /api/settings/commission     add a rule with its effective date
 *   PATCH /api/settings/commission     end a rule (never edit history)
 *
 * A rule is never edited in place: changing the numbers would silently
 * rewrite what people already earned. Ending a rule and starting a new one
 * from a date keeps every closed period exactly as it was.
 */

const tierSchema = z.object({
  from: z.number().min(0),
  to: z.number().min(0).nullable(),
  value: z.number().min(0).max(1_000_000),
  label: z.string().trim().max(40).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  appliesToRole: z.string().trim().max(40).optional().nullable(),
  appliesToUserId: z.string().uuid().optional().nullable(),
  type: z.enum(COMMISSION_TYPES),
  value: z.number().min(0).max(1_000_000).default(0),
  metric: z.enum(COMMISSION_METRICS).default('ORDER_DELIVERED'),
  period: z.enum(COMMISSION_PERIODS).default('PER_ORDER'),
  /** Bands. Absent means the single `value` above, as every older rule is. */
  tiers: z.array(tierSchema).max(20).optional().nullable(),
  productId: z.string().uuid().optional().nullable(),
  minOrders: z.number().int().min(0).max(100_000).optional().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

});

const endSchema = z.object({
  ruleId: z.string().uuid(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('commission.view');

    const rules = await db.commissionRule.findMany({
      // This store's agreement. One store's arrangement with its agents is
      // not the other's to read, let alone to be paid under.
      where: { companyId, storeId },
      orderBy: [{ isActive: 'desc' }, { effectiveFrom: 'desc' }],
    });
    const userIds = rules.map((r) => r.appliesToUserId).filter(Boolean) as string[];
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    // A store with no rule in force earns nobody anything — which is
    // correct, and reads on the screen as a quiet month rather than as a
    // rule somebody forgot to write. The screen says it plainly instead.
    const now = new Date();
    const inForce = rules.filter(
      (r) => r.isActive && r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo >= now)
    );

    return NextResponse.json({
      rules: rules.map((r) => ({
        ...r,
        value: Number(r.value),
        tiers: r.tiers ?? null,
        appliesToUserName: r.appliesToUserId ? nameOf.get(r.appliesToUserId) ?? null : null,
        inForce: r.isActive && r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo >= now),
      })),
      /** No rule in force: nothing accrues, and the screen must say why. */
      noRuleInForce: inForce.length === 0,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('commission.manage');

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;
    if (!input.appliesToRole && !input.appliesToUserId) {
      return NextResponse.json({ error: 'حدّد الدور أو الموظف الذي تنطبق عليه القاعدة' }, { status: 400 });
    }

    // A rule for a role nobody holds never fires, and the screen shows it as
    // active — so it is refused at the door. The screen listed two role
    // names the system does not use, and every rule written for them paid
    // nothing while looking correct.
    if (input.appliesToRole && !(ASSIGNABLE_ROLES as string[]).includes(input.appliesToRole)) {
      return NextResponse.json({ error: 'هذا الدور غير موجود في النظام' }, { status: 400 });
    }

    // A rule for one person: they must be in this company.
    if (input.appliesToUserId) {
      const person = await db.user.findFirst({
        where: { id: input.appliesToUserId, companyId },
        select: { id: true },
      });
      if (!person) return NextResponse.json({ error: 'الموظف غير موجود' }, { status: 404 });
    }

    // Bands that cannot be read two ways. Overlapping ones are not a
    // formatting problem: somebody inside both earns whichever the code
    // happens to check first, and that changes if the list is reordered.
    if (input.tiers && input.tiers.length > 0) {
      const problem = tiersProblem(input.tiers);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    } else if (input.value <= 0) {
      return NextResponse.json({ error: 'أدخل قيمة القاعدة أو شرائحها' }, { status: 400 });
    }

    // A rate is a percentage: bands over 100 would never be reached.
    if (input.metric === 'DELIVERY_RATE' && input.tiers?.some((t) => t.from > 100)) {
      return NextResponse.json({ error: 'نسبة التسليم من 0 إلى 100 — راجع الشرائح' }, { status: 400 });
    }

    // A span nobody can close pays nothing: a metric counted per order has
    // no day to add up, and a daily count is not a fact about one order.
    if ((input.period === 'PER_ORDER') !== (input.metric === 'ORDER_DELIVERED')) {
      return NextResponse.json(
        { error: 'المقياس «كل طلب مسلَّم» يُحتسب مع كل طلب، وبقية المقاييس تحتاج فترة (يومي أو أسبوعي أو شهري)' },
        { status: 400 }
      );
    }

    const rule = await db.commissionRule.create({
      data: {
        companyId,
        // From the session, never the body.
        storeId,
        name: input.name,
        appliesToRole: input.appliesToUserId ? null : input.appliesToRole ?? null,
        appliesToUserId: input.appliesToUserId ?? null,
        basis: 'ORDER_DELIVERED', // accrual point per contract
        type: input.type,
        value: input.value,
        metric: input.metric,
        period: input.period,
        tiers: input.tiers && input.tiers.length > 0 ? input.tiers : undefined,
        productId: input.productId ?? null,
        /*
         * THE SAMPLE FLOOR, AND THE CONTRACT'S NUMBER WHEN NOBODY TYPES ONE.
         *
         * «Delivery-rate tiers with a minimum sample of 30 orders.» There were
         * TWO columns for this and they did not agree: `minSampleOrders`
         * carried the 30 (defaulted here, shown in no screen) and was read by
         * NOTHING, while `minOrders` — the one `earnedBy` actually checks
         * against the sample — was optional and null on every rule in the
         * database. So the floor the contract names was stored and ignored,
         * and «100% out of two orders» cleared every band, which is the exact
         * case `earnedBy`'s own comment warns about.
         *
         * One column now. A rate rule left blank takes the contract's 30
         * rather than no floor at all; any other metric keeps «blank means no
         * floor», because a count of confirmed orders is not a ratio and a
         * small sample does not lie about it.
         */
        minOrders: input.minOrders ?? (input.metric === 'DELIVERY_RATE' ? 30 : null),
        effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00.000Z`),
        createdById: user.id,
      },
    });

    await logAudit({
      companyId, userId: user.id, action: 'COMMISSION_RULE_CREATED',
      entity: 'CommissionRule', entityId: rule.id, newData: input,
    });

    return NextResponse.json({ rule: { ...rule, value: Number(rule.value) } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('commission.manage');

    const parsed = endSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const rule = await db.commissionRule.findFirst({ where: { id: parsed.data.ruleId, companyId, storeId } });
    if (!rule) return NextResponse.json({ error: 'القاعدة غير موجودة' }, { status: 404 });

    const ended = await db.commissionRule.update({
      where: { id: rule.id },
      data: { effectiveTo: new Date(`${parsed.data.effectiveTo}T23:59:59.000Z`), isActive: false },
    });

    await logAudit({
      companyId, userId: user.id, action: 'COMMISSION_RULE_ENDED',
      entity: 'CommissionRule', entityId: rule.id,
      previousData: { effectiveTo: rule.effectiveTo, isActive: rule.isActive },
      newData: { effectiveTo: parsed.data.effectiveTo },
    });

    return NextResponse.json({ rule: { ...ended, value: Number(ended.value) } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
