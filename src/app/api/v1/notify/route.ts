import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { sendNotification } from '@/lib/v1/notify';

/**
 * POST /api/v1/notify — «tell the owner (or a person, or a chat) this», through the OMS's own Telegram bot.
 *
 * `{ target, text, key, link? }` → `{ ok, delivered, duplicate, message_id }`. Every rule is in `src/lib/v1/notify.ts`: the customer-data refusal,
 * the target names, the 24-hour key. Its own scope, `notify.send`: a key that may read ad spend or orders may not make the bot speak.
 */
export async function POST(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'notify.send');
    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'The body is not JSON');
    }
    const answer = await sendNotification(caller.companyId, payload, new URL(req.url).pathname);
    return v1Ok(requestId, { ...answer });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
