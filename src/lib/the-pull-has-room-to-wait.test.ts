import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pull's transaction has room to wait (RV711, from the review of #169)
 *
 * Since #169 a pull takes the customer's lock and can wait behind a colleague's whole pull of the same customer (up to five
 * attempts, up to 50 holds and 50 history rows). On Prisma's defaults (2 s for a connection, 5 s for the transaction) that ends
 * in P2028 on a busy morning.
 *
 *  1. `pullNextOrder` hands its transaction explicit `maxWait` and `timeout`, both above Prisma's defaults.
 *  2. Both together stay under the screen's own 15 s wait (`REQUEST_TIMEOUT_MS` in `api-client.ts`), so a pull that runs out of
 *     time is answered to her (the route's «الطابور مشغول») and never ends after nobody is listening.
 *  3. Nothing else about the pull changes: what the transaction returns is what `pullNextOrder` returns.
 *
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { $transaction } = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('./db', () => ({ db: { $transaction } }));

import { PULL_TRANSACTION_OPTIONS, pullNextOrder } from './confirmation-queue';

/** Prisma's interactive-transaction defaults — what the pull ran on before. */
const PRISMA_DEFAULT = { maxWait: 2_000, timeout: 5_000 };
/** `REQUEST_TIMEOUT_MS` in `api-client.ts`: the screen stops listening after this. */
const SCREEN_GIVES_UP_AFTER = 15_000;

const CAL = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' };

beforeEach(() => {
  $transaction.mockReset();
  $transaction.mockResolvedValue({ ok: true, orderId: 'o1', released: 0 });
});

describe('the pull transaction (RV711)', () => {
  it('is called with the explicit maxWait and timeout', async () => {
    await pullNextOrder({ companyId: 'c1', storeId: 's1' }, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL);
    expect($transaction).toHaveBeenCalledTimes(1);
    const [fn, options] = $transaction.mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(options).toEqual(PULL_TRANSACTION_OPTIONS);
    expect(options).toEqual({ maxWait: 3_000, timeout: 10_000 });
  });

  it('both bounds are longer than the defaults that timed out', () => {
    expect(PULL_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(PRISMA_DEFAULT.maxWait);
    expect(PULL_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(PRISMA_DEFAULT.timeout);
  });

  it('both together end before the screen stops listening', () => {
    expect(PULL_TRANSACTION_OPTIONS.maxWait + PULL_TRANSACTION_OPTIONS.timeout).toBeLessThan(SCREEN_GIVES_UP_AFTER);
  });

  it('what the transaction answers is what the pull answers — unchanged', async () => {
    const out = await pullNextOrder({ companyId: 'c1', storeId: 's1' }, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL);
    expect(out).toEqual({ ok: true, orderId: 'o1', released: 0 });
  });

  it('a P2028 from the transaction reaches the route untouched (the route says «اسحب مرة تانية»)', async () => {
    const timedOut = Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    $transaction.mockRejectedValue(timedOut);
    await expect(
      pullNextOrder({ companyId: 'c1', storeId: 's1' }, { id: 'huda', role: 'CONFIRMATION_AGENT' }, CAL)
    ).rejects.toBe(timedOut);
  });
});
