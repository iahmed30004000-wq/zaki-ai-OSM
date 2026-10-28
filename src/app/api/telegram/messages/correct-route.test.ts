import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تعديل وترحيل» — THE DOOR, AS PRISMA AND THE MESSAGE DOOR ARE ASKED.
 *
 * What it owes: a person with `telegram.manage` only; a message of this store's sources only; nothing for a message that
 * is already an order; every field needs a value (named when it has none); what is stored is the eight fields written
 * back in the nine-label format, one line each and without the order number; the write itself refuses a message that
 * became an order a moment ago; the old and new values go to the audit with the address redacted; and the answer is the
 * message door's own — the correction is read by the door that reads every message, never around it.
 */

const { db, ctx, door } = vi.hoisted(() => ({
  db: { telegramMessage: { findFirst: vi.fn(), updateMany: vi.fn() } },
  ctx: { storeId: 'store-A' as string | null, denied: false },
  door: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: vi.fn(async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: ctx.storeId })),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: vi.fn(async () => {
    if (ctx.denied) throw new Error('FORBIDDEN');
  }),
}));
vi.mock('@/lib/audit', async () => {
  const real = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit');
  return { ...real, logAudit: vi.fn() };
});
vi.mock('@/lib/telegram/inbound', () => ({ processStoredMessage: door }));

import { POST } from './[id]/correct/route';
import { readLabeledOrder } from '@/lib/telegram/labeled-order';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { logAudit } from '@/lib/audit';

const FIELDS = {
  orderedAt: '2026-10-28 17:45:32',
  customer: 'محمد عيد أطليبي',
  phone: '+96398101968',
  address: 'سوريا',
  product: 'ماء الكمأ الأصلي',
  offer: 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني',
  price: '25',
  quantity: '1',
};

const ORIGINAL = ['تاريخ الطلب: 2026-10-28 17:45:32', 'إسم العميل: محمد', 'رقم الهاتف: 12', 'عنوان العميل: دمشق', 'إسم المنتج: ماء', 'إسم العرض: قطعة', 'السعر: 25', 'الكمية: 1'].join('\n');

const call = (body: unknown, id = 'm1') =>
  POST(new Request('http://x/api/telegram/messages/m1/correct', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  ctx.storeId = 'store-A';
  ctx.denied = false;
  db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', text: ORIGINAL, processingStatus: 'NEEDS_REVIEW', orderId: null });
  db.telegramMessage.updateMany.mockResolvedValue({ count: 1 });
  door.mockResolvedValue({ status: 'PROCESSED', orderId: 'o1' });
});

describe('who and which message', () => {
  it('asks permission first — without it nothing is read or written', async () => {
    ctx.denied = true;
    const res = await call(FIELDS);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.telegramMessage.findFirst).not.toHaveBeenCalled();
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
  });

  it('reads the message under the same store scope as every other door', async () => {
    await call(FIELDS);
    expect(db.telegramMessage.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'm1', companyId: 'c1', ...telegramStoreWhere('store-A', true) });
  });

  it('a message that is not this store’s is 404, and nothing is written', async () => {
    db.telegramMessage.findFirst.mockResolvedValue(null);
    expect((await call(FIELDS)).status).toBe(404);
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['already PROCESSED', { processingStatus: 'PROCESSED', orderId: 'o9' }],
    ['linked to an order', { processingStatus: 'NEEDS_REVIEW', orderId: 'o9' }],
  ])('a message %s is 409, and nothing is written', async (_what, over) => {
    db.telegramMessage.findFirst.mockResolvedValue({ id: 'm1', text: ORIGINAL, ...over });
    expect((await call(FIELDS)).status).toBe(409);
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
    expect(door).not.toHaveBeenCalled();
  });

  it('the write itself refuses a message that became an order between the read and the write', async () => {
    db.telegramMessage.updateMany.mockResolvedValue({ count: 0 });
    expect((await call(FIELDS)).status).toBe(409);
    expect(db.telegramMessage.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'm1', companyId: 'c1', orderId: null });
    expect(door).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('the eight fields', () => {
  it.each(Object.keys(FIELDS))('a blank «%s» is refused with its name, before anything is written', async (field) => {
    const res = await call({ ...FIELDS, [field]: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe(field);
    expect(db.telegramMessage.updateMany).not.toHaveBeenCalled();
    expect(door).not.toHaveBeenCalled();
  });

  it('a missing field is a bad request, not a crash', async () => {
    const { price: _price, ...rest } = FIELDS;
    expect((await call(rest)).status).toBe(400);
    expect((await call(null)).status).toBe(400);
  });

  it('is stored as a message in his format: one line per label, the order number absent', async () => {
    await call(FIELDS);
    const text: string = db.telegramMessage.updateMany.mock.calls[0][0].data.text;
    expect(text.split('\n')).toHaveLength(8);
    expect(text).not.toContain('رقم الطلب');
    expect(text).toContain('رقم الهاتف: +96398101968');
    expect(text).toContain('عنوان العميل: سوريا');
  });

  it('what is stored is read back as exactly those fields by the door’s own reader', async () => {
    await call({ ...FIELDS, address: 'الرقة\nالكرمة', customer: '  محمد   عيد  ' });
    const text: string = db.telegramMessage.updateMany.mock.calls[0][0].data.text;
    const read = readLabeledOrder(text);
    expect(read).toMatchObject({ claimed: true, ok: true, fields: { ...FIELDS, address: 'الرقة الكرمة', customer: 'محمد عيد' } });
  });

  it('a value that reads like a label cannot split the message', async () => {
    await call({ ...FIELDS, address: 'السعر: 9999\nالكمية: 50' });
    const read = readLabeledOrder(db.telegramMessage.updateMany.mock.calls[0][0].data.text);
    expect(read).toMatchObject({ claimed: true, ok: true, fields: { price: '25', quantity: '1', address: 'السعر: 9999 الكمية: 50' } });
  });
});

describe('the answer', () => {
  it('is the message door’s: an order', async () => {
    const res = await call(FIELDS);
    expect(await res.json()).toEqual({ success: true, status: 'PROCESSED', orderId: 'o1' });
    expect(door).toHaveBeenCalledWith('m1');
  });

  it('and when the corrected message still waits, its NEW reason', async () => {
    door.mockResolvedValue({ status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:25.00' });
    expect(await (await call(FIELDS)).json()).toEqual({ success: false, status: 'NEEDS_REVIEW', reason: 'PRICE_MISMATCH:25.00' });
  });

  it('the text is stored BEFORE the door reads it, so the door reads the correction', async () => {
    const order: string[] = [];
    db.telegramMessage.updateMany.mockImplementation(async () => {
      order.push('write');
      return { count: 1 };
    });
    door.mockImplementation(async () => {
      order.push('door');
      return { status: 'PROCESSED', orderId: 'o1' };
    });
    await call(FIELDS);
    expect(order).toEqual(['write', 'door']);
  });
});

describe('the audit trail', () => {
  it('keeps what it was and what it became, the address redacted', async () => {
    await call(FIELDS);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAudit).mock.calls[0][0];
    expect(entry).toMatchObject({ companyId: 'c1', userId: 'u1', action: 'TELEGRAM_MESSAGE_CORRECTED', entity: 'TelegramMessage', entityId: 'm1' });
    expect(entry.previousData).toMatchObject({ phone: '12', address: '[REDACTED]' });
    expect(entry.newData).toMatchObject({ phone: '+96398101968', address: '[REDACTED]' });
  });
});
