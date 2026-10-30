import { apiFetch, apiJson } from '@/lib/api-client';
import type { ChangeRequestValue } from '@/components/screens/confirmation/ActionDialogs';
import { answerAfterRaise, type RaisedAnswer } from '@/lib/change-request-after-raise';

/**
 * RAISING ONE OF THE THREE ASKS, FROM WHEREVER THE ORDER IS.
 *
 * Two screens open the same door — the agent's own queue, and the order
 * itself — and the second one is the one that matters after dispatch,
 * because an order she no longer holds is only reachable there.
 *
 * Both do exactly this, and a second copy of it would be the place where
 * «cancellations carry their reason» stops being true on one screen. So the
 * POST and the carry-out that follows it live here, once.
 *
 * WHAT THE CARRY-OUT IS DEPENDS ON THE ASK, and each goes through the door
 * that already does that thing: an edit through the order's own money path,
 * a cancellation through the stand-down door, which releases the reservation
 * in the same transaction, and a postponement through the HOLD door — the
 * order stays confirmed, its goods and waybill stay, it leaves the open
 * trolley and comes back to the shipment list on its day (M6, 28/10).
 *
 * `readyToApply` is the server saying the raiser may also decide it and the
 * parcel is still ours. When it is false the request is in somebody's
 * queue, and this returns having asked — which is the whole of what she can
 * do.
 *
 * AND IT SAYS WHERE THE REQUEST WENT (`answerAfterRaise`). «حتى لما رفعت طلب تعديل ما ظهر بطلبات التعديل»: a request the
 * raiser may also decide is approved on the spot, so it is never in «بانتظار القرار»; when the last step then fails it
 * waits in «بانتظار التطبيق», and the old screens said «أُرسل» or showed a bare error. Now the answer is a sentence that
 * names the tab — carried out, approved and waiting to be carried out (this throws it), or waiting for a decision.
 */
export async function raiseChangeRequest(
  orderId: string,
  value: ChangeRequestValue,
  /**
   * THE VERSION THE SCREEN LOADED THE ORDER AT.
   *
   * The order route refuses every write without it — «expectedVersion is
   * required for order updates» — so a request the raiser could also
   * decide was raised, approved, and then failed at the last step with an
   * English sentence. It was reported as exactly that.
   */
  expectedVersion: number,
  /** Whether the person holds the screen of the requests: it decides whether the sentence points at it. */
  opts: { canOpenQueue?: boolean } = {}
): Promise<RaisedAnswer> {
  const canOpenQueue = opts.canOpenQueue === true;
  /**
   * Each ask carries only what it means. A cancellation names no field and
   * a postponement names no value; sending empty ones would have the server
   * storing «the customer's name, changed to nothing» beside every one.
   */
  const body =
    value.intent === 'EDIT'
      ? { intent: value.intent, reason: value.reason, changes: { [value.field]: { to: value.to } } }
      : value.intent === 'CANCEL'
        ? { intent: value.intent, reason: value.reason, cancelReason: value.cancelReason }
        : {
            intent: value.intent,
            reason: value.reason,
            postponeUntil: new Date(`${value.postponeDate}T10:00:00`).toISOString(),
          };

  const res = await apiJson<{ request: { id: string }; orderStatus?: string; readyToApply?: boolean }>(
    `/api/orders/${orderId}/change-requests`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.readyToApply) {
    return answerAfterRaise({ intent: value.intent, readyToApply: false, orderStatus: res.orderStatus, canOpenQueue });
  }

  /** The last step failed: the request is approved and sits in «بانتظار التطبيق», and that is what the sentence says. */
  const waiting = (why: string | null): never => {
    throw new Error(answerAfterRaise({ intent: value.intent, readyToApply: true, failure: why, orderStatus: res.orderStatus, canOpenQueue }).message);
  };
  const done = (): RaisedAnswer => answerAfterRaise({ intent: value.intent, readyToApply: true, orderStatus: res.orderStatus, canOpenQueue });

  if (value.intent === 'EDIT') {
    try {
      await apiJson(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeRequestId: res.request.id, expectedVersion }),
      });
    } catch (e) {
      return waiting(e instanceof Error ? e.message : null);
    }
    return done();
  }
  const res2 = await apiFetch(value.intent === 'CANCEL' ? '/api/ops/shipments/stand-down' : '/api/ops/shipments/hold', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      value.intent === 'CANCEL'
        ? { orderId, outcome: 'CANCEL', changeRequestId: res.request.id }
        : { orderId, changeRequestId: res.request.id }
    ),
  });
  if (res2.ok) return done();
  const answer = await res2.json().catch(() => ({}));
  /*
   * A PACKED PARCEL needs a person's word that the box was opened, and a
   * helper with no screen cannot ask for it. The request stays APPROVED and
   * waiting, so the press still names it, and «طلبات التعديل» carries it out
   * with the question. Said plainly rather than as a failure of the ask.
   */
  if (answer?.code === 'ATTESTATION_REQUIRED') {
    throw new Error('اعتُمد الطلب وبقي تنفيذه: بوليصة الطرد مطبوعة. افتح «طلبات التعديل» ونفّذه من هناك لتؤكد أن الطرد بين يديك.');
  }
  return waiting(answer?.errorAr || answer?.error || 'تعذر تنفيذ القرار');
}
