import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { DESK_NOT_FOUND, DESK_WATCH_REFUSAL, mayWatchDesks, watchedAgent } from '@/lib/desk-watch';
import {
  OWN_DESK_REFUSAL,
  RETURN_PILE_KEY,
  RETURN_PILE_REFUSAL,
  RETURN_TRANSACTION_OPTIONS,
  pileMessage,
  returnNoAnswerPile,
} from '@/lib/return-no-answer-pile';

/**
 * POST /api/confirmation/desks/[agentId]/return-no-answer — «أرجِع «لا يرد» للطابور».
 *
 * The one press a watcher makes on a colleague's desk (the owner, 8/11: «واذا ساحبيتو رجعهم»): up to 200 of HER «لا يرد» orders
 * go back to the queue, and the answer says how many remain so a second press returns the rest. Which orders, and everything
 * that is written, is `return-no-answer-pile.ts`; this door only decides WHO may.
 *
 * WHO — all of it asked here, never by the screen:
 *   · `mayWatchDesks` (`team.monitor` and every order in sight) — the refusal is the desk door's own sentence;
 *   · AND `orders.unlock`, the key the claim door asks for «سحبه منه». Watching alone returns nothing, and a holder of
 *     `orders.unlock` who may not watch gets the watching refusal;
 *   · the desk is a colleague's: her id is an ACTIVE person of this company who reaches this store (`watchedAgent`, 404
 *     otherwise — an id from another company says nothing about whether it exists), and never the presser's own.
 *
 * THIS DOOR NAMES A DESK, AND ACTS AS NOBODY BUT THE PRESSER. The agent is a filter on whose pile it is: the claim-history line
 * carries the presser's id and name, the notification and the audit row say who pressed, and no write is made «as» her. That is
 * why `no-write-door-acts-as-the-agent.test.ts` lists this file as its one exception, and asserts these facts about it.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    const { user, companyId, storeId } = await requireContext();

    if (!mayWatchDesks(user)) {
      return NextResponse.json({ error: 'Forbidden: cannot watch desks', errorAr: DESK_WATCH_REFUSAL }, { status: 403 });
    }
    if (!can(user, RETURN_PILE_KEY)) {
      return NextResponse.json(
        { error: `Forbidden: missing required permission ${RETURN_PILE_KEY}`, errorAr: RETURN_PILE_REFUSAL },
        { status: 403 }
      );
    }
    // Returning your own desk is not this door's job (her own pile has its own buttons).
    if (agentId === user.id) {
      return NextResponse.json({ error: 'Cannot return your own desk', errorAr: OWN_DESK_REFUSAL, code: 'OWN_DESK' }, { status: 400 });
    }
    const agent = await watchedAgent(companyId, storeId, agentId);
    if (!agent) return NextResponse.json({ error: 'Not found', errorAr: DESK_NOT_FOUND }, { status: 404 });

    const outcome = await db.$transaction(
      (tx) =>
        returnNoAnswerPile(tx, {
          scope: { companyId, storeId },
          agentId: agent.id,
          by: { id: user.id, name: user.name },
        }),
      RETURN_TRANSACTION_OPTIONS
    );

    // One audit row per press — and none for a press that moved nothing.
    if (outcome.returned > 0) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'DESK_NO_ANSWER_RETURNED',
        entity: 'User',
        entityId: agent.id,
        previousData: { holder: agent.name },
        newData: {
          returned: outcome.returned,
          skipped: outcome.skipped,
          remaining: outcome.remaining,
          limit: outcome.limit,
          by: user.name,
        },
      });
    }

    return NextResponse.json({ ...outcome, agent: { id: agent.id, name: agent.name }, message: pileMessage(outcome) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
