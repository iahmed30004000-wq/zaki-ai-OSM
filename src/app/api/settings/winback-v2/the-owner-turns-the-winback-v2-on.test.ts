import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الاسترجاع اليومي (تجريبي)» — the switch’s door and where it lives (`Company.settings.winbackV2`): the twin of
 * `../call-proof/the-owner-turns-the-call-proof-on.test.ts`, and needing no other switch — in particular not the call-proof one (its own key, its own audit row).
 *
 *  · OFF until it is turned on; reading it is `settings.view`, turning it on is `settings.manage`, and the moment it went on is the SERVER’s clock;
 *  · a second «on» keeps the first moment; «off» clears it; every other key of the settings document is left alone (the rounds’ and the returns’ switches beside it);
 *  · ONE audit row (`WINBACK_V2_SWITCHED`) with the before and the after; a body that is not a plain yes or no is refused in Arabic, and a refused key writes nothing.
 */

const { store, requirePermission, logAudit, db } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown> };
  const db = { company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(store.doc) })) } };
  return { store, requirePermission: vi.fn(async (_key: string) => undefined), logAudit: vi.fn(), db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'owner' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import { GET, PUT } from './route';
import { winbackV2Switch, forgetWinbackV2Switch } from '@/lib/winback-v2-switch';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 }, callProofAndCadence: { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' } };
  forgetWinbackV2Switch();
});

describe('the switch', () => {
  it('is OFF until it is turned on, and reading it is the settings page’s key', async () => {
    expect(await (await GET()).json()).toEqual({ winbackV2: { enabled: false, enabledAt: null } });
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('turning it on is the sensitive-settings key, stores the moment by the server clock, and touches only its own key', async () => {
    const data = await (await put({ enabled: true })).json();
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(data.winbackV2.enabled).toBe(true);
    expect(Date.now() - new Date(data.winbackV2.enabledAt).getTime()).toBeLessThan(5_000);
    expect(store.doc.winbackV2).toEqual({ enabled: true, enabledAt: data.winbackV2.enabledAt });
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.callProofAndCadence).toEqual({ enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' });
  });

  it('writes ONE audit row, WINBACK_V2_SWITCHED, with the before and the after', async () => {
    const data = await (await put({ enabled: true })).json();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1', userId: 'owner', action: 'WINBACK_V2_SWITCHED', entity: 'Company', entityId: 'c1',
        previousData: { enabled: false, enabledAt: null },
        newData: { enabled: true, enabledAt: data.winbackV2.enabledAt },
      })
    );
  });

  it('a second «on» keeps the first moment; «off» clears it and every door hears it at once', async () => {
    store.doc.winbackV2 = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await (await put({ enabled: true })).json()).winbackV2.enabledAt).toBe('2026-11-02T06:00:00.000Z');
    expect((await winbackV2Switch(db as never, 'c1')).enabled).toBe(true);
    await put({ enabled: false });
    expect(store.doc.winbackV2).toEqual({ enabled: false, enabledAt: null });
    expect((await winbackV2Switch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a body that is not a plain yes or no is refused in Arabic, and nothing is stored', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, enabledAt: '2020-01-01' }, null]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/نعم أو لا/);
    }
    expect(store.doc.winbackV2).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('needs no other switch: it can be turned on with the call-proof switch off', async () => {
    store.doc = {};
    expect((await (await put({ enabled: true })).json()).winbackV2.enabled).toBe(true);
  });

  it('a refused key writes nothing and leaves no audit row', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await put({ enabled: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.doc.winbackV2).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
