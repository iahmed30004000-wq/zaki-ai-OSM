import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { ORDER_ACCESS_STATUS, assertOrderAccess, assertOrderReadable } from '@/lib/rbac';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { CONTACT_METHODS, CONTACT_RESULTS, NO_ANSWER_CLOSE, NO_ANSWER_RESULTS } from '@/lib/confirmation-workflow';
import { logAudit } from '@/lib/audit';
import { NO_ANSWER_LIMIT } from '@/lib/confirmation-workflow';
import { endOrder } from '@/lib/order-cancel';
import { can, authorize } from '@/lib/authorization';
import { ORDER_NOT_FOUND } from '@/lib/order-refusals';
import { mustHoldToWork, NOT_HELD_MESSAGE, returnToThePool, returnsModeOn } from '@/lib/confirmation-queue';
import { logDeskRefusal } from '@/lib/desk-refusals';
import { NO_ANSWER_RETURNED_REASON, markPlanReturnLine } from '@/lib/no-answer-returns';
import { countedRounds, roundsClose, roundsOn, workClock } from '@/lib/no-answer-rounds';
import { roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { callProofOn, callProofReadFailed } from '@/lib/call-proof-switch';
import { assertCallProven, answerCallProofRefusal } from '@/lib/call-proof-guard';
import { callProofState } from '@/lib/call-proof';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';
import { cadenceSince } from '@/lib/no-answer-cadence-switch';
import { cadenceCalOf, cadenceLimit, cadencePress, cadencePressWords } from '@/lib/no-answer-cadence';
import { readConfirmationRule } from '@/lib/confirmation-rule-settings';
import { orderRuleOnce } from '@/lib/order-numbers';
import { MAX_TALK_S } from '@/lib/call-helper/core';

/**
 * GET  /api/orders/[id]/contact-attempts — chronological attempt history
 * POST /api/orders/[id]/contact-attempts — record one attempt (append-only)
 *
 * Server derives: employeeId, employeeRole, attemptNumber, createdAt.
 * Client can NEVER forge: companyId, employeeId, employeeRole, attemptNumber.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId } = await requireContext();
    const access = await assertOrderReadable(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }

    const attempts = await db.orderContactAttempt.findMany({
      where: { orderId: id, companyId },
      orderBy: { attemptNumber: 'asc' },
      include: { employee: { select: { id: true, name: true } } },
    });

    const last = attempts.length ? attempts[attempts.length - 1] : null;
    /*
     * «إثبات المكالمات» — with the switch on, the answer also says what the VIEWER's «لا يرد» is waiting for on this order (`callProof`), computed by the same function
     * the door asks, so the order window never decides the rule: it ticks `unlocksAtMs` against `serverNow`. With it off the answer has no such key.
     */
    // Request Q3b: the wait is the rule in force's seconds (read once, cached), so the order window unlocks when the door would.
    // Request Q4d: THIS ORDER's seconds — the base rule's unless an owner's rule names its store, a product of its lines or its channel (`order-numbers.ts`).
    const proof = (await callProofOn(db, companyId))
      ? {
          callProof: {
            on: true,
            serverNow: Date.now(),
            ...callProofState({ attempts, employeeId: user.id, claimedAt: access.order.claimedAt ?? null, now: new Date(), proofSeconds: (await orderRuleOnce(db, companyId, id, () => readConfirmationRule(db, companyId))()).proofSeconds }),
          },
        }
      : {};
    return NextResponse.json({
      attempts,
      summary: {
        total: attempts.length,
        lastAttempt: last,
        lastEmployee: last?.employee?.name ?? null,
        lastResult: last?.result ?? null,
        nextFollowUpAt: last?.nextFollowUpAt ?? null,
      },
      ...proof,
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

/** The 503's words (request C2): nothing was written, and pressing again in a moment works. */
const PLAN_UNREAD_AR = 'ما قدرنا نقرأ قاعدة المحاولات هلّق، وما انسجّل شي. جرّبي «لا يرد» كمان شوي.';

/** Was the plan's switch unreadable just now? Asked through a try: a route test that mocks the switch module without this export reads «no». */
function planSwitchUnread(companyId: string): boolean {
  try {
    return callProofReadFailed(companyId);
  } catch {
    return false;
  }
}

function parseFollowUpDate(
  v: unknown
): { ok: true; date: Date | null } | { ok: false; error: string; errorAr: string } {
  if (v === undefined || v === null || v === '') return { ok: true, date: null };
  const d = new Date(v as string);
  if (isNaN(d.getTime())) return { ok: false, error: 'Invalid nextFollowUpAt date', errorAr: 'موعد المتابعة غير صالح.' };
  // Server-time check: follow-up must be in the future (1 min tolerance)
  if (d.getTime() < Date.now() - 60_000) return { ok: false, error: 'nextFollowUpAt must be in the future', errorAr: 'موعد المتابعة يجب أن يكون في المستقبل.' };
  return { ok: true, date: d };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, companyId, storeId, country } = await requireContext();

    /**
     * ── THE TELEPHONE HAS ITS OWN PERMISSION NOW ──
     *
     * This door used to open for `orders.edit` OR `orders.claim`, and the
     * `contact_result` action next door rode on `orders.confirm`. Three
     * permissions, none of them about recording what happened on a call —
     * so the owner could not grant or withhold it from «الصلاحيات» at all.
     *
     * `orders.contact_log` is granted on deploy to every role that held
     * any of those three, so nobody loses a door; from then on he unticks
     * per role.
     */
    if (!can(user, 'orders.contact_log')) {
      return NextResponse.json(
        {
          error: 'Forbidden: cannot record contact attempts',
          errorAr: 'لا تملك صلاحية تسجيل نتيجة الاتصال.',
          code: 'CONTACT_LOG_NOT_ALLOWED',
        },
        { status: 403 }
      );
    }

    if (!can(user, 'orders.edit') && !can(user, 'orders.claim')) {
      return NextResponse.json({ error: 'Forbidden: cannot record contact attempts' }, { status: 403 });
    }

    // The call she makes on the order she holds — the work door (order-work-door.ts).
    const access = await assertOrderAccess(id, user, { companyId, storeId }, ORDER_WORK_DOOR);
    if (!access.allowed) {
      return NextResponse.json({ error: 'Order not found or not assigned to you', errorAr: ORDER_NOT_FOUND }, { status: ORDER_ACCESS_STATUS[access.reason] });
    }
    const order = access.order;

    // Edit authority is scope-evaluated (ASSIGNED covers own-assignment);
    // claim holders may record attempts on the claimable queue.
    if (!authorize(user, 'orders.edit', order).allowed && !can(user, 'orders.claim')) {
      return NextResponse.json({ error: 'Forbidden: cannot record contact attempts', errorAr: 'لا تملك صلاحية تسجيل محاولات التواصل.' }, { status: 403 });
    }

    // AN AGENT WORKS ONLY THE ORDER SHE HOLDS (the owner, 1/11): the call she logs is on the order in her hands, as the confirmation
    // door next door asks. Whoever can take or hand out any order (`orders.unlock`, `orders.assign`) logs a call on any order, as before.
    if (mustHoldToWork((permission) => can(user, permission)) && order.claimedById !== user.id) {
      await logDeskRefusal({ companyId, storeId, userId: user.id, orderId: order.id, code: 'NOT_HELD', door: 'contact-attempts' });
      return NextResponse.json({ error: NOT_HELD_MESSAGE, errorAr: NOT_HELD_MESSAGE, code: 'NOT_HELD' }, { status: 403 });
    }

    const body = await req.json();
    const { contactMethod, result, note, nextFollowUpAt, durationSeconds } = body as {
      contactMethod?: string; result?: string; note?: string; nextFollowUpAt?: string;
      /** «كم ثانية» — read only with «إثبات المكالمات» on, and only for a result that is not a «didn't answer» (the server measures those itself). */
      durationSeconds?: unknown;
    };

    // ── Server-side validation (never trust frontend) ──
    if (!contactMethod || !(CONTACT_METHODS as readonly string[]).includes(contactMethod)) {
      return NextResponse.json({ error: 'Invalid contactMethod', errorAr: 'طريقة التواصل غير معروفة. اختر واحدة من القائمة.' }, { status: 400 });
    }
    if (!result || !(CONTACT_RESULTS as readonly string[]).includes(result)) {
      return NextResponse.json({ error: 'Invalid contact result', errorAr: 'نتيجة التواصل غير معروفة. اختر واحدة من القائمة.' }, { status: 400 });
    }
    if (note && note.length > 2000) {
      return NextResponse.json({ error: 'Note too long (max 2000)', errorAr: 'الملاحظة أطول من 2000 حرف. اختصرها.' }, { status: 400 });
    }
    const fu = parseFollowUpDate(nextFollowUpAt);
    if (!fu.ok) return NextResponse.json({ error: fu.error, errorAr: fu.errorAr }, { status: 400 });

    // Attempt number computed server-side; unique(orderId, attemptNumber) backstops races
    const lastAttempt = await db.orderContactAttempt.findFirst({
      where: { orderId: id },
      orderBy: { attemptNumber: 'desc' },
      select: { attemptNumber: true },
    });
    const attemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

    // «نظام الجولات» — the owner's switch, read once (cached) before the transaction. OFF: the rule below is today's, line for line.
    const rounds = await roundsSwitch(db, companyId);
    // «الطلب يرجع للطابور فوراً» — on only with the rounds on as well (their counting is what closes), cached, and OFF on any failure.
    const returnsOn = await returnsModeOn(db, companyId, rounds);

    /*
     * «إثبات المكالمات» (step A of Confirmation Center v2) — the owner's switch, read once (cached) before the transaction; OFF on any failure, and OFF is the rule
     * above and below exactly as it is today: the guard is never asked, `durationSeconds` is neither read nor validated nor written.
     *
     * With it ON, a «didn't answer» (`NO_ANSWER_RESULTS`) is recorded only after a logged «اتصال» press of hers that is at least thirty seconds old (`call-proof.ts`),
     * asked INSIDE the transaction below, as its first statement: a refusal writes nothing — no line, no close, no release. For any other result a typed
     * `durationSeconds` is stored when it is a whole number of seconds (an answered call's talk time, as the phone measured it).
     */
    const proofOn = await callProofOn(db, companyId);
    const guardedClass = (NO_ANSWER_RESULTS as readonly string[]).includes(result!);
    /*
     * REQUEST C2 (18/11), finding #23: A FAILED READ OF THE PLAN'S SWITCH NEVER CLOSES BY THREE. A read that threw is OFF for ten seconds, and OFF here is the old rule —
     * the third «لا يرد» of all time closes the order. A «لا يرد» while the switch cannot be read is refused with 503 before anything is written; she presses again in a
     * moment. Any other result goes on as ever (it closes nothing). A read that WORKED and said off is not this: that is the way back, line for line.
     */
    if (guardedClass && !proofOn && planSwitchUnread(companyId)) {
      return NextResponse.json({ error: PLAN_UNREAD_AR, errorAr: PLAN_UNREAD_AR, code: 'PLAN_SWITCH_UNREAD' }, { status: 503 });
    }
    /*
     * «جدول المحاولات» (step B) — the SAME switch as the proof above (one switch: proof off means cadence off, and then it is not even asked). `cadenceAt` is the moment the switch
     * went on — the floor of every count — or null; `cal` is what the pure plan needs of the world (the country's timezone, rest days and work hours — the SAME builder the desk uses). Null, and every line below is today's, key for key.
     */
    const cadenceAt = proofOn ? await cadenceSince(db, companyId) : null;
    /*
     * REQUEST Q3b (19/11): THE RULE IN FORCE, read ONCE for this press (cached thirty seconds) and only with the switch on — off, nothing new is read and every line below is
     * today's. Its proof seconds go to the guard, its steps, days and clocks into the plan's calendar, its attempts into the answer. The due a line STORED is never rewritten:
     * an edit judges the next press only.
     */
    // REQUEST Q4d (21/11): the rule in force FOR THIS ORDER — the base rule with its own attempts, steps, days and proof seconds when an owner's rule names its store,
    // a product of its current lines or its channel (`order-numbers.ts`). No such rule in the company: it is the base rule itself, and nothing more is read.
    const rule = proofOn ? await orderRuleOnce(db, companyId, id, () => readConfirmationRule(db, companyId))() : null;
    const cal = cadenceAt && rule ? cadenceCalOf(cadenceAt, country, rule) : null;
    let enteredDuration: number | null = null;
    if (proofOn && !guardedClass && durationSeconds !== undefined && durationSeconds !== null && durationSeconds !== '') {
      if (typeof durationSeconds !== 'number' || !Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > MAX_TALK_S) {
        return NextResponse.json({ error: CALL_PROOF_WORDS.invalidDuration, errorAr: CALL_PROOF_WORDS.invalidDuration, code: 'INVALID_DURATION' }, { status: 400 });
      }
      enteredDuration = durationSeconds;
    }

    // ── The 1/2/3 no-answer rule ──
    // The third no-answer closes the order under its OWN reason, in the same
    // transaction as the attempt, and releases the reservation. It is not a
    // customer rejection and must never be reported as one.
    const { attempt, autoClosed, noAnswerCount, announce, returned, cad, pressedAt } = await db.$transaction(async (tx) => {
      // The proof comes BEFORE the first write of this transaction (a refusal is a sentinel answered in the `catch`).
      let measured: number | null = null;
      if (proofOn) {
        measured = (
          await assertCallProven(tx, { companyId, orderId: id, employeeId: user.id, claimedAt: order.claimedAt ?? null, result: result!, door: 'ATTEMPT', proofSeconds: rule?.proofSeconds })
        ).durationSeconds;
      }
      /*
       * THE PLAN, read through THIS transaction right after the guard and BEFORE the line is written (the guard's refusal has already thrown: nothing below runs for it). `pressedAt` is
       * the instant the plan decides with AND the instant the line is stamped with, so the replay of the stored rows can never disagree with this decision, not even by the engine's
       * own clock stamp. The line is written ONCE with its due on it (`OrderContactAttempt` is append-only: no update is ever issued).
       */
      const pressedAt = new Date();
      const cad = cal
        ? cadencePress(
            await tx.orderContactAttempt.findMany({
              where: { orderId: id, companyId },
              // `nextFollowUpAt`: the due each counted line STORED — the plan checks the next press against it (request C2: history keeps its verdicts).
              select: { createdAt: true, result: true, attemptNumber: true, nextFollowUpAt: true },
            }),
            { at: pressedAt, result: result! },
            cal
          )
        : null;
      const created = await tx.orderContactAttempt.create({
        data: {
          // With the switch off the data object carries no new key at all.
          ...(proofOn ? { durationSeconds: guardedClass ? measured : enteredDuration } : {}),
          // With the plan on, a no-answer-class line carries the instant the plan used.
          ...(cad && guardedClass ? { createdAt: pressedAt } : {}),
          companyId,            // from session — never client
          orderId: id,
          employeeId: user.id,  // server-derived — forged employeeId impossible
          employeeRole: user.role,
          attemptNumber,
          contactMethod: contactMethod!,
          result: result!,
          note: note?.trim() || null,
          // With the plan on, the date of a no-answer-class line is the PLAN's: the due when the press counted, nothing when it was early (a date the client sent is still validated above).
          nextFollowUpAt: cad && guardedClass ? (cad.counted ? cad.dueAt : null) : fu.date,
        },
        include: { employee: { select: { id: true, name: true } } },
      });

      /*
       * WITH THE SWITCH ON, THE COUNT IS ROUNDS (`no-answer-rounds.ts`, R2 · R3 · R5): presses within three working hours are
       * one, a press with no «اتصل» before it is not counted, and three rounds on ONE day close nothing. The same function
       * counts «جولة n من 3» on her desk, so the number she reads is the number that closes.
       */
      const roundsNow = !cad && roundsOn(rounds)
        ? countedRounds(
            await tx.orderContactAttempt.findMany({
              where: { orderId: id },
              select: { createdAt: true, result: true, employeeId: true, attemptNumber: true },
            }),
            workClock({
              workHoursStart: country.workHoursStart,
              workHoursEnd: country.workHoursEnd,
              weekendDays: country.weekendDays,
              timezone: country.timezone,
            })
          )
        : null;
      // With the plan on the number is the COUNTED attempts (`no-answer-cadence.ts`) and the close below waits for five over two days; with it off, today's counting, line for line.
      const noAnswers = cad
        ? cad.next.counted.length
        : roundsNow
          ? roundsNow.counted.length
          : await tx.orderContactAttempt.count({
              where: { orderId: id, result: { in: [...NO_ANSWER_RESULTS] } },
            });
      // Three rounds, all on one day: not yet (R3); under the plan, not five counted over two days. OFF this is always false.
      const roundsOnOneDay = cad ? !cad.closes : roundsNow ? !roundsClose(roundsNow) : false;

      const terminal = ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(order.confirmationStatus);
      /*
       * AND THE PARCEL MUST STILL BE OURS TO CANCEL — ASKED OF THE ONE HELPER.
       *
       * This is the one door that cancels an order without a person pressing
       * cancel, so it must not even try to touch a parcel that has entered
       * the shipment: an order with a trolley, a barcode, a printed waybill
       * or a place on the pickup shelf is a person's decision (it needs
       * their word that the box was opened), never a counter's. It could not
       * reach one by coincidence once — shipping needs CONFIRMED and
       * CONFIRMED is in the `terminal` list — and a rule's shadow is not a
       * rule. `endOrder` is the helper every cancel door goes through; this
       * door asks it, in this transaction, only for an order that never left
       * the confirmation desk.
       */
      const neverShipped =
        !order.shippingBatchId &&
        !order.trackingNumber &&
        !order.labelPrintedAt &&
        order.shippingStatus === 'NOT_READY';
      /*
       * ANY of the three, not `NO_ANSWER` alone.
       *
       * The counter above has always counted BUSY too, and the close fired
       * only on `NO_ANSWER` — so an order whose third attempt was busy
       * reached «3/3» and then closed nothing, and sat there with no door
       * out of it. Three calls that never reached anybody is the same
       * evidence whichever way the line failed.
       */
      if (
        (NO_ANSWER_RESULTS as readonly string[]).includes(result!) &&
        noAnswers >= NO_ANSWER_LIMIT &&
        !roundsOnOneDay &&
        !terminal &&
        neverShipped
      ) {
        // Under the plan the close is the plan's own code («خمس»); every other way into this branch (switch off, the rounds) is the rule of three, byte for byte as ever.
        const closeAs = cad ? NO_ANSWER_CLOSE.five : NO_ANSWER_CLOSE.three;
        const closed = await endOrder({
          orderId: id,
          companyId,
          storeId,
          by: { id: user.id, name: user.name, role: user.role },
          door: 'CONTACT_AUTO_CLOSE',
          kind: 'CANCEL',
          endAs: 'CANCELLED',
          reason: closeAs.reason,
          rejectionNote: `إغلاق تلقائي بعد ${noAnswers} محاولات بلا رد`,
          data: { followUpStatus: order.nextFollowUpAt ? 'CANCELLED' : order.followUpStatus },
          logNote: closeAs.note,
          noteBody: `أُغلق الطلب تلقائياً بعد ${noAnswers} محاولات اتصال بلا رد.`,
          tx,
        });
        // A refusal (the order moved on in the same instant) leaves the attempt
        // recorded and the order alone; the next attempt asks again.
        //
        // The announcement for System 7 is NOT sent from in here: this transaction
        // has not committed, and a cancellation told to an installed app that is
        // then rolled back is a customer written to about an order that is still open.
        return {
          attempt: created,
          autoClosed: closed.ok,
          noAnswerCount: noAnswers,
          announce: closed.ok ? closed.afterCommit : undefined,
          returned: false,
          cad,
          pressedAt,
        };
      }
      /*
       * «الطلب يرجع للطابور فوراً» — HER «لا يرد» TAKES THE ORDER OUT OF HER HAND (the owner, 9/11). The close above came first: an order the
       * third round closed is not released. Only the HOLDER's press releases — a supervisor logging a call on a colleague's order lets
       * nothing go — and only a result that reached nobody; a press of «اتصل» or a sent message is activity, not an answer. It is one
       * more write in THIS transaction (`returnToThePool`: conditional, so a transfer or a shipment in the same instant wins), and
       * her twins held for her stay held for her. The order is ready again three working hours after this attempt (`no-answer-returns.ts`).
       */
      const returned =
        returnsOn &&
        order.claimedById === user.id &&
        (NO_ANSWER_RESULTS as readonly string[]).includes(result!) &&
        // Under the plan only a COUNTED press releases: an early one is kept and told, and leaves the order where it was.
        (!cad || cad.counted) &&
        (await returnToThePool(tx, { companyId, orderId: id, holderId: user.id, reason: NO_ANSWER_RETURNED_REASON }));
      /*
       * THE LINE WEARS THE WORD OF THE RULE THAT WROTE IT (the planner 15/11 22:30, ruling 28). With the plan deciding this press (`cad`), the line just written is stamped
       * `{ "rule": "plan" }` in its metadata, in this same transaction; the older doors (`cad` null) write nothing new, so their line reads the older word forever.
       */
      if (returned && cad) await markPlanReturnLine(tx, { companyId, orderId: id, holderId: user.id });
      return { attempt: created, autoClosed: false, noAnswerCount: noAnswers, announce: undefined, returned, cad, pressedAt };
    });
    // The transaction has committed: only now does anybody hear the order closed.
    await announce?.();

    await logAudit({
      companyId, userId: user.id, action: 'CONTACT_ATTEMPT_RECORDED',
      entity: 'Order', entityId: id,
      newData: {
        attemptNumber,
        contactMethod,
        result,
        // What was STORED: under the plan the due (or null for an early press), never the client's date.
        nextFollowUpAt: cad && guardedClass ? attempt.nextFollowUpAt ?? null : fu.date,
        ...(proofOn ? { durationSeconds: attempt.durationSeconds ?? null } : {}),
        ...(cad && guardedClass ? { cadence: { attempt: cad.next.counted.length, counted: cad.counted, dueAt: cad.next.dueAt?.toISOString() ?? null } } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      attempt,
      noAnswerCount,
      noAnswerLimit: cal ? cadenceLimit(cal.rule) : NO_ANSWER_LIMIT,
      autoClosed,
      // Said only when it happened (the mode is off otherwise, and the answer is what it always was): the order is out of her hand.
      ...(returned ? { returnedToQueue: true } : {}),
      // The plan's own answer, only for a no-answer-class line with the switch on: where she stands, whether it counted, when the next counts, and the words the desk prints.
      ...(cad && guardedClass
        ? {
            cadence: {
              attempt: cad.next.counted.length,
              of: cadenceLimit(cal!.rule),
              counted: cad.counted,
              dueAt: cad.next.dueAt?.toISOString() ?? null,
              words: cadencePressWords({
                counted: cad.counted,
                closed: autoClosed,
                released: !!returned,
                attempt: cad.next.counted.length,
                dueAt: cad.next.dueAt,
                now: pressedAt,
                timeZone: country.timezone,
                limit: cadenceLimit(cal!.rule),
              }),
            },
          }
        : {}),
    });
  } catch (error: any) {
    // A «لا يرد» the proof refused: a sentinel thrown inside the transaction (nothing was written), answered as a 409 she can act on.
    const refused = await answerCallProofRefusal(error);
    if (refused) return refused;
    return apiErrorResponse(error);
  }
}
