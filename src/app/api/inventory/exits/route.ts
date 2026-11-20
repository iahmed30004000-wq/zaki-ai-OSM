import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { maySeeCost } from '@/lib/cost-visibility';
import { warehousesOfStore } from '@/lib/warehouses';
import { exitReplayOf, exitShown, requestExit, requestSchema } from '@/lib/stock-exits';
import { EXIT_REASON_AR, EXIT_REASONS } from '@/lib/stock-exit-reasons';
import { exitRefusalOf } from '@/lib/stock-exit-door';
import { exitsVariantsOf, labelLineVariants, variantLabelsOf, withLineVariants } from '@/lib/variant-lines';
import { reachFor, refuse, TX_OPTIONS } from '@/lib/stock-transfer-door';

/**
 * GET  /api/inventory/exits (inventory.view) — the store's exits, newest first, its warehouses and the reasons' words
 * POST /api/inventory/exits (inventory.exit) — request: goods leave a warehouse for good once another person approves
 *
 * The warehouse plan, request W6a. Every rule is in `src/lib/stock-exits.ts`; this door adds the session — the store
 * the caller stands in, her key, and the warehouses she reaches. The value at cost of an approved line is told only to
 * a person who may see what things cost (`costs.view`). Nothing here touches money.
 */

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.view');

    const [rows, warehouses] = await Promise.all([
      // THIS store's exits only — a warehouse may hold the goods of several stores of its country.
      db.stockExit.findMany({
        where: { companyId, storeId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          warehouseId: true,
          reason: true,
          note: true,
          status: true,
          requestedById: true,
          requestedAt: true,
          decidedById: true,
          decidedAt: true,
          rejectReason: true,
          lines: { select: { productId: true, quantity: true, valueAtCost: true, product: { select: { name: true } } }, orderBy: { productId: 'asc' } },
        },
      }),
      warehousesOfStore(companyId, storeId),
    ]);

    const peopleIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))];
    const whIds = [...new Set(rows.map((r) => r.warehouseId))];
    const [people, places] = await Promise.all([
      peopleIds.length ? db.user.findMany({ where: { id: { in: peopleIds }, companyId }, select: { id: true, name: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { id: { in: whIds }, companyId }, select: { id: true, name: true } }) : [],
    ]);
    const who = new Map(people.map((p) => [p.id, p.name]));
    const where = new Map(places.map((w) => [w.id, w.name]));
    const seesCost = maySeeCost(user);
    // 20/11 (W8c): the lines' combinations, each with its label — a line without combinations answers what it always did.
    const combos = await exitsVariantsOf(db, rows.map((r) => r.id));
    const labels = await variantLabelsOf(db, companyId, [...combos.values()].flatMap((m) => [...m.values()].flat().map((v) => v.variantId)));

    return NextResponse.json({
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      reasons: EXIT_REASONS.map((r) => ({ reason: r, ar: EXIT_REASON_AR[r] })),
      exits: rows.map((r) => {
        const names = new Map(r.lines.map((l) => [l.productId, l.product.name]));
        const shown = exitShown(
          { ...r, lines: withLineVariants(r.lines.map(({ productId, quantity, valueAtCost }) => ({ productId, quantity, valueAtCost })), combos.get(r.id) ?? new Map()) },
          seesCost
        );
        return {
          ...shown,
          warehouseName: where.get(r.warehouseId) ?? null,
          requestedByName: who.get(r.requestedById) ?? null,
          decidedByName: r.decidedById ? who.get(r.decidedById) ?? null : null,
          lines: shown.lines.map((l) => labelLineVariants({ ...l, productName: names.get(l.productId) ?? null }, labels)),
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
    await requirePermission('inventory.exit');

    const parsed = requestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', parsed.error.issues[0]?.message ?? 'البيانات ناقصة');
    const body = parsed.data;
    const seesCost = maySeeCost(user);

    try {
      const out = await db.$transaction(
        (tx) => requestExit(tx, { companyId, storeId, requestedById: user.id, body, mayUse: reachFor(user, companyId) }),
        TX_OPTIONS
      );
      if (!out.replay) {
        await logAudit({
          companyId,
          userId: user.id,
          action: 'STOCK_EXIT_REQUESTED',
          entity: 'StockExit',
          entityId: out.exit.id,
          newData: {
            warehouseId: out.exit.warehouseId,
            reason: out.exit.reason,
            note: out.exit.note,
            lines: out.exit.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
            by: user.name,
          },
        });
      }
      return NextResponse.json({ exit: exitShown(out.exit, seesCost), replay: out.replay }, { status: out.replay ? 200 : 201 });
    } catch (e) {
      const refused = exitRefusalOf(e);
      if (refused) return refused;
      /*
       * Two presses carrying the same id at the same moment: the replay check saw nothing, the database saw the second,
       * and its transaction rolled back whole. If the row is this very request of this person, it is the twin's: a
       * success to repeat. Anything else under the id is a conflict that says nothing about the row.
       */
      if (body.id && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        try {
          const twin = await exitReplayOf(db, { companyId, storeId, requestedById: user.id, body });
          if (twin) return NextResponse.json({ exit: exitShown(twin, seesCost), replay: true }, { status: 200 });
        } catch (again) {
          const r = exitRefusalOf(again);
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
