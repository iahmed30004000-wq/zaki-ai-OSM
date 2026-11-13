import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TAKING A PARTNER'S DRAW BACK, THROUGH THE WALLET'S OWN REVERSAL DOOR (13/11).
 *
 * «عكس» on a draw uses the door every wallet movement is taken back by (`PATCH /api/finance/wallets/:id/movements`, the cash box's
 * key). A draw is a line of the partners' ledger, though, so taking it back moves a partner's balance: that needs the partners' key
 * as well. Driven through the real PATCH and the real `reverseMovement` over an in-memory ledger, as a person is a list of keys.
 */

type Row = Record<string, any>;

const { db, tables, current, requireContext, logAudit } = vi.hoisted(() => {
  const tables = { walletMovement: [] as Row[], wallet: [] as Row[], user: [] as Row[] };
  let seq = 0;
  const tx = {
    walletMovement: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => tables.walletMovement.find((m) => m.id === where.movementId || (m.id === where.id && m.companyId === where.companyId && m.walletId === where.walletId)) ?? null),
      findUnique: vi.fn(async ({ where }: { where: Row }) => tables.walletMovement.find((m) => m.reversalOfId === where.reversalOfId) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `rev${++seq}`, ...data };
        tables.walletMovement.push(row);
        return row;
      }),
    },
    expense: { updateMany: vi.fn() },
  };
  const db = {
    wallet: { findFirst: vi.fn(async ({ where }: { where: Row }) => tables.wallet.find((w) => w.id === where.id && w.storeId === where.storeId) ?? null) },
    walletMovement: {
      findMany: vi.fn(async () => tables.walletMovement),
      ...tx.walletMovement,
      aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
      count: vi.fn(async () => 0),
    },
    user: { findMany: vi.fn(async () => tables.user) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  return { db, tables, current: { keys: [] as string[] }, requireContext: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  walletBalance: vi.fn(async () => ({ balance: 0 })),
}));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, k: string) => current.keys.includes(k),
  requirePermission: async (k: string) => {
    if (!current.keys.includes(k)) throw new Error(`Forbidden: missing required permission ${k}`);
  },
}));

import { GET, PATCH } from './route';

const WALLET = '22222222-2222-4222-8222-222222222222';
const DRAW = '33333333-3333-4333-8333-333333333333';
const PLAIN = '44444444-4444-4444-8444-444444444444';
const P = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: WALLET }) };
const reverse = (movementId: string) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ movementId, reason: 'سُجِّل المبلغ مرتين' }) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  tables.walletMovement.length = 0;
  tables.wallet.length = 0;
  tables.user.length = 0;
  current.keys = ['finance.cashbox_view', 'finance.cashbox'];
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'سارة' }, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
  tables.wallet.push({ id: WALLET, storeId: 's1', name: 'الصندوق', isActive: true, country: { minorUnit: 2 } });
  tables.walletMovement.push(
    {
      id: DRAW, companyId: 'c1', walletId: WALLET, direction: 'OUT', amount: '100', currencyCode: 'USD', party: 'احمد كيوان', category: 'PARTNER_DRAW',
      note: 'سحب', referenceType: 'PARTNER_DRAW', referenceId: P, reversalOfId: null, partnerId: P, valueInStoreCurrency: '98.700',
      createdById: 'u1', createdAt: new Date('2026-11-12T10:00:00Z'),
    },
    {
      id: PLAIN, companyId: 'c1', walletId: WALLET, direction: 'OUT', amount: '25', currencyCode: 'USD', party: 'مورّد', category: 'OTHER',
      note: 'دفعة', referenceType: null, referenceId: null, reversalOfId: null, partnerId: null, valueInStoreCurrency: null,
      createdById: 'u1', createdAt: new Date('2026-11-12T09:00:00Z'),
    },
  );
});

describe('a person who holds the cash box but not «الشركاء والسحوبات»', () => {
  it('cannot take a draw back: 403 in the door’s words, nothing written, nothing audited', async () => {
    const res = await reverse(DRAW);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('NOT_ALLOWED');
    expect(body.error).toContain('الشركاء والسحوبات');
    expect(tables.walletMovement.filter((m) => m.reversalOfId)).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('still takes back any other movement exactly as before', async () => {
    const res = await reverse(PLAIN);
    expect(res.status).toBe(201);
    expect(tables.walletMovement.filter((m) => m.reversalOfId === PLAIN)).toHaveLength(1);
  });
});

describe('a person who holds both keys', () => {
  beforeEach(() => {
    current.keys = ['finance.cashbox_view', 'finance.cashbox', 'finance.partners'];
  });

  it('takes the draw back: a linked IN entry of the same amount, the same partner and the same store value', async () => {
    const res = await reverse(DRAW);
    expect(res.status).toBe(201);
    const rev = tables.walletMovement.find((m) => m.reversalOfId === DRAW)!;
    expect(rev).toMatchObject({ direction: 'IN', amount: '100', partnerId: P, valueInStoreCurrency: '98.700', category: 'PARTNER_DRAW', reversalReason: 'سُجِّل المبلغ مرتين' });
    expect(logAudit.mock.calls.map((c) => c[0].action)).toEqual(['WALLET_MOVEMENT_REVERSED']);
  });

  it('a draw is taken back once: the second press is a 409, not a second reversal', async () => {
    expect((await reverse(DRAW)).status).toBe(201);
    const again = await reverse(DRAW);
    expect(again.status).toBe(409);
    expect(tables.walletMovement.filter((m) => m.reversalOfId === DRAW)).toHaveLength(1);
  });
});

describe('the partners’ key alone, without the cash box’s', () => {
  it('is not enough: the door itself asks the cash box first', async () => {
    current.keys = ['finance.partners'];
    const res = await reverse(DRAW);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('finance.cashbox');
    expect(tables.walletMovement.filter((m) => m.reversalOfId)).toHaveLength(0);
  });
});

describe('the ledger a wallet shows carries the draw’s worth as a number', () => {
  it('a draw row says what it is worth in the store’s currency; every other row is unchanged', async () => {
    const body = await (await GET(new Request('http://localhost/x'), params)).json();
    const draw = body.movements.find((m: Row) => m.id === DRAW);
    const plain = body.movements.find((m: Row) => m.id === PLAIN);
    expect(draw.valueInStoreCurrency).toBe(98.7);
    expect(draw.partnerId).toBe(P);
    expect(draw.amount).toBe(100);
    expect(plain.valueInStoreCurrency).toBeNull();
    expect(plain.amount).toBe(25);
  });
});
