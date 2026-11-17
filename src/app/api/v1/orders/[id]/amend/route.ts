import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { amendSystemOrder, asksForAChange, loadOwnOrder, v1AmendSchema } from '@/lib/v1/order-amend';
import { amountString } from '@/lib/v1/shape';

/**
 * POST /api/v1/orders/{id}/amend — «الزبون غيّر الرقم / العنوان / الكمية بالمحادثة».
 *
 * THE HANDLER DOES FOUR THINGS AND DECIDES NONE OF THEM, like the order door beside it: it proves who is calling, proves the order
 * is one THIS system created (a 404 otherwise, before a key is claimed), settles whether the request was already answered, and hands
 * the change to `amendSystemOrder`, which owns every rule (editable, the phone, the blacklist, the catalogue's prices). A replay
 * answers the first call's body and amends nothing twice.
 *
 * The body is parsed first and the field names — never the values — go in a refusal: a customer's phone does not travel into the
 * calling system's error log.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.amend');
    const { id } = await params;

    const raw = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const parsed = v1AmendSchema.safeParse(body);
    if (!parsed.success) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 20),
      });
    }
    if (!asksForAChange(parsed.data)) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'Send at least one of customer, items or notes', {
        fields: ['customer', 'items', 'notes'],
      });
    }

    // Proved to be this system's order BEFORE the key is claimed: a 404 must not burn a key the caller will reuse with the right id.
    const order = await loadOwnOrder(caller, id);

    const key = idempotencyKeyOf(req);
    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    const result = await amendSystemOrder(caller, order, parsed.data);

    const answer = {
      order_id: result.orderId,
      order_number: result.orderNumber,
      status: result.status,
      // Our figures, always. `price_adjusted` says whether they differ from the subtotal the customer was quoted, if one was sent.
      price_adjusted: result.priceAdjusted,
      totals: {
        subtotal: amountString(result.totals.subtotal, result.minorUnit),
        discount: amountString(result.totals.discount, result.minorUnit),
        delivery_fee: amountString(result.totals.deliveryFee, result.minorUnit),
        total: amountString(result.totals.total, result.minorUnit),
        currency: result.currency,
      },
    };

    await rememberIdempotency(caller.companyId, key, 200, answer);
    claimed = null;
    return v1Ok(requestId, answer, 200);
  } catch (error) {
    // A refused or failed attempt gives the key back (a 409 NOT_EDITABLE is a fact about the order, and a retry meets it afresh).
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
