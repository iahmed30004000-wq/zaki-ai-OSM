import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات (تجريبي)» — the switch's door and where it lives (`Company.settings.noAnswerRounds`).
 */

const { store, requirePermission, logAudit, db } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown>, failRead: false };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (store.failRead) throw new Error('db down');
        return { settings: JSON.stringify(store.doc) };
      }),
    },
  };
  return { store, requirePermission: vi.fn(async (_key: string) => undefined), logAudit: vi.fn(), db };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('./db', () => ({ db }));
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
import { forgetRoundsSwitch, roundsSwitch } from '@/lib/no-answer-rounds-switch';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 } };
  store.failRead = false;
  forgetRoundsSwitch();
});

describe('the switch', () => {
  it('is OFF until it is turned on', async () => {
    expect((await (await GET()).json()).rounds).toEqual({ enabled: false, enabledAt: null });
  });

  it('turning it on is the sensitive-settings key, and stores the moment by the server clock', async () => {
    const res = await put({ enabled: true });
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    const data = await res.json();
    expect(data.rounds.enabled).toBe(true);
    expect(Date.now() - new Date(data.rounds.enabledAt).getTime()).toBeLessThan(5_000);
    // Only its own key: the win-back rule beside it is untouched.
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'NO_ANSWER_ROUNDS_SWITCHED' }));
  });

  it('a second «on» keeps the first moment', async () => {
    store.doc.noAnswerRounds = { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' };
    expect((await (await put({ enabled: true })).json()).rounds.enabledAt).toBe('2026-11-01T06:00:00.000Z');
  });

  it('off clears it — the next «on» is a new start — and every door hears it at once in this process', async () => {
    store.doc.noAnswerRounds = { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' };
    expect((await roundsSwitch(db as never, 'c1')).enabled).toBe(true);
    await put({ enabled: false });
    expect(store.doc.noAnswerRounds).toEqual({ enabled: false, enabledAt: null });
    expect((await roundsSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a body that is not a plain yes or no is refused in Arabic', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, enabledAt: '2020-01-01' }]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/نعم أو لا/);
    }
  });

  it('a read that fails is OFF, never on', async () => {
    store.doc.noAnswerRounds = { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' };
    store.failRead = true;
    expect((await roundsSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('and is read once in a while, not once per press', async () => {
    await roundsSwitch(db as never, 'c1', 1_000);
    await roundsSwitch(db as never, 'c1', 5_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(1);
    await roundsSwitch(db as never, 'c1', 12_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(2);
  });
});
