import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «أرقام القاعدة» — the door (request Q3a, 19/11; INERT — no engine file reads the stored rule yet).
 *  · reading is `settings.view`; saving and reverting are `settings.manage` — without them 403, nothing stored, no audit row;
 *  · save → read back; «من بداية الدوام الجاي» (the default) is pending until the store's Country starts work, «هلق» acts at once;
 *  · an invalid rule is refused with an Arabic sentence and its field, and nothing changes; a save while one is pending replaces it only;
 *  · «رجّع»: cancels a pending change, goes back to a chosen version, refuses with nothing to go back to; one audit row per change;
 *  · a corrupt stored value reads as the default; every other key of the settings document is left alone.
 */

const { store, granted, logAudit, db, ctx } = vi.hoisted(() => {
  const store = { docs: {} as Record<string, Record<string, unknown>> };
  const db = {
    company: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ settings: JSON.stringify(store.docs[where.id] ?? {}) })) },
  };
  const ctx = { companyId: 'c0' };
  return { store, granted: new Set<string>(), logAudit: vi.fn(), db, ctx };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'owner' },
    companyId: ctx.companyId,
    storeId: 's1',
    countryId: 'k1',
    country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async (k: string) => {
    if (!granted.has(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return { id: 'owner' };
  },
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/company-settings', () => ({
  updateCompanySettings: async (companyId: string, key: string, change: (cur: unknown) => unknown) => {
    const all = (store.docs[companyId] ??= {});
    const next = change(all[key]);
    if (next === undefined) delete all[key];
    else all[key] = next;
    return next;
  },
}));

import { GET, POST, PUT } from './route';
import { CONFIRMATION_RULE_DEFAULT } from '@/lib/confirmation-rule-settings';

let n = 0;
// Thursday 19/11 12:00 in Amman — inside work; the next start is Sunday 22/11 09:00 (Friday and Saturday are rest days).
const NOW = new Date('2026-11-19T12:00:00+03:00');
const NEXT_START = new Date('2026-11-22T09:00:00+03:00').toISOString();

const req = (method: string, body: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (body: unknown) => PUT(req('PUT', body));
const post = (body: unknown) => POST(req('POST', body));
const read = async () => (await (await GET()).json()).confirmationRule;
const rule = (over: Record<string, unknown> = {}) => ({ ...structuredClone(CONFIRMATION_RULE_DEFAULT), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ctx.companyId = `c${++n}`; // the reader caches per company: a fresh one per test
  store.docs[ctx.companyId] = { queueModes: { nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 } };
  granted.clear();
  granted.add('settings.view');
  granted.add('settings.manage');
});
afterEach(() => vi.useRealTimers());

describe('reading', () => {
  it('nothing stored → the default in force, nothing pending, no versions, the ranges and the next start of work', async () => {
    const r = await read();
    expect(r.rule).toEqual({ ...CONFIRMATION_RULE_DEFAULT, attempts: 5 });
    expect(r.pending).toBeNull();
    expect(r.previous).toEqual([]);
    expect(r.defaults).toEqual({ ...CONFIRMATION_RULE_DEFAULT, attempts: 5 });
    expect(r.ranges.hand).toEqual({ min: 1, max: 10 });
    expect(r.nextWorkStart).toBe(NEXT_START);
  });

  it('a corrupt stored value reads as the default', async () => {
    store.docs[ctx.companyId].confirmationRule = { v: 1, current: 'garbage' };
    expect((await read()).rule).toEqual({ ...CONFIRMATION_RULE_DEFAULT, attempts: 5 });
  });

  it('needs settings.view (403 in Arabic without it)', async () => {
    granted.delete('settings.view');
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
  });
});

describe('saving', () => {
  it('«هلق» is in force at once and reads back; the other settings keys are untouched; one audit row', async () => {
    const res = await put({ rule: rule({ hand: 5 }), when: 'NOW' });
    expect(res.status).toBe(200);
    expect((await res.json()).confirmationRule.rule.hand).toBe(5);
    expect((await read()).rule.hand).toBe(5);
    expect(store.docs[ctx.companyId].queueModes).toEqual({ nightFrom: 9, nightTo: 11, peakFrom: 21, peakTo: 24 });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CONFIRMATION_RULE_CHANGED', companyId: ctx.companyId, userId: 'owner', entity: 'Company',
      previousData: { rule: CONFIRMATION_RULE_DEFAULT, pending: null },
      newData: expect.objectContaining({ when: 'NOW', rule: expect.objectContaining({ hand: 5 }) }),
    }));
  });

  it('with no «when» the change waits for the next start of work (the owner’s default) — pending with its moment, then in force', async () => {
    await put({ rule: rule({ hand: 6 }) });
    let r = await read();
    expect(r.rule.hand).toBe(3);
    expect(r.pending).toMatchObject({ effectiveAt: NEXT_START, byUserId: 'owner', rule: expect.objectContaining({ hand: 6 }) });
    vi.setSystemTime(new Date(new Date(NEXT_START).getTime() + 31_000));
    r = await read();
    expect(r.rule.hand).toBe(6);
    expect(r.pending).toBeNull();
  });

  it('a save while one is pending replaces the pending one only', async () => {
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    await put({ rule: rule({ hand: 6 }), when: 'NEXT_WORK_START' });
    const r = (await (await put({ rule: rule({ hand: 7 }), when: 'NEXT_WORK_START' })).json()).confirmationRule;
    expect(r.rule.hand).toBe(4);
    expect(r.pending.rule.hand).toBe(7);
    // the rule in force (4) is the newest version, then the default; the replaced pending 6 never acted and is not a version
    expect(r.previous.map((p: { rule: { hand: number } }) => p.rule.hand)).toEqual([4, 3]);
  });

  it('an invalid rule is refused with an Arabic sentence and its field; nothing stored, no audit row', async () => {
    for (const [body, field] of [
      [{ rule: rule({ hand: 11 }) }, 'hand'],
      [{ rule: rule({ proofSeconds: 14 }) }, 'proofSeconds'],
      [{ rule: rule({ steps: [] }) }, 'steps'],
      [{ rule: rule({ morning: '20:00' }) }, 'evening'],
      [{}, 'rule'],
      [null, 'rule'],
      [{ rule: rule(), when: 'TOMORROW' }, 'when'],
    ] as const) {
      const res = await put(body);
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j.field).toBe(field);
      expect(j.errorAr).toMatch(/[؀-ۿ]/);
      expect(j.code).toMatch(/^INVALID_/);
    }
    expect(store.docs[ctx.companyId].confirmationRule).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('needs settings.manage: 403, nothing stored, no audit row', async () => {
    granted.delete('settings.manage');
    const res = await put({ rule: rule({ hand: 5 }), when: 'NOW' });
    expect(res.status).toBe(403);
    expect(store.docs[ctx.companyId].confirmationRule).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('«رجّع»', () => {
  it('cancels a pending change: the rule in force stays and nothing is pending', async () => {
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    await put({ rule: rule({ hand: 6 }) });
    vi.clearAllMocks();
    const res = await post({ action: 'revert' });
    expect(res.status).toBe(200);
    const r = (await res.json()).confirmationRule;
    expect(r.rule.hand).toBe(4);
    expect(r.pending).toBeNull();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'CONFIRMATION_RULE_REVERTED', newData: expect.objectContaining({ did: 'CANCELLED' }) }));
  });

  it('with nothing pending goes back to the newest previous version, now; a version number picks an older one', async () => {
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    await put({ rule: rule({ hand: 5 }), when: 'NOW' });
    let r = (await (await post({ action: 'revert' })).json()).confirmationRule;
    expect(r.rule.hand).toBe(4);
    expect(r.pending).toBeNull();
    // versions now: 5, 4, 3 (the default) — back to the default
    expect(r.previous.map((p: { rule: { hand: number } }) => p.rule.hand)).toEqual([5, 4, 3]);
    r = (await (await post({ action: 'revert', version: 2 })).json()).confirmationRule;
    expect(r.rule).toEqual({ ...CONFIRMATION_RULE_DEFAULT, attempts: 5 });
  });

  it('a revert may wait for the next start of work too', async () => {
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    const r = (await (await post({ action: 'revert', when: 'NEXT_WORK_START' })).json()).confirmationRule;
    expect(r.rule.hand).toBe(4);
    expect(r.pending).toMatchObject({ effectiveAt: NEXT_START, rule: expect.objectContaining({ hand: 3 }) });
  });

  it('nothing to go back to → 409 in Arabic, no audit row; a bad version or action → 400', async () => {
    let res = await post({ action: 'revert' });
    expect(res.status).toBe(409);
    expect((await res.json()).errorAr).toMatch(/[؀-ۿ]/);
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    vi.clearAllMocks();
    res = await post({ action: 'revert', version: 1 });
    expect(res.status).toBe(409);
    for (const body of [{ action: 'revert', version: -1 }, { action: 'revert', version: 'x' }, { action: 'delete' }, null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(logAudit).not.toHaveBeenCalled();
    expect((await read()).rule.hand).toBe(4);
  });

  it('needs settings.manage', async () => {
    await put({ rule: rule({ hand: 4 }), when: 'NOW' });
    granted.delete('settings.manage');
    vi.clearAllMocks();
    expect((await post({ action: 'revert' })).status).toBe(403);
    expect(logAudit).not.toHaveBeenCalled();
    expect((await read()).rule.hand).toBe(4);
  });
});
