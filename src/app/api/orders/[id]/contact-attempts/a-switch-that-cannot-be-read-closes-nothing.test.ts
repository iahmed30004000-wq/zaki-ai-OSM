import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REQUEST C2, decision 8 (finding #23 of the rules map): A FAILED READ OF THE PLAN'S SWITCH NEVER CLOSES BY THREE.
 *
 * The switch is OFF for ten seconds after a read that threw — and OFF at this door is the old rule: the third «لا يرد» of all time closes the order. So:
 *  · the database does not answer the switch's read → a «لا يرد» (or «مشغول», «مسكّر») is refused 503 with a plain Arabic sentence and a code; NOTHING is written, nothing
 *    is counted, nothing closes; it stays refused for the ten seconds the failure is remembered, and the first good read after them decides as ever;
 *  · any other result (an answered call) goes on as before — it closes nothing;
 *  · a read that WORKED and said «off» is not a failure: the old rule runs, the third closes (the way back, as on main).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, store, requireContext, assertOrderAccess, endOrder } = vi.hoisted(() => {
  const store = { fail: false, settings: {} as Record<string, unknown> };
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        if (store.fail) throw new Error('db down');
        return { settings: JSON.stringify(store.settings) };
      }),
    },
    orderContactAttempt: { findFirst: vi.fn(async () => ({ attemptNumber: 2 })), create: vi.fn(async ({ data }: any) => ({ id: 'a3', ...data })), count: vi.fn(async () => 3), findMany: vi.fn(async () => []) },
    order: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
  } as any;
  return { db, store, requireContext: vi.fn(), assertOrderAccess: vi.fn(), endOrder: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a), assertOrderReadable: vi.fn(), ORDER_ACCESS_STATUS: { NOT_FOUND: 404 } }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => ({ enabled: false, enabledAt: null }) }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => ({ enabled: false, enabledAt: null }) }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';
import { callProofReadFailed, callProofSwitch, forgetCallProofSwitch } from '@/lib/call-proof-switch';

const params = { params: Promise.resolve({ id: 'o1' }) };
const send = (result: string) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', result }) }), params);

beforeEach(() => {
  vi.clearAllMocks();
  forgetCallProofSwitch();
  store.fail = false;
  store.settings = {};
  requireContext.mockResolvedValue({ user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT' }, companyId: 'c-unread', storeId: 's1', country: { timezone: 'Asia/Amman', workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6] } });
  assertOrderAccess.mockResolvedValue({ allowed: true, order: { id: 'o1', claimedById: 'u1', claimedAt: new Date(), confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', nextFollowUpAt: null, followUpStatus: null } });
  endOrder.mockResolvedValue({ ok: true, afterCommit: undefined });
});

describe('the switch could not be read', () => {
  it.each(['NO_ANSWER', 'BUSY', 'UNREACHABLE'])('«%s» is refused 503 in Arabic — nothing written, nothing counted, nothing closed (never the three-close)', async (result) => {
    store.fail = true;
    const res = await send(result);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('PLAN_SWITCH_UNREAD');
    expect(body.errorAr).toBe('ما قدرنا نقرأ قاعدة المحاولات هلّق، وما انسجّل شي. جرّبي «لا يرد» كمان شوي.');
    expect(/[A-Za-z]/.test(body.errorAr)).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.count).not.toHaveBeenCalled();
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('an answered call goes on as before (it closes nothing)', async () => {
    store.fail = true;
    const res = await send('ANSWERED');
    expect(res.status).toBe(200);
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
    expect(endOrder).not.toHaveBeenCalled();
  });

  it('the failure is remembered for the switch\'s ten seconds (no second query), and the first good read after them decides as ever', async () => {
    store.fail = true;
    await callProofSwitch(db, 'c-cache', 1_000);
    expect(callProofReadFailed('c-cache', 5_000)).toBe(true);
    expect(callProofReadFailed('c-cache', 11_000)).toBe(false);
    store.fail = false;
    await callProofSwitch(db, 'c-cache', 12_000);
    expect(callProofReadFailed('c-cache', 12_001)).toBe(false);
  });
});

describe('NEGATIVE — a read that WORKED is not a failure: the plan off is main\'s rule', () => {
  it('the switch read fine and says off: the third «لا يرد» closes by three, as on main', async () => {
    const res = await send('NO_ANSWER');
    expect(res.status).toBe(200);
    expect((await res.json()).autoClosed).toBe(true);
    expect(endOrder).toHaveBeenCalledTimes(1);
    expect(endOrder.mock.calls[0][0].reason).toBe('NO_ANSWER_3_ATTEMPTS');
  });

  it('a settings document that does not parse is OFF, not «unreadable» (the old rule, as on main)', async () => {
    db.company.findUnique.mockResolvedValueOnce({ settings: '{not json' });
    const res = await send('NO_ANSWER');
    expect(res.status).toBe(200);
    expect(callProofReadFailed('c-unread')).toBe(false);
  });
});
