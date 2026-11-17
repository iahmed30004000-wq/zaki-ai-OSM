import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «حوّل السلات اللي فيها اسم ورقم لطلبات تلقائيًا» — THE COMPANY'S SWITCH, BESIDE THE RETENTION DAYS (the owner, 17/11).
 *
 * ON unless the company turned it off; read by whoever sees the carts; flipped only with `settings.edit`, with an audit row;
 * and flipping it leaves the retention days as they were (one key changed under `abandonedCarts`).
 */

const h = vi.hoisted(() => ({
  settings: null as string | null,
  mayEdit: true,
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: { company: { findUnique: async () => ({ settings: h.settings }) } } }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1', role: 'COMPANY_ADMIN' }, companyId: 'c1' }),
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, key: string) => (key === 'settings.edit' ? h.mayEdit : true),
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: Record<string, unknown> | null) => Record<string, unknown>) => {
    const all = h.settings ? JSON.parse(h.settings) : {};
    all[key] = change(all[key] ?? null);
    h.settings = JSON.stringify(all);
  },
}));

import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://x/api/abandoned-carts/settings', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = null;
  h.mayEdit = true;
});

describe('the auto-order switch', () => {
  it('is ON when nobody set it', async () => {
    expect(await (await GET()).json()).toMatchObject({ autoConvert: true, retentionDays: 60 });
  });

  it('turned off: stored under abandonedCarts, the retention days untouched, an audit row', async () => {
    await put({ retentionDays: 30 });
    const r = await put({ autoConvert: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ retentionDays: 30, autoConvert: false });
    expect(JSON.parse(h.settings!)).toEqual({ abandonedCarts: { retentionDays: 30, autoConvert: false } });
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ABANDONED_CART_AUTO_CONVERT', previousData: { autoConvert: true }, newData: { autoConvert: false } })
    );
    expect(await (await GET()).json()).toMatchObject({ autoConvert: false, retentionDays: 30 });
  });

  it('NEGATIVE: without `settings.edit` it does not move; an empty or wrong body is a 400', async () => {
    h.mayEdit = false;
    expect((await put({ autoConvert: false })).status).toBe(403);
    expect(h.settings).toBeNull();
    h.mayEdit = true;
    expect((await put({})).status).toBe(400);
    expect((await put({ autoConvert: 'no' })).status).toBe(400);
    expect(h.settings).toBeNull();
  });
});
