import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «تاريخ الحركة الفعلي» AT THE TWO DOORS (22/11) — the movements door and the transfers door.
 *
 *   · a real date in the past is written beside the registration (on a transfer: on the transfer AND on both legs);
 *   · none typed = the row is written exactly as before (no `occurredAt` key at all);
 *   · the future and the malformed are refused in Arabic with a code, and NOTHING is written;
 *   · the lists answer the real date, whether the registration fell on another day of the STORE, and are ordered by the real date;
 *   · who may read the lists is the list's own key (`finance.cashbox_view`) — no new key — through the real permission engine.
 *
 * Driven through the real routes and the real `recordMovement` (lib/wallets) over in-memory tables.
 */

type Row = Record<string, any>;

const { db, tables, requireContext, current } = vi.hoisted(() => {
  const tables = { walletMovement: [] as Row[], walletTransfer: [] as Row[], wallet: [] as Row[], user: [] as Row[] };
  let seq = 0;
  const walletMovement = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `m${++seq}`, createdAt: new Date(), ...data };
      tables.walletMovement.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      tables.walletMovement
        .filter((m) => (where.walletId ? m.walletId === where.walletId : true))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((m) => ({ ...m, reversalOf: null, reversedBy: null }))
    ),
    aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
    count: vi.fn(async () => 0),
  };
  const walletTransfer = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `t${++seq}`, createdAt: new Date(), ...data };
      tables.walletTransfer.push(row);
      return row;
    }),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => [...tables.walletTransfer].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
  };
  const wallet = {
    findFirst: vi.fn(async ({ where }: { where: Row }) => tables.wallet.find((w) => w.id === where.id) ?? null),
    findUnique: vi.fn(async ({ where }: { where: Row }) => tables.wallet.find((w) => w.id === where.id) ?? null),
    findMany: vi.fn(async () => tables.wallet),
  };
  const db = {
    walletMovement,
    walletTransfer,
    wallet,
    user: { findMany: vi.fn(async () => tables.user) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn({ walletMovement, walletTransfer, wallet })),
  };
  return { db, tables, requireContext: vi.fn(), current: { user: null as unknown as SessionUser } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    can: (_u: unknown, k: string) => real.can(current.user, k),
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET as listMovements, POST as recordOne } from './wallets/[id]/movements/route';
import { GET as listTransfers, POST as transfer } from './transfers/route';
import { OCCURRED_AT_REFUSAL_AR } from '@/lib/real-date';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: W1 }) };

/** A person built the way a session builds one: role rows, then the real engine. */
async function as(keys: string[]) {
  const base = { id: 'u1', email: 'u@x', name: 'سلوى', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  current.user = attachGrants(
    base,
    await computeEffectiveGrants(base as never, {
      roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => [],
    })
  );
  requireContext.mockResolvedValue({
    user: current.user, companyId: 'c1', storeId: 's1',
    country: { currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus' },
  });
}

const CASH = ['finance.cashbox_view', 'finance.cashbox'];

const post = (body: Row) =>
  recordOne(new Request('http://x', { method: 'POST', body: JSON.stringify({ direction: 'IN', amount: 50, party: 'زبون', category: 'OTHER', note: 'دفعة نقدية', ...body }) }), params);
const send = (body: Row) =>
  transfer(new Request('http://x', { method: 'POST', body: JSON.stringify({ fromWalletId: W1, toWalletId: W2, amountOut: 100, note: 'نقل للصندوق', ...body }) }));

const yesterday = () => new Date(Date.now() - 24 * 3600_000).toISOString();
const tomorrow = () => new Date(Date.now() + 24 * 3600_000).toISOString();

beforeEach(async () => {
  vi.clearAllMocks();
  for (const t of Object.values(tables)) t.length = 0;
  const wallet = (id: string, name: string) => ({
    id, name, companyId: 'c1', storeId: 's1', countryId: 'SY', currencyCode: 'USD', isActive: true, openingBalance: 0,
    country: { minorUnit: 2, name: 'سوريا', timezone: 'Asia/Damascus' }, store: { name: 'متجر' },
  });
  tables.wallet.push(wallet(W1, 'بينانس'), wallet(W2, 'صندوق'));
  tables.user.push({ id: 'u1', name: 'سلوى' });
  await as(CASH);
});

describe('the movements door', () => {
  it('writes a real date in the past beside the registration', async () => {
    const at = yesterday();
    expect((await post({ occurredAt: at })).status).toBe(201);
    expect(tables.walletMovement).toHaveLength(1);
    expect(tables.walletMovement[0].occurredAt).toEqual(new Date(at));
  });

  it('none typed = written as before: no occurredAt key at all', async () => {
    expect((await post({})).status).toBe(201);
    expect('occurredAt' in db.walletMovement.create.mock.calls[0][0].data).toBe(false);
  });

  it('NEGATIVE: the future is refused in Arabic with its code, and nothing is written', async () => {
    const res = await post({ occurredAt: tomorrow() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OCCURRED_AT_FUTURE', errorAr: OCCURRED_AT_REFUSAL_AR.OCCURRED_AT_FUTURE });
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a malformed date is refused, and nothing is written', async () => {
    const res = await post({ occurredAt: 'امبارح' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('OCCURRED_AT_MALFORMED');
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the registration cannot be typed — a sent createdAt is not written', async () => {
    await post({ createdAt: '2020-01-01T00:00:00.000Z' });
    expect(db.walletMovement.create.mock.calls[0][0].data.createdAt).toBeUndefined();
  });

  it('the list answers the real date and «another day», ordered by the real date', async () => {
    tables.walletMovement.push(
      { id: 'late', walletId: W1, companyId: 'c1', direction: 'IN', amount: 1, createdById: 'u1', createdAt: new Date('2026-11-20T08:00:00Z'), occurredAt: new Date('2026-11-19T14:00:00Z') },
      { id: 'plain', walletId: W1, companyId: 'c1', direction: 'IN', amount: 2, createdById: 'u1', createdAt: new Date('2026-11-20T07:00:00Z'), occurredAt: null },
    );
    const { movements } = await (await listMovements(new Request('http://x'), params)).json();
    expect(movements.map((m: Row) => m.id)).toEqual(['plain', 'late']);
    expect(movements[1]).toMatchObject({ realDate: '2026-11-19T14:00:00.000Z', registeredOnAnotherDay: true, createdByName: 'سلوى' });
    // A row with no real date shows its registration, and says nothing about another day.
    expect(movements[0]).toMatchObject({ realDate: '2026-11-20T07:00:00.000Z', registeredOnAnotherDay: false });
  });
});

describe('a date that does not exist is refused, never rolled forward (review 22/11)', () => {
  it.each(['2026-02-30T10:00:00.000Z', '2026-11-19T24:00', '2026-11-31T09:00', '2026-11-19T10:60'])(
    'NEGATIVE: %s — the movements door refuses it as malformed and writes nothing',
    async (at) => {
      const res = await post({ occurredAt: at });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('OCCURRED_AT_MALFORMED');
      expect(db.walletMovement.create).not.toHaveBeenCalled();
    }
  );

  it.each(['2026-02-30T10:00:00.000Z', '2026-11-19T24:00'])('NEGATIVE: %s — the transfers door refuses it and writes nothing', async (at) => {
    const res = await send({ occurredAt: at });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('OCCURRED_AT_MALFORMED');
    expect(db.walletTransfer.create).not.toHaveBeenCalled();
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('a real leap day (2024-02-29) is accepted as it is', async () => {
    expect((await post({ occurredAt: '2024-02-29T10:00:00.000Z' })).status).toBe(201);
    expect(tables.walletMovement[0].occurredAt).toEqual(new Date('2024-02-29T10:00:00.000Z'));
  });
});

describe('the lists read the store’s day and carry the reversal (review pins 22/11)', () => {
  it('«another day» is the STORE’s: 22:30 UTC on the 19th is the 20th in Damascus — one day, not two', async () => {
    tables.walletMovement.push({
      id: 'edge', walletId: W1, companyId: 'c1', direction: 'IN', amount: 1, createdById: 'u1',
      createdAt: new Date('2026-11-20T08:00:00Z'), occurredAt: new Date('2026-11-19T22:30:00Z'),
    });
    const { movements } = await (await listMovements(new Request('http://x'), params)).json();
    expect(movements[0].registeredOnAnotherDay).toBe(false);

    tables.walletTransfer.push({
      id: 'tx-edge', companyId: 'c1', fromWalletId: W1, toWalletId: W2, amountOut: 1, amountIn: 1, exchangeRate: 1, kind: 'INTERNAL', note: 'n',
      createdById: 'u1', createdAt: new Date('2026-11-20T08:00:00Z'), occurredAt: new Date('2026-11-19T22:30:00Z'),
    });
    db.walletMovement.findMany.mockResolvedValueOnce([]);
    const { transfers } = await (await listTransfers()).json();
    expect(transfers[0].registeredOnAnotherDay).toBe(false);
  });

  it('the transfers list is ordered by the real date, then the registration', async () => {
    const t = (id: string, createdAt: string, occurredAt: string | null) => ({
      id, companyId: 'c1', fromWalletId: W1, toWalletId: W2, amountOut: 1, amountIn: 1, exchangeRate: 1, kind: 'INTERNAL', note: id,
      createdById: 'u1', createdAt: new Date(createdAt), occurredAt: occurredAt ? new Date(occurredAt) : null,
    });
    tables.walletTransfer.push(
      t('late', '2026-11-20T08:00:00Z', '2026-11-18T10:00:00Z'),
      t('plain', '2026-11-20T07:00:00Z', null),
      t('mid', '2026-11-19T12:00:00Z', null),
    );
    db.walletMovement.findMany.mockResolvedValueOnce([]);
    const { transfers } = await (await listTransfers()).json();
    expect(transfers.map((x: Row) => x.id)).toEqual(['plain', 'mid', 'late']);
  });

  it('the movements list asks for the reversing entry’s reason and moment (the panel says them)', async () => {
    await listMovements(new Request('http://x'), params);
    const { include } = db.walletMovement.findMany.mock.calls[0][0] as unknown as { include: Row };
    expect(include.reversedBy).toEqual({ select: { id: true, reversalReason: true, createdAt: true } });
  });
});

describe('the transfers door', () => {
  it('writes the real date on the transfer and on BOTH legs', async () => {
    const at = yesterday();
    expect((await send({ occurredAt: at })).status).toBe(201);
    expect(tables.walletTransfer[0].occurredAt).toEqual(new Date(at));
    expect(tables.walletMovement).toHaveLength(2);
    for (const leg of tables.walletMovement) expect(leg.occurredAt).toEqual(new Date(at));
  });

  it('none typed = the transfer and its legs are written as before', async () => {
    await send({});
    expect('occurredAt' in db.walletTransfer.create.mock.calls[0][0].data).toBe(false);
    for (const call of db.walletMovement.create.mock.calls) expect('occurredAt' in call[0].data).toBe(false);
  });

  it('NEGATIVE: the future is refused before anything is written', async () => {
    const res = await send({ occurredAt: tomorrow() });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('OCCURRED_AT_FUTURE');
    expect(db.walletTransfer.create).not.toHaveBeenCalled();
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('the list says who registered it, the real date, and «another day» in the store’s timezone', async () => {
    tables.walletTransfer.push({
      id: 'tx', companyId: 'c1', fromWalletId: W1, toWalletId: W2, amountOut: 1, amountIn: 1, exchangeRate: 1, kind: 'INTERNAL', note: 'n',
      createdById: 'u1', createdAt: new Date('2026-11-20T08:00:00Z'), occurredAt: new Date('2026-11-19T14:00:00Z'),
    });
    db.walletMovement.findMany.mockResolvedValueOnce([]);
    const { transfers } = await (await listTransfers()).json();
    expect(transfers[0]).toMatchObject({ createdByName: 'سلوى', realDate: '2026-11-19T14:00:00.000Z', registeredOnAnotherDay: true });
  });
});

describe('who may read the two lists — the list’s own key, no new one', () => {
  it('the view key alone reads both lists', async () => {
    await as(['finance.cashbox_view']);
    expect((await listMovements(new Request('http://x'), params)).status).toBe(200);
    expect((await listTransfers()).status).toBe(200);
  });

  it('NEGATIVE: without «finance.cashbox_view» neither list is read', async () => {
    await as(['finance.cashbox']);
    expect((await listMovements(new Request('http://x'), params)).status).toBe(403);
    expect((await listTransfers()).status).toBe(403);
    expect(db.walletMovement.findMany).not.toHaveBeenCalled();
    expect(db.walletTransfer.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the view key alone cannot write a real date (or anything) at either door', async () => {
    await as(['finance.cashbox_view']);
    expect((await post({ occurredAt: yesterday() })).status).toBe(403);
    expect((await send({ occurredAt: yesterday() })).status).toBe(403);
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });
});
