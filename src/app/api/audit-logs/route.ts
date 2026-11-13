import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { can, requirePermission } from '@/lib/authorization';
import { withoutPay } from '@/lib/audit-pay-redact';
import { withoutPartners } from '@/lib/audit-partners-redact';
import { readPage, readLimit } from '@/lib/numeric-input';
import { auditWhere, readAuditQuery } from '@/lib/audit-view';

/**
 * GET /api/audit-logs — the trail, read in pages.
 *
 * It used to be the newest hundred and nothing else: the hundred-and-first change was
 * unreachable, and «what did Samer do on Tuesday» meant scrolling a hundred rows. Now it
 * takes who / what kind of record / a word / a span of days, and answers one page of whatever
 * matched with how many matched in all. The company is always the session's own.
 *
 * `facts` are what the dropdowns count — over the whole company, not over the current choice,
 * so choosing a person does not make every other person vanish from the list of people.
 */
export async function GET(req: Request) {
  try {
    const { companyId } = await requireCompanyTenant();
    const viewer = await requirePermission('audit.view');

    const params = new URL(req.url).searchParams;
    const query = readAuditQuery(params);
    const where = auditWhere(companyId, query);
    const limit = readLimit(params, 25, 100);
    const wanted = readPage(params);

    const total = await db.auditLog.count({ where });
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(wanted, totalPages);

    const [logs, byUser, byEntity] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.auditLog.groupBy({ by: ['userId'], where: { companyId }, _count: { _all: true } }),
      db.auditLog.groupBy({ by: ['entity'], where: { companyId }, _count: { _all: true } }),
    ]);

    const names = await db.user.findMany({
      where: { id: { in: byUser.flatMap((u) => (u.userId ? [u.userId] : [])) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((u) => [u.id, u.name]));

    // Two keys, two cuts, each independent of the other: a reader may hold either, both or neither.
    const mayPay = can(viewer, 'payroll.view');
    const mayPartners = can(viewer, 'finance.partners');
    const shown = logs.map((row) => {
      const afterPay = mayPay ? row : withoutPay(row);
      return mayPartners ? afterPay : withoutPartners(afterPay);
    });

    return NextResponse.json({
      // Salaries, payslips, penalties and payouts keep their rows and lose
      // their amounts for a reader without «عرض الرواتب» (audit-pay-redact.ts);
      // the partners' names, shares and draws keep theirs and lose their
      // figures for a reader without «الشركاء والسحوبات» (audit-partners-redact.ts).
      logs: shown,
      pagination: { total, page, limit, totalPages },
      facts: {
        users: byUser
          .map((u) => ({ id: u.userId ?? 'system', name: u.userId ? (nameOf.get(u.userId) ?? 'مستخدم محذوف') : 'النظام (تلقائي)', count: u._count._all }))
          .sort((a, b) => b.count - a.count),
        entities: byEntity.map((e) => ({ entity: e.entity, count: e._count._all })).sort((a, b) => b.count - a.count),
      },
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
