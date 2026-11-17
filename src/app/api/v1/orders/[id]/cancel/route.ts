import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { cancelSystemOrder, loadOwnOrder, v1CancelSchema } from '@/lib/v1/order-amend';

/**
 * POST /api/v1/orders/{id}/cancel — «الزبون تراجع بالمحادثة».
 *
 * The same four things as `/amend` and the same two rules about whose order it is and until when: only an order THIS system created
 * (404 otherwise), only while it is still editable (409 NOT_EDITABLE after). It ends the order through `endOrder` as REJECTED,
 * «غيّر رأيه» — the path the landing chat's cancel takes. An order already ended answers 200 `already: true`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.cancel');
    const { id } = await params;

    const raw = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const parsed = v1CancelSchema.safeParse(body);
    if (!parsed.success) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 20),
      });
    }

    const order = await loadOwnOrder(caller, id);

    const key = idempotencyKeyOf(req);
    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    const result = await cancelSystemOrder(caller, order, parsed.data.reason);

    const answer = {
      order_id: result.orderId,
      order_number: result.orderNumber,
      status: result.status,
      already: result.already,
    };

    await rememberIdempotency(caller.companyId, key, 200, answer);
    claimed = null;
    return v1Ok(requestId, answer, 200);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
