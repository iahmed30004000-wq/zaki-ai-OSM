import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «حاسبة عمولة الموظفات (تقدير)» — the settings door (step G2): read by `settings.view`, written by `settings.manage`, validated WHOLE (an invalid document is refused in Arabic and
 * nothing is stored), one audit row with the before and the after, and every other key of the settings document left alone. It edits an estimate: no commission rule is touched.
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
import { AGENT_COMMISSION_DEFAULTS } from '@/lib/agent-commission-settings';

const put = (body: unknown) => PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const NEW_DOC = { tiers: [{ from: 50, value: 10_000 }, { from: 90, value: 20_000 }], bonus: { minOrders: 1_000, perOrder: 300 }, qualityGate: { enabled: true, minDeliveryRate: 85 } };

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 }, callProofAndCadence: { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' } };
});

describe('the calculator\'s settings door', () => {
  it('shows the planner\'s defaults until the owner edits, under the settings page\'s key', async () => {
    const data = await (await GET()).json();
    expect(data.agentCommission).toEqual(AGENT_COMMISSION_DEFAULTS);
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('saving is the sensitive-settings key, stores the whole document under its own key, and touches nothing else', async () => {
    const res = await put(NEW_DOC);
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(store.doc.agentCommission).toEqual(NEW_DOC);
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.callProofAndCadence).toEqual({ enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' });
    expect((await (await GET()).json()).agentCommission).toEqual(NEW_DOC);
  });

  it('writes ONE audit row with the before (the defaults) and the after', async () => {
    await put(NEW_DOC);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'c1', userId: 'owner', action: 'AGENT_COMMISSION_CHANGED', entity: 'Company', previousData: AGENT_COMMISSION_DEFAULTS, newData: NEW_DOC }));
  });

  it('an invalid document is refused in Arabic, nothing is stored, no audit row — whatever is wrong with it', async () => {
    for (const bad of [{}, null, { ...NEW_DOC, tiers: [] }, { ...NEW_DOC, extra: 1 }, { ...NEW_DOC, tiers: [{ from: 9, value: 1 }, { from: 5, value: 2 }] }, { ...NEW_DOC, qualityGate: { enabled: true, minDeliveryRate: 150 } }]) {
      const res = await put(bad);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.errorAr).toMatch(/[؀-ۿ]/);
      expect(body.code).toBe('INVALID_COMMISSION_CALCULATOR');
    }
    expect(store.doc.agentCommission).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a refused key writes nothing and leaves no audit row', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await put(NEW_DOC);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.doc.agentCommission).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
