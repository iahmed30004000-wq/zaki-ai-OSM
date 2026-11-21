import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d — THE DIFFERENTIAL: «NO ORDER RULE = osm/main, BYTE FOR BYTE» ON «طلباتي»
 *
 * `the-desk-without-order-rules.main-golden.json` was written by THIS file with `Q4D_GOLDEN_FROM` naming a copy of this route as it is on `osm/main` db1f1b20 (before
 * each card read its order's rule), over seeded desks: one to eight held orders of random products and channels, each with a random history of «اتصال» and «لا يرد»
 * lines (counted or early, with the dues the door stores), the plan and the proof on or off, random moments. Recorded: the whole answer except the server's clock.
 *
 * Today's route answers them with NO rule row, and again with rows that bind NOTHING on these orders: both must be the golden, record for record — and the orders'
 * facts are never read with no ORDER_NUMBERS row.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, world, rules, COUNTRY } = vi.hoisted(() => {
  const world = { held: [] as any[], attempts: [] as any[], products: {} as Record<string, string[]>, factReads: 0, plan: true, proof: true };
  const rules: any[] = [];
  const db = {
    order: {
      findMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        if (where.id?.in) {
          world.factReads++;
          return (where.id.in as string[]).map((id) => ({ id, storeId: 's1', productId: world.products[id][0], channel: { kind: 'FACEBOOK' }, items: world.products[id].map((p) => ({ productId: p })) }));
        }
        if (where.rejectionReason) return [];
        if (!('OR' in where)) return [];
        return world.held.map((o) => ({ ...o }));
      }),
      count: vi.fn(async () => 0),
    },
    orderContactAttempt: {
      groupBy: vi.fn(async () => {
        const by = new Map<string, number>();
        for (const a of world.attempts) if (['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(a.result)) by.set(a.orderId, (by.get(a.orderId) ?? 0) + 1);
        return [...by].map(([orderId, n]) => ({ orderId, _count: { _all: n } }));
      }),
      findMany: vi.fn(async () => world.attempts.map((a) => ({ ...a }))),
    },
    company: { findUnique: vi.fn(async () => ({ settings: '{}' })) },
    callHelperDevice: { findFirst: vi.fn(async () => null) },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
  };
  const COUNTRY = { id: 'co1', code: 'JO', timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] };
  return { db, world, rules, COUNTRY };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1', name: 'Sara', role: 'CONFIRMATION_AGENT', companyId: 'c1', status: 'ACTIVE', permissions: [] }, companyId: 'c1', storeId: 's1', countryId: 'co1', country: COUNTRY }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined, can: (_u: unknown, k: string) => k === 'confirmation.work' }));
vi.mock('@/lib/desk-watch', () => ({ DESK_NOT_FOUND: 'x', DESK_WATCH_REFUSAL: 'x', mayWatchDesks: () => true, watchedAgent: async () => ({ id: 'u2', name: 'Lina' }) }));
vi.mock('@/lib/insights-key', () => ({ mayReadInsights: () => false }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/response-clock', () => ({ firstActionTimes: async () => new Map() }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => world.proof,
  callProofSwitch: async () => (world.plan ? { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') } : { enabled: false, enabledAt: null }),
}));

import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';
import { cadenceCalOf, cadencePress, type CadenceFact } from '@/lib/no-answer-cadence';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 80;
const SEED = 20261121;
const MIN = 60_000;
const GOLDEN = join(process.cwd(), 'src/app/api/confirmation/mine/the-desk-without-order-rules.main-golden.json');
const rule = (over: Record<string, unknown>) => ({
  id: `n${Math.random()}`, companyId: 'c1', storeId: null, name: 'لا تمسك', kind: 'ORDER_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { ...scheduleOfAttempts(7), proofSeconds: 15 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});
/** Rows that bind NOTHING on these orders (store s1, products pA–pC, channel FACEBOOK). */
const BIND_NOTHING = () => [
  rule({ companyId: 'c2', productId: 'pA' }),
  rule({ isActive: false, productId: 'pA' }),
  rule({ storeId: 's2' }),
  rule({ productId: 'pZ' }),
  rule({ channelKind: 'TIKTOK' }),
  rule({ effectiveTo: new Date('2026-11-02T00:00:00.000Z'), productId: 'pB' }),
  rule({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2 } }),
];

async function runScenarios(GET: (r: Request) => Promise<Response>) {
  const records: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const next = rng(SEED + i);
    forgetConfirmationRules('c1');
    world.plan = next() < 0.8;
    world.proof = world.plan && next() < 0.9;
    world.held = [];
    world.attempts = [];
    world.products = {};
    const now = Date.UTC(2026, 10, 16 + Math.floor(next() * 3), 6 + Math.floor(next() * 10), Math.floor(next() * 60));
    const k = 1 + Math.floor(next() * 8);
    for (let j = 0; j < k; j++) {
      const id = `o${j}`;
      world.products[id] = [['pA'], ['pB'], ['pC'], ['pA', 'pB']][Math.floor(next() * 4)];
      // A history pressed door-style under the default plan: counted presses carry their stored dues; now and then an early one.
      const lines: CadenceFact[] = [];
      const cal = cadenceCalOf(new Date('2026-11-01T00:00:00.000Z'), COUNTRY, undefined);
      let t = now - (1 + Math.floor(next() * 60)) * 60 * MIN;
      const presses = Math.floor(next() * 6);
      for (let p = 0; p < presses && t < now; p++) {
        const result = ['NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED'][Math.floor(next() * 4)];
        const r = cadencePress(lines, { at: new Date(t), result }, cal);
        const line = { orderId: id, createdAt: new Date(t), result, employeeId: 'u1', attemptNumber: lines.length + 1, nextFollowUpAt: r.counted ? r.dueAt : null };
        lines.push(line as CadenceFact);
        world.attempts.push(line);
        t = r.dueAt && next() < 0.8 ? r.dueAt.getTime() + Math.floor(next() * 30) * MIN : t + (1 + Math.floor(next() * 300)) * MIN;
      }
      if (next() < 0.7) world.attempts.push({ orderId: id, createdAt: new Date(now - Math.floor(next() * 60_000)), result: 'OPENED', employeeId: 'u1', attemptNumber: lines.length + 1, nextFollowUpAt: null });
      world.held.push({
        id, orderNumber: `JO-${id}`, confirmationStatus: lines.length ? 'NO_ANSWER' : 'NEW', shippingStatus: null, totalAmount: 10, currency: 'JOD',
        claimedAt: new Date(now - 3 * 60 * MIN), nextFollowUpAt: null, postponedUntil: null,
        customer: { id: `c-${id}`, fullName: 'زبون', phone: '0791234567', rawPhone: '0791234567', totalOrders: 1 },
        items: [], addOns: [], _count: { contactAttempts: lines.length, notes: 0 },
      });
    }
    vi.setSystemTime(now);
    const body = JSON.parse(JSON.stringify(await (await GET(new Request('http://localhost/api/confirmation/mine'))).json()));
    delete body.serverNow;
    records.push(body);
  }
  return records;
}

afterEach(() => vi.useRealTimers());

describe('«طلباتي» with no order rule that binds its cards = osm/main', () => {
  it.each([
    ['no rule row', () => [], true],
    ['rows that bind nothing here', BIND_NOTHING, false],
  ])('%s → the golden, record for record', async (_name, make, neverRead) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    rules.length = 0;
    rules.push(...make());
    const from = process.env.Q4D_GOLDEN_FROM;
    if (from) writeFileSync(GOLDEN, JSON.stringify(await runScenarios((await import(/* @vite-ignore */ from)).GET)));
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown[];
    expect(golden).toHaveLength(N);
    world.factReads = 0;
    const today = await runScenarios((await import('./route')).GET);
    for (let i = 0; i < N; i++) expect(today[i], `desk ${i}`).toEqual(golden[i]);
    if (neverRead) expect(world.factReads).toBe(0);
  });
});
