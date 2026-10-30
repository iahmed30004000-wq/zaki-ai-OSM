import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SYSTEM KEY READS, AND WRITES A NOTE ON, ONLY THE ORDERS THAT SYSTEM RAISED (perm-plan PR-13, V1-1).
 *
 * `GET /api/v1/orders/{id}` and `POST /api/v1/orders/{id}/notes` answered for ANY order of the company: a leaked key could poll
 * every order's status and write on every order. They now answer for the orders the caller's SYSTEM created through
 * `POST /api/v1/orders` — and nothing else, with the same 404 an unknown id has always got.
 *
 * THIS IS A PUBLISHED DOOR (System 7 calls it), so what is held still here is the CONTRACT: the request, the answer's fields
 * and its headers, the 404's envelope, and the idempotency of a note are exactly what they were. Only the WHERE of the read
 * narrowed. And a key ROTATION must not orphan last month's orders — the match is on the SYSTEM, not on the key's id.
 *
 * The match is on the JSON `createSystemOrder` writes into the order's first activity row. The writer and the reader are
 * pinned to each other below, because a drift between them would turn this into a silent 404 for System 7.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: { order: { findFirst: vi.fn() }, orderNote: { create: vi.fn() }, orderActivity: { create: vi.fn() }, $transaction: vi.fn() },
  requireSystemToken: vi.fn(),
  claimIdempotency: vi.fn(),
  rememberIdempotency: vi.fn(),
  releaseIdempotency: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/v1/system-token', () => ({ requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) }));
vi.mock('@/lib/v1/idempotency', () => ({
  claimIdempotency: (...a: unknown[]) => h.claimIdempotency(...a),
  rememberIdempotency: (...a: unknown[]) => h.rememberIdempotency(...a),
  releaseIdempotency: (...a: unknown[]) => h.releaseIdempotency(...a),
  idempotencyKeyOf: () => 'k1',
  requestFingerprint: () => 'fp',
}));

import { raisedBySystem } from './order-origin';
import { GET as getOrder } from '@/app/api/v1/orders/[id]/route';
import { POST as postNote } from '@/app/api/v1/orders/[id]/notes/route';

const CALLER = { tokenId: 'tok_9', companyId: 'c1', system: 'replies', scopes: ['orders.read', 'orders.note'] };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSystemToken.mockResolvedValue(CALLER);
  h.claimIdempotency.mockResolvedValue(null);
  h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ orderNote: h.db.orderNote, orderActivity: h.db.orderActivity }));
});

// ── a tiny evaluator for the one Prisma fragment, so the test judges ROWS and not the shape of an object ──
interface Activity { action: string; userId: string | null; metadata: string | null }
type Fragment = ReturnType<typeof raisedBySystem>;
function raisedBy(fragment: Fragment, activities: Activity[]): boolean {
  const q = fragment.activities.some;
  return activities.some(
    (a) =>
      a.action === q.action &&
      a.userId === q.userId &&
      q.AND.every((c) => (a.metadata ?? '').includes(c.metadata.contains))
  );
}

/** Exactly what `createSystemOrder` writes (src/lib/v1/order-intake.ts, the ORDER_CREATED activity). */
const intakeMetadata = (system: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ source: system, via: 'api/v1', system, externalRef: 'ORD-1', priceAdjusted: false, lines: [], ...over });

describe('which orders a system raised', () => {
  const mine: Activity = { action: 'ORDER_CREATED', userId: null, metadata: intakeMetadata('replies') };

  it('an order that system created through the door matches', () => {
    expect(raisedBy(raisedBySystem('replies'), [mine])).toBe(true);
  });

  it('a key ROTATION does not orphan it: the match is on the system, and no key id appears in the filter', () => {
    expect(JSON.stringify(raisedBySystem('replies'))).not.toMatch(/tok_|tokenId/);
    expect(raisedBy(raisedBySystem('replies'), [mine])).toBe(true);
  });

  it('NEGATIVE: an order another system raised does not match', () => {
    expect(raisedBy(raisedBySystem('replies'), [{ ...mine, metadata: intakeMetadata('mediabuyer') }])).toBe(false);
    expect(raisedBy(raisedBySystem('replies'), [{ ...mine, metadata: intakeMetadata('replies-2') }])).toBe(false);
  });

  it('NEGATIVE: an order a PERSON created (a user on the activity, no api/v1) does not match', () => {
    expect(raisedBy(raisedBySystem('replies'), [{ action: 'ORDER_CREATED', userId: 'u1', metadata: JSON.stringify({ source: 'manual' }) }])).toBe(false);
    expect(raisedBy(raisedBySystem('replies'), [{ action: 'ORDER_CREATED', userId: null, metadata: JSON.stringify({ source: 'storefront' }) }])).toBe(false);
    expect(raisedBy(raisedBySystem('replies'), [])).toBe(false);
  });

  it('NEGATIVE: a later activity that merely mentions the system is not the creation', () => {
    expect(raisedBy(raisedBySystem('replies'), [{ action: 'NOTE_ADDED', userId: null, metadata: intakeMetadata('replies') }])).toBe(false);
  });

  it('NEGATIVE: a customer-written string that contains the words cannot forge it — inside a JSON string its quotes are escaped', () => {
    const forged: Activity = {
      action: 'ORDER_CREATED',
      userId: null,
      metadata: JSON.stringify({ source: 'manual', externalRef: '"via":"api/v1","system":"replies"', note: '"system":"replies"' }),
    };
    expect(raisedBy(raisedBySystem('replies'), [forged])).toBe(false);
  });

  it('a system name with a quote or a backslash is matched as what it is, not as syntax', () => {
    const odd = 'we"ird\\sys';
    expect(raisedBy(raisedBySystem(odd), [{ action: 'ORDER_CREATED', userId: null, metadata: intakeMetadata(odd) }])).toBe(true);
    expect(raisedBy(raisedBySystem('we'), [{ action: 'ORDER_CREATED', userId: null, metadata: intakeMetadata(odd) }])).toBe(false);
  });
});

describe('the writer and the reader are pinned to each other', () => {
  const intake = readFileSync(path.join(process.cwd(), 'src', 'lib', 'v1', 'order-intake.ts'), 'utf8');

  it('the intake still writes the origin the way the filter reads it — userId null, ORDER_CREATED, via api/v1, system = the caller’s', () => {
    const block = intake.slice(intake.indexOf("action: 'ORDER_CREATED'") - 400, intake.indexOf("action: 'ORDER_CREATED'") + 700);
    expect(block).toMatch(/userId: null/);
    expect(block).toMatch(/action: 'ORDER_CREATED'/);
    expect(block).toMatch(/via: 'api\/v1'/);
    expect(block).toMatch(/system: caller\.system/);
    expect(block).toMatch(/metadata: JSON\.stringify\(/);
  });

  it('and the filter’s two substrings are found in that JSON as it is really serialised', () => {
    const json = intakeMetadata('replies');
    expect(json).toContain('"via":"api/v1"');
    expect(json).toContain(`"system":"replies"`);
  });
});

describe('the status read', () => {
  it('asks ONE query, with the company, the id and the origin together — the contract’s "one row, one query" holds', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    await getOrder(new Request('https://oms.test/api/v1/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });
    expect(h.db.order.findFirst).toHaveBeenCalledTimes(1);
    expect(h.db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o1', companyId: 'c1', ...raisedBySystem('replies') });
  });

  it('NEGATIVE: an order of the company that this system did not raise is the contract’s own 404, with its envelope and request id', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o_human', { headers: { 'x-request-id': 'rep_7' } }), { params: Promise.resolve({ id: 'o_human' }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Request-Id')).toBe('rep_7');
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No such order', details: null }, request_id: 'rep_7' });
  });

  it('an order it raised is read exactly as before: four fields and nothing about the customer', async () => {
    h.db.order.findFirst.mockResolvedValue({
      id: 'o1', orderNumber: 'SY-1', confirmationStatus: 'CONFIRMED', shippingStatus: 'SHIPPED',
      updatedAt: new Date('2026-10-02T10:00:00Z'), store: { country: { timezone: 'Asia/Damascus' } },
    });
    const res = await getOrder(new Request('https://oms.test/api/v1/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.data ?? body).sort()).toEqual(expect.arrayContaining(['order_id', 'order_number', 'shipping_status', 'status', 'updated_at']));
    expect(JSON.stringify(body)).not.toMatch(/phone|address|customer|total/i);
  });

  it('the scope the door asks of the key did not change', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    await getOrder(new Request('https://oms.test/api/v1/orders/o1'), { params: Promise.resolve({ id: 'o1' }) });
    expect(h.requireSystemToken.mock.calls[0][1]).toBe('orders.read');
  });
});

describe('a note', () => {
  const note = (id: string) =>
    postNote(
      new Request(`https://oms.test/api/v1/orders/${id}/notes`, { method: 'POST', body: JSON.stringify({ kind: 'internal', note: 'ملاحظة للاختبار' }) }),
      { params: Promise.resolve({ id }) }
    );

  it('NEGATIVE: on an order this system did not raise it is the same 404 — before a key is burned, and nothing is written', async () => {
    h.db.order.findFirst.mockResolvedValue(null);
    const res = await note('o_human');
    expect(res.status).toBe(404);
    expect(h.db.order.findFirst.mock.calls[0][0].where).toEqual({ id: 'o_human', companyId: 'c1', ...raisedBySystem('replies') });
    expect(h.claimIdempotency).not.toHaveBeenCalled();
    expect(h.db.orderNote.create).not.toHaveBeenCalled();
    expect(h.db.orderActivity.create).not.toHaveBeenCalled();
  });

  it('on an order it raised the note is written once, with the provenance, as before', async () => {
    h.db.order.findFirst.mockResolvedValue({ id: 'o1' });
    const res = await note('o1');
    expect(res.status).toBe(201);
    expect(h.db.orderNote.create.mock.calls[0][0].data).toMatchObject({ orderId: 'o1', companyId: 'c1', authorId: null, kind: 'internal' });
    expect(h.db.orderActivity.create.mock.calls[0][0].data.metadata).toContain('"system":"replies"');
  });

  it('and a different system’s key, on the same order, gets the 404 — the filter follows the CALLER', async () => {
    h.requireSystemToken.mockResolvedValue({ ...CALLER, system: 'mediabuyer' });
    h.db.order.findFirst.mockResolvedValue(null);
    await note('o1');
    const where = h.db.order.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ id: 'o1', companyId: 'c1', ...raisedBySystem('mediabuyer') });
    expect(where).not.toEqual({ id: 'o1', companyId: 'c1', ...raisedBySystem('replies') });
  });
});
