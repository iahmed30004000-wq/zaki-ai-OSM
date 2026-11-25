import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant, tenantOf } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { readLimit, readPage } from '@/lib/numeric-input';
import { CLIENT_ERROR_KINDS, cleanClientError } from '@/lib/client-error';

/**
 * «ZAKI ORDERS» — CRASHES AND FROZEN SCREENS, SENT BY THE PHONE AND READ BY THE MANAGER (22/11).
 *
 *   POST /api/client-errors  `{ errors: [...] }` (up to 20 at once — the app sends what it kept while offline).
 *                            Any signed-in, active person: the phone that crashed is somebody's. Who sent it is the
 *                            session's, never the body's. 120 reports per person per ten minutes — a crash loop must
 *                            not fill the table.
 *   GET  /api/client-errors  `?kind=&version=&page=&limit=` — `audit.view`, this company's rows, newest first.
 *
 * No customer data: the app sends none, and `cleanClientError` cuts every field and blanks long digit runs (a phone
 * number in an exception message) before anything is written.
 */
const report = z.object({
  kind: z.enum(CLIENT_ERROR_KINDS),
  message: z.string().max(10_000),
  stack: z.string().max(100_000).nullish(),
  screen: z.string().max(500).nullish(),
  appVersion: z.string().min(1).max(100),
  versionCode: z.number().int().min(0).max(2_147_483_647).nullish(),
  device: z.string().max(500).nullish(),
  osVersion: z.string().max(100).nullish(),
  occurredAt: z.string().max(40),
});
const body = z.object({ errors: z.array(report).min(1).max(20) });

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const limit = rateLimit(`client-errors:${user.id}`, 120, 10 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'تقارير كثيرة، رح تنبعت لاحقاً', errorAr: 'تقارير كثيرة، رح تنبعت لاحقاً' }, { status: 429 });
    }
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'تقرير العطل غير مفهوم', errorAr: 'تقرير العطل غير مفهوم' }, { status: 400 });
    }
    const now = new Date();
    await db.clientError.createMany({
      data: parsed.data.errors.map((e) => ({ companyId, userId: user.id, ...cleanClientError(e, now) })),
    });
    return NextResponse.json({ ok: true, received: parsed.data.errors.length });
  } catch (error) {
    const { body: b, status } = apiError(error);
    return NextResponse.json(b, { status });
  }
}

export async function GET(req: Request) {
  try {
    const viewer = await requirePermission('audit.view');
    const { companyId } = await tenantOf(viewer);
    const url = new URL(req.url);
    const page = readPage(url.searchParams);
    const take = readLimit(url.searchParams, 50, 200);
    const kind = url.searchParams.get('kind');
    const version = url.searchParams.get('version')?.trim();
    const where = {
      companyId,
      ...(kind && (CLIENT_ERROR_KINDS as readonly string[]).includes(kind) ? { kind } : {}),
      ...(version ? { appVersion: version.slice(0, 100) } : {}),
    };
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [rows, total, week] = await Promise.all([
      db.clientError.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * take, take }),
      db.clientError.count({ where }),
      db.clientError.groupBy({ by: ['kind'], where: { companyId, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
    const names = new Map(
      userIds.length
        ? (await db.user.findMany({ where: { id: { in: userIds }, companyId }, select: { id: true, name: true } })).map((u) => [u.id, u.name])
        : []
    );
    return NextResponse.json({
      errors: rows.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? null) : null })),
      total,
      page,
      limit: take,
      lastWeek: Object.fromEntries(week.map((w) => [w.kind, w._count._all])),
    });
  } catch (error) {
    const { body: b, status } = apiError(error);
    return NextResponse.json(b, { status });
  }
}
