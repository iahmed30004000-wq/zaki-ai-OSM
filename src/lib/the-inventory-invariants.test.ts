import { describe, expect, it } from 'vitest';
import { dashboardFiles, repoFile, stripComments, stripTemplates } from './guard-source';
import { assertReadyToShip } from './order-state';
import { allocateDiscount } from './money';
import { consumeOrderStock, restoreOrderStock } from './stock-consumption';
import { inStore } from './store-filter';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the inventory section.
 *
 * «Violating any line here is a defect, not a design choice.» — the
 * invariants reference, which is the formal contract this system was built
 * against. Each of its eight inventory lines is pinned here against the code
 * with the evidence the brief demands.
 *
 * Six hold. One was delivered under another name and better (custody is
 * DERIVED, like the zone). One is PARTIAL and reported.
 *
 * And one was broken in five places, found while verifying the eighth line
 * and fixed on 2026-10-02 — see «THE SHELF IS THE STORE'S» at the bottom.
 */

describe('1 · the reservation is PER LINE, never per order', () => {
  it('lives on the order line', () => {
    const schema = repoFile('prisma/schema.prisma');
    const item = schema.slice(schema.indexOf('model OrderItem {'));
    expect(item.slice(0, item.indexOf('\n}'))).toMatch(/reservedQty\s+Int\s+@default\(0\)/);
  });

  it('and the Order model carries no reservation of its own', () => {
    // A second place to hold the same fact is a second place for it to be
    // wrong — and the order-level one would be the one screens reach for.
    const schema = repoFile('prisma/schema.prisma');
    const order = schema.slice(schema.indexOf('model Order {'));
    const body = order.slice(0, order.indexOf('\n}'));
    expect(body.split('\n').filter((l) => /reserv/i.test(l) && !l.trim().startsWith('//'))).toEqual([]);
  });

  it('and the reservation counts the FREE units too', () => {
    // Gift units are goods. A shelf that does not hold them for the order is
    // a shelf that promises them to somebody else.
    const res = stripComments(repoFile('src/lib/reservation.ts'));
    expect(res).toMatch(/item\.quantity \+ item\.freeQuantity - item\.reservedQty/);
    expect(res).toMatch(/reservedQty: item\.quantity \+ item\.freeQuantity/);
    // And consumption asks for the same number, or the difference throws at
    // the door of every order that carried a gift.
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    expect(con).toMatch(/line\.quantity \+ line\.freeQuantity/);
  });
});

describe('2 · one unreserved line stops READY_TO_SHIP', () => {
  const confirmed = { confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' } as never;

  it('refuses with its own code', () => {
    const v = assertReadyToShip(confirmed, [
      { quantity: 2, freeQuantity: 0, reservedQty: 2 },
      { quantity: 1, freeQuantity: 0, reservedQty: 0 },
    ]);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('UNRESERVED_LINES');
  });

  it('and the FREE units count toward being held', () => {
    // Two paid and one gift reserved as two is not a held line, or the gift
    // ships off a shelf that never promised it.
    const v = assertReadyToShip(confirmed, [{ quantity: 2, freeQuantity: 1, reservedQty: 2 }]);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('UNRESERVED_LINES');
  });

  it('and allows an order whose every line is held', () => {
    expect(assertReadyToShip(confirmed, [{ quantity: 2, freeQuantity: 1, reservedQty: 3 }]).allowed).toBe(true);
  });

  it('and an order with no lines at all is refused, not passed', () => {
    const v = assertReadyToShip(confirmed, []);
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('UNRESERVED_LINES');
  });
});

describe('3 · the discount is allocated across lines proportionally', () => {
  it('and stored per line, because partial returns refund per line', () => {
    const schema = repoFile('prisma/schema.prisma');
    const item = schema.slice(schema.indexOf('model OrderItem {'));
    // A WORD, not a prefix. `/discountShare/` was satisfied by renaming the
    // column to `discountShareGone` — the substring survived the rename, so
    // the guard reported a column that no longer existed.
    expect(item.slice(0, item.indexOf('\n}'))).toMatch(/^\s*discountShare\s+\S/m);
  });

  it('and the allocation loses nothing to rounding', () => {
    // Three lines of equal value sharing 10 on a 2-decimal currency: the
    // shares must still add up to 10, not to 9.99.
    const lines = [
      { quantity: 1, unitPrice: 10 },
      { quantity: 1, unitPrice: 10 },
      { quantity: 1, unitPrice: 10 },
    ];
    const shares = allocateDiscount(lines, 10, 2);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10);
  });

  it('and it is proportional to value, not spread evenly', () => {
    const shares = allocateDiscount([{ quantity: 1, unitPrice: 90 }, { quantity: 1, unitPrice: 10 }], 10, 2);
    expect(shares[0]).toBeCloseTo(9, 10);
    expect(shares[1]).toBeCloseTo(1, 10);
  });
});

describe('4 · stock enters by a batch or a reasoned adjustment, and nothing else', () => {
  it('the adjustment door refuses to move stock without a reason', () => {
    const inv = stripComments(repoFile('src/app/api/inventory/route.ts'));
    // The reason reaches the ledger row, not just the request body.
    expect(inv).toMatch(/reason: `جرد: عُدّ \$\{input\.countedQuantity\}/);
  });

  it('and a surplus with no cost to stand on is refused, not invented', () => {
    const inv = stripComments(repoFile('src/app/api/inventory/route.ts'));
    expect(inv).toMatch(/throw new UncostedSurplus\(/);
  });

  it('and a bought product cannot enter through the production door', () => {
    const prod = stripComments(repoFile('src/app/api/production/route.ts'));
    expect(prod).toMatch(/sourceType === 'PURCHASED'/);
    expect(prod).toMatch(/code: 'WRONG_DOOR'/);
  });

  it('and the unit cost divides EVERY cost line across the quantity', () => {
    /*
     * The contract writes the formula as «unit cost + (shipping and customs ÷
     * qty)». The code generalises it: any labelled cost line — shipping,
     * customs, or anything else the run actually paid — is summed into
     * `totalProductionCost` and divided by the quantity. Two named fields
     * would have been two fields and no room for the third thing.
     */
    const prod = stripComments(repoFile('src/app/api/production/route.ts'));
    expect(prod).toMatch(/batchTotal\(\{/);
    expect(prod).toMatch(/costLines,/);
    expect(prod).toMatch(/batchUnitCost\(totalProductionCost, qty\)/);
  });
});

describe('5 · nothing re-enters the shelf before it is counted and inspected', () => {
  it('the restore takes a counted quantity and a damaged one', () => {
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    expect(con).toMatch(/receivedQty/);
    expect(con).toMatch(/damagedQty/);
  });

  it('and the damaged units do NOT go back, while their cost does', () => {
    const con = repoFile('src/lib/stock-consumption.ts');
    expect(con).toMatch(/They do not return to stock; their cost does/);
    expect(stripComments(con)).toMatch(/absorbDamaged\(\{/);
  });

  it('and nothing comes back that never left', () => {
    // Consumption is at DELIVERY, so a parcel refused at the door took no
    // units out of any batch. «Restoring» them would invent stock.
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    expect(con).toMatch(/if \(!\(await alreadyMoved\(tx, input\.orderId, SALE\)\)\) \{/);
    expect(con).toMatch(/neverConsumed: true/);
  });

  it('and the batch it comes back as says it was counted', () => {
    expect(repoFile('src/lib/stock-consumption.ts')).toMatch(/بعد العد والفحص/);
  });
});

describe('6 · allow_negative_stock is the COUNTRY’s, and it gates the shipment', () => {
  it('the column belongs to the country, not the company or the product', () => {
    const schema = repoFile('prisma/schema.prisma');
    const country = schema.slice(schema.indexOf('model Country {'));
    expect(country.slice(0, country.indexOf('\n}'))).toMatch(/allowNegativeStock/);
  });

  it('and no door reserves at ORDER creation', () => {
    // The flag gates the shipment, not the order. An order is taken from a
    // customer whatever the shelf says; what we may SHIP is the question.
    for (const door of [
      'src/lib/public-order.ts',
      'src/app/api/orders/route.ts',
      'src/lib/telegram/order-creation.ts',
      'src/app/api/orders/ai-intake/route.ts',
    ]) {
      expect(stripComments(repoFile(door)), door).not.toMatch(/reserveOrderLines\(/);
    }
  });

  it('and the two doors that DO reserve both read it off the country', () => {
    for (const door of [
      'src/app/api/orders/[id]/confirmation/route.ts',
      'src/app/api/ops/shipments/hold/route.ts',
    ]) {
      expect(stripComments(repoFile(door)), door).toMatch(
        /reserveOrderLines\(tx, [^)]*\{ allowNegativeStock: country\.allowNegativeStock \}/
      );
    }
  });

  it('and there is no third state: refused leaves the line unreserved', () => {
    const res = stripComments(repoFile('src/lib/reservation.ts'));
    // `continue`, so the line keeps reservedQty 0 and invariant 2 holds it
    // out of READY_TO_SHIP — the contract's «exceptions list».
    expect(res).toMatch(/if \(!opts\.allowNegativeStock\) continue;/);
    // And allowed means reserved AND reported as a shortage, never silent.
    expect(res).toMatch(/outcome\.shortages\.push\(\{/);
  });

  it('and the preparation screen is the exceptions list', () => {
    const prep = stripComments(repoFile('src/app/api/ops/preparation/route.ts'));
    expect(prep).toMatch(/shortages: groups\.filter\(\(g\) => g\.shortage > 0\)\.length/);
    expect(prep).toMatch(/allowNegativeStock: country\.allowNegativeStock/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 7 · «COURIER_CUSTODY is a real location.» — DELIVERED UNDER ANOTHER NAME,
 * and the other name is better.
 *
 * There is no `COURIER_CUSTODY` location row, and there is no custody
 * column. Custody is DERIVED from the orders a courier is carrying —
 * `agent-custody.ts` says so in its own words — which is exactly what the
 * contract's FIRST invariant demands of the zone: derived, never stored.
 *
 * A stored custody location would be a fourth thing to keep in step with
 * the order's state and its courier, and the first one to drift.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('7 · the courier’s custody is derived, not a stored location', () => {
  it('and the owner of the rule says so', () => {
    const cust = repoFile('src/lib/agent-custody.ts');
    expect(cust).toMatch(/there is no custody column/);
  });

  it('and no column stores it', () => {
    const schema = repoFile('prisma/schema.prisma');
    expect(schema).not.toMatch(/custodyLocation|COURIER_CUSTODY/);
  });

  it('and the totals are computed by a function that touches no database', () => {
    // The same shape as the zone: a pure derivation, testable on its own.
    const pure = stripComments(repoFile('src/lib/agent-custody-totals.ts'));
    expect(pure).not.toMatch(/\btx\.|\bdb\./);
    expect(pure).toMatch(/export function custodyTotals\(/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * 8 · «Warehouses belong to a country. Cross-border transfer is refused by
 * rule, not by warning.» — HELD, under another name.
 *
 * There is no Warehouse model. The STORE is the warehouse: the batch carries
 * `storeId`, and `Store.countryId` is REQUIRED. So a shelf belongs to a
 * store, and a store belongs to a country.
 *
 * And the transfer is refused by CONSTRUCTION rather than by a rule: the
 * other store's batches are not in the query. That is stronger than a rule,
 * which is a thing somebody can forget to call — but it only became true on
 * 2026-10-02. See below.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('8 · a shelf belongs to a store, and a store to a country', () => {
  it('the batch carries the store', () => {
    const schema = repoFile('prisma/schema.prisma');
    const batch = schema.slice(schema.indexOf('model ProductionBatch {'));
    expect(batch.slice(0, batch.indexOf('\n}'))).toMatch(/storeId\s+String\?\s+@map\("store_id"\)/);
  });

  it('and the store’s country is required, not optional', () => {
    const schema = repoFile('prisma/schema.prisma');
    const store = schema.slice(schema.indexOf('model Store {'));
    const body = store.slice(0, store.indexOf('\n}'));
    // `String` and not `String?`: a store with no country is a shelf in no
    // currency, under no negative-stock policy, in no timezone.
    expect(body).toMatch(/countryId\s+String\s*$/m);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE SHELF IS THE STORE'S — AT EVERY DOOR.
 *
 * Found while verifying line 8, and it was one defect wearing five faces.
 * Availability and reservation were store-scoped: `onHand` filters by
 * `storeId`, `availableStock` passes it, `receiveStock` writes it. Three
 * other doors ignored it entirely:
 *
 *   · `drawDownStock` took no `storeId` at all, so a delivery drew FIFO
 *     across EVERY store's batches and could empty a shelf another store
 *     had already promised — the exact case the batch's own doc comment was
 *     written against.
 *   · the stocktake's SHORTFALL half drew company-wide while its SURPLUS
 *     half wrote to the store.
 *   · a RETURN created its batch with no `storeId`, so counted, inspected
 *     goods landed in the company-wide pile — invisible to the store-scoped
 *     availability the store's own screens read. Restored and unsellable.
 *   · and the return's cost was read off whichever store had the newest
 *     batch, moving one store's profit by another's money.
 *
 * All five now pass the order's own store, using the convention `onHand`
 * already set: null means company-wide, so an order with no store behaves
 * exactly as before.
 *
 * AND THEN A SIXTH AND SEVENTH FACE, on 2026-10-07: THE LEDGER LINES.
 *
 * What this section said on 2026-10-02 was true of the BATCHES and silent
 * about the `InventoryMovement` rows written beside them. Both halves of
 * `stock-consumption.ts` wrote a movement with no store:
 *
 *   · the SALE line on delivery, while the `drawDownStock` call three lines
 *     above it was handed `order.storeId` and emptied THAT store's batches;
 *   · the RETURN line, directly under a batch created with
 *     `storeId: order.storeId` and the comment «back onto the shelf it
 *     left».
 *
 * `/api/inventory/movements` and the ledger block in `/api/inventory` filter
 * the MOVEMENT itself with the strict `inStore(companyId, storeId)`, so both
 * rows were written and then returned by no store's query. Measured on this
 * database before the fix: 30 of 30 movement rows carried no `store_id` —
 * 26 SALE and 4 RETURN. The whole stock ledger existed and was unreadable.
 *
 * AND THIS FILE WAS HALF OF WHY. «a return comes back onto the shelf it
 * left» asked the SOURCE TEXT whether the BATCH carried the store, inside a
 * window that ended at `batchNumber` — so it could not have seen the
 * movement four lines further down even in principle. A half-fix read as
 * complete. It is replaced below by the PAIR, asserted by running the two
 * functions against a transaction that answers for real and reading the
 * rows they hand Prisma.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the shelf is the store’s, at every door', () => {
  it('the draw-down filters by the store', () => {
    const rec = stripComments(repoFile('src/lib/receiving.ts'));
    const fn = rec.slice(rec.indexOf('export async function drawDownStock('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/storeId\?: string \| null/);
    // In the WHERE of the batch query, not merely accepted and dropped.
    const where = body.slice(body.indexOf('findMany({'), body.indexOf('orderBy'));
    expect(where).toMatch(/\.\.\.\(input\.storeId \? \{ storeId: input\.storeId \} : \{\}\)/);
  });

  it('and consumption passes the order’s store', () => {
    // The window is the draw-down CALL. A match over the whole file would be
    // satisfied by the `storeId: true` in the select, which is the half that
    // reads it rather than the half that uses it.
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const call = con.slice(con.indexOf('await drawDownStock(tx, {'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/storeId: order\.storeId,/);
  });

  it('and the stocktake’s shortfall uses the same shelf as its surplus', () => {
    const inv = stripComments(repoFile('src/app/api/inventory/route.ts'));
    const call = inv.slice(inv.indexOf('await drawDownStock(tx, {'));
    expect(call.slice(0, call.indexOf('})'))).toMatch(/storeId,/);
  });

  /*
   * «and a return comes back onto the shelf it left» STOOD HERE as a grep
   * over `src/lib/stock-consumption.ts` for `storeId: order.storeId,` in the
   * window from `tx.productionBatch.create({` to `batchNumber` — the batch's
   * half, in a window that stopped four lines short of the movement. It is
   * replaced by «the ledger line lands on the same shelf as the goods»
   * below, which runs both functions and reads both rows.
   */

  it('and the return’s cost is read off that same shelf', () => {
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    const last = con.slice(con.indexOf('const lastCost = await'));
    expect(last.slice(0, last.indexOf('orderBy'))).toMatch(
      /\.\.\.\(order\.storeId \? \{ storeId: order\.storeId \} : \{\}\)/
    );
  });

  it('and the draw-down does NOT round the cost it reports', () => {
    /*
     * It rounded to two decimals in a function that does not know the
     * currency, and the caller then rounded the result by the real minor
     * unit — so on JOD a batch at 3.333 taken three times came back as
     * 10.00 when it cost 9.999. Seventh instance of the defect fixed six
     * times on 2026-10-02, and the owner's own ruling covers it: a derived
     * figure is rounded once, by whoever knows the currency.
     */
    const rec = stripComments(repoFile('src/lib/receiving.ts'));
    const fn = rec.slice(rec.indexOf('export async function drawDownStock('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/Math\.round\(cost \* 100\) \/ 100/);
    expect(body).toMatch(/return \{ taken: input\.quantity - left, short: left, cost \};/);
    // And the caller still rounds, by the order's own currency.
    const con = stripComments(repoFile('src/lib/stock-consumption.ts'));
    expect(con).toMatch(/roundMinor\(cost, minorUnit\)/);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE LEDGER LINE LANDS ON THE SAME SHELF AS THE GOODS.
 *
 * The pair, asserted together — which is the whole point. A batch that
 * carries the store and a movement that does not is the half-fix that was
 * already in this file, and no test of the batch alone can see it.
 *
 * Nothing is mocked. `consumeOrderStock` and `restoreOrderStock` take their
 * transaction as an argument and `receiving.ts` imports the client only as a
 * TYPE, so the real functions run against a transaction written below that
 * actually applies the `where` it is handed. That matters twice: the
 * draw-down's own store clause is exercised rather than assumed, and the
 * rows the code hands Prisma are the rows read back.
 * ─────────────────────────────────────────────────────────────────────────
 */

const MUBARAK = 's-mubarak';
const SIHHA = 's-sihha';
const PRODUCT = 'p-cream';
const ORDER = 'o-1';

type Row = Record<string, any>;

/** Prisma's `where` for the shapes these two functions and `inStore` use. */
function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && Array.isArray(want.in)) {
      if (!want.in.includes(row[key])) return false;
    } else if (want && typeof want === 'object' && 'gt' in want) {
      if (!((row[key] ?? 0) > want.gt)) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

/**
 * A transaction that answers honestly.
 *
 * `alreadySold` is the ledger state a RETURN depends on: restoring units an
 * order never consumed invents stock, so the function asks the ledger first.
 */
function ledger(opts: { orderStore: string | null; shelf: Row[]; alreadySold?: boolean }) {
  const movements: Row[] = [];
  const created: Row[] = [];
  /** The review lines a short shelf writes on the order (P0-13). */
  const reviews: Row[] = [];
  const shelf: Row[] = opts.shelf.map((b) => ({ ...b }));
  /** Every `where` the draw-down asked the shelf, so its store can be read. */
  const shelfQueries: Row[] = [];
  let seq = 0;

  const tx = {
    inventoryMovement: {
      findFirst: async ({ where }: any) => {
        const written = movements.find((m) => m.referenceId === where.referenceId && m.type === where.type);
        if (written) return { id: 'seen' };
        if (opts.alreadySold && where.type === 'SALE') return { id: 'm-prior-sale' };
        return null;
      },
      create: async ({ data }: any) => {
        movements.push(data);
        return { id: `m${movements.length}`, ...data };
      },
    },
    order: {
      findFirst: async () => ({
        orderNumber: 'ORD-1',
        storeId: opts.orderStore,
        items: [{ productId: PRODUCT, productName: 'كريم', quantity: 2, freeQuantity: 1 }],
        store: { country: { minorUnit: 2 } },
      }),
      update: async () => ({}),
    },
    // An order with no add-ons, unless a test says otherwise — plain functions, so a mock reset leaves them answering.
    orderAddOn: { aggregate: async () => ({ _sum: { reservedQty: 0 } }), findMany: async () => [], update: async () => ({}), updateMany: async () => ({ count: 0 }) },
    orderItem: { updateMany: async () => ({ count: 0 }) },
    // No fixed cost for any product: the order's cost is what the batches say. The figure is the ORDER's, never the shelf's —
    // it is not a shelf query, so it is kept out of `shelfQueries`.
    productFixedCost: { findMany: async () => [] },
    orderActivity: {
      create: async ({ data }: any) => { reviews.push(data); return { id: `a${reviews.length}`, ...data }; },
      findFirst: async ({ where }: any) => reviews.find((r) => r.orderId === where.orderId && r.action === where.action) ?? null,
    },
    productionBatch: {
      findMany: async ({ where, orderBy }: any) => {
        shelfQueries.push(where);
        // THE ORDER IS APPLIED, NOT ASSUMED. Returning rows in array order
        // lets «oldest batch first» pass because the fixture listed them
        // that way, which is no test of the draw-down at all.
        // COPIES, as Prisma returns, so a writer cannot read back a value
        // it has already changed in the same call.
        const rows = shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }));
        // DIRECTION INCLUDED, or a fake that always sorts ascending swallows
        // a flip of the draw-down's own `productionDate: 'asc'`.
        const specs: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy ?? {}]).flatMap(
          (o: any) => Object.entries<string>(o ?? {})
        );
        for (const [key, dir] of [...specs].reverse()) {
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          if (dir === 'desc') rows.reverse();
        }
        return rows;
      },
      findFirst: async ({ where, orderBy }: any) => {
        shelfQueries.push(where);
        const rows = shelf.filter((b) => matchesWhere(b, where)).map((b) => ({ ...b }));
        const key = Object.keys((Array.isArray(orderBy) ? orderBy[0] : orderBy) ?? {})[0];
        const dir = key ? (Array.isArray(orderBy) ? orderBy[0] : orderBy)[key] : 'asc';
        if (key) {
          rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
          if (dir === 'desc') rows.reverse();
        }
        return rows[0] ?? null;
      },
      update: async ({ where, data }: any) => {
        const row = shelf.find((b) => b.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: any) => {
        const row = { id: `b-new-${++seq}`, ...data };
        created.push(row);
        shelf.push(row);
        return row;
      },
      aggregate: async ({ where }: any) => ({
        _sum: {
          quantityRemaining: shelf
            .filter((b) => matchesWhere(b, where))
            .reduce((s, b) => s + (b.quantityRemaining ?? 0), 0),
        },
      }),
    },
  };

  return { tx: tx as never, movements, created, shelfQueries, shelf, reviews };
}

const batchOn = (store: string, id: string, qty = 50) => ({
  id,
  companyId: 'c1',
  storeId: store,
  productId: PRODUCT,
  quantityRemaining: qty,
  quantitySold: 0,
  costPerUnit: 4,
  productionDate: new Date('2026-01-01'),
});

const consume = (store: string | null, shelf: Row[]) => {
  const l = ledger({ orderStore: store, shelf });
  return consumeOrderStock(l.tx, {
    orderId: ORDER,
    companyId: 'c1',
    userId: 'u1',
  }).then(() => l);
};

const restore = (store: string | null, shelf: Row[]) => {
  const l = ledger({ orderStore: store, shelf, alreadySold: true });
  return restoreOrderStock(l.tx, {
    orderId: ORDER,
    companyId: 'c1',
    receivedQty: 3,
    userId: 'u1',
  }).then(() => l);
};

describe('the ledger line lands on the same shelf as the goods', () => {
  it('the SALE line carries the store the draw-down actually emptied', async () => {
    const l = await consume(MUBARAK, [batchOn(MUBARAK, 'b-m'), batchOn(SIHHA, 'b-s')]);

    expect(l.movements).toHaveLength(1);
    const line = l.movements[0];
    // THE VALUE. `undefined` is what this writer handed Prisma for as long
    // as it existed, and a revert prints exactly that here.
    expect(line.storeId).toBe(MUBARAK);
    expect(line.type).toBe('SALE');
    expect(line.companyId).toBe('c1');

    // And it is the SAME store the units came out of, not a second source:
    // the draw-down asked the shelf for this store and no other.
    const draw = l.shelfQueries.find((w) => w.quantityRemaining)!;
    expect(draw.storeId).toBe(MUBARAK);
    expect(line.storeId).toBe(draw.storeId);

    // Proof the other store's batch was never touched, so «the store the
    // line names» and «the shelf that moved» cannot have come apart.
    expect(l.shelf.find((b) => b.id === 's-sihha-untouched')).toBeUndefined();
    expect(l.shelf.find((b) => b.id === 'b-s')!.quantityRemaining).toBe(50);
    expect(l.shelf.find((b) => b.id === 'b-m')!.quantityRemaining).toBe(47);
  });

  it('and the RETURN line carries the store its own batch was created with', async () => {
    const l = await restore(MUBARAK, [batchOn(MUBARAK, 'b-m')]);

    expect(l.created).toHaveLength(1);
    expect(l.movements).toHaveLength(1);
    const batch = l.created[0];
    const line = l.movements[0];

    expect(batch.storeId).toBe(MUBARAK);
    expect(line.storeId).toBe(MUBARAK);
    // THE PAIR. This is the assertion that was missing: the batch half was
    // written on 2026-10-02 and the movement half was not, and the check
    // that stood here could not tell the difference.
    expect(line.storeId).toBe(batch.storeId);
    expect(line.batchId).toBe(batch.id);
    expect(line.type).toBe('RETURN');
  });

  it('and both rows come back from this store’s own ledger query, which they did not before', async () => {
    const sale = (await consume(MUBARAK, [batchOn(MUBARAK, 'b-m')])).movements[0];
    const ret = (await restore(MUBARAK, [batchOn(MUBARAK, 'b-m')])).movements[0];

    // The real read filter — `/api/inventory/movements` and the ledger block
    // in `/api/inventory` both use it, and it is an EXACT match.
    const mine = inStore('c1', MUBARAK);
    for (const row of [sale, ret]) {
      expect(matchesWhere(row, mine)).toBe(true);
      // The row as these writers used to produce it: everything the same,
      // no shelf. Thirty of them are on this database.
      expect(matchesWhere({ ...row, storeId: undefined }, mine)).toBe(false);
      expect(matchesWhere({ ...row, storeId: null }, mine)).toBe(false);
      // And another store's query must not pick them up either.
      expect(matchesWhere(row, inStore('c1', SIHHA))).toBe(false);
      // Nor a session with no store selected, answered with the company.
      expect(matchesWhere(row, inStore('c1', null))).toBe(false);
    }
  });

  it('and follows the order’s store rather than a constant', async () => {
    const l = await consume(SIHHA, [batchOn(MUBARAK, 'b-m'), batchOn(SIHHA, 'b-s')]);
    expect(l.movements[0].storeId).toBe(SIHHA);
    expect(matchesWhere(l.movements[0], inStore('c1', SIHHA))).toBe(true);
    expect(matchesWhere(l.movements[0], inStore('c1', MUBARAK))).toBe(false);

    const r = await restore(SIHHA, [batchOn(SIHHA, 'b-s')]);
    expect(r.created[0].storeId).toBe(SIHHA);
    expect(r.movements[0].storeId).toBe(SIHHA);
  });

  it('and an order with no store still moves stock, exactly as before', async () => {
    // The convention `onHand` and `drawDownStock` already keep: null means
    // company-wide. `Order.storeId` is nullable in the schema, so this case
    // is real, and it must not start throwing or start inventing a shelf.
    const l = await consume(null, [batchOn(MUBARAK, 'b-m')]);
    expect(l.movements[0].storeId).toBeNull();
    expect(l.shelf.find((b) => b.id === 'b-m')!.quantityRemaining).toBe(47);

    const r = await restore(null, [batchOn(MUBARAK, 'b-m')]);
    expect(r.created[0].storeId).toBeNull();
    expect(r.movements[0].storeId).toBeNull();
    // And such a row is invisible in every store — which is the finding this
    // whole section is about, not a behaviour anyone wants.
    expect(matchesWhere(r.movements[0], inStore('c1', MUBARAK))).toBe(false);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE DRAW CROSSES BATCHES, AND ONLY ONE FUNCTION IS ALLOWED TO DRAW.
 *
 * The legacy delivery door in `PATCH /api/orders/[id]` deducted from ONE
 * batch — `Math.min(existing.quantity, activeBatch.quantityRemaining)` — so
 * an order larger than the oldest batch was delivered and the remainder
 * stayed on the books. It was deleted on 2026-10-07 and replaced by a call
 * to `consumeOrderStock`; the per-door arithmetic is pinned in
 * `src/app/api/orders/[id]/the-delivery-line-lands-on-a-shelf.test.ts`.
 *
 * These two rules are the ones that outlive that door: the draw itself must
 * cross batches, and no SECOND door may ever write the deduction by hand
 * again. Five writers of inventory movements were found in this codebase
 * once; the sixth must not be another delivery path.
 * ─────────────────────────────────────────────────────────────────────────
 */
describe('the draw crosses batches, and nobody deducts by hand', () => {
  it('three units against batches of 1 and 5 empty the first and take two from the second', async () => {
    // The order in this fixture needs 3 (two paid, one gift). The old
    // arithmetic took `min(3, 1)` = ONE and stopped: two units delivered and
    // still on the shelf. Listed NEWEST first, so array order would take 3
    // out of the June batch and leave the January one full — a different
    // pair of numbers from the one asserted.
    const l = await consume(MUBARAK, [
      { ...batchOn(MUBARAK, 'b-june', 5), productionDate: new Date('2026-06-01') },
      { ...batchOn(MUBARAK, 'b-jan', 1), productionDate: new Date('2026-01-01') },
    ]);

    expect(l.shelf.find((b) => b.id === 'b-jan')!.quantityRemaining).toBe(0);
    expect(l.shelf.find((b) => b.id === 'b-june')!.quantityRemaining).toBe(3);
    expect(l.shelf.find((b) => b.id === 'b-jan')!.quantitySold).toBe(1);
    expect(l.shelf.find((b) => b.id === 'b-june')!.quantitySold).toBe(2);

    // One ledger line for the whole draw, and its balance is the PRODUCT's
    // on hand — not the last batch it touched, which held 3 of the 3 left
    // only by coincidence here, so the sum is asserted instead.
    expect(l.movements).toHaveLength(1);
    expect(l.movements[0].quantity).toBe(-3);
    expect(l.movements[0].balanceAfter).toBe(
      l.shelf.reduce((s, b) => s + (b.quantityRemaining ?? 0), 0)
    );
  });

  /*
   * CHANGED 30/10 (P0-13, OLD → NEW). Old: «a shelf shorter than the order refuses rather than taking what it
   * can» — it threw. New: the delivery is recorded, the shelf gives what it HAS, and the rest is not silent: it is
   * reported and written as a review line. Reason (LAUNCH_LINE P0-13): the old block's sin was taking 1 of 3 and
   * saying NOTHING; refusing a delivery that already happened was the other way to be wrong. What the old test
   * protected — «not in silence» — is kept, and asserted below.
   */
  it('and a shelf shorter than the order gives what it has and SAYS what it could not', async () => {
    const l = await consume(MUBARAK, [batchOn(MUBARAK, 'b-jan', 1)]);
    expect(l.shelf.find((b) => b.id === 'b-jan')!.quantityRemaining).toBe(0);
    expect(l.movements).toHaveLength(1);
    expect(l.movements[0]).toMatchObject({ type: 'SALE', quantity: -1, balanceAfter: 0 });
    // The two it did not have are on the order, once.
    expect(l.reviews).toHaveLength(1);
    expect(l.reviews[0]).toMatchObject({ orderId: ORDER, action: 'STOCK_SHORT_AT_DELIVERY' });
    expect(JSON.parse(l.reviews[0].metadata)).toMatchObject({ short: 2, lines: [{ need: 3, taken: 1, short: 2 }] });
  });

  it('and asking twice deducts once — the ledger is the key, not a status column', async () => {
    const first = await consume(MUBARAK, [batchOn(MUBARAK, 'b-m', 10)]);
    expect(first.shelf.find((b) => b.id === 'b-m')!.quantityRemaining).toBe(7);

    // The same world, asked again, as a second delivery door would.
    const again = await consumeOrderStock(first.tx, {
      orderId: ORDER,
      companyId: 'c1',
      userId: 'u1',
    });
    expect(again.alreadyDone).toBe(true);
    expect(again.taken).toBe(0);
    expect(first.shelf.find((b) => b.id === 'b-m')!.quantityRemaining).toBe(7);
    expect(first.movements).toHaveLength(1);
  });

  it('and `consumeOrderStock` is the only thing in the repository that writes a SALE line', async () => {
    /*
     * THE RULE THAT STOPS A SIXTH WRITER. A delivery path that writes its
     * own SALE row writes its own arithmetic with it, and then idempotency,
     * the gift units and the multi-batch walk are all somebody's to get
     * right a second time. That is the whole history of this defect.
     */
    const offenders = dashboardFiles('both')
      .filter((f) => f.rel !== '/src/lib/stock-consumption.ts')
      .filter((f) => /type:\s*('SALE'|"SALE"|SALE\b)/.test(stripTemplates(stripComments(f.src))))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);

    // AND THE CHECK IS NOT VACUOUS: the shape it looks for is present in the
    // one file allowed to have it, so an empty result means «nowhere else»
    // and not «the pattern never matches anything».
    const owner = stripTemplates(stripComments(repoFile('src/lib/stock-consumption.ts')));
    expect(owner).toMatch(/type:\s*SALE\b/);
  });

  it('and every delivery door reaches it rather than reimplementing it', async () => {
    // The five doors that take goods off the shelf. The legacy PATCH is the
    // last of them to join; before 2026-10-07 it deducted by hand, and the
    // four others already called the helper.
    for (const door of [
      'src/app/api/orders/[id]/route.ts',
      'src/app/api/orders/[id]/shipping/route.ts',
      'src/lib/partial-delivery.ts',
      'src/app/api/finance/statements/[id]/route.ts',
      'src/app/api/ops/tracking/write-off/route.ts',
    ]) {
      const src = stripComments(repoFile(door));
      expect(src, door).toMatch(/consumeOrderStock\(/);
      // And none of them does the arithmetic beside the call.
      expect(src, door).not.toMatch(/quantityRemaining: \{ decrement:/);
      expect(src, door).not.toMatch(/quantitySold: \{ increment:/);
    }
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────
 * AND THE BALANCE ON THE LEDGER LINE IS THE SHELF'S, FROM THE ONE FUNCTION
 * THAT KNOWS IT.
 *
 * `balanceAfter` records a DERIVED TOTAL at write time, and the whole value
 * of such a column is that the series adds up when somebody reads it back.
 * `POST /api/production` wrote `balanceAfter: qty` — the NEW BATCH'S OWN
 * QUANTITY. For the first run of a product the two agree, which is why it
 * survived every fixture; for the second they do not. A product holding 50
 * taking a run of 20 wrote 20, and the sale written under it from
 * `onHandTotal` wrote 69, so the series stepped 20 → 69. Fixed 2026-10-07.
 *
 * Six writers of this column exist. Five already asked `onHandTotal`; this
 * one was the exception, and «one of six forgot» is a shape no behavioural
 * test of the other five can see — the same shape as the missing `storeId`
 * in `ad54038`. So the writers are FOUND rather than listed: every
 * `inventoryMovement.create` in the shipped tree, in `scripts` and in
 * `prisma`, must take `balanceAfter` from the shared function, and any site
 * that does not must be WRITTEN DOWN HERE with its reason.
 *
 * Comments and template literals are blanked first, so a file that merely
 * MENTIONS `onHandTotal` in prose does not pass.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** The balanced argument text of a call whose `(` is at `open`. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/**
 * The `balanceAfter` value inside a `create`'s own arguments.
 *
 * Depth-tracked rather than `[^,\n]+`, because the figure this guard is
 * about — `await onHandTotal(db, companyId, productId)` — has commas INSIDE
 * it, and a lazy capture would read it as `await onHandTotal(db` and call
 * that a different expression every time an argument was renamed.
 *
 * And the ES shorthand is the same write: `receiving.ts` computes the
 * figure one line above and passes `balanceAfter,` with no colon at all.
 */
function balanceExpression(args: string): { expression: string; shorthand: boolean } | null {
  const key = /\bbalanceAfter\b/.exec(args);
  if (!key) return null;
  let i = key.index + 'balanceAfter'.length;
  while (i < args.length && /\s/.test(args[i])) i++;
  if (args[i] !== ':') return { expression: 'balanceAfter', shorthand: true };
  i++;
  let depth = 0;
  let out = '';
  for (; i < args.length; i++) {
    const ch = args[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
    out += ch;
  }
  return { expression: out.trim(), shorthand: false };
}

type BalanceSource = 'FROM_SHARED' | 'VIA_LOCAL_FROM_SHARED' | 'COMPUTED_LOCALLY' | 'ABSENT';

interface BalanceSite {
  rel: string;
  line: number;
  expression: string;
  source: BalanceSource;
}

/**
 * Every writer of an inventory movement, with where its balance came from.
 *
 * `receiving.ts` assigns the figure to a local one line above its `create`,
 * so a bare identifier is followed back to its assignment in the same file
 * rather than counted as hand arithmetic.
 */
function balanceSites(): BalanceSite[] {
  const extra = ['prisma/seed.ts', 'scripts/backfill-delivered-stock.ts', 'scripts/place-stock-in-stores.ts'];
  const files: Array<{ rel: string; src: string }> = [
    ...dashboardFiles('both').map((f) => ({ rel: f.rel.replace(/^\//, ''), src: f.src })),
  ];
  for (const rel of extra) {
    try {
      files.push({ rel, src: repoFile(rel) });
    } catch {
      // A script that has been deleted is not an offender.
    }
  }

  const out: BalanceSite[] = [];
  for (const file of files) {
    const src = stripTemplates(stripComments(file.src));
    const CALL = /\.inventoryMovement\.create(?:Many)?\s*\(/g;
    for (let m = CALL.exec(src); m; m = CALL.exec(src)) {
      const open = src.indexOf('(', m.index + 1);
      const args = callArgs(src, open);
      const line = src.slice(0, m.index).split('\n').length;

      const found = balanceExpression(args);
      if (!found) {
        out.push({ rel: file.rel, line, expression: '', source: 'ABSENT' });
        continue;
      }
      const { expression } = found;
      let source: BalanceSource = 'COMPUTED_LOCALLY';
      if (/^await\s+onHandTotal\s*\(/.test(expression)) {
        source = 'FROM_SHARED';
      } else if (/^[A-Za-z_$][\w$]*$/.test(expression)) {
        const assigned = new RegExp(`(?:const|let|var)\\s+${expression}\\s*=\\s*await\\s+onHandTotal\\s*\\(`);
        if (assigned.test(src)) source = 'VIA_LOCAL_FROM_SHARED';
      }
      out.push({ rel: file.rel, line, expression, source });
    }
  }
  return out;
}

describe('the ledger balance comes from the shelf, not from the row being written', () => {
  const sites = balanceSites();

  /**
   * THE SEED, AND WHY IT IS NOT A DEFECT.
   *
   * `prisma/seed.ts` writes `balanceAfter: qty` too, and it is CORRECT BY
   * CONSTRUCTION rather than by luck of the fixture: the product is created
   * by `prisma.product.create` in the same loop iteration, two statements
   * above, and this is the only batch it will ever have at that moment — so
   * its on hand IS `qty`. The seed is also how this database is rebuilt,
   * which makes it the owner's ground and not a file an audit edits.
   */
  const WRITTEN_DOWN: Record<string, string> = {
    'prisma/seed.ts':
      'المنتجُ يُنشَأُ في الدورةِ نفسِها ولا دفعةَ له غيرُها — فالرصيدُ هو الكميّةُ بالبناء. وهو ملفُّ بناءِ القاعدة.',
  };

  it('finds every writer, so the sweep is not looking at nothing', () => {
    // Five in the shipped tree plus the seed. A seventh appearing here is a
    // writer somebody must classify.
    expect(sites.length, JSON.stringify(sites, null, 1)).toBeGreaterThanOrEqual(6);
    const paths = sites.map((s) => s.rel);
    for (const expected of [
      'src/lib/receiving.ts',
      'src/lib/stock-consumption.ts',
      'src/app/api/inventory/route.ts',
      'src/app/api/production/route.ts',
      'prisma/seed.ts',
    ]) {
      expect(paths, `${expected} يَكتُبُ حركةَ مخزونٍ ولم يَرَه الكنس`).toContain(expected);
    }
    // And `stock-consumption.ts` writes TWO of them — the sale and the
    // return — so a sweep that found one per file would be half blind.
    expect(sites.filter((s) => s.rel === 'src/lib/stock-consumption.ts')).toHaveLength(2);
  });

  it('and every one of them takes the figure from `onHandTotal`', () => {
    const offenders = sites
      .filter((s) => s.source !== 'FROM_SHARED' && s.source !== 'VIA_LOCAL_FROM_SHARED')
      .filter((s) => !(s.rel in WRITTEN_DOWN))
      .map((s) => `${s.rel}:${s.line} → balanceAfter: ${s.expression || '(غائب)'} [${s.source}]`);
    expect(
      offenders,
      'رصيدٌ مُشتَقٌّ يُحسَبُ محليّاً بدلَ الدالّةِ المشتركة — السلسلةُ تَتوقّفُ عن الجمعِ عندَ هذا السطر'
    ).toEqual([]);
  });

  it('and the production door in particular, which was the exception', () => {
    const mine = sites.filter((s) => s.rel === 'src/app/api/production/route.ts');
    expect(mine).toHaveLength(1);
    expect(mine[0].source).toBe('FROM_SHARED');
    // The value, so a revert prints what actually reached the column.
    expect(mine[0].expression).not.toBe('qty');
    expect(mine[0].expression).toMatch(/^await onHandTotal\(db, companyId, productId\)/);
  });

  /**
   * THE DETECTOR STILL RECOGNISES WHAT IT WAS WRITTEN FOR.
   *
   * Ten vacuous guards have been caught in this audit. Each way this one
   * could go blind is run rather than assumed.
   */
  it('recognises a locally computed balance, and is not fooled by prose', () => {
    const shape = (body: string) => {
      const src = stripTemplates(stripComments(`await tx.inventoryMovement.create(${body});`));
      const open = src.indexOf('(', src.indexOf('.create'));
      return balanceExpression(callArgs(src, open));
    };

    expect(shape('{ data: { quantity: qty, balanceAfter: qty } }')).toEqual({ expression: 'qty', shorthand: false });

    // THE COMMAS INSIDE THE CALL. `[^,\n]+` read this as `await
    // onHandTotal(db` — which is why the expression is extracted by depth.
    expect(shape('{ data: { balanceAfter: await onHandTotal(db, companyId, productId) } }')).toEqual({
      expression: 'await onHandTotal(db, companyId, productId)',
      shorthand: false,
    });
    // And it stops at the key's own value, not at the end of the object.
    expect(shape('{ data: { balanceAfter: qty, referenceId: batch.id } }')).toEqual({
      expression: 'qty',
      shorthand: false,
    });

    // THE SHORTHAND IS THE SAME WRITE, and `receiving.ts` uses it. A guard
    // that only knew `balanceAfter:` reported that file as ABSENT.
    expect(shape('{ data: { balanceAfter, reason } }')).toEqual({ expression: 'balanceAfter', shorthand: true });
    expect(shape('{ data: { productId } }')).toBeNull();

    // Balanced to the call's own closing paren, so a LATER call that does it
    // right cannot cover for this one.
    const pair = stripComments(
      'await tx.inventoryMovement.create({ data: { balanceAfter: qty } });\n' +
        'await tx.inventoryMovement.create({ data: { balanceAfter: await onHandTotal(tx, c, p) } });'
    );
    const first = callArgs(pair, pair.indexOf('(', pair.indexOf('.create')));
    expect(balanceExpression(first)!.expression).toBe('qty');

    // A SENTENCE ABOUT THE FUNCTION IS NOT THE FUNCTION, in both the forms
    // this repository writes.
    expect(shape('{ data: { /* balanceAfter: await onHandTotal(tx, c, p) */ balanceAfter: qty } }')!.expression).toBe(
      'qty'
    );
    expect(shape('{ data: {\n  // from onHandTotal\n  balanceAfter: qty } }')!.expression).toBe('qty');
    expect(stripTemplates('const s = `await onHandTotal(tx, c, p)`;')).not.toMatch(/onHandTotal/);

    // And the local-assignment follow-back needs the assignment to exist.
    const assigned = /(?:const|let|var)\s+balanceAfter\s*=\s*await\s+onHandTotal\s*\(/;
    expect(assigned.test('const balanceAfter = await onHandTotal(tx, c, p);')).toBe(true);
    expect(assigned.test('const balanceAfter = qty;')).toBe(false);
  });
});
