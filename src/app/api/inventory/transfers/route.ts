import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { warehousesOfStore } from '@/lib/warehouses';
import { replayOf, sendSchema, sendTransfer, shownTo } from '@/lib/stock-transfers';
import { STOCK_TRANSFER_KIND_LABEL, type StockTransferKind } from '@/lib/stock-transfer-kind';
import { reachFor, refusalOf, refuse, TX_OPTIONS } from '@/lib/stock-transfer-door';

/**
 * GET  /api/inventory/transfers (inventory.view)     — the store's transfers, newest first, and its warehouses
 * POST /api/inventory/transfers (inventory.transfer) — send: units leave the source and are on the road
 *
 * The warehouse plan, request W3a. Every rule is in `src/lib/stock-transfers.ts`; this door adds the session — the
 * store the caller stands in, her key, and the warehouses she reaches. Only a transfer between two warehouses of ONE
 * store is built; another store or another country answers «لسا مش مبني».
 *
 * While a transfer is on the road its sent quantities are told only to its sender (`stock-transfers.shownTo`): the
 * receiver counts without being told what to expect.
 */

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    const [rows, warehouses] = await Promise.all([
      db.stockTransfer.findMany({
        where: { companyId, storeId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          kind: true,
          status: true,
          note: true,
          fromWarehouseId: true,
          toWarehouseId: true,
          sentById: true,
          sentAt: true,
          receivedById: true,
          receivedAt: true,
          cancelledById: true,
          cancelledAt: true,
          cancelReason: true,
          differenceType: true,
          differenceReason: true,
          differenceApprovedById: true,
          differenceApprovedAt: true,
          lines: { select: { productId: true, quantitySent: true, quantityReceived: true, product: { select: { name: true } } } },
        },
      }),
      warehousesOfStore(companyId, storeId),
    ]);

    const peopleIds = [
      ...new Set(rows.flatMap((r) => [r.sentById, r.receivedById, r.cancelledById, r.differenceApprovedById]).filter((x): x is string => !!x)),
    ];
    const whIds = [...new Set(rows.flatMap((r) => [r.fromWarehouseId, r.toWarehouseId]))];
    const [people, places] = await Promise.all([
      peopleIds.length ? db.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { id: { in: whIds }, companyId }, select: { id: true, name: true } }) : [],
    ]);
    const who = new Map(people.map((p) => [p.id, p.name]));
    const where = new Map(places.map((w) => [w.id, w.name]));

    return NextResponse.json({
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      transfers: rows.map((r) => {
        const names = new Map(r.lines.map((l) => [l.productId, l.product.name]));
        const shown = shownTo({ ...r, lines: r.lines.map(({ productId, quantitySent, quantityReceived }) => ({ productId, quantitySent, quantityReceived })) }, user.id);
        return {
          ...shown,
          kindAr: STOCK_TRANSFER_KIND_LABEL[r.kind as StockTransferKind] ?? r.kind,
          fromName: where.get(r.fromWarehouseId) ?? null,
          toName: where.get(r.toWarehouseId) ?? null,
          sentByName: who.get(r.sentById) ?? null,
          receivedByName: r.receivedById ? who.get(r.receivedById) ?? null : null,
          cancelledByName: r.cancelledById ? who.get(r.cancelledById) ?? null : null,
          differenceApprovedByName: r.differenceApprovedById ? who.get(r.differenceApprovedById) ?? null : null,
          lines: shown.lines.map((l) => ({ ...l, productName: names.get(l.productId) ?? null })),
        };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.transfer');

    const parsed = sendSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', parsed.error.issues[0]?.message ?? 'البيانات ناقصة');
    const body = parsed.data;

    try {
      const out = await db.$transaction(
        (tx) => sendTransfer(tx, { companyId, storeId, sentById: user.id, body, mayUse: reachFor(user, companyId) }),
        TX_OPTIONS
      );
      if (!out.replay) {
        await logAudit({
          companyId,
          userId: user.id,
          action: 'STOCK_TRANSFER_SENT',
          entity: 'StockTransfer',
          entityId: out.transfer.id,
          newData: {
            kind: out.kind,
            fromWarehouseId: out.transfer.fromWarehouseId,
            toWarehouseId: out.transfer.toWarehouseId,
            lines: out.transfer.lines,
            by: user.name,
          },
        });
      }
      return NextResponse.json({ transfer: shownTo(out.transfer, user.id), replay: out.replay }, { status: out.replay ? 200 : 201 });
    } catch (e) {
      const refused = refusalOf(e);
      if (refused) return refused;
      /*
       * Two presses carrying the same id at the same moment: the replay check saw nothing, the database saw the second,
       * and its transaction rolled back whole. If the row is this very deal of this person, it is the twin's: a success
       * to repeat. Anything else under the id is a conflict that says nothing about the row.
       */
      if (body.id && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        try {
          const twin = await replayOf(db, { companyId, storeId, sentById: user.id, body });
          if (twin) return NextResponse.json({ transfer: shownTo(twin, user.id), replay: true }, { status: 200 });
        } catch (again) {
          const r = refusalOf(again);
          if (r) return r;
          throw again;
        }
      }
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
