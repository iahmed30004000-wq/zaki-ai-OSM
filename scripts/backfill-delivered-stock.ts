/**
 * The units that were handed to customers and never left stock.
 *
 * Delivering an order was supposed to consume its goods. It never did: the
 * reservation was released the moment the order left the open set, the batch
 * kept its full remainder, and the unit went quietly back on sale. The
 * delivery path now consumes properly — this settles what happened before.
 *
 *   node --import tsx scripts/backfill-delivered-stock.ts           # look
 *   node --import tsx scripts/backfill-delivered-stock.ts --apply   # settle
 *
 * It is safe to run twice. Every order it settles gets a SALE movement
 * carrying that order's id, and an order that already has one is skipped —
 * the same key the live delivery path uses, so the two can never
 * double-count each other.
 */
import { PrismaClient } from '@prisma/client';
import { consumeOrderStock } from '../src/lib/stock-consumption';

const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Orders whose goods reached a customer. */
const DELIVERED = ['DELIVERED', 'PARTIALLY_DELIVERED'];

async function main() {
  const orders = await db.order.findMany({
    where: { shippingStatus: { in: DELIVERED } },
    orderBy: { deliveredAt: 'asc' },
    select: {
      id: true,
      companyId: true,
      orderNumber: true,
      deliveredAt: true,
      items: { select: { productId: true, productName: true, quantity: true, freeQuantity: true } },
    },
  });

  // Which of them the ledger already accounts for.
  const settled = new Set(
    (
      await db.inventoryMovement.findMany({
        where: { type: 'SALE', referenceId: { in: orders.map((o) => o.id) } },
        select: { referenceId: true },
      })
    ).map((m) => m.referenceId!)
  );

  const pending = orders.filter((o) => !settled.has(o.id));
  const units = pending.reduce(
    (sum, o) => sum + o.items.reduce((s, i) => s + i.quantity + i.freeQuantity, 0),
    0
  );

  console.log(`delivered orders ............ ${orders.length}`);
  console.log(`already settled ............. ${settled.size}`);
  console.log(`to settle ................... ${pending.length}  (${units} units)`);

  if (pending.length === 0) {
    console.log('\nNothing to do — every delivered order has already left stock.');
    return;
  }

  // What it does to each product, before touching anything.
  const perProduct = new Map<string, { name: string; need: number }>();
  for (const o of pending) {
    for (const i of o.items) {
      const row = perProduct.get(i.productId) ?? { name: i.productName, need: 0 };
      row.need += i.quantity + i.freeQuantity;
      perProduct.set(i.productId, row);
    }
  }

  console.log('\nproduct                                    on hand   to take   after');
  console.log('─'.repeat(74));
  let wouldGoNegative = 0;
  for (const [productId, row] of perProduct) {
    const agg = await db.productionBatch.aggregate({
      where: { productId },
      _sum: { quantityRemaining: true },
    });
    const onHand = agg._sum.quantityRemaining ?? 0;
    const after = onHand - row.need;
    if (after < 0) wouldGoNegative++;
    console.log(
      `${row.name.slice(0, 40).padEnd(42)}${String(onHand).padStart(7)}${String(row.need).padStart(10)}` +
        `${String(after).padStart(8)}${after < 0 ? '  ← short' : ''}`
    );
  }

  if (wouldGoNegative > 0) {
    console.log(
      `\n${wouldGoNegative} product(s) were sold beyond what stock records hold. ` +
        `They are taken down to zero and the shortfall is reported, never written as a negative balance.`
    );
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to settle.');
    return;
  }

  console.log('\nSettling…');
  let taken = 0;
  let short = 0;
  let done = 0;

  for (const order of pending) {
    // One transaction per order: a failure leaves that order untouched
    // rather than half-consumed, and the next run picks it up again.
    const res = await db.$transaction((tx) =>
      consumeOrderStock(tx, {
        orderId: order.id,
        companyId: order.companyId,
        // No stock rule is passed (P0-13): a delivery is recorded whatever the shelf says. The shelf still never
        // goes below zero; what it could not give is counted in `short` below and written as a review line.
        userId: null,
      })
    );
    taken += res.taken;
    short += res.short;
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${pending.length}…`);
  }

  console.log(`\nsettled orders .............. ${done}`);
  console.log(`units taken out of stock .... ${taken}`);
  console.log(`units that were not there ... ${short}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
