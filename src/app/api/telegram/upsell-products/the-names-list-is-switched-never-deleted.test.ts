import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أسماء المنتجات (الأب سيل والأسماء القديمة)» — THE DOORS, AS PRISMA IS ASKED (10/11).
 *
 *   · reading needs telegram.view, writing telegram.manage (403 otherwise, and nothing is asked of the database);
 *   · every query carries the company AND the selected store: another store's row is 404, another store's product is refused;
 *   · the match key is computed on the server, and a name taken in the store is 409;
 *   · there is no DELETE — a name is switched off — and every write is audited;
 *   · «أضف الأسماء الجاهزة» adds what it can match, skips what exists and names what it could not;
 *   · «دمج الأب سيل»: the preview is planned and «نعم» without `confirm: true` is 400.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake row
type Row = Record<string, any>;

const { db, ctx, plan } = vi.hoisted(() => ({
  db: {
    store: { findFirst: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn() },
    telegramUpsellProduct: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  } as Row,
  ctx: { denied: '' as string },
  plan: { planWaitingMessages: vi.fn(), applyWaitingMessages: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: vi.fn(async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 'store-A' })) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(async (key: string) => {
    if (ctx.denied === key) throw new Error(`Forbidden: missing required permission ${key}`);
  }),
  can: () => true,
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/telegram/upsell-plan', () => plan);

import { GET, POST } from './route';
import * as one from './[id]/route';
import { POST as SEED } from './seed/route';
import { POST as MERGE } from '../upsell-merge/route';
import { logAudit } from '@/lib/audit';

const USD = { id: 'store-A', country: { currencyCode: 'USD', minorUnit: 2 } };
const json = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const UPSELL = { kind: 'UPSELL', incomingName: 'كورس طنين: عبوتين إضافيات 🎁', productId: 'prod-tinnitus', extraUnits: 2, linePrice: 20 };
const stored = (over: Row = {}) => ({
  id: 'al1',
  kind: 'UPSELL',
  incomingName: UPSELL.incomingName,
  foldedName: 'كورس طنين عبوتين اضافيات',
  productId: 'prod-tinnitus',
  extraUnits: 2,
  linePrice: '20.000',
  offerAliases: null,
  isActive: true,
  product: { name: 'قطرة طنين الأذن' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  ctx.denied = '';
  db.store.findFirst.mockResolvedValue(USD);
  db.product.findFirst.mockResolvedValue({ id: 'prod-tinnitus', name: 'قطرة طنين الأذن' });
  db.product.findMany.mockResolvedValue([]);
  db.telegramUpsellProduct.findMany.mockResolvedValue([]);
  db.telegramUpsellProduct.findFirst.mockResolvedValue(null);
  db.telegramUpsellProduct.create.mockImplementation(async ({ data }: Row) => ({ ...stored(), ...data, id: 'al-new' }));
  db.telegramUpsellProduct.updateMany.mockResolvedValue({ count: 1 });
});

describe('the keys', () => {
  it('reading needs telegram.view, and is store-scoped', async () => {
    db.telegramUpsellProduct.findMany.mockResolvedValue([stored()]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({ kind: 'UPSELL', linePrice: 20, productName: 'قطرة طنين الأذن' });
    expect(db.telegramUpsellProduct.findMany.mock.calls[0][0].where).toEqual({ companyId: 'c1', storeId: 'store-A' });
    ctx.denied = 'telegram.view';
    expect((await GET()).status).toBe(403);
  });

  it.each([
    ['POST', () => POST(json(UPSELL))],
    ['PATCH', () => one.PATCH(json({ isActive: false }), params('al1'))],
    ['seed', () => SEED()],
    ['merge', () => MERGE(json({ mode: 'preview' }))],
  ])('%s without telegram.manage is 403 and writes nothing', async (_what, call) => {
    ctx.denied = 'telegram.manage';
    expect((await call()).status).toBe(403);
    expect(db.telegramUpsellProduct.create).not.toHaveBeenCalled();
    expect(db.telegramUpsellProduct.updateMany).not.toHaveBeenCalled();
    expect(plan.planWaitingMessages).not.toHaveBeenCalled();
  });

  it('there is no DELETE door at all', () => {
    expect((one as Row).DELETE).toBeUndefined();
  });
});

describe('making a name', () => {
  it('computes the key itself, checks the product in THIS store, and audits', async () => {
    const res = await POST(json({ ...UPSELL, foldedName: 'something else' }));
    expect(res.status).toBe(201);
    const data = db.telegramUpsellProduct.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ companyId: 'c1', storeId: 'store-A', kind: 'UPSELL', foldedName: 'كورس طنين عبوتين اضافيات', extraUnits: 2, linePrice: 20 });
    expect(db.product.findFirst.mock.calls[0][0].where).toEqual({ id: 'prod-tinnitus', companyId: 'c1', storeId: 'store-A', status: 'ACTIVE' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TELEGRAM_ALIAS_CREATED' }));
  });

  it.each([
    ['an upsell without its units', { ...UPSELL, extraUnits: null }],
    ['an upsell without its price', { ...UPSELL, linePrice: undefined }],
    ['a price with a cent too many', { ...UPSELL, linePrice: 20.005 }],
    ['a price of 0', { ...UPSELL, linePrice: 0 }],
    ['51 units', { ...UPSELL, extraUnits: 51 }],
    ['a name with no letter', { ...UPSELL, incomingName: '🎁 ✨' }],
    ['an unknown kind', { ...UPSELL, kind: 'OTHER' }],
    ['an old offer of quantity 0', { kind: 'RENAMED', incomingName: 'اسم قديم', productId: 'prod-tinnitus', offerAliases: [{ name: 'عرض', quantity: 0, price: 20 }] }],
  ])('refuses %s with 400, in Arabic, and writes nothing', async (_what, body) => {
    const res = await POST(json(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/[؀-ۿ]/);
    expect(db.telegramUpsellProduct.create).not.toHaveBeenCalled();
  });

  it('a product of another store (or not active) is refused', async () => {
    db.product.findFirst.mockResolvedValue(null);
    expect((await POST(json(UPSELL))).status).toBe(400);
    expect(db.telegramUpsellProduct.create).not.toHaveBeenCalled();
  });

  it('a name the store already has is 409', async () => {
    db.telegramUpsellProduct.findFirst.mockResolvedValue({ id: 'al1' });
    expect((await POST(json(UPSELL))).status).toBe(409);
  });

  it('an old name keeps its old offers, folded, and no units or price', async () => {
    const res = await POST(
      json({ kind: 'RENAMED', incomingName: 'قطرة  طنين الأذن', productId: 'prod-tinnitus', extraUnits: 3, linePrice: 9, offerAliases: [{ name: 'عبوة عدد 1 = 20 دولار', quantity: 1, price: 20 }] })
    );
    expect(res.status).toBe(201);
    expect(db.telegramUpsellProduct.create.mock.calls[0][0].data).toMatchObject({
      kind: 'RENAMED',
      foldedName: 'قطره طنين الاذن',
      extraUnits: null,
      linePrice: null,
      offerAliases: [{ name: 'عبوة عدد 1 = 20 دولار', foldedName: 'عبوه عدد 1 20 دولار', quantity: 1, price: 20 }],
    });
  });
});

describe('changing a name', () => {
  it('switches it off — never deletes — scoped to the company and the store, audited as disabled', async () => {
    db.telegramUpsellProduct.findFirst.mockResolvedValue(stored());
    const res = await one.PATCH(json({ isActive: false }), params('al1'));
    expect(res.status).toBe(200);
    expect(db.telegramUpsellProduct.updateMany).toHaveBeenCalledWith({ where: { id: 'al1', companyId: 'c1', storeId: 'store-A' }, data: { isActive: false } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TELEGRAM_ALIAS_DISABLED' }));
  });

  it('another store’s (or company’s) row is 404', async () => {
    db.telegramUpsellProduct.findFirst.mockResolvedValue(null);
    expect((await one.PATCH(json({ isActive: false }), params('al-other'))).status).toBe(404);
    expect(db.telegramUpsellProduct.findFirst.mock.calls[0][0].where).toEqual({ id: 'al-other', companyId: 'c1', storeId: 'store-A' });
    expect(db.telegramUpsellProduct.updateMany).not.toHaveBeenCalled();
  });

  it('a whole edit is validated like a new one, and a key another row holds is 409', async () => {
    db.telegramUpsellProduct.findFirst.mockResolvedValueOnce(stored()).mockResolvedValueOnce({ id: 'al2' });
    expect((await one.PATCH(json({ ...UPSELL, incomingName: 'كورس حرير: عبوتين إضافيات 🎁' }), params('al1'))).status).toBe(409);
    db.telegramUpsellProduct.findFirst.mockResolvedValue(stored());
    expect((await one.PATCH(json({ ...UPSELL, extraUnits: 0 }), params('al1'))).status).toBe(400);
    expect(db.telegramUpsellProduct.updateMany).not.toHaveBeenCalled();
  });
});

describe('«أضف الأسماء الجاهزة»', () => {
  it('adds what it matches by exact name, skips what exists, and names what it could not match', async () => {
    db.product.findMany.mockResolvedValue([
      { id: 'prod-tinnitus', name: 'قطرة طنين الأذن' },
      { id: 'prod-silk', name: 'كريم حرير' },
      { id: 'prod-kamaa', name: 'ماء الكمأ' },
    ]);
    db.telegramUpsellProduct.findMany.mockResolvedValue([{ foldedName: 'كورس حرير عبوتين اضافيات' }]);
    const body = await (await SEED()).json();
    expect(body.existing).toEqual(['كورس حرير: عبوتين إضافيات 🎁']);
    expect(body.created).toEqual(['كورس طنين: عبوتين إضافيات 🎁', '✨ بديل الليزر... الآن بين يديك! ✨', 'ماء الكمأ الأصلي', 'قطرة  طنين الأذن']);
    expect(body.missing.map((m: Row) => m.incomingName)).toEqual(['كورس ندبات: عبوتين إضافيات 🎁', 'ALBETCHU لإخفاء مظهر الندبات']);
    const silk = db.telegramUpsellProduct.create.mock.calls.map((c: Row[]) => c[0].data).find((d: Row) => d.kind === 'RENAMED' && d.productId === 'prod-silk');
    expect(silk.offerAliases.map((o: Row) => [o.quantity, o.price])).toEqual([[1, 20], [2, 35], [3, 45]]);
    expect(logAudit).toHaveBeenCalledTimes(4);
  });

  it('a store that does not sell in dollars gets nothing', async () => {
    db.store.findFirst.mockResolvedValue({ id: 'store-A', country: { currencyCode: 'JOD', minorUnit: 3 } });
    const body = await (await SEED()).json();
    expect(body.created).toEqual([]);
    expect(db.telegramUpsellProduct.create).not.toHaveBeenCalled();
  });
});

describe('«دمج الأب سيل — تجربة» and «نعم»', () => {
  it('the preview plans and writes nothing', async () => {
    plan.planWaitingMessages.mockResolvedValue([{ key: 'msg:m1' }]);
    const res = await MERGE(json({ mode: 'preview' }));
    expect(await res.json()).toEqual({ rows: [{ key: 'msg:m1' }] });
    expect(plan.applyWaitingMessages).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'apply' }, { mode: 'apply', confirm: 'yes' }, { mode: 'apply', confirm: 1 }])('apply without confirm: true is 400 (%o)', async (body) => {
    expect((await MERGE(json(body))).status).toBe(400);
    expect(plan.applyWaitingMessages).not.toHaveBeenCalled();
  });

  it('apply with confirm re-plans on the server for the store scope, with the keys asked, and audits once', async () => {
    plan.applyWaitingMessages.mockResolvedValue([{ key: 'msg:m1', status: 'PROCESSED' }]);
    const res = await MERGE(json({ mode: 'apply', confirm: true, keys: ['msg:m1', 7] }));
    expect(res.status).toBe(200);
    expect(plan.applyWaitingMessages).toHaveBeenCalledWith('c1', { OR: [{ source: { storeId: 'store-A' } }, { sourceId: null }, { source: { storeId: null } }] }, ['msg:m1']);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TELEGRAM_UPSELL_MERGED' }));
  });
});
