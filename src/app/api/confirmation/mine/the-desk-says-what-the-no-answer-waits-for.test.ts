import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «إثبات المكالمات» ON «طلباتي» (Confirmation Center v2, step A) — what each held card is told about HER «لا يرد»:
 *
 *   · with the switch on, on her own desk, every held order carries `callProof` — NO_OPENED (no press of hers), WAIT with the server's unlock instant (a press younger
 *     than thirty seconds), READY — computed by the very function the doors ask, from ONE read of the attempts for the whole desk; and the answer says `callProofOn`;
 *   · with the switch off: no key on any row, no top-level key, and not one read of the attempts (the rounds are off here too);
 *   · a colleague's desk read through «شاشة موظفة» carries none and reads none — the lock is about the viewer's own calls.
 *
 * The harness of `the-desk-signs-the-helper-link.test.ts`.
 */

const NOW = new Date('2026-11-15T10:00:00.000Z').getTime();

const { db, proof } = vi.hoisted(() => {
  const proof = { on: true };
  const row = (id: string, claimedAt = '2026-11-15T08:00:00.000Z') => ({
    id,
    orderNumber: `JO-${id}`,
    confirmationStatus: 'NEW',
    shippingStatus: null,
    totalAmount: 10,
    currency: 'JOD',
    claimedAt: new Date(claimedAt),
    customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
    items: [],
    addOns: [],
    _count: { contactAttempts: 0, notes: 0 },
  });
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ('OR' in where ? [row('o1'), row('o2'), row('o3'), row('o4', '2026-11-15T09:59:30.000Z')] : [])),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => [
        // o1: her press 10 s ago → WAIT; o2: her press 60 s ago → READY; o3: only a colleague's press → NO_OPENED.
        { orderId: 'o1', createdAt: new Date(Date.now() - 10_000), result: 'OPENED', employeeId: 'u1', attemptNumber: 1 },
        { orderId: 'o2', createdAt: new Date(Date.now() - 60_000), result: 'OPENED', employeeId: 'u1', attemptNumber: 1 },
        { orderId: 'o3', createdAt: new Date(Date.now() - 60_000), result: 'OPENED', employeeId: 'u2', attemptNumber: 1 },
        // o4: her press is from BEFORE she took the order again (claimed 30 s ago, pressed 60 s ago) → it is not hers now → NO_OPENED.
        { orderId: 'o4', createdAt: new Date(Date.now() - 60_000), result: 'OPENED', employeeId: 'u1', attemptNumber: 1 },
      ]),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
  };
  return { db, proof };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] },
    companyId: 'c1',
    storeId: 's1',
    countryId: 'co1',
    country: { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] },
  }),
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => undefined,
  can: (_u: unknown, k: string) => k === 'confirmation.work',
}));
vi.mock('@/lib/desk-watch', () => ({
  DESK_NOT_FOUND: 'x',
  DESK_WATCH_REFUSAL: 'x',
  mayWatchDesks: () => true,
  watchedAgent: async () => ({ id: 'u2', name: 'Lina' }),
}));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => proof.on }));

import { GET } from './route';

type Row = { id: string; callProof?: { state: string; unlocksAtMs: number | null } };
type Desk = { work: Row[]; noAnswer: Row[]; callProofOn?: boolean; serverNow: string };
const desk = async (url = 'http://localhost/api/confirmation/mine') => (await GET(new Request(url))).json() as Promise<Desk>;
const held = (d: Desk) => [...d.work, ...d.noAnswer];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  proof.on = true;
});

describe('ON — her own desk', () => {
  it('every held card says what her «لا يرد» waits for: NO_OPENED, WAIT with the unlock instant, READY', async () => {
    const d = await desk();
    expect(d.callProofOn).toBe(true);
    const byId = Object.fromEntries(held(d).map((r) => [r.id, r.callProof]));
    expect(byId.o1).toEqual({ state: 'WAIT', unlocksAtMs: NOW - 10_000 + 30_000 });
    expect(byId.o2).toEqual({ state: 'READY', unlocksAtMs: null });
    expect(byId.o3).toEqual({ state: 'NO_OPENED', unlocksAtMs: null });
    expect(byId.o4).toEqual({ state: 'NO_OPENED', unlocksAtMs: null });
  });

  it('is ONE read of the attempts for the whole desk, not one per card', async () => {
    await desk();
    expect(db.orderContactAttempt.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('OFF — the desk is today’s', () => {
  it('no key on any row, no top-level key, and the attempts are not read', async () => {
    proof.on = false;
    const d = await desk();
    expect(d).not.toHaveProperty('callProofOn');
    for (const r of held(d)) expect(r).not.toHaveProperty('callProof');
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});

describe('a colleague’s desk read through «شاشة موظفة»', () => {
  it('carries none and reads none: the lock is about the viewer’s own calls', async () => {
    const d = await desk('http://localhost/api/confirmation/mine?agent=u2');
    expect(d).not.toHaveProperty('callProofOn');
    for (const r of held(d)) expect(r).not.toHaveProperty('callProof');
    expect(db.orderContactAttempt.findMany).not.toHaveBeenCalled();
  });
});
