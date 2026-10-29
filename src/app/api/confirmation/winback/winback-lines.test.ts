import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ORDER WITH NO LINES IS AN ORDER THAT CAN NEVER SHIP.
 *
 * `POST /api/confirmation/winback` raised a real `Order` and not one
 * `OrderItem`. It was the only one of the six order-creation doors that did
 * not — the other five (`POST /api/orders`, `createPublicOrder`,
 * `createTelegramOrder`, `createReplacement`, the AI intake) all write their
 * lines beside the row.
 *
 * What that costs, end to end: `assertReadyToShip` refuses a lineless order
 * BY NAME — «الطلب بلا أسطر — لا يمكن تجهيزه» — and `reserveOrderLines`
 * iterates an empty list, so no stock is ever held. Every win-back offer a
 * customer ever accepted was an order the warehouse could not pick, for a
 * customer the business had deliberately gone back to win. The feature was
 * dead on arrival and no test of the other five doors could see it.
 *
 * TWO THINGS ARE HELD HERE, and they are different in kind:
 *
 *   1. THE DOOR, by behaviour — the route is driven with a mocked database
 *      and the rows it writes are read back. Values, not names.
 *
 *   2. EVERY DOOR, by enumeration — the sweep at the bottom finds the
 *      `order.create({` call sites instead of listing them, so a SEVENTH
 *      door added tomorrow fails until somebody classifies it. That is the
 *      real shape of this defect: «one of six forgot», which no test of the
 *      six could catch and no list written today can anticipate.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit, orderRefFields } = vi.hoisted(() => {
  const db = {
    order: { findFirst: vi.fn(), create: vi.fn() },
    // The offer reads the company's own rule; none stored means the defaults, which is what these claims were written under.
    company: { findUnique: vi.fn(async () => ({ settings: null })) },
    orderItem: { findMany: vi.fn(), createMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orderStatusLog: { findFirst: vi.fn(), findMany: vi.fn() },
    orderNote: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return {
    db,
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    orderRefFields: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-ref', () => ({ orderRefFields: (...a: unknown[]) => orderRefFields(...a) }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: vi.fn() }));

import { POST } from './route';
import { computeCod } from '@/lib/money';
import { assertReadyToShip } from '@/lib/order-state';
import { stripComments, stripTemplates } from '@/lib/guard-source';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const user = { id: 'u-sup', name: 'مشرفة', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE' };

/** JOD: three decimals, like the store these rows were measured on. */
const MINOR = 3;

const ctx = {
  user,
  companyId: 'c1',
  storeId: 's1',
  countryId: 'co1',
  country: { id: 'co1', code: 'JO', currencyCode: 'JOD', minorUnit: MINOR, orderPrefix: 'ORD', allowNegativeStock: false },
};

/**
 * THE ROW THIS WAS MEASURED ON — ORD-2026-0052 of this database.
 *
 *   quantity 3 · sellingPrice 36 · one line of 3 × 12.00 · lineTotal 36
 *
 * So `Order.sellingPrice` is the order's SUBTOTAL, not a unit price: the
 * seed says so in as many words («legacy sellingPrice is the total for the
 * whole quantity»), `OrderLinesCard` divides it by the quantity to show a
 * unit, and every one of the 56 orders in this database agrees — not one has
 * `sellingPrice <> SUM(quantity * unitPrice)`.
 */
const source = {
  id: SOURCE_ID,
  orderNumber: 'ORD-2026-0052',
  confirmationStatus: 'REJECTED',
  rejectionReason: 'PRICE_TOO_HIGH',
  rejectionNote: null,
  shippedAt: null,
  replacedBy: null,
  replaces: null,
  countryId: 'co1',
  storeId: 's1',
  regionId: 'r1',
  customerId: 'cust-1',
  productId: 'prod-1',
  offerId: 'off-1',
  quantity: 3,
  freeQuantity: 0,
  sellingPrice: 36,
  discountAmount: 0,
  shippingCost: 0,
  totalAmount: 36,
  currency: 'JOD',
  priceIncludesDelivery: false,
  productNameSnapshot: 'سكراب',
  productImageSnapshot: null,
  moderatorId: 'mod-1',
  estimatedCostOfGoods: 12.6,
  source: 'TikTok',
  customerNotes: null,
};

/** The source order's own lines: three pieces at twelve. */
const ONE_LINE = [
  { productId: 'prod-1', productName: 'سكراب', quantity: 3, freeQuantity: 0, unitPrice: 12 },
];

const offer = (discount: number) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: SOURCE_ID, discount }),
    })
  );

/** The rows the route handed `orderItem.createMany`. */
const writtenLines = () => db.orderItem.createMany.mock.calls[0][0].data as Record<string, unknown>[];
/** The row the route handed `order.create`. */
const writtenOrder = () => db.order.create.mock.calls[0][0].data as Record<string, number | string>;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue(ctx);
  requirePermission.mockResolvedValue(user);
  db.order.findFirst.mockResolvedValue(source);
  // Rejected well past the fourteen-day cooling period.
  db.orderStatusLog.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 40 * 86_400_000) });
  db.orderItem.findMany.mockResolvedValue(ONE_LINE);
  orderRefFields.mockResolvedValue({ orderNumber: 'ORD-2026-0057', merchantRef: 'ORD-2026-0057' });
  db.order.create.mockImplementation(async () => ({ id: 'new-order', orderNumber: 'ORD-2026-0057' }));
  db.orderItem.createMany.mockResolvedValue({ count: 1 });
  db.orderNote.create.mockResolvedValue({});
});

describe('the win-back order carries the goods of the order it is winning back', () => {
  it('writes a line per line of the original, in the same transaction as the order', async () => {
    const res = await offer(5);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // The lines are read off the order being won back — not invented, and
    // not taken from the request body, which carries only a discount.
    expect(db.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: SOURCE_ID } })
    );

    const lines = writtenLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      companyId: 'c1',
      orderId: 'new-order',
      productId: 'prod-1',
      productName: 'سكراب',
      quantity: 3,
      freeQuantity: 0,
      unitPrice: 12,
      addedStage: 'INTAKE',
    });

    // Both writes went through the transaction client, so an order cannot
    // survive a failure that loses its lines.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  /**
   * THE MONEY, AND THE SECOND DEFECT THE FIRST ONE WAS HIDING.
   *
   * The route handed `computeCod` a single line of `{ quantity: 3,
   * unitPrice: order.sellingPrice }` — a subtotal passed as a unit price and
   * then multiplied by the quantity again. On ORD-2026-0052 that is 108
   * where the customer owes 36, and the discount comes off the inflated
   * figure. A one-unit order gives the right answer, which is why it was
   * invisible: the orders PATCH records fixing this exact mistake
   * («multiplying a price that is already the line's total by the quantity
   * again»), and this door still had it.
   */
  it('charges the subtotal of its lines less the discount — 31, never 103', async () => {
    await offer(5);

    const door = computeCod({
      lines: [{ quantity: 3, unitPrice: 12 }],
      discount: 5,
      deliveryFee: 0,
      priceIncludesDelivery: false,
      minorUnit: MINOR,
    });
    expect(door.subtotal).toBe(36);
    expect(door.cod).toBe(31);

    const row = writtenOrder();
    expect(row.totalAmount).toBe(31);
    expect(row.sellingPrice).toBe(36);
    expect(row.discountAmount).toBe(5);

    // What the old arithmetic produced, named so the test says which number
    // it is refusing: 3 × 36 − 5.
    expect(row.totalAmount).not.toBe(103);
    expect(row.sellingPrice).not.toBe(108);

    // And the line adds up to what the row says is due.
    expect(Number(writtenLines()[0].lineTotal)).toBe(31);
    expect(Number(writtenLines()[0].discountShare)).toBe(5);
  });

  it('allocates the discount across several lines with computeCod’s own shares', async () => {
    db.orderItem.findMany.mockResolvedValue([
      { productId: 'prod-1', productName: 'سكراب', quantity: 3, freeQuantity: 0, unitPrice: 12 },
      { productId: 'prod-2', productName: 'كريم', quantity: 1, freeQuantity: 2, unitPrice: 14 },
    ]);
    await offer(5);

    const lines = writtenLines();
    expect(lines).toHaveLength(2);
    // Gift units travel with their line: they are real stock to be picked.
    expect(lines[1]).toMatchObject({ productId: 'prod-2', quantity: 1, freeQuantity: 2, unitPrice: 14 });

    const money = computeCod({
      lines: [
        { quantity: 3, unitPrice: 12 },
        { quantity: 1, unitPrice: 14 },
      ],
      discount: 5,
      deliveryFee: 0,
      priceIncludesDelivery: false,
      minorUnit: MINOR,
    });
    expect(lines.map((l) => Number(l.discountShare))).toEqual(money.discountShares);
    expect(lines.map((l) => Number(l.lineTotal))).toEqual(money.lineTotals);
    // The parts add back up to the whole, which is the point of storing them.
    expect(lines.reduce((s, l) => s + Number(l.discountShare), 0)).toBe(5);
    expect(lines.reduce((s, l) => s + Number(l.lineTotal), 0)).toBe(Number(writtenOrder().totalAmount));
  });

  /**
   * AN ORDER THAT HAS NO LINES OF ITS OWN IS STILL WINNABLE.
   *
   * Orders predating `OrderItem` — and, until this fix, every win-back order
   * ever written — have only the single-product columns. Those columns are
   * that order's own record of what was bought, and `OrderLinesCard` already
   * renders them as one line when `items` is empty. Refusing here would mean
   * the fix made some lost orders permanently unwinnable.
   */
  it('falls back to the order’s own product columns, with the unit price divided once', async () => {
    db.orderItem.findMany.mockResolvedValue([]);
    const res = await offer(0);
    expect(res.status).toBe(200);

    const lines = writtenLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 'prod-1', productName: 'سكراب', quantity: 3 });
    // 36 for three pieces is 12 each — divided ONCE, never multiplied back.
    expect(Number(lines[0].unitPrice)).toBe(12);
    expect(writtenOrder().totalAmount).toBe(36);
  });

  /**
   * AND NOTHING IS RESERVED YET. The order enters at NEW; stock is held when
   * it is CONFIRMED (`reserveOrderLines` in the confirmation PATCH). A
   * win-back offer nobody has accepted must not hold goods off the shelf.
   */
  it('holds no stock at creation — the lines go in unreserved, as intake writes them', async () => {
    await offer(5);
    expect(writtenOrder().confirmationStatus).toBe('NEW');
    expect(writtenOrder().shippingStatus).toBe('NOT_READY');
    for (const line of writtenLines()) expect(line.reservedQty).toBeUndefined();
    expect(db.orderItem.update).not.toHaveBeenCalled();
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * AND A PARCEL THAT CAME BACK IS RAISED THROUGH THE SAME DOOR (28/10).
 *
 * «قبل الشحن وبعد». The order it wins back is the same goods: refused at the door instead of on the phone,
 * counted back in by the desk. Its lines are its own `OrderItem` rows, the money is `computeCod`'s, and the
 * order and its lines are one write — exactly as for a cancellation, which is what is held here.
 */
/**
 * RV8 — WHO ENTERED THE WIN-BACK ORDER.
 *
 * `createdById` is "the staff account that ENTERED this order". The win-back copied `moderatorId` and left the column
 * empty, so a derived order had no creator at all. It is the person who made the offer — and never the original's
 * creator, which is a fact about the old order's work.
 */
describe('the win-back order names who made the offer', () => {
  it('createdById is the supervisor who pressed it', async () => {
    const res = await offer(5);
    expect(res.status).toBe(200);
    expect(writtenOrder().createdById).toBe('u-sup');
  });

  it('and not the creator of the order being won back', async () => {
    db.order.findFirst.mockResolvedValue({ ...source, createdById: 'someone-else' });
    await offer(5);
    expect(writtenOrder().createdById).toBe('u-sup');
    expect(writtenOrder().createdById).not.toBe('someone-else');
  });
});

describe('a parcel that came back carries the same goods, through the same door', () => {
  const returned = {
    ...source,
    confirmationStatus: 'CONFIRMED',
    rejectionReason: null,
    shippedAt: new Date(Date.now() - 45 * 86_400_000),
    shippingStatus: 'RETURNED',
    returnReason: 'CUSTOMER_REFUSED',
    deliveryFailureReason: null,
    returnReceipt: { inspectedAt: new Date(Date.now() - 20 * 86_400_000) },
  };

  beforeEach(() => {
    db.order.findFirst.mockResolvedValue(returned);
    db.orderStatusLog.findFirst.mockResolvedValue(null);
  });

  it('writes a line per line of the original, inside the order’s transaction, and the same money', async () => {
    const res = await offer(5);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(db.orderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: SOURCE_ID } }));
    expect(writtenLines()).toEqual([
      expect.objectContaining({ orderId: 'new-order', productId: 'prod-1', quantity: 3, freeQuantity: 0, unitPrice: 12, discountShare: 5, lineTotal: 31, addedStage: 'INTAKE' }),
    ]);
    expect(writtenOrder()).toMatchObject({ sellingPrice: 36, discountAmount: 5, totalAmount: 31, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('and with no lines of its own, the same fallback: the product columns, the unit price divided once', async () => {
    db.orderItem.findMany.mockResolvedValue([]);
    expect((await offer(0)).status).toBe(200);
    expect(writtenLines()).toEqual([expect.objectContaining({ productId: 'prod-1', quantity: 3, unitPrice: 12 })]);
    expect(writtenOrder().totalAmount).toBe(36);
  });

  it('and nothing is held off the shelf for it either — the offer enters at NEW', async () => {
    await offer(5);
    for (const line of writtenLines()) expect(line.reservedQty).toBeUndefined();
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * THE SAME ORDER AT THE WAREHOUSE DOOR — the before and the after, run.
 */
describe('a win-back order reaching assertReadyToShip', () => {
  const confirmed = { confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' };

  it('was refused outright while the door wrote no lines', () => {
    const verdict = assertReadyToShip(confirmed, []);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('UNRESERVED_LINES');
    expect(verdict.message).toBe('الطلب بلا أسطر — لا يمكن تجهيزه');
  });

  it('is allowed now, once its own lines are reserved', async () => {
    await offer(5);
    const lines = writtenLines().map((l) => ({
      quantity: Number(l.quantity),
      freeQuantity: Number(l.freeQuantity),
      // What `reserveOrderLines` writes when the order is confirmed.
      reservedQty: Number(l.quantity) + Number(l.freeQuantity),
    }));
    expect(lines).toHaveLength(1);
    expect(assertReadyToShip(confirmed, lines)).toEqual({ allowed: true });

    // And an unreserved line still blocks it — the guard is the reservation's,
    // not merely «is there a row».
    expect(assertReadyToShip(confirmed, [{ ...lines[0], reservedQty: 0 }]).code).toBe('UNRESERVED_LINES');
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * EVERY DOOR THAT RAISES AN ORDER WRITES ITS LINES — AND THE DOORS ARE
 * FOUND, NOT LISTED.
 *
 * The defect's shape is not wrong arithmetic. It is ONE CALL SITE OUT OF SIX
 * that forgot, and no behavioural test of the other five can see it: they all
 * pass happily while a sixth door writes a cripple. A hand-written list of
 * the six has the same hole one door further on, because the seventh door is
 * on nobody's list the day it is written.
 *
 * So this sweeps the shipped tree for `order.create({` and demands that the
 * file writing it also write `OrderItem` rows — or be WRITTEN DOWN BELOW
 * with the reason it does not. Comments and template literals are blanked
 * first, so a file that merely MENTIONS `orderItem.createMany` in prose
 * fails: the thing this audit keeps catching is a guard satisfied by a name
 * being present rather than used, and the self-check at the end of this
 * block proves this one is not.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Every shipped `.ts`/`.tsx` that can write a row — src, the seed, the scripts. */
function shippedFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) {
        out.push({ rel: relative(process.cwd(), p).split('\\').join('/'), src: readFileSync(p, 'utf8') });
      }
    }
  };
  for (const root of ['src', 'scripts', 'prisma']) walk(join(process.cwd(), root));
  return out;
}

/** `tx.order.create({` / `db.order.create({` — and never `orderItem.create(`. */
const CREATES_AN_ORDER = /\border\.create\(\s*\{/;
/** The CALL, not the name: an import or a sentence naming it does not count. */
const CREATES_LINES = /\borderItem\.create(?:Many)?\(\s*\{/;

/**
 * DOORS THAT RAISE AN ORDER AND WRITE NO LINES THEMSELVES, with the reason.
 *
 * Empty, and that is the finding rather than an oversight: all six doors now
 * write their own lines. An entry here would have to say WHERE the lines are
 * written instead — a door that delegates to a helper, say — because «it
 * does not need lines» is not a thing an order can be: `assertReadyToShip`
 * refuses a lineless order whatever raised it.
 */
const LINES_WRITTEN_ELSEWHERE: Record<string, string> = {};

describe('every door that raises an order writes its lines', () => {
  const doors = shippedFiles()
    .map(({ rel, src }) => ({ rel, clean: stripTemplates(stripComments(src)) }))
    .filter(({ clean }) => CREATES_AN_ORDER.test(clean));

  it('finds the doors at all — a guard over an empty list proves nothing', () => {
    // Six today. A rename or a refactor that blinds the matcher must fail
    // loudly rather than pass over nothing.
    expect(doors.length).toBeGreaterThanOrEqual(6);
    const rels = doors.map((d) => d.rel);
    for (const known of [
      'src/app/api/confirmation/winback/route.ts',
      'src/app/api/orders/route.ts',
      'src/app/api/orders/ai-intake/route.ts',
      'src/lib/public-order.ts',
      'src/lib/replacement-order.ts',
      'src/lib/telegram/order-creation.ts',
    ]) {
      expect(rels, `${known} no longer looks like an order door`).toContain(known);
    }
  });

  it('and not one of them raises an order it leaves without lines', () => {
    const lineless = doors.filter((d) => !CREATES_LINES.test(d.clean)).map((d) => d.rel);
    const unexplained = lineless.filter((rel) => !(rel in LINES_WRITTEN_ELSEWHERE));
    expect(
      unexplained,
      'بابٌ يُنشئ طلباً بلا أسطر — الطلب بلا أسطر لا يُجهَّز أبداً. إمّا أن يكتب أسطره، ' +
        'أو أن يُكتَب هنا مع موضع كتابتها'
    ).toEqual([]);
    // And the list does not rot into an excuse for the next omission.
    for (const rel of Object.keys(LINES_WRITTEN_ELSEWHERE)) {
      expect(lineless, `${rel} no longer needs its entry`).toContain(rel);
    }
  });

  /**
   * THE DETECTOR STILL RECOGNISES WHAT IT WAS WRITTEN FOR.
   *
   * Seven guards in this audit passed with the feature removed. These four
   * strings are the four ways this one could go blind.
   */
  it('recognises a lineless door, and is not fooled by the name alone', () => {
    const door = 'const o = await tx.order.create({ data: { quantity: 1 } });';
    expect(CREATES_AN_ORDER.test(door)).toBe(true);
    expect(CREATES_LINES.test(door)).toBe(false);

    const fixed = `${door}\nawait tx.orderItem.createMany({ data: [] });`;
    expect(CREATES_LINES.test(fixed)).toBe(true);

    /*
     * A SENTENCE ABOUT LINES IS NOT A LINE — the exact failure shape this
     * audit keeps finding, so it is asserted rather than assumed. Both the
     * shapes real prose takes in this repository are checked: a block
     * comment above the call, and a commented-out call on its own line.
     *
     * What `stripComments` does NOT blank is a trailing `//` on a line of
     * code (its regex is anchored at `^`), so a mention parked at the end of
     * a code line would still count. No file in this tree writes prose that
     * way, and the stripper is shared by nine guards — widening it here with
     * a local copy is how the copies that cost this redesign the most hours
     * came about. Said plainly instead of claimed as a protection.
     */
    const prose = `${door}\n// await tx.orderItem.createMany({ data: [] });`;
    expect(CREATES_LINES.test(stripComments(prose))).toBe(false);
    expect(CREATES_LINES.test(stripComments(`/* orderItem.createMany({ */\n${door}`))).toBe(false);

    // And a line write is not mistaken for an order write.
    expect(CREATES_AN_ORDER.test('await tx.orderItem.create({ data: {} });')).toBe(false);
  });

  /** The winback's own two writes, named, so a revert cannot pass quietly. */
  it('and the winback writes its lines inside the order’s own transaction', () => {
    const src = stripTemplates(stripComments(readFileSync(
      join(process.cwd(), 'src/app/api/confirmation/winback/route.ts'), 'utf8'
    )));
    const tx = src.slice(src.indexOf('db.$transaction'));
    const body = tx.slice(0, tx.indexOf('\n    });'));
    expect(body).toMatch(CREATES_AN_ORDER);
    expect(body).toMatch(CREATES_LINES);
    // The lines belong to the order just created, not to the one being won back.
    expect(body).toMatch(/orderId: fresh\.id/);
  });
});
