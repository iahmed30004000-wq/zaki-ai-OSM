import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «شو القاعدة تبعو لاني ممكن اعدلها» — THE DOOR THE OWNER EDITS IT THROUGH.
 *
 * What the route owes: that only whoever holds `settings.manage` may change how
 * much of the company's money a discount can give away (a supervisor works the
 * list and reads the rule; she does not write it), that a rule outside its bounds
 * is REFUSED with a sentence rather than quietly clamped, that only the `winback`
 * key of the settings document is written, and that the change is written down
 * with what it was and what it became.
 */

const { db, requireContext, requirePermission, logAudit, updateCompanySettings } = vi.hoisted(() => ({
  db: { company: { findUnique: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  updateCompanySettings: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/company-settings', () => ({ updateCompanySettings: (...a: unknown[]) => updateCompanySettings(...a) }));

import { PUT } from './route';

const owner = { id: 'u-owner', name: 'المالك', role: 'COMPANY_ADMIN', status: 'ACTIVE' };
const good = { reasons: ['PRICE_TOO_HIGH', 'OTHER'], coolingDays: 10, lookbackDays: 90, maxDiscountPercent: 12.5 };

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

/** The company's settings document, as the database would hold it: a save changes what the next read returns. */
let stored: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  requireContext.mockResolvedValue({ user: owner, companyId: 'c-42', storeId: 's1' });
  requirePermission.mockResolvedValue(owner);
  db.company.findUnique.mockImplementation(async () => ({ settings: stored }));
  updateCompanySettings.mockImplementation(async (_c: string, key: string, change: (cur: unknown) => unknown) => {
    const doc = stored ? JSON.parse(stored) : {};
    doc[key] = change(doc[key]);
    stored = JSON.stringify(doc);
    return doc[key];
  });
});

const nothingWritten = () => {
  expect(updateCompanySettings).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

describe('who may change it', () => {
  it('— settings.manage, and nothing else: asked by name, before anything is read', async () => {
    await put(good);
    expect(requirePermission).toHaveBeenCalledWith('settings.manage');
    expect(requirePermission.mock.invocationCallOrder[0]).toBeLessThan(db.company.findUnique.mock.invocationCallOrder[0]);
  });

  it('and a supervisor, who works the list, is turned away: 403, nothing read, nothing saved, nothing written down', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.manage'));
    const res = await put(good);
    expect(res.status).toBe(403);
    expect(db.company.findUnique).not.toHaveBeenCalled();
    nothingWritten();
  });
});

describe('what a good rule does', () => {
  /** REWRITTEN ON 28/10: what is saved carries the switch — on, when the body leaves it out. */
  it('— is saved under the `winback` key of THIS company’s settings, the percent as the share the arithmetic reads', async () => {
    const res = await put(good);
    expect(res.status).toBe(200);
    expect(updateCompanySettings).toHaveBeenCalledTimes(1);
    expect(updateCompanySettings.mock.calls[0].slice(0, 2)).toEqual(['c-42', 'winback']);
    const saved = {
      reasons: ['PRICE_TOO_HIGH', 'OTHER'],
      afterShipping: true,
      coolingDays: 10,
      lookbackDays: 90,
      maxDiscountShare: 0.125,
    };
    expect((await res.json()).rule).toEqual(saved);
    // The change function writes the rule whatever was there before — it replaces ITS key and touches no other.
    const change = updateCompanySettings.mock.calls[0][2] as (cur: unknown) => unknown;
    expect(change({ old: 1 })).toEqual(saved);
    expect(change(undefined)).toEqual(saved);
  });

  it('and it is written down: who, what it was, what it became — the default when nothing had been stored', async () => {
    await put(good);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      companyId: 'c-42',
      userId: 'u-owner',
      action: 'WINBACK_RULE_UPDATED',
      entity: 'Company',
      entityId: 'c-42',
      previousData: { coolingDays: 14, lookbackDays: 120, maxDiscountShare: 0.25 },
      newData: { coolingDays: 10, lookbackDays: 90, maxDiscountShare: 0.125, reasons: ['PRICE_TOO_HIGH', 'OTHER'] },
    });
  });

  it('and «what it was» is the stored rule when there was one', async () => {
    stored = JSON.stringify({ winback: { coolingDays: 30, maxDiscountShare: 0.1 }, ai: { key: 'x' } });
    await put(good);
    expect(logAudit.mock.calls[0][0].previousData).toMatchObject({ coolingDays: 30, maxDiscountShare: 0.1 });
  });

  it('and «what it was» is read BEFORE the save — saved twice, the second audit says what the first one saved', async () => {
    await put(good);
    await put({ ...good, coolingDays: 20 });
    expect(logAudit).toHaveBeenCalledTimes(2);
    expect(logAudit.mock.calls[1][0].previousData).toMatchObject({ coolingDays: 10 });
    expect(logAudit.mock.calls[1][0].newData).toMatchObject({ coolingDays: 20 });
  });

  it('and the settings read are THIS company’s, and the other keys of the document are left as they were', async () => {
    stored = JSON.stringify({ ai: { key: 'x' }, winback: { coolingDays: 30 } });
    await put(good);
    expect(db.company.findUnique).toHaveBeenCalledWith({ where: { id: 'c-42' }, select: { settings: true } });
    expect(JSON.parse(stored!).ai).toEqual({ key: 'x' });
    expect(JSON.parse(stored!).winback).toMatchObject({ coolingDays: 10, maxDiscountShare: 0.125 });
  });

  it('and the reasons come back in the editor’s order whatever order they were sent', async () => {
    const res = await put({ ...good, reasons: ['OTHER', 'CUSTOMER_CHANGED_MIND', 'PRICE_TOO_HIGH'] });
    expect((await res.json()).rule.reasons).toEqual(['PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'OTHER']);
  });

  it('and «يشمل المرتجع بعد الشحن» switched off is saved off — and read back off by the next save', async () => {
    const res = await put({ ...good, afterShipping: false });
    expect(res.status).toBe(200);
    expect((await res.json()).rule.afterShipping).toBe(false);
    expect(JSON.parse(stored!).winback.afterShipping).toBe(false);
    // The stored «off» is what the next save says it was.
    await put({ ...good, afterShipping: true });
    expect(logAudit.mock.calls[1][0].previousData).toMatchObject({ afterShipping: false });
    expect(logAudit.mock.calls[1][0].newData).toMatchObject({ afterShipping: true });
  });

  it('and a rule stored before the switch existed reads as on — what «what it was» says', async () => {
    stored = JSON.stringify({ winback: { coolingDays: 30 } });
    await put(good);
    expect(logAudit.mock.calls[0][0].previousData).toMatchObject({ afterShipping: true, coolingDays: 30 });
  });

  it('and the edges of every bound are accepted', async () => {
    for (const body of [
      { ...good, coolingDays: 1, lookbackDays: 30 },
      { ...good, coolingDays: 90, lookbackDays: 365 },
      { ...good, maxDiscountPercent: 0 },
      { ...good, maxDiscountPercent: 50 },
    ]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(200);
    }
  });
});

describe('what is refused, and never clamped', () => {
  it.each([
    ['no reasons', { ...good, reasons: [] }, 'REASONS'],
    ['a duplicate order', { ...good, reasons: ['PRICE_TOO_HIGH', 'DUPLICATE_ORDER'] }, 'REASONS'],
    ['a wrong number', { ...good, reasons: ['WRONG_NUMBER'] }, 'REASONS'],
    ['a fake order', { ...good, reasons: ['FAKE_ORDER'] }, 'REASONS'],
    ['an entry error', { ...good, reasons: ['MODERATOR_DATA_ERROR'] }, 'REASONS'],
    ['a reason that does not exist', { ...good, reasons: ['SOMETHING'] }, 'REASONS'],
    ['no cooling', { ...good, coolingDays: 0 }, 'COOLING_DAYS'],
    ['a cooling past the ceiling', { ...good, coolingDays: 91 }, 'COOLING_DAYS'],
    ['a look-back under a month', { ...good, lookbackDays: 29 }, 'LOOKBACK_DAYS'],
    ['a look-back past a year', { ...good, lookbackDays: 366 }, 'LOOKBACK_DAYS'],
    ['a look-back no longer than the cooling', { ...good, coolingDays: 60, lookbackDays: 60 }, 'LOOKBACK_DAYS'],
    ['«500%»', { ...good, maxDiscountPercent: 500 }, 'MAX_DISCOUNT'],
    ['a negative discount', { ...good, maxDiscountPercent: -1 }, 'MAX_DISCOUNT'],
    ['a field nobody asked for', { ...good, companyId: 'c2' }, 'UNKNOWN_FIELD'],
    ['a field nobody asked for, beside the switch', { ...good, afterShipping: true, shipped: true }, 'UNKNOWN_FIELD'],
    ['a switch that is the word «true»', { ...good, afterShipping: 'true' }, 'AFTER_SHIPPING'],
    ['a switch that is a one', { ...good, afterShipping: 1 }, 'AFTER_SHIPPING'],
    ['a switch that is nothing', { ...good, afterShipping: null }, 'AFTER_SHIPPING'],
    ['a body that is not a rule', [1, 2], 'BAD_BODY'],
    ['a body that is not JSON', '{nope', 'BAD_BODY'],
    ['no body', 'null', 'BAD_BODY'],
  ])('— %s: 400 with a sentence and a code, nothing saved, nothing written down', async (_what, body, code) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe(code);
    expect(json.errorAr.length).toBeGreaterThan(5);
    expect(json.error).toBe(json.errorAr);
    nothingWritten();
  });

  it('and a switch that is not a yes or a no is refused in his language, naming it', async () => {
    const res = await put({ ...good, afterShipping: 'yes' });
    expect(res.status).toBe(400);
    expect((await res.json()).errorAr).toBe('يشمل المرتجع بعد الشحن: نعم أو لا فقط');
    nothingWritten();
  });

  it('and a field that names another company is a refusal, not a different company’s rule — the company is the session’s', async () => {
    expect((await put({ ...good, companyId: 'c2' })).status).toBe(400);
    expect(updateCompanySettings).not.toHaveBeenCalled();
    await put(good);
    expect(updateCompanySettings.mock.calls[0][0]).toBe('c-42');
  });
});
