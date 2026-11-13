import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «استلام الكل» ASKS THE OWNER'S KEY BEFORE IT READS A PARCEL — AND THEN ASKS THE LIST'S OWN QUESTION.
 *
 *   «بدي زر استلام الكل مع صلاحية للمالك» (11/11)
 *
 * `POST /api/ops/returns/receive-all`. The order of its gates: the context, the returns key, THIS door's key
 * (`ops.returns_receive_all`, granted to nobody — the owner's full access holds it), the body, the view. Each refusal is
 * NEGATIVE-marked and proves nothing was read or written. Past the gates, the set it walks is the LIST'S set: the `where`
 * the GET asks with the same filters is the oracle, and this door's `where` must be that, plus the cursor and nothing else.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, held, requireContext, logAudit } = vi.hoisted(() => ({
  db: {
    order: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
      update: vi.fn(),
      count: vi.fn(async (..._a: unknown[]) => 0),
      groupBy: vi.fn(async () => []),
    },
    deliveryProvider: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    returnReceipt: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  held: { keys: new Set<string>() },
  requireContext: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => held.keys.has(k),
  requirePermission: async (k: string) => {
    if (!held.keys.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return {};
  },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({ reverseForOrder: vi.fn() }));

import { POST } from '@/app/api/ops/returns/receive-all/route';
import { GET } from '@/app/api/ops/returns/route';

const OWNER = ['ops.returns', 'ops.returns_receive_all', 'customers.view'];
const COURIER = '11111111-1111-4111-8111-111111111111';
const CURSOR = '55555555-5555-4555-8555-555555555555';

const send = async (body: unknown) => {
  const res = await POST(new Request('http://x/api/ops/returns/receive-all', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const nothingWasTouched = () => {
  expect(db.order.findMany, 'قرأ الباب طرود بعد الرفض').not.toHaveBeenCalled();
  expect(db.order.findFirst).not.toHaveBeenCalled();
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.returnReceipt.create).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  held.keys = new Set();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 3 },
  });
});

describe('the gates, before anything is read', () => {
  it('NEGATIVE: no key at all → 403, and nothing is read or written', async () => {
    const r = await send({ countedAndInspected: true });
    expect(r.status).toBe(403);
    nothingWasTouched();
  });

  it('NEGATIVE: the returns key alone → 403 with an Arabic sentence, and nothing is read or written', async () => {
    held.keys = new Set(['ops.returns']);
    const r = await send({ countedAndInspected: true });
    expect(r.status).toBe(403);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    nothingWasTouched();
  });

  it('NEGATIVE: the door\'s key WITHOUT the returns key → 403 (it sits behind the desk\'s own key)', async () => {
    held.keys = new Set(['ops.returns_receive_all']);
    expect((await send({ countedAndInspected: true })).status).toBe(403);
    nothingWasTouched();
  });

  it('NEGATIVE: the owner without the tick → 400 in Arabic, nothing read', async () => {
    held.keys = new Set(OWNER);
    const r = await send({});
    expect(r.status).toBe(400);
    expect(r.body.errorAr ?? r.body.error).toMatch(/[؀-ۿ]/);
    nothingWasTouched();
  });

  it('NEGATIVE: the tick must be the literal true — «yes» or 1 is not a statement', async () => {
    held.keys = new Set(OWNER);
    expect((await send({ countedAndInspected: 'yes' })).status).toBe(400);
    expect((await send({ countedAndInspected: 1 })).status).toBe(400);
    nothingWasTouched();
  });

  it('NEGATIVE: the received view → 400 in Arabic — what was counted in is not counted in again', async () => {
    held.keys = new Set(OWNER);
    const r = await send({ view: 'received', countedAndInspected: true });
    expect(r.status).toBe(400);
    expect(r.body.errorAr).toMatch(/بانتظار الاستلام/);
    nothingWasTouched();
  });

  it('NEGATIVE: an unknown filter value → 400 in Arabic, never a quiet «everything»', async () => {
    held.keys = new Set(OWNER);
    const r = await send({ status: 'DELIVERED', countedAndInspected: true });
    expect(r.status).toBe(400);
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    nothingWasTouched();
  });

  it('NEGATIVE: an unknown barcode word → 400 in Arabic, nothing read — never a quiet «every parcel»', async () => {
    held.keys = new Set(OWNER);
    const r = await send({ barcode: 'with', countedAndInspected: true });
    expect(r.status).toBe(400);
    expect(r.body.errorAr).toBe('فلتر الباركود غير معروف: with');
    nothingWasTouched();
  });

  it('NEGATIVE: a cursor that is not an id → 400', async () => {
    held.keys = new Set(OWNER);
    expect((await send({ countedAndInspected: true, cursor: "x' OR 1=1" })).status).toBe(400);
    nothingWasTouched();
  });

  it('the owner → 200; an empty set receives nothing and says it is finished', async () => {
    held.keys = new Set(OWNER);
    const r = await send({ countedAndInspected: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 0, skipped: {}, nextCursor: null });
    expect(db.returnReceipt.create).not.toHaveBeenCalled();
    // The press is still recorded: one summary row, in the store.
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'RETURNS_RECEIVED_ALL', entity: 'Store', entityId: 's1' });
  });
});

describe('the set it walks is the list’s own — the GET is the oracle', () => {
  const FIXED = new Date('2026-11-11T09:00:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED);
    held.keys = new Set(OWNER);
  });

  /** The `where` the list asked its rows with, for these filters. */
  const listWhere = async (query: string) => {
    db.order.findMany.mockClear();
    await GET(new Request(`http://x/api/ops/returns?${query}`));
    const call = db.order.findMany.mock.calls.find((c) => (c[0] as any)?.select?.orderNumber);
    return (call![0] as any).where;
  };
  /** The `where` this door asked its piece with, for the same filters. */
  const doorWhere = async (body: Record<string, unknown>) => {
    db.order.findMany.mockClear();
    await send({ ...body, countedAndInspected: true });
    return (db.order.findMany.mock.calls[0][0] as any).where;
  };

  const CASES: [string, Record<string, unknown>][] = [
    ['view=pending', { view: 'pending' }],
    ['', {}],
    ['status=FAILED_DELIVERY', { status: 'FAILED_DELIVERY' }],
    [`courier=${COURIER}`, { courier: COURIER }],
    ['courier=none', { courier: 'none' }],
    ['age=old', { age: 'old' }],
    ['q=0791234567', { q: '0791234567' }],
    [`status=RETURNED&courier=${COURIER}&age=week&q=سارة`, { status: 'RETURNED', courier: COURIER, age: 'week', q: 'سارة' }],
    ['status=all&courier=all&age=all', { status: 'all', courier: 'all', age: 'all' }],
    // «بلا باركود» (13/11): the button walks exactly the parcels the list showed when it was counted.
    ['barcode=none', { barcode: 'none' }],
    [`courier=${COURIER}&barcode=none`, { courier: COURIER, barcode: 'none' }],
    ['barcode=all', { barcode: 'all' }],
  ];

  it.each(CASES)('?%s — the same question as the list, word for word', async (query, body) => {
    const list = await listWhere(query);
    const door = await doorWhere(body);
    expect(door).toEqual(list);
    // The scope is spread at the TOP, so no filter can widen it.
    expect(door).toMatchObject({ companyId: 'c1', storeId: 's1', returnReceipt: null });
  });

  it('«بلا باركود» narrows the walk: the door asks one clause more, and with it chosen the walk is never wider than without', async () => {
    const without = await doorWhere({});
    const narrowed = await doorWhere({ barcode: 'none' });
    expect(narrowed.AND).toHaveLength(without.AND.length + 1);
    expect(JSON.stringify(narrowed)).toContain('trackingNumber');
    expect(JSON.stringify(without)).not.toContain('trackingNumber');
  });

  it('the cursor is ANDed on last — the list’s question with «after this id», and nothing else', async () => {
    const list = await listWhere('status=RETURNED');
    const door = await doorWhere({ status: 'RETURNED', cursor: CURSOR });
    expect(door).toEqual({ ...list, AND: [...list.AND, { id: { gt: CURSOR } }] });
  });

  it('NEGATIVE: whoever may not read phones is not answered by a phone — the list drops that clause, and so does the door', async () => {
    held.keys = new Set(['ops.returns', 'ops.returns_receive_all']);
    const list = await listWhere('q=0791234567');
    const door = await doorWhere({ q: '0791234567' });
    expect(door).toEqual(list);
    expect(JSON.stringify(door)).not.toMatch(/"phone"/);
  });

  it('walks by id, fifty at a time, and asks for the ids only', async () => {
    await doorWhere({});
    const asked = db.order.findMany.mock.calls[0][0] as any;
    expect(asked.orderBy).toEqual({ id: 'asc' });
    expect(asked.take).toBe(50);
    expect(asked.select).toEqual({ id: true });
  });
});
