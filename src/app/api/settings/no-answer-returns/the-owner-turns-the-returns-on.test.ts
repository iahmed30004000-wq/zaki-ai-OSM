import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الطلب يرجع للطابور فوراً (تجريبي)» — the switch’s door and where it lives (`Company.settings.noAnswerReturns`): the twin of
 * «نظام الجولات»’ (`../no-answer-rounds/the-owner-turns-the-rounds-on.test.ts`), plus what is its own — it needs the rounds.
 *
 *  · OFF until it is turned on; OFF on any failure to read it; only a real `true` with a real date is on.
 *  · Turning it on is `settings.manage` (reading it, `settings.view`); the moment it went on is the SERVER’s clock; a second «on»
 *    keeps the first moment; «off» clears it; every other key of the settings document is left alone.
 *  · One audit row, with the before and the after; every door hears the change at once in this process.
 *  · It does nothing without «نظام الجولات»: GET says whether the rounds are on, PUT refuses «on» while they are off (409 in Arabic,
 *    nothing stored, no audit row) — «off» is always allowed.
 *
 * UPDATED 2026-11-18 (request C2, decision 7): the door used to TURN the switch (the bullets above about PUT). Its card left «قواعد مركز التأكيد» — the one rule replaced
 * it — so PUT now refuses EVERY write, on or off, with 409 `RULE_RETIRED` after asking the same key, and writes NOTHING (no switch, no date, no audit row; «ROUNDS_OFF»
 * is gone with it). GET is as it was. The library's save (`saveReturnsSwitch`, engine code that leaves with C4) is still held below, called directly.
 */

const { store, requirePermission, logAudit, db, rounds, updates } = vi.hoisted(() => {
  const store = { doc: {} as Record<string, unknown>, failRead: false };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (store.failRead) throw new Error('db down');
        return { settings: JSON.stringify(store.doc) };
      }),
    },
  };
  return {
    store,
    requirePermission: vi.fn(async (_key: string) => undefined),
    logAudit: vi.fn(),
    db,
    updates: vi.fn(),
    rounds: { value: { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') } as { enabled: boolean; enabledAt: Date | null } },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('./db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'owner' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (k: string) => requirePermission(k) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => rounds.value }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    updates(key);
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import { GET, PUT } from './route';
import { forgetReturnsSwitch, parseReturnsSwitch, returnsSwitch, saveReturnsSwitch } from '@/lib/no-answer-returns-switch';
import { RETIRED_SWITCH_AR, RETIRED_SWITCH_CODE } from '@/lib/retired-switch';

/** The library's save, as the door used to call it (C2: the door no longer does). Answers what the door answered then. */
const save = async (enabled: boolean) => ({ returns: await saveReturnsSwitch('c1', enabled) });
const iso = (sw: { enabled: boolean; enabledAt: Date | null }) => ({ enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null });
const STORED = { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 }, noAnswerRounds: STORED };
  store.failRead = false;
  rounds.value = { enabled: true, enabledAt: new Date('2026-11-01T06:00:00.000Z') };
  forgetReturnsSwitch();
});

describe('the switch', () => {
  it('is OFF until it is turned on — and the answer says whether the rounds beside it are on', async () => {
    expect(await (await GET()).json()).toEqual({ returns: { enabled: false, enabledAt: null }, roundsOn: true });
    rounds.value = { enabled: false, enabledAt: null };
    expect((await (await GET()).json()).roundsOn).toBe(false);
  });

  it('reading it is the settings page’s key', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('PUT takes no more writes (C2): every body is refused 409 in Arabic, after the same key as before', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await PUT();
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.code).toBe(RETIRED_SWITCH_CODE);
      expect(data.errorAr).toBe(RETIRED_SWITCH_AR);
      expect(/[A-Za-z]/.test(data.errorAr)).toBe(false);
      expect(data.code).not.toBe('ROUNDS_OFF');
    }
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
  });

  it('PUT writes NOTHING, the rounds on or off: the stored values are exactly what they were, no settings write, no audit row', async () => {
    for (const roundsValue of [{ enabled: true, enabledAt: new Date(STORED.enabledAt) }, { enabled: false, enabledAt: null }]) {
      rounds.value = roundsValue;
      for (const stored of [STORED, { enabled: false, enabledAt: null }, undefined]) {
        store.doc = { winback: { coolingDays: 14 }, noAnswerRounds: STORED, ...(stored ? { noAnswerReturns: stored } : {}) };
        const before = JSON.stringify(store.doc);
        await PUT();
        expect(JSON.stringify(store.doc)).toBe(before);
      }
    }
    expect(updates).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('the library\'s save stores the moment by the server clock and leaves the other keys alone', async () => {
    const data = iso((await save(true)).returns);
    expect(data.enabled).toBe(true);
    expect(Date.now() - new Date(data.enabledAt!).getTime()).toBeLessThan(5_000);
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.noAnswerRounds).toEqual(STORED);
    expect(store.doc.noAnswerReturns).toEqual(data);
  });

  it('a second «on» keeps the first moment', async () => {
    store.doc.noAnswerReturns = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect(iso((await save(true)).returns).enabledAt).toBe('2026-11-02T06:00:00.000Z');
  });

  it('off clears it — the next «on» is a new start — and every door hears it at once in this process', async () => {
    store.doc.noAnswerReturns = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(true);
    await save(false);
    expect(store.doc.noAnswerReturns).toEqual({ enabled: false, enabledAt: null });
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
  });
});

describe('what is stored is read strictly', () => {
  it('a read that fails is OFF, never on', async () => {
    store.doc.noAnswerReturns = STORED;
    store.failRead = true;
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a broken document, a missing key and a half-written value are all OFF', () => {
    for (const raw of [undefined, null, 'yes', 7, {}, { enabled: true }, { enabled: true, enabledAt: 'nope' }, { enabled: 'true', enabledAt: STORED.enabledAt }, { enabled: false, enabledAt: STORED.enabledAt }]) {
      expect(parseReturnsSwitch(raw), JSON.stringify(raw)).toEqual({ enabled: false, enabledAt: null });
    }
    expect(parseReturnsSwitch(STORED)).toEqual({ enabled: true, enabledAt: new Date(STORED.enabledAt) });
  });

  it('«on» with NO date is OFF: a null, an empty string, a number and a flag are not a date — never “on since 1970”', () => {
    // `new Date(null)` and `new Date(0)` are the epoch, a perfectly valid date: only a real string may be the moment it went on.
    for (const enabledAt of [null, '', 0, 1_762_000_000_000, true]) {
      expect(parseReturnsSwitch({ enabled: true, enabledAt }), JSON.stringify(enabledAt)).toEqual({ enabled: false, enabledAt: null });
    }
  });

  it('…and the settings page draws it OFF too, from the stored document itself', async () => {
    for (const enabledAt of [null, 0]) {
      forgetReturnsSwitch();
      store.doc.noAnswerReturns = { enabled: true, enabledAt };
      expect(await (await GET()).json()).toEqual({ returns: { enabled: false, enabledAt: null }, roundsOn: true });
      expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
    }
  });

  it('is read once in a while, not once per press', async () => {
    await returnsSwitch(db as never, 'c1', 1_000);
    await returnsSwitch(db as never, 'c1', 5_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(1);
    await returnsSwitch(db as never, 'c1', 12_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(2);
  });

  it('and the rounds’ own key is not the mode’s: one switch on does not turn the other on', async () => {
    store.doc = { noAnswerRounds: STORED };
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
  });
});

describe('what this process remembers never outlives a save', () => {
  it('turning it ON: the very next read — inside the cache’s seconds — is ON, and costs no second look at the database', async () => {
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false); // this process remembers: off
    await save(true);
    const looked = db.company.findUnique.mock.calls.length;
    const now = await returnsSwitch(db as never, 'c1');
    expect(now.enabled).toBe(true);
    expect(now.enabledAt).toBeInstanceOf(Date);
    // The save REPLACED the cached value with the new one; it did not just forget it (which would cost the next door a read).
    expect(db.company.findUnique.mock.calls.length).toBe(looked);
  });

  it('turning it OFF, after it was on: the next read is OFF at once, the same way', async () => {
    store.doc.noAnswerReturns = STORED;
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(true);
    await save(false);
    const looked = db.company.findUnique.mock.calls.length;
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
    expect(db.company.findUnique.mock.calls.length).toBe(looked);
  });

  it('the settings page shows what is STORED, not what this process remembered a moment ago', async () => {
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false); // remembered: off
    store.doc.noAnswerReturns = STORED; // another instance turned it on meanwhile
    expect((await (await GET()).json()).returns).toEqual({ enabled: true, enabledAt: STORED.enabledAt });
  });
});
