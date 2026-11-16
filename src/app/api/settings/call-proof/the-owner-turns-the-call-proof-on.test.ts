import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «إثبات المكالمات وجدول المحاولات (تجريبي)» — the switch’s door and where it lives (`Company.settings.callProofAndCadence`): the twin of
 * `../per-line-settlement/the-owner-turns-the-per-line-settlement-on.test.ts`, and needing no other switch.
 *
 *  · OFF until it is turned on; reading it is `settings.view`, turning it on is `settings.manage`, and the moment it went on is the SERVER’s clock;
 *  · a second «on» keeps the first moment; «off» clears it; every other key of the settings document is left alone (the rounds’ and the returns’ switches beside it);
 *  · ONE audit row (`CALL_PROOF_SWITCHED`) with the before and the after; a body that is not a plain yes or no is refused in Arabic, and a refused key writes nothing.
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
import { callProofOn, forgetCallProofSwitch } from '@/lib/call-proof-switch';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 }, noAnswerRounds: { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' } };
  forgetCallProofSwitch();
});

describe('the switch', () => {
  it('is OFF until it is turned on, and reading it is the settings page’s key', async () => {
    expect(await (await GET()).json()).toEqual({ callProof: { enabled: false, enabledAt: null } });
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('turning it on is the sensitive-settings key, stores the moment by the server clock, and touches only its own key', async () => {
    const data = await (await put({ enabled: true })).json();
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(data.callProof.enabled).toBe(true);
    expect(Date.now() - new Date(data.callProof.enabledAt).getTime()).toBeLessThan(5_000);
    expect(store.doc.callProofAndCadence).toEqual({ enabled: true, enabledAt: data.callProof.enabledAt });
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.noAnswerRounds).toEqual({ enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' });
  });

  it('writes ONE audit row, CALL_PROOF_SWITCHED, with the before and the after', async () => {
    const data = await (await put({ enabled: true })).json();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1', userId: 'owner', action: 'CALL_PROOF_SWITCHED', entity: 'Company', entityId: 'c1',
        previousData: { enabled: false, enabledAt: null },
        newData: { enabled: true, enabledAt: data.callProof.enabledAt },
      })
    );
  });

  it('a second «on» keeps the first moment; «off» clears it and every door hears it at once', async () => {
    store.doc.callProofAndCadence = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await (await put({ enabled: true })).json()).callProof.enabledAt).toBe('2026-11-02T06:00:00.000Z');
    expect(await callProofOn(db as never, 'c1')).toBe(true);
    await put({ enabled: false });
    expect(store.doc.callProofAndCadence).toEqual({ enabled: false, enabledAt: null });
    expect(await callProofOn(db as never, 'c1')).toBe(false);
  });

  it('a body that is not a plain yes or no is refused in Arabic, and nothing is stored', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, enabledAt: '2020-01-01' }, null]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/نعم أو لا/);
    }
    expect(store.doc.callProofAndCadence).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('needs no other switch: it can be turned on with the rounds off', async () => {
    store.doc = {};
    expect((await (await put({ enabled: true })).json()).callProof.enabled).toBe(true);
  });

  it('a refused key writes nothing and leaves no audit row', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await put({ enabled: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.doc.callProofAndCadence).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
