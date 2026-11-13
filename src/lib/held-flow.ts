/**
 * ═══════════════════════════════════════════════════════════════════════
 * «حركة الطلبات» — WHAT ENTERS THE AGENTS' HANDS, WHAT LEAVES THEM, HOW LONG IT SITS, AND HOW SMOOTHLY IT MOVES.
 *
 * The owner (13/11, on his phone, over «لا رد والطلبات المحجوزة»): «بدي لوحة تحكم صغيرة هون بس ذكية نفهم الارقام وديناميكا حركة
 * الطلبات وسلاستها». He reads «بيد الموظفات الآن: 1,3xx» and cannot tell whether that is normal, growing, stuck or moving. So this
 * file answers four questions about ONE store over a window (6 hours · 24 hours · 7 days, wall clock), and says the answer in a
 * sentence. It only reads: no write, no rule, no pull, no release, no close, no money. Agents and counts only — no customer field.
 *
 * THIS FILE IS PURE: no database, no clock, no `Date.now()`. The questions it is asked live in `held-flow-read.ts`, which hands it
 * rows. (The screen imports the words and the window list from here, so nothing here may import the database either.)
 *
 * ── THE FOUR QUESTIONS ──
 *
 *   1. THE FLOW (the window)
 *        · دخل النظام   — orders CREATED in the window (`Order.createdAt`).
 *        · انسحب        — pulls out of the pool into somebody's hand: claim-history lines `CLAIMED` / `PULL_NEXT`. A PULL is an event,
 *                         so an order pulled twice is two pulls (the sums below only close if every entry is counted).
 *        · طلع من الأيدي — every way an order leaves a hand that a ledger with a timestamp proves (see «WHAT IS PROVED»):
 *                         أُكِّد · رجع للطابور · انلغى.
 *        · الصافي       — everything that ENTERED the hands minus everything that LEFT them. Positive = the held pile grew.
 *   2. HOW LONG THEY SIT — the orders held NOW, by wall-clock time since the claim: under 6 hours · 6–24 hours · 1–3 days · more than
 *      3 days, and the oldest one's age.
 *   3. HOW SMOOTH
 *        · the MEDIAN time from a pull to the first attempt on that order (the puller's own, in WORKING minutes — the same
 *          convention as `teamPerformance.medianFirstActionMinutes`: nobody is punished for the night);
 *        · the share of pulls that got an attempt within `FAST_MINUTES` working minutes, always beside «X من Y»;
 *        · BOUNCED — orders pulled by two or more different agents in the window (a ping-pong).
 *   4. THE SENTENCE — `readFlow`: one or two plain sentences and a tone, built only from the numbers above.
 *
 * ── THE CLAIM LEDGER, REASON BY REASON (every `orderClaimHistory.create` was read; this is the table) ──
 *
 *   action / reason                                        written by                              counted as
 *   ─────────────────────────────────────────────────────  ──────────────────────────────────────  ───────────────────────────────
 *   CLAIMED     PULL_NEXT                                  the pull (`pullNextOrder`)              ENTERED · «انسحب»
 *   CLAIMED     MANUAL_ENTRY                               an agent typed the order herself        ENTERED · «بغير السحب» (never «انسحب»)
 *   CLAIMED     CUSTOMER_CALLED_BACK                       «الزبون على الخط» (`takeOnTheLine`)     ENTERED · «بغير السحب» — see below
 *   CLAIMED     anything else, or none                     the claim-by-number door (a free text)  «غير ذلك» — said, in no sum
 *   RELEASED    TAKEN_ON_THE_LINE                          the colleague's side of the same take   a HAND-OVER: neither entry nor exit
 *   RELEASED    AUTO_RELEASE_* (90 minutes, the rounds,    `releaseStaleClaims`, `releaseByRounds`, EXITED · «رجع للطابور»
 *               a date nobody touched, idle)               `releaseIdleReturns`
 *   RELEASED    NO_ANSWER_RETURNED · DATE_RETURNED         her own press (`returnToThePool`)       EXITED · «رجع للطابور»
 *   RELEASED    MANAGER_RETURNED                           a supervisor's return of her pile       EXITED · «رجع للطابور»
 *   RELEASED    a person's words, or none                  the release button (`DELETE …/claim`)   EXITED · «رجع للطابور»
 *   RELEASED    a CODE this table was never taught         a writer added after this file          «غير ذلك» — said, in no sum
 *   TRANSFERRED / OVERRIDDEN  (free text)                  the transfer door · «استلمه أنا»        MOVED — counted apart, in no sum
 *   UNLOCKED, or an action nobody writes today             —                                       «غير ذلك» — said, in no sum
 *
 * THE RELEASE BUTTON WRITES WHATEVER THE PERSON TYPED («اكتب السبب»: three letters at least), so a free text on a `RELEASED` line is
 * the normal case and is an exit by its ACTION. What it cannot be is written like a machine: a reason made only of capital letters,
 * digits and underscores (`NEW_AUTO_RULE`) is a system release this table was never taught — counted in `unknown`, said on the screen,
 * in no sum, so the day somebody adds a release rule the screen asks for its row instead of folding it into «رجع للطابور».
 * A `CLAIMED` line is stricter: its reason is what tells a pull from a take, so any reason this table does not know — a free text from
 * the claim-by-number door included — is not guessed into «انسحب»; it is counted in `unknown`, said, and in no sum.
 *
 * «الزبون على الخط» ENTERS FROM THE POOL OR FROM A COLLEAGUE. From a colleague it writes TWO lines in one transaction — her
 * `RELEASED / TAKEN_ON_THE_LINE` and the taker's `CLAIMED / CUSTOMER_CALLED_BACK` — and the held pile does not move; from the pool
 * it writes the second one alone. So the takes that ENTERED are `CUSTOMER_CALLED_BACK − TAKEN_ON_THE_LINE`, and the hand-over line is
 * in neither sum. (The metadata would say it line by line; the counts say the same without reading a JSON per row.)
 *
 * ── WHAT IS PROVED, AND WHAT IS LEFT OUT ──
 *
 * LEAVING A HAND is proved by two ledgers with a timestamp:
 *   · the claim ledger, for a release (above);
 *   · the confirmation status log (`OrderStatusLog`, `statusType: 'CONFIRMATION'`): a line whose `previousValue` is an OPEN status
 *     and whose `newValue` is CONFIRMED · REJECTED · CANCELLED is a DECISION at that moment. All three doors write it (the
 *     confirmation door, `endOrder`, the order PATCH). Rejected and cancelled are one number, «انلغى» — the team table reads them
 *     the same way. A decision is an exit from a HAND only if the order has a holder: «who holds it now» is the proxy (no door clears
 *     the holder on a decision, and a decision on an order nobody held — a manager's yes from the list — is not a hand letting go).
 * LEFT OUT, because no ledger with a time says it: an entry issue that sends the order back to its moderator
 * (`/api/confirmation/issues`), a postponed order handed back early (`/api/confirmation/postponed`), and the stand-down of a
 * shipment (`/api/ops/shipments/stand-down`) clear the holder and write NO claim-history line. They are not in «طلع من الأيدي»,
 * and the screen says so under the numbers — a net that read «+27» when the truth is «+20» would be a number nobody can trust.
 *
 * ── SCOPE AND SIZE ──
 *
 * Every question is scoped by company AND store (`held-flow-read.ts`), grouped (never one per agent or per order) and bounded.
 * A read that reaches its bound says so (`truncated`): a count is then «حد أدنى», no percentage is judged on it, and the speed
 * figures are not drawn at all — a share over half a window is a lie that looks like a number.
 *
 * A base of zero is a dash, never «0%» (the tab's own rule): the speed tiles are `null`, the share has no base.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ───────────────────────── the window ─────────────────────────

export const FLOW_WINDOW_KEYS = ['6h', '24h', '7d'] as const;
export type FlowWindowKey = (typeof FLOW_WINDOW_KEYS)[number];
/** The card opens on a day: long enough to hold a whole shift, short enough to move when something changes. */
export const DEFAULT_FLOW_WINDOW: FlowWindowKey = '24h';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const FLOW_WINDOWS: Record<FlowWindowKey, { ms: number; label: string }> = {
  '6h': { ms: 6 * HOUR_MS, label: 'آخر 6 ساعات' },
  '24h': { ms: 24 * HOUR_MS, label: 'آخر 24 ساعة' },
  '7d': { ms: 7 * DAY_MS, label: 'آخر 7 أيام' },
};

/** The key a query string asked for, or null when it is not one of the three — the door answers 400 for null. */
export function flowWindowKey(raw: string | null): FlowWindowKey | null {
  return (FLOW_WINDOW_KEYS as readonly string[]).includes(raw ?? '') ? (raw as FlowWindowKey) : null;
}

// ───────────────────────── the claim ledger ─────────────────────────

/** The reasons the writers use — copied here because the writers import the database; `held-flow.test.ts` holds each one to its writer. */
export const PULL_REASON = 'PULL_NEXT';
export const TYPED_REASON = 'MANUAL_ENTRY';
export const ON_THE_LINE_REASON = 'CUSTOMER_CALLED_BACK';
export const HANDED_OVER_REASON = 'TAKEN_ON_THE_LINE';

/** The system's own release reasons besides the `AUTO_RELEASE…` family — each written by a function named in the header table. */
const SYSTEM_RETURNS = ['NO_ANSWER_RETURNED', 'DATE_RETURNED', 'MANAGER_RETURNED'];
/** The family `isAutomaticRelease` (`auto-release.ts`) reads by its prefix: every one of them is the system's. */
const AUTO_RELEASE_PREFIX = 'AUTO_RELEASE';
/** Written like a machine: capital letters, digits and underscores only. A person's reason has words. */
const WRITTEN_LIKE_A_CODE = /^[A-Z][A-Z0-9_]*$/;

export type ClaimKind = 'PULLED' | 'TYPED' | 'ON_THE_LINE' | 'HANDED_OVER' | 'RETURNED' | 'MOVED' | 'UNKNOWN';

/** One row of the claim ledger, reduced to what the arithmetic reads. */
export interface ClaimLine {
  orderId: string;
  userId: string;
  action: string;
  reason: string | null;
  at: Date;
}

/** What one ledger line is — the table in the header, as code. */
export function claimKindOf(action: string, reason: string | null): ClaimKind {
  if (action === 'CLAIMED') {
    if (reason === PULL_REASON) return 'PULLED';
    if (reason === TYPED_REASON) return 'TYPED';
    if (reason === ON_THE_LINE_REASON) return 'ON_THE_LINE';
    return 'UNKNOWN';
  }
  if (action === 'RELEASED') {
    if (reason === HANDED_OVER_REASON) return 'HANDED_OVER';
    if (reason === null || reason.trim() === '') return 'RETURNED';
    if (reason.startsWith(AUTO_RELEASE_PREFIX) || SYSTEM_RETURNS.includes(reason)) return 'RETURNED';
    return WRITTEN_LIKE_A_CODE.test(reason) ? 'UNKNOWN' : 'RETURNED';
  }
  if (action === 'TRANSFERRED' || action === 'OVERRIDDEN') return 'MOVED';
  return 'UNKNOWN';
}

/** A decision out of an open status, from the confirmation status log. */
export interface DecisionLine {
  orderId: string;
  /** The status it went to. */
  to: string;
  at: Date;
}

/** Any logged attempt on an order — a call, a message, or a press of «اتصل» — the same «attempt» the idle release and «عالق» read. */
export interface AttemptLine {
  orderId: string;
  userId: string;
  at: Date;
}

export interface Truncated {
  /** The claim ledger hit its bound: every count from it is «حد أدنى». */
  ledger: boolean;
  /** The decisions hit theirs: «أُكِّد» and «انلغى» are «حد أدنى». */
  decisions: boolean;
  /** The attempts hit theirs: the speed figures are not drawn. */
  attempts: boolean;
  /** The held list hit its bound: the age buckets are «حد أدنى». */
  held: boolean;
}

// ───────────────────────── the arithmetic ─────────────────────────

/** A pull is judged «fast» if its first attempt came within this many WORKING minutes. */
export const FAST_MINUTES = 30;

export interface HeldBuckets {
  /** The orders held now: every bucket below plus `unknownAge`. */
  total: number;
  /** Held for less than 6 hours. */
  under6h: number;
  /** 6 hours up to (not including) 24. */
  from6hTo24h: number;
  /** 24 hours up to and including 3 days. */
  from1dTo3d: number;
  /** MORE than 3 days. */
  over3d: number;
  /** Held, but the claim carries no time — said, never put in a bucket. */
  unknownAge: number;
  /** The age of the oldest claim, in milliseconds. Null when no held order carries a time. */
  oldestMs: number | null;
}

export interface SpeedFigures {
  /** Pulls that can be judged: they got an attempt, or their `FAST_MINUTES` are over without one. */
  judged: number;
  /** Of the pulled orders, those the puller attempted at all (the median's base). */
  withAttempt: number;
  /** Of the judged, those whose first attempt came within `FAST_MINUTES` working minutes. */
  fast: number;
  /** The median working minutes from the pull to the first attempt. Null when nobody attempted. */
  medianMinutes: number | null;
}

export interface HeldFlowFigures {
  /** Orders created in the window. */
  created: number;
  entered: {
    /** `CLAIMED / PULL_NEXT`: pulls from the pool. */
    pulled: number;
    /** `CLAIMED / MANUAL_ENTRY`: the agent typed it herself. */
    typed: number;
    /** `CUSTOMER_CALLED_BACK` taken FROM THE POOL (a take from a colleague is a hand-over). */
    onTheLine: number;
    /** `pulled + typed + onTheLine`. */
    total: number;
  };
  exits: {
    confirmed: number;
    /** Every release except the hand-over to a colleague. */
    returned: number;
    /** Rejected or cancelled, out of an open status, by an order that has a holder. */
    cancelled: number;
    total: number;
  };
  /** `entered.total − exits.total`. */
  net: number;
  /** Transfers and takeovers: the order stayed in a hand. Counted apart, in no sum. */
  moved: number;
  /** Ledger lines this table does not know. Said, in no sum. */
  unknown: number;
  held: HeldBuckets;
  /** Null when the claim ledger or the attempts were cut at their bound. */
  speed: SpeedFigures | null;
  bounced: {
    /** Orders pulled by two or more different agents in the window. */
    orders: number;
    /** Distinct orders pulled in the window — the base. */
    of: number;
  };
  /** Working minutes the window held — a window with none is a night, not a standstill. */
  workMinutes: number;
  truncated: Truncated;
}

/** Everything the arithmetic reads. No database, no clock: `now` and `minutesBetween` arrive as arguments. */
export interface FlowInput {
  created: number;
  claims: ClaimLine[];
  decisions: DecisionLine[];
  attempts: AttemptLine[];
  held: { claimedAt: Date | null }[];
  now: Date;
  /** Working minutes between two instants, floored — `workClock(calendar).minutesBetween`. */
  minutesBetween: (from: Date, to: Date) => number;
  /** Working minutes the whole window held. */
  workMinutes: number;
  truncated: Truncated;
}

/** The middle value, rounded; empty is null, never a lying zero. The very rounding of `median` in `team-performance.ts` (a test holds them equal). */
export function middle(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? Math.round(sorted[mid]) : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** First index whose value is >= x. */
function firstAtOrAfter(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index whose value is > x. */
function firstAfter(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * THE HELD PILE BY AGE, wall clock. «أقل من 6 ساعات» is strictly under six; «من 6 لـ 24 ساعة» starts AT six and ends before twenty-four;
 * «من يوم لـ 3 أيام» starts at twenty-four hours and takes exactly three days; «أكتر من 3 أيام» is strictly MORE than three — each word
 * of the four labels is the comparison it is written with. A claim in the future (a clock that drifted) is age zero.
 */
export function bucketHeld(held: { claimedAt: Date | null }[], now: Date): HeldBuckets {
  const out: HeldBuckets = { total: held.length, under6h: 0, from6hTo24h: 0, from1dTo3d: 0, over3d: 0, unknownAge: 0, oldestMs: null };
  for (const h of held) {
    if (!h.claimedAt) {
      out.unknownAge++;
      continue;
    }
    const age = Math.max(0, now.getTime() - h.claimedAt.getTime());
    if (out.oldestMs === null || age > out.oldestMs) out.oldestMs = age;
    if (age < 6 * HOUR_MS) out.under6h++;
    else if (age < 24 * HOUR_MS) out.from6hTo24h++;
    else if (age <= 3 * DAY_MS) out.from1dTo3d++;
    else out.over3d++;
  }
  return out;
}

/**
 * THE SPEED OF THE PULLS. For each pull — one `CLAIMED / PULL_NEXT` line — the first attempt BY THE PULLER at or after the pull and
 * before the next line the ledger wrote on that order (a release, a transfer, another pull: the span the pull owned). An attempt of
 * somebody else, one before the pull, or one after the order had moved on is not this pull's. A pull with no attempt is a MISS only
 * once `FAST_MINUTES` working minutes have fully passed (more than, as the minutes are floored); a younger one cannot be judged yet and
 * is in no base.
 */
function speedOf(input: FlowInput, pulls: ClaimLine[]): SpeedFigures {
  const linesOf = new Map<string, number[]>();
  for (const l of input.claims) {
    const list = linesOf.get(l.orderId);
    if (list) list.push(l.at.getTime());
    else linesOf.set(l.orderId, [l.at.getTime()]);
  }
  for (const list of linesOf.values()) list.sort((a, b) => a - b);

  const triesOf = new Map<string, number[]>();
  for (const a of input.attempts) {
    const key = `${a.orderId}\u0000${a.userId}`;
    const list = triesOf.get(key);
    if (list) list.push(a.at.getTime());
    else triesOf.set(key, [a.at.getTime()]);
  }
  for (const list of triesOf.values()) list.sort((a, b) => a - b);

  let judged = 0;
  let fast = 0;
  const minutes: number[] = [];
  for (const pull of pulls) {
    const t = pull.at.getTime();
    const lines = linesOf.get(pull.orderId) ?? [];
    const nextLine = lines[firstAfter(lines, t)];
    const tries = triesOf.get(`${pull.orderId}\u0000${pull.userId}`) ?? [];
    const attemptAt = tries[firstAtOrAfter(tries, t)];
    if (attemptAt !== undefined && (nextLine === undefined || attemptAt < nextLine)) {
      const m = input.minutesBetween(pull.at, new Date(attemptAt));
      minutes.push(m);
      judged++;
      if (m <= FAST_MINUTES) fast++;
    } else if (input.minutesBetween(pull.at, input.now) > FAST_MINUTES) {
      judged++;
    }
  }
  return { judged, withAttempt: minutes.length, fast, medianMinutes: middle(minutes) };
}

/** The whole arithmetic, with nothing read: the same rows give the same figures. */
export function tallyFlow(input: FlowInput): HeldFlowFigures {
  let pulled = 0;
  let typed = 0;
  let calledBack = 0;
  let handedOver = 0;
  let returned = 0;
  let moved = 0;
  let unknown = 0;
  const pulls: ClaimLine[] = [];
  const pullersOf = new Map<string, Set<string>>();
  for (const line of input.claims) {
    switch (claimKindOf(line.action, line.reason)) {
      case 'PULLED': {
        pulled++;
        pulls.push(line);
        const who = pullersOf.get(line.orderId);
        if (who) who.add(line.userId);
        else pullersOf.set(line.orderId, new Set([line.userId]));
        break;
      }
      case 'TYPED':
        typed++;
        break;
      case 'ON_THE_LINE':
        calledBack++;
        break;
      case 'HANDED_OVER':
        handedOver++;
        break;
      case 'RETURNED':
        returned++;
        break;
      case 'MOVED':
        moved++;
        break;
      default:
        unknown++;
    }
  }

  let confirmed = 0;
  let cancelled = 0;
  for (const d of input.decisions) {
    if (d.to === 'CONFIRMED') confirmed++;
    else if (d.to === 'REJECTED' || d.to === 'CANCELLED') cancelled++;
    else unknown++;
  }

  // A take from a colleague is two lines and no movement: only the takes from the pool entered.
  const onTheLine = Math.max(0, calledBack - handedOver);
  const enteredTotal = pulled + typed + onTheLine;
  const exitsTotal = confirmed + returned + cancelled;

  const cut = input.truncated.ledger || input.truncated.attempts;
  let bouncedOrders = 0;
  for (const who of pullersOf.values()) if (who.size >= 2) bouncedOrders++;

  return {
    created: input.created,
    entered: { pulled, typed, onTheLine, total: enteredTotal },
    exits: { confirmed, returned, cancelled, total: exitsTotal },
    net: enteredTotal - exitsTotal,
    moved,
    unknown,
    held: bucketHeld(input.held, input.now),
    speed: cut ? null : speedOf(input, pulls),
    bounced: { orders: bouncedOrders, of: pullersOf.size },
    workMinutes: input.workMinutes,
    truncated: input.truncated,
  };
}

// ───────────────────────── the words ─────────────────────────

/** «يوم» · «يومين» · «3 أيام» … «10 أيام» · «11 يوم». */
export function daysWords(n: number): string {
  if (n === 1) return 'يوم';
  if (n === 2) return 'يومين';
  return n <= 10 ? `${n} أيام` : `${n} يوم`;
}

/** «ساعة» · «ساعتين» · «3 ساعات» … «10 ساعات» · «11 ساعة». */
export function hoursWords(n: number): string {
  if (n === 1) return 'ساعة';
  if (n === 2) return 'ساعتين';
  return n <= 10 ? `${n} ساعات` : `${n} ساعة`;
}

/** «أقل من دقيقة» · «دقيقة» · «دقيقتين» · «3 دقائق» … «10 دقائق» · «11 دقيقة». */
export function minutesWords(n: number): string {
  if (n < 1) return 'أقل من دقيقة';
  if (n === 1) return 'دقيقة';
  if (n === 2) return 'دقيقتين';
  return n <= 10 ? `${n} دقائق` : `${n} دقيقة`;
}

/** «طلب واحد» · «طلبين» · «3 طلبات» … «10 طلبات» · «11 طلب». */
export function ordersWords(n: number): string {
  if (n === 1) return 'طلب واحد';
  if (n === 2) return 'طلبين';
  return n <= 10 ? `${n} طلبات` : `${n} طلب`;
}

/** An age in words, wall clock: under an hour, hours up to a day, then whole days. */
export function ageWords(ms: number): string {
  if (ms < HOUR_MS) return 'أقل من ساعة';
  if (ms < DAY_MS) return hoursWords(Math.floor(ms / HOUR_MS));
  return daysWords(Math.floor(ms / DAY_MS));
}

/** A whole percentage with its base beside it — a base of zero has no percentage. */
export function percentOf(part: number, base: number): number | null {
  return base > 0 ? Math.round((part / base) * 100) : null;
}

// ───────────────────────── the reading ─────────────────────────

/**
 * THE RULES OF THE SENTENCE — every threshold is a named constant, written as a whole percentage and compared by multiplication
 * (`a * 100 < b * PERCENT`), so a boundary is an integer and never a rounding. A FIRST READING: they are the owner's to move, and
 * moving one changes a sentence, never a number. Each says why it sits where it does.
 */

/**
 * Under this many entries, a share of them is noise: three pulls and one exit is not a pile. The pile rules want this many ENTERED;
 * the draining rule wants this many EXITED; below both the card says «حركة قليلة» and judges nothing.
 */
export const FLOW_MIN_EVENTS = 30;
/** Exits under 85% of entries: the held pile grew by more than a seventh of what came in — worth a look, not yet an alarm. */
export const PILE_WATCH_EXIT_PERCENT = 85;
/** Exits under 60% of entries: the pile grew by more than two-fifths of what came in — «في تكدّس». */
export const PILE_PROBLEM_EXIT_PERCENT = 60;
/** Exits over 115% of entries (with enough of them): the pile is shrinking — said, because «المحجوز عم بنزل» is the good news the owner is waiting for. */
export const DRAIN_EXIT_PERCENT = 115;
/**
 * Fewer old orders than this are a tail, never a headline: a postponed order keeps its holder until its date, so a few days-old
 * claims are normal. «Old» is MORE than three days, wall clock.
 */
export const OLD_HELD_MIN = 10;
/** At least a tenth of the held pile older than three days. */
export const OLD_WATCH_PERCENT = 10;
/** At least three-tenths of it. */
export const OLD_PROBLEM_PERCENT = 30;
/** Under this many judged pulls the share is noise. */
export const SPEED_MIN_PULLS = 20;
/**
 * Under 80% of pulls attempted within `FAST_MINUTES`: the contact-first rule already stops an agent pulling again while she holds an
 * untouched order, so most pulls should be rung quickly — one in five slower is worth a look.
 */
export const FAST_WATCH_PERCENT = 80;
/** Under half: the pull is working as a hoarding button, not a work queue. */
export const FAST_PROBLEM_PERCENT = 50;
/** Fewer bounced orders than this are chance. */
export const BOUNCE_MIN_ORDERS = 5;
/** At least a tenth of the pulled orders went through two or more agents. */
export const BOUNCE_WATCH_PERCENT = 10;
/** At least a quarter. */
export const BOUNCE_PROBLEM_PERCENT = 25;
/**
 * A window with fewer working minutes than this is a night or a weekend: no pull and no exit then is what a closed office looks like,
 * not a standstill.
 */
export const QUIET_WORK_MINUTES = 30;

export type FlowTone = 'CALM' | 'WATCH' | 'PROBLEM';
export const TONE_ORDER: Record<FlowTone, number> = { CALM: 0, WATCH: 1, PROBLEM: 2 };

export interface FlowReading {
  tone: FlowTone;
  /** The one word for the chip. */
  label: string;
  /** One or two plain sentences, each built from numbers above. */
  sentences: string[];
}

export const TONE_LABEL_AR: Record<FlowTone, string> = { CALM: 'ماشية', WATCH: 'انتباه', PROBLEM: 'مشكلة' };

const worse = (a: FlowTone, b: FlowTone): FlowTone => (TONE_ORDER[b] > TONE_ORDER[a] ? b : a);

/** «سحبوا 312» — and, when somebody took orders another way, how many: never folded into «سحبوا». */
function tookWords(f: HeldFlowFigures): string {
  const others = f.entered.typed + f.entered.onTheLine;
  return others > 0 ? `سحبوا ${f.entered.pulled} وأخدوا ${others} بغير السحب` : `سحبوا ${f.entered.pulled}`;
}

function flowSentence(f: HeldFlowFigures): { tone: FlowTone; text: string } {
  const entered = f.entered.total;
  const exits = f.exits.total;

  // A read that hit its bound cannot judge a ratio: both sides are floors.
  if (f.truncated.ledger || f.truncated.decisions) {
    return {
      tone: 'WATCH',
      text: `الحركة كبيرة والقراءة وصلت حدها — الأرقام حد أدنى: ${tookWords(f)} وطلع من أيديهم ${exits}. اختر مدة أقصر.`,
    };
  }

  if (entered === 0 && exits === 0) {
    if (f.held.total === 0) return { tone: 'CALM', text: 'ما في حركة بهالمدة، ولا في طلبات محجوزة عند الموظفات.' };
    if (f.workMinutes < QUIET_WORK_MINUTES) return { tone: 'CALM', text: 'ما في حركة بهالمدة — وما كان فيها دوام تقريباً.' };
    return { tone: 'PROBLEM', text: `ما تحرّك شي بهالمدة رغم الدوام — وفي ${f.held.total} طلب محجوز عند الموظفات.` };
  }

  const said = `${tookWords(f)} وطلع من أيديهم ${exits}`;
  if (entered >= FLOW_MIN_EVENTS && exits * 100 < entered * PILE_PROBLEM_EXIT_PERCENT) {
    return { tone: 'PROBLEM', text: `في تكدّس: ${said} بس — المحجوز بيزيد.` };
  }
  if (entered >= FLOW_MIN_EVENTS && exits * 100 < entered * PILE_WATCH_EXIT_PERCENT) {
    return { tone: 'WATCH', text: `المحجوز عم يزيد: ${said}.` };
  }
  if (exits >= FLOW_MIN_EVENTS && exits * 100 > entered * DRAIN_EXIT_PERCENT) {
    return { tone: 'CALM', text: `المحجوز عم بنزل: ${said}.` };
  }
  if (entered < FLOW_MIN_EVENTS && exits < FLOW_MIN_EVENTS) return { tone: 'CALM', text: `حركة قليلة: ${said}.` };
  return { tone: 'CALM', text: `الحركة ماشية: ${said}.` };
}

/** The second sentence: the worst of the three findings that are not the flow — or none. */
function findingSentence(f: HeldFlowFigures): { tone: FlowTone; text: string } | null {
  const found: { tone: FlowTone; text: string }[] = [];

  const old = f.held.over3d;
  if (old >= OLD_HELD_MIN && f.held.oldestMs !== null) {
    const tone: FlowTone | null =
      old * 100 >= f.held.total * OLD_PROBLEM_PERCENT ? 'PROBLEM' : old * 100 >= f.held.total * OLD_WATCH_PERCENT ? 'WATCH' : null;
    if (tone) {
      const floor = f.truncated.held ? ' (حد أدنى)' : '';
      found.push({ tone, text: `${ordersWords(old)} محجوز من أكتر من 3 أيام${floor} — أقدمهم من ${ageWords(f.held.oldestMs)}.` });
    }
  }

  const s = f.speed;
  if (s && s.judged >= SPEED_MIN_PULLS) {
    const tone: FlowTone | null =
      s.fast * 100 < s.judged * FAST_PROBLEM_PERCENT ? 'PROBLEM' : s.fast * 100 < s.judged * FAST_WATCH_PERCENT ? 'WATCH' : null;
    if (tone) found.push({ tone, text: `بس ${s.fast} من ${s.judged} سحبة وصلها اتصال خلال ${FAST_MINUTES} دقيقة دوام.` });
  }

  const b = f.bounced;
  if (b.orders >= BOUNCE_MIN_ORDERS) {
    const tone: FlowTone | null =
      b.orders * 100 >= b.of * BOUNCE_PROBLEM_PERCENT ? 'PROBLEM' : b.orders * 100 >= b.of * BOUNCE_WATCH_PERCENT ? 'WATCH' : null;
    if (tone) found.push({ tone, text: `${ordersWords(b.orders)} انسحب من موظفتين أو أكتر — بينتقل بين الأيدي.` });
  }

  // The worst one; the first listed wins a tie.
  let best: { tone: FlowTone; text: string } | null = null;
  for (const item of found) if (!best || TONE_ORDER[item.tone] > TONE_ORDER[best.tone]) best = item;
  return best;
}

/**
 * THE SENTENCE. One or two, from the figures and nothing else: the flow in the window first, then the worst thing the pile, the
 * speed or the ping-pong say. The tone is the worse of the two. Pure: the same figures give the same words.
 */
export function readFlow(f: HeldFlowFigures): FlowReading {
  const flow = flowSentence(f);
  const finding = findingSentence(f);
  const tone = finding ? worse(flow.tone, finding.tone) : flow.tone;
  return { tone, label: TONE_LABEL_AR[tone], sentences: finding ? [flow.text, finding.text] : [flow.text] };
}

/** What the door sends and the screen draws. */
export interface HeldFlow extends HeldFlowFigures {
  window: { key: FlowWindowKey; label: string; start: string; end: string };
  reading: FlowReading;
  rules: { fastMinutes: number };
}
