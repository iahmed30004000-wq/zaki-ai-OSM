import { apiJson } from '@/lib/api-client';
import type { ChangeableField } from '@/lib/change-request-fields';
import { answerAfterRaise } from '@/lib/change-request-after-raise';

/**
 * AN EDIT ON A CONFIRMED ORDER, AS A REQUEST — ALL ITS FIELDS AT ONCE.
 *
 * `raiseChangeRequest` next door carries ONE field, because the three
 * dialogs it serves ask about one thing each («الكمية», «السعر»…). The
 * cards in the order window are a FORM: a person fixes a name and a street
 * in the same save, and splitting that into two requests would put two
 * rows in «طلبات التعديل» that a supervisor has to approve separately —
 * one of which can be approved and the other refused, leaving the order in
 * a state nobody asked for.
 *
 * So this is the same door with the whole diff in one `changes` object,
 * which is exactly what `POST /api/orders/[id]/change-requests` already
 * accepts (a partial record over `CHANGEABLE_FIELDS`).
 *
 * `readyToApply` is the server saying the raiser may also decide it and
 * the parcel is still ours. When it is false the request is in somebody's
 * queue and this returns `applied: false` — which is the whole of what the
 * raiser can do, and what the card says out loud.
 *
 * AND IT RETURNS THE SENTENCE (`message`) that says where the request went — carried out, or waiting for a decision in
 * «بانتظار القرار». When it was approved on the spot and the last step failed it THROWS the sentence that names
 * «بانتظار التطبيق», as it always threw: a card that catches it shows it as the reason the save did not finish, which is
 * now also the place to look.
 */
export async function raiseEditRequest(
  orderId: string,
  changes: Partial<Record<ChangeableField, string | number | null>>,
  reason: string,
  /**
   * The version the screen loaded the order at. The order route refuses
   * every write without it, so a request the raiser could also decide
   * would be raised, approved, and then fail at the last step.
   */
  expectedVersion: number,
  /** Whether the person holds the screen of the requests: it decides whether the sentence points at it. */
  opts: { canOpenQueue?: boolean } = {}
): Promise<{ applied: boolean; requestId: string; message: string }> {
  const canOpenQueue = opts.canOpenQueue === true;
  const res = await apiJson<{ request: { id: string }; orderStatus?: string; readyToApply?: boolean }>(
    `/api/orders/${orderId}/change-requests`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'EDIT',
        reason,
        changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { to: v }])),
      }),
    }
  );

  if (!res.readyToApply) {
    const waiting = answerAfterRaise({ intent: 'EDIT', readyToApply: false, orderStatus: res.orderStatus, canOpenQueue });
    return { applied: false, requestId: res.request.id, message: waiting.message };
  }

  try {
    await apiJson(`/api/orders/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeRequestId: res.request.id, expectedVersion }),
    });
  } catch (e) {
    throw new Error(
      answerAfterRaise({
        intent: 'EDIT',
        readyToApply: true,
        failure: e instanceof Error ? e.message : null,
        orderStatus: res.orderStatus,
        canOpenQueue,
      }).message
    );
  }
  return { applied: true, requestId: res.request.id, message: answerAfterRaise({ intent: 'EDIT', readyToApply: true, canOpenQueue }).message };
}
