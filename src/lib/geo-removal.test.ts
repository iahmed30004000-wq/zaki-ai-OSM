import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PAGE_SEEDS, seedPagesFor } from './store-pages';
import {
  NO_COMPANY_COLUMN,
  STORE_TABLES,
  STORE_TABLE_MODELS,
  blockersSentence,
  isUntouchedSeed,
  regionBlockers,
  regionUse,
  storeBlockers,
  type StoreFacts,
} from './geo-removal';

/**
 * WHEN A STORE, OR A CITY, MAY BE DELETED — AND THE DAY A TABLE WAS FORGOTTEN.
 *
 * The owner, 21/10: «بدي زر لحذف المتجر اذا ما كان مدخل عليه اشي» and «لحذف
 * المدن اذا ما كان مربوط فيها ولا طلب».
 *
 * The first thing here is the one that can fail without anybody touching this
 * file: `STORE_TABLES` lists every model that points at a store, by hand,
 * because the database cannot say «something was entered» — eight of the
 * twenty-eight have no foreign key at all, and would be left behind pointing
 * at a store that is gone. So the list is held against Prisma's own generated
 * model: a twenty-ninth table with a `storeId` fails the first claim below
 * until somebody has decided what it means for deleting a store.
 */

const MODELS = Prisma.dmmf.datamodel.models;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Every model with a `storeId` column, or a relation whose foreign key is to a Store. */
const pointsAtStore = (m: (typeof MODELS)[number]) =>
  m.fields.some((f) => f.kind === 'scalar' && f.name === 'storeId') ||
  m.fields.some((f) => f.kind === 'object' && f.type === 'Store' && (f.relationFromFields?.length ?? 0) > 0);

/** What the database does to this model's rows when their store goes: Cascade, Restrict, SetNull, … or null for no foreign key at all. */
const onDeleteOf = (m: (typeof MODELS)[number]): string | null => {
  const rel = m.fields.find((f) => f.kind === 'object' && f.type === 'Store' && (f.relationFromFields?.length ?? 0) > 0);
  return rel ? (rel.relationOnDelete ?? 'NoAction') : null;
};

describe('the list of tables a store can be pointed at', () => {
  it('— is exactly the models Prisma generated with a storeId: none forgotten, none invented', () => {
    const wanted = MODELS.filter(pointsAtStore).map((m) => lowerFirst(m.name)).sort();
    expect([...STORE_TABLE_MODELS].sort()).toEqual(wanted);
    // The detection itself must be finding something, or the equality above would hold for two empty lists.
    expect(wanted.length).toBeGreaterThan(20);
  });

  it('and each is named once, and called something a person can read', () => {
    expect(new Set(STORE_TABLE_MODELS).size).toBe(STORE_TABLES.length);
    for (const t of STORE_TABLES) expect(t.label.length, t.model).toBeGreaterThan(3);
  });

  it('and what the database would NOT clear away for us can never be let go — only the two the system itself writes', () => {
    const letGo = STORE_TABLES.filter((t) => t.how !== 'blocks').map((t) => t.model).sort();
    expect(letGo).toEqual(['notification', 'storePage']);
    // Both really do cascade: nothing is left behind pointing at a store that is gone.
    for (const model of letGo) {
      const m = MODELS.find((x) => lowerFirst(x.name) === model)!;
      expect(onDeleteOf(m), `${model} لا يُمسح مع المتجر`).toBe('Cascade');
    }
  });

  it('and the ones with no foreign key, or one that lets go, are all stoppers — a payslip is not left pointing at nothing', () => {
    for (const m of MODELS.filter(pointsAtStore)) {
      const how = STORE_TABLES.find((t) => t.model === lowerFirst(m.name))!.how;
      const rule = onDeleteOf(m);
      if (rule === null || rule === 'SetNull' || rule === 'Restrict' || rule === 'NoAction') {
        expect(how, `${m.name} (${rule ?? 'بلا مفتاح أجنبي'})`).toBe('blocks');
      }
    }
  });
});

describe('the skeleton pages a store is created with', () => {
  const page = (over: Partial<Parameters<typeof isUntouchedSeed>[0]> = {}) => ({ ...seedPagesFor('متجر')[0], ...over });

  it('— all three, untouched, are not something entered', () => {
    for (const p of seedPagesFor('متجر الشفاء')) expect(isUntouchedSeed(p), p.slug).toBe(true);
    expect(PAGE_SEEDS).toHaveLength(3);
  });

  it('and the shop having been renamed since does not make them somebody’s work', () => {
    // Made as «اسم قديم», the shop is «اسم جديد» now: the page still says the old one.
    for (const p of seedPagesFor('اسم قديم')) expect(isUntouchedSeed(p), p.slug).toBe(true);
  });

  it('and a page published, edited by one word, retitled, or not one of the three, is', () => {
    expect(isUntouchedSeed(page({ isPublished: true }))).toBe(false);
    expect(isUntouchedSeed(page({ body: page().body.replace('نبيع', 'نشتري') }))).toBe(false);
    expect(isUntouchedSeed(page({ body: page().body + ' ' }))).toBe(false);
    expect(isUntouchedSeed(page({ title: 'سياسة أخرى' }))).toBe(false);
    expect(isUntouchedSeed(page({ kind: 'CUSTOM' }))).toBe(false);
    expect(isUntouchedSeed(page({ slug: 'my-own-page' }))).toBe(false);
  });

  it('and one punctuation mark changed is an edit — the words around the name are matched as written, not as a pattern', () => {
    // «.» in a pattern means any character: unescaped, a full stop swapped for a comma would still read as the skeleton.
    const body = page().body;
    expect(body.endsWith('.')).toBe(true);
    expect(isUntouchedSeed(page({ body: `${body.slice(0, -1)}،` }))).toBe(false);
    expect(isUntouchedSeed(page({ body: `${body.slice(0, -1)}!` }))).toBe(false);
    expect(isUntouchedSeed(page({ body }))).toBe(true);
  });

  it('and a name that is not the same everywhere it appears is an edit', () => {
    const seeds = [{ slug: 's', title: 't', kind: 'TERMS', body: 'أهلاً في «{{store}}». شكراً لاختيارك «{{store}}».' }];
    const made = (a: string, b: string) => ({ slug: 's', title: 't', kind: 'TERMS', isPublished: false, body: `أهلاً في «${a}». شكراً لاختيارك «${b}».` });
    expect(isUntouchedSeed(made('متجر', 'متجر'), seeds)).toBe(true);
    expect(isUntouchedSeed(made('متجر', 'متجر آخر'), seeds)).toBe(false);
  });

  it('and the pattern is not fooled by what the name contains', () => {
    // A name full of the characters a pattern treats as its own.
    for (const name of ['A (B) [C] {D} *E* +F? ^G$ |H\\ .I', 'a.b']) {
      for (const p of seedPagesFor(name)) expect(isUntouchedSeed(p), `${name} / ${p.slug}`).toBe(true);
    }
  });
});

// ───────────────────────── asking the database ─────────────────────────

interface PageRow {
  storeId: string;
  slug: string;
  title: string;
  kind: string;
  body: string;
  isPublished: boolean;
}

/** A database that knows only what `groupBy` and the pages' `findMany` are asked, and counts what it was asked. */
function fakeDb(rows: Record<string, Record<string, number>> = {}, pages: PageRow[] = []) {
  const asked: string[] = [];
  const db: Record<string, unknown> = {};
  for (const t of STORE_TABLES) {
    db[t.model] = {
      groupBy: vi.fn(async (args: { where: { storeId: { in: string[] } } }) => {
        asked.push(t.model);
        return args.where.storeId.in
          .filter((id) => rows[t.model]?.[id])
          .map((id) => ({ storeId: id, _count: { _all: rows[t.model][id] } }));
      }),
      findMany: vi.fn(async (args: { where: { storeId: { in: string[] } } }) => {
        asked.push(`${t.model}:rows`);
        return pages.filter((p) => args.where.storeId.in.includes(p.storeId));
      }),
    };
  }
  return { db, asked };
}

/** Whoever is asking: their company, and (when a claim says so) the store they stand in. */
const asker = { companyId: 'c1' };
const store = (id: string, over: Partial<StoreFacts> = {}): StoreFacts => ({
  id,
  storefrontEnabled: false,
  domain: null,
  landingPageId: null,
  ...over,
});
const seeded = (storeId: string, name = 'متجر') => seedPagesFor(name).map((p) => ({ ...p, storeId }));

describe('a store with nothing entered on it', () => {
  it('— has no reason to stay, with its three skeleton pages and whatever the system wrote about it', () => {
    const { db } = fakeDb({ notification: { s1: 40 } }, seeded('s1'));
    return expect(storeBlockers(db, [store('s1')], asker)).resolves.toEqual(new Map([['s1', []]]));
  });

  it('and the system’s notifications are never even asked about — they go with the store', async () => {
    const { db, asked } = fakeDb({ notification: { s1: 40 } }, seeded('s1'));
    await storeBlockers(db, [store('s1')], asker);
    expect(asked).not.toContain('notification');
  });
});

describe('a store with something entered on it', () => {
  it.each(STORE_TABLES.filter((t) => t.how === 'blocks'))('— %# · one row in «$label» keeps it, and says how many', async (t) => {
    const { db } = fakeDb({ [t.model]: { s1: 3 } }, seeded('s1'));
    const why = (await storeBlockers(db, [store('s1')], asker)).get('s1')!;
    expect(why).toEqual([{ key: t.model, text: `${t.label} (3)`, count: 3 }]);
  });

  it('and a skeleton page that was edited keeps it; so does one published, or one the owner added', async () => {
    const edited = seeded('s1').map((p, i) => (i === 0 ? { ...p, body: p.body + '\nسطر أضفتُه.' } : p));
    const published = seeded('s1').map((p, i) => (i === 1 ? { ...p, isPublished: true } : p));
    const added = [...seeded('s1'), { storeId: 's1', slug: 'about', title: 'من نحن', kind: 'ABOUT', body: 'نحن…', isPublished: false }];
    for (const pages of [edited, published, added]) {
      const { db } = fakeDb({}, pages);
      expect((await storeBlockers(db, [store('s1')], asker)).get('s1')).toEqual([
        { key: 'storePage', text: 'صفحات معدَّلة أو منشورة (1)', count: 1 },
      ]);
    }
  });

  it('and the things no row can say: open to customers, its own domain, fronted by a landing page, and the one you stand in', async () => {
    const { db } = fakeDb();
    const keys = async (over: Partial<StoreFacts>, standing?: string) =>
      (await storeBlockers(db, [store('s1', over)], { ...asker, selectedStoreId: standing })).get('s1')!.map((b) => b.key);
    expect(await keys({ storefrontEnabled: true })).toEqual(['live']);
    expect(await keys({ domain: 'shop.example.com' })).toEqual(['domain']);
    expect(await keys({ landingPageId: 'lp1' })).toEqual(['front']);
    expect(await keys({}, 's1')).toEqual(['selected']);
    // Somebody else's store is not the one you stand in.
    expect(await keys({}, 's2')).toEqual([]);
  });

  it('and every reason is listed, the standing and the live ones first, then the tables in the order the screen reads them', async () => {
    const { db } = fakeDb({ wallet: { s1: 1 }, order: { s1: 5 }, userStoreAccess: { s1: 2 } }, seeded('s1'));
    const why = (await storeBlockers(db, [store('s1', { storefrontEnabled: true })], { ...asker, selectedStoreId: 's1' })).get('s1')!;
    expect(why.map((b) => b.key)).toEqual(['selected', 'live', 'order', 'wallet', 'userStoreAccess']);
  });

  it('and staff confined to the store keep it — letting it go would widen their access to every store', async () => {
    const { db } = fakeDb({ userStoreAccess: { s1: 1 } }, seeded('s1'));
    const why = (await storeBlockers(db, [store('s1')], asker)).get('s1')!;
    expect(why.map((b) => b.text)).toEqual(['موظفون مقيَّدون بهذا المتجر (1)']);
  });
});

describe('asking about many stores at once', () => {
  it('— each store gets its own answer, from counts grouped per store', async () => {
    const { db } = fakeDb({ order: { s2: 7 }, product: { s1: 1, s3: 2 } }, [...seeded('s1'), ...seeded('s2'), ...seeded('s3')]);
    const out = await storeBlockers(db, [store('s1'), store('s2'), store('s3')], asker);
    expect(out.get('s1')!.map((b) => b.text)).toEqual(['المنتجات (1)']);
    expect(out.get('s2')!.map((b) => b.text)).toEqual(['الطلبات (7)']);
    expect(out.get('s3')!.map((b) => b.text)).toEqual(['المنتجات (2)']);
  });

  it('and it costs the same however many — one query per table, never one per store', async () => {
    const one = fakeDb();
    await storeBlockers(one.db, [store('s1')], asker);
    const many = fakeDb();
    await storeBlockers(many.db, Array.from({ length: 40 }, (_, i) => store(`s${i}`)), asker);
    expect(many.asked.length).toBe(one.asked.length);
    // Twenty-seven stoppers (the expenses joined the wallets and payslips), and the pages.
    expect(one.asked.length).toBe(28);
  });

  it('and no stores asks nothing at all', async () => {
    const { db, asked } = fakeDb();
    expect((await storeBlockers(db, [], asker)).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('and a row whose store is none — a company-wide rule — is nobody’s', async () => {
    const db = fakeDb().db;
    (db.commissionRule as { groupBy: unknown }).groupBy = vi.fn(async () => [{ storeId: null, _count: { _all: 9 } }]);
    expect((await storeBlockers(db, [store('s1')], asker)).get('s1')).toEqual([]);
  });
});

describe('every question is asked with the asker’s company', () => {
  it('— so a count is of THEIR rows, and the indexes that lead with it are the ones used', async () => {
    const { db } = fakeDb({}, seeded('s1'));
    await storeBlockers(db, [store('s1')], { companyId: 'company-7' });
    for (const t of STORE_TABLES.filter((x) => x.how === 'blocks' && !NO_COMPANY_COLUMN.has(x.model))) {
      const delegate = db[t.model] as { groupBy: { mock: { calls: { where: unknown }[][] } } };
      expect(delegate.groupBy.mock.calls[0][0].where, t.model).toEqual({ companyId: 'company-7', storeId: { in: ['s1'] } });
    }
    const pages = db.storePage as { findMany: { mock: { calls: { where: unknown }[][] } } };
    expect(pages.findMany.mock.calls[0][0].where).toEqual({ companyId: 'company-7', storeId: { in: ['s1'] } });
  });

  it('and the one table with no company column is asked by store alone', async () => {
    const { db } = fakeDb();
    await storeBlockers(db, [store('s1')], { companyId: 'company-7' });
    const access = db.userStoreAccess as { groupBy: { mock: { calls: { where: unknown }[][] } } };
    expect(access.groupBy.mock.calls[0][0].where).toEqual({ storeId: { in: ['s1'] } });
  });

  it('and «no company column» is exactly what the generated schema says — and no more', () => {
    const lacking = STORE_TABLES
      .filter((t) => !MODELS.find((m) => lowerFirst(m.name) === t.model)!.fields.some((f) => f.kind === 'scalar' && f.name === 'companyId'))
      .map((t) => t.model)
      .sort();
    expect(lacking).toEqual([...NO_COMPANY_COLUMN].sort());
  });
});

describe('the sentence a refusal is sent as', () => {
  it('— names what it is about and lists every reason', () => {
    expect(blockersSentence('المتجر', [{ key: 'order', text: 'الطلبات (3)' }, { key: 'live', text: 'واجهته مفتوحة' }])).toBe(
      'لا يُحذف المتجر: الطلبات (3) · واجهته مفتوحة'
    );
  });
});

// ───────────────────────── cities ─────────────────────────

/** A database that answers `groupBy` on orders and on courier fees only, by city. */
function fakeRegions(orders: Record<string, number>, fees: Record<string, number>) {
  const ask = (rows: Record<string, number>) =>
    vi.fn(async (args: { where: { regionId: { in: string[] } } }) =>
      args.where.regionId.in.filter((id) => rows[id]).map((id) => ({ regionId: id, _count: { _all: rows[id] } }))
    );
  return { order: { groupBy: ask(orders) }, deliveryFee: { groupBy: ask(fees) } };
}

describe('a city', () => {
  it('— nothing names it, so nothing keeps it', async () => {
    const use = await regionUse(fakeRegions({}, {}), ['r1']);
    expect(use.get('r1')).toEqual({ orders: 0, fees: 0 });
    expect(regionBlockers(use.get('r1'))).toEqual([]);
  });

  it('and an order that names it keeps it — whatever state the order is in', async () => {
    const use = await regionUse(fakeRegions({ r1: 4 }, {}), ['r1']);
    expect(regionBlockers(use.get('r1'))).toEqual([{ key: 'orders', text: 'الطلبات (4)', count: 4 }]);
  });

  it('and a courier’s fee for it keeps it — the database would have deleted that price silently', async () => {
    const use = await regionUse(fakeRegions({}, { r1: 2 }), ['r1']);
    expect(regionBlockers(use.get('r1'))).toEqual([{ key: 'fees', text: 'أجور التوصيل (2)', count: 2 }]);
  });

  it('and both are told, orders first', async () => {
    const use = await regionUse(fakeRegions({ r1: 1 }, { r1: 1 }), ['r1']);
    expect(regionBlockers(use.get('r1')).map((b) => b.key)).toEqual(['orders', 'fees']);
  });

  it('and each city gets its own counts from one question per table', async () => {
    const db = fakeRegions({ r1: 4 }, { r2: 2 });
    const use = await regionUse(db, ['r1', 'r2', 'r3']);
    expect(use.get('r1')).toEqual({ orders: 4, fees: 0 });
    expect(use.get('r2')).toEqual({ orders: 0, fees: 2 });
    expect(use.get('r3')).toEqual({ orders: 0, fees: 0 });
    expect(db.order.groupBy).toHaveBeenCalledTimes(1);
    expect(db.deliveryFee.groupBy).toHaveBeenCalledTimes(1);
  });

  it('and no cities asks nothing at all; a city nobody asked about is not a city with nothing', async () => {
    const db = fakeRegions({}, {});
    expect((await regionUse(db, [])).size).toBe(0);
    expect(db.order.groupBy).not.toHaveBeenCalled();
    expect(regionBlockers(undefined)).toEqual([]);
  });
});
