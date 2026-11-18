import { businessMinutesBetween, zonedParts, zonedTimeToInstant, type BusinessCalendar } from './business-calendar';
import { FLOW_MIN_EVENTS, claimKindOf, middle, percentOf, type AttemptLine, type ClaimLine } from './held-flow';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القياس كل أسبوع» — SIX FIGURES AGAINST SIX TARGETS, AND TWO CHECKS (the owner's plan of 17/11, request C3).
 *
 * After the one rule of the confirmation desk went live, the owner wants to see every week whether it works. This file is the
 * ARITHMETIC and the WORDS only: no database, no clock (the window is cut from a `now` handed in), no framework. The reads live in
 * `weekly-measures-read.ts`; the screen (`WeeklyMeasures.tsx`) prints the strings written here and decides nothing.
 *
 * READ ONLY, AND NOTHING IS DECIDED BY CODE: a target only colours a tile (ماشي / انتباه) and a check only writes a sentence — no rule,
 * no queue, no number anywhere moves because of a figure here.
 *
 * THE WINDOW is the last seven COMPLETE local days of the store's country (yesterday back), or the seven before them. Every
 * percentage stands beside «X من Y», and a base of zero is «—», never «0%».
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * THE TARGETS — rule values, in ONE object. The tile's tone reads only these (never a measured figure), and the two checks read
 * their thresholds from here too.
 */
export const WEEKLY_TARGETS = {
  /** «سرعة أول اتصال»: the median, in working minutes, at most this. */
  firstCallMinutes: 15,
  /** «التأكيد من الطلبات الفريدة»: at least this percent. */
  uniqueConfirmedPercent: 65,
  /** «لا يرد اللي انعاد عليه»: at least this percent. */
  retriedPercent: 95,
  /** «المتأخر»: finished − entered, at least this. */
  backlogNet: 0,
  /** «سحبات رجعت بلا اتصال»: strictly under this percent. */
  silentPullsPercent: 5,
  /** «تسليم المؤكَّد»: at least this percent. */
  deliveredPercent: 85,
  /** The first two-week check: the answer rate of the fifth attempt, against this percent. */
  fifthAnswerPercent: 25,
  /** The second two-week check: the share of entries through «الزبون على الخط», against this percent. */
  onTheLinePercent: 10,
} as const;

/** How many days one window holds. */
export const WEEKLY_DAYS = 7;

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const dayKeyOf = (utcDay: number) => {
  const d = new Date(utcDay);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const midnightOf = (utcDay: number, timeZone: string) => {
  const d = new Date(utcDay);
  return zonedTimeToInstant(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0);
};

// ───────────────────────── the window ─────────────────────────

export type WeekKey = 'this' | 'last';

export interface WeeklyWindow {
  week: WeekKey;
  /** Local midnight of the first day — included. */
  start: Date;
  /** Local midnight of the day AFTER the last — excluded. */
  end: Date;
  /** The first and the last local day, `yyyy-mm-dd`. */
  fromDay: string;
  toDay: string;
}

/** The week a query string asked for: «last» is the week before; anything else is this one. */
export function weekKeyOf(raw: string | null | undefined): WeekKey {
  return raw === 'last' ? 'last' : 'this';
}

/**
 * THE SEVEN COMPLETE LOCAL DAYS ENDING YESTERDAY (or the seven before them), in the store country's timezone. Calendar arithmetic on
 * UTC dates, and only the two edges placed in the zone — so midnight, a month end or a DST day never moves a day in or out.
 */
export function weeklyWindow(now: Date, timeZone: string, week: WeekKey = 'this'): WeeklyWindow {
  const p = zonedParts(now, timeZone);
  const today = Date.UTC(p.year, p.month - 1, p.day);
  const endDay = today - (week === 'last' ? WEEKLY_DAYS : 0) * DAY_MS;
  const startDay = endDay - WEEKLY_DAYS * DAY_MS;
  return {
    week,
    start: midnightOf(startDay, timeZone),
    end: midnightOf(endDay, timeZone),
    fromDay: dayKeyOf(startDay),
    toDay: dayKeyOf(endDay - DAY_MS),
  };
}

/**
 * THE START OF THE WINDOW'S LAST WORKING DAY — a not-reached line at or after it has not had a working day to be called again, so it is
 * outside the base of «لا يرد اللي انعاد عليه». A window with no working day at all gives its start (every line is outside).
 */
export function lastWorkingDayStart(window: Pick<WeeklyWindow, 'start' | 'end'>, cal: BusinessCalendar): Date {
  const p = zonedParts(new Date(window.end.getTime() - 1), cal.timezone);
  let day = Date.UTC(p.year, p.month - 1, p.day);
  for (let i = 0; i < WEEKLY_DAYS; i++, day -= DAY_MS) {
    if (cal.weekendDays.includes(new Date(day).getUTCDay())) continue;
    const at = midnightOf(day, cal.timezone);
    return at.getTime() < window.start.getTime() ? window.start : at;
  }
  return window.start;
}

// ───────────────────────── the arithmetic ─────────────────────────

/** The shipping states a confirmed order ends in; anything else is «لسا بالطريق». */
const DELIVERED_STATES = ['DELIVERED', 'PARTIALLY_DELIVERED'];
const NOT_DELIVERED_STATES = ['FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'];
/** A confirmed order refused afterwards never left: it ended without a delivery. */
const REFUSED = ['REJECTED', 'CANCELLED'];
/** The decisions that end the confirmation stage (the `held-flow.ts` reading). */
const DECISIONS = ['CONFIRMED', 'REJECTED', 'CANCELLED'];
/** The rejection that says «the same order twice». */
export const DUPLICATE_REJECTION = 'DUPLICATE_ORDER';

/** Everything the arithmetic reads — already scoped to one company and one store by the reader. */
export interface WeeklyInput {
  window: Pick<WeeklyWindow, 'start' | 'end'>;
  calendar: BusinessCalendar;
  /** Orders created in the window. `duplicateMarked`: the intake filter wrote its duplicate line on it. */
  created: { id: string; createdAt: Date; confirmed: boolean; duplicateMarked: boolean; rejectionReason: string | null }[];
  /** The first CALL outcome (reached or not) of each order created in the window that has one. */
  firstCalls: ReadonlyMap<string, Date>;
  /** Every call line (an outcome — a button or a message is not a call) of the window. */
  callLines: { orderId: string; at: Date; reached: boolean }[];
  /** Orders whose not-reached line before the window exists — their first one did not fall in it. */
  notReachedBefore: ReadonlySet<string>;
  /** Of the orders with a not-reached line in the window, those the five-attempt rule closed. */
  closedByRule: ReadonlySet<string>;
  /** Decisions out of an open confirmation status, in the window (the confirmation status log). */
  decisions: { orderId: string; to: string; at: Date }[];
  /** For the decided orders: the time of their earliest not-reached line, when they have one. */
  firstNotReachedAt: ReadonlyMap<string, Date>;
  /** The claim ledger of the window. */
  claims: ClaimLine[];
  /** Every attempt of the window (a call, a press, a message) — who, which order, when. */
  attempts: AttemptLine[];
  /** Orders CONFIRMED in the window, with where their parcel stands. */
  confirmedOrders: { id: string; shippingStatus: string; confirmationStatus: string }[];
  /** The window's answer-rate row of the fifth attempt (`tallyAnswerRate`). */
  fifth: { reached: number; base: number };
  /** A reader hit its bound: every figure is «حد أدنى». */
  truncated: boolean;
}

export interface WeeklyFigures {
  firstCall: { medianMinutes: number | null; base: number; noCallYet: number };
  uniqueConfirmed: { confirmed: number; base: number; duplicates: number; rate: number | null };
  retried: { retried: number; base: number; rate: number | null };
  backlog: { entered: number; finished: number; net: number };
  silentPulls: { silent: number; base: number; rate: number | null };
  delivered: { delivered: number; base: number; onTheRoad: number; rate: number | null };
  checks: {
    fifth: { reached: number; base: number; rate: number | null };
    onTheLine: { part: number; base: number; rate: number | null };
  };
  truncated: boolean;
}

/** «فريدة»: not marked duplicate at intake, and not rejected as a duplicate. */
export function isUniqueOrder(o: { duplicateMarked: boolean; rejectionReason: string | null }): boolean {
  return !o.duplicateMarked && o.rejectionReason !== DUPLICATE_REJECTION;
}

export function tallyWeekly(input: WeeklyInput): WeeklyFigures {
  const { window, calendar } = input;

  // 1 · the first call, in working minutes from the creation.
  const minutes: number[] = [];
  let noCallYet = 0;
  for (const o of input.created) {
    const first = input.firstCalls.get(o.id);
    if (first) minutes.push(businessMinutesBetween(o.createdAt, first, calendar));
    else noCallYet++;
  }

  // 2 · confirmed of the unique orders created.
  const unique = input.created.filter(isUniqueOrder);
  const confirmed = unique.filter((o) => o.confirmed).length;

  // 3 · a not-reached line with a working day still ahead in the window: called again (any outcome), or closed by the rule.
  const cutoff = lastWorkingDayStart(window, calendar).getTime();
  const lastMissInBase = new Map<string, number>();
  const lastCall = new Map<string, number>();
  for (const l of input.callLines) {
    const t = l.at.getTime();
    if (t < window.start.getTime() || t >= window.end.getTime()) continue;
    lastCall.set(l.orderId, Math.max(lastCall.get(l.orderId) ?? -Infinity, t));
    if (!l.reached && t < cutoff) lastMissInBase.set(l.orderId, Math.max(lastMissInBase.get(l.orderId) ?? -Infinity, t));
  }
  let retried = 0;
  for (const [orderId, t] of lastMissInBase) if ((lastCall.get(orderId) ?? -Infinity) > t || input.closedByRule.has(orderId)) retried++;

  // 4 · finished − entered: entered = the FIRST not-reached line falls in the window; finished = a decision, after a not-reached line.
  const entered = new Set<string>();
  for (const l of input.callLines) {
    const t = l.at.getTime();
    if (!l.reached && t >= window.start.getTime() && t < window.end.getTime() && !input.notReachedBefore.has(l.orderId)) entered.add(l.orderId);
  }
  const firstDecision = new Map<string, number>();
  for (const d of input.decisions) {
    const t = d.at.getTime();
    if (!DECISIONS.includes(d.to) || t < window.start.getTime() || t >= window.end.getTime()) continue;
    firstDecision.set(d.orderId, Math.min(firstDecision.get(d.orderId) ?? Infinity, t));
  }
  let finished = 0;
  for (const [orderId, t] of firstDecision) {
    const miss = input.firstNotReachedAt.get(orderId);
    if (miss && miss.getTime() < t) finished++;
  }

  // 5 · a pull released with no attempt by the puller between the claim and the release.
  const ledgerOf = new Map<string, ClaimLine[]>();
  for (const c of input.claims) {
    const list = ledgerOf.get(c.orderId);
    if (list) list.push(c);
    else ledgerOf.set(c.orderId, [c]);
  }
  for (const list of ledgerOf.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  const triesOf = new Map<string, number[]>();
  for (const a of input.attempts) {
    const key = `${a.orderId}\u0000${a.userId}`;
    const list = triesOf.get(key);
    if (list) list.push(a.at.getTime());
    else triesOf.set(key, [a.at.getTime()]);
  }
  let pulls = 0;
  let silent = 0;
  for (const [orderId, list] of ledgerOf) {
    list.forEach((line, i) => {
      if (claimKindOf(line.action, line.reason) !== 'PULLED') return;
      pulls++;
      const release = list.slice(i + 1).find((l) => l.action === 'RELEASED');
      if (!release) return;
      const from = line.at.getTime();
      const to = release.at.getTime();
      const tries = triesOf.get(`${orderId}\u0000${line.userId}`) ?? [];
      if (!tries.some((t) => t >= from && t <= to)) silent++;
    });
  }

  // 6 · of the confirmed orders that reached a final state, the delivered.
  let delivered = 0;
  let deliveredBase = 0;
  let onTheRoad = 0;
  for (const o of input.confirmedOrders) {
    if (DELIVERED_STATES.includes(o.shippingStatus)) {
      delivered++;
      deliveredBase++;
    } else if (NOT_DELIVERED_STATES.includes(o.shippingStatus) || REFUSED.includes(o.confirmationStatus)) {
      deliveredBase++;
    } else onTheRoad++;
  }

  // The second check: what ENTERED the hands, and of it the takes through «الزبون على الخط» from the pool.
  let pulled = 0;
  let typed = 0;
  let calledBack = 0;
  let handedOver = 0;
  for (const c of input.claims) {
    const kind = claimKindOf(c.action, c.reason);
    if (kind === 'PULLED') pulled++;
    else if (kind === 'TYPED') typed++;
    else if (kind === 'ON_THE_LINE') calledBack++;
    else if (kind === 'HANDED_OVER') handedOver++;
  }
  const onTheLine = Math.max(0, calledBack - handedOver);
  const enteredHands = pulled + typed + onTheLine;

  return {
    firstCall: { medianMinutes: middle(minutes), base: minutes.length, noCallYet },
    uniqueConfirmed: { confirmed, base: unique.length, duplicates: input.created.length - unique.length, rate: percentOf(confirmed, unique.length) },
    retried: { retried, base: lastMissInBase.size, rate: percentOf(retried, lastMissInBase.size) },
    backlog: { entered: entered.size, finished, net: finished - entered.size },
    silentPulls: { silent, base: pulls, rate: percentOf(silent, pulls) },
    delivered: { delivered, base: deliveredBase, onTheRoad, rate: percentOf(delivered, deliveredBase) },
    checks: {
      fifth: { reached: input.fifth.reached, base: input.fifth.base, rate: percentOf(input.fifth.reached, input.fifth.base) },
      onTheLine: { part: onTheLine, base: enteredHands, rate: percentOf(onTheLine, enteredHands) },
    },
    truncated: input.truncated,
  };
}

// ───────────────────────── the words ─────────────────────────

export type WeeklyTone = 'OK' | 'WATCH';
const TONE_AR: Record<WeeklyTone, string> = { OK: 'ماشي', WATCH: 'انتباه' };

/** One tile, written for the screen: it prints these strings and decides nothing. */
export interface WeeklyTile {
  key: 'firstCall' | 'uniqueConfirmed' | 'retried' | 'backlog' | 'silentPulls' | 'delivered';
  label: string;
  /** The figure — «—» when its base is zero. */
  value: string;
  /** «X من Y», or the parts of the figure. */
  counts: string;
  /** What is counted apart, outside the base — or null. */
  apart: string | null;
  /** «الهدف …». */
  target: string;
  /** From the target only; null when there is nothing to judge. */
  tone: WeeklyTone | null;
  /** The tone in a word («ماشي» / «انتباه»), so colour never carries it alone. */
  toneWords: string | null;
  /** How it was counted. */
  definition: string;
}

const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);
/** `part / base` against a percent, by multiplication — a boundary is an integer, never a rounding. */
const atLeast = (part: number, base: number, percent: number): WeeklyTone | null => (base === 0 ? null : part * 100 >= base * percent ? 'OK' : 'WATCH');

export function weeklyTiles(f: WeeklyFigures): WeeklyTile[] {
  return tilesOf(f).map((t) => ({ ...t, toneWords: t.tone ? TONE_AR[t.tone] : null }));
}

function tilesOf(f: WeeklyFigures): Omit<WeeklyTile, 'toneWords'>[] {
  const T = WEEKLY_TARGETS;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    {
      key: 'firstCall',
      label: 'سرعة أول اتصال',
      value: f.firstCall.medianMinutes === null ? '—' : String(f.firstCall.medianMinutes),
      counts: `دقيقة عمل — الوسيط من ${f.firstCall.base} طلب`,
      apart: `لسا بلا اتصال: ${f.firstCall.noCallYet}`,
      target: `الهدف: ${T.firstCallMinutes} دقيقة عمل أو أقل`,
      tone: f.firstCall.medianMinutes === null ? null : f.firstCall.medianMinutes <= T.firstCallMinutes ? 'OK' : 'WATCH',
      definition: 'من وقت إنشاء الطلب لأول اتصال إلو نتيجة (ردّ أو ما ردّ)، بدقائق الدوام بس — العطلة وخارج الدوام ما بينحسبوا. للطلبات اللي انعملت بهالأسبوع.',
    },
    {
      key: 'uniqueConfirmed',
      label: 'التأكيد من الطلبات الفريدة',
      value: pct(f.uniqueConfirmed.rate),
      counts: `${f.uniqueConfirmed.confirmed} من ${f.uniqueConfirmed.base}`,
      apart: `مكرّر برّا الحساب: ${f.uniqueConfirmed.duplicates}`,
      target: `الهدف: ${T.uniqueConfirmedPercent}% أو أكتر`,
      tone: atLeast(f.uniqueConfirmed.confirmed, f.uniqueConfirmed.base, T.uniqueConfirmedPercent),
      definition: 'المؤكَّد ÷ الطلبات اللي انعملت بهالأسبوع، بعد ما نشيل اللي تنبيه الاستقبال علّم عليها «مكرر» واللي انرفضت لأنها مكررة.',
    },
    {
      key: 'retried',
      label: 'لا يرد اللي انعاد عليه',
      value: pct(f.retried.rate),
      counts: `${f.retried.retried} من ${f.retried.base}`,
      apart: null,
      target: `الهدف: ${T.retriedPercent}% أو أكتر`,
      tone: atLeast(f.retried.retried, f.retried.base, T.retriedPercent),
      definition: 'الطلبات اللي إلها «ما ردّ» بهالأسبوع قبل آخر يوم دوام فيه: كم منها انعاد عليها اتصال بعدها، أو سكّرها حكم المحاولات الخمس. «ما ردّ» بآخر يوم دوام برّا الحساب.',
    },
    {
      key: 'backlog',
      label: 'المتأخر: اللي خلص ناقص اللي دخل',
      value: signed(f.backlog.net),
      counts: `خلص ${f.backlog.finished} · دخل ${f.backlog.entered}`,
      apart: null,
      target: `الهدف: ${T.backlogNet === 0 ? 'صفر' : T.backlogNet} أو أكتر`,
      tone: f.backlog.net >= T.backlogNet ? 'OK' : 'WATCH',
      definition: 'دخل = طلب أول «ما ردّ» إلو صار بهالأسبوع. خلص = طلب إلو «ما ردّ» قبل وانحسم بهالأسبوع (أكّد، انرفض أو انلغى). الطلب اللي انحسم مرتين بينعدّ مرة.',
    },
    {
      key: 'silentPulls',
      label: 'سحبات رجعت بلا اتصال',
      value: pct(f.silentPulls.rate),
      counts: `${f.silentPulls.silent} من ${f.silentPulls.base}`,
      apart: null,
      target: `الهدف: أقل من ${T.silentPullsPercent}%`,
      tone: f.silentPulls.base === 0 ? null : f.silentPulls.silent * 100 < f.silentPulls.base * T.silentPullsPercent ? 'OK' : 'WATCH',
      definition: 'من السحبات اللي صارت بهالأسبوع: كم وحدة رجعت للطابور بدون ولا محاولة من اللي سحبتها بين السحب والرجعة.',
    },
    {
      key: 'delivered',
      label: 'تسليم المؤكَّد',
      value: pct(f.delivered.rate),
      counts: `${f.delivered.delivered} من ${f.delivered.base}`,
      apart: `لسا بالطريق: ${f.delivered.onTheRoad}`,
      target: `الهدف: ${T.deliveredPercent}% أو أكتر`,
      tone: atLeast(f.delivered.delivered, f.delivered.base, T.deliveredPercent),
      definition: 'من الطلبات اللي انأكّدت بهالأسبوع ووصلت لآخر طريقها: كم منها انسلّم. اللي لسا بالطريق برّا الحساب.',
    },
  ];
}

export type CheckVerdict = 'SMALL' | 'ABOVE' | 'BELOW';

/** The two checks of the two weeks, as sentences built from the figures only. A base under `FLOW_MIN_EVENTS` is «العيّنة صغيرة», never a verdict. */
export function weeklyChecks(f: WeeklyFigures): { key: 'fifth' | 'onTheLine'; verdict: CheckVerdict; sentence: string }[] {
  const T = WEEKLY_TARGETS;
  const small = 'العيّنة صغيرة — لسا بكّير نحكم.';
  const fifth = f.checks.fifth;
  const fifthVerdict: CheckVerdict =
    fifth.base < FLOW_MIN_EVENTS ? 'SMALL' : fifth.reached * 100 >= fifth.base * T.fifthAnswerPercent ? 'ABOVE' : 'BELOW';
  const line = f.checks.onTheLine;
  const lineVerdict: CheckVerdict = line.base < FLOW_MIN_EVENTS ? 'SMALL' : line.part * 100 > line.base * T.onTheLinePercent ? 'ABOVE' : 'BELOW';
  return [
    {
      key: 'fifth',
      verdict: fifthVerdict,
      sentence:
        `نسبة الرد بالمحاولة الخامسة ${pct(fifth.rate)} (من ${fifth.base}) — ` +
        (fifthVerdict === 'SMALL'
          ? small
          : fifthVerdict === 'ABOVE'
            ? `${T.fifthAnswerPercent}% أو أكتر: الخامسة لسا بتجيب رد.`
            : `أقل من ${T.fifthAnswerPercent}%: الخامسة قليلة الفايدة بهالأسبوع.`),
    },
    {
      key: 'onTheLine',
      verdict: lineVerdict,
      sentence:
        `دخول من «الزبون على الخط»: ${line.part} من ${line.base} (${pct(line.rate)}) — ` +
        (lineVerdict === 'SMALL'
          ? small
          : lineVerdict === 'ABOVE'
            ? `أكتر من ${T.onTheLinePercent}%: شوفوا إذا عم ينستعمل لنقاوة الطلبات.`
            : `${T.onTheLinePercent}% أو أقل: ضمن المتوقع.`),
    },
  ];
}

/** «آخر 7 أيام: من … لـ …» — the window beside the card's title («الأسبوع اللي قبلو: من … لـ …» for the week before). */
export function weeklyWindowWords(w: Pick<WeeklyWindow, 'week' | 'fromDay' | 'toDay'>): string {
  return `${w.week === 'last' ? 'الأسبوع اللي قبلو' : `آخر ${WEEKLY_DAYS} أيام`}: من ${w.fromDay} لـ ${w.toDay}`;
}

/** What the door answers for `?part=weekly`. */
export interface WeeklyMeasures {
  figures: WeeklyFigures;
  tiles: WeeklyTile[];
  checks: ReturnType<typeof weeklyChecks>;
  truncated: boolean;
}

export function weeklyMeasuresOf(figures: WeeklyFigures): WeeklyMeasures {
  return { figures, tiles: weeklyTiles(figures), checks: weeklyChecks(figures), truncated: figures.truncated };
}
