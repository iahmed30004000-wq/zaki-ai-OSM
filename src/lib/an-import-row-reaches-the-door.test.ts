import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

/**
 * THE WHOLE PATH, FROM A CELL IN A SPREADSHEET TO THE ROW PRISMA IS HANDED.
 *
 * Ten vacuous guards have been found in this audit, and the shape of all ten
 * was the same: a test that asserted a reader in isolation while the thing
 * the reader fed went on unmeasured. The importer's defect is exactly that
 * shape in reverse — the reader is in `order-import.ts`, the figure it
 * produces is posted by `ImportOrdersDialog.tsx`, and the door that would
 * have refused a malformed number is `POST /api/orders`, three files away
 * and looking at a number that is already clean. No one of the three can be
 * tested alone and mean anything.
 *
 * So this file drives all four links:
 *
 *   1. a CSV with «٣٥٠٠» in the price column, through `POST /api/orders/import`
 *   2. the row that door answers with
 *   3. the request body `ImportOrdersDialog` builds — NOT retyped here but
 *      EVALUATED out of the component's own source, so a change to what the
 *      screen posts changes what this test posts
 *   4. the real `POST /api/orders`, with the figure read off
 *      `order.create`'s `data`
 *
 * THE ROW IS ASSERTED BEFORE THE STATUS CODE, deliberately. An earlier
 * agent's first draft asserted the status first, so when it was mutated the
 * output said «200 instead of 400» and the figure that had been stored never
 * appeared. A guard on money has to print the money.
 */

const { db, requireContext, requirePermission, activeBlock, logAudit, notify, noteCustomersHandedOut } =
  vi.hoisted(() => ({
    db: {
      region: { findFirst: vi.fn() },
      customerBlock: { findFirst: vi.fn() },
      customer: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      product: { findFirst: vi.fn(), findMany: vi.fn() },
      store: { findFirst: vi.fn() },
      deliveryFee: { findFirst: vi.fn() },
      productionBatch: { findMany: vi.fn() },
      offer: { findFirst: vi.fn() },
      user: { findFirst: vi.fn() },
      order: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
      orderItem: { createMany: vi.fn() },
      orderActivity: { create: vi.fn() },
      orderStatusLog: { create: vi.fn() },
      // The highest order number, asked as a NUMBER in SQL (ط41); see the answer in `beforeEach`.
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    activeBlock: vi.fn(),
    logAudit: vi.fn(),
    notify: vi.fn(),
    noteCustomersHandedOut: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => notify(...a), afterResponse: (w: () => Promise<unknown>) => void w() }));
vi.mock('@/lib/pii-alert', () => ({
  noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a),
  distinctCustomers: () => 0,
}));
vi.mock('@/lib/blacklist', () => ({ activeBlock: (...a: unknown[]) => activeBlock(...a) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
  can: () => true,
  authorize: () => ({ allowed: true }),
}));
vi.mock('@/lib/rbac', () => ({ applyQueueFilter: (_u: unknown, w: unknown) => w }));

import { POST as IMPORT } from '@/app/api/orders/import/route';
import { POST as CREATE } from '@/app/api/orders/route';

const PRODUCT = 'كريم مرطّب';
const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const HEAD = ['الاسم', 'الهاتف', 'العنوان', 'المنتج', 'الكمية', 'السعر'];

/** A one-row sheet, posted as a file the way the screen posts it. */
async function readSheet(qty: string, price: string) {
  const csv = [HEAD, ['أحمد المغني', '0999123456', 'حمص — شارع الحضارة', PRODUCT, qty, price]]
    .map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(','))
    .join('\n');
  const body = new FormData();
  body.append('file', new File([csv], 'orders.csv', { type: 'text/csv' }));
  const res = await IMPORT(new Request('http://localhost/api/orders/import', { method: 'POST', body }));
  return { status: res.status, data: (await res.json()) as any };
}

/**
 * THE BODY THE SCREEN POSTS, TAKEN OUT OF THE SCREEN.
 *
 * `JSON.stringify({ … })` in `ImportOrdersDialog.run` is sliced out of the
 * component by balanced braces and evaluated with the row bound to `r`. A
 * body retyped here would be a test of what somebody remembered the screen
 * sending; this is a test of what it sends. If the literal cannot be found
 * or cannot be evaluated, the extraction throws and the test fails — it
 * cannot quietly fall back to a body of its own.
 */
function bodyTheScreenPosts(row: unknown): Record<string, unknown> {
  const src = stripComments(repoFile('src/components/orders/ImportOrdersDialog.tsx'));
  const marker = 'JSON.stringify(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('الشاشةُ لم تَعُد تُسلسِلُ جسمَ الطلب');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error('جسمُ الطلبِ غيرُ متوازنِ الأقواس');
  const literal = src.slice(open, end + 1);
  // It must really be the order body, not some other object in the file.
  expect(literal, 'الجسمُ المُستخرَجُ ليس جسمَ الطلب').toContain('customerPhone');
  const make = new Function('r', 'return ' + literal) as (r: unknown) => Record<string, unknown>;
  return make(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Admin', role: 'COMPANY_ADMIN', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co-sy',
    country: { id: 'co-sy', currencyCode: 'SYP', minorUnit: 2, orderPrefix: 'SY', allowNegativeStock: false },
  });
  requirePermission.mockResolvedValue({});
  activeBlock.mockResolvedValue(false);
  db.customerBlock.findFirst.mockResolvedValue(null);
  db.order.findMany.mockResolvedValue([]);
  db.order.findFirst.mockResolvedValue(null);
  // No numbered orders yet — what `order.findFirst: null` said before the number was read as a number.
  db.$queryRaw.mockResolvedValue([{ highest: null }]);
  db.product.findMany.mockResolvedValue([
    { id: PRODUCT_ID, name: PRODUCT, nameEn: null, sku: 'SKU-1', basePrice: 14, image: null, batches: [] },
  ]);
  db.product.findFirst.mockResolvedValue({ id: PRODUCT_ID, name: PRODUCT, image: null, basePrice: 14, batches: [] });
  db.productionBatch.findMany.mockResolvedValue([]);
  // The store does not fold the delivery fee into the price, so the figure
  // the sheet carried is the figure stored — no arithmetic in between.
  db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
  db.deliveryFee.findFirst.mockResolvedValue(null);
  db.customer.findUnique.mockResolvedValue({ id: 'cust1', firstOrderDate: null });
  db.customer.findFirst.mockResolvedValue({ id: 'cust1', firstOrderDate: null });
  db.order.create.mockResolvedValue({ id: 'o1', orderNumber: 'SY-2026-0001' });
  db.$transaction.mockImplementation(async (fn: any) => (typeof fn === 'function' ? fn(db) : fn));
});

/** The figures of the row `order.create` was actually handed. */
const stored = () => {
  expect(db.order.create, 'لم يُنشَأْ طلبٌ أصلاً').toHaveBeenCalled();
  const data = db.order.create.mock.calls[0][0].data;
  return { sellingPrice: data.sellingPrice, quantity: data.quantity, totalAmount: data.totalAmount };
};

describe('a price typed on an Arabic keypad survives the whole import path', () => {
  /**
   * NOTHING IS ASSERTED UNTIL THE WHOLE PATH HAS RUN, and then the STORED
   * FIGURE is asserted first. A draft of this test checked the parsed row on
   * the way past, so breaking the reader printed «expected +0 to be 3500»
   * about an intermediate value and the row Prisma was handed never
   * appeared. The figure that matters is the one in the column.
   */
  it('three thousand five hundred is stored as 3500 — not as zero', async () => {
    const read = await readSheet('1', '٣٥٠٠');
    const row = read.data.rows[0];
    const body = bodyTheScreenPosts(row);
    const res = await CREATE(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );

    // THE ROW PRISMA WAS HANDED, before anything else is looked at.
    expect(stored().sellingPrice, 'بريزما استلمت سعراً غير الذي في الجدول').toBe(3500);
    expect(stored().quantity, 'وكميّةً غيرَ التي في الجدول').toBe(1);

    // Then the links, so a failure says WHICH of them broke.
    expect(read.status, JSON.stringify(read.data)).toBe(200);
    expect(row.sellingPrice, 'الباب الأول قرأ السعر خطأً').toBe(3500);
    expect(row.problems).toEqual([]);
    expect(row.importable).toBe(true);
    expect(body.sellingPrice, 'الشاشةُ لا تُرسِلُ السعرَ الذي قُرِئ').toBe(3500);
    expect(res.status).toBe(200);
  });

  it('and a quantity typed the same way reaches the door as a count', async () => {
    const read = await readSheet('٣', '12');
    const row = read.data.rows[0];
    expect(row.quantity, 'الكميّةُ العربيّةُ لم تُقرأ').toBe(3);

    const body = bodyTheScreenPosts(row);
    expect(body.quantity).toBe(3);

    await CREATE(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
    expect(stored().quantity).toBe(3);
    expect(stored().sellingPrice).toBe(12);
  });
});

describe('and a cell nobody can read never becomes an order at all', () => {
  it('the import door marks the row unimportable and says why, in Arabic', async () => {
    const read = await readSheet('1', '3,5');
    const row = read.data.rows[0];
    expect(row.sellingPrice, 'سعرٌ مُلفَّقٌ من خليّةٍ غامضة').toBeNull();
    expect(row.importable).toBe(false);
    expect(row.problems.map((p: any) => p.kind)).toContain('BAD_PRICE');
    expect(row.problems.find((p: any) => p.field === 'sellingPrice').ar).toContain('3,5');
    // And nothing was written by the reading door itself.
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  /**
   * AND IF SOMETHING DID POST IT, the door refuses it — which is the second
   * half of the ruling. The screen cannot tick such a row, so this is the
   * state of the world below the screen: the figure the sheet carried is not
   * a figure the create door will accept either, once the importer stops
   * rewriting it into one.
   */
  it('and the raw cell, posted as it stands, is refused by the create door', async () => {
    const res = await CREATE(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'أحمد المغني',
          customerPhone: '0999123456',
          customerAddress: 'حمص',
          productId: PRODUCT_ID,
          quantity: 1,
          sellingPrice: '3,5',
        }),
      })
    );
    expect(db.order.create, 'الباب كَتَبَ سعراً من خليّةٍ غامضة').not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  /**
   * THE FINDING THAT WAS OPEN HERE, CLOSED ON 22/10 BY THE OWNER'S RULING — «ارفض الصف».
   *
   * Found while this path was first measured: an EMPTY price cell was legal (the column was `required: false`, and the template this
   * very parser generated shipped an example row with the price blank), and was assumed to mean «charge the product's own price». It
   * did not. The create door builds its line as
   *
   *     unitPrice: sellingPrice ?? 0
   *
   * and reads `basePrice` nowhere, so a blank price cell stored an order at ZERO on a product whose catalogue price is 14 — the
   * same silent zero this whole change was about, reached by an ABSENT cell instead of a mis-read one.
   *
   * It was recorded and not fixed, because the fix was a ruling: make the column required, or fill the catalogue price at the import
   * door, or fall back to `basePrice` at the create door. The owner chose the first — the choice that changes nothing in how an order
   * is created. So the empty cell is refused where it is read, and the three links below are the three places it could have got out:
   * the reading door, the screen's tick, and the screen's own guard.
   *
   * THE ROW IS ASSERTED BEFORE THE STATUS, as in the rest of this file, and `order.create` is asserted never to have been called.
   */
  it('an empty price cell is refused at the reading door, by name, and nothing is written', async () => {
    const read = await readSheet('2', '');
    const row = read.data.rows[0];

    expect(row.sellingPrice).toBeNull();
    expect(row.problems.map((p: any) => [p.field, p.kind, p.ar]), 'الخليّةُ الفارغةُ لم تُسمَّ').toEqual([
      ['sellingPrice', 'MISSING', 'السعر مفقود'],
    ]);
    expect(row.importable, 'صفٌّ بلا سعرٍ يُعرَضُ للاستيراد').toBe(false);
    expect(read.status, JSON.stringify(read.data)).toBe(200);
    expect(db.order.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  /**
   * A FILE WITH NO PRICE COLUMN AT ALL is refused at the door, whole — with the column named — which is what «every row has an
   * empty price» comes to. It used to import every row at ZERO.
   */
  it('and a file with no price column at all is refused whole, naming the price', async () => {
    const csv = [
      ['الاسم', 'الهاتف', 'العنوان', 'المنتج', 'الكمية'],
      ['أحمد المغني', '0999123456', 'حمص', PRODUCT, '1'],
    ]
      .map((r) => r.join(','))
      .join('\n');
    const body = new FormData();
    body.append('file', new File([csv], 'orders.csv', { type: 'text/csv' }));
    const res = await IMPORT(new Request('http://localhost/api/orders/import', { method: 'POST', body }));
    const data = (await res.json()) as any;
    expect(data.missing, JSON.stringify(data)).toEqual(['السعر']);
    expect(data.code).toBe('MISSING_COLUMNS');
    expect(data.error).toContain('السعر');
    expect(res.status).toBe(400);
    expect(db.order.create).not.toHaveBeenCalled();
  });

  /**
   * THE BOUNDARY, THROUGH THE WHOLE PATH: a price somebody typed is a price, «0» included. A deliberate free order (a sample, a
   * gift) is the person's to make, the create door accepts it, and the ruling is about the cell nobody filled in. Held here so that
   * «empty» and «zero» cannot be folded into one by a tidy-up.
   */
  it('while a typed zero is still a price — it reaches the order as the zero somebody wrote', async () => {
    const read = await readSheet('2', '0');
    const row = read.data.rows[0];
    expect(row.sellingPrice).toBe(0);
    expect(row.problems).toEqual([]);
    expect(row.importable).toBe(true);

    const body = bodyTheScreenPosts(row);
    expect(body.sellingPrice, 'الشاشةُ أسقطَت الصفرَ المكتوب').toBe(0);
    await CREATE(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
    expect(stored().sellingPrice).toBe(0);
    expect(stored().quantity).toBe(2);
  });

  /**
   * THE SCREEN'S OWN GUARD, below the tick. The tick of an unfinished row is disabled, so the guard is unreachable through the
   * screen — which is why it is three lines and not a dialog. What it buys is that there is NO path, reachable or not, that turns
   * an unreadable quantity into a quantity of one or an empty price into a price of ZERO on its way to the order door. It is held
   * in behaviour by `the-import-dialog-says-what-the-model-is.test.tsx` (a row the server calls importable but that has no price is
   * not posted) and in shape here.
   */
  it('and the screen posts a price only when the sheet gave one — there is no «leave it out» branch left', () => {
    const src = stripComments(repoFile('src/components/orders/ImportOrdersDialog.tsx'));
    expect(src).toContain('if (!r.productId || r.quantity === null || r.sellingPrice === null) {');
    expect(src, 'الشاشةُ ما زالت تحذف السعرَ الفارغَ من الطلب بدل أن ترفضه').not.toMatch(/\.\.\.\(r\.sellingPrice !== null \?/);
    expect(src).toMatch(/sellingPrice: r\.sellingPrice,/);
  });

  it('and an unreadable quantity leaves the screen nothing to send', async () => {
    const read = await readSheet('0x10', '12');
    const row = read.data.rows[0];
    expect(row.quantity, 'ستّةَ عشرَ وحدةً من «0x10»').toBeNull();
    expect(row.importable).toBe(false);

    // The screen refuses it rather than posting a quantity nobody typed.
    const src = stripComments(repoFile('src/components/orders/ImportOrdersDialog.tsx'));
    expect(src).toContain('if (!r.productId || r.quantity === null || r.sellingPrice === null) {');
  });
});
