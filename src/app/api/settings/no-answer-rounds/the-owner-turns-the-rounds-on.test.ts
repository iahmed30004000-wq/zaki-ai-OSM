import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «نظام الجولات (تجريبي)» — the switch's door and where it lives (`Company.settings.noAnswerRounds`).
 *
 * UPDATED 2026-11-18 (request C2, decision 7): the door used to TURN the switch (PUT stored `{ enabled, enabledAt }` and wrote an audit row). Its card left «قواعد مركز
 * التأكيد» — the one rule replaced it — so PUT now refuses EVERY write with 409 `RULE_RETIRED`, after asking the same key as before, and writes NOTHING: not the switch,
 * not the date, not an audit row. GET is as it was. The library's own save (`saveRoundsSwitch`, engine code that leaves with C4) is still held below, called directly.
 */

const { store, requirePermission, logAudit, db, updates } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown>, failRead: false };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (store.failRead) throw new Error('db down');
        return { settings: JSON.stringify(store.doc) };
      }),
    },
  };
  return { store, requirePermission: vi.fn(async (_key: string) => undefined), logAudit: vi.fn(), db, updates: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('./db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'owner' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    updates(key);
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import { GET, PUT } from './route';
import { forgetRoundsSwitch, roundsSwitch, saveRoundsSwitch } from '@/lib/no-answer-rounds-switch';
import { RETIRED_SWITCH_AR, RETIRED_SWITCH_CODE } from '@/lib/retired-switch';

const STORED = { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 } };
  store.failRead = false;
  forgetRoundsSwitch();
});

describe('GET is as it was', () => {
  it('is OFF until it is turned on, and reads what is stored', async () => {
    expect((await (await GET()).json()).rounds).toEqual({ enabled: false, enabledAt: null });
    store.doc.noAnswerRounds = STORED;
    forgetRoundsSwitch();
    expect((await (await GET()).json()).rounds).toEqual(STORED);
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });
});

describe('PUT takes no more writes (C2)', () => {
  it('every body — on, off, garbage, none — is refused 409 in Arabic, after the same key as before', async () => {
    for (const body of [{ enabled: true }, { enabled: false }, {}, { enabled: 'yes' }, null]) {
      const res = await PUT();
      expect(res.status, JSON.stringify(body)).toBe(409);
      const data = await res.json();
      expect(data.code).toBe(RETIRED_SWITCH_CODE);
      expect(data.errorAr).toBe(RETIRED_SWITCH_AR);
      expect(data.error).toBe(RETIRED_SWITCH_AR);
      expect(/[A-Za-z]/.test(data.errorAr)).toBe(false);
      expect(data.errorAr).toContain('قواعد مركز التأكيد');
    }
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
  });

  it('writes NOTHING: the stored value (on or off) is exactly what it was, no settings write, no audit row', async () => {
    for (const stored of [STORED, { enabled: false, enabledAt: null }, undefined]) {
      store.doc = { winback: { coolingDays: 14 }, ...(stored ? { noAnswerRounds: stored } : {}) };
      const before = JSON.stringify(store.doc);
      await PUT();
      expect(JSON.stringify(store.doc)).toBe(before);
    }
    expect(updates).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a person without the key is stopped by the key, as before (the refusal is not a way round it)', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await PUT();
    expect(res.status).not.toBe(200);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe('the library under the door (engine code — leaves with C4)', () => {
  it('a save stores the moment by the server clock and keeps the other keys', async () => {
    const saved = await saveRoundsSwitch('c1', true);
    expect(saved.enabled).toBe(true);
    expect(Date.now() - saved.enabledAt!.getTime()).toBeLessThan(5_000);
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
  });

  it('a second «on» keeps the first moment; off clears it and every reader hears it at once', async () => {
    store.doc.noAnswerRounds = STORED;
    expect((await saveRoundsSwitch('c1', true)).enabledAt!.toISOString()).toBe(STORED.enabledAt);
    expect((await roundsSwitch(db as never, 'c1')).enabled).toBe(true);
    await saveRoundsSwitch('c1', false);
    expect(store.doc.noAnswerRounds).toEqual({ enabled: false, enabledAt: null });
    expect((await roundsSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a read that fails is OFF, never on', async () => {
    store.doc.noAnswerRounds = STORED;
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
