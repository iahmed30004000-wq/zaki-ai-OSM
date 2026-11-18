import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE THREE WAYS OUT OF HER HAND READ IN ARABIC ON THE ORDER’S TIMELINE (the owner, 9/11: «الطلب يرجع للطابور فوراً»)
 *
 * The press that sends an order back (her «لا يرد», her date) and the idle release each write a `RELEASED` line in HER name — the
 * column cannot be empty — saying in the metadata that nobody pressed «release». The timeline must not read as though she let her
 * own order go (`auto-release.ts`), and must not show an English code: the actor is «النظام» and the reason is said in words.
 *
 * THE WORD OF `NO_ANSWER_RETURNED` IS THE WORD OF THE RULE THAT WROTE THE LINE (the planner 15/11, answer 15; ruling 28 of 15/11 22:30 moved it from the switch at read time to the line).
 * The stored reason is one string for two rules, so the plan's door stamps `{ "rule": "plan" }` in the line's metadata when it writes. A line WITH the mark reads the number-free
 * «بيجهز لما يحين موعد محاولته الجاية»; a line WITHOUT it — everything the older doors wrote, with any metadata or none — reads the older «بيجهز بعد 3 ساعات دوام», byte for byte as before
 * the plan. `orderTimeline` takes no switch and no option: the word is decided per row from the row alone. The other two lines are the same marked or not.
 *
 * What must work: the two words by the mark; every shape of an absent/unreadable/other mark reads the older word; the mark changes only that one reason's line; the actor and title are the
 * system's either way. Blockers: the wrong word for a mark; an English code reaching the page.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db } = vi.hoisted(() => ({
  db: {
    orderClaimHistory: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
    callLog: { findMany: vi.fn() },
    callHelperReading: { findMany: vi.fn() },
    deliveryAttempt: { findMany: vi.fn() },
    orderNote: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderIssue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { orderTimeline } from './order-timeline';
import { DATE_RETURNED_REASON, IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON, withPlanRuleMark } from './no-answer-returns';
import { automaticReleaseMetadata } from './auto-release';

const at = new Date('2026-11-02T10:00:00Z');
const line = (reason: string, metadata: string | null = automaticReleaseMetadata('sara')) => ({
  id: `h-${reason}`, createdAt: at, action: 'RELEASED', userId: 'sara', reason, metadata,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of [db.orderStatusLog, db.orderClaimHistory, db.orderContactAttempt, db.deliveryAttempt, db.orderNote, db.orderActivity, db.orderChangeRequest, db.orderIssue, db.callLog, db.callHelperReading]) {
    table.findMany.mockResolvedValue([]);
  }
  db.user.findMany.mockResolvedValue([{ id: 'sara', name: 'سارة' }]);
});

describe('on the timeline', () => {
  const said = async (reason: string, metadata?: string | null) => {
    db.orderClaimHistory.findMany.mockResolvedValue([metadata === undefined ? line(reason) : line(reason, metadata)]);
    return (await orderTimeline(db as never, 'o1'))[0];
  };
  /** What the plan's door writes: the system's release metadata with the rule's mark merged in (`withPlanRuleMark`). */
  const PLAN_MARKED = withPlanRuleMark(automaticReleaseMetadata('sara'));

  const OLD_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز بعد 3 ساعات دوام';
  const PLAN_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز لما يحين موعد محاولته الجاية';

  it('her «لا يرد» that sent the order back, NO mark on the line (the older doors’ line): the system is the actor, and the older mode’s word says when it is ready — as before the plan', async () => {
    const event = await said(NO_ANSWER_RETURNED_REASON);
    expect(event).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام', actorId: null });
    expect(event.detail).toBe(OLD_WORD);
  });

  it('anything that is not plainly the plan’s mark is the same older word — no metadata, not JSON, not an object, another rule, another type, another key', async () => {
    for (const metadata of [null, '', 'not json', '[]', 'null', '"plan"', JSON.stringify({ rule: 'three-hours' }), JSON.stringify({ rule: true }), JSON.stringify({ rules: 'plan' }), JSON.stringify({ automatic: true, holder: 'sara' })]) {
      expect((await said(NO_ANSWER_RETURNED_REASON, metadata)).detail, String(metadata)).toBe(OLD_WORD);
    }
  });

  /**
   * NO NUMBER ON A PLAN LINE (the planner's ruling 6, RV1413; answer 15 gives it to the plan only). The same reason is written by the three-hour mode AND by
   * «جدول المحاولات»; a «3 ساعات دوام» on a row whose next attempt is thirty minutes or two hours away would be a rule that was not its own.
   */
  it('a line the PLAN wrote (marked): the number-free word — no hours, no count — and the system is still the actor', async () => {
    const event = await said(NO_ANSWER_RETURNED_REASON, PLAN_MARKED);
    expect(event).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام', actorId: null });
    expect(event.detail).toBe(PLAN_WORD);
    expect(event.detail).not.toMatch(/ساعات|ثلاث|خمس|\d/);
  });

  it('the mark carries other keys without losing them, and only the mark decides: an unmarked line with a stranger’s keys reads the older word', async () => {
    expect((await said(NO_ANSWER_RETURNED_REASON, JSON.stringify({ rule: 'plan', automatic: true, holder: 'sara', extra: 1 }))).detail).toBe(PLAN_WORD);
    expect((await said(NO_ANSWER_RETURNED_REASON, JSON.stringify({ extra: 1, automatic: true, holder: 'sara' }))).detail).toBe(OLD_WORD);
  });

  it('the mark changes ONLY that one line: the date’s return and the idle release read the same marked or not', async () => {
    for (const reason of [DATE_RETURNED_REASON, IDLE_RETURNED_REASON]) {
      expect((await said(reason, PLAN_MARKED)).detail, reason).toBe((await said(reason)).detail);
    }
  });

  it('two lines in one history are read each by its own mark — the older word and the plan’s word side by side', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      { ...line(NO_ANSWER_RETURNED_REASON), id: 'old', createdAt: new Date(at.getTime() - 3_600_000) },
      { ...line(NO_ANSWER_RETURNED_REASON, PLAN_MARKED), id: 'new' },
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => l.detail)).toEqual([OLD_WORD, PLAN_WORD]);
  });

  it('a supervisor’s return of her pile is read as the supervisor’s whatever else the metadata says (the mark is for the «NO_ANSWER_RETURNED» line only)', async () => {
    const event = await said('MANAGER_RETURNED', JSON.stringify({ pulledBack: true, from: 'sara', by: { id: 'sara', name: 'سارة' }, rule: 'plan' }));
    expect(event.detail).toBe('أرجعها سارة للطابور — ما حدا وصل لزبونها');
  });

  it('her date that sent the order back', async () => {
    const event = await said(DATE_RETURNED_REASON);
    expect(event).toMatchObject({ actorName: 'النظام', actorId: null });
    expect(event.detail).toBe('رجع للطابور بعد ما انحدد موعد — بيجهز بالموعد');
  });

  it('the idle release: the same “automatic” words as the other releases, and NO figure — the limit is 30 or 20 and the line does not say which the release used (18/11, finding #9)', async () => {
    const event = await said(IDLE_RETURNED_REASON);
    expect(event).toMatchObject({ actorName: 'النظام', actorId: null });
    // 18/11 (C1): was «تحرير تلقائي — مرّت 30 دقيقة عمل وما انسجّلت عليه أي محاولة، ورجع للطابور». The 30 was typed, and the release uses 20 with «أولوية الطابور» on — a line written then would read 30 forever.
    // The line carries no figure now (as the rounds' release already did, RV1413); the notice she got said the real one (`idleWhy`).
    expect(event.detail).toBe('تحرير تلقائي — مرّت مهلة الخمول وما انسجّلت عليه أي محاولة، ورجع للطابور');
    expect(event.detail).not.toMatch(/\d/);
  });

  it.each([[undefined], [PLAN_MARKED]])('no English code ever reaches the page, and the three are told apart (metadata %o)', async (metadata) => {
    const seen = new Set<string>();
    for (const reason of [NO_ANSWER_RETURNED_REASON, DATE_RETURNED_REASON, IDLE_RETURNED_REASON]) {
      const { detail } = await said(reason, metadata);
      expect(detail, reason).not.toMatch(/[A-Z_]{6,}/);
      seen.add(String(detail));
    }
    expect(seen.size).toBe(3);
  });

  it('the idle release is the system’s even for a row with no metadata (its reason starts with AUTO_RELEASE)', async () => {
    const event = await said(IDLE_RETURNED_REASON, null);
    expect(event.actorName).toBe('النظام');
  });

  it('a person’s own release is still hers: only the lines that say nobody pressed are the system’s', async () => {
    const event = await said('some reason a person typed', JSON.stringify({ previousOwner: 'sara' }));
    expect(event.actorName).toBe('سارة');
  });
});
