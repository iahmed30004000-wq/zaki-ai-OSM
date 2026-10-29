import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { AlreadyBlocked, blockPhone, releaseBlock } from '@/lib/blacklist';
import { normalizePhoneNumber } from '@/lib/phone';
import { zodMessage } from '@/lib/zod-message';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { typed } from '@/lib/text-search';

/**
 * GET    /api/control/blacklist   the list, active first
 * POST   /api/control/blacklist   block a phone
 * PATCH  /api/control/blacklist   release one
 *
 * There is no DELETE. A block is released, never removed — who blocked whom
 * and why survives the decision to let them back.
 */

const blockSchema = z.object({
  phone: z.string().trim().min(6).max(25),
  name: z.string().trim().max(80).optional(),
  reason: z.string().trim().min(3, 'سبب الحظر إلزامي').max(300),
});

const releaseSchema = z.object({
  blockId: z.string().uuid(),
  reason: z.string().trim().min(3, 'سبب فك الحظر إلزامي').max(300),
});

export async function GET(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('control.blacklist');

    const term = new URL(req.url).searchParams.get('q')?.trim();
    const normalized = term ? normalizePhoneNumber(term) : '';

    const blocks = await db.customerBlock.findMany({
      where: {
        companyId,
        ...(term
          ? {
              OR: [
                ...(normalized ? [{ phone: typed(normalized) }] : []),
                { name: typed(term) },
                { reason: typed(term) },
              ],
            }
          : {}),
      },
      orderBy: [{ releasedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: 200,
      include: {
        blockedBy: { select: { id: true, name: true } },
        releasedBy: { select: { id: true, name: true } },
      },
    });

    // What each blocked number actually did, so the list can be judged.
    const phones = [...new Set(blocks.map((b) => b.phone))];
    const history = phones.length
      ? await db.order.groupBy({
          by: ['customerId'],
          where: { companyId, customer: { phone: { in: phones } } },
          _count: { _all: true },
        })
      : [];
    const customers = phones.length
      ? await db.customer.findMany({
          where: { companyId, phone: { in: phones } },
          select: { id: true, phone: true, totalOrders: true, deliveredOrders: true, cancelledOrders: true },
        })
      : [];
    const byPhone = new Map(customers.map((c) => [c.phone, c]));

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId: null, user, where: 'القائمة السوداء', rows: blocks });

    return NextResponse.json({
      blocks: blocks.map((b) => ({
        id: b.id,
        phone: b.phone,
        name: b.name,
        reason: b.reason,
        createdAt: b.createdAt,
        blockedByName: b.blockedBy?.name ?? null,
        releasedAt: b.releasedAt,
        releasedByName: b.releasedBy?.name ?? null,
        releaseReason: b.releaseReason,
        active: b.releasedAt === null,
        customer: byPhone.get(b.phone) ?? null,
      })),
      activeCount: blocks.filter((b) => b.releasedAt === null).length,
      totalOrdersSeen: history.length,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    // Blocking a number has a key of its own (PR-6): seeing the list is `control.blacklist`, changing it is this one.
    await requirePermission('control.blacklist_manage');

    const parsed = blockSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    try {
      const block = await blockPhone(db, {
        companyId,
        phone: parsed.data.phone,
        name: parsed.data.name,
        reason: parsed.data.reason,
        blockedById: user.id,
      });

      await logAudit({
        companyId, userId: user.id, action: 'CUSTOMER_BLOCKED',
        entity: 'CustomerBlock', entityId: block.id,
        newData: { phone: block.phone, reason: block.reason },
      });

      return NextResponse.json({ block }, { status: 201 });
    } catch (e) {
      if (e instanceof AlreadyBlocked) {
        return NextResponse.json({ error: e.message, code: 'ALREADY_BLOCKED' }, { status: 409 });
      }
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'تعذر الحظر' },
        { status: 400 }
      );
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('control.blacklist_manage');

    const parsed = releaseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    try {
      const released = await releaseBlock(db, {
        companyId,
        blockId: parsed.data.blockId,
        reason: parsed.data.reason,
        releasedById: user.id,
      });

      await logAudit({
        companyId, userId: user.id, action: 'CUSTOMER_BLOCK_RELEASED',
        entity: 'CustomerBlock', entityId: released.id,
        newData: { phone: released.phone, reason: parsed.data.reason },
      });

      return NextResponse.json({ block: released });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'تعذر فك الحظر' },
        { status: 409 }
      );
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
