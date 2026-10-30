import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * POST /api/products/categorise — THE DOOR THE «رتّبها لي» DIALOG PRESSES (THE OWNER, 22/10: «انتا صنف افضل»).
 *
 * The door files products that carry no category onto shelves a person chose. It runs here against a SMALL FAKE OF THE TABLES
 * (products and categories as arrays, `findMany` / `updateMany` / `create` honouring the WHERE they are given), so what is held is
 * what the door does to rows and not what it was told to call:
 *
 *   · it never moves a product that already has a category — not one filed before the request, and not one filed while it ran;
 *   · it makes a shelf only for a product it is about to file, never a second copy of a shelf that exists under another spelling,
 *     and never an empty one;
 *   · it stays inside the caller's store and the caller's reach (`products.edit`, scoped);
 *   · it logs every product it files and every shelf it makes, and nothing it does not;
 *   · and every refusal is an Arabic sentence, in BOTH fields.
 *
 * The permission engine is the REAL one (`authorize` / `can` over grants attached to the session user), not a stub that says yes.
 * ═══════════════════════════════════════════════════════════════════════
 */

interface ProductRow {
  id: string;
  companyId: string;
  storeId: string;
  categoryId: string | null;
}
interface CategoryRow {
  id: string;
  companyId: string;
  name: string;
}

const { fake, requireContext, logAudit } = vi.hoisted(() => ({
  fake: {
    products: [] as ProductRow[],
    categories: [] as CategoryRow[],
    /** Called between the read and the write, to simulate somebody else filing a product in that gap. */
    between: null as null | (() => void),
    nextId: 1,
    calls: { findProducts: [] as any[], updateMany: [] as any[], createCategory: [] as any[], findCategories: [] as any[] },
  },
  requireContext: vi.fn(),
  logAudit: vi.fn(),
}));

const matches = (row: Record<string, unknown>, where: Record<string, any>): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
    return row[k] === v;
  });

vi.mock('@/lib/db', () => ({
  db: {
    product: {
      findMany: vi.fn(async (args: { where: Record<string, any> }) => {
        fake.calls.findProducts.push(args);
        const rows = fake.products.filter((p) => matches(p as any, args.where)).map((p) => ({ ...p }));
        fake.between?.();
        return rows;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, any>; data: Partial<ProductRow> }) => {
        fake.calls.updateMany.push(args);
        const hit = fake.products.filter((p) => matches(p as any, args.where));
        for (const p of hit) Object.assign(p, args.data);
        return { count: hit.length };
      }),
    },
    category: {
      findMany: vi.fn(async (args: { where: Record<string, any> }) => {
        fake.calls.findCategories.push(args);
        return fake.categories.filter((c) => matches(c as any, args.where)).map((c) => ({ id: c.id, name: c.name }));
      }),
      create: vi.fn(async (args: { data: { companyId: string; name: string } }) => {
        fake.calls.createCategory.push(args);
        const row = { id: `cat-new-${fake.nextId++}`, companyId: args.data.companyId, name: args.data.name };
        fake.categories.push(row);
        return { id: row.id, name: row.name };
      }),
    },
  },
}));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
// `authorization.ts` imports these; the engine itself is the real one.
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { POST } from './route';

const COMPANY = 'c1';
const STORE = 's1';
const P = (n: number) => `product-0000-${String(n).padStart(4, '0')}`; // ids are 10–64 characters

/** A session user whose grants are attached the way `getCurrentUser` attaches them. */
const userWith = (grants: Record<string, { scope: string; scopeIds?: string[] | null }>) => ({
  id: 'u1',
  role: 'MODERATOR',
  status: 'ACTIVE',
  companyId: COMPANY,
  effectiveGrants: { fullAccess: false, grants },
});
// was: { 'products.edit' } alone — making a shelf is `categories.manage` since PR-11 (the migration gave it to every company-wide editor).
const EDITOR = userWith({ 'products.edit': { scope: 'ALL_COMPANY' }, 'categories.manage': { scope: 'ALL_COMPANY' } });

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/products/categorise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
const json = async (res: Response) => (await res.json()) as any;
const productRow = (n: number, over: Partial<ProductRow> = {}): ProductRow => ({
  id: P(n), companyId: COMPANY, storeId: STORE, categoryId: null, ...over,
});
const item = (n: number, category: string) => ({ productId: P(n), category });
const categoryOf = (n: number) => fake.products.find((p) => p.id === P(n))?.categoryId;

beforeEach(() => {
  vi.clearAllMocks();
  fake.products = [];
  fake.categories = [];
  fake.between = null;
  fake.nextId = 1;
  fake.calls = { findProducts: [], updateMany: [], createCategory: [], findCategories: [] };
  requireContext.mockResolvedValue({ user: EDITOR, companyId: COMPANY, storeId: STORE });
});

describe('who may press it', () => {
  it('— without `products.edit` it is a 403 in Arabic, in BOTH fields, and nothing is read or written', async () => {
    requireContext.mockResolvedValue({ user: userWith({ 'products.view': { scope: 'ALL_COMPANY' } }), companyId: COMPANY, storeId: STORE });
    fake.products = [productRow(1)];
    const res = await post({ items: [item(1, 'العناية بالبشرة')] });
    expect(res.status).toBe(403);
    const b = await json(res);
    expect(b.error).toBe('لا تملك صلاحية تعديل المنتجات.');
    expect(b.errorAr).toBe('لا تملك صلاحية تعديل المنتجات.');
    expect(fake.calls.findProducts).toHaveLength(0);
    expect(fake.calls.updateMany).toHaveLength(0);
    expect(categoryOf(1)).toBeNull();
  });

  it('— a suspended account with the grant is refused all the same', async () => {
    requireContext.mockResolvedValue({ user: { ...EDITOR, status: 'SUSPENDED' }, companyId: COMPANY, storeId: STORE });
    fake.products = [productRow(1)];
    const res = await post({ items: [item(1, 'العناية بالبشرة')] });
    expect(res.status).toBe(403);
    expect(categoryOf(1)).toBeNull();
  });

  it('— a grant scoped to a CATEGORY reaches only products in it, and an unfiled product is in none: nothing is filed, nothing is made', async () => {
    requireContext.mockResolvedValue({
      user: userWith({ 'products.edit': { scope: 'CATEGORY', scopeIds: ['cat-skin'] } }),
      companyId: COMPANY,
      storeId: STORE,
    });
    fake.products = [productRow(1), productRow(2)];
    const b = await json(await post({ items: [item(1, 'العناية بالبشرة'), item(2, 'إلكترونيات')] }));
    expect(b).toEqual({ filed: 0, skipped: 2, created: [] });
    expect(fake.products.every((p) => p.categoryId === null)).toBe(true);
    expect(fake.calls.createCategory).toHaveLength(0);
  });

  it('— a grant scoped to SPECIFIC products files those and only those', async () => {
    requireContext.mockResolvedValue({
      // was: no categories.manage — here it is held, so this test keeps asking only about the REACH of the edit.
      user: userWith({ 'products.edit': { scope: 'SPECIFIC', scopeIds: [P(2)] }, 'categories.manage': { scope: 'ALL_COMPANY' } }),
      companyId: COMPANY,
      storeId: STORE,
    });
    fake.products = [productRow(1), productRow(2), productRow(3)];
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(2, 'مكمّلات'), item(3, 'مكمّلات')] }));
    expect(b.filed).toBe(1);
    expect(b.skipped).toBe(2);
    expect(categoryOf(2)).not.toBeNull();
    expect(categoryOf(1)).toBeNull();
    expect(categoryOf(3)).toBeNull();
  });

  it('— without `categories.manage` it files onto the shelves that EXIST and makes none: the products that wanted a new one are skipped', async () => {
    requireContext.mockResolvedValue({ user: userWith({ 'products.edit': { scope: 'ALL_COMPANY' } }), companyId: COMPANY, storeId: STORE });
    fake.categories = [{ id: 'cat-supp', companyId: COMPANY, name: 'مكمّلات' }];
    fake.products = [productRow(1), productRow(2)];
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(2, 'إلكترونيات')] }));
    expect(b).toEqual({ filed: 1, skipped: 1, created: [] });
    expect(categoryOf(1)).toBe('cat-supp');
    expect(categoryOf(2)).toBeNull();
    expect(fake.calls.createCategory).toHaveLength(0);
    expect(fake.categories.map((c) => c.name)).toEqual(['مكمّلات']);
  });

  it('— a company-wide grant files them all', async () => {
    fake.products = [productRow(1), productRow(2), productRow(3)];
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(2, 'مكمّلات'), item(3, 'إلكترونيات')] }));
    expect(b).toMatchObject({ filed: 3, skipped: 0 });
  });
});

describe('the body — every way it can be wrong has an Arabic sentence, in both fields, and nothing is read', () => {
  const BAD: Array<[string, unknown, string]> = [
    ['not JSON at all', '{not json', 'الطلب غير صالح'],
    ['null', 'null', 'الطلب غير صالح'],
    ['no items', {}, 'لا منتجات للتصنيف'],
    ['items that is not a list', { items: 'x' }, 'لا منتجات للتصنيف'],
    ['an empty list', { items: [] }, 'لا منتجات للتصنيف'],
    ['an item that is not an object', { items: [null] }, 'بيانات المنتج غير صالحة'],
    ['an item without a product', { items: [{ category: 'مكمّلات' }] }, 'معرّف المنتج مطلوب'],
    ['a product id that is a number', { items: [{ productId: 5, category: 'مكمّلات' }] }, 'معرّف المنتج مطلوب'],
    ['a product id too short to be one', { items: [{ productId: 'abc', category: 'مكمّلات' }] }, 'معرّف المنتج غير صالح'],
    ['a product id too long to be one', { items: [{ productId: 'x'.repeat(65), category: 'مكمّلات' }] }, 'معرّف المنتج غير صالح'],
    ['an item without a category', { items: [{ productId: P(1) }] }, 'اسم التصنيف مطلوب'],
    ['a category of one letter', { items: [{ productId: P(1), category: 'م' }] }, 'اسم التصنيف قصير جداً'],
    ['a category of spaces', { items: [{ productId: P(1), category: '     ' }] }, 'اسم التصنيف قصير جداً'],
    ['a category of sixty-one letters', { items: [{ productId: P(1), category: 'م'.repeat(61) }] }, 'اسم التصنيف طويل جداً'],
  ];

  it.each(BAD)('— %s', async (_name, body, sentence) => {
    fake.products = [productRow(1)];
    const res = await post(body);
    expect(res.status).toBe(400);
    const b = await json(res);
    expect(b.error).toBe(sentence);
    expect(b.errorAr).toBe(sentence);
    expect(/[A-Za-z]/.test(b.error), 'جملة إنجليزية في الرفض').toBe(false);
    expect(fake.calls.findProducts).toHaveLength(0);
    expect(fake.calls.createCategory).toHaveLength(0);
  });

  it('— more than 300 products in one press is refused, with the limit in the sentence', async () => {
    const items = Array.from({ length: 301 }, (_, i) => item(i + 1, 'مكمّلات'));
    const res = await post({ items });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('300');
    expect(fake.calls.findProducts).toHaveLength(0);
  });

  it('— and exactly 300 is accepted', async () => {
    const items = Array.from({ length: 300 }, (_, i) => item(i + 1, 'مكمّلات'));
    fake.products = items.map((_, i) => productRow(i + 1));
    const res = await post({ items });
    expect(res.status).toBe(200);
    expect((await json(res)).filed).toBe(300);
  });
});

describe('what it files — and what it will not touch', () => {
  it('files an unfiled product on the shelf named, and says so', async () => {
    fake.products = [productRow(1)];
    fake.categories = [{ id: 'cat-supp', companyId: COMPANY, name: 'مكمّلات' }];
    const res = await post({ items: [item(1, 'مكمّلات')] });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ filed: 1, skipped: 0, created: [] });
    expect(categoryOf(1)).toBe('cat-supp');
  });

  it('reads only THIS store’s unfiled products of THIS company, by the ids it was given', async () => {
    fake.products = [productRow(1)];
    await post({ items: [item(1, 'مكمّلات')] });
    expect(fake.calls.findProducts).toHaveLength(1);
    expect(fake.calls.findProducts[0].where).toEqual({ id: { in: [P(1)] }, categoryId: null, companyId: COMPANY, storeId: STORE });
  });

  it('NEVER moves a product that already has a category: it is skipped, untouched, and no shelf is made for it', async () => {
    fake.products = [productRow(1, { categoryId: 'cat-old' }), productRow(2)];
    fake.categories = [{ id: 'cat-old', companyId: COMPANY, name: 'قديم' }];
    const b = await json(await post({ items: [item(1, 'إلكترونيات'), item(2, 'مكمّلات')] }));
    expect(b).toMatchObject({ filed: 1, skipped: 1, created: ['مكمّلات'] });
    expect(categoryOf(1)).toBe('cat-old');
    expect(fake.categories.map((c) => c.name)).not.toContain('إلكترونيات');
  });

  it('NEVER moves a product filed in the gap between its read and its write: the write carries `categoryId: null` itself', async () => {
    fake.products = [productRow(1), productRow(2)];
    // Somebody files product 1 on the product page after this door has read it and before it writes.
    fake.between = () => {
      fake.products[0].categoryId = 'cat-by-somebody-else';
    };
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(2, 'مكمّلات')] }));
    expect(categoryOf(1)).toBe('cat-by-somebody-else');
    expect(b).toMatchObject({ filed: 1, skipped: 1 });
    for (const call of fake.calls.updateMany) expect(call.where.categoryId, 'الكتابة بلا شرط «بلا تصنيف»').toBeNull();
    // And only the one it filed is in the log.
    const filedLogs = logAudit.mock.calls.filter(([a]) => a.action === 'PRODUCT_CATEGORISED');
    expect(filedLogs.map(([a]) => a.entityId)).toEqual([P(2)]);
  });

  it('a product of another store, of another company, or one that does not exist is skipped like any other — the answer tells them apart from nothing', async () => {
    fake.products = [
      productRow(1),
      productRow(2, { storeId: 'another-store' }),
      productRow(3, { companyId: 'another-company' }),
    ];
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(2, 'مكمّلات'), item(3, 'مكمّلات'), item(4, 'مكمّلات')] }));
    expect(b).toMatchObject({ filed: 1, skipped: 3 });
    expect(Object.keys(b).sort()).toEqual(['created', 'filed', 'skipped']);
    expect(categoryOf(2)).toBeNull();
    expect(categoryOf(3)).toBeNull();
  });

  it('a product named twice is filed once, on the first shelf named', async () => {
    fake.products = [productRow(1)];
    const b = await json(await post({ items: [item(1, 'مكمّلات'), item(1, 'إلكترونيات')] }));
    expect(b).toEqual({ filed: 1, skipped: 0, created: ['مكمّلات'] });
    expect(fake.categories.map((c) => c.name)).toEqual(['مكمّلات']);
  });

  it('takes the company from the session, never from the body', async () => {
    fake.products = [productRow(1)];
    await post({ companyId: 'another-company', storeId: 'another-store', items: [item(1, 'مكمّلات')] });
    expect(fake.calls.findProducts[0].where.companyId).toBe(COMPANY);
    expect(fake.calls.findProducts[0].where.storeId).toBe(STORE);
    expect(fake.calls.findCategories[0].where).toEqual({ companyId: COMPANY });
    expect(fake.calls.createCategory[0].data.companyId).toBe(COMPANY);
    expect(fake.calls.updateMany[0].where.companyId).toBe(COMPANY);
  });
});

describe('the shelves', () => {
  it('uses a shelf that exists, as written, and makes none', async () => {
    fake.products = [productRow(1)];
    fake.categories = [{ id: 'cat-skin', companyId: COMPANY, name: 'العناية بالبشرة' }];
    const b = await json(await post({ items: [item(1, 'العناية بالبشرة')] }));
    expect(b.created).toEqual([]);
    expect(fake.calls.createCategory).toHaveLength(0);
    expect(categoryOf(1)).toBe('cat-skin');
  });

  it('matches an existing shelf by its folded spelling — «مكملات» is «مكمّلات» — so a spelling never doubles a shelf', async () => {
    fake.products = [productRow(1), productRow(2)];
    fake.categories = [{ id: 'cat-supp', companyId: COMPANY, name: 'مكمّلات' }];
    const b = await json(await post({ items: [item(1, 'مكملات'), item(2, 'العنايه  بالبشره')] }));
    expect(categoryOf(1)).toBe('cat-supp');
    expect(b.created).toEqual(['العنايه  بالبشره']);
    expect(fake.categories).toHaveLength(2);
  });

  it('an exact name wins over a folded match', async () => {
    fake.products = [productRow(1)];
    fake.categories = [
      { id: 'cat-folded', companyId: COMPANY, name: 'مكمّلات' },
      { id: 'cat-exact', companyId: COMPANY, name: 'مكملات' },
    ];
    await post({ items: [item(1, 'مكملات')] });
    expect(categoryOf(1)).toBe('cat-exact');
  });

  it('when two existing shelves are the same shelf by spelling, a third spelling goes to the first of them — the same one every time', async () => {
    fake.products = [productRow(1)];
    fake.categories = [
      { id: 'cat-first', companyId: COMPANY, name: 'مكمّلات' },
      { id: 'cat-second', companyId: COMPANY, name: 'مكملات' },
    ];
    await post({ items: [item(1, 'مُكمَّلات')] });
    expect(categoryOf(1)).toBe('cat-first');
    expect(fake.calls.createCategory).toHaveLength(0);
  });

  it('makes a missing shelf ONCE for however many products name it, and says which it made', async () => {
    fake.products = [productRow(1), productRow(2), productRow(3)];
    const b = await json(await post({ items: [item(1, 'إلكترونيات'), item(2, 'إلكترونيات'), item(3, 'إلكترونيات')] }));
    expect(b).toEqual({ filed: 3, skipped: 0, created: ['إلكترونيات'] });
    expect(fake.calls.createCategory).toHaveLength(1);
    expect(fake.categories).toHaveLength(1);
    const ids = new Set([categoryOf(1), categoryOf(2), categoryOf(3)]);
    expect(ids.size).toBe(1);
  });

  it('and a shelf it has just made is found again under another spelling in the same request — one shelf, not two', async () => {
    fake.products = [productRow(1), productRow(2)];
    const b = await json(await post({ items: [item(1, 'إلكترونيات'), item(2, 'الكترونيات')] }));
    expect(b).toEqual({ filed: 2, skipped: 0, created: ['إلكترونيات'] });
    expect(fake.categories).toHaveLength(1);
    expect(categoryOf(1)).toBe(categoryOf(2));
  });

  it('makes two shelves for two names', async () => {
    fake.products = [productRow(1), productRow(2)];
    const b = await json(await post({ items: [item(1, 'إلكترونيات'), item(2, 'أجهزة منزلية')] }));
    expect(b.created).toEqual(['إلكترونيات', 'أجهزة منزلية']);
    expect(categoryOf(1)).not.toBe(categoryOf(2));
  });

  it('trims the name it makes the shelf with', async () => {
    fake.products = [productRow(1)];
    await post({ items: [item(1, '   إلكترونيات   ')] });
    expect(fake.categories.map((c) => c.name)).toEqual(['إلكترونيات']);
  });

  it('makes NO shelf when no product is about to go onto it: all filed already, all foreign, or all out of reach', async () => {
    fake.products = [productRow(1, { categoryId: 'cat-old' }), productRow(2, { storeId: 'another-store' })];
    const b = await json(await post({ items: [item(1, 'إلكترونيات'), item(2, 'إلكترونيات'), item(3, 'إلكترونيات')] }));
    expect(b).toEqual({ filed: 0, skipped: 3, created: [] });
    expect(fake.calls.createCategory).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('what it writes down', () => {
  it('logs a product filed, from no category to this one, by whom — and a shelf made, with the same action the categories door uses', async () => {
    fake.products = [productRow(1), productRow(2)];
    fake.categories = [{ id: 'cat-skin', companyId: COMPANY, name: 'العناية بالبشرة' }];
    await post({ items: [item(1, 'العناية بالبشرة'), item(2, 'إلكترونيات')] });

    const calls = logAudit.mock.calls.map(([a]) => a);
    const filed = calls.filter((a) => a.action === 'PRODUCT_CATEGORISED');
    expect(filed).toHaveLength(2);
    expect(filed[0]).toMatchObject({
      companyId: COMPANY, userId: 'u1', entity: 'Product', entityId: P(1),
      previousData: { categoryId: null }, newData: { categoryId: 'cat-skin', category: 'العناية بالبشرة' },
    });
    expect(filed[1]).toMatchObject({ entityId: P(2), previousData: { categoryId: null }, newData: { category: 'إلكترونيات' } });

    const made = calls.filter((a) => a.action === 'CATEGORY_CREATED');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ companyId: COMPANY, userId: 'u1', entity: 'Category', newData: { name: 'إلكترونيات' } });
    expect(calls).toHaveLength(3);
  });

  it('logs nothing for a product it skipped', async () => {
    fake.products = [productRow(1, { categoryId: 'cat-old' })];
    await post({ items: [item(1, 'إلكترونيات')] });
    expect(logAudit).not.toHaveBeenCalled();
  });
});
