import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { customerRiskMany } from '@/lib/customer-risk';
import { mayReadInsights } from '@/lib/insights-key';
import { CLAIM_CAPS, POSTPONE_LEAD_DAYS } from '@/lib/confirmation-queue';
import { deriveCoreState, type StateSource } from '@/lib/order-state';
import { NO_ANSWER_LIMIT , NO_ANSWER_RESULTS } from '@/lib/confirmation-workflow';
import { firstActionTimes } from '@/lib/response-clock';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { endOfLocalDay, localDayKey, startOfLocalDay } from '@/lib/local-day';
import { readPage } from '@/lib/numeric-input';
import { typed } from '@/lib/text-search';
import { ruleFor } from '@/lib/phone-rules';
import { DESK_NOT_FOUND, DESK_WATCH_REFUSAL, mayWatchDesks, watchedAgent } from '@/lib/desk-watch';
import type { BusinessCalendar } from '@/lib/business-calendar';
import { countedRounds, roundsOn, workClock, type AttemptFact, type WorkClock } from '@/lib/no-answer-rounds';
import { roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { deskTab, dueContext, dueLabel, dueSentence, dueVerdict, oldestFirst, summariseDue, verdictFromCount, type DueVerdict } from '@/lib/work-first';
import { companySendsFor } from '@/lib/whatsapp/after-no-answer';
import { waNumber } from '@/lib/message-templates';
import { deskCallKey } from '@/lib/call-helper/desk';
import { deskCallIntent } from '@/lib/call-helper/core';

/**
 * GET /api/confirmation/mine — the agent's own desk, in THREE groups.
 *
 * It was two: everything workable in one list, and the last hundred she
 * ever confirmed under it. Both halves had the same fault — they mixed
 * things she must act on with things she must not.
 *
 * ── «اتصلي هلّق» AND «بانتظار» ARE DIFFERENT WORK (they were «للشغل» and «لا يرد», decided by a count) ──
 *
 * An order she owes a call on right now is one list; an order that did not answer and is not due to be rung again yet is
 * the other. The split used to be BY COUNT alone, so a returned «لا يرد» she had just pulled landed under «لا يرد», «للشغل»
 * said 0, and she pulled another (the owner, 8/11: 479 of 489 orders in one tab). Now ONE verdict decides it — the same
 * one the pull's refusal asks (`work-first.ts`, «الشغل أول»): due now → «اتصلي هلّق»; in the no-answer cycle and not due →
 * «بانتظار» (each row carries `dueAt`, when it is due); and what the verdict leaves open — an order whose last call reached
 * the customer and that needs a decision — goes where its count always put it.
 *
 * The response also carries `due` (how many are owed, the oldest, and the banner's sentence) and each row's `dueNow`,
 * `dueReason`, `dueAt` and `dueWords` — the line the card prints («جديد — سحبتيه هلّق», «جاهز الساعة 14:00»…). The words are
 * written here, once, so the screen ships no wording logic (its first-load JavaScript is held under a ceiling).
 *
 * ── AND «أكّدتها» IS A SEARCH, NOT A FEED ──
 *
 * `take: 100` by `confirmedAt desc` is the last hundred of her career. The
 * agent who confirmed a thousand orders cannot reach the one from Tuesday
 * — and «اليوم» is the only question she actually asks of this list, so
 * today is the default and the rest is a day, a search and pages of 25.
 *
 * Every number — the risk tier, the attempt counter, the page count — is
 * computed here. The screen renders and sends; it never decides.
 */

/** «أكّدتها» — one page, so a thousand confirmations are reachable. */
const CONFIRMED_PAGE_SIZE = 25;

/** On her desk right now. */
const WORKABLE = ['NEW', 'IN_PROGRESS', 'NO_ANSWER'];
/** Waiting on a date — hers, but not today's work until the date arrives. */
const WAITING = ['FOLLOW_UP_REQUIRED', 'POSTPONED'];

const ORDER_SELECT = {
  id: true, orderNumber: true, merchantRef: true, createdAt: true, confirmedAt: true, version: true,
  // When she pulled it — the moment the response clock starts.
  claimedAt: true,
  confirmationStatus: true, shippingStatus: true, totalAmount: true, currency: true,
  postponedUntil: true, postponePreferredTime: true, postponeCount: true,
  nextFollowUpAt: true, followUpReason: true, discountAmount: true,
  /*
   * WHERE THE ORDER CAME FROM — four fields, because it takes four.
   *
   * The card never said. And «إدخال إشكال» only accepts an order a
   * MODERATOR entered (`moderatorId`): a store order — a landing page,
   * Telegram, the POS — is refused with «لا يمكن فتح إشكال إدخال على طلب
   * من مصدر خارجي», which the agent learns only after pressing it. A
   * button that exists in order to refuse is a button that teaches nothing
   * the first four times.
   *
   * `source` and `channel` name the door, `moderator` and `createdBy` name
   * the person — and the screen reads them together, because «يدوي» from a
   * moderator and «يدوي» from a supervisor are different sentences.
   */
  source: true,
  moderatorId: true,
  moderator: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  channel: { select: { id: true, name: true } },
  // The street THIS order goes to, when the visitor typed one other than the customer row's — shown before it.
  deliveryAddress: true,
  // The governorate the fee table was read from, and the customer note the row prints in one line. Display only.
  // `internalNotes` is deliberately NOT read: the system writes into it as well (Telegram ids, win-back discounts, import file names) and no key guards it.
  // `regionId` too: the card asks «does this order HAVE a governorate» of the id, never of the free-text city — the confirm button waits on it.
  regionId: true,
  region: { select: { name: true } },
  customerNotes: true,
  customer: { select: { id: true, fullName: true, phone: true, rawPhone: true, city: true, address: true, totalOrders: true } },
  items: { select: { id: true, productName: true, quantity: true, freeQuantity: true, lineTotal: true, reservedQty: true } },
  // What the customer added on the thank-you screen. The total on the card already carries it, so a card that
  // listed only the lines read as a total that does not add up — and the agent on the phone read the wrong goods.
  addOns: { select: { id: true, productName: true, quantity: true, total: true } },
  _count: { select: { contactAttempts: true, notes: true } },
} as const;

/*
 * WHERE EACH CONFIRMED ORDER IS, for the one button of the «أكّدتها» tab: a holder of `orders.edit_confirmed` changes her own order
 * herself until it enters a batch (2/11), and the row says «تعديل» instead of «طلب تعديل» only for the orders where that is true.
 * Read for that tab alone, display only — the server decides again when she presses it.
 */
const WHERE_IT_IS = {
  claimedById: true,
  shippingBatchId: true,
  // The trolley's status: on one still being filled nothing is asked of the order at all (the owner's ruling 4/11), and the
  // row says so instead of offering «طلب تعديل». Optional to the screen — an older response simply lacks it.
  shippingBatch: { select: { status: true } },
  shippedAt: true,
  labelPrintedAt: true,
} as const;

/** No-answer attempts logged so far — drives the 1/2/3 counter in the UI. */
async function noAnswerCounts(orderIds: string[]) {
  if (orderIds.length === 0) return new Map<string, number>();
  const rows = await db.orderContactAttempt.groupBy({
    by: ['orderId'],
    where: { orderId: { in: orderIds }, result: { in: [...NO_ANSWER_RESULTS] } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.orderId, r._count._all]));
}

/**
 * «نظام الجولات» ON: every attempt of the desk's orders, grouped by order — ONE read, whatever the number of orders. The
 * counter and the «due now» verdict are both made from it, so the number on a card and the tab it sits in cannot disagree.
 */
async function attemptsByOrder(orderIds: string[]) {
  const byOrder = new Map<string, AttemptFact[]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await db.orderContactAttempt.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, createdAt: true, result: true, employeeId: true, attemptNumber: true },
  });
  for (const row of rows) {
    const list = byOrder.get(row.orderId);
    if (list) list.push(row);
    else byOrder.set(row.orderId, [row]);
  }
  return byOrder;
}

/**
 * The counter is the ROUND, from the same function the close reads (`countedRounds`), so «جولة n من 3» on the card is the
 * number that closes the order. One working clock for the whole desk.
 */
function roundCounts(byOrder: Map<string, AttemptFact[]>, clock: WorkClock) {
  return new Map([...byOrder].map(([orderId, list]) => [orderId, countedRounds(list, clock).counted.length]));
}

export async function GET(request: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const params = new URL(request.url).searchParams;

    /*
     * ── «شاشة موظفة»: WHOSE DESK ──
     *
     * Without `?agent=` this is her own desk, asked of `confirmation.work`
     * exactly as before. With it, the viewer reads a colleague's desk — and
     * only with the watching keys (desk-watch.ts), only a colleague of this
     * company and this store (404 otherwise), and only for reading: this door
     * has no write verb, and no door that writes reads `agent`.
     */
    const agentAsked = (params.get('agent') ?? '').trim();
    let deskOf = user.id;
    let viewing: { id: string; name: string; readOnly: true } | null = null;
    if (agentAsked && agentAsked !== user.id) {
      if (!mayWatchDesks(user)) {
        return NextResponse.json({ error: 'Forbidden: cannot watch another desk', errorAr: DESK_WATCH_REFUSAL }, { status: 403 });
      }
      const agent = await watchedAgent(companyId, storeId, agentAsked);
      if (!agent) return NextResponse.json({ error: 'Not found', errorAr: DESK_NOT_FOUND }, { status: 404 });
      deskOf = agent.id;
      viewing = { ...agent, readOnly: true };
    } else {
      await requirePermission('confirmation.work');
    }

    const scope = { companyId, storeId, claimedById: deskOf };
    const now = new Date();

    /*
     * ── WHAT «أكّدتها» IS ASKING ──
     *
     * A day, a search and a page — all three read here and all three
     * answered by the database, because a page of 25 drawn out of a
     * hundred rows the server already cut is not paging, it is the same
     * hundred rows with 75 of them hidden.
     *
     * A day that is not `yyyy-MM-dd` falls back to today rather than
     * refusing: the one thing this list must never do is come back empty
     * because a query string was mistyped.
     */
    const dayAsked = params.get('day') ?? '';
    const dayStart = startOfLocalDay(dayAsked);
    const dayEnd = endOfLocalDay(dayAsked);
    const day = dayStart && dayEnd ? dayAsked : localDayKey(now);
    const from = dayStart ?? startOfLocalDay(day)!;
    const to = dayEnd ?? endOfLocalDay(day)!;
    const q = (params.get('q') ?? '').trim().slice(0, 60);
    // The shared reader, so `?page=abc` and `?page=1e400` fall to page one
    // here exactly as they do on every other paged door.
    const page = readPage(params);

    /*
     * The search runs on the ORDER NUMBER, the NAME and the PHONE, which is
     * the three things a customer on the line can read out. The phone is
     * matched on its digits: `rawPhone` holds what was typed and `phone`
     * the normalised form, and she knows neither — she knows what he said.
     */
    const digits = q.replace(/\D/g, '');
    const search = q
      ? {
          OR: [
            { orderNumber: typed(q) },
            { customer: { fullName: typed(q) } },
            ...(digits
              ? [{ customer: { rawPhone: typed(digits) } }, { customer: { phone: typed(digits) } }]
              : []),
          ],
        }
      : {};

    /*
     * ── AND WHAT THE THIRD NO-ANSWER LEFT BEHIND ──
     *
     * The close writes `CANCELLED` + `NO_ANSWER_3_ATTEMPTS` and leaves the
     * order claimed by her, so it would otherwise vanish from every list
     * on this screen — she rings, the card disappears, and nothing says it
     * closed. Today's are shown, read-only, at the bottom of «لا يرد».
     *
     * Found through the status log and not `updatedAt`: `updatedAt` moves
     * with any later write, so a note added tomorrow would make a Tuesday
     * closure look like today's. The log entry is the moment it happened.
     */
    const closedScope = {
      ...scope,
      confirmationStatus: 'CANCELLED',
      rejectionReason: 'NO_ANSWER_3_ATTEMPTS',
      statusLogs: {
        some: { note: 'AUTO_CLOSE_NO_ANSWER_3_ATTEMPTS', createdAt: { gte: startOfLocalDay(localDayKey(now))! } },
      },
    };

    const [inConfirmation, closedToday, confirmed, confirmedTotal] = await Promise.all([
      db.order.findMany({
        where: {
          ...scope,
          OR: [
            { confirmationStatus: { in: WORKABLE } },
            // A postponed order leaves her list and comes back by itself on
            // the day it is due. Leaving it there all week buries the three
            // orders she can actually do something about today; taking it
            // away for good would lose it.
            {
              confirmationStatus: { in: WAITING },
              OR: [
                { postponedUntil: { lte: now } },
                { AND: [{ postponedUntil: null }, { nextFollowUpAt: { lte: now } }] },
                { AND: [{ postponedUntil: null }, { nextFollowUpAt: null }] },
              ],
            },
          ],
        },
        /*
         * ── EVERY ORDER IN HER HANDS REACHES HER DESK (5/11, سلوى) ──
         *
         * This read was `take: 200` by `nextFollowUpAt asc`, and Postgres puts a NULL last in an ascending sort. An order
         * nobody has rung yet has no follow-up date, so with 200 no-answers in her hands every fresh pull was the row cut
         * off: «للشغل (0)» while the pull refused her «سجّل محاولة على ORD-…» about an order on no card of hers — held,
         * unreachable, and gone with the ninety-minute release under her own name. Now the undated come FIRST (they are
         * the calls), and the page holds the whole cap: nothing she may hold is ever past the end of it.
         */
        orderBy: [{ nextFollowUpAt: { sort: 'asc', nulls: 'first' } }, { claimedAt: 'asc' }],
        take: CLAIM_CAPS.total,
        select: ORDER_SELECT,
      }),
      db.order.findMany({
        where: closedScope,
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: ORDER_SELECT,
      }),
      db.order.findMany({
        where: { ...scope, confirmationStatus: 'CONFIRMED', confirmedAt: { gte: from, lte: to }, ...search },
        orderBy: { confirmedAt: 'desc' },
        skip: (page - 1) * CONFIRMED_PAGE_SIZE,
        take: CONFIRMED_PAGE_SIZE,
        select: { ...ORDER_SELECT, changeRequests: { where: { status: 'PENDING' }, select: { id: true, createdAt: true } }, ...WHERE_IT_IS },
      }),
      db.order.count({
        where: { ...scope, confirmationStatus: 'CONFIRMED', confirmedAt: { gte: from, lte: to }, ...search },
      }),
    ]);

    // Risk is per customer, company-wide — one lookup per distinct customer.
    // Both lists that go through `decorate`, so the one function never
    // returns a risk tier for some rows and null for others.
    const customerIds = [...new Set([...inConfirmation, ...closedToday].map((o) => o.customer.id))];
    // The return-risk tier is a smart card (PR-10): `null` without `insights.view`, which the screen already draws as no chip
    // (a customer with no history has no tier either) — and the lookups are not made.
    // ONE GROUPED LOOKUP, NOT ONE PER CUSTOMER (the owner's ruling 4/11): a `Promise.all` of `customerRisk` sent up to
    // ~750 queries at once into a pool of ten and the agent's next navigation waited for a connection until P2024.
    // `customerRiskMany` gives every id the very figure `customerRisk` would have, in three queries whatever the count.
    const risks = mayReadInsights(user) ? await customerRiskMany(db, companyId, customerIds) : null;
    const riskByCustomer = new Map(customerIds.map((id) => [id, risks?.get(id) ?? null]));
    // «نظام الجولات» — OFF (the default), the count is every no-answer, as it always was.
    const roundsSw = await roundsSwitch(db, companyId);
    const rounds = roundsOn(roundsSw);
    // «واتساب بعد لا يرد» from the company's number for this country (`after-no-answer.ts`) — only on her own desk, the one with the sheet,
    // and only for whoever holds `whatsapp.send`: the send door asks it, and a button that answers 403 is not offered.
    const fromCompany =
      !viewing && (await companySendsFor(db, companyId, ruleFor(country.code)?.dialCode ?? null)) && can(user, 'whatsapp.send');
    /*
     * «مساعد الاتصال» — HER PAIRED PHONE SIGNS THE CALL LINKS (contract v1.1). Only on her own desk, and only when she has
     * an active device: one indexed lookup, nothing more without one. The number signed is exactly what the WhatsApp button
     * builds (`waNumber` with this desk's calling code), so the app dials the number the strip shows. Absent = today's `tel:`.
     */
    const callKey = viewing ? null : await deskCallKey(companyId, user.id);
    const deskDialCode = ruleFor(country.code)?.dialCode ?? null;
    const helperLink = (o: { id: string; customer: { rawPhone: string | null } }) => {
      if (!callKey) return {};
      const link = deskCallIntent(callKey, o.id, waNumber(o.customer.rawPhone ?? '', deskDialCode), now.getTime());
      return link ? { callHelperLink: link } : {};
    };
    // The working calendar is placed once for the whole desk — only with the switch on, the only time anything below asks it.
    const cal: BusinessCalendar = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };
    const clock = rounds ? workClock(cal) : null;
    const shownIds = [...inConfirmation, ...closedToday].map((o) => o.id);
    const attempts = rounds && clock ? await attemptsByOrder(shownIds) : null;
    const noAnswer = attempts && clock ? roundCounts(attempts, clock) : await noAnswerCounts(shownIds);

    /*
     * ── «الشغل أول»: ONE VERDICT PER HELD ORDER ──
     *
     * Is a call owed on it right now? The very function the pull's refusal asks (`work-first.ts`), so the tab an order sits in,
     * the banner's count and the pull's «اسحب طلب جديد — خلّصي اللي فوق أول» can never disagree. Evaluated once per order,
     * from the attempts already read above — no query per order. With the switch off the attempts are not read at all: the only
     * case there is, an order nobody has tried to reach, is told from the count the row already carries.
     */
    const dueCtx = attempts && clock ? dueContext({ now, cal, rounds: roundsSw, clock }) : null;
    const verdictOf = new Map<string, DueVerdict>(
      inConfirmation.map((o) => [
        o.id,
        attempts && dueCtx
          ? dueVerdict(
              { claimedAt: o.claimedAt, claimedById: deskOf, postponedUntil: o.postponedUntil, nextFollowUpAt: o.nextFollowUpAt },
              attempts.get(o.id) ?? [],
              dueCtx
            )
          : verdictFromCount(o._count?.contactAttempts ?? 1),
      ])
    );

    // The response clock: how long each order has been waiting on her.
    // "How long since I took anything new" is the header chip's question,
    // answered once there rather than twice.
    const firstAction = await firstActionTimes([...inConfirmation, ...closedToday].map((o) => o.id));
    const waitingLater = await db.order.count({
      where: { ...scope, confirmationStatus: { in: WAITING }, postponedUntil: { gt: now } },
    });

    // Contact details left the building; the tally is the person's, not
    // this screen's. See noteCustomersHandedOut.
    await noteCustomersHandedOut({ companyId, storeId, user, where: viewing ? 'شاشة موظفة' : 'طلباتي', rows: [...inConfirmation, ...closedToday, ...confirmed] });

    /*
     * ── THE SPLIT ──
     *
     * One pass over the rows she holds, decided by the verdict above (`deskTab`: due → «اتصلي هلّق», waiting → «بانتظار», and
     * what the verdict leaves open by the count the row already carries). Done here and not in the browser for the reason
     * every other number on this screen is: two places that each decide
     * which tab an order belongs in eventually disagree, and the tab
     * headings would then count differently from the lists under them.
     */
    const decorate = (o: (typeof inConfirmation)[number]) => ({
      ...o,
      state: deriveCoreState(o as unknown as StateSource),
      previousOrders: Math.max(0, (o.customer.totalOrders ?? 1) - 1),
      risk: riskByCustomer.get(o.customer.id) ?? null,
      noAnswerCount: noAnswer.get(o.id) ?? 0,
      firstActionAt: firstAction.get(o.id) ?? null,
    });
    // Only the rows she rings from carry the helper's link; «أكّدتها» and today's closed ones are not called from here.
    const held = inConfirmation.map((o) => {
      const verdict = verdictOf.get(o.id)!;
      const row = decorate(o);
      return {
        ...row,
        ...helperLink(o),
        // «الشغل أول»: a call is owed on it right now, why — and, for one that is waiting, when it falls due.
        dueNow: verdict.due,
        dueReason: verdict.reason,
        dueAt: verdict.dueAt ? verdict.dueAt.toISOString() : null,
        // …and the line the card prints about it, on the store's clock (null when it has nothing to say).
        dueWords: dueLabel(verdict, { rounds: row.noAnswerCount, limit: NO_ANSWER_LIMIT, now, timeZone: country.timezone }),
      };
    });
    const owedSummary = summariseDue(held.map((o) => ({ id: o.id, orderNumber: o.orderNumber, claimedAt: o.claimedAt, due: o.dueNow })));
    const tabOf = (o: (typeof held)[number]) => deskTab(verdictOf.get(o.id)!, o.noAnswerCount);
    /** The calls she owes first, the one that has waited longest at the top — what the pull button opens. With the switch off the query's own order stays. */
    const dueFirst = (a: (typeof held)[number], b: (typeof held)[number]) => Number(b.dueNow) - Number(a.dueNow) || oldestFirst(a, b);

    return NextResponse.json({
      // Whose desk this is, when it is not the reader's own — the screen draws it read-only. Absent on her own desk.
      ...(viewing ? { viewing } : {}),
      leadDays: POSTPONE_LEAD_DAYS,
      // The country's calling code — the rows carry a local number («09…») and WhatsApp needs it in full.
      dialCode: ruleFor(country.code)?.dialCode ?? null,
      // The sheet offers «ابعت من رقم الشركة» for this country: COMPANY, a template, and the number connected. Absent otherwise —
      // the agent's own WhatsApp, as it always was.
      ...(fromCompany ? { whatsappRoute: 'COMPANY' as const } : {}),
      /** Postponed to a later day — off her desk, not gone. */
      waitingLater,
      noAnswerLimit: NO_ANSWER_LIMIT,
      // «نظام الجولات» is on: the counter is «جولة n من 3». Absent when it is off.
      ...(rounds ? { rounds: true } : {}),
      // The server's own clock, so a wrong clock on her machine cannot make
      // an order look answered or overdue.
      serverNow: new Date().toISOString(),
      /**
       * «الشغل أول» — how many calls she owes right now, and the oldest of them: the banner says it and the pull button opens
       * it. Counted from the same verdicts as the tab below, so the number and the list cannot differ.
       */
      due: { ...owedSummary, sentence: owedSummary.count > 0 ? dueSentence(owedSummary.count) : null },
      /** «اتصلي هلّق» — a call is owed on it right now (a new pull, a «لا يرد» whose round came, a date that arrived), and the orders that need a decision. */
      work: held.filter((o) => tabOf(o) === 'work').sort(rounds ? dueFirst : () => 0),
      /**
       * «بانتظار» — it did not answer and it is not due to be rung again yet; each row says when (`dueAt`).
       *
       * AND AN ORDER STILL OPEN PAST THE LIMIT STAYS HERE. `held` is open orders only (the closed ones are `closedToday`), so
       * a count of three or more on an open order is one the close did not take: «نظام الجولات» (three rounds on one day, or
       * presses left behind when the owner turned it off again) or a close the helper refused. Dropped from both tabs it would
       * be in her hands, counted toward her cap, and on no list she can see.
       */
      noAnswer: held.filter((o) => tabOf(o) === 'noAnswer'),
      /** Closed by the third no-answer today — read-only, so it is not a surprise tomorrow. */
      closedToday: closedToday.map(decorate),
      /** «أكّدتها» — a day, a search, a page, and the size of what is behind them. */
      confirmed: {
        day,
        q,
        page,
        pageSize: CONFIRMED_PAGE_SIZE,
        total: confirmedTotal,
        pages: Math.max(1, Math.ceil(confirmedTotal / CONFIRMED_PAGE_SIZE)),
        rows: confirmed.map((o) => ({
          ...o,
          state: deriveCoreState(o as unknown as StateSource),
          previousOrders: Math.max(0, (o.customer.totalOrders ?? 1) - 1),
          noAnswerCount: 0,
        })),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
