import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from './guard-source';

vi.mock('./db', () => ({ db: {} }));
const emit = vi.fn(async (..._a: unknown[]) => 1);
vi.mock('./apps/events', () => ({ emitAppEvent: (...a: unknown[]) => emit(...a) }));

import { announceSwap, type SwapAnnouncement } from './parcel-swap-events';

/**
 * WHAT THE REPLIES SYSTEM IS TOLD ABOUT A PARCEL SWAP.
 *
 * The sale is delivered, the box's order is returned — and nothing is ever created, because A did not order a
 * second time. The envelope and the six events are the v1 contract and are not touched; the one new thing is an
 * optional field inside `data`, which the contract allows.
 */

const base = (over: Partial<SwapAnnouncement['box']> = {}): SwapAnnouncement => ({
  companyId: 'c1',
  sale: { id: 'sale1', orderNumber: 'JO-2026-0100', total: 40, currency: 'JOD', replacesOrderNumber: 'JO-2026-0001' },
  box: {
    id: 'y', orderNumber: 'JO-2026-0002', totalAmount: '35.000', currency: 'JOD', trackingNumber: null,
    previousStatus: 'SHIPPED', endedAs: 'RETURNED', ...over,
  },
});

beforeEach(() => emit.mockClear());

describe('announcing a swap', () => {
  it('tells delivered for the sale and returned for the box — in that order, and nothing else', async () => {
    await announceSwap(base());
    expect(emit.mock.calls.map((c) => [c[1]])).toEqual([['order.delivered'], ['order.returned']]);
    expect(emit.mock.calls.some((c) => c[1] === 'order.created')).toBe(false);
  });

  it('the delivered payload carries the four required fields as numbers and strings, and says what it replaced', async () => {
    await announceSwap(base());
    expect(emit.mock.calls[0][2]).toEqual({
      orderId: 'sale1', orderNumber: 'JO-2026-0100', shippingStatus: 'DELIVERED', previousStatus: null,
      total: 40, currency: 'JOD', trackingNumber: null, replacesOrderNumber: 'JO-2026-0001',
    });
  });

  it('the returned payload reads the Decimal total as a number — a string would be refused on the other side', async () => {
    await announceSwap(base());
    const payload = emit.mock.calls[1][2] as Record<string, unknown>;
    expect(payload).toMatchObject({ orderId: 'y', shippingStatus: 'RETURNED', previousStatus: 'SHIPPED', total: 35, currency: 'JOD' });
    expect(typeof payload.total).toBe('number');
  });

  it('a box with pieces still owed back is not told as returned — the shipping door does not tell that state either', async () => {
    await announceSwap(base({ endedAs: 'RETURN_REQUESTED' }));
    expect(emit.mock.calls.map((c) => c[1])).toEqual(['order.delivered']);
  });

  it('the announcement is the only place that names the optional field, and it never touches the contract', () => {
    const src = stripComments(repoFile('src/lib/parcel-swap-events.ts'));
    expect(src).toContain('replacesOrderNumber');
    expect(src).not.toContain("'order.created'");
    expect(src.match(/emitAppEvent\(/g)).toHaveLength(2);
    // the schema keeps `data` open to additions and every contract file is the way it was shipped
    expect(repoFile('contracts/oms-app-events.v1/schema.json')).toContain('"additionalProperties": true');
  });
});
