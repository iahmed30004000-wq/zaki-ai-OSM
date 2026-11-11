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
import { landingOrderSchema, takeLandingOrder } from '@/lib/v1/landing-door';

/**
 * POST /api/v1/landing/orders — an order from a standalone landing page.
 *
 * A refusal gives the key back: the visitor fixes their phone number and the
 * same form sends the same key again, and that is a new attempt, not a replay
 * of the refusal. Only an order that exists keeps its key.
 */
export async function POST(req: Request) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.create');
    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const parsed = landingOrderSchema.safeParse(payload);
    if (!parsed.success) {
      // Field names only: a value here could be a customer's phone.
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
        fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].slice(0, 20),
      });
    }

    const key = idempotencyKeyOf(req);
    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    const result = await takeLandingOrder(caller.companyId, parsed.data);
    if (!result.ok) {
      await releaseIdempotency(claimed.companyId, claimed.key);
      claimed = null;
      return NextResponse.json(result.body, {
        status: result.status,
        headers: { 'X-Request-Id': requestId, ...(result.headers ?? {}) },
      });
    }

    await rememberIdempotency(caller.companyId, key, 201, result.body);
    claimed = null;
    return v1Ok(requestId, result.body, 201);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
