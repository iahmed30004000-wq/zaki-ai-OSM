import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCK THAT EXISTS AND CANNOT BE SEEN IS WORSE THAN STOCK THAT WAS NEVER
 * WRITTEN.
 *
 * `POST /api/production` created a `ProductionBatch` with no `storeId`, and
 * the `InventoryMovement` beside it with no `storeId` either. The `GET` on
 * the same route filters `inStore(companyId, storeId)`, and that is an
 * EXACT `storeId: storeId` match (`src/lib/store-filter.ts`) which a NULL
 * can never satisfy — and so does the `PATCH` in `[id]/route.ts`. The batch
 * was stored, held `quantityRemaining` units and fed `costPerUnit` into cost
 * of goods, and was invisible on the one screen that owns it and
 * uncorrectable from it. Nobody knew to look for it.
 *
 * THE STORE IS NOT GUESSED. `requireContext()` throws `STORE_REQUIRED` when
 * no store is selected, so `storeId` is a `string` by the time this door
 * runs; and the product was tenant-validated one query earlier with the
 * SAME `inStore(companyId, storeId)`, so the product's own store IS this
 * store. The two paths that already got it right agree: `receiveStock`
 * takes the store from the receiving context, and the return restock puts
 * units «back onto the shelf it left».
 *
 * THREE THINGS ARE HELD HERE, and they are different in kind:
 *
 *   1. THE DOOR, by behaviour — the real `POST` runs against a mocked
 *      database and the two rows it writes are read back. Values, not the
 *      presence of the word `storeId` in a file.
 *
 *   2. THE SCREEN, by behaviour — the real `GET` runs against a `findMany`
 *      that actually APPLIES the `where` it is handed to a fixture set, so
 *      «the unplaced row does not come back» is demonstrated rather than
 *      asserted about a filter nobody ran.
 *
 *   3. EVERY WRITER, by enumeration — the sweep at the bottom reads the
 *      store-scoped models OFF `schema.prisma` and finds their `create`
 *      call sites, so a writer added tomorrow to a table nobody is thinking
 *      about today fails until somebody classifies it. That is the real
 *      shape of this defect: «one of N writers forgot the tenant column»,
 *      which no behavioural test of the other N−1 can see.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    productionBatch: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    productionBatchCost: { deleteMany: vi.fn(), createMany: vi.fn() },
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

import { GET, POST } from './route';
import { PATCH } from '@/app/api/production/[id]/route';
import { inStore } from '@/lib/store-filter';
import { stripComments, stripTemplates } from '@/lib/guard-source';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
/** المبارك ستور and صحة بلس — two shelves of one company, as this database has. */
const MUBARAK = 's-mubarak';
const SIHHA = 's-sihha';

const sound = { productId: PRODUCT, batchNumber: 'BATCH-2026-001', quantityProduced: 1000, manufacturingCost: 250 };

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/production', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The batch row as it actually reached the database. */
const writtenBatch = () => db.productionBatch.create.mock.calls[0][0].data as Record<string, unknown>;
/** The stock movement written beside it. */
const writtenMovement = () => db.inventoryMovement.create.mock.calls[0][0].data as Record<string, unknown>;

const context = (storeId: string | null) => ({
  user: { id: 'u1' },
  companyId: 'c1',
  storeId,
  countryId: 'co1',
  country: { currencyCode: 'SYP', minorUnit: 2 },
});

/**
 * THE SHELF, AS ROWS, SHARED BY EVERY TEST BELOW.
 *
 * `onHandTotal` is NOT mocked anywhere in this file — the real function from
 * `receiving.ts` runs against this. So `aggregate` has to behave like
 * Prisma's: apply the `where` it is handed and sum the column it is ASKED
 * for. A fake that ignores either is how a guard goes vacuous — one in
 * `7c98b01` survived a mutation because the fake transaction sorted
 * ascending whichever direction it was given.
 */
interface ShelfRow { id: string; companyId: string; storeId: string | null; productId: string; quantityRemaining: number }
const shelf: ShelfRow[] = [];

function aggregateShelf(args: any): { _sum: { quantityRemaining: number | null } } {
  // The column actually asked for, so an aggregate over the wrong one
  // cannot come back looking right.
  if (!args?._sum?.quantityRemaining) {
    throw new Error(`aggregate asked for ${JSON.stringify(args?._sum)} — this fake only sums quantityRemaining`);
  }
  const rows = shelf.filter((r) => matchesWhere(r as unknown as Record<string, unknown>, args.where ?? {}));
  if (rows.length === 0) return { _sum: { quantityRemaining: null } };
  return { _sum: { quantityRemaining: rows.reduce((n, r) => n + r.quantityRemaining, 0) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  shelf.length = 0;
  requireContext.mockResolvedValue(context(MUBARAK));
  requirePermission.mockResolvedValue(undefined);
  db.productionBatch.aggregate.mockImplementation(async (args: any) => aggregateShelf(args));
  db.productionBatch.findUnique.mockResolvedValue(null);
  db.product.findFirst.mockResolvedValue({
    id: PRODUCT,
    name: 'كريم',
    sku: 'MB-01',
    sourceType: 'MANUFACTURED',
    companyId: 'c1',
    storeId: MUBARAK,
  });
  db.productionBatch.create.mockImplementation(async (args: any) => {
    const row = { id: `b-new-${shelf.length + 1}`, ...args.data };
    // The run the door just wrote is ON the shelf from this moment, which is
    // what makes «the balance after» answerable at all.
    shelf.push(row as ShelfRow);
    return row;
  });
  db.inventoryMovement.create.mockResolvedValue({ id: 'm-new' });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 1 · THE ROW THE DOOR HANDS PRISMA
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('a production run is filed on the shelf the person is standing at', () => {
  it('writes the context store onto the batch — the value, not the word', async () => {
    const res = await post(sound);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    const row = writtenBatch();
    // The VALUE first, so a revert prints what actually reached the column:
    // `undefined` is what this door wrote for as long as it existed.
    expect(row.storeId).toBe(MUBARAK);
    expect(row.companyId).toBe('c1');
    // And it is a real id, not an empty string or a null that would be
    // stored as NULL and read back as nothing.
    expect(typeof row.storeId).toBe('string');
    expect(row.storeId).not.toBe('');
  });

  it('writes the SAME store onto the inventory movement — half-fixed is not fixed', async () => {
    await post(sound);

    const movement = writtenMovement();
    expect(movement.storeId).toBe(MUBARAK);
    expect(movement.companyId).toBe('c1');
    // The pair must agree: the batch says where the units are, the ledger
    // says how the balance got that way, and /api/inventory/movements
    // filters the movement itself with the same strict `inStore`.
    expect(movement.storeId).toBe(writtenBatch().storeId);
  });

  it('follows the store the request is actually in, rather than a constant', async () => {
    requireContext.mockResolvedValue(context(SIHHA));
    db.product.findFirst.mockResolvedValue({
      id: PRODUCT, name: 'كريم', sku: 'SB-01', sourceType: 'MANUFACTURED', companyId: 'c1', storeId: SIHHA,
    });

    await post({ ...sound, batchNumber: 'BATCH-2026-002' });
    expect(writtenBatch().storeId).toBe(SIHHA);
    expect(writtenMovement().storeId).toBe(SIHHA);
  });

  /**
   * AND THE STORE THE BATCH GETS IS PROVABLY THE PRODUCT'S OWN STORE.
   *
   * Not a second source of truth: the product was fetched one query earlier
   * with `inStore(companyId, storeId)`, which is an exact match on
   * `Product.storeId`. So any product this door accepts has exactly this
   * store, and «context store» and «the product's store» cannot disagree.
   */
  it('and that store is the one the product was just validated against', async () => {
    await post(sound);
    const where = db.product.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: PRODUCT, companyId: 'c1', storeId: MUBARAK });
    expect(writtenBatch().storeId).toBe(where.storeId);
    // The product row the door accepted carries that same store, so the two
    // possible sources for this column are one source.
    expect((await db.product.findFirst.mock.results[0].value).storeId).toBe(writtenBatch().storeId);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 2 · AND THE SCREEN THAT OWNS IT CAN SEE IT
 *
 * `findMany` here APPLIES the `where` the route hands it. Without that the
 * assertion «the unplaced row is not returned» would be a sentence about a
 * filter nobody ran — which is exactly the kind of guard this audit keeps
 * finding.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** The handful of `inStore` shapes, applied for real. */
function matchesWhere(row: Record<string, unknown>, where: Record<string, any>): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (want && typeof want === 'object' && Array.isArray(want.in)) {
      if (!want.in.includes(row[key])) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

const SHELF = [
  { id: 'b-mubarak', batchNumber: 'BATCH-001', companyId: 'c1', storeId: MUBARAK, productionDate: new Date() },
  { id: 'b-sihha', batchNumber: 'BATCH-002', companyId: 'c1', storeId: SIHHA, productionDate: new Date() },
  /** What this door used to write: real units, no shelf. */
  { id: 'b-unplaced', batchNumber: 'BATCH-OLD', companyId: 'c1', storeId: null, productionDate: new Date() },
];

const listed = async () => {
  const res = await GET(new Request('http://localhost/api/production'));
  expect(res.status).toBe(200);
  return ((await res.json()).batches as { id: string }[]).map((b) => b.id);
};

describe('the production screen returns this store’s batches and only those', () => {
  beforeEach(() => {
    db.productionBatch.findMany.mockImplementation(async (args: any) => {
      const rows = SHELF.filter((r) => matchesWhere(r, args.where));
      // product/costLines are includes; the ids are all this test reads.
      return rows.map((r) => ({ ...r, product: null, costLines: [] }));
    });
  });

  it('asks for exactly `inStore(companyId, storeId)` — the shared helper, not a hand-written clause', async () => {
    await listed();
    expect(db.productionBatch.findMany.mock.calls[0][0].where).toEqual(inStore('c1', MUBARAK));
  });

  it('shows a batch written by this door, and never the store-less one', async () => {
    expect(await listed()).toEqual(['b-mubarak']);
    expect(await listed()).not.toContain('b-unplaced');
    expect(await listed()).not.toContain('b-sihha');
  });

  /**
   * THE ROUND TRIP, which is the whole defect in two lines: take the row the
   * POST actually handed Prisma and ask the GET's own filter whether it
   * would come back. Before the fix the answer was no.
   */
  it('and the row the POST writes is a row the GET returns — before, it was not', async () => {
    await post(sound);
    const row = writtenBatch();

    const filter = inStore('c1', MUBARAK);
    expect(matchesWhere(row as Record<string, unknown>, filter)).toBe(true);

    // The row as this door used to write it: everything the same, no shelf.
    const asItWas = { ...row, storeId: undefined };
    expect(matchesWhere(asItWas, filter)).toBe(false);
    expect(matchesWhere({ ...row, storeId: null }, filter)).toBe(false);
  });

  it('and a session with no store selected is shown nothing, not everything', async () => {
    // `requireContext` refuses this case outright, so it cannot arise
    // through the door; the filter it would produce is pinned anyway,
    // because «no store» answered with the whole company is the leak in
    // its most convenient disguise.
    expect(inStore('c1', null)).toEqual({ companyId: 'c1', id: { in: [] } });
    for (const row of SHELF) expect(matchesWhere(row, inStore('c1', null))).toBe(false);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 3 · AND THE CORRECTION DOOR, which filters the same way
 *
 * `PATCH /api/production/[id]` looks the batch up with
 * `{ id, ...inStore(companyId, storeId) }`. So an unplaced batch was not
 * merely invisible: its costs could never be corrected either. This is why
 * the fix had to be at the write site rather than by widening the read.
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('a batch with no shelf cannot even be corrected', () => {
  const patch = (id: string) =>
    PATCH(
      new Request(`http://localhost/api/production/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manufacturingCost: 999 }),
      }),
      { params: Promise.resolve({ id }) } as any
    );

  beforeEach(() => {
    db.productionBatch.findFirst.mockImplementation(async (args: any) => {
      const row = SHELF.find((r) => matchesWhere(r, args.where));
      return row ? { ...row, quantityProduced: 10, manufacturingCost: 0, packagingCost: 0, rawMaterialCost: 0, otherCosts: 0, costLines: [] } : null;
    });
    db.productionBatch.update.mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data, costLines: [] }));
  });

  it('answers 404 for the store-less row and 200 for the placed one', async () => {
    expect((await patch('b-unplaced')).status).toBe(404);
    expect(db.productionBatch.update).not.toHaveBeenCalled();

    expect((await patch('b-mubarak')).status).toBe(200);
    expect(db.productionBatch.update).toHaveBeenCalledTimes(1);
  });

  it('and 404 for another store’s row, which is the same rule doing its job', async () => {
    expect((await patch('b-sihha')).status).toBe(404);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 4 · EVERY WRITER OF A STORE-SCOPED TABLE — FOUND, NOT LISTED
 *
 * The defect's shape is not a wrong number. It is ONE CALL SITE out of many
 * that forgot a tenant column, and a column that is forgotten does not
 * throw — the row is written and then does not come back, which reads as
 * working software.
 *
 * So the models are read OFF `prisma/schema.prisma` (every model declaring
 * a `storeId`, and whether it also declares a `companyId`) and their
 * `create` / `createMany` call sites are found in the shipped tree. A site
 * that writes neither the column nor a spread must be WRITTEN DOWN BELOW
 * with the reason. Comments and template literals are blanked first, so a
 * file that merely MENTIONS `storeId` in prose does not pass.
 * ───────────────────────────────────────────────────────────────────────────
 */

const REPO = process.cwd();

interface TenantModel {
  /** `ProductionBatch` */
  model: string;
  /** `productionBatch` — how the Prisma client names it. */
  accessor: string;
  hasCompanyId: boolean;
}

/** Every model in the schema that carries a `storeId`, with its sibling column. */
function storeScopedModels(): TenantModel[] {
  const schema = readFileSync(join(REPO, 'prisma/schema.prisma'), 'utf8');
  const out: TenantModel[] = [];
  let name: string | null = null;
  let fields: string[] = [];
  for (const line of schema.split(/\r?\n/)) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      name = open[1];
      fields = [];
      continue;
    }
    if (name && /^\}/.test(line)) {
      if (fields.some((f) => f === 'storeId')) {
        out.push({
          model: name,
          accessor: name[0].toLowerCase() + name.slice(1),
          hasCompanyId: fields.includes('companyId'),
        });
      }
      name = null;
      continue;
    }
    if (name) {
      const field = /^\s{2}(\w+)\s+\w/.exec(line);
      if (field) fields.push(field[1]);
    }
  }
  return out;
}

/** Every shipped `.ts`/`.tsx` that can write a row — src, the scripts, the seed. */
function shippedFiles(): { rel: string; clean: string }[] {
  const out: { rel: string; clean: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !p.includes('.test.')) {
        out.push({
          rel: relative(REPO, p).split(sep).join('/'),
          clean: stripTemplates(stripComments(readFileSync(p, 'utf8'))),
        });
      }
    }
  };
  for (const root of ['src', 'scripts', 'prisma']) walk(join(REPO, root));
  return out;
}

/**
 * The balanced argument text of the call whose `(` sits at `open`.
 *
 * A fixed window of lines gets this wrong both ways — it runs past a short
 * call into the next one, and stops inside a long one — and getting it
 * wrong in the second direction is how a guard like this goes quietly
 * blind. Templates are already blanked, so no brace inside a string counts.
 */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

type Verdict = 'WRITES_IT' | 'SPREAD' | 'MISSING';

interface Site {
  /** `src/lib/stock-consumption.ts#inventoryMovement` — stable across edits. */
  key: string;
  rel: string;
  accessor: string;
  line: number;
  store: Verdict;
  company: Verdict;
  hasCompanyId: boolean;
}

function creationSites(): Site[] {
  const models = storeScopedModels();
  const sites: Site[] = [];
  for (const { rel, clean } of shippedFiles()) {
    for (const m of models) {
      // A DOT before the model name, so `db.product.create(` counts and
      // `db.landingPageProduct.create(` is not mistaken for it.
      const re = new RegExp('\\.' + m.accessor + '\\.create(?:Many)?\\(', 'g');
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(clean)) !== null) {
        const args = callArgs(clean, hit.index + hit[0].length - 1);
        const read = (col: string): Verdict =>
          new RegExp('\\b' + col + '\\b').test(args) ? 'WRITES_IT' : /\.\.\./.test(args) ? 'SPREAD' : 'MISSING';
        sites.push({
          key: `${rel}#${m.accessor}`,
          rel,
          accessor: m.accessor,
          line: clean.slice(0, hit.index).split('\n').length,
          store: read('storeId'),
          company: read('companyId'),
          hasCompanyId: m.hasCompanyId,
        });
      }
    }
  }
  return sites;
}

/**
 * WRITERS THAT LEAVE `storeId` OUT, AND WHY — one entry per file#model.
 *
 * Two kinds live here and the difference matters. A «shared by design» row
 * is read back by a filter that accepts NULL (`inStoreOrShared`, or an
 * explicit `OR`), and leaving the column out is the decision. A «defect»
 * row is read back by a strict `inStore`, so the row is written and then
 * cannot be seen: those are named as defects, with the file that owns them,
 * because an entry that reads like a decision is how the next omission gets
 * waved through.
 */
const STORE_LEFT_OUT: Record<string, string> = {
  // ── shared by design ───────────────────────────────────────────────────
  'prisma/seed.ts#notification': 'بالتصميم: الإشعار يُقرأ بـ OR: [{ storeId }, { storeId: null }] في /api/notifications، فصفٌّ بلا متجر يراه صاحبه في كل متجر',
  'prisma/seed.ts#deliveryProvider': 'بالتصميم: /api/delivery-providers يقرأ OR: [courierScope, { companyId, storeId: null }] — مندوبٌ بلا متجر مشتركٌ بين متاجر الشركة',

  // ── defects in the seed ────────────────────────────────────────────────
  //
  // The three movement writers that stood here — stock-consumption.ts (SALE
  // and RETURN), inventory/route.ts (the stocktake summary) and
  // orders/[id]/route.ts (the legacy delivery SALE) — now write the column,
  // and their lines are gone because an entry whose site is fixed FAILS the
  // register check below. The four of them, with the production door, were
  // the whole set of movement writers that dropped it.
  'prisma/seed.ts#product':
    'خلل في البذرة — المنتج يُقرأ بـ inStore الصارم في /api/inventory و/api/products، فمنتجٌ مبذورٌ بلا متجر لا يظهر في أي متجر. ' +
    'يُرقَّع اليوم بـ scripts/place-stock-in-stores.ts بعد البذر، والرقعة ليست الكتابة',
  'prisma/seed.ts#customer':
    'خلل في البذرة — /api/customers يرشّح storeId بالضبط عند اختيار متجر، فزبونٌ مبذورٌ بلا متجر لا يظهر في القائمة',
  'prisma/seed.ts#productionBatch':
    'خلل في البذرة — نفس خلل هذا الباب قبل إصلاحه: دفعةٌ بلا رفّ لا تظهر في شاشة الإنتاج',
  'prisma/seed.ts#inventoryMovement':
    'خلل في البذرة — حركة الإنتاج المبذورة بلا متجر، فلا تظهر في سجل المخزون',
};

/**
 * SITES WHOSE `data` IS A SPREAD, with proof the spread carries the column.
 *
 * A spread cannot be read at the call site, and calling that «fine» is how
 * a guard stops seeing. Each one names the shape that must still be in the
 * file, so moving the store out of the spread object fails here.
 */
const STORE_IN_A_SPREAD: Record<string, RegExp> = {
  'scripts/structure-matrix.ts#landingPage': /const data = \{\s*\n\s*companyId: store\.companyId,\s*\n\s*storeId: store\.id,/,
};

describe('every writer of a store-scoped table writes the store', () => {
  const sites = creationSites();
  const models = storeScopedModels();

  it('finds the models and the call sites at all — a guard over an empty list proves nothing', () => {
    // 25 models carry a storeId today, 51 call sites write them. A rename or
    // a refactor that blinds the matcher must fail loudly, not pass over
    // nothing.
    expect(models.length).toBeGreaterThanOrEqual(25);
    expect(sites.length).toBeGreaterThanOrEqual(50);

    const names = models.map((m) => m.accessor);
    for (const known of ['productionBatch', 'inventoryMovement', 'product', 'order', 'customer', 'wallet', 'landingPage']) {
      expect(names, `${known} no longer looks store-scoped in the schema`).toContain(known);
    }

    // The two writers this test is about, by key, so a move cannot hide them.
    const keys = sites.map((s) => s.key);
    expect(keys).toContain('src/app/api/production/route.ts#productionBatch');
    expect(keys).toContain('src/app/api/production/route.ts#inventoryMovement');
    // And the schema knows UserStoreAccess has a store but no company, which
    // is what stops the companyId rule below from inventing a column.
    expect(models.find((m) => m.accessor === 'userStoreAccess')?.hasCompanyId).toBe(false);
  });

  it('and not one of them writes a store-scoped row with no store it has not explained', () => {
    const offenders = [...new Set(sites.filter((s) => s.store === 'MISSING').map((s) => s.key))];
    const unexplained = offenders.filter((k) => !(k in STORE_LEFT_OUT));
    expect(
      unexplained,
      'كاتبٌ يُنشئ صفّاً في جدولٍ مملوكٍ لمتجر بلا storeId — الصفّ يُكتَب ثم لا يعود من القراءة. ' +
        'إمّا أن يكتب العمود، أو أن يُكتَب هنا مع السبب'
    ).toEqual([]);

    // And the register does not rot into an excuse for the next omission:
    // an entry whose site now writes the column must be deleted.
    for (const key of Object.keys(STORE_LEFT_OUT)) {
      expect(offenders, `${key} يكتب storeId الآن — احذف سطره من السجل`).toContain(key);
    }
  });

  it('and a site that spreads its data proves the store is in the spread', () => {
    const spreads = [...new Set(sites.filter((s) => s.store === 'SPREAD').map((s) => s.key))];
    expect(
      spreads.filter((k) => !(k in STORE_IN_A_SPREAD)),
      'موضعٌ يمرّر data بالنشر فلا يُقرأ عند النداء — سجّله مع الشكل الذي يُثبت المتجر'
    ).toEqual([]);

    for (const [key, shape] of Object.entries(STORE_IN_A_SPREAD)) {
      expect(spreads, `${key} لم يعد ينشر data — احذف سطره`).toContain(key);
      const rel = key.split('#')[0];
      const src = stripTemplates(stripComments(readFileSync(join(REPO, rel), 'utf8')));
      expect(src, `${rel}: الكائن المنشور لم يعد يحمل المتجر`).toMatch(shape);
    }
  });

  /**
   * AND THE COMPANY COLUMN, which is the more serious of the two.
   *
   * A missing `storeId` hides a row. A missing `companyId` on a model that
   * has one is a TENANCY LEAK: the row belongs to no company and every
   * company's `{ companyId }` filter either misses it or — worse, if any
   * read ever widens — hands it over. There is no register for this one on
   * purpose: nothing in the tree needs an exemption today, and an empty
   * list is the finding.
   */
  it('and every one of them writes the company column when the model has one', () => {
    const leaks = sites
      .filter((s) => s.hasCompanyId && s.company === 'MISSING')
      .map((s) => `${s.rel}:${s.line} (${s.accessor})`);
    expect(leaks, 'صفٌّ في جدولٍ مملوكٍ لشركة يُكتَب بلا companyId — هذا تسريبُ ملكية، لا صفٌّ مخفيّ').toEqual([]);
  });

  /**
   * THE DETECTOR STILL RECOGNISES WHAT IT WAS WRITTEN FOR.
   *
   * Ten vacuous guards have been caught in this audit. These are the ways
   * this one could go blind, each run rather than assumed.
   */
  it('recognises a store-less write, and is not fooled by the name alone', () => {
    const bad = 'await db.productionBatch.create({ data: { companyId, productId } });';
    const good = 'await db.productionBatch.create({ data: { companyId, storeId, productId } });';
    const args = (s: string) => callArgs(s, s.indexOf('(', s.indexOf('.create')));

    expect(/\bstoreId\b/.test(args(bad))).toBe(false);
    expect(/\bstoreId\b/.test(args(good))).toBe(true);

    // The balance stops at the call's own closing paren, so a NEXT call that
    // does write the column cannot cover for this one.
    const pair = `${bad}\n${good}`;
    expect(/\bstoreId\b/.test(args(pair))).toBe(false);

    // A SENTENCE ABOUT THE STORE IS NOT THE STORE — the exact failure shape
    // this audit keeps finding, in both the forms this repository writes.
    expect(/\bstoreId\b/.test(args(stripComments(`/* storeId */\n${bad}`)))).toBe(false);
    expect(
      /\bstoreId\b/.test(args(stripComments('await db.productionBatch.create({ data: {\n  // storeId,\n  companyId } });')))
    ).toBe(false);

    // A sibling model is not mistaken for the model.
    const sibling = 'await db.landingPageProduct.create({ data: { x: 1 } });';
    expect(new RegExp('\\.product\\.create\\(').test(sibling)).toBe(false);
    expect(new RegExp('\\.landingPageProduct\\.create\\(').test(sibling)).toBe(true);

    // And `storeIds` (the plural, a parameter) is not the column.
    expect(/\bstoreId\b/.test('data: { storeIds }')).toBe(false);
  });

  /** This door's own two writes, by key and by shape, so a revert cannot pass quietly. */
  it('and the production door’s batch and movement both carry it', () => {
    const mine = sites.filter((s) => s.rel === 'src/app/api/production/route.ts');
    expect(mine.map((s) => s.accessor).sort()).toEqual(['inventoryMovement', 'productionBatch']);
    for (const s of mine) expect(s.store, `${s.rel}:${s.line}`).toBe('WRITES_IT');
    for (const s of mine) expect(s.company, `${s.rel}:${s.line}`).toBe('WRITES_IT');
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 5 · AND THE LEDGER LINE SAYS THE SHELF'S BALANCE, NOT THE RUN'S SIZE
 *
 * `balanceAfter: qty` — the new batch's own quantity. For the FIRST run of a
 * product the two agree, and that is the whole reason this survived: every
 * hand-built fixture starts a product at nothing, so the wrong expression
 * and the right one printed the same number.
 *
 * The second run is where it parts. A product holding 50 that takes a run of
 * 20 wrote `balanceAfter: 20` beside `quantity: 20`, so the ledger read 20
 * where the shelf held 70 — and the next line under it, a sale of one
 * written by `consumeOrderStock` from `onHandTotal`, read 69. The series
 * steps 20 → 69, and the column exists for exactly one purpose: that
 * somebody can read the shelf's history and have it add up.
 *
 * WHAT IS ASSERTED IS THE ROW HANDED TO PRISMA, and the arithmetic over the
 * rows — never the text of the route. `onHandTotal` and the rest of
 * `receiving.ts` are the real functions; only `@/lib/db` is a fake, and that
 * fake applies the `where` it is given and refuses to sum a column it was
 * not asked for.
 * ───────────────────────────────────────────────────────────────────────────
 */
describe('the stock ledger records the balance the shelf is actually at', () => {
  /** A run already on this shelf, written by someone else, some other day. */
  const standing = (units: number): ShelfRow => ({
    id: 'b-standing',
    companyId: 'c1',
    storeId: MUBARAK,
    productId: PRODUCT,
    quantityRemaining: units,
  });

  it('counts the stock already there — fifty on hand, a run of twenty, a balance of seventy', async () => {
    shelf.push(standing(50));

    const res = await post({ ...sound, quantityProduced: 20 });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    const movement = writtenMovement();
    expect(movement.quantity).toBe(20);
    expect(
      movement.balanceAfter,
      'الرصيدُ بعدَ تشغيلةٍ ثانيةٍ هو الرفُّ كلُّه (٥٠ + ٢٠ = ٧٠)، لا كميّةُ التشغيلةِ وحدَها'
    ).toBe(70);

    // The two columns are DIFFERENT facts, and the defect was writing one
    // into the other. Naming that directly, with the numbers, so a revert
    // prints `20 !== 20` rather than a sentence about a function name.
    expect(movement.balanceAfter).not.toBe(movement.quantity);
  });

  it('and the balance includes the run just written, not the shelf before it', async () => {
    shelf.push(standing(50));
    await post({ ...sound, quantityProduced: 20 });
    // 70, not 50: the movement explains a shelf that already holds the run.
    expect(writtenMovement().balanceAfter).toBe(70);
  });

  /**
   * THE SERIES, WHICH IS THE COLUMN'S ONLY JOB.
   *
   * Every row's balance must be the row before it plus its own quantity.
   * This is the same arithmetic run against the live database for this
   * audit — 30 movements of one product, zero drift — and it is the check
   * the old expression fails on the second row and every row after it.
   */
  it('so two runs in a row read as a series that adds up', async () => {
    await post({ ...sound, batchNumber: 'BATCH-2026-010', quantityProduced: 50 });
    await post({ ...sound, batchNumber: 'BATCH-2026-011', quantityProduced: 20 });

    const rows = db.inventoryMovement.create.mock.calls.map(
      (c: any) => c[0].data as { quantity: number; balanceAfter: number }
    );
    expect(rows).toHaveLength(2);

    let running = 0;
    for (const [i, row] of rows.entries()) {
      running += row.quantity;
      expect(row.balanceAfter, `الحركةُ ${i + 1}: الرصيدُ المكتوبُ لا يساوي ما قبلَه + كميّتَه`).toBe(running);
    }
    expect(rows.map((r) => r.balanceAfter)).toEqual([50, 70]);
  });

  /**
   * AND WHY NOBODY SAW IT. The first run of a product is the one case where
   * the broken expression and the correct one agree, and it is the only case
   * any fixture in this repository had.
   */
  it('while a product’s very first run reads the same either way — 1000 and 1000', async () => {
    const res = await post(sound);
    expect(res.status).toBe(200);
    const movement = writtenMovement();
    expect(movement.quantity).toBe(1000);
    expect(movement.balanceAfter).toBe(1000);
  });

  /**
   * THE BALANCE IS THIS PRODUCT'S, NOT THE WHOLE SHELF'S.
   *
   * `onHandTotal` filters on `{ companyId, productId }` and the fake applies
   * that filter, so a run of one product cannot be credited with another
   * product's units — and a mutation that drops the filter prints 70 vs 500.
   */
  it('and never another product’s units, nor another company’s', async () => {
    shelf.push(standing(50));
    shelf.push({ id: 'b-other-product', companyId: 'c1', storeId: MUBARAK, productId: 'p-other', quantityRemaining: 430 });
    shelf.push({ id: 'b-other-company', companyId: 'c2', storeId: MUBARAK, productId: PRODUCT, quantityRemaining: 900 });

    await post({ ...sound, quantityProduced: 20 });
    expect(writtenMovement().balanceAfter).toBe(70);
  });

  /**
   * IT ASKED THE SHARED FUNCTION, which is the point of the fix rather than
   * a detail of it: five writers computed this figure one way and this door
   * computed it another, and a sixth way is a sixth answer.
   */
  it('by asking the shelf, not by arithmetic of its own', async () => {
    shelf.push(standing(50));
    await post({ ...sound, quantityProduced: 20 });

    expect(db.productionBatch.aggregate).toHaveBeenCalled();
    const call = db.productionBatch.aggregate.mock.calls.at(-1)![0];
    expect(call.where).toEqual({ companyId: 'c1', productId: PRODUCT });
    expect(call._sum).toEqual({ quantityRemaining: true });
  });

  /**
   * AND THE FAKE IS NOT ASLEEP. Each way this test could pass while proving
   * nothing, run rather than assumed.
   */
  it('the shelf fake applies the where it is handed and refuses the wrong column', () => {
    shelf.length = 0;
    shelf.push(standing(50));
    shelf.push({ id: 'x', companyId: 'c1', storeId: MUBARAK, productId: 'p-other', quantityRemaining: 7 });

    expect(aggregateShelf({ where: { companyId: 'c1', productId: PRODUCT }, _sum: { quantityRemaining: true } }))
      .toEqual({ _sum: { quantityRemaining: 50 } });
    // No filter at all is a DIFFERENT answer, so a mutation that drops the
    // filter cannot come back looking the same.
    expect(aggregateShelf({ where: {}, _sum: { quantityRemaining: true } }))
      .toEqual({ _sum: { quantityRemaining: 57 } });
    // Nothing matched is null, the way Prisma answers it — `?? 0` in
    // `onHandTotal` is what turns that into a number.
    expect(aggregateShelf({ where: { companyId: 'c-none' }, _sum: { quantityRemaining: true } }))
      .toEqual({ _sum: { quantityRemaining: null } });
    expect(() => aggregateShelf({ where: {}, _sum: { quantitySold: true } })).toThrow(/quantityRemaining/);
  });
});
