import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { memoryDb } from './stock-transfers.memory-db.test';
import {
  PAIR_HINT_AR,
  PAIR_HINTS,
  ProductPairRefused,
  canonical,
  hintOf,
  pairKey,
  pairRefusalBody,
  proposePairs,
  removePair,
  savePair,
  type PairableProduct,
} from './product-pairs';

/**
 * THE SAME ARTICLE IN TWO STORES (W7a) — the lib: the hints are equalities in one folded form, the proposal is never a
 * choice made for the person, a pair is written in ONE direction, and a save or a removal refuses in Arabic.
 * The doors (session, key, reach) are held by `src/app/api/inventory/pairs/pair-doors.test.ts`.
 */

const P = (id: string, sku: string, name: string, nameEn: string | null = null): PairableProduct => ({ id, sku, name, nameEn });

describe('the form two skus or two names are compared in', () => {
  it('folds the letters, the digits and the spaces, and nothing else', () => {
    expect(pairKey('  ABC-1 ')).toBe('abc-1');
    expect(pairKey('صوبة القدس ٤  شعلات')).toBe(pairKey('صوبه القدس 4 شعلات'));
    expect(pairKey('أحمر')).toBe(pairKey('احمر'));
    // NEGATIVE: a dash or a different digit is a different key — no fuzzy score, ever.
    expect(pairKey('ABC1')).not.toBe(pairKey('ABC-1'));
    expect(pairKey('صوبة 2 شعلات')).not.toBe(pairKey('صوبة 4 شعلات'));
    expect(pairKey('')).toBeNull();
    expect(pairKey('   ')).toBeNull();
    expect(pairKey(null)).toBeNull();
  });

  it('the strongest hint wins: the sku before the name before the English name', () => {
    expect(hintOf(P('a', 'S1', 'كريم'), P('b', 's1', 'شامبو'))).toBe('SKU');
    expect(hintOf(P('a', 'S1', 'كريم'), P('b', 'S2', 'كريم'))).toBe('NAME');
    expect(hintOf(P('a', 'S1', 'كريم', 'Cream'), P('b', 'S2', 'مرطب', 'cream'))).toBe('NAME_EN');
    // NEGATIVE: two empty English names are not the same name.
    expect(hintOf(P('a', 'S1', 'كريم', null), P('b', 'S2', 'مرطب', null))).toBeNull();
    expect(hintOf(P('a', 'S1', 'كريم', ''), P('b', 'S2', 'مرطب', ' '))).toBeNull();
  });

  it('every hint has an Arabic name and no English letter', () => {
    for (const h of PAIR_HINTS) expect(PAIR_HINT_AR[h]).toMatch(/^[^A-Za-z]+$/);
  });
});

describe('one direction for every pair', () => {
  it('side A is the store whose id sorts first, whichever side asked', () => {
    const one = canonical({ productId: 'p1', storeId: 's1' }, { productId: 'p2', storeId: 's2' });
    const two = canonical({ productId: 'p2', storeId: 's2' }, { productId: 'p1', storeId: 's1' });
    expect(one).toEqual({ productAId: 'p1', storeAId: 's1', productBId: 'p2', storeBId: 's2' });
    expect(two).toEqual(one);
    // Byte order (COLLATE "C"), not a dictionary's: an upper-case id sorts before a lower-case one.
    expect(canonical({ productId: 'x', storeId: 'b' }, { productId: 'y', storeId: 'B' }).storeAId).toBe('B');
  });

  it('NEGATIVE: two products of one store are no pair', () => {
    expect(() => canonical({ productId: 'p1', storeId: 's1' }, { productId: 'p2', storeId: 's1' })).toThrow(ProductPairRefused);
  });
});

describe('the proposals', () => {
  const mine = [P('m1', 'ABC-1', 'كريم'), P('m2', 'X', 'صوبة القدس ٤ شعلات'), P('m3', 'SH', 'شامبو'), P('m4', 'Q', 'شي تاني'), P('m5', 'E', 'زيت', 'Oil')];
  const theirs = [
    P('t1', 'abc-1', 'اسم تاني'),
    P('t2', 'Y', 'صوبة القدس 4 شعلات'),
    P('t3', 'Z1', 'شامبو'),
    P('t4', 'Z2', 'شامبو'),
    P('t5', 'F', 'زيت زيتون', 'OIL'),
  ];

  it('the same sku first, then the same name, then the same English name — once per product, under its strongest hint', () => {
    const out = proposePairs(mine, theirs, new Set(), new Set());
    expect(out.map((x) => [x.productId, x.hint, x.candidateIds, x.sure])).toEqual([
      ['m1', 'SKU', ['t1'], true],
      ['m2', 'NAME', ['t2'], true],
      ['m3', 'NAME', ['t3', 't4'], false],
      ['m5', 'NAME_EN', ['t5'], true],
    ]);
  });

  it('NEGATIVE: a candidate offered to two of my products is sure for neither — the person chooses', () => {
    const out = proposePairs([P('a', 'S', 'كريم'), P('b', 'S ', 'مرطب')], [P('t', 's', 'شي')], new Set(), new Set());
    expect(out.map((x) => [x.productId, x.sure])).toEqual([
      ['a', false],
      ['b', false],
    ]);
  });

  it('NEGATIVE: a product already paired with the other store is proposed on neither side', () => {
    const out = proposePairs(mine, theirs, new Set(['m1']), new Set(['t2']));
    expect(out.map((x) => x.productId)).toEqual(['m3', 'm5']);
    expect(out.flatMap((x) => x.candidateIds)).not.toContain('t2');
  });

  it('nothing alike, nothing proposed', () => {
    expect(proposePairs([P('a', 'A', 'أ')], [P('b', 'B', 'ب')], new Set(), new Set())).toEqual([]);
  });
});

describe('save and remove, inside a transaction', () => {
  const base = () =>
    memoryDb({
      store: [
        { id: 's1', companyId: 'c1', countryId: 'k1', name: 'أ' },
        { id: 's2', companyId: 'c1', countryId: 'k1', name: 'ب' },
      ],
      product: [
        { id: 'p1', companyId: 'c1', storeId: 's1', name: 'كريم', nameEn: null, sku: 'A1' },
        { id: 'p2', companyId: 'c1', storeId: 's2', name: 'كريم', nameEn: null, sku: 'a1' },
        { id: 'p2b', companyId: 'c1', storeId: 's2', name: 'غيره', nameEn: null, sku: 'B' },
      ],
    });
  const all = async () => true;

  it('a save writes ONE row in the one direction, with the server’s own hint, and a second save is a replay', async () => {
    const m = base();
    const tx = m.tx;
    const first = await savePair(tx, { companyId: 'c1', storeId: 's2', userId: 'u', productId: 'p2', otherProductId: 'p1', reaches: all });
    expect(first.replay).toBe(false);
    expect(first.pair).toMatchObject({ productId: 'p2', otherProductId: 'p1', otherStoreId: 's1', hint: 'SKU' });
    expect(m.data.productPair).toEqual([expect.objectContaining({ productAId: 'p1', storeAId: 's1', productBId: 'p2', storeBId: 's2', hint: 'SKU', createdById: 'u' })]);
    const again = await savePair(tx, { companyId: 'c1', storeId: 's1', userId: 'v', productId: 'p1', otherProductId: 'p2', reaches: all });
    expect(again).toMatchObject({ replay: true, pair: { productId: 'p1', otherProductId: 'p2' } });
    expect(m.data.productPair).toHaveLength(1);
  });

  it('NEGATIVE: a second twin in the same store is refused, from either side', async () => {
    const m = base();
    const tx = m.tx;
    await savePair(tx, { companyId: 'c1', storeId: 's1', userId: 'u', productId: 'p1', otherProductId: 'p2', reaches: all });
    await expect(savePair(tx, { companyId: 'c1', storeId: 's1', userId: 'u', productId: 'p1', otherProductId: 'p2b', reaches: all })).rejects.toMatchObject({
      code: 'MINE_ALREADY_PAIRED',
      status: 409,
    });
    await expect(savePair(tx, { companyId: 'c1', storeId: 's2', userId: 'u', productId: 'p2b', otherProductId: 'p1', reaches: all })).rejects.toMatchObject({
      code: 'OTHER_ALREADY_PAIRED',
    });
    expect(m.data.productPair).toHaveLength(1);
  });

  it('NEGATIVE: a store she does not reach answers like a product that is not there', async () => {
    const m = base();
    const e = await savePair(m.tx, { companyId: 'c1', storeId: 's1', userId: 'u', productId: 'p1', otherProductId: 'p2', reaches: async () => false }).catch((x) => x);
    expect(e).toMatchObject({ code: 'OTHER_NOT_FOUND', status: 404 });
    expect(pairRefusalBody(e)).toEqual({ error: e.errorAr, errorAr: e.errorAr, code: 'OTHER_NOT_FOUND' });
    expect(e.errorAr).toMatch(/[؀-ۿ]/);
    expect(m.data.productPair).toHaveLength(0);
  });

  it('NEGATIVE: a product of another company is not there, even for a reach that says yes to every store', async () => {
    const m = base();
    m.data.product.push({ id: 'px', companyId: 'c2', storeId: 's9', name: 'كريم', nameEn: null, sku: 'A1' });
    await expect(savePair(m.tx, { companyId: 'c1', storeId: 's1', userId: 'u', productId: 'p1', otherProductId: 'px', reaches: all })).rejects.toMatchObject({
      code: 'OTHER_NOT_FOUND',
    });
    expect(m.data.productPair).toHaveLength(0);
  });

  it('a removal takes the row away; NEGATIVE: a pair of another store, or of a store she does not reach, is «not found»', async () => {
    const m = memoryDb({
      productPair: [{ id: 'pp', companyId: 'c1', productAId: 'p1', storeAId: 's1', productBId: 'p2', storeBId: 's2', hint: null, createdById: 'u', createdAt: new Date() }],
    });
    const tx = m.tx;
    await expect(removePair(tx, { companyId: 'c1', storeId: 's3', pairId: 'pp', reaches: all })).rejects.toMatchObject({ code: 'PAIR_NOT_FOUND' });
    await expect(removePair(tx, { companyId: 'c2', storeId: 's1', pairId: 'pp', reaches: all })).rejects.toMatchObject({ code: 'PAIR_NOT_FOUND' });
    await expect(removePair(tx, { companyId: 'c1', storeId: 's1', pairId: 'pp', reaches: async (s) => s !== 's2' })).rejects.toMatchObject({
      code: 'PAIR_NOT_FOUND',
    });
    expect(m.data.productPair).toHaveLength(1);
    expect(await removePair(tx, { companyId: 'c1', storeId: 's2', pairId: 'pp', reaches: all })).toMatchObject({ productId: 'p2', otherProductId: 'p1' });
    expect(m.data.productPair).toHaveLength(0);
  });

  it('a save and a removal touch the pairs table and nothing else', async () => {
    const m = base();
    await savePair(m.tx, { companyId: 'c1', storeId: 's1', userId: 'u', productId: 'p1', otherProductId: 'p2', reaches: all });
    await removePair(m.tx, { companyId: 'c1', storeId: 's1', pairId: m.data.productPair[0].id, reaches: all });
    expect(m.touched).toEqual(['productPair.create', 'productPair.delete']);
  });
});

/**
 * NOTHING ELSE: the pair modules load no stock-writing module and no money module, and nothing outside them reads the
 * table yet (the transfer between stores, W7b, will be the first).
 */
describe('the pairs stand alone', () => {
  const ROOT = process.cwd();
  const MONEY = /wallet|expense|profit|financ|commission|settlement|payslip|partner/i;
  const STOCK = /receiving|stock-consumption|reservation|batch-split|stock-transfers|stock-exits|variant-stock/;
  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(c)) return c;
    return null;
  }
  const direct = (f: string) => {
    const src = readFileSync(join(ROOT, f), 'utf8');
    return [...src.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => resolve(join(ROOT, f), m[1]))
      .filter((x): x is string => !!x)
      .map((p) => p.slice(ROOT.length + 1).split('\\').join('/'));
  };

  it('the lib and the doors import no money module and no stock writer', () => {
    for (const f of ['src/lib/product-pairs.ts', 'src/app/api/inventory/pairs/route.ts', 'src/app/api/inventory/pairs/[id]/route.ts']) {
      const files = direct(f);
      expect(files.filter((x) => MONEY.test(x) || STOCK.test(x)), f).toEqual([]);
    }
  });

  it('nothing outside the pair files reads the table yet', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name.name) && !/\.test\.tsx?$/.test(name.name) && /productPair\b|product_pairs/.test(readFileSync(p, 'utf8'))) {
          hits.push(p.slice(ROOT.length + 1).split('\\').join('/'));
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(hits.sort()).toEqual(['src/lib/product-pairs.ts']);
  });
});
