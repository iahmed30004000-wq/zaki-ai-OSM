import { describe, expect, it } from 'vitest';
import {
  NO_ANSWER_CLOSE,
  NO_ANSWER_CLOSE_NOTES,
  NO_ANSWER_CLOSE_REASONS,
  NO_ANSWER_LIMIT,
  PICKABLE_REJECTION_REASONS,
  REJECTION_REASONS,
  REJECTION_REASON_AR,
  SYSTEM_ONLY_REJECTION_REASONS,
} from './confirmation-workflow';
import { faultOf } from './loss-analysis';
import { CADENCE_LIMIT } from './no-answer-cadence';
import { DEFAULT_WINBACK_RULE, winbackCodes, winbackLabel } from './winback';

/**
 * THE PLAN'S CLOSE HAS ITS OWN NAME («جدول المحاولات», step B, ruling 6).
 *
 * The fifth COUNTED «لا يرد» closes an order under the plan, and it used to be
 * filed as `NO_ANSWER_3_ATTEMPTS` — «closed after three attempts» printed on a
 * five-attempt close. The code is now `NO_ANSWER_5_ATTEMPTS`, welded to the
 * limit by this file: change `CADENCE_LIMIT` and the name stops matching.
 *
 * The old code stays exactly as it was — the switch-off rule and the rounds
 * still close at three, and every stored row carrying it still says «ثلاث».
 */
describe('the five-attempt close code', () => {
  const FIVE = 'NO_ANSWER_5_ATTEMPTS';
  const THREE = 'NO_ANSWER_3_ATTEMPTS';

  it('is a stored reason the system alone writes — never in a picker', () => {
    expect(REJECTION_REASONS).toContain(FIVE);
    expect(SYSTEM_ONLY_REJECTION_REASONS).toContain(FIVE);
    expect(PICKABLE_REJECTION_REASONS).not.toContain(FIVE);
    // the old code is untouched, in all three places
    expect(REJECTION_REASONS).toContain(THREE);
    expect(SYSTEM_ONLY_REJECTION_REASONS).toContain(THREE);
    expect(PICKABLE_REJECTION_REASONS).not.toContain(THREE);
  });

  it('carries the limit in its name: change the limit and this fails', () => {
    expect(NO_ANSWER_CLOSE.five.reason).toBe(`NO_ANSWER_${CADENCE_LIMIT}_ATTEMPTS`);
    expect(NO_ANSWER_CLOSE.three.reason).toBe(`NO_ANSWER_${NO_ANSWER_LIMIT}_ATTEMPTS`);
    expect(NO_ANSWER_CLOSE.five.reason).toBe(FIVE);
    expect(NO_ANSWER_CLOSE.three.reason).toBe(THREE);
  });

  it('writes a status-log note that is AUTO_CLOSE_ + its own reason — the desk card reads both', () => {
    expect(NO_ANSWER_CLOSE.three.note).toBe(`AUTO_CLOSE_${THREE}`);
    expect(NO_ANSWER_CLOSE.five.note).toBe(`AUTO_CLOSE_${FIVE}`);
  });

  it('is listed beside the old one, for every reader of «closed because nobody answered»', () => {
    expect([...NO_ANSWER_CLOSE_REASONS]).toEqual([THREE, FIVE]);
    expect([...NO_ANSWER_CLOSE_NOTES]).toEqual([NO_ANSWER_CLOSE.three.note, NO_ANSWER_CLOSE.five.note]);
    for (const r of NO_ANSWER_CLOSE_REASONS) expect(SYSTEM_ONLY_REJECTION_REASONS, r).toContain(r);
  });

  it('says «خمس» and never «ثلاث» — and the old one the reverse', () => {
    expect(REJECTION_REASON_AR[FIVE]).toContain('خمس');
    expect(REJECTION_REASON_AR[FIVE]).not.toContain('ثلاث');
    expect(REJECTION_REASON_AR[THREE]).toContain('ثلاث');
    expect(REJECTION_REASON_AR[THREE]).not.toContain('خمس');
  });

  it('is our reach on the loss report, like the code it follows — or it leaves the «كان يمكن تفاديه» sum', () => {
    expect(faultOf('rejectionReason', FIVE)).toBe('OUR_REACH');
    expect(faultOf('rejectionReason', THREE)).toBe('OUR_REACH');
  });

  it('is winback-able through its host: the default rule reads both codes', () => {
    expect(winbackCodes(DEFAULT_WINBACK_RULE.reasons)).toEqual(expect.arrayContaining([THREE, FIVE]));
  });

  /**
   * With the plan ON the rule's tick stands for BOTH codes, so its word carries no number (ruling 6, decision Q2; the planner 15/11, answer 6: only with the switch on —
   * OFF the tick says the older «ثلاث» exactly, pinned in winback-rule.test.ts). A row still says its own code's words — each stored code is told apart wherever one row is read.
   */
  it('and, with the plan on, the rule\'s tick has no number in it, while a row keeps its own code\'s words', () => {
    const on = { planOn: true };
    expect(winbackLabel(THREE, on)).toBe('أُغلق تلقائياً بعد محاولات بلا ردّ');
    expect(winbackLabel(THREE, on)).not.toMatch(/ثلاث|خمس|3|5/);
    expect(winbackLabel(FIVE, on)).toBe(REJECTION_REASON_AR[FIVE]);
    expect(winbackLabel('PRICE_TOO_HIGH', on)).toBe(REJECTION_REASON_AR.PRICE_TOO_HIGH);
    expect(winbackLabel('NOT_A_CODE', on)).toBe('NOT_A_CODE');
  });

  it('and with it OFF (nothing handed) every code says its own words — the tick of the old rule is the old words', () => {
    expect(winbackLabel(THREE)).toBe(REJECTION_REASON_AR[THREE]);
    expect(winbackLabel(FIVE)).toBe(REJECTION_REASON_AR[FIVE]);
    expect(winbackLabel('NOT_A_CODE')).toBe('NOT_A_CODE');
  });
});
