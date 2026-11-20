import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';
import type { Row } from '@/lib/stock-transfers.memory-db.test';

/**
 * THE MONTH'S EXITS DOOR (W6b) — GET /api/inventory/exits/month.
 *
 * End to end on the in-memory database (`stock-transfers.memory-db.test.ts`): exits are asked and decided through W6a's REAL
 * doors, then the month is read through this one. People are built the way a session builds them (`computeEffectiveGrants`
 * over role rows and personal overrides) and the REAL `can` decides both the page key and the cost key.
 *
 * What it pins: only APPROVED exits count, in the STORE's month of their approval; the figures are the lines' own (the value
 * at cost W6a wrote, summed and rounded here); a person without `costs.view` gets no cost field at all — not a zero; an
 * uncosted line is said apart; a malformed or future month is refused in Arabic with a stable code; another store's exits
 * are not read.
 */

const S = vi.hoisted(() => ({
  current: null as unknown as SessionUser,
  storeId: 's1',
  m: null as unknown as { db: Record<string, unknown>; data: Record<string, Row[]> },
  rolePerms: {} as Record<string, string[]>,
  overrides: {} as Record<string, { permission: string; effect: 'ALLOW' | 'DENY' }[]>,
}));

vi.mock('@/lib/db', () => {
  const extra: Row = {
    rolePermission: {
      findMany: async ({ where }: Row) =>
        (where.roleId ? S.rolePerms[where.roleId] ?? [] : S.rolePerms[`template:${where.role?.name}`] ?? []).map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null })),
    },
    userPermission: { findMany: async ({ where }: Row) => (S.overrides[where.userId] ?? []).map((o) => ({ ...o, scope: 'ALL_COMPANY', scopeIds: null })) },
  };
  const db = new Proxy({} as Row, {
    get: (_t, prop: string) => (prop in extra ? extra[prop] : (S.m.db as Row)[prop]),
  });
  return { db };
});
vi.mock('@/lib/geo-context', async (orig) => {
  const real = await orig<typeof import('@/lib/geo-context')>();
  return {
    ...real,
    requireContext: async () => ({
      user: S.current,
      companyId: (S.current as Row).companyId,
      storeId: S.storeId,
      country: { id: 'k1', timezone: 'Asia/Amman', minorUnit: 3 },
    }),
  };
});
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(S.current, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return S.current;
    },
  };
});
vi.mock('@/lib/auth', async (orig) => {
  const real = await orig<typeof import('@/lib/auth')>();
  return { ...real, requireCompanyTenant: async () => ({ user: S.current, companyId: (S.current as Row).companyId }) };
});
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { memoryDb } from '@/lib/stock-transfers.memory-db.test';
import * as list from '../route';
import * as approveDoor from '../[id]/approve/route';
import * as rejectDoor from '../[id]/reject/route';
import { GET as month } from './route';

const C1 = 'c1';

async function as(id: string) {
  const u = S.m.data.user.find((x) => x.id === id)!;
  S.current = attachGrants({ ...u, permissions: [] } as unknown as SessionUser, await computeEffectiveGrants({ id: u.id, role: u.role, roleId: u.roleId ?? null }));
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ask = (body: Row) => list.POST(req({ warehouseId: 'wA', ...body })).then(json);
const approve = (id: string) => approveDoor.POST(req(undefined), ctx(id)).then(json);
const reject = (id: string) => rejectDoor.POST(req({ reason: 'العدّ غلط' }), ctx(id)).then(json);
const read = (m?: string) => month(new Request(`http://x/api/inventory/exits/month${m === undefined ? '' : `?month=${m}`}`) as never).then(json);
const at = (iso: string) => vi.setSystemTime(new Date(iso));

/** Ask as one person and approve as another, at a given instant. */
async function out(lines: { productId: string; quantity: number }[], reason: string, when: string, note?: string) {
  at(when);
  await as('u-asker');
  const a = await ask({ reason, lines, note });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  await as('u-approver');
  const d = await approve(a.body.exit.id);
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return a.body.exit.id as string;
}

const batch = (id: string, productId: string, storeId: string, qty: number, cost: number) => ({
  id, companyId: C1, storeId, productId, batchNumber: id, quantityProduced: qty, quantitySold: 0, quantityRemaining: qty,
  quantityMovedIn: 0, quantityMovedOut: 0, costPerUnit: cost, productionDate: new Date('2026-09-01'), createdAt: new Date('2026-09-01'),
  status: 'COMPLETED', notes: null, warehouseId: 'wA', inTransitTransferId: null, splitFromBatchId: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-11-20T10:00:00.000Z');
  S.storeId = 's1';
  S.rolePerms = {
    'r-asker': ['inventory.view', 'inventory.exit'],
    'r-approver': ['inventory.view', 'inventory.exit_approve'],
    'r-viewer': ['inventory.view'],
    'r-viewer-cost': ['inventory.view', 'costs.view'],
    'r-none': ['orders.view'],
  };
  S.overrides = { 'u-denied-cost': [{ permission: 'costs.view', effect: 'DENY' }] };
  const people = [
    ['u-owner', 'SUPER_ADMIN', null, 'المالك'],
    ['u-asker', 'CUSTOM', 'r-asker', 'سارة'],
    ['u-approver', 'CUSTOM', 'r-approver', 'منى'],
    ['u-viewer', 'CUSTOM', 'r-viewer', 'رنا'],
    ['u-viewer-cost', 'CUSTOM', 'r-viewer-cost', 'هالة'],
    ['u-denied-cost', 'CUSTOM', 'r-viewer-cost', 'ليلى'],
    ['u-none', 'CUSTOM', 'r-none', 'نور'],
  ] as const;
  S.m = memoryDb({
    country: [{ id: 'k1', companyId: C1, isActive: true, minorUnit: 3 }],
    store: [
      { id: 's1', companyId: C1, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C1, countryId: 'k1', name: 'متجر تاني' },
    ],
    user: people.map(([id, role, roleId, name]) => ({ id, name, role, roleId, status: 'ACTIVE', companyId: C1 })),
    userCountryAccess: people.filter(([id]) => id !== 'u-owner').map(([userId]) => ({ userId, countryId: 'k1' })),
    userWarehouseAccess: [],
    warehouse: [{ id: 'wA', companyId: C1, countryId: 'k1', name: 'مخزن الشمال', isActive: true }],
    warehousePlacement: [
      { id: 'pl1', companyId: C1, storeId: 's1' },
      { id: 'pl2', companyId: C1, storeId: 's2' },
    ],
    product: [
      { id: 'p1', companyId: C1, storeId: 's1', name: 'كريم اليدين' },
      { id: 'p2', companyId: C1, storeId: 's1', name: 'صابون الزيت' },
      { id: 'p3', companyId: C1, storeId: 's2', name: 'منتج المتجر التاني' },
    ],
    productionBatch: [
      batch('b1', 'p1', 's1', 50, 1.1235),
      // Never costed: what leaves from it is «بلا كلفة».
      batch('b2', 'p2', 's1', 20, 0),
      batch('b3', 'p3', 's2', 10, 4),
    ],
  }) as never;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the month counts what LEFT — approved exits, in the store’s month of their approval', () => {
  it('approved lines with their value; a pending and a rejected exit add nothing; another store is not read', async () => {
    await out([{ productId: 'p1', quantity: 4 }], 'EXPIRED', '2026-11-03T08:00:00.000Z');
    await out([{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 3 }], 'SAMPLES', '2026-11-10T08:00:00.000Z', 'معرض');
    // Pending: asked, never decided.
    await as('u-asker');
    expect((await ask({ reason: 'DAMAGED', lines: [{ productId: 'p1', quantity: 5 }] })).status).toBe(201);
    // Rejected.
    const r = await ask({ reason: 'DAMAGED', lines: [{ productId: 'p1', quantity: 6 }] });
    await as('u-approver');
    expect((await reject(r.body.exit.id)).status).toBe(200);
    // Another store, same warehouse, same month — not this store's report.
    S.storeId = 's2';
    await out([{ productId: 'p3', quantity: 1 }], 'EXPIRED', '2026-11-11T08:00:00.000Z');
    S.storeId = 's1';

    at('2026-11-20T10:00:00.000Z');
    await as('u-viewer-cost');
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toMatchObject({ month: '2026-11', monthAr: 'تشرين الثاني 2026', current: true, prev: '2026-10', next: null, seesCost: true, exits: 2 });
    expect(body.lines.map((l: Row) => [l.productName, l.quantity, l.reasonAr, l.requestedByName, l.decidedByName, l.warehouseName])).toEqual([
      ['كريم اليدين', 4, 'منتهي', 'سارة', 'منى', 'مخزن الشمال'],
      ['كريم اليدين', 2, 'عيّنات وهدايا', 'سارة', 'منى', 'مخزن الشمال'],
      ['صابون الزيت', 3, 'عيّنات وهدايا', 'سارة', 'منى', 'مخزن الشمال'],
    ]);
    // The values are the lines W6a wrote (4 × 1.1235 → 4.494 at three places; 2 × 1.1235 → 2.247), read here, not recomputed.
    const written = S.m.data.stockExitLine.filter((l) => l.productId === 'p1' && l.valueAtCost !== null).map((l) => l.valueAtCost);
    expect(body.lines.slice(0, 2).map((l: Row) => l.valueAtCost)).toEqual(written);
    expect(written).toEqual([4.494, 2.247]);
    // The never-costed line is «بلا كلفة» — no figure, not a zero — and is counted apart.
    expect(body.lines[2]).toMatchObject({ valueAtCost: null, uncosted: true });
    expect(body.reasons).toEqual([
      { reason: 'EXPIRED', reasonAr: 'منتهي', quantity: 4, lines: 1, valueAtCost: 4.494, uncostedLines: 0 },
      { reason: 'SAMPLES', reasonAr: 'عيّنات وهدايا', quantity: 5, lines: 2, valueAtCost: 2.247, uncostedLines: 1 },
    ]);
    expect(body.total).toEqual({ quantity: 9, lines: 3, valueAtCost: 6.741, uncostedLines: 1 });
  });

  it('the store’s month, not the server’s: an approval at 01:30 of the 1st in Amman (22:30 UTC the day before) is that month’s', async () => {
    await out([{ productId: 'p1', quantity: 1 }], 'EXPIRED', '2026-10-31T22:30:00.000Z');
    await out([{ productId: 'p1', quantity: 2 }], 'EXPIRED', '2026-10-31T20:30:00.000Z'); // 23:30 of 31 October in Amman
    at('2026-11-20T10:00:00.000Z');
    await as('u-viewer');
    const nov = await read('2026-11');
    expect(nov.body.lines.map((l: Row) => l.quantity)).toEqual([1]);
    const oct = await read('2026-10');
    expect(oct.body.lines.map((l: Row) => l.quantity)).toEqual([2]);
    expect(oct.body).toMatchObject({ month: '2026-10', monthAr: 'تشرين الأول 2026', current: false, prev: '2026-09', next: '2026-11' });
  });

  it('the month of the APPROVAL, not of the request: asked on 30 October, approved on 2 November, it is November’s', async () => {
    at('2026-10-30T08:00:00.000Z');
    await as('u-asker');
    const a = await ask({ reason: 'EXPIRED', lines: [{ productId: 'p1', quantity: 3 }] });
    at('2026-11-02T08:00:00.000Z');
    await as('u-approver');
    expect((await approve(a.body.exit.id)).status).toBe(200);
    at('2026-11-20T10:00:00.000Z');
    await as('u-viewer');
    expect((await read('2026-11')).body.lines.map((l: Row) => l.quantity)).toEqual([3]);
    expect((await read('2026-10')).body.lines).toEqual([]);
  });

  it('an approval pressed a moment ago is in the very next answer (the latest approval is part of the question)', async () => {
    await as('u-viewer');
    expect((await read()).body.exits).toBe(0);
    await out([{ productId: 'p1', quantity: 1 }], 'EXPIRED', '2026-11-20T10:00:00.000Z');
    await as('u-viewer');
    expect((await read()).body.exits).toBe(1);
  });
});

describe('the value at cost reaches the cost key only — the door decides', () => {
  it('NEGATIVE: without `costs.view` (or with it DENIED personally) no cost field is sent anywhere — not a zero, not a null', async () => {
    await out([{ productId: 'p1', quantity: 4 }, { productId: 'p2', quantity: 1 }], 'DAMAGED', '2026-11-05T08:00:00.000Z');
    for (const who of ['u-viewer', 'u-denied-cost', 'u-asker', 'u-approver']) {
      await as(who);
      const { status, body } = await read();
      expect(status, who).toBe(200);
      expect(body.seesCost, who).toBe(false);
      expect(body.lines, who).toHaveLength(2);
      const text = JSON.stringify(body);
      expect(text, who).not.toContain('valueAtCost');
      expect(text, who).not.toContain('uncosted');
      expect(body.total, who).toEqual({ quantity: 5, lines: 2 });
    }
    for (const who of ['u-viewer-cost', 'u-owner']) {
      await as(who);
      expect((await read()).body.total.valueAtCost, who).toBe(4.494);
    }
  });

  it('NEGATIVE: the page key is asked — a person without `inventory.view` is refused', async () => {
    await as('u-none');
    expect((await read()).status).toBe(403);
  });
});

describe('the month asked', () => {
  it('NEGATIVE: a malformed month and a month still to come are refused in Arabic with a stable code', async () => {
    await as('u-viewer');
    for (const bad of ['2026-13', '2026-1', 'nov', '2026-11-01']) {
      const { status, body } = await read(bad);
      expect(status, bad).toBe(400);
      expect(body, bad).toMatchObject({ code: 'INVALID_MONTH', errorAr: 'الشهر غير صالح.' });
    }
    const future = await read('2026-12');
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('MONTH_IN_FUTURE');
    expect(future.body.errorAr).toMatch(/لسا ما إجا/);
  });

  it('a month back across the year says its neighbours', async () => {
    await as('u-viewer');
    expect((await read('2026-01')).body).toMatchObject({ monthAr: 'كانون الثاني 2026', prev: '2025-12', next: '2026-02', current: false });
  });
});
