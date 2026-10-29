import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { apiErrorResponse } from '@/lib/api-error';
import { can } from '@/lib/authorization';
import { zodMessage } from '@/lib/zod-message';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';

/**
 * ORDER NOTES — the context layer (contract Stage 7 / PART 5).
 *
 *   GET  /api/orders/:id/notes   full chronological thread
 *   POST /api/orders/:id/notes   append one note
 *
 * There is deliberately NO PATCH and NO DELETE: notes are immutable for
 * every role including the owner. A correction is a new note. Never add a
 * typed field for a situation a note already covers (partial payment,
 * customer debt, received_by, collected currency, "collected not remitted").
 */

export const NOTE_KINDS = ['follow_up', 'return', 'settlement', 'internal'] as const;

const createSchema = z.object({
  body: z.string().trim().min(2, 'الملاحظة قصيرة جدًا').max(2000),
  kind: z.enum(NOTE_KINDS).default('internal'),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    // Her own order's thread too, through the work door (order-work-door.ts).
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const notes = await db.orderNote.findMany({
      where: { orderId: id, companyId },
      orderBy: { createdAt: 'asc' },
    });
    const authorIds = [...new Set(notes.map((n) => n.authorId).filter(Boolean) as string[])];
    const authors = authorIds.length
      ? await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(authors.map((a) => [a.id, a.name]));

    return NextResponse.json({
      count: notes.length,
      notes: notes.map((n) => ({ ...n, authorName: n.authorId ? nameOf.get(n.authorId) ?? null : null })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();

    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    /*
     * WRITING A NOTE IS ITS OWN KEY (perm-plan PR-6): `orders.note`. It rode on the work door — `orders.view` or
     * `confirmation.work` — so a person who could only READ an order could also leave a line on it that every colleague
     * trusts. The migration gave the key to everybody who passed the door, so nobody lost it; reading the thread above
     * is unchanged.
     */
    if (!can(user, 'orders.note')) {
      return NextResponse.json(
        { error: 'ما عندك صلاحية كتابة ملاحظة على الطلب.', errorAr: 'ما عندك صلاحية كتابة ملاحظة على الطلب.', code: 'NOTE_FORBIDDEN' },
        { status: 403 }
      );
    }

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const note = await db.orderNote.create({
      data: {
        companyId,
        orderId: id,
        body: parsed.data.body,
        kind: parsed.data.kind,
        authorId: user.id,
      },
    });
    return NextResponse.json({ note: { ...note, authorName: user.name } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
