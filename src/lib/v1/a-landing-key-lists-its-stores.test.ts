import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEFINITION OF DONE — «المتاجر» FOR ZAKI PAGES (2026-11-23)
 *
 * GET /api/v1/landing/stores lists the stores a landing key sees, each with its country and currency, so Zaki Pages can
 * offer them when the owner adds a country or a store: every real store for a key of every country, the country's
 * stores for a country-bound key, its one store for a store-bound key — and never a test bench.
 */

const h = vi.hoisted(() => ({ requireSystemToken: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { store: { findMany: (...a: unknown[]) => h.findMany(...a) } } }));
vi.mock('@/lib/v1/system-token', async () => {
  const real = await vi.importActual<typeof import('./system-token')>('./system-token');
  return { ...real, requireSystemToken: (...a: unknown[]) => h.requireSystemToken(...a) };
});

import { GET } from '@/app/api/v1/landing/stores/route';
import { LANDING_DOOR } from './landing-country';

const JO = { code: 'jo', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3 };
const ROWS = [
  { id: 's1', name: 'متجر العسل', status: 'ACTIVE', country: JO },
  { id: 's2', name: 'متجر الأزياء', status: 'PAUSED', country: JO },
];
const ask = () => GET(new Request('https://oms.test/api/v1/landing/stores'));
const whereOf = () => h.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  h.findMany.mockResolvedValue(ROWS);
});

describe('the stores a landing key sees', () => {
  it('a key of every country: every real store, with its country and currency', async () => {
    h.requireSystemToken.mockResolvedValue({ companyId: 'c1', countryId: null });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(h.requireSystemToken.mock.calls[0][1]).toBe('products.read');
    expect(h.requireSystemToken.mock.calls[0][2]).toBe(LANDING_DOOR);
    expect(whereOf()).toEqual({ companyId: 'c1', isTest: false });
    const body = (await res.json()) as { stores: unknown[] };
    expect(body.stores).toEqual([
      { id: 's1', name: 'متجر العسل', active: true, country: 'JO', countryName: 'الأردن', currency: 'JOD', minorUnit: 3 },
      { id: 's2', name: 'متجر الأزياء', active: false, country: 'JO', countryName: 'الأردن', currency: 'JOD', minorUnit: 3 },
    ]);
  });

  it('a country-bound key: its country\'s stores only', async () => {
    h.requireSystemToken.mockResolvedValue({ companyId: 'c1', countryId: 'jo-id' });
    await ask();
    expect(whereOf()).toEqual({ companyId: 'c1', isTest: false, countryId: 'jo-id' });
  });

  it('a store-bound key: its one store', async () => {
    h.requireSystemToken.mockResolvedValue({ companyId: 'c1', countryId: 'jo-id', storeId: 's1' });
    await ask();
    expect(whereOf()).toEqual({ companyId: 'c1', isTest: false, countryId: 'jo-id', id: 's1' });
  });
});
