/**
 * The SCENARIO of the verification kit — what the confirmation desk looks like in the scratch database, written ONCE and read by
 * `seed.mjs` (which writes it), `pull-order.mjs` (which asks the real pull code what it hands out) and `screenshots.mjs`.
 *
 * DEFINITION OF DONE: every state the planner's answers talk about exists as a named order — NEW orders, retries that are READY
 * (including a TIE on the due), a retry that is NOT YET due, a customer promise whose date has ARRIVED, a postponed order whose
 * date has not, a legacy «لا يرد» line from before the switch, an order closed today, and orders held in an agent's hand — for a
 * company with the switch ON and a company with it OFF. All times are RELATIVE to one `now` (the seed's), so a scenario is only
 * true for a while after it is seeded: run `seed.mjs` again right before a check.
 *
 * Nothing here touches a database. Every name and number is invented (the `.test` domain, phones of zeros).
 */

export const COMPANY_ON = 'KIT ON — إثبات المكالمات وجدول المحاولات شغّال';
export const COMPANY_OFF = 'KIT OFF — المفتاح مطفي';

/** email → who. The password is one for the whole run (`KIT_PASSWORD`, or generated and printed once by the seed). */
export const USERS = {
  adminOn: { email: 'admin-on@scratch.test', name: 'مدير KIT ON', role: 'COMPANY_ADMIN', company: 'on', countries: ['SY', 'JO'] },
  agent1On: { email: 'agent1-on@scratch.test', name: 'موظفة التأكيد 1 (سوريا)', role: 'CONFIRMATION_AGENT', company: 'on', countries: ['SY'] },
  agent2On: { email: 'agent2-on@scratch.test', name: 'موظف التأكيد 2 (الأردن)', role: 'CONFIRMATION_AGENT', company: 'on', countries: ['JO'] },
  adminOff: { email: 'admin-off@scratch.test', name: 'مدير KIT OFF', role: 'COMPANY_ADMIN', company: 'off', countries: ['SY'] },
  agentOff: { email: 'agent-off@scratch.test', name: 'موظفة التأكيد (مطفي)', role: 'CONFIRMATION_AGENT', company: 'off', countries: ['SY'] },
};

/** Two countries per the planner's rows (answer 1 and 2): Syria-like works every day 10:00-22:00, Jordan-like rests Friday and Saturday. */
export const COUNTRIES = {
  SY: { code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, timezone: 'Asia/Damascus', weekendDays: [], workHoursStart: '10:00', workHoursEnd: '22:00', orderPrefix: 'SY', regions: ['دمشق', 'حلب', 'حمص'] },
  JO: { code: 'JO', name: 'الأردن', currencyCode: 'JOD', minorUnit: 3, timezone: 'Asia/Amman', weekendDays: [5, 6], workHoursStart: '09:00', workHoursEnd: '17:00', orderPrefix: 'JO', regions: ['عمّان', 'إربد'] },
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The wall-clock offset of a zone at an instant, in ms (local minus UTC). */
function zoneOffsetMs(ms, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock of `timeZone` reads `hhmm` on the local day `dayOffset` days from today's. */
export function localAt(now, timeZone, dayOffset, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
  const wall = Date.UTC(today[0], today[1] - 1, today[2] + dayOffset, h, m);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

/** The moment the switch of the ON company went on (the FLOOR of every count): three days before the seed. */
export function enabledAtOf(now) {
  return new Date(now.getTime() - 3 * DAY);
}

/**
 * The orders. `pool: true` = nobody holds it (the pull's pool); `heldBy` = in that agent's hand. `lines` are the contact attempts, oldest
 * first: `at` = minutes AGO the line was written, `due` = minutes from now its stored due falls (negative = already passed), `null` = no due.
 * `expect` is what the PLANNER's rules say about the order, in a word — printed beside the pull order so a reader can compare.
 * What the pull is ASSERTED to hand out (`pull-order.mjs --assert`, the CI step) is `EXPECTED_HAND_OUT`, at the end of this file.
 */
export function buildScenario(now) {
  const ago = (m) => new Date(now.getTime() - m * MIN);
  const at = (m) => new Date(now.getTime() + m * MIN);
  const tie = at(-90); // ONE instant shared by two retries: the tie on the due

  const line = (n, result, agoMin, due, extra = {}) => ({ n, result, createdAt: ago(agoMin), due: due === null ? null : due, ...extra });

  const on = [
    // ── SY (the ON company's Syria-like store) — the pool ──
    { key: 'SY-NEW-1', country: 'SY', company: 'on', pool: true, status: 'NEW', createdAt: ago(300), lines: [], expect: 'جديد — الأقدم أول' },
    { key: 'SY-NEW-2', country: 'SY', company: 'on', pool: true, status: 'NEW', createdAt: ago(240), lines: [], expect: 'جديد' },
    {
      key: 'SY-PROMISE-DUE', country: 'SY', company: 'on', pool: true, status: 'POSTPONED', createdAt: ago(3 * 24 * 60),
      postponedUntil: at(-20), nextFollowUpAt: at(-20), followUpReason: 'CUSTOMER_REQUESTED_CALLBACK',
      lines: [line(1, 'CALLBACK_REQUESTED', 24 * 60, at(-20))], expect: 'وعد زبون وصل وقتو',
    },
    {
      key: 'SY-PROMISE-WAITING', country: 'SY', company: 'on', pool: true, status: 'POSTPONED', createdAt: ago(2 * 24 * 60),
      postponedUntil: at(6 * 60), nextFollowUpAt: at(6 * 60), followUpReason: 'POSTPONED',
      lines: [line(1, 'CALLBACK_REQUESTED', 3 * 60, at(6 * 60))], expect: 'مؤجّل — ما حان (ما بينسحب)',
    },
    // The retries: by their DUE they are A (-150), B (-90), C (-90, a tie with B: the older order B first), E (-60); by their AGE they are E, B, C, A.
    { key: 'SY-RETRY-A', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(24 * 60), lines: [line(1, 'NO_ANSWER', 180, at(-150))], expect: 'إعادة جاهزة — الموعد -150د' },
    { key: 'SY-RETRY-B', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(3 * 24 * 60), lines: [line(1, 'NO_ANSWER', 120, tie)], expect: 'إعادة جاهزة — الموعد -90د (تعادل، الأقدم إنشاءً)' },
    { key: 'SY-RETRY-C', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(2 * 24 * 60), lines: [line(1, 'NO_ANSWER', 120, tie)], expect: 'إعادة جاهزة — الموعد -90د (تعادل)' },
    {
      key: 'SY-RETRY-E', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(4 * 24 * 60),
      lines: [line(1, 'NO_ANSWER', 400, at(-370)), line(2, 'NO_ANSWER', 180, at(-60))], expect: 'إعادة جاهزة (محاولتان) — الموعد -60د، الأقدم إنشاءً',
    },
    // NOT YET DUE for about two hours: the second counted press was two minutes ago and the plan's wait after it is 2 h (#1 at -300, due -270; #2 at -2, due +118).
    { key: 'SY-RETRY-D', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(24 * 60), lines: [line(1, 'NO_ANSWER', 300, at(-270)), line(2, 'NO_ANSWER', 2, at(118))], expect: 'إعادة لسا ما حان موعدها بعد ساعتين (ما بتنسحب)' },
    // A «لا يرد» line from BEFORE the switch (three days ago): it carries no due and counts for nothing — the order falls to «the rest, oldest created».
    { key: 'SY-LEGACY', country: 'SY', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(6 * 24 * 60), nextFollowUpAt: null, lines: [line(1, 'NO_ANSWER', 5 * 24 * 60, null)], expect: 'سطر قديم قبل المفتاح — من «الباقي بالأقدم»' },
    // ── SY — in agent 1's hand ──
    { key: 'SY-HELD-NEW', country: 'SY', company: 'on', heldBy: 'agent1On', status: 'IN_PROGRESS', createdAt: ago(200), claimedAt: ago(12), lines: [], expect: 'ممسوك — اتصلي هلّق' },
    { key: 'SY-HELD-RETRY', country: 'SY', company: 'on', heldBy: 'agent1On', status: 'IN_PROGRESS', createdAt: ago(2 * 24 * 60), claimedAt: ago(12), lines: [line(1, 'NO_ANSWER', 200, at(-170))], expect: 'ممسوك — محاولة 2 جاهزة' },
    { key: 'SY-HELD-PROMISE', country: 'SY', company: 'on', heldBy: 'agent1On', status: 'POSTPONED', createdAt: ago(4 * 24 * 60), claimedAt: ago(12), postponedUntil: at(-30), nextFollowUpAt: at(-30), followUpReason: 'CUSTOMER_REQUESTED_CALLBACK', lines: [line(1, 'CALLBACK_REQUESTED', 24 * 60, at(-30))], expect: 'ممسوك — وعد زبون وصل وقتو' },
    // ── SY — closed today by the fifth «لا يرد» (the plan's own code), still under her name ──
    {
      // FIVE COUNTED presses over two local days, exactly the plan's own times (#2 +30 min, #3 +2 h, #4 at 10:00 the next day and 8 h+ after #3, #5 at 18:00) — so the
      // desk counts 5 and prints the plan's «closed» words. The status log that the card's «today» filter reads is stamped by the seed (`closedToday`), not by these lines.
      key: 'SY-CLOSED-TODAY', country: 'SY', company: 'on', heldBy: 'agent1On', closedToday: 'NO_ANSWER_5_ATTEMPTS', status: 'CANCELLED', createdAt: ago(5 * 24 * 60), claimedAt: ago(40),
      lines: (() => {
        const tz = COUNTRIES.SY.timezone;
        const t1 = localAt(now, tz, -2, '11:00'), t2 = localAt(now, tz, -2, '11:30'), t3 = localAt(now, tz, -2, '13:30'), t4 = localAt(now, tz, -1, '10:00'), t5 = localAt(now, tz, -1, '18:00');
        const l = (n, t, due) => ({ n, result: 'NO_ANSWER', createdAt: t, due });
        return [l(1, t1, t2), l(2, t2, t3), l(3, t3, t4), l(4, t4, t5), l(5, t5, null)];
      })(),
      expect: 'أُغلق اليوم بعد 5 محاولات',
    },
    // ── JO (the ON company's Jordan-like store) ──
    { key: 'JO-NEW-1', country: 'JO', company: 'on', pool: true, status: 'NEW', createdAt: ago(180), lines: [], expect: 'جديد' },
    { key: 'JO-RETRY-READY', country: 'JO', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(24 * 60), lines: [line(1, 'NO_ANSWER', 90, at(-60))], expect: 'إعادة جاهزة' },
    { key: 'JO-RETRY-WAIT', country: 'JO', company: 'on', pool: true, status: 'NO_ANSWER', createdAt: ago(24 * 60), lines: [line(1, 'NO_ANSWER', 300, at(-270)), line(2, 'NO_ANSWER', 2, at(118))], expect: 'إعادة لسا ما حان موعدها بعد ساعتين' },
    { key: 'JO-HELD-NEW', country: 'JO', company: 'on', heldBy: 'agent2On', status: 'IN_PROGRESS', createdAt: ago(100), claimedAt: ago(12), lines: [], expect: 'ممسوك — اتصلي هلّق' },
  ];

  const off = [
    // The OFF company: today's rules (three «لا يرد» close, no dues written on lines).
    { key: 'OFF-NEW-1', country: 'SY', company: 'off', pool: true, status: 'NEW', createdAt: ago(300), lines: [], expect: 'جديد' },
    { key: 'OFF-NO-ANSWER', country: 'SY', company: 'off', pool: true, status: 'NO_ANSWER', createdAt: ago(2 * 24 * 60), nextFollowUpAt: null, lines: [line(1, 'NO_ANSWER', 24 * 60, null), line(2, 'NO_ANSWER', 6 * 60, null)], expect: 'لا يرد مرتين — القاعدة القديمة' },
    { key: 'OFF-HELD-NEW', country: 'SY', company: 'off', heldBy: 'agentOff', status: 'IN_PROGRESS', createdAt: ago(200), claimedAt: ago(12), lines: [], expect: 'ممسوك' },
    {
      key: 'OFF-CLOSED-TODAY', country: 'SY', company: 'off', heldBy: 'agentOff', closedToday: 'NO_ANSWER_3_ATTEMPTS', status: 'CANCELLED', createdAt: ago(4 * 24 * 60), claimedAt: ago(40),
      lines: [line(1, 'NO_ANSWER', 2 * 24 * 60, null), line(2, 'NO_ANSWER', 24 * 60, null), line(3, 'NO_ANSWER', 10, null)], expect: 'أُغلق اليوم بعد 3 محاولات (القاعدة القديمة)',
    },
  ];

  return [...on, ...off];
}

/**
 * WHAT EACH DESK IS HANDED, IN ORDER — written by hand from the planner's rules and the times above, NOT copied from a run:
 *   NEW first, the oldest created first (SY-NEW-1 at -300 min, SY-NEW-2 at -240) · then the customer's promise whose date arrived ·
 *   then the RETRIES by their due (A -150, then the tie B / C at -90 where the older order B goes first, then E at -60) ·
 *   then «the rest» oldest created (the legacy line from before the switch). Not handed: SY-RETRY-D and JO-RETRY-WAIT (their due is in
 *   about two hours), SY-PROMISE-WAITING (six hours), and anything in an agent's hand.
 * The OFF company has the switch off — today's order: new, then the rest oldest first — and no time of day changes any of these lists
 * (the dues are stored instants, and the legacy mode asks no working-hours question).
 * If a ruling changes the pull order, THIS list changes with it, in the same pull request, and the reviewer reads it as the new rule.
 */
export const EXPECTED_HAND_OUT = {
  [USERS.agent1On.email]: ['SY-NEW-1', 'SY-NEW-2', 'SY-PROMISE-DUE', 'SY-RETRY-A', 'SY-RETRY-B', 'SY-RETRY-C', 'SY-RETRY-E', 'SY-LEGACY'],
  [USERS.agent2On.email]: ['JO-NEW-1', 'JO-RETRY-READY'],
  [USERS.agentOff.email]: ['OFF-NEW-1', 'OFF-NO-ANSWER'],
};

/** The real door's first answer to a desk AS SEEDED (her hand holds an order with no attempt), and its last answer once the pool is empty. */
export const EXPECTED_REFUSALS = { atSeed: 'UNTOUCHED_ORDER', whenEmpty: 'QUEUE_EMPTY' };

/** The differences between two lists of order keys, one sentence each; an empty array means they are the same list in the same order. */
export function diffHandOut(actual, expected) {
  if (!Array.isArray(expected)) return ['no expected list is written for this desk'];
  const out = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    if (actual[i] !== expected[i]) out.push(`#${i + 1}: expected ${expected[i] ?? '(nothing)'} · got ${actual[i] ?? '(nothing)'}`);
  }
  return out;
}
