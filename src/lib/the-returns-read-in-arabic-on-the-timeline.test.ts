import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE THREE WAYS OUT OF HER HAND READ IN ARABIC ON THE ORDER’S TIMELINE (the owner, 9/11: «الطلب يرجع للطابور فوراً»)
 *
 * The press that sends an order back (her «لا يرد», her date) and the idle release each write a `RELEASED` line in HER name — the
 * column cannot be empty — saying in the metadata that nobody pressed «release». The timeline must not read as though she let her
 * own order go (`auto-release.ts`), and must not show an English code: the actor is «النظام» and the reason is said in words.
 *
 * THE WORD OF `NO_ANSWER_RETURNED` IS THE RULE'S (the planner 15/11, answer 15). The stored reason is one string for two rules, so the timeline is HANDED which one is
 * on (`opts.planOn`): left out (the switch OFF, or a caller that cannot cheaply know it) it is the older mode's «بيجهز بعد 3 ساعات دوام», byte for byte as before the plan;
 * `planOn: true` is the number-free «بيجهز لما يحين موعد محاولته الجاية». The other two lines are the same in both worlds. Blocker: the wrong word for the flag.
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
import { DATE_RETURNED_REASON, IDLE_RETURNED_REASON, NO_ANSWER_RETURNED_REASON } from './no-answer-returns';
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
  const said = async (reason: string, metadata?: string | null, opts?: { planOn?: boolean }) => {
    db.orderClaimHistory.findMany.mockResolvedValue([metadata === undefined ? line(reason) : line(reason, metadata)]);
    return (await (opts ? orderTimeline(db as never, 'o1', opts) : orderTimeline(db as never, 'o1')))[0];
  };

  const OLD_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز بعد 3 ساعات دوام';
  const PLAN_WORD = 'رجع للطابور فوراً بعد «لا يرد» — بيجهز لما يحين موعد محاولته الجاية';

  it('her «لا يرد» that sent the order back, the switch OFF (nothing handed): the system is the actor, and the older mode’s word says when it is ready — as before the plan', async () => {
    const event = await said(NO_ANSWER_RETURNED_REASON);
    expect(event).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام', actorId: null });
    expect(event.detail).toBe(OLD_WORD);
  });

  it('the flag spelled OFF — or anything but a plain true — is the same older word', async () => {
    expect((await said(NO_ANSWER_RETURNED_REASON, undefined, { planOn: false })).detail).toBe(OLD_WORD);
    expect((await said(NO_ANSWER_RETURNED_REASON, undefined, {})).detail).toBe(OLD_WORD);
    expect((await said(NO_ANSWER_RETURNED_REASON, undefined, { planOn: 'yes' as never })).detail).toBe(OLD_WORD);
  });

  /**
   * NO NUMBER UNDER THE PLAN (the planner's ruling 6, RV1413; answer 15 gives it to the plan only). The same reason is written by the three-hour mode AND by
   * «جدول المحاولات»; with the plan on, a «3 ساعات دوام» on a row whose next attempt is thirty minutes or two hours away would be a rule that was not its own.
   */
  it('the plan ON: the number-free word — no hours, no count', async () => {
    const event = await said(NO_ANSWER_RETURNED_REASON, undefined, { planOn: true });
    expect(event).toMatchObject({ title: 'تحرير الطلب', actorName: 'النظام', actorId: null });
    expect(event.detail).toBe(PLAN_WORD);
    expect(event.detail).not.toMatch(/ساعات|ثلاث|خمس|\d/);
  });

  it('the flag changes ONLY that one line: the date’s return and the idle release read the same either way', async () => {
    for (const reason of [DATE_RETURNED_REASON, IDLE_RETURNED_REASON]) {
      expect((await said(reason, undefined, { planOn: true })).detail, reason).toBe((await said(reason)).detail);
    }
  });

  it('her date that sent the order back', async () => {
    const event = await said(DATE_RETURNED_REASON);
    expect(event).toMatchObject({ actorName: 'النظام', actorId: null });
    expect(event.detail).toBe('رجع للطابور بعد ما انحدد موعد — بيجهز بالموعد');
  });

  it('the idle release: the same “automatic” words as the other releases, with its thirty working minutes', async () => {
    const event = await said(IDLE_RETURNED_REASON);
    expect(event).toMatchObject({ actorName: 'النظام', actorId: null });
    expect(event.detail).toBe('تحرير تلقائي — مرّت 30 دقيقة عمل وما انسجّلت عليه أي محاولة، ورجع للطابور');
  });

  it.each([[undefined], [{ planOn: true }]])('no English code ever reaches the page, and the three are told apart (%o)', async (opts) => {
    const seen = new Set<string>();
    for (const reason of [NO_ANSWER_RETURNED_REASON, DATE_RETURNED_REASON, IDLE_RETURNED_REASON]) {
      const { detail } = await said(reason, undefined, opts);
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
