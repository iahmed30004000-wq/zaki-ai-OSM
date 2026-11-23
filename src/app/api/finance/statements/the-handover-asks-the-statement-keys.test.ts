import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HANDOVER ASKS THE STATEMENT'S KEYS — NOT THE CASH BOX (F9, 23/11).
 *
 * «استلمت منه» used to ask «تسجيل حركات الصندوق» (`finance.cashbox`) and write the money in one press. It is the manual
 * statement now, so it asks what a statement asks: «رفع تقارير الشحن» (`settlement.upload`) to add the orders, gather them,
 * record a payment and read the open handovers; «مراجعة المطابقات» (`settlement.review`) to run the matching; «اعتماد كشف
 * شركة الشحن» (`settlement.approve`) to write the money. The owner ticks them himself — no migration grants anything.
 *
 * Every person is built by the REAL engine (`computeEffectiveGrants`: role rows, a personal «منع», a roleId-null legacy
 * account) and every door asks the REAL `can()`. A 403 is the refusal; anything else means the person got PAST the gate
 * (the doors then stop on an empty database, which is not what is tested here).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { current, db } = vi.hoisted(() => ({
  current: { user: null as unknown as SessionUser },
  db: {
    courierStatement: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    deliveryProvider: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: current.user, companyId: 'c1', storeId: 's1', countryId: 'sy',
    country: { id: 'sy', currencyCode: 'SYP', minorUnit: 2 },
  }),
}));
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

import { attachGrants, can } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { GET as listHandovers, POST as addOrders } from './manual/route';
import { POST as assemble } from './[id]/assemble/route';
import { POST as addReceipt } from './[id]/receipts/route';
import { POST as match } from './[id]/match/route';
import { PATCH as patchStatement } from './[id]/route';

const ID = '88888888-8888-4888-8888-888888888888';
const params = { params: Promise.resolve({ id: ID }) };
const send = (method: string, body: unknown) =>
  new Request('http://x/api', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function person(
  roleKeys: string[],
  ex: { deny?: string[] } = {},
  legacy?: string
): Promise<SessionUser> {
  const base = {
    id: 'e1', email: 'e@x', name: 'هبة', role: legacy ?? 'CUSTOM', roleId: legacy ? null : 'r1', status: 'ACTIVE', companyId: 'c1',
  } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => roleKeys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => (ex.deny ?? []).map((k) => ({ permission: k, effect: 'DENY', scope: null, scopeIds: null })),
  });
  return attachGrants(base, grants);
}

/** Each door of the handover, and the key it must ask. */
const DOORS: Array<{ name: string; key: string; call: () => Promise<Response> }> = [
  { name: 'أضف الطلبات (manual)', key: 'settlement.upload', call: () => addOrders(send('POST', {})) },
  { name: 'افتح التسليم (assemble)', key: 'settlement.upload', call: () => assemble(send('POST', {}), params) },
  { name: 'سجّل دفعة (receipts)', key: 'settlement.upload', call: () => addReceipt(send('POST', {}), params) },
  { name: 'التسليمات المفتوحة (GET manual)', key: 'settlement.upload', call: () => listHandovers(new Request('http://x/api')) },
  { name: 'المطابقة (match)', key: 'settlement.review', call: () => match(send('POST', {}), params) },
  { name: 'اعتماد (PATCH approve)', key: 'settlement.approve', call: () => patchStatement(send('PATCH', { approve: true }), params) },
];

beforeEach(() => vi.clearAllMocks());

describe('the cash box alone opens none of the handover’s doors', () => {
  it.each(DOORS)('NEGATIVE: $name — 403 with an Arabic sentence, nothing read', async ({ call }) => {
    current.user = await person(['finance.cashbox', 'finance.cashbox_view', 'ops.track']);
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorAr).toMatch(/[؀-ۿ]/);
    expect(db.courierStatement.findFirst).not.toHaveBeenCalled();
    expect(db.courierStatement.findMany).not.toHaveBeenCalled();
  });
});

describe('each door asks its own key — and only that one', () => {
  it.each(DOORS)('$name: open with $key alone', async ({ key, call }) => {
    current.user = await person([key]);
    expect((await call()).status).not.toBe(403);
  });

  it.each(DOORS)('NEGATIVE: $name: shut to every other statement key', async ({ key, call }) => {
    const others = ['settlement.view', 'settlement.upload', 'settlement.review', 'settlement.approve'].filter((k) => k !== key);
    current.user = await person(others);
    expect((await call()).status).toBe(403);
  });

  it.each(DOORS)('NEGATIVE: $name: a personal «منع» on $key beats a role that has it', async ({ key, call }) => {
    current.user = await person([key, 'finance.cashbox'], { deny: [key] });
    expect((await call()).status).toBe(403);
  });
});

describe('a legacy account (no role id) is judged by what the engine gives it', () => {
  it.each(DOORS)('$name: the door answers exactly what `can` says for a legacy COMPANY_ADMIN', async ({ key, call }) => {
    current.user = await person([], {}, 'COMPANY_ADMIN');
    const res = await call();
    expect(res.status === 403).toBe(!can(current.user, key));
  });

  it('and that account may hand a courier over: it holds «رفع تقارير الشحن»', async () => {
    current.user = await person([], {}, 'COMPANY_ADMIN');
    expect(can(current.user, 'settlement.upload')).toBe(true);
  });
});
