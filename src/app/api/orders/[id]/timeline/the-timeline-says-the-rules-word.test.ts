import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE TIMELINE'S «رجع للطابور فوراً» LINE WEARS THE WORD OF THE RULE THAT WROTE IT (the planner 15/11, answer 15; ruling 28 of 15/11 22:30)
 *
 *  1. A line the OLDER doors wrote (no rule mark in its metadata — any metadata, or none) reads «… بيجهز بعد 3 ساعات دوام», the older mode's word byte for byte as before the plan.
 *     The stored reason is the same string either way (`NO_ANSWER_RETURNED`): only the reader's word differs.
 *  2. A line the PLAN's door wrote (`{ "rule": "plan" }` merged into its metadata) reads «… بيجهز لما يحين موعد محاولته الجاية» — no number.
 *  3. THE SWITCH AT READ TIME DECIDES NOTHING: flip «جدول المحاولات» after the lines were written and no line changes its word — a plan line read with the key now OFF still reads the
 *     plan word, an old line read with the key now ON still reads the older word. The door reads no switch at all: no settings read, no cache, nothing extra to pay.
 *  4. Every other line of the history is the same marked or not (the idle release, the date's return, the plain claim words), and the payload keeps its keys.
 *
 * Driven through the REAL route and the REAL `orderTimeline` over an in-memory history: the word on the page is the one that came out of the whole chain.
 * Blockers: any change to a stored value, a payload key or a status; the wrong word for a line's own mark.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, state } = vi.hoisted(() => {
  const state = {
    settings: {} as Record<string, unknown>,
    reason: 'NO_ANSWER_RETURNED',
    metadata: null as string | null,
  };
  const at = new Date('2026-11-02T10:00:00Z');
  const none = () => ({ findMany: vi.fn(async () => []) });
  const db = {
    company: {
      findUnique: vi.fn(async () => ({ settings: JSON.stringify(state.settings) })),
    },
    orderClaimHistory: {
      findMany: vi.fn(async () => [{ id: 'h1', createdAt: at, action: 'RELEASED', userId: 'sara', reason: state.reason, metadata: state.metadata }]),
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
import { automaticReleaseMetadata } from '@/lib/auto-release';
import { DATE_RETURNED_REASON, IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON, withPlanRuleMark } from '@/lib/no-answer-returns';

const OLD_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز بعد 3 ساعات دوام';
const PLAN_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز لما يحين موعد محاولته الجاية';
const PLAN_ON = { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };
const OLD_LINE = automaticReleaseMetadata('sara');
const PLAN_LINE = withPlanRuleMark(OLD_LINE);

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
  state.metadata = OLD_LINE;
});

describe('the «رجع للطابور فوراً» line, by the mark on the line', () => {
  it('a line with no mark: the older mode’s word, exactly', async () => {
    const body = await read();
    expect(body.events[0].detail).toBe(OLD_WORD);
    expect(body.events[0]).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام' });
  });

  it('a line with no metadata at all (the oldest rows): the older mode’s word', async () => {
    state.metadata = null;
    expect((await read()).events[0].detail).toBe(OLD_WORD);
  });

  it('a line the plan wrote: the number-free word, and the system is still the actor', async () => {
    state.metadata = PLAN_LINE;
    const body = await read();
    expect(body.events[0].detail).toBe(PLAN_WORD);
    expect(body.events[0].detail).not.toMatch(/\d|ساعات|ثلاث|خمس/);
    expect(body.events[0]).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام' });
  });

  /** THE REWRITTEN PINS (ruling 28): the key is flipped AFTER the lines were written, and the words stay. */
  it('a PLAN line read with the key now OFF (stored off, never stored, turned back off, not plainly on) still reads the plan word', async () => {
    state.metadata = PLAN_LINE;
    for (const stored of [undefined, { enabled: false, enabledAt: null }, { enabled: true }, { enabled: true, enabledAt: 'not a date' }, 'on', null]) {
      state.settings = stored === undefined ? {} : { callProofAndCadence: stored };
      forgetCallProofSwitch();
      expect((await read()).events[0].detail, JSON.stringify(stored)).toBe(PLAN_WORD);
    }
  });

  it('an OLD line read with the key now ON still reads the older word — turning the plan on rewrites no history', async () => {
    state.metadata = OLD_LINE;
    state.settings = { callProofAndCadence: PLAN_ON };
    expect((await read()).events[0].detail).toBe(OLD_WORD);
  });

  it('the legacy returns mode on, the plan off: an unmarked line reads the older word; a plan line the plan word', async () => {
    state.settings = { noAnswerRounds: PLAN_ON, noAnswerReturns: PLAN_ON };
    expect((await read()).events[0].detail).toBe(OLD_WORD);
    state.metadata = PLAN_LINE;
    expect((await read()).events[0].detail).toBe(PLAN_WORD);
  });

  it('a switch that cannot be read changes nothing — the door never asks it, and the page still answers', async () => {
    db.company.findUnique.mockRejectedValue(new Error('db down'));
    expect((await read()).events[0].detail).toBe(OLD_WORD);
    state.metadata = PLAN_LINE;
    expect((await read()).events[0].detail).toBe(PLAN_WORD);
  });

  it('the door pays NO settings read for it: the company’s settings are never asked, with the key on, off or unreadable', async () => {
    for (const settings of [{}, { callProofAndCadence: PLAN_ON }]) {
      state.settings = settings;
      forgetCallProofSwitch();
      await read();
    }
    expect(db.company.findUnique).not.toHaveBeenCalled();
  });

  it('the other lines read the same marked or not, in both worlds, and the payload keeps its keys', async () => {
    for (const reason of [DATE_RETURNED_REASON, IDLE_RETURNED_REASON, 'PULL_NEXT']) {
      state.reason = reason;
      state.metadata = OLD_LINE;
      const unmarked = await read();
      state.metadata = PLAN_LINE;
      state.settings = { callProofAndCadence: PLAN_ON };
      forgetCallProofSwitch();
      const marked = await read();
      expect(marked.events[0].detail, reason).toBe(unmarked.events[0].detail);
      expect(Object.keys(marked).sort()).toEqual(['count', 'events', 'orderNumber', 'state', 'zone']);
      expect(Object.keys(unmarked).sort()).toEqual(Object.keys(marked).sort());
    }
  });
});
