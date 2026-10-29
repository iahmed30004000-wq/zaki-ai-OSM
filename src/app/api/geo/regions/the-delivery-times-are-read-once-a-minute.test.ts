import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE GOVERNORATES DOOR ASKED FOR 180 DAYS OF DELIVERIES THREE TIMES PER OPENING (RV184).
 *
 * The orders screen and its two dialogs each load the governorates, and each
 * load worked out every governorate's delivery time from every delivered
 * order of the last 180 days. The answer is the same for the same store, and
 * a minute old is as good as a second old. What must NOT change: the body,
 * and that one store's times are never shown to another.
 */

const { deliveryWindows, context, db } = vi.hoisted(() => ({
  deliveryWindows: vi.fn(),
  context: { value: { countryId: 'c1', country: { id: 'c1', code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3 }, companyId: 'co1', storeId: 's1' } as Record<string, unknown> },
  db: { region: { findMany: vi.fn() } },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => context.value }));
vi.mock('@/lib/delivery-time', async (orig) => ({
  ...(await orig<typeof import('@/lib/delivery-time')>()),
  deliveryWindows: (...a: unknown[]) => deliveryWindows(...a),
}));

import { GET } from './route';

const WINDOW_A = new Map([['r1', { medianDays: 2, slowDays: 4, samples: 9 }]]);
const WINDOW_B = new Map([['r1', { medianDays: 6, slowDays: 9, samples: 12 }]]);

beforeEach(() => {
  vi.clearAllMocks();
  db.region.findMany.mockResolvedValue([{ id: 'r1', name: 'عمّان' }]);
});

const ask = async () => (await GET()).json();

describe('GET /api/geo/regions', () => {
  it('reads the delivery times once for three askers of the same store, and answers all three the same', async () => {
    context.value = { ...context.value, companyId: 'co-memo-1', storeId: 's-memo-1' };
    deliveryWindows.mockResolvedValue(WINDOW_A);
    const [a, b, c] = await Promise.all([ask(), ask(), ask()]);
    expect(deliveryWindows, 'القراءة انعادت لكل سائل').toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.regions[0].delivery).toEqual({ medianDays: 2, slowDays: 4, samples: 9 });
    expect(a.country.currencyCode).toBe('JOD');
  });

  it('NEGATIVE: another store, or another company, is never given this one’s times', async () => {
    deliveryWindows.mockReset();
    context.value = { ...context.value, companyId: 'co-memo-2', storeId: 's-x' };
    deliveryWindows.mockResolvedValue(WINDOW_A);
    const mine = await ask();

    context.value = { ...context.value, companyId: 'co-memo-2', storeId: 's-y' };
    deliveryWindows.mockResolvedValue(WINDOW_B);
    const theirs = await ask();

    context.value = { ...context.value, companyId: 'co-memo-3', storeId: 's-x' };
    const otherCompany = await ask();

    expect(mine.regions[0].delivery.medianDays).toBe(2);
    expect(theirs.regions[0].delivery.medianDays, 'وقت توصيل متجر انعرض لمتجر ثاني').toBe(6);
    expect(otherCompany.regions[0].delivery.medianDays, 'وقت توصيل شركة انعرض لشركة ثانية').toBe(6);
    expect(deliveryWindows).toHaveBeenCalledTimes(3);
  });

  it('NEGATIVE: a failed read is not kept — the next opening tries again', async () => {
    deliveryWindows.mockReset();
    context.value = { ...context.value, companyId: 'co-memo-4', storeId: 's-z' };
    deliveryWindows.mockRejectedValueOnce(new Error('db down'));
    expect((await GET()).status).toBeGreaterThanOrEqual(500);
    deliveryWindows.mockResolvedValue(WINDOW_A);
    const body = await ask();
    expect(body.regions[0].delivery.medianDays).toBe(2);
  });
});
