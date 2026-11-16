import { describe, expect, it } from 'vitest';
import {
  PICKABLE_REJECTION_REASONS,
  REJECTION_REASONS,
  REJECTION_REASON_AR,
  SYSTEM_ONLY_REJECTION_REASONS,
} from './confirmation-workflow';
import { dashboardFiles, repoFile, stripComments } from './guard-source';

/**
 * WHY AN ORDER WAS LOST — RECORDED, NOT INVENTED.
 *
 * The confirmation screen already refused to reject an order without a
 * structured reason, and demanded a sentence for «other». Three other doors
 * wrote one anyway:
 *
 *   `/call-logs` wrote `OTHER` for EVERY rejection logged from a call — the
 *   one value that says nothing, in the field the analysis of lost orders
 *   will read.
 *
 *   Voiding an entry issue wrote `FAKE_ORDER`. An entry issue is OUR mistake,
 *   and every report counting fake orders was counting our own typing.
 *
 *   And a wrong number was filed as a no-answer, so it burned three calls
 *   nobody could ever have answered and closed as «three attempts, no reply»
 *   — a statistic that says «we cannot reach people» when the truth is «our
 *   numbers are wrong».
 */

describe('the reasons', () => {
  it('has one for our own mistake, distinct from a fake order', () => {
    expect(REJECTION_REASONS).toContain('MODERATOR_DATA_ERROR');
    expect(REJECTION_REASONS).toContain('FAKE_ORDER');
  });

  /** Every stored value reads as a sentence, including the ones nobody picks. */
  it('reads in Arabic, all of them', () => {
    for (const r of REJECTION_REASONS) {
      expect(REJECTION_REASON_AR[r], `${r} بلا ترجمة`).toBeTruthy();
    }
  });

  /**
   * AND THE THREE THE SYSTEM OWNS ARE NOT OFFERED.
   *
   * «Closed after three attempts» (and its five-attempt twin under the plan)
   * is not a choice anybody makes, and putting «our own data error» in the
   * picker invites an agent to use it as the shortest way out of a hard call.
   */
  it('offers a person everything except what the system writes for itself', () => {
    // Named, not counted. A first version looped over
    // `SYSTEM_ONLY_REJECTION_REASONS` and compared lengths — so emptying that
    // list satisfied both, which is exactly the change it exists to stop.
    expect(PICKABLE_REJECTION_REASONS, 'الإغلاق التلقائيّ معروضٌ للاختيار').not.toContain('NO_ANSWER_3_ATTEMPTS');
    expect(PICKABLE_REJECTION_REASONS, 'إغلاق «جدول المحاولات» معروضٌ للاختيار').not.toContain('NO_ANSWER_5_ATTEMPTS');
    expect(PICKABLE_REJECTION_REASONS, '«خطأ إدخال» معروضٌ للاختيار').not.toContain('MODERATOR_DATA_ERROR');
    expect(SYSTEM_ONLY_REJECTION_REASONS).toHaveLength(3);
    expect(PICKABLE_REJECTION_REASONS).toContain('OTHER');
    expect(PICKABLE_REJECTION_REASONS.length).toBe(REJECTION_REASONS.length - 3);
  });

  /** One list. A screen with its own copy is a screen that falls behind it. */
  it('and no screen keeps its own copy of them', () => {
    const offenders: string[] = [];
    for (const { rel, src } of dashboardFiles()) {
      const body = stripComments(src);
      // A local list is one that spells several of the codes out in place.
      const spelled = REJECTION_REASONS.filter((r) => body.includes(`'${r}'`)).length;
      if (spelled >= 3) offenders.push(`${rel}: ${spelled} رموز مكتوبة في المكان`);
    }
    expect(offenders, `نسخةٌ محليّةٌ من قائمة الأسباب:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('a server', () => {
  /**
   * NEVER CHOOSES «OTHER» FOR A PERSON.
   *
   * It means «none of these, and here is a sentence», and the door that takes
   * it demands the sentence. A server writing it fills the record with the
   * one value that answers nothing — and it did, on every rejection logged
   * from a call.
   */
  it('never writes OTHER as a rejection reason', () => {
    const offenders: string[] = [];
    for (const rel of [
      'src/app/api/orders/[id]/call-logs/route.ts',
      'src/app/api/orders/[id]/confirmation/route.ts',
      'src/app/api/orders/[id]/contact-attempts/route.ts',
      'src/app/api/confirmation/issues/[id]/route.ts',
    ]) {
      const src = stripComments(repoFile(rel));
      if (/rejectionReason:\s*'OTHER'/.test(src)) offenders.push(rel);
    }
    expect(offenders, `الخادم يكتب «أخرى» نيابةً عن إنسان:\n${offenders.join('\n')}`).toEqual([]);
  });

  /** And the call door asks for the reason, like the screen beside it. */
  it('and the call log demands a structured reason before it closes an order', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/call-logs/route.ts'));
    // The GUARD, not the mapping: `else if (result === 'REJECTED')` two
    // screens up matched the loose version of this, so disabling the guard
    // left the test passing.
    expect(src, 'الحارس معطَّل أو غائب').toMatch(
      /if \(result === 'REJECTED'\) \{\s*if \(!rejectionReason/
    );
    expect(src).toContain('سبب الإلغاء مطلوب');
    expect(src, '«أخرى» بلا شرح').toContain("rejectionReason === 'OTHER'");
  });

  /**
   * A WRONG NUMBER CLOSES, IT DOES NOT WAIT FOR THREE RINGS.
   */
  it('closes a wrong number under its own reason instead of calling it thrice', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/call-logs/route.ts'));
    expect(src).toMatch(/result === 'WRONG_NUMBER'\) mappedStatus = 'REJECTED'/);
    expect(src, 'الرقم الخاطئ ما زال يُعدّ محاولةً بلا ردّ').not.toMatch(
      /result === 'NO_ANSWER' \|\| result === 'BUSY' \|\| result === 'WRONG_NUMBER'/
    );
  });

  /** Voiding an entry issue is our mistake, and says so. */
  it('and voiding an entry issue records our mistake, not a fake customer', () => {
    const src = stripComments(repoFile('src/app/api/confirmation/issues/[id]/route.ts'));
    expect(src).toContain("rejectionReason: 'MODERATOR_DATA_ERROR'");
    expect(src, 'ما زال يتّهم الزبون').not.toContain("rejectionReason: 'FAKE_ORDER'");
  });
});
