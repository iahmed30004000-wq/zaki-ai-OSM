import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE TIMELINE'S «رجع للطابور فوراً» LINE WEARS THE WORD OF THE RULE THAT IS ON (the planner 15/11, answer 15)
 *
 *  1. Plan OFF (or the switch unreadable): the line reads «… بيجهز بعد 3 ساعات دوام» — the older mode's word, byte for byte as before the plan. The stored reason is the
 *     same string either way (`NO_ANSWER_RETURNED`): only the reader's word changes.
 *  2. Plan ON (`Company.settings.callProofAndCadence` plainly on): the same line reads «… بيجهز لما يحين موعد محاولته الجاية» — no number.
 *  3. The door pays ONE extra read for it (the company's settings, cached ten seconds — the switch's own reader), and asks nothing else new.
 *  4. Every other line of the history is the same in both worlds (the idle release, the date's return, the plain claim words).
 *
 * Driven through the REAL route and the REAL `orderTimeline` over an in-memory history: the word on the page is the one that came out of the whole chain.
 * Blockers: any change to a stored value, a payload key or a status; the wrong word for the switch's state.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, state } = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, unknown>,
    reason: 'NO_ANSWER_RETURNED',
    settingsReads: 0,
  };
  const at = new Date('2026-11-02T10:00:00Z');
  const none = () => ({ findMany: vi.fn(async () => []) });
  const db = {
    company: {
      findUnique: vi.fn(async () => {
        state.settingsReads += 1;
        return { settings: JSON.stringify(state.settings) };
      }),
    },
    orderClaimHistory: {
      findMany: vi.fn(async () => [{ id: 'h1', createdAt: at, action: 'RELEASED', userId: 'sara', reason: state.reason, metadata: JSON.stringify({ automatic: true, holder: 'sara' }) }]),
    },
    orderStatusLog: none(),
    orderContactAttempt: none(),
    callLog: none(),
    callHelperReading: none(),
    deliveryAttempt: none(),
    orderNote: none(),
    orderActivity: none(),
    orderChangeRequest: none(),
    orderIssue: none(),
    user: { findMany: vi.fn(async () => [{ id: 'sara', name: 'سارة' }]) },
  };
  return { db, state };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'sara', role: 'CONFIRMATION_AGENT' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/rbac', () => ({
  ORDER_ACCESS_STATUS: { NOT_FOUND: 404 },
  assertOrderReadable: async () => ({ allowed: true, order: { orderNumber: 'ORD-1', confirmationStatus: 'IN_PROGRESS', shippingStatus: 'NOT_READY', claimedById: null } }),
}));

import { GET } from './route';
import { forgetCallProofSwitch } from '@/lib/call-proof-switch';
import { DATE_RETURNED_REASON, IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON } from '@/lib/no-answer-returns';

const OLD_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز بعد 3 ساعات دوام';
const PLAN_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز لما يحين موعد محاولته الجاية';
const PLAN_ON = { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };

const read = async () => {
  const res = await GET(new Request('http://x/'), { params: Promise.resolve({ id: 'o1' }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { events: { title: string; detail: string | null; actorName: string | null }[]; count: number; orderNumber: string };
};

beforeEach(() => {
  vi.clearAllMocks();
  forgetCallProofSwitch();
  state.settings = {};
  state.reason = NO_ANSWER_RETURNED_REASON;
  state.settingsReads = 0;
});

describe('the «رجع للطابور فوراً» line, by the switch', () => {
  it('the plan OFF (nothing stored): the older mode’s word, exactly', async () => {
    const body = await read();
    expect(body.events[0].detail).toBe(OLD_WORD);
    expect(body.events[0]).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام' });
  });

  it('the plan stored but OFF, or stored as something that is not plainly on: still the older mode’s word', async () => {
    for (const stored of [{ enabled: false, enabledAt: null }, { enabled: true }, { enabled: true, enabledAt: 'not a date' }, 'on', null]) {
      state.settings = { callProofAndCadence: stored };
      forgetCallProofSwitch();
      expect((await read()).events[0].detail, JSON.stringify(stored)).toBe(OLD_WORD);
    }
  });

  it('the plan ON: the number-free word', async () => {
    state.settings = { callProofAndCadence: PLAN_ON };
    const body = await read();
    expect(body.events[0].detail).toBe(PLAN_WORD);
    expect(body.events[0].detail).not.toMatch(/\d|ساعات|ثلاث|خمس/);
  });

  it('the legacy returns mode on, the plan OFF: the older mode’s word (the older mode is the one it describes)', async () => {
    state.settings = { noAnswerRounds: PLAN_ON, noAnswerReturns: PLAN_ON };
    expect((await read()).events[0].detail).toBe(OLD_WORD);
  });

  it('a switch that cannot be read is OFF, and so is the word — the page still answers', async () => {
    db.company.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect((await read()).events[0].detail).toBe(OLD_WORD);
  });

  it('ONE extra read for it: the company’s settings, and the second request inside the cache window pays none', async () => {
    state.settings = { callProofAndCadence: PLAN_ON };
    await read();
    expect(state.settingsReads).toBe(1);
    await read();
    expect(state.settingsReads).toBe(1);
  });

  it('the other lines read the same in both worlds, and the payload keeps its keys', async () => {
    for (const reason of [DATE_RETURNED_REASON, IDLE_RETURNED_REASON, 'PULL_NEXT']) {
      state.reason = reason;
      state.settings = {};
      forgetCallProofSwitch();
      const off = await read();
      state.settings = { callProofAndCadence: PLAN_ON };
      forgetCallProofSwitch();
      const on = await read();
      expect(on.events[0].detail, reason).toBe(off.events[0].detail);
      expect(Object.keys(on).sort()).toEqual(['count', 'events', 'orderNumber', 'state', 'zone']);
      expect(Object.keys(off).sort()).toEqual(Object.keys(on).sort());
    }
  });
});
