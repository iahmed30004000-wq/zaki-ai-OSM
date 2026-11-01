import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ORDER'S COST OF GOODS COMES FROM ONE PLACE — AND THAT PLACE KNOWS THE OWNER'S FIXED COST (the owner, 1/11)
 *
 * «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… ثابت لكل الطلبات وما يتغير تحت اي ظرف، اللي بيقدر يغيرو الادمنة فقط من قائمة المنتجات.»
 *
 * The complaint was a cost struck twice, differently: once when the order was raised, from the average of whatever the batches held that
 * day, and again at delivery, from the batches the units happened to come out of. Nine places write an order's cost of goods; each of
 * them now asks `product-fixed-cost.ts` — `unitCostsOf` where it prices a unit, `fixedCostsOf` where it prices the units that left or
 * copies an order — and none of them reads the batch average on its own any more.
 *
 * WHAT THIS HOLDS, AND WHY BY READING CODE. A behaviour test shows the door follows the figure TODAY; it cannot show that the tenth
 * door, written next month, will. So the sweeps below are over-inclusive on purpose and fail on a stranger:
 *
 *   · every file that CALLS the batch average (`productCost(` / `productCosts(`) is named here with its reason — a new order door that
 *     costs from the shelf by itself is a stranger and goes red;
 *   · every file that names `estimatedCostOfGoods` and writes a row is a door, a copy of another order, or a reader — a new writer
 *     of an order's cost is a stranger and goes red;
 *   · each door asks the figure with the CALL, not the import line (this repository has recorded five times a guard satisfied by an
 *     import while the thing it names was gone).
 *
 * The lists shrink with the code: a name that no longer sweeps is a ghost, and a ghost fails too.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');
const code = (file: string) => stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
const ALL = filesUnder(SRC).map((p) => ({ file: rel(p), src: stripComments(readFileSync(p, 'utf8')) }));

/** `import { …unitCostsOf… } from '…/product-fixed-cost'` — the name, from the one file. */
const importsFromTheOneFile = (src: string, name: string) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'[^']*product-fixed-cost'`).test(src);

/*
 * THE NINE PLACES THAT WRITE AN ORDER'S COST OF GOODS, and what each asks of the one file.
 *
 * `unitCostsOf` prices ONE unit of a product (creation: the figure, else the batches' average, else 0). The delivery prices the units
 * that LEFT (`fixedCostsOf` × `taken`), the replacement copies another order's cost (`fixedCostsOf` + `costOfACopy`), and Telegram
 * keeps its own no-figure reading (see below) with the figure on top.
 */
const DOORS: Array<{ file: string; asks: RegExp; names: string[]; what: string; writes?: false }> = [
  { file: 'src/app/api/orders/route.ts', asks: /unitCostsOf\(\s*db\b/, names: ['unitCostsOf'], what: 'the manual door' },
  { file: 'src/app/api/orders/ai-intake/route.ts', asks: /unitCostsOf\(\s*db\b/, names: ['unitCostsOf'], what: 'the pasted order' },
  { file: 'src/lib/public-order.ts', asks: /unitCostsOf\(\s*db\b/, names: ['unitCostsOf'], what: 'the storefront and the sales page' },
  { file: 'src/lib/v1/order-intake.ts', asks: /unitCostsOf\(\s*db\b/, names: ['unitCostsOf'], what: 'the systems door' },
  // The writer of a migrated order is `order-migration.ts`; this route hands it the question (its `unitCost` dependency).
  { file: 'src/app/api/orders/import/migrate/route.ts', asks: /unitCostsOf\(\s*tx\b/, names: ['unitCostsOf'], what: 'the migration of old orders (the dependency it hands the writer)', writes: false },
  { file: 'src/app/api/orders/[id]/route.ts', asks: /unitCostsOf\(\s*db\b[\s\S]*fixedCostsOf\(\s*db\b/, names: ['unitCostsOf', 'fixedCostsOf'], what: 'the lines edit — the units that go on' },
  { file: 'src/lib/stock-consumption.ts', asks: /fixedCostsOf\(\s*tx\b/, names: ['fixedCostsOf'], what: 'the delivery — the units that left' },
  { file: 'src/lib/replacement-order.ts', asks: /fixedCostsOf\(\s*tx\b[\s\S]*costOfACopy\(/, names: ['fixedCostsOf', 'costOfACopy'], what: 'a replacement and a box handed to another customer' },
  { file: 'src/lib/telegram/order-creation.ts', asks: /fixedCostsOf\(\s*db\b/, names: ['fixedCostsOf'], what: 'Telegram — whose no-figure reading is its own (RV574)' },
];

describe('each door that writes an order’s cost asks the owner’s figure — by the call, not by the import', () => {
  it.each(DOORS)('$file ($what)', ({ file, asks, names }) => {
    const src = code(file);
    for (const name of names) expect(importsFromTheOneFile(src, name), `${file} لا يستورد ${name}`).toBe(true);
    expect(src, `${file} لا ينادي الدالّة — الاستيراد وحده لا يكفي`).toMatch(asks);
  });

  it('and not one of them reads the batch average itself any more', () => {
    const readers = [...DOORS.map((d) => d.file), 'src/lib/order-migration.ts', 'src/lib/order-line-apply.ts'].filter((f) => /\bproductCosts?\s*\(|\.average\b/.test(code(f)));
    expect(readers, 'بابٌ يحسب كلفة الطلب من متوسط الدفعات بنفسه — اسأل unitCostsOf').toEqual([]);
  });

  it('and the six doors that price a unit say so with `unitCostsOf`, the one place the figure beats the average', () => {
    const pricing = DOORS.filter((d) => d.names.includes('unitCostsOf')).map((d) => d.file);
    expect(pricing.sort()).toEqual([
      'src/app/api/orders/[id]/route.ts',
      'src/app/api/orders/ai-intake/route.ts',
      'src/app/api/orders/import/migrate/route.ts',
      'src/app/api/orders/route.ts',
      'src/lib/public-order.ts',
      'src/lib/v1/order-intake.ts',
    ].sort());
  });
});

/** Files that CALL the batch average, by name — the question «what did a unit cost on the day I asked». */
const BATCH_AVERAGE_CALL = /\bproductCosts?\s*\(/;

/**
 * EVERY READER OF THE BATCH AVERAGE, and why it is allowed to be one. None of them costs an ORDER: they are the one function that
 * answers «figure, else average», the screens that SHOW the average beside the figure, and a published read contract.
 */
const READERS_OF_THE_BATCH_AVERAGE: Record<string, string> = {
  'src/lib/product-cost.ts': 'where the batch average is DEFINED (`productCost`, `productCosts`) — the module itself, not a caller of it',
  'src/lib/product-fixed-cost.ts': 'THE one function: the average is the answer for a product with no figure (`unitCostsOf`)',
  'src/app/api/products/route.ts': 'the products list shows the average beside the figure (`withFixedCost` decides which is the cost)',
  'src/app/api/products/stats/route.ts': 'the stock figures of the products screen — a shelf, not an order',
  'src/app/api/products/[id]/route.ts': 'the product page shows the average beside the figure',
  'src/app/api/products/[id]/stock/route.ts': 'the stock card shows the average beside the figure (`batchAverageCost`)',
  'src/lib/v1/product-figures.ts': 'a PUBLISHED read contract (`unit_cost_usd`) — unchanged by the owner’s figure; whether it should follow is RV572',
};

describe('no file costs an ORDER from the batch average except through the one function', () => {
  const swept = ALL.filter((f) => BATCH_AVERAGE_CALL.test(f.src)).map((f) => f.file).sort();

  it('sweeps a real set of files, not an empty one', () => {
    expect(swept.length).toBeGreaterThanOrEqual(5);
  });

  it('and every one of them is named, with its reason', () => {
    const strangers = swept.filter((f) => !(f in READERS_OF_THE_BATCH_AVERAGE));
    expect(
      strangers,
      'ملفٌّ يقرأ متوسط الدفعات ولم يُصنَّف — إن كان يكلِّف طلباً فليسأل unitCostsOf، وإن كان يعرضه فاكتب لماذا'
    ).toEqual([]);
  });

  it('and the list names no file that stopped reading it', () => {
    const ghosts = Object.keys(READERS_OF_THE_BATCH_AVERAGE).filter((f) => !swept.includes(f));
    expect(ghosts, 'اسمٌ في القائمة لا يقرأ المتوسط').toEqual([]);
  });

  it('and not one of the nine order doors is among them', () => {
    const doors = new Set(DOORS.map((d) => d.file));
    expect(Object.keys(READERS_OF_THE_BATCH_AVERAGE).filter((f) => doors.has(f))).toEqual([]);
  });

  it('and every reason is a sentence, not a shrug', () => {
    for (const [file, why] of Object.entries(READERS_OF_THE_BATCH_AVERAGE)) {
      expect([...why].length, `${file}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(20);
    }
  });
});

/** Files that name an order's cost of goods in code AND write a row — the same over-inclusive net `every-money-writer-is-known` casts. */
const NAMES_THE_COST = /\bestimatedCostOfGoods\b/;
const WRITES_A_ROW = /\.(create|update|updateMany|upsert|createMany)\(/;

/** The files that name the cost and write a row but do not write an ORDER's cost from the shelf or from the figure. */
const NOT_A_COSTING: Record<string, string> = {
  'src/app/api/confirmation/winback/route.ts':
    'the win-back raises a NEW order from a cancelled one and copies its cost; the figure reaches it at DELIVERY (`consumeOrderStock`) — creation-time figure for a copy: RV575',
  'src/app/api/finance/route.ts': 'reports the cost of the delivered orders; it writes expenses and wallets, not an order’s cost',
  'src/app/api/orders/[id]/finance/route.ts': 'writes the HAND-TYPED finance columns (`productCost`, packaging…); `estimatedCostOfGoods` is only read to show the profit',
};

describe('no file writes an order’s cost of goods without being a door, a copy, or a reader', () => {
  const swept = ALL.filter((f) => NAMES_THE_COST.test(f.src) && WRITES_A_ROW.test(f.src)).map((f) => f.file).sort();
  const known = new Set([...DOORS.filter((d) => d.writes !== false).map((d) => d.file), 'src/lib/order-migration.ts', ...Object.keys(NOT_A_COSTING)]);

  it('sweeps a real set of files, not an empty one', () => {
    expect(swept.length).toBeGreaterThanOrEqual(10);
  });

  it('and not one of them is a stranger', () => {
    expect(
      swept.filter((f) => !known.has(f)),
      'ملفٌّ يكتب كلفة طلبٍ ولم يُصنَّف — يمرّ بـproduct-fixed-cost أو يُقال لماذا لا يحتاجه'
    ).toEqual([]);
  });

  it('and the lists name no file that stopped writing it', () => {
    expect([...known].filter((f) => !swept.includes(f)), 'اسمٌ في القائمة لا يظهر في المسح').toEqual([]);
  });

  it('and every reason is a sentence, not a shrug', () => {
    for (const [file, why] of Object.entries(NOT_A_COSTING)) {
      expect([...why].length, `${file}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(20);
    }
  });
});

describe('the rules the figure follows are written once, in the one file, and each is a rule about ZERO and about the units', () => {
  const one = code('src/lib/product-fixed-cost.ts');

  it('`unitCostsOf` takes the figure with `??` — a zero figure is an answer; `||` would read it as «none»', () => {
    const body = one.slice(one.indexOf('export async function unitCostsOf('), one.indexOf('export function costOfACopy('));
    expect(body).toMatch(/fixed\.get\(id\) \?\? batches\.get\(id\)\?\.average \?\? 0/);
    expect(body, 'يقرأ الصفر على أنه «لا رقم»').not.toContain('||');
  });

  it('…and reads a batch only for the products with no figure', () => {
    const body = one.slice(one.indexOf('export async function unitCostsOf('), one.indexOf('export function costOfACopy('));
    expect(body).toMatch(/const unfixed = ids\.filter\(\(id\) => !fixed\.has\(id\)\)/);
    expect(body).toMatch(/unfixed\.length > 0 \? await productCosts\(tx, companyId, unfixed\)/);
  });

  it('the delivery writes figure × the units that LEFT, and tests the figure by `!== undefined`, never by truthiness', () => {
    const stock = code('src/lib/stock-consumption.ts');
    expect(stock).toMatch(/orderCost \+= figure !== undefined \? figure \* result\.taken : result\.cost;/);
    expect(stock).toMatch(/estimatedCostOfGoods: roundMinor\(orderCost, minorUnit\)/);
    // the rules around it did not move: only when something left and nothing was short
    expect(stock).toMatch(/if \(taken > 0 && short === 0\) \{/);
  });

  it('the delivery never lets the figure reach the ledger: the SALE line, the draw-down and the return carry no figure', () => {
    const stock = code('src/lib/stock-consumption.ts');
    const consume = stock.slice(stock.indexOf('export async function consumeOrderStock('), stock.indexOf('export function absorbDamaged('));
    // `figures` is read in `consumeOrderStock` for the order's own cost, and only there
    expect(stock.match(/\bfigures\b/g)?.length).toBeGreaterThan(1);
    const drawCall = consume.slice(consume.indexOf('await drawDownStock('), consume.indexOf('taken += result.taken'));
    expect(drawCall).not.toMatch(/figure|fixed/i);
    const movement = consume.slice(consume.indexOf('tx.inventoryMovement.create('), consume.indexOf('await tx.orderItem.updateMany('));
    expect(movement.length).toBeGreaterThan(100);
    expect(movement).not.toMatch(/figure|fixed|orderCost/i);
    const restore = stock.slice(stock.indexOf('export async function restoreOrderStock('));
    expect(restore, 'الإرجاع يقرأ التكلفة الثابتة').not.toMatch(/fixedCostsOf|figure/);
  });

  it('Telegram’s figure beats its own reading with `??`, and the reading itself is untouched (RV574)', () => {
    const tg = code('src/lib/telegram/order-creation.ts');
    expect(tg).toMatch(/const unitCost = fixedCost \?\? \(productRow\.batches\[0\]\?\.costPerUnit \|\| 0\);/);
  });

  it('the lines edit asks for the figures only of the products on the lines that MOVED, and passes ZERO through as a figure', () => {
    const route = code('src/app/api/orders/[id]/route.ts');
    expect(route).toMatch(/const costIds = costProductIds\(lineApply\.audit\);/);
    expect(route).toMatch(/\(pid\) => figures\.get\(pid\)\s*\)/);
    const apply = code('src/lib/order-line-apply.ts');
    expect(apply).toMatch(/const fixed = fixedOf\(productId\);\s*if \(fixed !== undefined\) return fixed;/);
  });

  it('the migration hands its writer the same question the other doors ask, by its dependency’s new name', () => {
    expect(code('src/lib/order-migration.ts')).toMatch(/deps\.unitCost\(tx, ctx\.companyId, p\.productId\)/);
    expect(code('src/lib/order-migration.ts'), 'اسم التبعيّة ما زال يقول «متوسط»').not.toMatch(/averageCost/);
  });
});

describe('what the owner’s figure does NOT touch', () => {
  it('the published read contract keeps reading the batches: `unit_cost_usd` is not the figure (RV572)', () => {
    const figures = code('src/lib/v1/product-figures.ts');
    expect(figures).toMatch(/productCosts\(db, companyId, ids\)/);
    expect(figures).not.toMatch(/fixedCostsOf|unitCostsOf|product-fixed-cost/);
  });

  it('the batch ledger — receiving and the cost of a batch — never reads the figure', () => {
    for (const file of ['src/lib/receiving.ts', 'src/lib/product-cost.ts', 'src/lib/unit-cost.ts', 'src/lib/stock-opening-count.ts']) {
      expect(code(file), `${file} يقرأ التكلفة الثابتة`).not.toMatch(/fixedCostsOf|unitCostsOf|product-fixed-cost|ProductFixedCost/);
    }
  });

  it('and the money an order charges is not computed from it: no price function reads the figure', () => {
    for (const file of ['src/lib/money.ts', 'src/lib/delivery-fees.ts', 'src/lib/offers.ts', 'src/lib/offer-gift.ts']) {
      expect(code(file), `${file} يقرأ التكلفة الثابتة`).not.toMatch(/fixedCostsOf|unitCostsOf|product-fixed-cost|ProductFixedCost/);
    }
  });
});
