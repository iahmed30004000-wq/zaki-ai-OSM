import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { warehousesOfStore } from '@/lib/warehouses';
import { auditLines, replayOf, sendSchema, sendTransfer, shownTo } from '@/lib/stock-transfers';
import { ABROAD_KEY, STOCK_TRANSFER_KIND_LABEL, type StockTransferKind } from '@/lib/stock-transfer-kind';
import { arabicIssue, reachFor, refusalOf, refuse, shownOpts, storeReachFor, TX_OPTIONS } from '@/lib/stock-transfer-door';
import { labelLineVariants, transfersVariantsOf, variantLabelsOf, withLineVariants } from '@/lib/variant-lines';
import { afterResponse } from '@/lib/notify';
import { announceTransferSent } from '@/lib/stock-transfer-alerts';

/**
 * GET  /api/inventory/transfers (inventory.view)     — the store's transfers, newest first, and its warehouses
 * POST /api/inventory/transfers (inventory.transfer) — send: units leave the source and are on the road
 *
 * The warehouse plan, request W3a. Every rule is in `src/lib/stock-transfers.ts`; this door adds the session — the
 * store the caller stands in, her key, and the warehouses she reaches.
 *
 * 20/11 (W7b): every kind is built. A transfer to another store names it (`toStoreId`) and needs every product's twin
 * there; to another country it also needs `inventory.transfer_abroad` and is answered AWAITING_APPROVAL — the owner's
 * press (`/:id/approve`) sends it. The list shows the store's own transfers AND those arriving in it from another store;
 * the cost a line carries is shown only to a holder of `costs.view`, and never while the count is blind.
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
        // 20/11 (W7b): and the transfers whose goods arrive in this store from another one.
        where: { companyId, OR: [{ storeId }, { toStoreId: storeId }] },
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
          storeId: true,
          toStoreId: true,
          approvedById: true,
          approvedAt: true,
          lines: {
            select: {
              productId: true,
              quantitySent: true,
              quantityReceived: true,
              product: { select: { name: true } },
              // 20/11 (W7b): the twin and the cost the units carry (null for INTERNAL).
              toProductId: true,
              toProduct: { select: { name: true } },
              costOut: true,
              landedCosts: true,
              unitCostIn: true,
              costRemainder: true,
            },
          },
        },
      }),
      warehousesOfStore(companyId, storeId),
    ]);

    const peopleIds = [
      ...new Set(
        rows.flatMap((r) => [r.sentById, r.receivedById, r.cancelledById, r.differenceApprovedById, r.approvedById]).filter((x): x is string => !!x)
      ),
    ];
    const whIds = [...new Set(rows.flatMap((r) => [r.fromWarehouseId, r.toWarehouseId]))];
    const storeIds = [...new Set(rows.flatMap((r) => (r.toStoreId ? [r.storeId, r.toStoreId] : [])))];
    const [people, places, stores] = await Promise.all([
      peopleIds.length ? db.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { id: { in: whIds }, companyId }, select: { id: true, name: true } }) : [],
      storeIds.length ? db.store.findMany({ where: { id: { in: storeIds }, companyId }, select: { id: true, name: true } }) : [],
    ]);
    const who = new Map(people.map((p) => [p.id, p.name]));
    const where = new Map(places.map((w) => [w.id, w.name]));
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const opts = shownOpts(user);
    // 20/11 (W8c): the lines' combinations, blind exactly as their line (`shownTo`), each with its label — a line without
    // combinations answers what it always answered.
    const combos = await transfersVariantsOf(db, rows.map((r) => r.id));
    const labels = await variantLabelsOf(db, companyId, [...combos.values()].flatMap((m) => [...m.values()].flat().map((v) => v.variantId)));

    return NextResponse.json({
      // The country rides along (20/11, W3b): the screen reads the kind from the two ends before the press (`readStockTransfer`).
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, countryId: w.countryId })),
      transfers: rows.map((r) => {
        const names = new Map(r.lines.map((l) => [l.productId, l.product.name]));
        const twinNames = new Map(r.lines.map((l) => [l.productId, l.toProduct?.name ?? null]));
        const plain = r.lines.map(({ productId, quantitySent, quantityReceived, toProductId, costOut, landedCosts, unitCostIn, costRemainder }) => ({
          productId,
          quantitySent,
          quantityReceived,
          // 20/11 (W7b): present only on a line across stores, so an INTERNAL line is the line it always was.
          ...(toProductId ? { toProductId, costOut, landedCosts, unitCostIn, costRemainder } : {}),
        }));
        const shown = shownTo({ ...r, lines: withLineVariants(plain, combos.get(r.id) ?? new Map()) }, user.id, opts);
        return {
          ...shown,
          kindAr: STOCK_TRANSFER_KIND_LABEL[r.kind as StockTransferKind] ?? r.kind,
          fromName: where.get(r.fromWarehouseId) ?? null,
          toName: where.get(r.toWarehouseId) ?? null,
          sentByName: who.get(r.sentById) ?? null,
          receivedByName: r.receivedById ? who.get(r.receivedById) ?? null : null,
          cancelledByName: r.cancelledById ? who.get(r.cancelledById) ?? null : null,
          differenceApprovedByName: r.differenceApprovedById ? who.get(r.differenceApprovedById) ?? null : null,
          // 20/11 (W7b): the two stores of a transfer across stores, and the owner who approved one to another country.
          ...(r.toStoreId
            ? {
                fromStoreName: storeName.get(r.storeId) ?? null,
                toStoreName: storeName.get(r.toStoreId) ?? null,
                approvedByName: r.approvedById ? who.get(r.approvedById) ?? null : null,
              }
            : {}),
          lines: shown.lines.map((l) =>
            labelLineVariants(
              { ...l, productName: names.get(l.productId) ?? null, ...('toProductId' in l ? { toProductName: twinNames.get(l.productId) ?? null } : {}) },
              labels
            )
          ),
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
    if (!parsed.success) return refuse(400, 'INVALID', arabicIssue(parsed.error));
    const body = parsed.data;

    try {
      const out = await db.$transaction(
        (tx) =>
          sendTransfer(tx, {
            companyId,
            storeId,
            sentById: user.id,
            body,
            mayUse: reachFor(user, companyId),
            // 20/11 (W7b): the other store by the session's store-entry rule, and the abroad key as `can()` decides it.
            mayReachStore: storeReachFor(user, companyId),
            mayAbroad: can(user, ABROAD_KEY),
          }),
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
            lines: auditLines(out.transfer.lines),
            by: user.name,
          },
        });
        // 20/11 (W3c): the destination's receivers hear it is coming — the source and the NUMBER of products, never a
        // unit (the receipt is blind). After the answer; a failed notice never fails the send. A replay tells nobody again.
        // 20/11 (W7b): a request to another country has not left yet — its receivers hear at the owner's press.
        const sent = out.transfer;
        if (sent.status === 'SENT') afterResponse(() => announceTransferSent(companyId, sent));
      }
      return NextResponse.json({ transfer: shownTo(out.transfer, user.id, shownOpts(user)), replay: out.replay }, { status: out.replay ? 200 : 201 });
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
          if (twin) return NextResponse.json({ transfer: shownTo(twin, user.id, shownOpts(user)), replay: true }, { status: 200 });
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
