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
 */

const { store, requirePermission, logAudit, db, rounds } = vi.hoisted(() => {
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
    const next = change(store.doc[key]);
    store.doc[key] = next;
    return next;
  },
}));

import { GET, PUT } from './route';
import { forgetReturnsSwitch, parseReturnsSwitch, returnsSwitch } from '@/lib/no-answer-returns-switch';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
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

  it('turning it on is the sensitive-settings key, and stores the moment by the server clock', async () => {
    const res = await put({ enabled: true });
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    const data = await res.json();
    expect(data.returns.enabled).toBe(true);
    expect(Date.now() - new Date(data.returns.enabledAt).getTime()).toBeLessThan(5_000);
    // Only its own key: the win-back rule and the rounds’ switch beside it are untouched.
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.noAnswerRounds).toEqual(STORED);
    expect(store.doc.noAnswerReturns).toEqual({ enabled: true, enabledAt: data.returns.enabledAt });
  });

  it('writes ONE audit row, with the before and the after', async () => {
    const res = await put({ enabled: true });
    const data = await res.json();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1', userId: 'owner', action: 'NO_ANSWER_RETURNS_SWITCHED', entity: 'Company', entityId: 'c1',
        previousData: { enabled: false, enabledAt: null },
        newData: { enabled: true, enabledAt: data.returns.enabledAt },
      })
    );
  });

  it('a second «on» keeps the first moment', async () => {
    store.doc.noAnswerReturns = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await (await put({ enabled: true })).json()).returns.enabledAt).toBe('2026-11-02T06:00:00.000Z');
  });

  it('off clears it — the next «on» is a new start — and every door hears it at once in this process', async () => {
    store.doc.noAnswerReturns = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(true);
    await put({ enabled: false });
    expect(store.doc.noAnswerReturns).toEqual({ enabled: false, enabledAt: null });
    expect((await returnsSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a body that is not a plain yes or no is refused in Arabic, and nothing is stored', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, enabledAt: '2020-01-01' }, null]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/نعم أو لا/);
    }
    expect(store.doc.noAnswerReturns).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('it needs «نظام الجولات»', () => {
  it('«on» while the rounds are off is refused in Arabic (409), nothing is stored, no audit row', async () => {
    rounds.value = { enabled: false, enabledAt: null };
    const res = await put({ enabled: true });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('ROUNDS_OFF');
    expect(data.errorAr).toBe('لازم «نظام الجولات» يكون شغّال أول — هالمفتاح ما بيشتغل إلا معه.');
    expect(/[A-Za-z]/.test(data.errorAr)).toBe(false);
    expect(store.doc.noAnswerReturns).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('«off» is always allowed — also when the rounds are off, and it says so', async () => {
    rounds.value = { enabled: false, enabledAt: null };
    store.doc.noAnswerReturns = STORED;
    const res = await put({ enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ returns: { enabled: false, enabledAt: null }, roundsOn: false });
    expect(store.doc.noAnswerReturns).toEqual({ enabled: false, enabledAt: null });
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
