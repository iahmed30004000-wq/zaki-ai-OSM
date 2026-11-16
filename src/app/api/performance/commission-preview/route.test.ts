import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The commission estimate's door (step G2): money is the payroll's — `payroll.view` is asked before anything is read — the month is the commission module's own span, the
 * company and store are the session's, and the door only reads: it is an estimate, not the ledger.
 */
const { requirePermission, readPreview, readConfig } = vi.hoisted(() => ({
  requirePermission: vi.fn(async (_key: string) => undefined),
  readPreview: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  readConfig: vi.fn(async (..._a: unknown[]) => ({ tiers: [{ from: 1, value: 1 }] })),
}));

vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/agent-commission-settings', () => ({ readAgentCommission: (...a: unknown[]) => readConfig(...a) }));
vi.mock('@/lib/agent-commission-calc', () => ({ readCommissionPreview: (...a: unknown[]) => readPreview(...a) }));

import { GET } from './route';

beforeEach(() => vi.clearAllMocks());

describe('GET /api/performance/commission-preview', () => {
  it('asks the payroll\'s key first, and a refusal reads nothing', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(requirePermission).toHaveBeenCalledWith('payroll.view');
    expect(readPreview).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('reads this company and store over the current month, with the company\'s settings', async () => {
    readPreview.mockResolvedValueOnce([{ userId: 'u1' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const [client, scope, config] = readPreview.mock.calls[0] as [unknown, { companyId: string; storeId: string; start: Date; end: Date }, unknown];
    expect(client).toEqual({ marker: 'db' });
    expect(scope).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(scope.start.getDate()).toBe(1);
    expect(scope.start.getTime()).toBeLessThan(scope.end.getTime());
    expect(config).toEqual({ tiers: [{ from: 1, value: 1 }] });
    expect(await res.json()).toMatchObject({ rows: [{ userId: 'u1' }], config: { tiers: [{ from: 1, value: 1 }] } });
  });

  it('only reads', () => {
    const src = readFileSync('src/app/api/performance/commission-preview/route.ts', 'utf8');
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(src).not.toMatch(/\.(create|update|upsert|delete)\w*\(/);
  });
});
