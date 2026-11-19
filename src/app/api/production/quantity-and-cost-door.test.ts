import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PRODUCTION DOOR'S NUMBERS, AND WHAT THEY USED TO BECOME.
 *
 * `POST /api/production` guarded a quantity with
 *
 *     !quantityProduced || quantityProduced <= 0
 *
 * which is not a number guard. On the STRING `'abc'` both halves are false,
 * so it passed; `parseInt` then produced `NaN`, 5 out of `'5abc'`, 3 out of
 * the Arabic-keyboard `'3,5'`, 1 out of `'1e3'`, and **0** out of `'0x10'` —
 * a zero quantity past a guard whose whole text says the quantity must be
 * above zero. The four cost buckets were `parseFloat(x) || 0`, so a cost
 * that was not a number was recorded as **nothing**, and that nothing flows
 * through `batchTotal` into `totalProductionCost`, `costPerUnit`, and every
 * COGS figure downstream.
 *
 * MEASURED, because the `NaN` case does not end where it looks like it
 * ends: Prisma refuses `NaN` for an `Int` column
 * (`PrismaClientValidationError`, raised client-side before any SQL), so
 * the batch was never stored — the operator got a 500 «حدث خطأ داخلي»
 * where a 400 naming the field was waiting. The silent ones are the
 * expensive ones, and those DID store.
 *
 * These call the real `POST` and read THE ROW IT WROTE, so a fallback put
 * back anywhere between the body and `db.productionBatch.create` fails
 * them. The source sweep at the end is the minority of this file and is
 * only there to stop a deleted shape returning in a place no row can show.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    // `aggregate` is what `onHandTotal` asks, and the door now takes the
    // ledger line's `balanceAfter` from it rather than from the run's own
    // quantity. Without it on the fake, every POST here answered 500.
    productionBatch: { findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    product: { findFirst: vi.fn() },
    inventoryMovement: { create: vi.fn() },
    // 19/11 (W2a): the run and its ledger line are ONE transaction now, which takes the product's stock lock (`$executeRaw`) —
    // inside a transaction, so the client handed to it is one without `$transaction`.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(new Proxy(db, { has: (o, p) => p !== '$transaction' && p in o }))),
    $executeRaw: vi.fn(async () => 1),
    // 19/11 (W2a): a receipt asks «is this store placed in warehouses?» (`warehouse-intake.storeIsPlaced`) — never, here.
    warehousePlacement: { findUnique: vi.fn(async () => null) },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './route';

const PRODUCT = '11111111-1111-4111-8111-111111111111';

/** A sound body; each test replaces exactly the field it is about. */
const sound = { productId: PRODUCT, batchNumber: 'BATCH-2026-001', quantityProduced: 1000 };

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/production', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The row as it actually reached the database. */
const written = () => db.productionBatch.create.mock.calls[0][0].data;
/** And the stock movement written beside it. */
const moved = () => db.inventoryMovement.create.mock.calls[0][0].data;

/** The batches this door has written, so `onHandTotal` has something to sum. */
const shelf: Array<Record<string, any>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1' },
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'SYP' },
  });
  requirePermission.mockResolvedValue(undefined);
  db.productionBatch.findUnique.mockResolvedValue(null);
  db.product.findFirst.mockResolvedValue({ id: PRODUCT, name: 'كريم', sourceType: 'MANUFACTURED' });
  /*
   * A SHELF THAT STARTS EMPTY AND HOLDS WHAT THIS DOOR PUTS ON IT.
   *
   * The ledger line's `balanceAfter` now comes from `onHandTotal`, which
   * asks `aggregate` — so a fake that answered a constant would make every
   * assertion about that column a sentence about the fake. The run the door
   * just wrote is on the shelf from the moment `create` returns, which is
   * the only way «the balance after» is answerable at all.
   */
  shelf.length = 0;
  db.productionBatch.create.mockImplementation(async (args: any) => {
    const row = { id: 'b1', batchNumber: args.data.batchNumber, ...args.data };
    shelf.push(row);
    return row;
  });
  db.productionBatch.aggregate.mockImplementation(async ({ where }: any) => ({
    _sum: {
      quantityRemaining: shelf
        .filter((b) => b.companyId === where.companyId && b.productId === where.productId)
        .reduce((s, b) => s + (b.quantityRemaining ?? 0), 0),
    },
  }));
  db.inventoryMovement.create.mockResolvedValue({ id: 'm1' });
});

/** What the OLD door would have stored, so each test states the loss. */
const oldQty = (raw: unknown) => parseInt(raw as string, 10);
const oldCost = (raw: unknown) => parseFloat(raw as string) || 0;
/** And the old guard, so «it passed the guard» is demonstrated, not claimed. */
const oldGuard = (raw: any) => !raw || raw <= 0;

describe('the quantity a person types is the quantity that is stored', () => {
  it('and the old guard let five strings through that were not numbers', () => {
    expect(oldGuard('abc')).toBe(false);
    expect(oldQty('abc')).toBeNaN(); // → Prisma refuses an Int NaN → 500

    expect(oldGuard('5abc')).toBe(false);
    expect(oldQty('5abc')).toBe(5); // stored, silently

    expect(oldGuard('3,5')).toBe(false);
    expect(oldQty('3,5')).toBe(3);

    expect(oldGuard('1e3')).toBe(false);
    expect(oldQty('1e3')).toBe(1); // a thousand typed, one recorded

    expect(oldGuard('0x10')).toBe(false);
    expect(oldQty('0x10')).toBe(0); // zero units, past a «> 0» guard
  });

  it('and each of them is answered 400, with a sentence naming the field, and no row written', async () => {
    for (const bad of ['abc', '5abc', '3,5', '0x10', '', '   ', null, {}, [], true]) {
      vi.clearAllMocks();
      db.productionBatch.findUnique.mockResolvedValue(null);
      const res = await post({ ...sound, quantityProduced: bad });
      // THE VALUE FIRST, and not merely «was not called»: break the schema
      // and this prints what reached `quantityProduced` — `[NaN]` for
      // `'abc'`, `[5]` for `'5abc'`, `[3]` for `'3,5'`, `[0]` for `'0x10'`.
      expect(
        db.productionBatch.create.mock.calls.map((c: any) => c[0].data.quantityProduced),
        `كمية «${String(bad)}» كُتبت`
      ).toEqual([]);
      expect(res.status, `كمية «${String(bad)}»`).toBe(400);
      expect((await res.json()).error, `كمية «${String(bad)}»`).toContain('الكمية المنتجة');
    }
  });

  it('and «1e3» is the one of the five that is READ now rather than refused — correctly', async () => {
    /*
     * MY OWN CLAIM, CORRECTED BY THE TEST. `1e3` is not malformed: it is a
     * thousand, written the way a number may be written, and
     * `numeric-input`'s header allows scientific notation on purpose
     * because a form may produce `5e-1`. The old door read it as **1**. So
     * this input moves from «stores the wrong number» to «stores the right
     * one», not to «refused».
     */
    expect(oldQty('1e3')).toBe(1);
    const res = await post({ ...sound, quantityProduced: '1e3' });
    expect(res.status).toBe(200);
    expect(written().quantityProduced).toBe(1000);
  });

  it('and a run of nothing, or of half a unit, is refused', async () => {
    for (const bad of [0, -5, 2.5]) {
      vi.clearAllMocks();
      db.productionBatch.findUnique.mockResolvedValue(null);
      expect((await post({ ...sound, quantityProduced: bad })).status, String(bad)).toBe(400);
      expect(db.productionBatch.create).not.toHaveBeenCalled();
    }
  });

  it('and the refusal reads as «write a number», not as «you left it empty»', async () => {
    // `الكمية المنتجة مطلوب` for a box somebody HAS filled sends them
    // looking for an empty field. The two cases are different sentences.
    const typed = await post({ ...sound, quantityProduced: 'abc' });
    expect(await typed.json()).toMatchObject({ error: 'الكمية المنتجة: اكتبه رقماً بالأرقام' });

    vi.clearAllMocks();
    db.productionBatch.findUnique.mockResolvedValue(null);
    const absent = await post({ productId: PRODUCT, batchNumber: 'BATCH-2026-002' });
    expect(await absent.json()).toMatchObject({ error: 'الكمية المنتجة مطلوب' });

    vi.clearAllMocks();
    db.productionBatch.findUnique.mockResolvedValue(null);
    // And a fraction, where the «whole number» half appears: the value IS a
    // number there, so it is `int` that failed.
    const half = await post({ ...sound, quantityProduced: 2.5 });
    expect(await half.json()).toMatchObject({ error: 'الكمية المنتجة: اكتبه رقماً صحيحاً بالأرقام' });
  });

  it('and the number that was typed is the number on the row AND on the stock movement', async () => {
    const res = await post({ ...sound, quantityProduced: ' 1000 ' });
    expect(res.status).toBe(200);
    expect(written().quantityProduced).toBe(1000);
    expect(written().quantityRemaining).toBe(1000);
    expect(moved().quantity).toBe(1000);
    expect(moved().balanceAfter).toBe(1000);
  });
});

describe('a cost that is not a number is refused, and is not recorded as nothing', () => {
  it('and the old door recorded exactly nothing for each of these', () => {
    expect(oldCost('abc')).toBe(0);
    expect(oldCost('')).toBe(0);
    expect(oldCost(null)).toBe(0);
    expect(oldCost({})).toBe(0);
    // And the two that stored a WRONG number rather than zero.
    expect(oldCost('2,500')).toBe(2); // two thousand five hundred typed, two stored
    expect(oldCost('12abc')).toBe(12);
  });

  it('and this is the unit cost that zero and «2,500» produced, in money', async () => {
    // 2500 manufacturing, 500 packaging, 1000 units — three per unit.
    const res = await post({ ...sound, manufacturingCost: 2500, packagingCost: 500 });
    expect(res.status).toBe(200);
    expect(written().totalProductionCost).toBe(3000);
    expect(written().costPerUnit).toBe(3);
    // What the old door wrote for the same run typed with a thousands
    // separator: 2 + 500 = 502, and a unit cost of half a currency unit.
    expect(oldCost('2,500') + oldCost('500')).toBe(502);
    expect(Number((502 / 1000).toFixed(4))).toBe(0.502);
  });

  it('and all four buckets answer 400 for a non-number, writing nothing', async () => {
    for (const field of ['manufacturingCost', 'packagingCost', 'rawMaterialCost', 'otherCosts']) {
      for (const bad of ['abc', '2,500', '12abc', '0x10', '', null, {}, true, -1]) {
        vi.clearAllMocks();
        db.productionBatch.findUnique.mockResolvedValue(null);
        const res = await post({ ...sound, [field]: bad });
        // The value first, so a restored `|| 0` prints `[0]` — the cost that
        // was recorded as nothing.
        expect(
          db.productionBatch.create.mock.calls.map((c: any) => c[0].data[field]),
          `${field} = «${String(bad)}»`
        ).toEqual([]);
        expect(res.status, `${field} = «${String(bad)}»`).toBe(400);
      }
    }
  });

  it('and a zero cost is still stored, because a run can genuinely have none', async () => {
    const res = await post({ ...sound, manufacturingCost: 2500, packagingCost: 0 });
    expect(res.status).toBe(200);
    expect(written().packagingCost).toBe(0);
    // An ABSENT bucket is the column's own default, declared once in the
    // schema and not re-applied at the write site.
    expect(written().rawMaterialCost).toBe(0);
    expect(written().otherCosts).toBe(0);
    expect(written().totalProductionCost).toBe(2500);
  });
});

describe('a negative cost line is refused, not clamped to zero', () => {
  it('and the clamp understated the batch by exactly what was typed', () => {
    const clamped = Math.max(0, Number(-500) || 0);
    expect(clamped).toBe(0);
    // Two named lines, one of them entered as -500 by mistake: the operator
    // read 1.2 per unit and had no sign their -500 had been dropped.
    expect(1200 + clamped).toBe(1200);
    expect(Number(((1200 + clamped) / 1000).toFixed(4))).toBe(1.2);
  });

  it('and it is refused now, with the four buckets beside it under the same rule', async () => {
    const line = await post({ ...sound, costLines: [{ label: 'قالب', amount: -500 }] });
    // The value first: put the clamp back and this prints `[0]` — the
    // -500 the operator typed, silently turned into nothing.
    expect(
      db.productionBatch.create.mock.calls.flatMap((c: any) =>
        (c[0].data.costLines?.create ?? []).map((l: any) => l.amount)
      )
    ).toEqual([]);
    expect(line.status).toBe(400);
    expect(db.productionBatch.create).not.toHaveBeenCalled();

    vi.clearAllMocks();
    db.productionBatch.findUnique.mockResolvedValue(null);
    expect((await post({ ...sound, otherCosts: -500 })).status).toBe(400);
  });

  it('and a non-numeric line amount no longer costs zero', async () => {
    expect(Math.max(0, Number('abc') || 0)).toBe(0); // what it was
    expect((await post({ ...sound, costLines: [{ label: 'قالب', amount: 'abc' }] })).status).toBe(400);
    expect(db.productionBatch.create).not.toHaveBeenCalled();
  });

  it('and a line amount of zero is still stored — a named item can cost nothing', async () => {
    const res = await post({ ...sound, costLines: [{ label: 'قالب', amount: 0 }] });
    expect(res.status).toBe(200);
    expect(written().costLines.create).toEqual([
      { companyId: 'c1', label: 'قالب', amount: 0, sortOrder: 0 },
    ]);
  });

  it('and the lines add into the total the way the buckets do', async () => {
    const res = await post({
      ...sound,
      manufacturingCost: 2000,
      costLines: [{ label: 'قالب', amount: 700 }, { label: 'أجرة عامل', amount: 300 }],
    });
    expect(res.status).toBe(200);
    expect(written().totalProductionCost).toBe(3000);
    expect(written().costPerUnit).toBe(3);
  });

  it('and a blank label, a 31st line and an over-long label are refused rather than silently dropped', async () => {
    // Each of these USED to lose an amount somebody typed, without a word:
    // a blank label was filtered out, a 31st line was sliced off, and a long
    // label was cut to 80 characters.
    for (const costLines of [
      [{ label: '  ', amount: 900 }],
      Array.from({ length: 31 }, (_, i) => ({ label: `بند ${i}`, amount: 10 })),
      [{ label: 'ب'.repeat(81), amount: 10 }],
    ]) {
      vi.clearAllMocks();
      db.productionBatch.findUnique.mockResolvedValue(null);
      expect((await post({ ...sound, costLines })).status).toBe(400);
      expect(db.productionBatch.create).not.toHaveBeenCalled();
    }
    // Thirty is fine.
    vi.clearAllMocks();
    db.productionBatch.findUnique.mockResolvedValue(null);
    db.product.findFirst.mockResolvedValue({ id: PRODUCT, name: 'كريم', sourceType: 'MANUFACTURED' });
    db.productionBatch.create.mockImplementation(async (args: any) => ({ id: 'b1', ...args.data }));
    const thirty = Array.from({ length: 30 }, (_, i) => ({ label: `بند ${i}`, amount: 10 }));
    expect((await post({ ...sound, costLines: thirty })).status).toBe(200);
    expect(written().costLines.create).toHaveLength(30);
  });
});

describe('and a production date that is not a date no longer reaches Prisma', () => {
  it('is refused with a sentence instead of becoming an Invalid Date', async () => {
    expect(new Date('abc').getTime()).toBeNaN();
    const res = await post({ ...sound, productionDate: 'abc' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('تاريخ الإنتاج غير صالح');
    expect(db.productionBatch.create).not.toHaveBeenCalled();
  });

  it('and a real date is kept', async () => {
    const res = await post({ ...sound, productionDate: '2026-03-15' });
    expect(res.status).toBe(200);
    expect(written().productionDate).toEqual(new Date('2026-03-15'));
  });
});

describe('and the route carries no rule of its own', () => {
  const src = readFileSync(join(process.cwd(), 'src/app/api/production/route.ts'), 'utf8')
    // Comments blanked: this file's own docblock names every deleted shape,
    // and four guards in this repository have been satisfied by their own
    // prose.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('imports the shared strict reader', () => {
    expect(src).toMatch(/from '@\/lib\/numeric-input'/);
  });

  it('and not one of the deleted shapes is left', () => {
    expect(src).not.toMatch(/parseInt\(quantityProduced/);
    expect(src).not.toMatch(/parseFloat\(/);
    expect(src).not.toMatch(/quantityProduced <= 0/);
    expect(src).not.toMatch(/Math\.max\(0, Number\(/);
    // And no fallback re-added at the write site, which is how the first
    // divergence in `a-column-has-one-rule` happened.
    expect(src).not.toMatch(
      /(?:manufacturingCost|packagingCost|rawMaterialCost|otherCosts|quantityProduced)[^\n]*\|\|\s*0/
    );
  });
});
