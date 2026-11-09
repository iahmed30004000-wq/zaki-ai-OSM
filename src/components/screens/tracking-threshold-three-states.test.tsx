// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A STORED ZERO MUST NOT READ AS AN ABSENCE — THREE STATES, NOT TWO.
 *
 * The days cell was
 *
 *     {o.daysInTransit ?? '—'}
 *     {o.lateThresholdDays > 0 && <span> / {o.lateThresholdDays}</span>}
 *
 * so a threshold of **0** printed nothing — exactly what an unpriced region
 * printed. Two different facts, one blank: «this courier is told never to
 * flag this region late» and «nobody has priced this courier for this
 * region at all». «Late» is how an operator decides which parcel to chase,
 * and the screen said the same thing about both.
 *
 * The collapse was not only in the condition. `/api/ops/tracking` read the
 * threshold as `thresholdOf.get(key) ?? 0`, so the two states were ALREADY
 * the same number before the browser saw them — a blank cell could not have
 * told them apart whatever the condition said. The row now carries `null`
 * for the unpriced lane, and the three states read:
 *
 *   · `null` → «بلا أجرة» (warning tone) — the lane has no fee row, which is
 *     a settings problem with a named cause, not a threshold of zero.
 *   · `0`    → «بلا حد» — priced, and the decision was «never late».
 *   · `3`    → «/ 3», unchanged.
 *
 * AND ONLY ONCE THE CLOCK IS RUNNING. An order that has not shipped has no
 * days in transit, and «/ 3» beside a «—» was a threshold against a clock
 * nobody had started. That is the fourth state, and it is deliberately
 * silent.
 *
 * These tests render the screen and read the CELL. Put `> 0` back and the
 * zero row reads «1» with nothing after it, against «بلا حد».
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson, apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/tracking',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => false,
  useTell: () => async () => undefined,
}));
// The three dialogs are other screens' subjects; none of them opens here.
vi.mock('@/components/screens/tracking/TransferDialog', () => ({ TransferDialog: () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({ CollectDialog: () => null }));
vi.mock('@/components/screens/tracking/DeliverDialog', () => ({ DeliverDialog: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { TrackingScreen } from './TrackingScreen';

const DAYS_OUT = 1;

/** One parcel, out for `DAYS_OUT` days, differing only in its threshold. */
function row(lateThresholdDays: number | null, over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'ORD-1',
    merchantRef: null,
    trackingNumber: 'TRK-1',
    shippingStatus: 'SHIPPED',
    collectionStatus: 'PENDING_COLLECTION',
    settlementStatus: 'PENDING_COLLECTION',
    daysInTransit: DAYS_OUT,
    lateThresholdDays,
    late: false,
    totalAmount: 40,
    currency: 'JOD',
    deliveryFailureReason: null,
    customer: { fullName: 'سارة', phone: '0790000000', city: 'عمّان' },
    region: { name: 'عمّان' },
    deliveryProvider: { id: 'dp1', name: 'Basha Delivery', kind: 'COMPANY' },
    deliveryFee: 2.5,
    priceIncludesDelivery: false,
    collectedAmount: null,
    expectedCollection: 37.5,
    _count: { deliveryAttempts: 0, notes: 0 },
    alert: null,
    ...over,
  };
}

/** The door's whole answer — the page, its numbers, what was applied. */
const answer = (orders: unknown[]) => ({
  count: orders.length,
  orders,
  lateCount: 0,
  dialCode: '+962',
  pagination: { total: orders.length, page: 1, limit: 25, totalPages: 1 },
  facts: {
    total: orders.length,
    tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
    lateCount: 0,
    couriers: [],
    regions: [],
    ages: { fresh: 0, few: 0, week: 0, old: 0 },
  },
  applied: { status: 'default', task: null, courier: null, region: null, age: null, q: null },
  capped: false,
});

async function show(lateThresholdDays: number | null, over?: Record<string, unknown>) {
  apiJson.mockResolvedValue(answer([row(lateThresholdDays, over)]));
  render(<TrackingScreen />);
  await waitFor(() => expect(screen.getAllByText('TRK-1').length).toBeGreaterThan(0));
}

/**
 * THE DAYS CELL'S TEXT, with whitespace squeezed.
 *
 * `Rows` renders each row twice — a table and a phone card — so the cell is
 * found by the day count it starts with and the first copy is read.
 */
function daysCell() {
  const spans = Array.from(document.querySelectorAll('span.tabular-nums')).filter((el) =>
    (el.textContent ?? '').trim().startsWith(String(DAYS_OUT))
  );
  expect(spans.length, 'the days cell was not found').toBeGreaterThan(0);
  return (spans[0].textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the late threshold beside the days in transit', () => {
  it('prints the number when the region has one', async () => {
    await show(3);
    expect(daysCell()).toBe('1 / 3');
  });

  it('says «بلا حد» for a threshold stored as 0 — not a blank', async () => {
    await show(0);
    const cell = daysCell();
    expect(cell).toContain('بلا حد');
    // THE ASSERTION THAT `> 0` BREAKS: the cell was just «1».
    expect(cell).not.toBe('1');
  });

  it('says «بلا أجرة» when this courier has no fee row for this region', async () => {
    await show(null);
    const cell = daysCell();
    expect(cell).toContain('بلا أجرة');
    expect(cell).not.toContain('بلا حد');
    expect(cell).not.toBe('1');
  });

  it('and the three states are three different cells', async () => {
    const seen: string[] = [];
    for (const t of [3, 0, null] as const) {
      await show(t);
      seen.push(daysCell());
      cleanup();
    }
    expect(new Set(seen).size, `two states still read alike: ${seen.join(' | ')}`).toBe(3);
  });

  it('and says nothing at all before the parcel ships', async () => {
    // No days in transit means no clock to measure against.
    await show(3, { daysInTransit: null, shippingStatus: 'READY_TO_SHIP' });
    const cell = Array.from(document.querySelectorAll('span.tabular-nums')).find((el) =>
      (el.textContent ?? '').trim().startsWith('—')
    );
    expect(cell, 'the unshipped days cell was not found').toBeTruthy();
    expect((cell!.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe('—');
  });
});
