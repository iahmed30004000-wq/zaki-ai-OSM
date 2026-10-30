import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE DAILY AND MONTHLY CEILING IS WRITTEN BY WHOEVER MAY CHANGE THE
 * ASSISTANTS’ SETTINGS, AND BY NOBODY ELSE.
 *
 * It rides the existing PUT (`settings.manage` — no new key), takes whole
 * positive numbers or «none», and a save about something else leaves it be.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: { company: { findUnique: vi.fn(), update: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn() },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { PUT } from './route';

let stored: Record<string, unknown>;

const put = (body: unknown) => PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }));
const written = () => {
  const call = db.company.update.mock.calls.at(-1);
  return call ? JSON.parse(call[0].data.settings).ai : null;
};

beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'زكي' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue(undefined);
  stored = { provider: 'OPENROUTER', model: 'm', prompts: { house: 'نص' } };
  db.company.findUnique.mockImplementation(async () => ({ settings: JSON.stringify({ ai: stored }) }));
  db.company.update.mockImplementation(async ({ data }: { data: { settings: string } }) => {
    stored = JSON.parse(data.settings).ai;
    return {};
  });
  db.$queryRaw.mockImplementation(async () => [{ settings: JSON.stringify({ ai: stored }) }]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('writing the ceiling', () => {
  it('saves it, asks for the existing key and no new one, and records the change', async () => {
    const res = await put({ spendCap: { dailyTokens: 50000, monthlyTokens: 1000000 } });
    expect(res.status).toBe(200);
    expect(written().spendCap).toEqual({ dailyTokens: 50000, monthlyTokens: 1000000 });
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(requirePermission).toHaveBeenCalledTimes(1);
    const audit = logAudit.mock.calls.at(-1)![0];
    expect(audit.previousData.spendCap).toEqual({ dailyTokens: null, monthlyTokens: null });
    expect(audit.newData.spendCap).toEqual({ dailyTokens: 50000, monthlyTokens: 1000000 });
  });

  it('a null side is «no ceiling», and both null stores nothing', async () => {
    await put({ spendCap: { dailyTokens: 50000, monthlyTokens: null } });
    expect(written().spendCap).toEqual({ dailyTokens: 50000, monthlyTokens: null });
    await put({ spendCap: { dailyTokens: null, monthlyTokens: null } });
    expect(written().spendCap).toBeUndefined();
  });

  it.each([
    ['zero', { dailyTokens: 0, monthlyTokens: null }],
    ['negative', { dailyTokens: -1, monthlyTokens: null }],
    ['a fraction', { dailyTokens: 1.5, monthlyTokens: null }],
    ['text', { dailyTokens: '100', monthlyTokens: null }],
    ['a typo past the limit', { dailyTokens: 10 ** 12, monthlyTokens: null }],
    ['a field nobody knows', { dailyTokens: 5, monthlyTokens: null, perUser: 3 }],
    ['one side missing', { dailyTokens: 5 }],
  ])('refuses %s with a 400 and writes nothing', async (_name, spendCap) => {
    const res = await put({ spendCap });
    expect(res.status).toBe(400);
    expect(db.company.update).not.toHaveBeenCalled();
  });

  it('whoever may not manage the settings writes nothing', async () => {
    requirePermission.mockRejectedValue(new Error('FORBIDDEN'));
    const res = await put({ spendCap: { dailyTokens: 5, monthlyTokens: null } });
    expect(res.status).not.toBe(200);
    expect(db.company.update).not.toHaveBeenCalled();
  });

  it('a save about something else leaves the ceiling where it was', async () => {
    stored = { ...stored, spendCap: { dailyTokens: 777, monthlyTokens: null } };
    await put({ prompts: { house: 'نص آخر' } });
    expect(written().spendCap).toEqual({ dailyTokens: 777, monthlyTokens: null });
  });
});
