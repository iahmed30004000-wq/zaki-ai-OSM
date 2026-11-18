import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));

import { readRuleFacts, ruleSummaryLines, type RuleFacts } from './confirmation-rule-summary';
import { AUTO_RELEASE_BUSINESS_MINUTES, RETURNS_MODE } from './confirmation-queue';
import { NO_ANSWER_LIMIT } from './confirmation-workflow';
import { CADENCE_FLOORS_MS, CADENCE_GAPS_MS, CADENCE_LIMIT, CADENCE_MIN_DAYS } from './no-answer-cadence';
import { MIN_CALL_MS } from './call-proof-words';
import { POSTPONE_MAX_TIMES, QUEUE_PRIORITY, QUEUE_PRIORITY_LIMITS } from './queue-priority';
import { QUEUE_MODES_DEFAULTS } from './queue-modes-settings';
import { forgetQueuePrioritySwitch } from './queue-priority-switch';
import { forgetCallProofSwitch } from './call-proof-switch';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القاعدة بالمختصر» — THE BOX AT THE TOP OF «قواعد مركز التأكيد» (C1, 18/11)
 *
 * DEFINITION OF DONE it pins:
 *  · six or seven short lines when the plan is on; every number in them IS a constant the engine uses (it is read here from the same constants, so a number typed a second time
 *    in the sentence goes red the day the constant moves);
 *  · the numbers that depend on a switch tell the truth of the switch's state: «أولوية الطابور» off → hand 5 and idle 30, never 3 and 20;
 *  · the plan off → the box says so and says the OLD rule's numbers (3 and 90), and does not describe the five attempts;
 *  · `readRuleFacts` reads the two switches, the limits the release uses (`returnsLimits`) and the windows — a failed read is «off».
 * ═══════════════════════════════════════════════════════════════════════
 */
/*
 * UPDATED 2026-11-18 (request C2): under the plan the hand and the idle release are the one rule set's 3 and 20 WHATEVER «أولوية الطابور» says (`returnsLimits` — what
 * `readRuleFacts` hands in), the postponement cap and «لا يرد is not a postponement» hold under the plan too (one more line), #4 is the morning anchor (11:00, it was «ببداية
 * الدوام»), #5's cap is 19:30 (it was 18:00), and «نظام الجولات» stored on beside the plan is not mentioned (its releases stopped). The old pins said «six lines», «5 and 30 with
 * the priority off», «ببداية الدوام (10:00)», «المسا (18:00)» and ««نظام الجولات» شغّال كمان … 12 ساعة عمل».
 */
const FACTS: RuleFacts = {
  proofOn: true,
  priorityOn: false,
  roundsOn: false,
  returnsOn: false,
  hand: QUEUE_PRIORITY_LIMITS.handLimit,
  idleMinutes: QUEUE_PRIORITY_LIMITS.idleBusinessMinutes,
  workStart: '10:00',
  workEnd: '22:00',
  modes: QUEUE_MODES_DEFAULTS,
};
const text = (f: Partial<RuleFacts> = {}) => ruleSummaryLines({ ...FACTS, ...f }).join('\n');

describe('the plan on, priority off — the numbers are the engine\'s', () => {
  const lines = ruleSummaryLines(FACTS);

  it('is seven lines, each one sentence', () => {
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line.length).toBeGreaterThan(20);
  });

  it('says the plan\'s hand and idle limit — 3 and 20 — and names no switch for them (they hold whatever «أولوية الطابور» says)', () => {
    expect(lines[0]).toContain(`${QUEUE_PRIORITY_LIMITS.handLimit} طلبات`);
    expect(lines[0]).toContain(`${QUEUE_PRIORITY_LIMITS.idleBusinessMinutes} دقيقة دوام`);
    expect(lines[0]).not.toContain('أولوية الطابور');
    expect(lines[0]).not.toContain(`${RETURNS_MODE.handLimit} طلبات`);
  });

  it('says the proof seconds, the gaps, the floors, the attempts, the days and the two anchors — all from the constants', () => {
    expect(lines[1]).toContain(`${MIN_CALL_MS.NO_ANSWER / 1000} ثانية`);
    expect(lines[2]).toContain(`${CADENCE_GAPS_MS.afterFirst / 60_000} دقيقة`);
    expect(CADENCE_GAPS_MS.afterSecond / 3_600_000).toBe(2);
    expect(lines[2]).toContain('ساعتين');
    expect(lines[2]).toContain(`${CADENCE_FLOORS_MS.beforeFourth / 3_600_000} ساعات`);
    expect(lines[2]).toContain('تاني يوم الصبح (11:00)');
    expect(lines[2]).toContain('المسا (19:30)');
    expect(lines[2]).not.toContain('ببداية الدوام');
    expect(lines[3]).toContain(`المحاولة ${CADENCE_LIMIT} على ${CADENCE_MIN_DAYS} أيام`);
    expect(lines[6]).toContain(`محاولة 2 من ${CADENCE_LIMIT}`);
  });

  it('the anchors are the country\'s own: a 09:00-17:00 window gives 11:00 and 16:00; a start after 11:00 gives the start', () => {
    expect(text({ workStart: '09:00', workEnd: '17:00' })).toContain('المسا (16:00)');
    expect(text({ workStart: '09:00', workEnd: '17:00' })).toContain('الصبح (11:00)');
    expect(text({ workStart: '12:00', workEnd: '22:00' })).toContain('الصبح (12:00)');
  });

  it('a country with no readable hours gets the plan\'s fallbacks (11:00 and 19:30)', () => {
    const t = text({ workStart: null, workEnd: undefined });
    expect(t).toContain('الصبح (11:00)');
    expect(t).toContain('المسا (19:30)');
  });

  it('the postponement cap and «لا يرد is not a postponement» are said with the priority off too; the pull order is the plain one', () => {
    expect(lines[4]).toContain(`موعد من الزبون: ${POSTPONE_MAX_TIMES} مرات بالأكثر`);
    expect(lines[4]).toContain('التأجيل بسبب «لا يرد» ممنوع');
    expect(lines[5]).toContain('أولوية الطابور مطفية');
    expect(lines[5]).not.toContain('حد لتأجيل');
  });
});

describe('the plan on, priority on', () => {
  const on = { priorityOn: true, hand: QUEUE_PRIORITY_LIMITS.handLimit, idleMinutes: QUEUE_PRIORITY_LIMITS.idleBusinessMinutes };
  const lines = ruleSummaryLines({ ...FACTS, ...on });

  it('is eight lines; the hand is 3 and the idle 20, as the release uses them', () => {
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain('3 طلبات');
    expect(lines[0]).toContain('20 دقيقة دوام');
  });

  it('says the priority numbers from their constants, and the two windows from the owner\'s settings', () => {
    expect(lines[5]).toContain(`أقل من ${QUEUE_PRIORITY.freshMinutes} دقيقة`);
    expect(QUEUE_PRIORITY.agingHours).toBe(2);
    expect(lines[5]).toContain('أكتر من ساعتين');
    expect(lines[4]).toContain(`${POSTPONE_MAX_TIMES} مرات بالأكثر`);
    expect(lines[6]).toBe('من 09:00 لـ11:00 ومن 21:00 لـ00:00: الجديد أول والأقدم أول، بلا حصة.');
    const moved = ruleSummaryLines({ ...FACTS, ...on, modes: { nightFrom: 8, nightTo: 10, peakFrom: 20, peakTo: 23 } })[6];
    expect(moved).toContain('من 08:00 لـ10:00 ومن 20:00 لـ23:00');
  });
});

describe('the plan off — the box says so, with the old rule\'s numbers', () => {
  it('names the 3 closings and the 90 minutes, and does not describe five attempts', () => {
    const t = text({ proofOn: false });
    expect(t).toContain('«إثبات المكالمات وجدول المحاولات» مطفي');
    expect(t).toContain(`بعد ${NO_ANSWER_LIMIT} مرات «لا يرد»`);
    expect(t).toContain(`${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل`);
    expect(t).not.toContain('ثانية');
    expect(t).not.toContain(`المحاولة ${CADENCE_LIMIT} على`);
  });

  it('priority on while the plan is off: it says the hand and idle are inert without the plan', () => {
    const t = text({ proofOn: false, priorityOn: true, hand: 3, idleMinutes: 20 });
    expect(t).toContain('ما بيشتغلوا إلا مع «إثبات المكالمات»');
  });
});

describe('Western digits and Arabic words only', () => {
  it.each([[{}], [{ proofOn: false }], [{ priorityOn: true }]])('%o', (over) => {
    const t = text(over);
    expect(t).not.toMatch(/[٠-٩]/);
    expect(t).not.toMatch(/[A-Za-z]/);
  });
});

describe('readRuleFacts reads what the engine reads', () => {
  let n = 0;
  // The queue-modes reader caches half a minute per company: every case gets its own company.
  let CO = '';
  const client = (settings: object) => ({ company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(settings) })) } });
  beforeEach(() => {
    CO = `co-rules-summary-${++n}`;
    forgetQueuePrioritySwitch();
    forgetCallProofSwitch();
  });
  const ON = { enabled: true, enabledAt: '2026-11-17T00:00:00.000Z' };

  it('both switches on: proof on, priority on, 3 and 20', async () => {
    const f = await readRuleFacts(client({ callProofAndCadence: ON, queuePriority: ON, queueModes: { nightFrom: 8, nightTo: 10, peakFrom: 20, peakTo: 23 } }) as never, CO, { workHoursStart: '09:00', workHoursEnd: '17:00' });
    expect(f).toMatchObject({ proofOn: true, priorityOn: true, hand: 3, idleMinutes: 20, workStart: '09:00', workEnd: '17:00', modes: { nightFrom: 8, peakTo: 23 } });
  });

  it('the plan on, priority off (C2): 3 and 20 — the plan\'s, whatever the priority key says', async () => {
    const f = await readRuleFacts(client({ callProofAndCadence: ON }) as never, CO, {});
    expect(f).toMatchObject({ proofOn: true, priorityOn: false, hand: 3, idleMinutes: 20 });
  });

  it('nothing set: both off, the mode\'s own 5 and 30, the default windows', async () => {
    const f = await readRuleFacts(client({}) as never, CO, {});
    expect(f).toMatchObject({ proofOn: false, priorityOn: false, hand: 5, idleMinutes: 30, modes: QUEUE_MODES_DEFAULTS });
  });

  it('a read that fails is «off», never «on»', async () => {
    const broken = { company: { findUnique: vi.fn(async () => { throw new Error('db down'); }) } };
    const f = await readRuleFacts(broken as never, CO, {});
    expect(f.proofOn).toBe(false);
    expect(f.priorityOn).toBe(false);
    expect(f.hand).toBe(RETURNS_MODE.handLimit);
  });
});

// ───────────────────────── every state of the five switches (review of C1, 18/11) ─────────────────────────
/**
 * The box was false in the legacy state: with the plan OFF, «نظام الجولات» ON and «الطلب يرجع للطابور فوراً» ON it said «بعد 90 دقيقة عمل» and «بعد 3 مرات»,
 * while the release uses the mode's idle limit (30, or 20 with the priority on) and the close counts ROUNDS. Each row below is one state, and what it must and must not say.
 */
describe('the box tells the truth of every state', () => {
  const PRI = { hand: QUEUE_PRIORITY_LIMITS.handLimit, idleMinutes: QUEUE_PRIORITY_LIMITS.idleBusinessMinutes };
  const OFF = { hand: RETURNS_MODE.handLimit, idleMinutes: RETURNS_MODE.idleBusinessMinutes };
  type Row = [string, Partial<RuleFacts>, string[], string[]];
  const rows: Row[] = [
    ['plan off · rounds off · returns off', { proofOn: false, ...OFF }, [`بعد ${NO_ANSWER_LIMIT} مرات «لا يرد»`, `${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل`, 'أولوية الطابور مطفية'], ['جولات', 'فوراً» شغّال']],
    ['plan off · rounds off · returns stored on (inert)', { proofOn: false, returnsOn: true, ...OFF }, [`بعد ${NO_ANSWER_LIMIT} مرات «لا يرد»`, `${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل`, 'ما بيشتغل: بدّو «نظام الجولات»'], ['بيجهز بعد']],
    ['plan off · rounds on · returns off', { proofOn: false, roundsOn: true, ...OFF }, [`بعد ${NO_ANSWER_LIMIT} جولات على 2 أيام`, '3 ساعات عمل = جولة وحدة', `${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل`, '12 ساعة عمل'], [`${NO_ANSWER_LIMIT} مرات «لا يرد»`, 'بيجهز بعد']],
    ['plan off · rounds on · returns on · priority off', { proofOn: false, roundsOn: true, returnsOn: true, ...OFF }, [`بعد ${NO_ANSWER_LIMIT} جولات`, 'بيجهز بعد 3 ساعات عمل', `بإيدها ${RETURNS_MODE.handLimit} طلبات`, `${RETURNS_MODE.idleBusinessMinutes} دقيقة عمل`], [`${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة`, `${NO_ANSWER_LIMIT} مرات «لا يرد»`]],
    ['plan off · rounds on · returns on · priority on', { proofOn: false, roundsOn: true, returnsOn: true, priorityOn: true, ...PRI }, [`بإيدها ${QUEUE_PRIORITY_LIMITS.handLimit} طلبات`, `${QUEUE_PRIORITY_LIMITS.idleBusinessMinutes} دقيقة عمل`, 'أولوية الطابور شغّالة'], [`${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة`, 'ما بيشتغلوا إلا']],
    ['plan off · rounds off · priority on (inert)', { proofOn: false, priorityOn: true, ...PRI }, ['ما بيشتغلوا إلا مع «إثبات المكالمات»', `${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة عمل`], ['بإيدها']],
    // UPDATED 2026-11-18 (C2): under the plan the hand and idle are always the plan's (PRI), and «نظام الجولات» stored on is not said — its releases stopped (was «شغّال كمان … 12 ساعة عمل»).
    ['plan on · rounds off', { proofOn: true, ...PRI }, [`المحاولة ${CADENCE_LIMIT} على`, `${QUEUE_PRIORITY_LIMITS.idleBusinessMinutes} دقيقة دوام`], ['جولات', 'جولة', 'نظام الجولات']],
    ['plan on · rounds on (its releases stop — C2)', { proofOn: true, roundsOn: true, ...PRI }, [`المحاولة ${CADENCE_LIMIT} على`], ['جولة', 'جولات', '12 ساعة عمل', 'شغّال كمان']],
    ['plan on · rounds on · returns on · priority on', { proofOn: true, roundsOn: true, returnsOn: true, priorityOn: true, ...PRI }, ['3 طلبات', '20 دقيقة دوام', 'أكتر من ساعتين بتتقدّم'], [`${AUTO_RELEASE_BUSINESS_MINUTES} دقيقة`, 'جولة', 'جولات']],
  ];
  it.each(rows)('%s', (_name, over, says, never) => {
    const t = text(over);
    for (const s of says) expect(t, s).toContain(s);
    for (const n of never) expect(t, n).not.toContain(n);
    expect(t).not.toMatch(/[A-Za-z]/);
  });
});

describe('readRuleFacts reads the two legacy switches too', () => {
  let n = 0;
  let CO = '';
  const client = (settings: object) => ({ company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(settings) })) } });
  const ON = { enabled: true, enabledAt: '2026-11-17T00:00:00.000Z' };
  beforeEach(() => {
    CO = `co-rules-legacy-${++n}`;
  });

  it('rounds on and returns on: both read, and the limits are the mode’s', async () => {
    const f = await readRuleFacts(client({ noAnswerRounds: ON, noAnswerReturns: ON }) as never, CO, {});
    expect(f).toMatchObject({ proofOn: false, roundsOn: true, returnsOn: true, hand: RETURNS_MODE.handLimit, idleMinutes: RETURNS_MODE.idleBusinessMinutes });
  });

  it('nothing stored: both off', async () => {
    const f = await readRuleFacts(client({}) as never, CO, {});
    expect(f).toMatchObject({ roundsOn: false, returnsOn: false });
  });
});
