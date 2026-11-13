import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE AUDIT TRAIL DOES NOT HAND THE PARTNERS' SHARES AND DRAWS TO WHOEVER MAY READ THE TRAIL.
 *
 * `audit.view` is what the accountant and the settlement officer hold; `finance.partners` is the owner's
 * alone. The partners' two doors write a row each — «حفظ الشركاء» (every name and share, before and after)
 * and «سحب شريك» (the partner, the amount, its value, the note) — and the trail used to return both,
 * verbatim, to anybody with `audit.view`.
 *
 * This runs the REAL partners door, the REAL draw door and the REAL audit door, one after the other, over
 * one in-memory store, and reads what each kind of reader receives from the last. Nothing between the
 * doors is stubbed but the database, the session and the writer of the audit row (which stores exactly what
 * lib/audit.ts stores: the two payloads as JSON text).
 */

type Row = Record<string, any>;

const { S, db, current, requireContext } = vi.hoisted(() => {
  const S = { partner: [] as Row[], wallet: [] as Row[], walletMovement: [] as Row[], auditLog: [] as Row[], seq: 0 };
  const current = { keys: [] as string[] };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    partner: {
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const p = S.partner.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `00000000-0000-4000-8000-${String(++S.seq).padStart(12, '0')}`, ...data };
        S.partner.push(row);
        return row;
      }),
    },
    wallet: { findFirst: vi.fn(async ({ where }: { where: Row }) => S.wallet.find((w) => w.id === where.id) ?? null) },
    walletMovement: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `00000000-0000-4000-9000-${String(++S.seq).padStart(12, '0')}`, createdAt: new Date(), ...data };
        S.walletMovement.push(row);
        return row;
      }),
    },
  };
  const db = {
    partner: {
      findMany: vi.fn(async () => S.partner.map((p) => ({ ...p }))),
      findFirst: vi.fn(async ({ where }: { where: Row }) => S.partner.find((p) => p.id === where.id) ?? null),
    },
    wallet: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const w = S.wallet.find((x) => x.id === where.id);
        return w ? { ...w, country: { minorUnit: 2 } } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Row }) => S.wallet.find((x) => x.id === where.id) ?? null),
    },
    walletMovement: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })), count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    auditLog: {
      count: vi.fn(async () => S.auditLog.length),
      findMany: vi.fn(async () => S.auditLog.map((r) => ({ ...r, user: { id: 'u1', name: 'المالك', email: 'o@x.test', role: 'SUPER_ADMIN' } }))),
      groupBy: vi.fn(async () => []),
    },
    user: { findMany: vi.fn(async () => []) },
  };
  return { S, db, current, requireContext: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/auth', () => ({ requireCompanyTenant: async () => ({ companyId: 'c1' }) }));
vi.mock('@/lib/audit', () => ({
  // exactly what lib/audit.ts stores: the two payloads as JSON text
  logAudit: async (arg: Row) => {
    S.auditLog.push({
      id: `a${S.auditLog.length + 1}`,
      companyId: arg.companyId,
      userId: arg.userId,
      action: arg.action,
      entity: arg.entity,
      entityId: arg.entityId,
      previousData: arg.previousData ? JSON.stringify(arg.previousData) : null,
      newData: arg.newData ? JSON.stringify(arg.newData) : null,
      createdAt: new Date('2026-11-13T09:00:00.000Z'),
    });
  },
}));
// The engine is the keys a reader holds: nothing else decides here.
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
    return { id: 'viewer' };
  },
}));

import { PUT } from '@/app/api/finance/partners/route';
import { POST as DRAW } from '@/app/api/finance/partners/draws/route';
import { GET as AUDIT } from '@/app/api/audit-logs/route';
import { withoutPartners } from '@/lib/audit-partners-redact';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const W = '11111111-1111-4111-8111-111111111111';

const NAMES = ['شريك أ', 'شريك ب', 'شريك ج', 'شريك د'];
const AMOUNT = 4321.5;
const NOTE = 'سحب لأجل التوسعة';

/** The owner: holds everything the two doors ask. */
const OWNER = ['audit.view', 'finance.view', 'finance.partners', 'finance.cashbox'];
/** The accountant template: the trail, the finance screens, the cash box to look at — and not the partners. */
const ACCOUNTANT = ['audit.view', 'finance.view', 'finance.cashbox_view'];

beforeEach(() => {
  for (const k of ['partner', 'wallet', 'walletMovement', 'auditLog'] as const) S[k].length = 0;
  S.seq = 0;
  // one partner already saved, with another share, so the row has a «before» as well as an «after»
  S.partner.push({ id: P1, companyId: 'c1', name: NAMES[0], sharePercent: 40, isActive: true, sortOrder: 0, createdAt: new Date(0) });
  S.wallet.push({ id: W, companyId: 'c1', storeId: 's1', name: 'الصندوق', currencyCode: 'USD', isActive: true });
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المالك' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
});

/** The owner saves four partners and records one draw, through the two real doors. */
async function theOwnerWrites() {
  current.keys = OWNER;
  const saved = await PUT(
    new Request('http://x/api/finance/partners', {
      method: 'PUT',
      body: JSON.stringify({
        partners: [
          { id: P1, name: NAMES[0], sharePercent: 15, isActive: true },
          { name: NAMES[1], sharePercent: 15, isActive: true },
          { name: NAMES[2], sharePercent: 15, isActive: true },
          { name: NAMES[3], sharePercent: 55, isActive: true },
        ],
      }),
    })
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const drew = await DRAW(new Request('http://x/api/finance/partners/draws', { method: 'POST', body: JSON.stringify({ walletId: W, partnerId: P1, amount: AMOUNT, note: NOTE }) }));
  expect(drew.status, await drew.clone().text()).toBe(201);
}

/** What a reader holding exactly these keys receives from the REAL audit door. */
async function trailAs(keys: string[]) {
  current.keys = keys;
  const res = await AUDIT(new Request('http://x/api/audit-logs'));
  expect(res.status).toBe(200);
  const body = await res.json();
  const rowOf = (action: string) => body.logs.find((l: Row) => l.action === action);
  return { body, text: JSON.stringify(body), saved: rowOf('PARTNERS_SAVED'), drew: rowOf('PARTNER_DRAW_RECORDED'), rowOf };
}

describe('a reader with the trail and without the partners key', () => {
  it('both rows are still there — who, when, what kind — and the partners’ names, shares and amounts are not', async () => {
    await theOwnerWrites();
    const { saved, drew } = await trailAs(ACCOUNTANT);

    // the rows stay: that something happened, to what, by whom and when
    expect(saved).toBeDefined();
    expect(drew).toBeDefined();
    expect(saved).toMatchObject({ action: 'PARTNERS_SAVED', entity: 'Partner', user: { name: 'المالك' } });
    expect(drew).toMatchObject({ action: 'PARTNER_DRAW_RECORDED', entity: 'WalletMovement', user: { name: 'المالك' } });
    expect(saved.createdAt).toBeTruthy();
    expect(drew.createdAt).toBeTruthy();

    // the list: nothing of it, and the row says why
    expect(saved.previousData).toBeNull();
    expect(saved.newData).toBeNull();
    expect(saved.partnersWithheld).toBe(true);

    // the draw: only where the money left from, and the row says why
    expect(JSON.parse(drew.newData)).toEqual({ wallet: 'الصندوق', currencyCode: 'USD', storeCurrency: 'USD' });
    expect(drew.partnersWithheld).toBe(true);
  });

  it('and nowhere in the whole answer: not a name, not a share field, not the amount, not the note', async () => {
    await theOwnerWrites();
    const { text } = await trailAs(ACCOUNTANT);
    for (const name of NAMES) expect(text, name).not.toContain(name);
    expect(text).not.toContain('sharePercent');
    expect(text).not.toContain('valueInStoreCurrency');
    expect(text).not.toContain(String(AMOUNT));
    expect(text).not.toContain(NOTE);
  });

  it('the draw’s own row id and the company stay readable: the row is still a row, the record still has its id', async () => {
    await theOwnerWrites();
    const { drew, saved } = await trailAs(ACCOUNTANT);
    expect(drew.entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.entityId).toBe('c1');
  });
});

describe('a reader with the trail AND the partners key', () => {
  it('reads the rows exactly as they were written, and no row says anything was withheld', async () => {
    await theOwnerWrites();
    const { saved, drew } = await trailAs(['audit.view', 'finance.partners']);

    expect(saved.partnersWithheld).toBeUndefined();
    expect(drew.partnersWithheld).toBeUndefined();
    expect(JSON.parse(saved.newData).partners.map((p: Row) => [p.name, p.sharePercent])).toEqual([
      [NAMES[0], 15],
      [NAMES[1], 15],
      [NAMES[2], 15],
      [NAMES[3], 55],
    ]);
    // the «before» of the first save is the one partner that was already there, with the share she had
    expect(JSON.parse(saved.previousData).partners.map((p: Row) => [p.name, p.sharePercent])).toEqual([[NAMES[0], 40]]);
    expect(JSON.parse(drew.newData)).toMatchObject({ wallet: 'الصندوق', partner: NAMES[0], amount: AMOUNT, currencyCode: 'USD', storeCurrency: 'USD', note: NOTE });
  });
});

describe('the two cuts are independent', () => {
  const PAY_ROW = {
    id: 'pay-1', companyId: 'c1', userId: 'u1', action: 'SALARY_PAID', entity: 'Payslip', entityId: 'p-1',
    previousData: null, newData: JSON.stringify({ month: '2026-10', net: 380, paid: 380 }), createdAt: new Date('2026-11-13T09:05:00.000Z'),
  };

  it('«عرض الرواتب» opens the salaries and leaves the partners cut', async () => {
    await theOwnerWrites();
    S.auditLog.push(PAY_ROW);
    const { rowOf } = await trailAs(['audit.view', 'payroll.view']);
    expect(JSON.parse(rowOf('SALARY_PAID').newData).net).toBe(380);
    expect(rowOf('SALARY_PAID').payWithheld).toBeUndefined();
    expect(rowOf('PARTNERS_SAVED').partnersWithheld).toBe(true);
    expect(rowOf('PARTNER_DRAW_RECORDED').partnersWithheld).toBe(true);
  });

  it('the partners key opens the partners and leaves the salaries cut', async () => {
    await theOwnerWrites();
    S.auditLog.push(PAY_ROW);
    const { rowOf } = await trailAs(['audit.view', 'finance.partners']);
    expect(rowOf('SALARY_PAID').payWithheld).toBe(true);
    expect(JSON.parse(rowOf('SALARY_PAID').newData)).toEqual({ month: '2026-10' });
    expect(rowOf('PARTNERS_SAVED').partnersWithheld).toBeUndefined();
    expect(JSON.parse(rowOf('PARTNER_DRAW_RECORDED').newData).amount).toBe(AMOUNT);
  });

  it('both keys: nothing is cut; neither: both are', async () => {
    await theOwnerWrites();
    S.auditLog.push(PAY_ROW);
    const both = await trailAs(['audit.view', 'payroll.view', 'finance.partners']);
    expect(both.rowOf('SALARY_PAID').payWithheld).toBeUndefined();
    expect(both.rowOf('PARTNERS_SAVED').partnersWithheld).toBeUndefined();
    const neither = await trailAs(['audit.view']);
    expect(neither.rowOf('SALARY_PAID').payWithheld).toBe(true);
    expect(neither.rowOf('PARTNERS_SAVED').partnersWithheld).toBe(true);
  });
});

describe('the cut is by what the row IS, not by the record kind a draw shares with every wallet row', () => {
  it('an ordinary wallet movement — same entity as a draw — reaches the accountant whole, with no «withheld» mark', async () => {
    await theOwnerWrites();
    S.auditLog.push({
      id: 'w-1', companyId: 'c1', userId: 'u1', action: 'WALLET_MOVEMENT_RECORDED', entity: 'WalletMovement', entityId: 'm-1',
      previousData: null, newData: JSON.stringify({ wallet: 'الصندوق', direction: 'OUT', amount: 12.5, note: 'بنزين' }), createdAt: new Date('2026-11-13T09:10:00.000Z'),
    });
    const { rowOf } = await trailAs(ACCOUNTANT);
    expect(JSON.parse(rowOf('WALLET_MOVEMENT_RECORDED').newData)).toEqual({ wallet: 'الصندوق', direction: 'OUT', amount: 12.5, note: 'بنزين' });
    expect(rowOf('WALLET_MOVEMENT_RECORDED').partnersWithheld).toBeUndefined();
  });
});

describe('withoutPartners, on one row', () => {
  const draw = (data: unknown) => ({ action: 'PARTNER_DRAW_RECORDED', entity: 'WalletMovement', previousData: null, newData: JSON.stringify(data) });

  it('an allow-list: a field added to the draw’s payload tomorrow is held back until somebody decides it is safe', () => {
    const cut = withoutPartners(draw({ wallet: 'الصندوق', currencyCode: 'USD', storeCurrency: 'USD', partner: NAMES[0], amount: 1, bonus: 7 }));
    expect(JSON.parse(cut.newData!)).toEqual({ wallet: 'الصندوق', currencyCode: 'USD', storeCurrency: 'USD' });
    expect(cut.partnersWithheld).toBe(true);
  });

  it('text that is not JSON on a partners’ row does not leave: it could be anything', () => {
    const cut = withoutPartners({ action: 'PARTNERS_SAVED', entity: 'Partner', previousData: `${NAMES[0]} 40%`, newData: null });
    expect(cut.previousData).toBeNull();
    expect(cut.partnersWithheld).toBe(true);
  });

  it('a row that is not about the partners comes back as the very same row', () => {
    const row = { action: 'WALLET_MOVEMENT_RECORDED', entity: 'WalletMovement', previousData: null, newData: JSON.stringify({ amount: 5 }) };
    expect(withoutPartners(row)).toBe(row);
  });

  it('names that happen to be words on Object’s prototype are not mistaken for a partners’ row', () => {
    for (const word of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const row = { action: word, entity: word, previousData: null, newData: JSON.stringify({ amount: 5 }) };
      expect(withoutPartners(row)).toBe(row);
    }
  });

  it('a partners’ row with nothing in it says nothing was withheld', () => {
    expect(withoutPartners({ action: 'PARTNERS_SAVED', entity: 'Partner', previousData: null, newData: null }).partnersWithheld).toBeUndefined();
    expect(withoutPartners(draw({ wallet: 'الصندوق', currencyCode: 'USD', storeCurrency: 'USD' })).partnersWithheld).toBeUndefined();
  });
});
