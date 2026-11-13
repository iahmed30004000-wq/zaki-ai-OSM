import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { ORDER_NUMBER_RE } from '@/lib/order-ref';
import { chatTokenSchema, confirmFromChat } from '@/lib/v1/landing-chat';

interface Ctx {
  params: Promise<{ orderNumber: string }>;
}

/**
 * POST …/orders/:orderNumber/confirm — the chat's «yes»: the agent's confirmation, step for step and by the same helpers
 * (`landing-chat.ts`). Already confirmed answers 200 with `already: true` and writes nothing.
 */
export async function POST(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.create');
    const orderNumber = decodeURIComponent((await ctx.params).orderNumber);
    if (!ORDER_NUMBER_RE.test(orderNumber)) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');

    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const parsed = chatTokenSchema.safeParse(payload);
    if (!parsed.success) {
      // Field names only: a value here could be a customer's words.
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 20),
      });
    }

    const key = idempotencyKeyOf(req);
    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    const result = await confirmFromChat(caller.companyId, orderNumber, parsed.data);
    if (!result.ok) {
      // A refusal gives the key back: the same request after the order changes is a new question.
      await releaseIdempotency(claimed.companyId, claimed.key);
      claimed = null;
      return NextResponse.json(result.body, { status: result.status, headers: { 'X-Request-Id': requestId } });
    }

    await rememberIdempotency(caller.companyId, key, 200, result.body);
    claimed = null;
    return v1Ok(requestId, result.body, 200);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
