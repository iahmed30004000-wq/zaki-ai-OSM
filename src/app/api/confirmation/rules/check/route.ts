import { NextRequest, NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { can, requirePermission } from '@/lib/authorization';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { resolveAudience } from '@/lib/notification-audience';
import {
  CLAIM_CAPS,
  OPEN_CONFIRMATION,
  PULL_PACE,
  capLoad,
  ownedCounts,
  pullPaceRefusal,
  pullRefusal,
  readReturnsMode,
  returnsLimits,
  type PullRefusal,
} from '@/lib/confirmation-queue';
import { roundsSwitch } from '@/lib/no-answer-rounds-switch';
import { workFirstGate } from '@/lib/work-first';
import { deskKeyLabel } from '@/lib/desk-readiness';
import { confirmationRuleOnce } from '@/lib/confirmation-rule-settings';
import { confirmationRulesOnce, employeeNumbers, numbersAnswer } from '@/lib/employee-numbers';
import { numbersInForce } from '@/lib/confirmation-own-rules';

/**
 * GET /api/confirmation/rules/check?userId= — «افحص موظفة»: for ONE person of this store, what the desk would tell her NOW.
 *
 * WHO ASKS: `settings.view` AND `users.view` — the same two keys as «مين مربوطة» (`../people/route.ts`).
 *
 * WHAT IS ANSWERED, for the current store:
 *   · how many orders she holds (in her hands + held for her) against her limit — the mode's hand limit where the mode is on,
 *     the cap of 500 otherwise — and how many of them nobody has rung yet, against that cap;
 *   · her pulls in the pace window against the pace;
 *   · what «اسحب الطلب التالي» would answer her now: its refusal code and its Arabic sentence, or «open»;
 *   · HER numbers (request Q4b, 21/11) — hand limit, idle minutes, pull pace — each with the rule it came from («من القاعدة الأساسية» or «من قاعدة «…»»). The hand and
 *     the pace above are hers too: an owner's rule that names her changes what the pull would tell her, and only her.
 *
 * HOW: from the very read-only pieces the pull asks, in the pull's own order (`pullNextOrder`): her key first (the door's
 * `requirePermission('confirmation.pull')`), then `pullRefusal` (the caps and the untouched order) with the mode's hand,
 * then «الشغل أول» (`workFirstGate`), then the pace (`pullPaceRefusal`). It NEVER calls `pullNextOrder` and writes nothing:
 * no stale-claim release, no returning-customer hold, no intake sweep — so where the pull would first let an untouched order
 * go back to the queue, this answer still counts it (said on the screen).
 *
 * The person is built as her session is (`resolveAudience`: `computeEffectiveGrants` → `can`). No order list, no customer: counts,
 * a code and the pull's own sentence (which may name the order she must ring first by its number, as the pull does).
 */

const CHECKS_PER_WINDOW = 30;
const CHECK_WINDOW_MS = 60_000;
const TOO_MANY = 'طلبات كتير ورا بعض — استنّى دقيقة وجرّب';

/** The reason the pull writes on the history line it hands out (`PULL_NEXT_REASON` in confirmation-queue.ts — pinned by this door's test). */
const PULL_NEXT_REASON = 'PULL_NEXT';

function refuse(status: number, code: string, errorAr: string) {
  return NextResponse.json({ error: errorAr, errorAr, code }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('settings.view');
    await requirePermission('users.view');

    const limit = rateLimit(`desk-check:${user.id}`, CHECKS_PER_WINDOW, CHECK_WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: TOO_MANY, errorAr: TOO_MANY, code: 'RATE_LIMITED' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const userId = request.nextUrl.searchParams.get('userId')?.trim() ?? '';
    if (!userId) return refuse(400, 'USER_REQUIRED', 'اختار موظفة أول');

    const [person] = await resolveAudience({ companyId, storeId, audience: { userIds: [userId] } });
    if (!person) {
      // Why she is not here, in one read: another company's person is «not found» exactly like a person who does not exist.
      const row = await db.user.findFirst({ where: { id: userId, companyId }, select: { status: true } });
      if (!row) return refuse(404, 'USER_NOT_FOUND', 'ما لقينا هالموظفة');
      if (row.status !== 'ACTIVE') return refuse(404, 'USER_INACTIVE', 'هالموظفة موقوفة — ما بتشتغل على المكتب هلّق');
      return refuse(404, 'NOT_IN_STORE', 'هالموظفة ما بتوصل لهالمتجر — اختار المتجر تبعها من فوق');
    }

    const scope = { companyId, storeId };
    const now = new Date();
    const cal = {
      workHoursStart: country.workHoursStart,
      workHoursEnd: country.workHoursEnd,
      weekendDays: country.weekendDays,
      timezone: country.timezone,
    };
    // Read as the pull reads them (cached switches): the rounds, the mode, and the mode's hand — absent, the cap of 500.
    const rounds = await roundsSwitch(db, companyId);
    const rule = confirmationRuleOnce(db, companyId, now.getTime());
    const her = { userId: person.id, storeId, timezone: country.timezone, rules: confirmationRulesOnce(db, companyId, now.getTime()) };
    const returns = await readReturnsMode(db, companyId, { now, calendar: () => cal, rounds, rule });
    // Her numbers (Q4b): the pull's own reading — her hand where the mode is on, her pace always.
    const mine = await employeeNumbers(db, companyId, now.getTime(), await rule(), her);
    const hand = returns ? (await returnsLimits(db, companyId, now.getTime(), rule, her)).handLimit : undefined;
    const perHour = mine.pullPerHour.value;
    // Request Q4c (21/11, the Q4b reviewer's note): whether each of her numbers acts NOW — a rule's hand shown while the switches it rides on are off is not in force.
    const inForce = await numbersInForce(db, companyId, now, cal, rule).catch(() => null);

    const since = new Date(now.getTime() - PULL_PACE.windowMinutes * 60_000);
    const [counts, pulls] = await Promise.all([
      ownedCounts(db, scope, person.id, now),
      db.orderClaimHistory.findMany({
        where: { userId: person.id, action: 'CLAIMED', reason: PULL_NEXT_REASON, createdAt: { gt: since } },
        select: { createdAt: true },
      }),
    ]);
    const pulledAt = pulls.map((p) => p.createdAt);

    let refusal: PullRefusal | { code: 'NO_PULL_KEY'; message: string } | null = null;
    if (!can(person, 'confirmation.pull')) {
      refusal = { code: 'NO_PULL_KEY', message: `ما معها «${deskKeyLabel('confirmation.pull')}» — السحب بيرفضها من أول ضغطة.` };
    } else {
      refusal = hand === undefined ? pullRefusal(counts) : pullRefusal(counts, undefined, hand);
      if (!refusal) {
        refusal = await workFirstGate(db, { scope, userId: person.id, cal, now, rounds, open: OPEN_CONFIRMATION, room: CLAIM_CAPS.total, held: counts.total, returns });
      }
      if (!refusal) refusal = pullPaceRefusal(pulledAt, now, perHour);
    }

    return NextResponse.json({
      person: { id: person.id, name: person.name },
      hold: {
        inHand: counts.total,
        heldForHer: counts.heldForHer ?? 0,
        load: capLoad(counts),
        limit: hand ?? CLAIM_CAPS.total,
        // Whose number the limit is: the mode's hand limit, or the cap of 500.
        limitFrom: hand === undefined ? 'CAP' : 'HAND',
        withoutAttempt: counts.withoutAttempt,
        withoutAttemptLimit: CLAIM_CAPS.withoutAttempt,
      },
      pace: { pulled: pulledAt.length, perHour, windowMinutes: PULL_PACE.windowMinutes },
      // Her three numbers and where each came from (Q4b). The hand acts where the mode is on (`hold.limitFrom` says it); the idle minutes where the plan or «أولوية الطابور» is.
      numbers: { ...numbersAnswer(mine), inForce },
      pull: refusal
        ? { open: false, code: refusal.code, sentence: refusal.message }
        : { open: true, code: null, sentence: 'السحب مفتوح إلها هلّق — بتاخد الطلب التالي إذا في طلب بالطابور.' },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
