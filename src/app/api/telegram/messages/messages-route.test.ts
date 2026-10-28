import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE «طلبات تلجرام» LIST AND THE «تجاهل» DOOR, AS PRISMA IS ASKED.
 *
 * The tab counts used to be counted over the whole company while the list read one store, and the tile «تم الإنشاء»
 * read a key that nothing wrote. Here the counts and the list are asked under ONE `where`, and a tab's total IS its
 * count — measured on the arguments handed to Prisma, not on the text of the route.
 */

const { db, ctx } = vi.hoisted(() => ({
  db: {
    telegramMessage: { groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  },
  ctx: { storeId: 'store-A' as string | null, manage: true },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: vi.fn(async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: ctx.storeId })),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => undefined), can: () => ctx.manage }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { GET } from './route';
import { POST as IGNORE } from './[id]/ignore/route';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { logAudit } from '@/lib/audit';

const SAMPLE = [
  'رقم الطلب: 26842',
  'تاريخ الطلب: 2026-10-28 17:45:32',
  'إسم العميل: محمد عيد أطليبي',
  'رقم الهاتف: 0933620102',
  'عنوان العميل: دمشق سوريا',
  'إسم المنتج: ماء الكمأ الأصلي',
  'إسم العرض: قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
  'السعر: 25',
  'الكمية: 1',
].join('\n');
const GROUPED = [
  { processingStatus: 'NEEDS_REVIEW', _count: { _all: 3 } },
  { processingStatus: 'FAILED', _count: { _all: 1 } },
  { processingStatus: 'PENDING', _count: { _all: 2 } },
  { processingStatus: 'PROCESSED', _count: { _all: 7 } },
  { processingStatus: 'IGNORED', _count: { _all: 4 } },
];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  chatId: '-100',
  threadId: null,
  threadName: null,
  senderName: 'أبو أحمد',
  text: SAMPLE,
  processingStatus: 'NEEDS_REVIEW',
  reviewReason: 'PRODUCT_NOT_FOUND',
  pageName: null,
  createdAt: new Date('2026-10-28T12:40:05Z'),
  source: { chatTitle: 'طلبات الصفحة', topicName: null, storeId: 'store-A', store: { country: { code: 'SY' } } },
  order: null,
  ...over,
});

const get = async (qs = '') => {
  const res = await GET(new Request(`http://localhost/api/telegram/messages${qs}`));
  expect(res.status).toBe(200);
  return res.json();
};
const listArgs = () => db.telegramMessage.findMany.mock.calls[0][0];
const groupArgs = () => db.telegramMessage.groupBy.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  ctx.storeId = 'store-A';
  ctx.manage = true;
  db.telegramMessage.groupBy.mockResolvedValue(GROUPED);
  db.telegramMessage.findMany.mockResolvedValue([]);
});

describe('the tabs count what the list holds', () => {
  it('— grouped under the same store scope and search as the list; the tab is the only difference', async () => {
    await get('?tab=review&q=محمد');
    const { processingStatus, ...rest } = listArgs().where;
    expect(processingStatus).toEqual({ in: ['NEEDS_REVIEW', 'FAILED', 'PENDING'] });
    expect(rest).toEqual(groupArgs().where);
    expect(groupArgs().where.AND[0]).toEqual(telegramStoreWhere('store-A', true));
    expect(groupArgs().by).toEqual(['processingStatus']);
  });

  it.each([
    ['?tab=review', 6],
    ['?tab=orders', 7],
    ['?tab=ignored', 4],
    ['', 17],
    ['?tab=anything', 17],
  ])('%s → a total of %s, which is that tab’s own count', async (qs, total) => {
    const body = await get(qs);
    expect(body.facts).toEqual({ review: 6, orders: 7, ignored: 4, all: 17 });
    expect(body.pagination.total).toBe(total);
  });

  it('a person with no store reads nothing, counts included', async () => {
    ctx.storeId = null;
    ctx.manage = false;
    await get();
    expect(groupArgs().where.AND[0]).toEqual({ id: { in: [] } });
    expect(listArgs().where.AND[0]).toEqual({ id: { in: [] } });
  });
});

describe('pages of 25', () => {
  it('page 2 of 30 skips the first 25', async () => {
    db.telegramMessage.groupBy.mockResolvedValue([{ processingStatus: 'NEEDS_REVIEW', _count: { _all: 30 } }]);
    const body = await get('?tab=review&page=2&limit=25');
    expect(listArgs()).toMatchObject({ skip: 25, take: 25 });
    expect(body.pagination).toEqual({ total: 30, page: 2, limit: 25, totalPages: 2 });
  });

  it('a page past the end is answered with the last page, and says so', async () => {
    db.telegramMessage.groupBy.mockResolvedValue([{ processingStatus: 'NEEDS_REVIEW', _count: { _all: 30 } }]);
    const body = await get('?tab=review&page=9&limit=25');
    expect(body.pagination.page).toBe(2);
    expect(listArgs().skip).toBe(25);
  });
});

describe('the search', () => {
  it('reads the stored text in both digit scripts, and the order number', async () => {
    await get('?q=0932');
    const or = groupArgs().where.AND[1].OR;
    const contains = or.filter((c: { text?: unknown }) => c.text).map((c: { text: { contains: string } }) => c.text.contains);
    expect(contains).toContain('0932');
    expect(contains).toContain(String.fromCharCode(0x0660, 0x0669, 0x0663, 0x0662));
    expect(or).toContainEqual({ order: { orderNumber: { contains: '0932', mode: 'insensitive' } } });
  });

  it('and an empty search asks nothing extra', async () => {
    await get('?q=%20%20');
    expect(groupArgs().where.AND).toHaveLength(1);
  });
});

describe('each message carries its columns, read from its own text', () => {
  it('his format: the fields as written, with no order number — and the source’s store does not leave the server', async () => {
    db.telegramMessage.findMany.mockResolvedValue([row()]);
    const [m] = (await get()).messages;
    expect(m.reading).toEqual({
      claimed: true,
      orderedAt: '2026-10-28 17:45:32',
      customer: 'محمد عيد أطليبي',
      phone: '0933620102',
      address: 'دمشق سوريا',
      product: 'ماء الكمأ الأصلي',
      offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
      price: '25',
      quantity: '1',
    });
    expect(m.reading).not.toHaveProperty('orderNumber');
    expect(m.source).toEqual({ chatTitle: 'طلبات الصفحة', topicName: null });
    expect(m.twin).toBeNull();
  });

  it('a message that is not in the format has no columns', async () => {
    db.telegramMessage.findMany.mockResolvedValue([row({ text: 'السلام عليكم', processingStatus: 'IGNORED', reviewReason: 'NOT_IN_FORMAT' })]);
    const [m] = (await get('?tab=ignored')).messages;
    expect(m.reading).toEqual({ claimed: false });
    expect(m.reviewReason).toBe('NOT_IN_FORMAT');
  });

  it('a duplicate names the order its twin already made', async () => {
    db.telegramMessage.findMany
      .mockResolvedValueOnce([row({ reviewReason: 'DUPLICATE_ORDER' })])
      .mockResolvedValueOnce([{ text: SAMPLE, order: { id: 'o1', orderNumber: 'SY-2026-0001', productId: 'prod-kamaa' } }]);
    const [m] = (await get()).messages;
    expect(m.twin).toEqual({ id: 'o1', orderNumber: 'SY-2026-0001' });
    // Asked of THIS store's processed messages, and never of itself.
    expect(db.telegramMessage.findMany.mock.calls[1][0].where).toMatchObject({
      id: { not: 'm1' },
      processingStatus: 'PROCESSED',
      source: { storeId: 'store-A' },
    });
  });

  it('and a row held for any other reason asks nothing more', async () => {
    db.telegramMessage.findMany.mockResolvedValue([row({ reviewReason: 'INVALID_PHONE' })]);
    await get();
    expect(db.telegramMessage.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('«تجاهل»', () => {
  const ignore = (id = 'm1') => IGNORE(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id }) });

  it('writes IGNORED and its time — nothing else, and only while no order is linked', async () => {
    db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', processingStatus: 'NEEDS_REVIEW', orderId: null });
    db.telegramMessage.updateMany.mockResolvedValue({ count: 1 });
    const res = await ignore();
    expect(res.status).toBe(200);
    const { where, data } = db.telegramMessage.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 'm1', companyId: 'c1', orderId: null, processingStatus: { in: ['NEEDS_REVIEW', 'FAILED', 'PENDING'] } });
    expect(Object.keys(data).sort()).toEqual(['processedAt', 'processingStatus']);
    expect(data.processingStatus).toBe('IGNORED');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TELEGRAM_MESSAGE_IGNORED', entityId: 'm1' }));
  });

  it('is asked within the store, as the retry door asks', async () => {
    db.telegramMessage.findFirst.mockResolvedValue(null);
    const res = await ignore();
    expect(res.status).toBe(404);
    expect(db.telegramMessage.findFirst.mock.calls[0][0].where).toEqual({ id: 'm1', companyId: 'c1', ...telegramStoreWhere('store-A', true) });
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a message that became an order, and writes nothing', async () => {
    db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', processingStatus: 'PROCESSED', orderId: 'o1' });
    const res = await ignore();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/[؀-ۿ]/);
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
  });

  it('and when the message moved between the read and the write, says so instead of pretending', async () => {
    db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', processingStatus: 'PENDING', orderId: null });
    db.telegramMessage.updateMany.mockResolvedValue({ count: 0 });
    expect((await ignore()).status).toBe(409);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an IGNORED message is already where it was sent', async () => {
    db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', processingStatus: 'IGNORED', orderId: null });
    expect((await ignore()).status).toBe(200);
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
  });
});
