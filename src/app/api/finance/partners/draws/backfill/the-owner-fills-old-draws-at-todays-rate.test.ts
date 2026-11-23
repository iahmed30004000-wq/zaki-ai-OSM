import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * «عبّي السعر للقديم بسعر اليوم» (23/11, F8 — the owner's exception), driven through the real door and the real `lib/draw-backfill`
 * over an in-memory ledger, with people built the way a session builds them (`computeEffectiveGrants`).
 *
 * Held: the owner only (a holder of the partners' key who is not the owner is refused, nothing read or written) · a preview first,
 * and no write without the confirm · the previewed total is the written total · a second run writes nothing · an equivalent already
 * there is never overwritten · a currency with no rate is skipped and named · a filled row can be edited and cleared, one by one.
 */

type Row = Record<string, any>;

const { state, db, requireContext, logAudit, current } = vi.hoisted(() => {
  const state = { rows: [] as Row[], auto: undefined as unknown, manual: {} as Row, updates: 0 };
  const match = (r: Row, w: Row): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'wallet') return r.storeId === (v as Row).storeId;
      if (k === 'reversedBy') return v === null ? !state.rows.some((x) => x.reversalOfId === r.id) : true;
      return (r[k] ?? null) === v;
    });
  const db = {
    walletMovement: {
      findMany: vi.fn(async ({ where }: { where: Row }) => state.rows.filter((r) => match(r, where)).map((r) => ({ ...r }))),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const r = state.rows.find((x) => match(x, where));
        return r ? { ...r } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.rows.filter((r) => match(r, where));
        for (const r of hit) Object.assign(r, data);
        state.updates += hit.length;
        return { count: hit.length };
      }),
    },
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify({ exchangeRates: { rates: state.manual } }) })) },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(db)),
  };
  return { state, db, requireContext: vi.fn(), logAudit: vi.fn(), current: { user: null as unknown as SessionUser } };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/system-settings', () => ({ readSystemSetting: async () => state.auto, updateSystemSetting: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a), geoReach: async () => null }));
vi.mock('@/lib/authorization', async (orig) => {
  const real = await orig<typeof import('@/lib/authorization')>();
  return {
    ...real,
    requirePermission: async (k: string) => {
      if (!real.can(current.user, k)) throw new Error(`Forbidden: missing required permission ${k}`);
      return current.user;
    },
  };
});

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { PERMISSION_MODULES } from '@/lib/permission-catalog';
import { GET, PATCH, POST } from './route';
import { BACKFILL_SOURCE } from '@/lib/draw-backfill';

async function person(roleKeys: string[], base: Partial<SessionUser> = {}, overrides: { permission: string; effect: 'DENY' | 'ALLOW' }[] = []) {
  const u = { id: 'u1', email: 'u@x', name: 'المالك', role: 'CUSTOM', roleId: 'r1', status: 'ACTIVE', companyId: 'c1', ...base } as unknown as SessionUser;
  return attachGrants(
    u,
    await computeEffectiveGrants(u as never, {
      roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
      overrideRows: async () => overrides.map((o) => ({ permission: o.permission, effect: o.effect, scope: null, scopeIds: null })),
    })
  );
}
async function as(u: SessionUser) {
  current.user = u;
  requireContext.mockResolvedValue({ user: u, companyId: 'c1', storeId: 's1', country: { currencyCode: 'USD', minorUnit: 2 } });
}
const OWNER = () => person([], { role: 'SUPER_ADMIN', roleId: null } as Partial<SessionUser>);
const EVERY_KEY = PERMISSION_MODULES.flatMap((m) => m.items.map((i) => i.key));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const draw = (n: number, over: Row = {}): Row => ({
  id: id(n), companyId: 'c1', storeId: 's1', walletId: 'w', category: 'PARTNER_DRAW', direction: 'OUT', reversalOfId: null,
  partnerId: 'p1', amount: 100, currencyCode: 'JOD', valueInStoreCurrency: null, createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)), ...over,
});
const call = async (h: (r: Request) => Promise<Response>, body?: unknown) => {
  const json = vi.fn(async () => body);
  const res = await h({ json } as unknown as Request);
  return { status: res.status, body: await res.json(), json };
};
const preview = async () => {
  const res = await GET();
  return { status: res.status, body: await res.json() };
};
const confirmOf = (p: Row) => ({ confirm: true, expectedIds: p.rows.map((r: Row) => r.id), expectedTotal: p.total });

beforeEach(async () => {
  vi.clearAllMocks();
  const now = new Date().toISOString();
  state.auto = { attemptedAt: now, fiat: { source: 'open.er-api.com', asOf: now, fetchedAt: now, perUsd: { JOD: 0.709 } } };
  state.manual = {};
  state.updates = 0;
  state.rows = [
    draw(1), // 100 JOD → 141.04
    draw(2, { amount: 70.9 }), // → 100.00
    draw(3, { currencyCode: 'SYP', amount: 1_300_000 }), // no pound rate → skipped
    draw(4, { valueInStoreCurrency: 150 }), // has one → never touched
    draw(5, { storeId: 's2' }), // another store
    draw(6, { direction: 'IN', reversalOfId: id(7) }), // a reversal
    draw(7), // reversed by 6 → not a candidate
  ];
  await as(await OWNER());
});

describe('the owner only — through the real engine', () => {
  it('the owner (roleId null, every key) previews', async () => {
    expect((await preview()).status).toBe(200);
  });

  it('NEGATIVE: a holder of the partners’ key (and every money key) who is not the owner → OWNER_ONLY on all three, nothing read or written', async () => {
    await as(await person(EVERY_KEY.filter((k) => k.startsWith('finance.') || k.startsWith('settlement.'))));
    expect((await preview()).body.code).toBe('OWNER_ONLY');
    const post = await call(POST, { confirm: true, expectedIds: [id(1)], expectedTotal: 1 });
    const patch = await call(PATCH, { movementId: id(1), value: null });
    for (const r of [post, patch]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('OWNER_ONLY');
      expect(r.json).not.toHaveBeenCalled();
    }
    expect(state.updates).toBe(0);
  });

  it('NEGATIVE: without the partners’ key at all → 403 before anything', async () => {
    await as(await person(['finance.view']));
    expect((await preview()).status).toBe(403);
  });
});

describe('preview, then confirm', () => {
  it('the preview lists only this store’s old draws with no equivalent, at today’s rate, and names the pound as skipped', async () => {
    const { body } = await preview();
    expect(body.rows.map((r: Row) => [r.id, r.value])).toEqual([[id(1), 141.04], [id(2), 100]]);
    expect(body.total).toBe(241.04);
    expect(body.skipped).toEqual([{ currencyCode: 'SYP', count: 1, sentence: 'ما في سعر — اكتب سعر الليرة بالإعدادات' }]);
    expect(state.updates).toBe(0);
  });

  it('NEGATIVE: no write without the confirm', async () => {
    const p = (await preview()).body;
    for (const body of [{ ...confirmOf(p), confirm: false }, { expectedIds: confirmOf(p).expectedIds, expectedTotal: p.total }, null]) {
      const r = await call(POST, body);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('CONFIRM_REQUIRED');
    }
    expect(state.updates).toBe(0);
  });

  it('the confirm writes exactly the previewed rows; the written total equals the preview total; rate and source frozen', async () => {
    const p = (await preview()).body;
    const r = await call(POST, confirmOf(p));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ written: 2, total: p.total });
    const written = state.rows.filter((x) => x.equivalentRateSource === BACKFILL_SOURCE);
    expect(written.map((x) => x.id)).toEqual([id(1), id(2)]);
    expect(written.reduce((s, x) => s + Math.round(x.valueInStoreCurrency * 100), 0) / 100).toBe(p.total);
    expect(written[0]).toMatchObject({ equivalentRateKind: 'AUTO', equivalentRateSource: 'استثناء بسعر اليوم' });
    expect(written[0].equivalentRate).toBeCloseTo(1 / 0.709, 10);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PARTNER_DRAWS_BACKFILLED', newData: expect.objectContaining({ count: 2, total: 241.04 }) }));
  });

  it('NEGATIVE: an equivalent already there is never overwritten; the pound row and the other store stay empty', async () => {
    await call(POST, confirmOf((await preview()).body));
    expect(state.rows.find((x) => x.id === id(4))).toMatchObject({ valueInStoreCurrency: 150 });
    expect(state.rows.find((x) => x.id === id(4))).not.toHaveProperty('equivalentRate');
    expect(state.rows.find((x) => x.id === id(3))!.valueInStoreCurrency).toBeNull();
    expect(state.rows.find((x) => x.id === id(5))!.valueInStoreCurrency).toBeNull();
    expect(state.rows.find((x) => x.id === id(7))!.valueInStoreCurrency).toBeNull();
  });

  it('NEGATIVE: a race — the row gets an equivalent between the re-check and the write — is NOT overwritten, and the run fails whole', async () => {
    const p = (await preview()).body;
    db.$transaction.mockImplementationOnce(async (fn: (t: unknown) => unknown) => {
      const tx = { ...db, walletMovement: { ...db.walletMovement, findMany: async (q: { where: Row }) => {
        const out = await db.walletMovement.findMany(q);
        state.rows.find((x) => x.id === id(1))!.valueInStoreCurrency = 150; // somebody else filled it, after the read
        return out;
      } } };
      return fn(tx);
    });
    const r = await call(POST, confirmOf(p));
    expect(r.status).toBe(500);
    expect(state.rows.find((x) => x.id === id(1))).toMatchObject({ valueInStoreCurrency: 150 });
    expect(state.rows.find((x) => x.id === id(1))).not.toHaveProperty('equivalentRate');
  });

  it('idempotent: a second run (even with the old preview) writes nothing', async () => {
    const p = (await preview()).body;
    await call(POST, confirmOf(p));
    const before = state.updates;
    const again = await call(POST, confirmOf(p));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOTHING_TO_FILL');
    expect(state.updates).toBe(before);
  });

  it('NEGATIVE: the rows changed after the preview (a rate typed, a row filled elsewhere) → STALE_PREVIEW, nothing written', async () => {
    const p = (await preview()).body;
    state.manual = { JOD: { perUsd: 0.5, at: new Date().toISOString() } };
    const r = await call(POST, confirmOf(p));
    expect(r.body.code).toBe('STALE_PREVIEW');
    expect(state.updates).toBe(0);
  });

  it('a pound rate typed later makes the pound row a candidate (skipped is not forgotten)', async () => {
    state.manual = { SYP: { perUsd: 13000, at: new Date().toISOString() } };
    const { body } = await preview();
    expect(body.rows.map((r: Row) => r.id)).toContain(id(3));
    expect(body.skipped).toEqual([]);
  });
});

describe('reversible per row', () => {
  it('a filled row is edited (MANUAL, still marked) and cleared back to no equivalent', async () => {
    await call(POST, confirmOf((await preview()).body));
    const edit = await call(PATCH, { movementId: id(1), value: '140' });
    expect(edit.status).toBe(200);
    expect(state.rows.find((x) => x.id === id(1))).toMatchObject({ valueInStoreCurrency: 140, equivalentRateKind: 'MANUAL', equivalentRateSource: BACKFILL_SOURCE });
    const clear = await call(PATCH, { movementId: id(1), value: null });
    expect(clear.body).toMatchObject({ before: 140, after: null });
    expect(state.rows.find((x) => x.id === id(1))).toMatchObject({ valueInStoreCurrency: null, equivalentRate: null, equivalentRateSource: null });
  });

  it('NEGATIVE: a row this exception did not fill (a typed equivalent) is not this door’s', async () => {
    const r = await call(PATCH, { movementId: id(4), value: null });
    expect(r.body.code).toBe('NOT_BACKFILLED');
    expect(state.rows.find((x) => x.id === id(4))!.valueInStoreCurrency).toBe(150);
  });
});
