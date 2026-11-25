import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, idempotencySlot, relayInCountry } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  claimIdempotency,
  idempotencyKeyOf,
  releaseIdempotency,
  rememberIdempotency,
  requestFingerprint,
} from '@/lib/v1/idempotency';
import { readRelay, relayChatLines } from '@/lib/v1/landing-chat-inbox';

/**
 * POST /api/v1/landing/chat/messages — one landing chat thread and its new lines, from Zaki pages (contract oms-lp.v1 §11,
 * `landing-chat-inbox.ts`). `201 { threadId, botPaused, written }` when the thread is new, `200` otherwise.
 * The landing key's `orders.create` is enough: no new scope, so no key has to be re-issued.
 */
export async function POST(req: Request) {
  const requestId = requestIdOf(req);
  let claimed: { companyId: string; key: string } | null = null;
  try {
    const caller = await requireSystemToken(req, 'orders.create', LANDING_DOOR);
    const key = idempotencySlot(caller, idempotencyKeyOf(req));

    const raw = await req.text();
    const parsed = readRelay(raw);
    // A body this door cannot take is a refusal Zaki pages must not send again: the readable shape, no key held.
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status, headers: { 'X-Request-Id': requestId } });

    const fingerprint = requestFingerprint('POST', new URL(req.url).pathname, raw);
    const replay = await claimIdempotency(caller.companyId, key, fingerprint);
    if (replay) return v1Ok(requestId, replay.body as Record<string, unknown>, replay.status);
    claimed = { companyId: caller.companyId, key };

    // A key bound to one country: another country's thread is 404, its order or product is not linked (`landing-country.ts`).
    const result = await relayChatLines(caller.companyId, await relayInCountry(caller, parsed.data), new Date(), caller.countryId ?? null, caller.storeId ?? null);
    await rememberIdempotency(caller.companyId, key, result.status, result.body);
    claimed = null;
    return v1Ok(requestId, result.body, result.status);
  } catch (error) {
    if (claimed) await releaseIdempotency(claimed.companyId, claimed.key);
    return v1ErrorResponse(requestId, error);
  }
}
