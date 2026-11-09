import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «تسوية السطور النظيفة عند الاعتماد (تجريبي)» — the switch’s door and where it lives (`Company.settings.perLineSettlement`): the twin of
 * «الطلب يرجع للطابور فوراً»’s (`../no-answer-returns/the-owner-turns-the-returns-on.test.ts`), minus the rounds it needed.
 *
 *  · OFF until it is turned on; OFF on any failure to read it; only a real `true` with a real date is on.
 *  · Turning it on is `settings.manage` (reading it, `settings.view`); the moment it went on is the SERVER’s clock; a second «on»
 *    keeps the first moment; «off» clears it; every other key of the settings document is left alone.
 *  · One audit row, with the before and the after; every door hears the change at once in this process.
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
import { forgetPerLineSwitch, parsePerLineSwitch, perLineSettlementOn, perLineSettlementSwitch } from '@/lib/per-line-settlement-switch';

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const STORED = { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  store.doc = { winback: { coolingDays: 14 }, noAnswerRounds: { enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' } };
  store.failRead = false;
  forgetPerLineSwitch();
});

describe('the switch', () => {
  it('is OFF until it is turned on', async () => {
    expect(await (await GET()).json()).toEqual({ perLine: { enabled: false, enabledAt: null } });
  });

  it('reading it is the settings page’s key', async () => {
    await GET();
    expect(requirePermission).toHaveBeenCalledWith('settings.view');
  });

  it('turning it on is the sensitive-settings key, and stores the moment by the server clock', async () => {
    const res = await put({ enabled: true });
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    const data = await res.json();
    expect(data.perLine.enabled).toBe(true);
    expect(Date.now() - new Date(data.perLine.enabledAt).getTime()).toBeLessThan(5_000);
    // Only its own key: the win-back rule and the rounds’ switch beside it are untouched.
    expect(store.doc.winback).toEqual({ coolingDays: 14 });
    expect(store.doc.noAnswerRounds).toEqual({ enabled: true, enabledAt: '2026-11-01T06:00:00.000Z' });
    expect(store.doc.perLineSettlement).toEqual({ enabled: true, enabledAt: data.perLine.enabledAt });
  });

  it('writes ONE audit row, with the before and the after', async () => {
    const data = await (await put({ enabled: true })).json();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1', userId: 'owner', action: 'PER_LINE_SETTLEMENT_SWITCHED', entity: 'Company', entityId: 'c1',
        previousData: { enabled: false, enabledAt: null },
        newData: { enabled: true, enabledAt: data.perLine.enabledAt },
      })
    );
  });

  it('a second «on» keeps the first moment', async () => {
    store.doc.perLineSettlement = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect((await (await put({ enabled: true })).json()).perLine.enabledAt).toBe('2026-11-02T06:00:00.000Z');
  });

  it('off clears it — the next «on» is a new start — and every door hears it at once in this process', async () => {
    store.doc.perLineSettlement = { enabled: true, enabledAt: '2026-11-02T06:00:00.000Z' };
    expect(await perLineSettlementOn(db as never, 'c1')).toBe(true);
    await put({ enabled: false });
    expect(store.doc.perLineSettlement).toEqual({ enabled: false, enabledAt: null });
    expect(await perLineSettlementOn(db as never, 'c1')).toBe(false);
  });

  it('a body that is not a plain yes or no is refused in Arabic, and nothing is stored', async () => {
    for (const body of [{}, { enabled: 'yes' }, { enabled: true, enabledAt: '2020-01-01' }, null]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).errorAr).toMatch(/نعم أو لا/);
    }
    expect(store.doc.perLineSettlement).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('needs no other switch: it can be turned on with «نظام الجولات» off', async () => {
    store.doc = {};
    const res = await put({ enabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).perLine.enabled).toBe(true);
  });

  it('a refused key writes nothing and leaves no audit row', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    const res = await put({ enabled: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(store.doc.perLineSettlement).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('what is stored is read strictly', () => {
  it('a read that fails is OFF, never on', async () => {
    store.doc.perLineSettlement = STORED;
    store.failRead = true;
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('a database with no `company` model at all (a fake that was never taught it) is OFF too', async () => {
    expect((await perLineSettlementSwitch({} as never, 'c1')).enabled).toBe(false);
  });

  it('a broken document, a missing key and a half-written value are all OFF', () => {
    for (const raw of [undefined, null, 'yes', 7, {}, { enabled: true }, { enabled: true, enabledAt: 'nope' }, { enabled: 'true', enabledAt: STORED.enabledAt }, { enabled: false, enabledAt: STORED.enabledAt }]) {
      expect(parsePerLineSwitch(raw), JSON.stringify(raw)).toEqual({ enabled: false, enabledAt: null });
    }
    expect(parsePerLineSwitch(STORED)).toEqual({ enabled: true, enabledAt: new Date(STORED.enabledAt) });
  });

  it('«on» with NO date is OFF: a null, an empty string, a number and a flag are not a date — never “on since 1970”', () => {
    for (const enabledAt of [null, '', 0, 1_762_000_000_000, true]) {
      expect(parsePerLineSwitch({ enabled: true, enabledAt }), JSON.stringify(enabledAt)).toEqual({ enabled: false, enabledAt: null });
    }
  });

  it('a settings document that is not JSON is OFF', async () => {
    db.company.findUnique.mockResolvedValueOnce({ settings: '{not json' } as never);
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
  });

  it('is read once in a while, not once per press', async () => {
    await perLineSettlementSwitch(db as never, 'c1', 1_000);
    await perLineSettlementSwitch(db as never, 'c1', 5_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(1);
    await perLineSettlementSwitch(db as never, 'c1', 12_000);
    expect(db.company.findUnique).toHaveBeenCalledTimes(2);
  });

  it('and the other switches’ keys are not this one’s: one switch on does not turn this on', async () => {
    store.doc = { noAnswerRounds: STORED, noAnswerReturns: STORED };
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
  });
});

describe('what this process remembers never outlives a save', () => {
  it('turning it ON: the very next read — inside the cache’s seconds — is ON, and costs no second look at the database', async () => {
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
    await put({ enabled: true });
    const looked = db.company.findUnique.mock.calls.length;
    const now = await perLineSettlementSwitch(db as never, 'c1');
    expect(now.enabled).toBe(true);
    expect(now.enabledAt).toBeInstanceOf(Date);
    expect(db.company.findUnique.mock.calls.length).toBe(looked);
  });

  it('turning it OFF, after it was on: the next read is OFF at once, the same way', async () => {
    store.doc.perLineSettlement = STORED;
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(true);
    await put({ enabled: false });
    const looked = db.company.findUnique.mock.calls.length;
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
    expect(db.company.findUnique.mock.calls.length).toBe(looked);
  });

  it('the audit row’s “before” is what is STORED, not what this process remembered a moment ago', async () => {
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
    store.doc.perLineSettlement = STORED; // another instance turned it on meanwhile
    await put({ enabled: false });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ previousData: { enabled: true, enabledAt: STORED.enabledAt }, newData: { enabled: false, enabledAt: null } })
    );
  });

  it('the settings page shows what is STORED, not what this process remembered a moment ago', async () => {
    expect((await perLineSettlementSwitch(db as never, 'c1')).enabled).toBe(false);
    store.doc.perLineSettlement = STORED;
    expect((await (await GET()).json()).perLine).toEqual({ enabled: true, enabledAt: STORED.enabledAt });
  });
});
