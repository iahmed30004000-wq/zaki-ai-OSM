import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Prisma } from '@prisma/client';
import { stripComments } from './guard-source';
import { benchExcludedAr, benchOnly, realStoresHere, realStoresOnly } from './test-store';
import { staleStatements } from './intelligence';

/*
 * `intelligence.ts` imports `db` for a TYPE; the mock keeps the import from
 * building a Prisma client. Hoisted above the imports by vitest.
 */
vi.mock('./db', () => ({ db: {} }));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A TEST BENCH IS NOT THE BUSINESS, AND ITS NUMBERS ARE NOT ITS FIGURES.
 *
 * «منتج تيست — بيئةٌ منعزلة … أرقامٌ لا تدخل أيَّ حسبة». Fifty niche
 * products tried, forty-six abandoned, and not one dinar of that in the
 * owner's profit.
 *
 * ── WHAT WAS MEASURED BEFORE A LINE WAS WRITTEN ──
 *
 * 253 queries in this product already filter by `storeId`. Every one of
 * them excludes a bench store FOR FREE — which is why the mark is on the
 * STORE and not on the product: a product flag inherits none of those 253
 * and has to defend all 284, and the one site nobody thought of is the one
 * that puts a test sale in the profit report.
 *
 * 31 are company-wide AND touch a money table, in 22 files. Read one by
 * one, and this is the finding that matters: ALMOST ALL OF THEM ARE SCOPED
 * TO NAMED IDS — one order's add-ons, one statement's lines, one customer's
 * history, one user's penalties, one product's batches. A query keyed on an
 * id that belongs to the bench answers about the bench, which is correct;
 * it is not an aggregate over the business.
 *
 * Exactly ONE was a real leak and is fixed: `staleStatements` in
 * `intelligence.ts` listed every OPEN courier statement in the company, so
 * an unclosed bench statement was raised as a finding about the business —
 * in the one screen built to tell the owner what is wrong.
 *
 * AND THE FIRST FIX WAS ITSELF WRONG, which is what Ⅳ is for. It spread
 * `realStoresOnly()` into `CourierStatement` — a model with a `storeId`
 * column and no `store` relation — so Prisma refused it at runtime and the
 * whole intelligence screen stopped answering. The type-check passed (a
 * spread is never checked for excess properties) and so did every test (they
 * mock Prisma); it surfaced only when the dev server was run, 2026-10-21.
 *
 * ── AND ONE IS NOT FIXABLE HERE, WHICH IS SAID RATHER THAN HIDDEN ──
 *
 * `WalletTransfer` carries NO `storeId` at all. It is company money by
 * schema design. (`Expense` was the second until 29/10: it now carries a
 * `storeId`, every read of it names the store, and the sweep skips a `where`
 * that does — see expense-scope.ts. Whether a bench store's expense is a
 * cost of the business is still the owner's ruling, not made here.)
 * Named below so the list cannot grow in silence.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), 'src');

function files(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(f);
  }
  return out;
}

/**
 * Comments blanked IN PLACE — same length, so every line number still
 * points at the real file. Replacing them with '' shifted every number and
 * made the first version of this sweep report lines with nothing on them.
 */
const blank = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^([ \t]*)\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));

/** The whole `where: { … }`, brace-counted — a regex stops at the first `}`. */
function whereAt(src: string, start: number): string {
  const open = src.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length && i < open + 3000; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/** The `db.<model>.<method>(` this `where:` belongs to. */
function callBefore(src: string, at: number): { model: string; method: string } | null {
  const slice = src.slice(Math.max(0, at - 400), at);
  const m = [...slice.matchAll(/\b(?:db|tx|prisma)\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g)].pop();
  return m ? { model: m[1], method: m[2] } : null;
}

const READS_MANY = new Set(['aggregate', 'groupBy', 'count', 'findMany']);

/** Tables whose rows carry money or quantities that feed a figure. */
const MONEY_MODELS = new Set([
  'order', 'orderItem', 'orderAddOn', 'expense', 'commission', 'fundMovement',
  'productionBatch', 'inventoryMovement', 'courierStatement', 'statementLine',
  'statementReceipt', 'walletTransfer', 'payslip', 'penalty', 'campaign',
]);

/**
 * EVERY COMPANY-WIDE READ OVER A MONEY TABLE, WITH ITS `where`.
 *
 * Over-inclusive on purpose, the same bet `every-money-writer-is-known`
 * makes: the part that fails OPEN is a new money path nobody classified, so
 * the sweep is wide and each hit has to fall on one of the sides below.
 */
interface Site {
  at: string;
  call: string;
  where: string;
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split(/[\\/]/).join('/');
    const src = blank(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/where:/g)) {
      const w = whereAt(src, m.index!);
      if (!w.includes('companyId')) continue;
      if (/storeId|store:/.test(w)) continue;
      const call = callBefore(src, m.index!);
      if (!call || !READS_MANY.has(call.method) || !MONEY_MODELS.has(call.model)) continue;
      out.push({
        at: `${rel}:${src.slice(0, m.index!).split('\n').length}`,
        call: `${call.model}.${call.method}`,
        where: w.replace(/\s+/g, ' '),
      });
    }
  }
  return out;
}

/**
 * NOT AN AGGREGATE OVER THE BUSINESS — each with the reason, and each
 * reason is a FACT A READER CAN CHECK against the `where` printed beside
 * it. «It only reads one row» is exactly what was wrongly assumed about
 * the winback in the money sweep, so the reasons here name the key that
 * does the scoping.
 */
interface Excuse {
  reason: string;
  /**
   * HOW MANY SITES THIS EXCUSE COVERS — and it is here because the guard
   * failed to catch a mutation without it.
   *
   * The excuse was per FILE, so adding a brand-new unclassified
   * company-wide aggregate to a file that already had an excuse passed
   * silently: `lib/analytics.ts` is excused for its expense aggregate, and
   * a fresh `order.count({ where: { companyId } })` dropped in beside it
   * inherited that excuse. Found by mutation, which is the only way a hole
   * of that shape is ever found.
   *
   * So the count is pinned. A new site in an excused file makes the number
   * wrong, and the failure names the file.
   */
  sites: number;
}

const ID_SCOPED: Record<string, Excuse> = {
  'app/api/control/blacklist/route.ts': { reason: 'مقيَّد بأرقام هواتف مُسمّاة — سؤالٌ عن عميلٍ بعينه', sites: 1 },
  'app/api/finance/statements/[id]/route.ts': { reason: 'مقيَّد بـ settledOrderIds — سطورُ كشفٍ بعينه', sites: 2 },
  'app/api/geo/countries/[id]/route.ts': { reason: 'عدٌّ ليُعرَفَ هل يُحذَفُ بلد — ليس رقماً يُعرَض', sites: 1 },
  // old → new (PR-6): 1 → 2. The second is the price gate's read of THIS order's lines (`orderId` + `companyId`), asked only of a person who lacks `orders.change_price`.
  // old → new (30/10, قلم التجهيز): 2 → 4. The third (and, after the reviews of #116, a fourth: the add-on count that refuses a quantity on an order carrying one) is the packing table's read of THIS order's lines (`orderId` + `companyId`) to rebuild a quantity's money from the stored piece price.
  'app/api/orders/[id]/route.ts': { reason: 'مقيَّد بـ orderId واحد — إضافاتُ طلبٍ بعينه وسطورُه (بوابة السعر وقلم التجهيز)', sites: 4 },
  'app/api/orders/import/migrate/route.ts': { reason: 'مقيَّد بأرقام طلباتٍ مُسمّاة من الملف — هل الرقم محجوز لطلبٍ آخر', sites: 1 },
  'app/api/whatsapp/conversations/[id]/route.ts': { reason: 'مقيَّد بـ customerId واحد — محادثةٌ بعينها', sites: 1 },
  'lib/commission-metrics.ts': { reason: 'مقيَّد بـ orderId: { in } ومستخدمٍ واحد', sites: 1 },
  'lib/couriers/dispatch.ts': { reason: 'مقيَّد بـ shippingBatchId واحد', sites: 1 },
  // new (طلب التعديل م٢): قراءتا أسطر وإضافات طلبٍ واحد مُتحقَّق منه (orderId + companyId) لمعاينة التعديل — قراءةٌ صرفة.
  'lib/order-edit-facts.ts': { reason: 'مقيَّد بـ orderId واحد — سطورُ طلبٍ بعينه وإضافاتُه (معاينة التعديل)', sites: 2 },
  'lib/customer-risk.ts': { reason: 'مقيَّد بالعميل نفسِه — تاريخُ شخصٍ لا رقمُ متجر', sites: 3 },
  'lib/jobs/definitions/sync-courier-status.ts': { reason: 'مقيَّد بمندوبٍ واحد وبوليصةٍ موجودة', sites: 1 },
  'lib/landing-analytics.ts': { reason: 'مقيَّد بـ campaignIds مُسمّاة', sites: 1 },
  'lib/operations.ts': { reason: 'مقيَّد بالعميل نفسِه — طلباتُه الأخرى', sites: 2 },
  'lib/payroll.ts': { reason: 'مقيَّد بمستخدمٍ واحد — جزاءُ شخصٍ لا رقمُ متجر', sites: 1 },
  'lib/penalty-service.ts': { reason: 'مقيَّد بمستخدمين مُسمّين', sites: 2 },
  'lib/product-cost.ts': { reason: 'مقيَّد بـ productId — ومنتجُ المنصّة صفُّه الخاصّ', sites: 2 },
  'lib/receiving.ts': { reason: 'مقيَّد بـ productId، أو عدُّ ترقيمٍ لتوليدِ رقمٍ فريد', sites: 2 },
  'lib/settlement.ts': { reason: 'مقيَّد بمراجعَ مُسمّاة من كشف', sites: 1 },
  'lib/shortfall.ts': { reason: 'مقيَّد بـ id: { in } لطلباتِ سطورِ كشفٍ مُسمّاة — يقرأ حالةَ الطلب لا رقمَ متجر', sites: 1 },
  'lib/v1/product-figures.ts': { reason: 'مقيَّد بـ productId: { in } — منتجاتٌ قرأها الكتالوجُ أصلاً بـ realStoresOnly', sites: 1 },
};

/**
 * COMPANY MONEY WITH NO STORE TO SUBTRACT — the honest bucket.
 *
 * These tables carry no `storeId` in the schema at all, so the filter
 * cannot be written. And the question underneath is the owner's, not a
 * programmer's: money spent advertising a test product really left the
 * account, so whether it is a cost of the business is a ruling.
 *
 * A CLOSED LIST THAT CANNOT GROW. If a thirty-second company-wide money
 * aggregate appears, it is not here and the sweep fails.
 */
const NO_STORE_COLUMN: Record<string, Excuse> = {
  'app/api/finance/transfers/route.ts': { reason: 'walletTransfer — لا عمودَ متجرٍ في الجدول', sites: 1 },
};

describe('Ⅰ · every company-wide money read is on one side or the other', () => {
  const all = sites();

  it('and the sweep found them — a sweep that counts nothing proves nothing', () => {
    expect(all.length, 'لم يُعثَرْ على استعلامٍ واحد — المسحُ لا يَمسح').toBeGreaterThanOrEqual(20);
  });

  it('and not one falls outside the three buckets', () => {
    const stray = all.filter((s) => {
      const file = s.at.split(':')[0];
      if (file in ID_SCOPED || file in NO_STORE_COLUMN) return false;
      // Or it carries the filter itself, which is the third side.
      return !/realStoresOnly|isTest/.test(s.where);
    });
    expect(
      stray,
      `استعلامُ مالٍ على الشركةِ لم يُصنَّفْ — إمّا أن يَستثنيَ المنصّةَ أو يُكتَبَ لماذا لا يَحتاج:\n${stray
        .map((s) => `  ${s.at}  ${s.call}\n    ${s.where.slice(0, 120)}`)
        .join('\n')}`
    ).toEqual([]);
  });

  it('and no excused file grew a new site under cover of its excuse', () => {
    /*
     * THE HOLE THIS CLOSES, found by mutation: the excuses are per FILE, so
     * a brand-new company-wide aggregate added to an already-excused file
     * inherited that file's excuse and the sweep stayed green. Pinning the
     * count is what makes an excuse cover the sites it was written for and
     * no others.
     */
    const counted = new Map<string, number>();
    for (const s of all) {
      const f = s.at.split(':')[0];
      counted.set(f, (counted.get(f) ?? 0) + 1);
    }
    const wrong: string[] = [];
    for (const [file, excuse] of Object.entries({ ...ID_SCOPED, ...NO_STORE_COLUMN })) {
      const now = counted.get(file) ?? 0;
      if (now !== excuse.sites) {
        wrong.push(`${file}: العذرُ كُتب لـ${excuse.sites} موضعاً وفيه الآن ${now}`);
      }
    }
    expect(
      wrong,
      `موضعٌ جديدٌ تحتَ عذرٍ قديم — صنِّفْه بنفسِه أو صحِّحِ العدد:\n${wrong.join('\n')}`
    ).toEqual([]);
  });

  it('and the one real leak is asked about the REAL stores’ ids', () => {
    /*
     * `staleStatements` listed every OPEN statement in the company. Named
     * here rather than left to the sweep, because it is the ONE site the
     * sweep's two excuse-lists do not cover — so if the filter is removed,
     * this says which line and why rather than «something is unclassified».
     *
     * IT NO LONGER SPELLS THE FILTER `...realStoresOnly()`, and must not:
     * `CourierStatement` has a `storeId` column and no `store` relation, and
     * Prisma refuses the unknown key at runtime (Ⅳ). So the stores are asked
     * first — `realStoresHere()`, the same `isTest: false` from the same
     * file — and the statements are asked about THEIR ids. Ⅳ runs the
     * function itself; this is the cheap tripwire that names the line.
     */
    /*
     * COMMENTS STRIPPED, THEN WHITESPACE COLLAPSED — and the second half
     * is the part I got wrong twice.
     *
     * The first version matched a 600-character window between the call and
     * the filter and failed, on the ten-line comment I had just written
     * between them. So I stripped comments — and it failed again, because
     * `stripComments` BLANKS a block comment in place, keeping its length
     * so that line numbers still point at the real file. Seven hundred
     * characters of spaces is the same obstacle as seven hundred characters
     * of prose.
     *
     * Widening the window would make the assertion weaker instead of truer.
     * Collapsing the runs makes it tight AND immune to whatever is written
     * between the two lines.
     */
    const src = stripComments(readFileSync(join(SRC, 'lib/intelligence.ts'), 'utf8')).replace(/\s+/g, ' ');
    // Just the one function, so a failure prints a screenful and not the file.
    const from = src.indexOf('function staleStatements');
    const body = src.slice(from, src.indexOf(' export ', from + 1));
    // The stores are asked first, and only the real ones …
    expect(body, 'staleStatements لم تعد تسأل عن المتاجرِ الحقيقيّةِ أوّلاً').toMatch(
      /tx\.store\.findMany\(\{ where: \{ companyId: scope\.companyId, \.\.\.realStoresHere\(\) \}/
    );
    // … and the statements are asked about THOSE ids, not about a relation
    // the model does not have.
    expect(body, 'كشوفُ المنصّةِ عادت تُرفَعُ كمشكلةٍ في العمل').toMatch(
      /courierStatement\.findMany\(\{ where: \{[^}]*storeId: \{ in: realStores\.map/
    );
    expect(body, 'staleStatements عادت تضعُ `store` في where على نموذجٍ بلا علاقة store').not.toContain(
      'realStoresOnly'
    );
  });

  it('and every excuse names a reason long enough to be one', () => {
    for (const [file, excuse] of Object.entries({ ...ID_SCOPED, ...NO_STORE_COLUMN })) {
      expect(excuse.reason.length, `${file}: عذرٌ بلا سبب`).toBeGreaterThan(20);
    }
  });

  it('and no excuse outlives what put it there', () => {
    /*
     * An excuse list nobody prunes is how a sweep stops sweeping. If a
     * file no longer has a company-wide money read, its entry goes.
     */
    const present = new Set(all.map((s) => s.at.split(':')[0]));
    const stale = [...Object.keys(ID_SCOPED), ...Object.keys(NO_STORE_COLUMN)].filter((f) => !present.has(f));
    expect(stale, `عذرٌ لم يَبقَ له موضع — احذِفْه:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and the «no store column» bucket is really about tables with no store column', () => {
    /*
     * CHECKED AGAINST THE SCHEMA, not taken on trust. This is the bucket
     * that admits a live leak, so its claim is the one most worth being
     * false: if somebody adds `storeId` to `WalletTransfer`, the excuse
     * evaporates and this fails, which is exactly when the filter becomes
     * writable. `Expense` got its column on 29/10 and left the bucket, so the
     * other half of this claim is that it HAS it.
     */
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const modelOf = (name: string) =>
      schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('\n}', schema.indexOf(`model ${name} {`)));
    for (const model of ['WalletTransfer']) {
      expect(modelOf(model), `${model} صارَ له عمودُ متجر — فالعذرُ بَطَلَ والفلترُ صارَ ممكناً`).not.toMatch(
        /^\s+storeId/m
      );
    }
    expect(modelOf('Expense'), 'المصروفُ فَقَدَ عمودَ متجره — عادَ ربحُ كلِّ متجرٍ يطرحُ مصاريفَ كلِّ المتاجر').toMatch(
      /^\s+storeId\s+String\?\s+@map\("store_id"\)/m
    );
  });
});

describe('Ⅱ · the filter itself', () => {
  it('asks for a real store, not «not a bench»', () => {
    /*
     * `isTest: false` and not `{ not: true }`: the column is NOT NULL
     * DEFAULT false so the two are the same set today — and `false` stays
     * correct if it ever becomes nullable, where `not: true` would also
     * match a row nobody has decided.
     */
    expect(realStoresOnly()).toEqual({ store: { isTest: false } });
    expect(realStoresHere()).toEqual({ isTest: false });
    expect(JSON.stringify(realStoresOnly()), 'صِيغَ كنفيٍ لا كإثبات').not.toContain('not');
  });

  it('and builds a FRESH object each call', () => {
    /*
     * A module-level object spread into a query is shared mutable state:
     * one caller editing it changes the rule for every other caller for
     * the life of the process. The same reason `leftWarehouseWhere()` is a
     * function.
     */
    const a = realStoresOnly();
    const b = realStoresOnly();
    expect(a).not.toBe(b);
    expect(a.store).not.toBe(b.store);
  });

  it('and the bench’s own screens get the inverse, from the same file', () => {
    expect(benchOnly()).toEqual({ store: { isTest: true } });
    expect(benchOnly().store.isTest).not.toBe(realStoresOnly().store.isTest);
  });

  it('and a figure that left a bench sale out can say so', () => {
    expect(benchExcludedAr(12)).toContain('12');
    expect(benchExcludedAr(0), 'قالَ شيئاً عن منصّةٍ لا طلبَ فيها').toBeNull();
    expect(benchExcludedAr(-3)).toBeNull();
  });
});

describe('Ⅲ · the mark is on the store, and a bench cannot be a shopfront', () => {
  it('the column exists in the schema, mapped to the database name', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const store = schema.slice(schema.indexOf('model Store {'), schema.indexOf('\n}', schema.indexOf('model Store {')));
    expect(store, 'العلامةُ ليست على المتجر').toMatch(/isTest\s+Boolean\s+@default\(false\)\s+@map\("is_test"\)/);
  });

  it('and the database refuses a public bench, not a screen', () => {
    /*
     * A bench carries half-finished products at invented prices, and a
     * store with `storefrontEnabled` is reachable by anybody at
     * `/s/<slug>`. Refused by a CHECK constraint because a screen is one
     * of several doors — see
     * [[osm-schema-is-not-the-constraints]]: six partial unique indexes in
     * this product live only in migrations, so a schema-only guard would
     * have missed those too.
     */
    const migrations = join(process.cwd(), 'prisma/migrations');
    const found = readdirSync(migrations)
      .filter((d) => statSync(join(migrations, d)).isDirectory())
      .map((d) => {
        try {
          return readFileSync(join(migrations, d, 'migration.sql'), 'utf8');
        } catch {
          return '';
        }
      })
      .some((sql) => /stores_test_bench_is_not_public/.test(sql) && /CHECK/.test(sql));
    expect(found, 'لا قيدَ في قاعدةِ البياناتِ يَمنعُ منصّةَ تجريبٍ معروضةً للناس').toBe(true);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Ⅳ · A STORE FILTER IS ONLY EVER WRITTEN ON A MODEL THAT HAS A STORE.
 *
 * The bug, 2026-10-21: `staleStatements` spread `realStoresOnly()` —
 * `{ store: { isTest: false } }` — into a `courierStatement` where. That
 * model has a `storeId` column and NO `store` relation, so Prisma threw
 * «Unknown argument `store`» and GET /api/growth/intelligence stopped
 * answering.
 *
 * WHY NOTHING SAW IT. TypeScript never checks a spread for excess
 * properties, and the mock every other test hands to Prisma accepts any
 * object at all. The one thing that knows what a `where` may contain is the
 * generated data model — `Prisma.dmmf`, the very structure Prisma validates
 * against when the query runs — so that is what is asked here.
 *
 * TWO LAYERS, because each fails in a different way:
 *
 *   · a SWEEP of the source: every place the filter is written must land on
 *     a model that has what the filter needs. It catches the NEXT site, in a
 *     file nobody tests.
 *   · the function RUN against a `tx` that refuses an unknown key the way
 *     Prisma does. It catches the bug in the shape it actually had.
 * ═══════════════════════════════════════════════════════════════════════════
 */

type Model = (typeof Prisma.dmmf.datamodel.models)[number];

const MODELS = Prisma.dmmf.datamodel.models;
const modelNamed = (name: string): Model | undefined => MODELS.find((m) => m.name === name);

const must = (name: string): Model => {
  const m = modelNamed(name);
  if (!m) throw new Error(`«${name}» ليس نموذجاً في البياناتِ المولَّدة — هل نُفِّذ prisma generate؟`);
  return m;
};

/** `db.courierStatement` → `CourierStatement`: Prisma lower-cases the first letter and nothing else. */
const modelOfDelegate = (delegate: string) => modelNamed(delegate.charAt(0).toUpperCase() + delegate.slice(1));

/** What a store filter needs from the model it lands on. */
type Needs = 'store' | 'isTest';

const hasWhatItNeeds = (m: Model, needs: Needs) =>
  needs === 'store'
    ? m.fields.some((f) => f.name === 'store' && f.kind === 'object' && f.type === 'Store')
    : m.fields.some((f) => f.name === 'isTest' && f.kind === 'scalar');

/**
 * THE THREE WAYS `test-store.ts` IS SPELLED, AND WHAT EACH ONE NEEDS.
 *
 * `store: realStoresHere()` is the same filter as the spread, written with
 * the key by hand (`growth/bench` does it) — a guard that knew only one
 * spelling would be passed by the other. `...realStoresHere()` is the
 * odd one out: it puts `isTest` ITSELF into the where, so it belongs on the
 * Store and nowhere else.
 */
const STORE_FILTERS: { spelling: string; re: RegExp; needs: Needs }[] = [
  { spelling: '...realStoresOnly() · ...benchOnly()', re: /\.\.\.\s*(?:realStoresOnly|benchOnly)\s*\(\s*\)/g, needs: 'store' },
  { spelling: 'store: realStoresHere()', re: /\bstore\s*:\s*(?:realStoresHere\s*\(\s*\)|\{\s*isTest\b)/g, needs: 'store' },
  { spelling: '...realStoresHere()', re: /\.\.\.\s*realStoresHere\s*\(\s*\)/g, needs: 'isTest' },
];

const PRISMA_METHODS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'create', 'createMany', 'update', 'updateMany',
  'upsert', 'delete', 'deleteMany',
]);

/** Keys that wrap a filter without changing WHICH MODEL it filters. */
const WRAPS_A_FILTER = new Set(['where', 'select', 'include', '_count', 'AND', 'OR', 'NOT', 'some', 'every', 'none', 'is', 'isNot']);

/**
 * THE PRISMA CALL AROUND A POSITION, AND THE KEYS BETWEEN THEM.
 *
 * Walks BACKWARDS out of the object the filter sits in, through every `{`
 * `[` `(` that encloses it, noting the `key:` each one opened with, until it
 * reaches the `(` of a `<db>.<model>.<method>(` call. The keys are the path
 * from the call's argument down to the filter — `where`, `OR`, a relation's
 * name — and the path is what says WHICH MODEL the filter is on:
 * `orderItem.findMany({ where: { order: { …HERE… } } })` filters an Order,
 * and answering «OrderItem» there would call a correct query wrong.
 *
 * Null when it cannot tell, and «cannot tell» is a failure, not a pass: a
 * guard that is quiet because it could not measure reads exactly like one
 * that passed.
 */
function pathToCall(src: string, at: number): { delegate: string; keys: string[] } | null {
  const closers: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
  const pending: string[] = [];
  const keys: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c in closers) {
      pending.push(closers[c]);
      continue;
    }
    if (c !== '{' && c !== '[' && c !== '(') continue;
    if (pending.length) {
      if (pending.pop() !== c) return null;
      continue;
    }
    // `c` opens a group that ENCLOSES the position.
    const before = src.slice(Math.max(0, i - 160), i);
    if (c === '(') {
      const call = /\.(\w+)\.(\w+)\s*$/.exec(before);
      if (call && PRISMA_METHODS.has(call[2])) return { delegate: call[1], keys };
      continue;
    }
    const key = /(\w+|'[^']*'|"[^"]*")\s*:\s*$/.exec(before);
    if (key) keys.push(key[1].replace(/^['"]|['"]$/g, ''));
  }
  return null;
}

function modelAfter(path: { delegate: string; keys: string[] }): { model: Model } | { problem: string } {
  let model = modelOfDelegate(path.delegate);
  if (!model) return { problem: `«${path.delegate}» ليس نموذجاً في Prisma` };
  for (const key of [...path.keys].reverse()) {
    if (WRAPS_A_FILTER.has(key)) continue;
    const field = model.fields.find((f) => f.name === key);
    if (!field || field.kind !== 'object') return { problem: `${model.name}.${key} ليس علاقةً` };
    const next = modelNamed(field.type);
    if (!next) return { problem: `${field.type} ليس نموذجاً في Prisma` };
    model = next;
  }
  return { model };
}

interface Use {
  at: string;
  spelling: string;
  /** The Prisma model the filter lands on, or null when the source could not say. */
  model: string | null;
  /** Why the model cannot take this filter, or null when it can. */
  problem: string | null;
}

/** Every place the store filter is written in `raw`, in source order, with the model it lands on. */
function storeFilterUses(rel: string, raw: string): Use[] {
  const src = stripComments(raw);
  const found: { index: number; use: Use }[] = [];
  for (const { spelling, re, needs } of STORE_FILTERS) {
    for (const m of src.matchAll(re)) {
      const index = m.index ?? 0;
      const at = `${rel}:${src.slice(0, index).split('\n').length}`;
      const path = pathToCall(src, index);
      if (!path) {
        found.push({
          index,
          use: { at, spelling, model: null, problem: 'ليس داخل نداءِ Prisma مباشر — اكتبْه داخل `where` النداءِ نفسِه' },
        });
        continue;
      }
      const landed = modelAfter(path);
      if ('problem' in landed) {
        found.push({ index, use: { at, spelling, model: null, problem: landed.problem } });
        continue;
      }
      const ok = hasWhatItNeeds(landed.model, needs);
      found.push({
        index,
        use: {
          at,
          spelling,
          model: landed.model.name,
          problem: ok
            ? null
            : needs === 'store'
              ? `${landed.model.name} ليس له علاقةُ \`store\` — سيرفضُها Prisma وقتَ التشغيل («Unknown argument \`store\`»)`
              : `${landed.model.name} ليس له حقلُ \`isTest\` — هذا الشكلُ للمتجر نفسِه فقط`,
        },
      });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.use);
}

/** Every `.ts` and `.tsx` under `src`, tests excluded — a shop page can query too. */
function sourceFiles(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) sourceFiles(f, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(f);
  }
  return out;
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
const RELATION_WRAPPERS = ['some', 'every', 'none', 'is', 'isNot'];

/**
 * WHAT PRISMA CHECKS FIRST AND A MOCK NEVER DOES: that every key of a
 * `where` is a field of the model it filters, and — through a relation — of
 * the model on the other side. The message is Prisma's own, so a failure
 * here reads like the one that was on the dashboard.
 */
function assertWhereFits(modelName: string, where: unknown, path = `${modelName}.where`): void {
  const model = must(modelName);
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (COMBINATORS.has(key)) {
      for (const part of [value].flat()) assertWhereFits(modelName, part, path);
      continue;
    }
    const field = model.fields.find((f) => f.name === key);
    if (!field) throw new Error(`Unknown argument \`${key}\` in ${path}. ${model.name} has no field «${key}».`);
    if (field.kind !== 'object' || value === null || typeof value !== 'object') continue;
    const inner = value as Record<string, unknown>;
    const wrapped = RELATION_WRAPPERS.filter((w) => w in inner);
    if (wrapped.length) for (const w of wrapped) assertWhereFits(field.type, inner[w], `${path}.${key}.${w}`);
    else assertWhereFits(field.type, inner, `${path}.${key}`);
  }
}

type Where = Record<string, unknown>;

/** The rows a `where` of plain equalities and `{ in: […] }` keeps. Anything else it cannot read, and says so. */
function keeps(where: Where, row: object): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = (row as Where)[key];
    if (want !== null && typeof want === 'object') {
      if ('in' in want) return (want as { in: unknown[] }).in.includes(have);
      throw new Error(`the fake tx cannot read a filter on «${key}»`);
    }
    return have === want;
  });
}

interface FakeStore {
  id: string;
  companyId: string;
  isTest: boolean;
}
interface FakeStatement {
  companyId: string;
  storeId: string;
  status: string;
  createdAt: Date;
}

/**
 * A `tx` that answers like the database and REFUSES like Prisma: a `where`
 * with a key the model does not have throws before any row is looked at.
 * The mock `intelligence.test.ts` uses cannot do that — which is how the
 * first version of this fix shipped.
 */
function fakeTx(stores: FakeStore[], statements: FakeStatement[]) {
  const findStores = vi.fn(async ({ where }: { where: Where }) => {
    assertWhereFits('Store', where);
    return stores.filter((s) => keeps(where, s)).map((s) => ({ id: s.id }));
  });
  const findStatements = vi.fn(async ({ where }: { where: Where }) => {
    assertWhereFits('CourierStatement', where);
    return statements.filter((s) => keeps(where, s)).map((s) => ({ createdAt: s.createdAt }));
  });
  const tx = { store: { findMany: findStores }, courierStatement: { findMany: findStatements } };
  return { tx: tx as never, findStores, findStatements };
}

describe('Ⅳ · a store filter is only written on a model that has a store', () => {
  // `lib/test-store.ts` DEFINES the filters; its own bodies are not uses.
  const uses = sourceFiles(SRC)
    .map((f) => ({ f, rel: relative(SRC, f).split(/[\\/]/).join('/') }))
    .filter(({ rel }) => rel !== 'lib/test-store.ts')
    .map(({ f, rel }) => ({ rel, raw: readFileSync(f, 'utf8') }))
    .filter(({ raw }) => /realStores|benchOnly|isTest/.test(raw))
    .flatMap(({ rel, raw }) => storeFilterUses(rel, raw));

  it('reads the data model Prisma itself validates against', () => {
    expect(MODELS.length, 'نموذجُ البياناتِ المولَّد شبهُ فارغ — هل نُفِّذ prisma generate؟').toBeGreaterThan(50);
    for (const name of ['Product', 'Order', 'Customer']) {
      expect(hasWhatItNeeds(must(name), 'store'), `${name} فقد علاقةَ store`).toBe(true);
    }
    expect(hasWhatItNeeds(must('Store'), 'isTest'), 'Store فقد حقلَ isTest').toBe(true);
  });

  it('and the premise of the fix still holds: a statement has a storeId and no store', () => {
    /*
     * The id list in `staleStatements` exists because of this one fact. If a
     * migration ever gives `CourierStatement` the relation, the list becomes
     * needless — and THIS fails, so the comment above that function does not
     * quietly turn into a lie.
     */
    const statement = must('CourierStatement');
    expect(statement.fields.some((f) => f.name === 'storeId' && f.kind === 'scalar')).toBe(true);
    expect(
      hasWhatItNeeds(statement, 'store'),
      'CourierStatement صار له علاقةُ store — فقائمةُ المعرّفات في staleStatements بلا حاجة: بسِّطوها واكتبوا ...realStoresOnly() وحدِّثوا هذا الاختبار'
    ).toBe(false);
  });

  it('and every use in the source lands on a model that has what the filter needs', () => {
    const bad = uses.filter((u) => u.problem);
    expect(
      bad,
      `فلترُ المنصّةِ مكتوبٌ على نموذجٍ لا يقبلُه — Prisma سيرفضُه وقتَ التشغيل ولن يراه الـtypecheck:\n${bad
        .map((u) => `  ${u.at}  ${u.spelling}\n    ${u.problem}`)
        .join('\n')}`
    ).toEqual([]);
  });

  it('and the sweep can SEE the sites it guards — a sweep that counts nothing proves nothing', () => {
    const seen = new Set(uses.map((u) => u.at.split(':')[0]));
    for (const file of [
      'app/api/v1/products/route.ts',
      'app/api/v1/customers/lookup/route.ts',
      'lib/v1/order-intake.ts',
      'app/api/growth/bench/route.ts',
    ]) {
      expect(seen.has(file), `المسحُ لم يَعُدْ يرى مواضعَ الفلترِ في ${file}`).toBe(true);
    }
    const products = uses.filter((u) => u.at.startsWith('app/api/v1/products/route.ts'));
    expect(products.map((u) => u.model), 'المسحُ أخطأ في النموذجِ الذي يقعُ عليه الفلتر').toEqual(['Product']);
  });

  it('and would have caught the filter that took the screen down', () => {
    /*
     * THE MUTATION, KEPT: the old body of `staleStatements`, in the shape it
     * had on main. This does not read the repository — it is the guard's
     * proof that it fails on the code it was written for, and it stays true
     * however the live function is later changed.
     */
    const old = `
      export async function staleStatements(tx: Tx, scope: Scope) {
        const open = await tx.courierStatement.findMany({
          where: { companyId: scope.companyId, status: 'OPEN', ...realStoresOnly() },
          select: { createdAt: true },
        });
      }`;
    const [use, ...rest] = storeFilterUses('lib/intelligence.ts', old);
    expect(rest).toEqual([]);
    expect(use.model).toBe('CourierStatement');
    expect(use.problem, 'المسحُ لم يرَ العطبَ الذي أسقطَ الشاشة').toMatch(/CourierStatement/);
  });

  it('and reads a relation, an OR and a nested object the way Prisma does', () => {
    const fine = `
      await db.product.findMany({ where: { companyId, status: 'ACTIVE', ...realStoresOnly() } });
      await db.orderItem.findMany({ where: { order: { companyId, ...realStoresOnly() } } });
      await db.order.groupBy({ by: ['productId'], where: { companyId, OR: [{ storeId: null }, { store: realStoresHere() }] } });
      await db.store.findMany({ where: { companyId, ...realStoresHere() } });
      await db.customer.findMany({ where: { AND: [{ companyId }, { ...benchOnly() }] } });
    `;
    // `orderItem` has no store, but its `order` does — a naive reader would
    // call the second line wrong.
    expect(storeFilterUses('fixture.ts', fine).map((u) => [u.model, u.problem])).toEqual([
      ['Product', null],
      ['Order', null],
      ['Order', null],
      ['Store', null],
      ['Customer', null],
    ]);

    const wrong = `
      await db.courierStatement.findMany({ where: { companyId, ...benchOnly() } });
      await tx.statementLine.count({ where: { statement: { companyId, ...realStoresOnly() } } });
      await db.order.findMany({ where: { companyId, ...realStoresHere() } });
      await db.orderItem.findMany({ where: { order: { companyId }, ...realStoresOnly() } });
      const scope = (companyId: string) => ({ companyId, ...realStoresOnly() });
    `;
    const found = storeFilterUses('fixture.ts', wrong);
    expect(found.map((u) => u.model)).toEqual(['CourierStatement', 'CourierStatement', 'Order', 'OrderItem', null]);
    expect(found.every((u) => u.problem), 'خمسةٌ خاطئة — كلُّها يجب أن تُرفَض').toBe(true);
  });

  it('and the fake is as strict as the thing it stands for', () => {
    // The exact failure of 2026-10-21 …
    expect(() =>
      assertWhereFits('CourierStatement', { companyId: 'c', status: 'OPEN', ...realStoresOnly() })
    ).toThrow(/Unknown argument `store`/);
    // … and the shapes that are fine.
    expect(() => assertWhereFits('CourierStatement', { companyId: 'c', storeId: { in: ['s'] } })).not.toThrow();
    expect(() => assertWhereFits('Product', { companyId: 'c', ...realStoresOnly() })).not.toThrow();
    expect(() => assertWhereFits('OrderItem', { order: { companyId: 'c', ...realStoresOnly() } })).not.toThrow();
    expect(() => assertWhereFits('Order', { OR: [{ storeId: null }, { store: realStoresHere() }] })).not.toThrow();
  });
});

describe('Ⅳ · staleStatements, run against a tx that refuses like Prisma', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const scope = { companyId: 'c1', storeId: 'real-1', minorUnit: 3, currency: 'JOD' };
  const stores: FakeStore[] = [
    { id: 'real-1', companyId: 'c1', isTest: false },
    { id: 'real-2', companyId: 'c1', isTest: false },
    { id: 'bench-1', companyId: 'c1', isTest: true },
    { id: 'other-1', companyId: 'c2', isTest: false },
  ];
  /*
   * 'OPEN' is what the finder asks for today. Whether any statement ever
   * carries that value is a separate question (BACKLOG_P2 RV70) and this fix
   * does not touch it.
   */
  const stale = (storeId: string, days = 30, companyId = 'c1'): FakeStatement => ({
    companyId,
    storeId,
    status: 'OPEN',
    createdAt: daysAgo(days),
  });

  it('asks Prisma only for fields the data model has — the question the old code failed', async () => {
    const { tx, findStores, findStatements } = fakeTx(stores, [stale('real-1')]);

    // The fake throws «Unknown argument» on a key the model lacks, as Prisma did.
    await expect(staleStatements(tx, scope, now)).resolves.toHaveLength(1);

    const sent = findStatements.mock.calls[0][0].where;
    expect(Object.keys(sent).sort(), 'كشوفُ المنصّةِ تسألُ بمفتاحٍ لا يعرفُه النموذج').toEqual(['companyId', 'status', 'storeId']);
    expect(sent.storeId).toEqual({ in: ['real-1', 'real-2'] });
    expect(findStores.mock.calls[0][0].where).toEqual({ companyId: 'c1', isTest: false });
  });

  it('a bench’s statement, open for a month, is not a finding about the business', async () => {
    const { tx } = fakeTx(stores, [stale('bench-1', 30), stale('bench-1', 45), stale('bench-1', 60)]);
    expect(await staleStatements(tx, scope, now)).toEqual([]);
  });

  it('and a bench does not swell the count of the real ones', async () => {
    // Three bench statements would make it an ALARM (≥ 3). One real one is a WATCH.
    const { tx } = fakeTx(stores, [stale('real-2', 20), stale('bench-1', 30), stale('bench-1', 31), stale('bench-1', 32)]);
    const [finding, ...rest] = await staleStatements(tx, scope, now);
    expect(rest).toEqual([]);
    expect(finding.metric).toBe(1);
    expect(finding.severity).toBe('WATCH');
  });

  it('and it still reads the whole company, not only the store on the screen', async () => {
    const { tx } = fakeTx(stores, [stale('real-1', 20), stale('real-2', 25)]);
    const [finding] = await staleStatements(tx, scope, now);
    expect(finding.metric, 'الكشفان في متجرَين حقيقيَّين — يُعدّان معاً').toBe(2);
  });

  it('and another company’s statements are never counted', async () => {
    const { tx } = fakeTx(stores, [stale('other-1', 40, 'c2')]);
    expect(await staleStatements(tx, scope, now)).toEqual([]);
  });

  it('and a company with no real store does not even ask the statements table', async () => {
    const onlyBench: FakeStore[] = [{ id: 'bench-1', companyId: 'c1', isTest: true }];
    const { tx, findStatements } = fakeTx(onlyBench, [stale('bench-1')]);
    expect(await staleStatements(tx, scope, now)).toEqual([]);
    expect(findStatements).not.toHaveBeenCalled();
  });

  it('and fourteen days is where «old» starts', async () => {
    expect(await staleStatements(fakeTx(stores, [stale('real-1', 13)]).tx, scope, now)).toEqual([]);
    expect(await staleStatements(fakeTx(stores, [stale('real-1', 14)]).tx, scope, now)).toHaveLength(1);
  });
});
