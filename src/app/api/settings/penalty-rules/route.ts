import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { PENALTY_KEYS, PENALTY_KINDS } from '@/lib/penalties';
import { ASSIGNABLE_ROLES } from '@/types/auth';

/**
 * GET/POST/PATCH /api/settings/penalty-rules — the rules that PROPOSE a
 * deduction. None of them applies one.
 *
 * Grace and a cap are required by the schema below rather than left to
 * whoever fills the form. A rule with no grace charges somebody every day
 * traffic exists, and a deduction that happens every day stops being a
 * signal about anything. A rule with no cap can eat a salary over one
 * illness. Both are the kind of mistake nobody notices until payday.
 */

const schema = z.object({
  kind: z.enum(PENALTY_KEYS as [string, ...string[]]),
  /** Null = every store; null role = everyone. */
  storeId: z.string().uuid().nullable().optional(),
  role: z.string().max(40).nullable().optional(),
  perUnit: z.number().positive().max(1_000_000),
  grace: z.number().int().min(0).max(100_000),
  periodCap: z.number().positive().max(10_000_000).nullable(),
  currencyCode: z.string().trim().length(3).toUpperCase(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
});

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    const rules = await db.penaltyRule.findMany({
      where: { companyId },
      orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
    });
    return NextResponse.json({
      kinds: PENALTY_KINDS,
      roles: ASSIGNABLE_ROLES,
      rules: rules.map((r) => ({
        ...r,
        perUnit: Number(r.perUnit),
        periodCap: r.periodCap === null ? null : Number(r.periodCap),
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('penalties.rules');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const d = parsed.data;

    const rule = await db.penaltyRule.create({
      data: {
        companyId,
        kind: d.kind,
        storeId: d.storeId ?? null,
        role: d.role || null,
        perUnit: d.perUnit,
        grace: d.grace,
        periodCap: d.periodCap,
        currencyCode: d.currencyCode,
        effectiveFrom: d.effectiveFrom ? new Date(d.effectiveFrom) : new Date(),
        effectiveTo: d.effectiveTo ? new Date(d.effectiveTo) : null,
        createdById: user.id,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PENALTY_RULE_CREATED',
      entity: 'PenaltyRule',
      entityId: rule.id,
      newData: { kind: d.kind, perUnit: d.perUnit, grace: d.grace, periodCap: d.periodCap, role: d.role ?? null },
    });

    return NextResponse.json({ rule: { ...rule, perUnit: Number(rule.perUnit) } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Switch a rule off, or end it.
 *
 * A rule is never deleted: the deductions it produced point at it, and a
 * missing rule makes an old charge unexplainable a year later.
 */
export async function PATCH(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('penalties.rules');

    const body = (await req.json().catch(() => null)) as { id?: string; isActive?: boolean } | null;
    if (!body?.id || typeof body.isActive !== 'boolean') {
      return NextResponse.json({ error: 'حدّد القاعدة والحالة' }, { status: 400 });
    }

    const rule = await db.penaltyRule.findFirst({ where: { id: body.id, companyId }, select: { id: true, isActive: true } });
    if (!rule) return NextResponse.json({ error: 'القاعدة غير موجودة' }, { status: 404 });

    await db.penaltyRule.update({ where: { id: rule.id }, data: { isActive: body.isActive } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PENALTY_RULE_UPDATED',
      entity: 'PenaltyRule',
      entityId: rule.id,
      previousData: { isActive: rule.isActive },
      newData: { isActive: body.isActive },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
