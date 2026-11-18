import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A BENCH EARNS NO PERIOD COMMISSION (B2, 18/11 — `test-store.ts`).
 *
 * Every per-order commission waits for DELIVERED (`accrueForOrder`), which a bench order never reaches. A PERIOD rule can
 * count confirmations («150 مؤكَّد باليوم») — the one way a bench order could still earn someone money. The job leaves a
 * bench store out; a real store's rules run through the same function with the same arguments as before.
 */

const { accrueForPeriod } = vi.hoisted(() => ({
  accrueForPeriod: vi.fn(async (..._a: unknown[]) => ({ created: 1, amount: 5, skipped: {} })),
}));

vi.mock('../db', () => ({ db: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn('tx')) } }));
vi.mock('../commission-period', async (orig) => ({
  ...(await orig<typeof import('../commission-period')>()),
  accrueForPeriod: (...a: unknown[]) => accrueForPeriod(...a),
}));
vi.mock('./definitions/shared', async (orig) => ({
  ...(await orig<typeof import('./definitions/shared')>()),
  activeStores: async () => [
    { id: 'real', companyId: 'c1', isTest: false, country: { minorUnit: 2, currencyCode: 'JOD' } },
    { id: 'bench', companyId: 'c1', isTest: true, country: { minorUnit: 2, currencyCode: 'JOD' } },
  ],
}));

import { accruePeriodCommission } from './definitions/accrue-period-commission';
import { SPANS } from '../commission-period';

beforeEach(() => vi.clearAllMocks());

describe('period commission and the bench', () => {
  it('a bench store’s rules are never run', async () => {
    await accruePeriodCommission.run({} as never);
    const stores = accrueForPeriod.mock.calls.map((c) => (c[1] as { storeId: string }).storeId);
    expect(stores, 'احتُسبت عمولة فترة على منصّة تجريب').not.toContain('bench');
  });

  it('NEGATIVE: a real store’s rules run for every span, as before', async () => {
    await accruePeriodCommission.run({} as never);
    const real = accrueForPeriod.mock.calls.filter((c) => (c[1] as { storeId: string }).storeId === 'real');
    expect(real.map((c) => (c[1] as { span: string }).span)).toEqual([...SPANS]);
    expect(real[0][1]).toMatchObject({ companyId: 'c1', storeId: 'real', minorUnit: 2, currencyCode: 'JOD' });
  });
});
