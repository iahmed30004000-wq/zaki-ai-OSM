import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST Q4d — THE DIFFERENTIAL: «NO ORDER RULE = osm/main, BYTE FOR BYTE» AT THE CONTACT DOOR
 *
 * `the-contact-door-without-order-rules.main-golden.json` was written by THIS file with `Q4D_GOLDEN_FROM` naming a copy of this door's `route.ts` as it is on
 * `osm/main` db1f1b20 (before the order numbers acted), over the seeded scenarios below: random countries, the plan «إثبات المكالمات وجدول المحاولات» on or off,
 * random presses (every result, random gaps from a minute to a day and a half, a «اتصال» from 5 to 90 s before, the holder or a colleague), and the order window's GET.
 * Recorded per press: the status and the whole answer, the line written, the close asked of the one door, the release.
 *
 * Today's door answers them with NO rule row, and again with rows that bind NOTHING here (another company, stopped, another store, another product, another
 * channel, an employee rule, a priority rule): both must be the golden, record for record.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, rows, out, ctx, rules, sw } = vi.hoisted(() => {
  const rows: any[] = [];
  const out: any[] = [];
  const rules: any[] = [];
  const ctx = { country: null as any, holder: 'u1' };
  const sw = { on: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') };
  const db = {
    orderContactAttempt: {
      findFirst: vi.fn(async () => (rows.length ? { attemptNumber: rows[rows.length - 1].attemptNumber } : null)),
      findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
      count: vi.fn(async () => rows.filter((r) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(r.result)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, id: `a${rows.length + 1}`, createdAt: data.createdAt ?? new Date() };
        rows.push(row);
        out.push({ line: { ...data } });
        return { ...row, employee: { id: 'u1', name: 'Agent' } };
      }),
    },
    order: {
      updateMany: vi.fn(async () => (out.push({ release: true }), { count: 1 })),
      findMany: vi.fn(async () => [{ id: 'o1', storeId: 's1', productId: 'pA', channel: { kind: 'FACEBOOK' }, items: [{ productId: 'pA' }] }]),
    },
    orderClaimHistory: {
      create: vi.fn(async () => undefined),
      findFirst: vi.fn(async () => ({ id: 'h1', metadata: JSON.stringify({ automatic: true, holder: 'u1' }) })),
      update: vi.fn(async () => undefined),
    },
    confirmationRule: { findMany: vi.fn(async () => rules.map((r) => ({ ...r }))) },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  } as any;
  return { db, rows, out, ctx, rules, sw };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' }, companyId: 'c1', storeId: 's1', country: ctx.country }),
}));
vi.mock('@/lib/rbac', () => {
  const order = () => ({
    id: 'o1', companyId: 'c1', storeId: 's1', productId: 'pA', channelId: 'ch1', claimedById: ctx.holder, claimedAt: new Date('2026-11-15T06:00:00.000Z'),
    confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY',
  });
  return {
    assertOrderAccess: async () => ({ allowed: true, order: order() }),
    assertOrderReadable: async () => ({ allowed: true, order: order() }),
    ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 404 },
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (a: any) => void out.push({ audit: a.newData })) }));
vi.mock('@/lib/order-cancel', () => ({
  endOrder: vi.fn(async (a: any) => {
    const rest = { ...a };
    delete rest.tx;
    out.push({ close: rest });
    return { ok: true, orderNumber: 'ORD-1', afterCommit: async () => undefined };
  }),
}));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/desk-refusals', () => ({ logDeskRefusal: async () => undefined }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/call-proof-switch', () => ({
  callProofOn: async () => sw.on,
  callProofReadFailed: () => false,
  callProofSwitch: async () => (sw.on ? { enabled: true, enabledAt: sw.enabledAt } : { enabled: false, enabledAt: null }),
}));

import { forgetConfirmationRules } from '@/lib/employee-numbers';
import { scheduleOfAttempts } from '@/lib/confirmation-own-rules';


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

const COUNTRIES = [
  { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
  { workHoursStart: '10:00', workHoursEnd: '22:00', weekendDays: [5], timezone: 'Asia/Damascus' },
  { workHoursStart: '08:00', workHoursEnd: '20:00', weekendDays: [], timezone: 'UTC' },
];
const RESULTS = ['NO_ANSWER', 'NO_ANSWER', 'NO_ANSWER', 'BUSY', 'UNREACHABLE', 'ANSWERED', 'CALLBACK_REQUESTED', 'WRONG_NUMBER'];
const N = 120;
const SEED = 20261121;
const GOLDEN = join(process.cwd(), 'src/app/api/orders/[id]/contact-attempts/the-contact-door-without-order-rules.main-golden.json');

const rule = (over: Record<string, unknown>) => ({
  id: `n${Math.random()}`, companyId: 'c1', storeId: null, name: 'لا تمسك', kind: 'ORDER_NUMBERS', userIds: null, productId: null, channelKind: null, phase: null, hoursFrom: null, hoursTo: null,
  effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), effectiveTo: null, isActive: true, payload: { ...scheduleOfAttempts(3), proofSeconds: 15, postponeMax: 1 }, createdAt: new Date('2026-11-01T00:00:00.000Z'), ...over,
});
/** Rows that bind NOTHING on order o1 (store s1, product pA, channel FACEBOOK). */
const BIND_NOTHING = () => [
  rule({ companyId: 'c2', productId: 'pA' }),
  rule({ isActive: false, productId: 'pA' }),
  rule({ storeId: 's2' }),
  rule({ productId: 'pZ' }),
  rule({ channelKind: 'TIKTOK' }),
  rule({ effectiveFrom: new Date('2027-01-01T00:00:00.000Z') }),
  rule({ kind: 'EMPLOYEE_NUMBERS', payload: { hand: 2, idleMinutes: 15 } }),
  rule({ kind: 'PRIORITY', productId: 'pA', payload: { first: true } }),
];

type Door = (r: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>;

async function runScenarios(door: { POST: Door; GET: Door }) {
  const records: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const next = rng(SEED + i);
    rows.length = 0;
    out.length = 0;
    forgetConfirmationRules('c1');
    ctx.country = COUNTRIES[Math.floor(next() * COUNTRIES.length)];
    sw.on = next() < 0.75;
    let t = Date.UTC(2026, 10, 15, 6 + Math.floor(next() * 10), Math.floor(next() * 60));
    const presses = 1 + Math.floor(next() * 8);
    const scenario: unknown[] = [];
    for (let p = 0; p < presses; p++) {
      ctx.holder = next() < 0.85 ? 'u1' : 'colleague';
      const result = RESULTS[Math.floor(next() * RESULTS.length)];
      const openedBefore = (5 + Math.floor(next() * 86)) * 1000;
      rows.push({ id: `o${rows.length}`, orderId: 'o1', companyId: 'c1', createdAt: new Date(t - openedBefore), result: 'OPENED', employeeId: 'u1', attemptNumber: rows.length + 1, nextFollowUpAt: null });
      vi.setSystemTime(t);
      out.length = 0;
      const res = await door.POST(
        new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', result }) }),
        { params: Promise.resolve({ id: 'o1' }) }
      );
      scenario.push({ status: res.status, body: JSON.parse(JSON.stringify(await res.json())), writes: JSON.parse(JSON.stringify(out)) });
      t += (1 + Math.floor(next() * (next() < 0.5 ? 90 : 2200))) * 60_000;
    }
    vi.setSystemTime(t);
    const got = await door.GET(new Request('http://x'), { params: Promise.resolve({ id: 'o1' }) });
    const window = JSON.parse(JSON.stringify(await got.json()));
    scenario.push({ window: window.callProof ?? null, summary: window.summary });
    records.push({ country: ctx.country.timezone, on: sw.on, scenario });
  }
  return records;
}

afterEach(() => vi.useRealTimers());

describe('the contact door with no order rule that binds it = osm/main', () => {
  it.each([
    ['no rule row', () => []],
    ['rows that bind nothing here', BIND_NOTHING],
  ])('%s → the golden, record for record', async (_name, make) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    rules.length = 0;
    rules.push(...make());
    const from = process.env.Q4D_GOLDEN_FROM;
    if (from) {
      const main = await import(/* @vite-ignore */ from);
      writeFileSync(GOLDEN, JSON.stringify(await runScenarios(main)));
    }
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as unknown[];
    expect(golden).toHaveLength(N);
    const today = await runScenarios(await import('./route'));
    for (let i = 0; i < N; i++) expect(today[i], `scenario ${i}`).toEqual(golden[i]);
  });
});
