import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, cartInCountry, idempotencySlot } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { readLandingCart, upsertLandingCart } from '@/lib/v1/landing-carts';

/**
 * POST /api/v1/landing/abandoned-carts — an abandoned cart from Zaki pages, upserted per company on `externalId`
 * (contract oms-lp.v1 §9, `landing-carts.ts`). `201 { id, status }` when it is new, `200` when it was already here.
 * The landing key's `orders.create` is enough: no new scope, so no key has to be re-issued.
 */
export async function POST(req: Request) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.create', LANDING_DOOR);
    const key = idempotencySlot(caller, idempotencyKeyOf(req));

    const raw = await req.text();
    // Kept to the key's country when it is bound to one (`landing-country.ts`): the same refusal shape when it is not.
    const read = readLandingCart(raw);
    const parsed = read.ok ? await cartInCountry(caller, read.data) : read;
    // A body this door cannot take is a refusal Zaki pages must not send again: the visitor-readable shape, no key held.
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status, headers: { 'X-Request-Id': requestId } });

    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    const result = await upsertLandingCart(caller.companyId, parsed.data);
    await rememberIdempotency(caller.companyId, key, result.status, result.body);
    claimed = null;
    return v1Ok(requestId, result.body, result.status);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
