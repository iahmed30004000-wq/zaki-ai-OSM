import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الشركاء والنسب» — THE DOOR THAT SAVES THE PARTNERS (13/11).
 *
 * «هلأ احنا ٤ شركاء: محمد كوري 15% · عبدالله كيوان 15% · محمد كيوان 15% · احمد كيوان 55%». The list is saved as a whole and only if
 * it is whole: the active shares total exactly 100.00, every partner already saved is in the request, nobody is deleted, and the key
 * is asked before a byte of the body is read. Driven through the real GET and PUT over an in-memory partners table.
 */

type Row = Record<string, any>;

const { db, tables, current, logAudit, requireContext } = vi.hoisted(() => {
  const tables = { partner: [] as Row[] };
  let seq = 0;
  const db = {
    partner: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        tables.partner.filter((p) => p.companyId === where.companyId).sort((a, b) => a.sortOrder - b.sortOrder)
      ),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = tables.partner.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, createdAt: new Date(), isActive: true, ...data };
        tables.partner.push(row);
        return { ...row };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, tables, current: { keys: [] as string[] }, logAudit: vi.fn(), requireContext: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
// THE KEYED ENGINE: a person is a list of keys, and every question is answered from it.
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { GET, PUT } from './route';

const FOUR = [
  { name: 'محمد كوري', sharePercent: 15, isActive: true },
  { name: 'عبدالله كيوان', sharePercent: 15, isActive: true },
  { name: 'محمد كيوان', sharePercent: 15, isActive: true },
  { name: 'احمد كيوان', sharePercent: 55, isActive: true },
];
const ALL_FINANCE_BUT_PARTNERS = [
  'finance.view', 'finance.create', 'finance.update', 'finance.cashbox_view', 'finance.cashbox', 'finance.wallets_manage',
  'finance.closing_approve', 'settlement.view', 'settlement.approve', 'costs.view',
];

const put = (body: unknown) => PUT(new Request('http://localhost/api/finance/partners', { method: 'PUT', body: JSON.stringify(body) }));
const get = () => GET();
const saved = () => tables.partner.filter((p) => p.companyId === 'c1');

beforeEach(() => {
  vi.clearAllMocks();
  tables.partner.length = 0;
  current.keys = ['finance.view', 'finance.partners'];
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
});

describe('the key is asked FIRST', () => {
  it('a person who holds EVERY other finance key but not «الشركاء والسحوبات» is refused on both doors — 403, and nothing is read', async () => {
    current.keys = ALL_FINANCE_BUT_PARTNERS;
    const unread = { json: vi.fn() };
    const refusedPut = await PUT(unread as unknown as Request);
    expect(refusedPut.status).toBe(403);
    expect((await refusedPut.json()).error).toContain('finance.partners');
    expect(unread.json, 'the body was read before the key was asked').not.toHaveBeenCalled();
    const refusedGet = await get();
    expect(refusedGet.status).toBe(403);
    expect(db.partner.findMany).not.toHaveBeenCalled();
    expect(db.partner.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a person with no key at all is refused the same way', async () => {
    current.keys = [];
    expect((await put({ partners: FOUR })).status).toBe(403);
    expect((await get()).status).toBe(403);
  });

  it('the Arabic sentence names the key by its catalog name', async () => {
    current.keys = ALL_FINANCE_BUT_PARTNERS;
    const body = await (await get()).json();
    expect(body.errorAr).toContain('الشركاء والسحوبات');
  });
});

describe('the first save: the owner’s four, typed on the card', () => {
  it('writes the four, in the order given, and answers with the list and its total of exactly 100', async () => {
    const res = await put({ partners: FOUR });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partners.map((p: Row) => [p.name, p.sharePercent, p.isActive, p.sortOrder])).toEqual([
      ['محمد كوري', 15, true, 0], ['عبدالله كيوان', 15, true, 1], ['محمد كيوان', 15, true, 2], ['احمد كيوان', 55, true, 3],
    ]);
    expect(body.sharesTotal).toBe(100);
    expect(saved()).toHaveLength(4);
    expect(db.partner.create).toHaveBeenCalledTimes(4);
    expect(db.partner.create.mock.calls[0][0].data).toMatchObject({ companyId: 'c1', name: 'محمد كوري', sharePercent: 15, sortOrder: 0 });
  });

  it('is ONE transaction, and is written to the audit trail with before and after', async () => {
    await put({ partners: FOUR });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0]).toMatchObject({ action: 'PARTNERS_SAVED', companyId: 'c1', userId: 'u1', previousData: { partners: [] } });
    expect(logAudit.mock.calls[0][0].newData.partners).toHaveLength(4);
  });

  it('a share typed as characters is read strictly and stored as a clean two-decimal figure', async () => {
    await put({
      partners: [
        { name: 'شريك أ', sharePercent: '33.33', isActive: true },
        { name: 'شريك ب', sharePercent: '33.33', isActive: true },
        { name: 'شريك ج', sharePercent: '33.34', isActive: true },
      ],
    });
    expect(saved().map((p) => p.sharePercent)).toEqual([33.33, 33.33, 33.34]);
  });

  it('GET answers with what is saved, and the total of the active shares', async () => {
    await put({ partners: FOUR });
    const body = await (await get()).json();
    expect(body.partners).toHaveLength(4);
    expect(body.sharesTotal).toBe(100);
  });

  it('GET on a company with no partners: an empty list and a total of zero — the card shows the four as rows to edit', async () => {
    const body = await (await get()).json();
    expect(body).toEqual({ partners: [], sharesTotal: 0 });
  });
});

describe('a list that is not whole is refused, and nothing is written', () => {
  const refused = async (partners: unknown, code: string) => {
    const res = await put({ partners });
    expect(res.status, code).toBe(400);
    expect((await res.json()).code).toBe(code);
    expect(db.partner.create).not.toHaveBeenCalled();
    expect(db.partner.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  };

  it('99.99 and 100.01 — the total is exactly 100.00 or it is not saved', async () => {
    await refused([{ ...FOUR[0], sharePercent: 14.99 }, ...FOUR.slice(1)], 'SHARES_NOT_100');
    await refused([{ ...FOUR[0], sharePercent: 15.01 }, ...FOUR.slice(1)], 'SHARES_NOT_100');
  });

  it('nobody, nobody active, a repeated name, a short name, a share of zero, of 120, of three decimals', async () => {
    await refused([], 'NO_PARTNERS');
    await refused(FOUR.map((p) => ({ ...p, isActive: false })), 'NO_ACTIVE');
    await refused([FOUR[0], { ...FOUR[1], name: FOUR[0].name }, FOUR[2], FOUR[3]], 'NAME_TWICE');
    await refused([{ ...FOUR[0], name: 'ا' }, ...FOUR.slice(1)], 'NAME_REQUIRED');
    await refused([{ ...FOUR[0], sharePercent: 0 }, ...FOUR.slice(1)], 'SHARE_INVALID');
    await refused([{ ...FOUR[0], sharePercent: 120 }, ...FOUR.slice(1)], 'SHARE_INVALID');
    await refused([{ ...FOUR[0], sharePercent: 15.123 }, ...FOUR.slice(1)], 'SHARE_INVALID');
  });

  it('a share that is not a number — «2,5», «0x10», nothing — is refused by the strict reader', async () => {
    for (const bad of ['2,5', '0x10', '', 'abc', null]) {
      const res = await put({ partners: [{ ...FOUR[0], sharePercent: bad }, ...FOUR.slice(1)] });
      expect(res.status, String(bad)).toBe(400);
    }
    expect(db.partner.create).not.toHaveBeenCalled();
  });

  it('a body that is not the shape at all is a 400, not a crash', async () => {
    for (const bad of [null, {}, { partners: 'x' }, { partners: [{ name: 5 }] }]) {
      expect((await put(bad)).status).toBe(400);
    }
  });
});

describe('a later save: the list is a whole, and nobody is deleted', () => {
  beforeEach(async () => {
    await put({ partners: FOUR });
    vi.clearAllMocks();
  });

  const withIds = () => saved().map((p) => ({ id: p.id, name: p.name, sharePercent: p.sharePercent, isActive: p.isActive }));

  it('re-cutting the shares updates the same rows — the ids, and so the draws they carry, stay', async () => {
    const before = withIds();
    const res = await put({ partners: before.map((p, i) => (i === 0 ? { ...p, sharePercent: 10 } : i === 3 ? { ...p, sharePercent: 60 } : p)) });
    expect(res.status).toBe(200);
    expect(saved().map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect(saved().map((p) => p.sharePercent)).toEqual([10, 15, 15, 60]);
    expect(db.partner.create).not.toHaveBeenCalled();
    expect(db.partner.update).toHaveBeenCalledTimes(4);
  });

  it('a partner is switched off, never deleted — he stays in the table, and the others total 100', async () => {
    const before = withIds();
    const res = await put({
      partners: [{ ...before[0], isActive: false }, { ...before[1], sharePercent: 30 }, before[2], before[3]],
    });
    expect(res.status).toBe(200);
    expect(saved()).toHaveLength(4);
    expect(saved()[0].isActive).toBe(false);
    expect((await res.json()).sharesTotal).toBe(100);
  });

  it('there is no way to delete one: the door has no delete, and a list that leaves one out is refused as stale', async () => {
    const before = withIds();
    const res = await put({ partners: before.slice(0, 3).map((p, i) => (i === 0 ? { ...p, sharePercent: 70 } : p)) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE_LIST');
    expect(saved()).toHaveLength(4);
    expect('delete' in db.partner).toBe(false);
    expect('deleteMany' in db.partner).toBe(false);
  });

  it('a new partner is added beside the four, and the shares are re-cut in the same save', async () => {
    const before = withIds();
    const res = await put({
      partners: [...before.map((p, i) => (i === 3 ? { ...p, sharePercent: 45 } : p)), { name: 'شريك جديد', sharePercent: 10, isActive: true }],
    });
    expect(res.status).toBe(200);
    expect(saved()).toHaveLength(5);
    expect(saved()[4]).toMatchObject({ name: 'شريك جديد', sharePercent: 10, sortOrder: 4 });
  });

  it('an id nobody saved, or one named twice, is refused — a stale or a forged list', async () => {
    const before = withIds();
    const ghost = await put({ partners: [{ ...before[0], id: '99999999-9999-4999-8999-999999999999' }, ...before.slice(1)] });
    expect(ghost.status).toBe(409);
    expect((await ghost.json()).code).toBe('UNKNOWN_PARTNER');
    const twice = await put({ partners: [before[0], before[0], before[2], before[3]] });
    expect([400, 409]).toContain(twice.status);
    expect(db.partner.update).not.toHaveBeenCalled();
  });

  it('another company’s partner is not this company’s: its id is unknown here', async () => {
    tables.partner.push({ id: '88888888-8888-4888-8888-888888888888', companyId: 'c2', name: 'غريب', sharePercent: 100, isActive: true, sortOrder: 0 });
    const before = withIds();
    const res = await put({ partners: [{ ...before[0], id: '88888888-8888-4888-8888-888888888888' }, ...before.slice(1)] });
    expect(res.status).toBe(409);
    expect(tables.partner.find((p) => p.companyId === 'c2')!.name).toBe('غريب');
  });

  it('a name that is already another partner’s (the database’s unique name) is said in a sentence, not a 500', async () => {
    const { Prisma } = await import('@prisma/client');
    const before = withIds();
    db.partner.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }));
    const res = await put({ partners: before });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NAME_TAKEN');
  });
});
