import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { logAudit } from '@/lib/audit';
import { normalizeAuthenticityCode } from '@/lib/authenticity';

/**
 * GET/POST/DELETE /api/settings/authenticity-codes — the owner's own list, behind `settings.authenticity_codes`.
 *
 * One add at a time, as asked: no bulk import. `GET` also returns the company's active stores, so the screen can
 * show the exact `/verify/[id]` link to share for each — the same id the public route resolves the company by.
 */

const CAP = 500;

export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.authenticity_codes');

    const [codes, stores] = await Promise.all([
      db.authenticityCode.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        take: CAP,
        select: { id: true, code: true, note: true, productId: true, scanCount: true, lastScanAt: true, createdAt: true },
      }),
      db.store.findMany({ where: { companyId, status: 'ACTIVE' }, select: { id: true, name: true } }),
    ]);
    return NextResponse.json({ codes, stores });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const schema = z.object({
  code: z.string().trim().min(3).max(64),
  note: z.string().trim().max(500).nullable().optional(),
  productId: z.string().trim().max(100).nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.authenticity_codes');

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const code = normalizeAuthenticityCode(parsed.data.code);
    if (!code) {
      return NextResponse.json({ error: 'الرمز غير صالح — حروف وأرقام وشرطات فقط، من 3 إلى 64 حرفاً' }, { status: 400 });
    }

    const existing = await db.authenticityCode.findUnique({ where: { companyId_code: { companyId, code } } });
    if (existing) {
      return NextResponse.json({ error: 'هذا الرمز مُضاف مسبقاً' }, { status: 409 });
    }

    const row = await db.authenticityCode.create({
      data: {
        companyId,
        code,
        note: parsed.data.note || null,
        productId: parsed.data.productId || null,
        createdById: user.id,
      },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'AUTHENTICITY_CODE_CREATED',
      entity: 'AuthenticityCode',
      entityId: row.id,
      newData: { code: row.code },
    });

    return NextResponse.json({ code: row }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.authenticity_codes');

    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) {
      return NextResponse.json({ error: 'حدّد الرمز' }, { status: 400 });
    }

    const row = await db.authenticityCode.findFirst({ where: { id: body.id, companyId }, select: { id: true, code: true } });
    if (!row) {
      return NextResponse.json({ error: 'الرمز غير موجود' }, { status: 404 });
    }

    await db.authenticityCode.delete({ where: { id: row.id } });
    await logAudit({
      companyId,
      userId: user.id,
      action: 'AUTHENTICITY_CODE_DELETED',
      entity: 'AuthenticityCode',
      entityId: row.id,
      previousData: { code: row.code },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
