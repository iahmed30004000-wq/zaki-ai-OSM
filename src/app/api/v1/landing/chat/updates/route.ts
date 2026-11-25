import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok, V1Fault, V1_CODE } from '@/lib/v1/door';
import { chatUpdates, updatesQuery } from '@/lib/v1/landing-chat-inbox';

/**
 * GET /api/v1/landing/chat/updates?after=<seq> — what the staff did in «رسائل اللاندينج» since `after`, for every thread of
 * the key's company (a country-bound key: its country's threads only): their replies, and the bot paused or given back, in order (contract oms-lp.v1 §11).
 * `{ updates: [{ seq, id, sessionId, kind: "staff" | "paused" | "resumed", text?, at }], cursor, more }`.
 */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'orders.create', LANDING_DOOR);
    const after = new URL(req.url).searchParams.get('after') || undefined;
    const q = updatesQuery.safeParse({ after });
    if (!q.success) throw new V1Fault(400, V1_CODE.VALIDATION_FAILED, 'after must be a sequence number');
    const answer = await chatUpdates(caller.companyId, q.data.after, new Date(), caller.countryId ?? null, caller.storeId ?? null);
    return v1Ok(requestId, { ...answer }, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
