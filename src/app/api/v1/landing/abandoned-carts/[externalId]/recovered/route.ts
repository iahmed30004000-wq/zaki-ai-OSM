import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, idempotencySlot, orderNumberInCountry, requireCartInCountry } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { readRecovered, recoverLandingCart } from '@/lib/v1/landing-carts';

interface Ctx {
  params: Promise<{ externalId: string }>;
}

/**
 * POST /api/v1/landing/abandoned-carts/:externalId/recovered — the customer ordered by himself after all (contract
 * oms-lp.v1 §9). RECOVERED, linked to the order when its number is this company's; a repeat is 200 with no change; an
 * unknown cart is 404 `{ error: { code: "NOT_FOUND" } }`. See `recoverLandingCart`.
 */
export async function POST(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.create', LANDING_DOOR);
    const key = idempotencySlot(caller, idempotencyKeyOf(req));
    const externalId = decodeURIComponent((await ctx.params).externalId).trim().slice(0, 200);

    const raw = await req.text();
    const parsed = readRecovered(raw);
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status, headers: { 'X-Request-Id': requestId } });

    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    // An unknown cart throws the 404 envelope, and the catch below gives the key back.
    // A key bound to one country: another country's cart answers as an unknown one, and another country's order is not linked.
    await requireCartInCountry(caller, externalId);
    const answer = await recoverLandingCart(caller.companyId, externalId, await orderNumberInCountry(caller, parsed.orderNumber));
    await rememberIdempotency(caller.companyId, key, 200, answer);
    claimed = null;
    return v1Ok(requestId, answer, 200);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
