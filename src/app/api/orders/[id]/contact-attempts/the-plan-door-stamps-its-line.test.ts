import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PLAN'S DOOR STAMPS THE LINE IT WRITES, AND THE TIMELINE READS THE STAMP (the planner 15/11 22:30, ruling 28)
 *
 * What must work
 *  1. Under «جدول المحاولات» a COUNTED «لا يرد» press that sends the order back writes its `NO_ANSWER_RETURNED` release line as it always did (the same `create`, the same metadata
 *     `{ automatic, holder }`) and, in the SAME transaction, stamps `{ "rule": "plan" }` into that line's metadata — merged: every key the line already carried stays.
 *  2. The older doors (the three-hour mode: the plan OFF, the returns mode on) write NOTHING new: no read of the line, no update, the metadata byte for byte what it was.
 *  3. Nothing is stamped when nothing was released: an early press under the plan (kept and told), a press by someone who does not hold the order, a release that lost its race.
 *  4. The timeline reads the word from the LINE: a plan line says the plan's word and an unmarked line the older word, whatever the switch says when it is read (the reader holds no switch).
 *
 * The tests: the real route over a small stateful fake of the tables (the stamp is read back through the real `orderTimeline`); the metadata merge and the readers that parse that column.
 * Edge cases: a line whose metadata is empty or not JSON; a mark on any reason other than `NO_ANSWER_RETURNED`; readers of the column (`isAutomaticRelease`, `managerReturnedBy`) unmoved by the extra key.
 * Blockers: any change to a stored value other than that one key, to money, to order creation, to a contract; the OFF path writing or reading one statement more.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, claims, requireContext, assertOrderAccess, logAudit, endOrder, proof, cad, sw, rsw, attempts } = vi.hoisted(() => {
  const claims: any[] = [];
  const attempts: any[] = [];
  const db = {
    orderContactAttempt: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    order: { update: vi.fn(), updateMany: vi.fn() },
    orderClaimHistory: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  } as any;
  return {
    db,
    claims,
    attempts,
    requireContext: vi.fn(),
    assertOrderAccess: vi.fn(),
    logAudit: vi.fn(),
    endOrder: vi.fn(),
    proof: { on: true },
    cad: { value: { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') } as { enabled: boolean; enabledAt: Date | null } },
    sw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
    rsw: { value: { enabled: false, enabledAt: null } as { enabled: boolean; enabledAt: Date | null } },
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/order-cancel', () => ({ endOrder: (...a: unknown[]) => endOrder(...a) }));
vi.mock('@/lib/authorization', () => ({ can: () => true, authorize: () => ({ allowed: true }) }));
vi.mock('@/lib/no-answer-rounds-switch', () => ({ roundsSwitch: async () => sw.value }));
vi.mock('@/lib/no-answer-returns-switch', () => ({ returnsSwitch: async () => rsw.value }));
vi.mock('@/lib/call-proof-switch', () => ({ callProofOn: async () => proof.on, callProofSwitch: async () => (proof.on ? cad.value : { enabled: false, enabledAt: null }) }));

import { POST } from '@/app/api/orders/[id]/contact-attempts/route';
import { orderTimeline } from '@/lib/order-timeline';
import { isAutomaticRelease, managerReturnedBy, automaticReleaseMetadata } from '@/lib/auto-release';
import { NO_ANSWER_RETURNED_REASON, DATE_RETURNED_REASON, PLAN_RULE_MARK, markPlanReturnLine, ruleOfLine, withPlanRuleMark } from '@/lib/no-answer-returns';

const OLD_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز بعد 3 ساعات دوام';
const PLAN_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز لما يحين موعد محاولته الجاية';
const T0 = new Date('2026-11-15T10:00:00.000Z'); // 13:00 in Amman, a working Sunday
const MIN = 60_000;
const params = { params: Promise.resolve({ id: 'o1' }) };
const send = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactMethod: 'PHONE', ...body }) }), params);
let heldBy = 'u1';
let raceLost = false;

/** A press at `when`, with its own proven «اتصال» a minute before it (the step-A guard is part of this door). */
async function pressAt(when: Date, result = 'NO_ANSWER') {
  attempts.push({ id: `s${attempts.length}`, orderId: 'o1', companyId: 'c1', createdAt: new Date(when.getTime() - MIN), result: 'OPENED', employeeId: 'u1', attemptNumber: attempts.length + 1 });
  vi.setSystemTime(when);
  const res = await send({ result });
  return res.json();
}

/** The history as the timeline reads it: the real `orderTimeline` over the fake's claim rows (every other table empty). */
async function timelineOf() {
  const none = { findMany: async () => [] };
  const fake = {
    orderClaimHistory: { findMany: async () => claims.map((c) => ({ ...c })) },
    orderStatusLog: none, orderContactAttempt: none, callLog: none, callHelperReading: none, deliveryAttempt: none, orderNote: none, orderActivity: none, orderChangeRequest: none, orderIssue: none,
    user: { findMany: async () => [{ id: 'u1', name: 'سارة' }] },
  };
  return orderTimeline(fake as never, 'o1');
}
const returnLine = () => claims.find((c) => c.reason === NO_ANSWER_RETURNED_REASON);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  claims.length = 0;
  attempts.length = 0;
  heldBy = 'u1';
  raceLost = false;
  proof.on = true;
  cad.value = { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') };
  sw.value = { enabled: false, enabledAt: null };
  rsw.value = { enabled: false, enabledAt: null };
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Agent', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5, 6], timezone: 'Asia/Amman' },
  });
  // `claimedAt` is an hour before the press, whenever the press is.
  assertOrderAccess.mockImplementation(async () => ({
    allowed: true,
    order: { id: 'o1', claimedById: heldBy, claimedAt: new Date(Date.now() - 3_600_000), confirmationStatus: 'IN_PROGRESS', nextFollowUpAt: null, followUpStatus: null, shippingStatus: 'NOT_READY' },
  }));
  db.orderContactAttempt.findFirst.mockImplementation(async () => (attempts.length ? { attemptNumber: attempts[attempts.length - 1].attemptNumber } : null));
  db.orderContactAttempt.findMany.mockImplementation(async () => attempts.map((r) => ({ ...r })));
  db.orderContactAttempt.count.mockImplementation(async () => attempts.filter((r) => ['NO_ANSWER', 'BUSY', 'UNREACHABLE'].includes(r.result)).length);
  db.orderContactAttempt.create.mockImplementation(async ({ data }: any) => {
    const row = { ...data, id: `a${attempts.length + 1}`, createdAt: data.createdAt ?? new Date() };
    attempts.push(row);
    return row;
  });
  db.order.updateMany.mockImplementation(async () => ({ count: raceLost ? 0 : 1 }));
  db.orderClaimHistory.create.mockImplementation(async ({ data }: any) => {
    claims.push({ ...data, id: `h${claims.length + 1}`, createdAt: new Date() });
  });
  db.orderClaimHistory.findFirst.mockImplementation(async ({ where }: any) => {
    const hit = [...claims].reverse().find((c) => c.orderId === where.orderId && c.userId === where.userId && c.action === where.action && c.reason === where.reason);
    return hit ? { id: hit.id, metadata: hit.metadata } : null;
  });
  db.orderClaimHistory.update.mockImplementation(async ({ where, data }: any) => {
    Object.assign(claims.find((c) => c.id === where.id), data);
  });
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  endOrder.mockResolvedValue({ ok: true, orderNumber: 'ORD-1', afterCommit: vi.fn() });
});

afterEach(() => vi.useRealTimers());

describe('the plan ON: a counted press stamps the line it wrote', () => {
  it('the line is written as ever (same create, same metadata) and then carries the plan mark merged into it — one read, one update, by the line’s id', async () => {
    const body = await pressAt(T0);
    expect(body).toMatchObject({ returnedToQueue: true });
    // The `create` is exactly what it was before the mark existed.
    expect(db.orderClaimHistory.create).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: 'NO_ANSWER_RETURNED', metadata: JSON.stringify({ automatic: true, holder: 'u1' }) },
    });
    expect(db.orderClaimHistory.findFirst).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.update).toHaveBeenCalledTimes(1);
    expect(db.orderClaimHistory.update.mock.calls[0][0].where).toEqual({ id: 'h1' });
    // Merged, not replaced: `automatic` and `holder` are still there.
    expect(JSON.parse(returnLine().metadata)).toEqual({ automatic: true, holder: 'u1', rule: 'plan' });
  });

  it('the stamp reads the NEWEST release of this holder on this order — an older release line of the same reason is left alone', async () => {
    claims.push({ id: 'old', companyId: 'c1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: NO_ANSWER_RETURNED_REASON, metadata: automaticReleaseMetadata('u1'), createdAt: new Date(T0.getTime() - 86_400_000) });
    await pressAt(T0);
    expect(JSON.parse(claims[0].metadata)).toEqual({ automatic: true, holder: 'u1' });
    expect(JSON.parse(claims[1].metadata)).toEqual({ automatic: true, holder: 'u1', rule: 'plan' });
    const asked = db.orderClaimHistory.findFirst.mock.calls[0][0];
    expect(asked.where).toEqual({ companyId: 'c1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: NO_ANSWER_RETURNED_REASON });
    expect(asked.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('an EARLY press (kept and told, nothing released) stamps nothing', async () => {
    await pressAt(T0);
    db.orderClaimHistory.findFirst.mockClear();
    db.orderClaimHistory.update.mockClear();
    const body = await pressAt(new Date(T0.getTime() + 30 * MIN - 1));
    expect(body.returnedToQueue).toBeUndefined();
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.update).not.toHaveBeenCalled();
  });

  it('a press by someone who does NOT hold the order releases nothing and stamps nothing', async () => {
    heldBy = 'someone-else';
    const body = await pressAt(T0);
    expect(body.returnedToQueue).toBeUndefined();
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.update).not.toHaveBeenCalled();
  });

  it('a release that lost its race (the order moved in the same instant) writes no line and so stamps none', async () => {
    raceLost = true;
    await pressAt(T0);
    expect(db.orderClaimHistory.create).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.update).not.toHaveBeenCalled();
  });
});

describe('the older door (the plan OFF, the three-hour mode on): the line is byte for byte what it was', () => {
  beforeEach(() => {
    cad.value = { enabled: false, enabledAt: null };
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
  });

  it('writes the line with its old metadata and reads/updates nothing else on the claim history', async () => {
    const body = await pressAt(T0);
    expect(body).toMatchObject({ returnedToQueue: true });
    expect(db.orderClaimHistory.create).toHaveBeenCalledWith({
      data: { companyId: 'c1', orderId: 'o1', userId: 'u1', action: 'RELEASED', reason: 'NO_ANSWER_RETURNED', metadata: JSON.stringify({ automatic: true, holder: 'u1' }) },
    });
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.update).not.toHaveBeenCalled();
    expect(ruleOfLine(returnLine())).toBeNull();
  });

  it('the proof OFF as well (nothing of step A or B is on): the same', async () => {
    proof.on = false;
    await pressAt(T0);
    expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
    expect(db.orderClaimHistory.update).not.toHaveBeenCalled();
  });
});

describe('the timeline reads the mark on the LINE, not the switch at read time', () => {
  it('a plan line says the plan’s word; an old line, written by the older door, says the older word — in one history, side by side', async () => {
    // First the older door (plan off) …
    cad.value = { enabled: false, enabledAt: null };
    sw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    rsw.value = { enabled: true, enabledAt: new Date('2026-11-01T00:00:00.000Z') };
    await pressAt(new Date(T0.getTime() - 7 * 86_400_000)); // a working Sunday, a week before
    // … then the owner turns the plan on and the plan's door writes the next one.
    cad.value = { enabled: true, enabledAt: new Date('2026-11-14T00:00:00.000Z') };
    sw.value = { enabled: false, enabledAt: null };
    rsw.value = { enabled: false, enabledAt: null };
    await pressAt(T0);
    expect(claims).toHaveLength(2);

    const lines = (await timelineOf()).filter((e) => e.kind === 'OWNERSHIP');
    expect(lines.map((l) => l.detail)).toEqual([OLD_WORD, PLAN_WORD]);
    // The actor and the title are the system's in both worlds, as they were.
    for (const l of lines) expect(l).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام', actorId: null });
  });
});

describe('the mark, as a pure value', () => {
  it('ruleOfLine: only a plain "plan" counts; no metadata, bad JSON, arrays, other rules and other types read as no mark — and it never throws', () => {
    expect(ruleOfLine({ metadata: JSON.stringify({ rule: 'plan' }) })).toBe(PLAN_RULE_MARK);
    expect(ruleOfLine({ metadata: JSON.stringify({ automatic: true, holder: 'u1', rule: 'plan' }) })).toBe('plan');
    for (const metadata of [null, undefined, '', 'not json', '[]', 'null', '"plan"', '7', JSON.stringify({ rule: 'three-hours' }), JSON.stringify({ rule: 1 }), JSON.stringify({ Rule: 'plan' }), JSON.stringify({ automatic: true })]) {
      expect(ruleOfLine({ metadata }), String(metadata)).toBeNull();
    }
  });

  it('withPlanRuleMark: keeps every key the line had, adds the mark, and survives metadata that is not an object', () => {
    expect(JSON.parse(withPlanRuleMark(automaticReleaseMetadata('u1')))).toEqual({ automatic: true, holder: 'u1', rule: 'plan' });
    expect(JSON.parse(withPlanRuleMark(JSON.stringify({ a: 1, rule: 'x' })))).toEqual({ a: 1, rule: 'plan' });
    for (const bad of [null, undefined, '', 'not json', '[1]', 'null', '5']) expect(JSON.parse(withPlanRuleMark(bad as never)), String(bad)).toEqual({ rule: 'plan' });
  });

  it('markPlanReturnLine: false and no write when there is no such line', async () => {
    const tx = { orderClaimHistory: { findFirst: vi.fn(async () => null), update: vi.fn() } };
    expect(await markPlanReturnLine(tx as never, { companyId: 'c1', orderId: 'o1', holderId: 'u1' })).toBe(false);
    expect(tx.orderClaimHistory.update).not.toHaveBeenCalled();
  });

  it('a mark on any other reason is ignored by the timeline: only «رجع للطابور فوراً» has a second word', async () => {
    claims.push({ id: 'x', userId: 'u1', action: 'RELEASED', reason: DATE_RETURNED_REASON, metadata: withPlanRuleMark(automaticReleaseMetadata('u1')), createdAt: T0 });
    const plain = { id: 'y', userId: 'u1', action: 'RELEASED', reason: DATE_RETURNED_REASON, metadata: automaticReleaseMetadata('u1'), createdAt: new Date(T0.getTime() + 1) };
    claims.push(plain);
    const [marked, unmarked] = (await timelineOf()).filter((e) => e.kind === 'OWNERSHIP');
    expect(marked.detail).toBe(unmarked.detail);
  });
});

describe('every reader of the metadata column is unmoved by the extra key', () => {
  const marked = withPlanRuleMark(automaticReleaseMetadata('u1'));

  it('isAutomaticRelease still reads «the system’s» (by `automatic`, and by the reason), marked or not', () => {
    expect(isAutomaticRelease({ action: 'RELEASED', reason: NO_ANSWER_RETURNED_REASON, metadata: marked })).toBe(true);
    expect(isAutomaticRelease({ action: 'RELEASED', reason: 'something typed', metadata: marked })).toBe(true);
    expect(isAutomaticRelease({ action: 'RELEASED', reason: 'something typed', metadata: JSON.stringify({ rule: 'plan' }) })).toBe(false);
  });

  it('managerReturnedBy finds nothing in it — it answers exactly what it answers for the unmarked line (the timeline’s own readers of the column, `onTheLinePeople` among them, are driven by the history test above)', () => {
    const row = (metadata: string) => ({ action: 'RELEASED', reason: NO_ANSWER_RETURNED_REASON, metadata });
    expect(managerReturnedBy(row(marked))).toBe(managerReturnedBy(row(automaticReleaseMetadata('u1'))));
  });
});
