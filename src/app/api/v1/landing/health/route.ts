import { requireSystemToken } from '@/lib/v1/system-token';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';

/** GET /api/v1/landing/health — is the door up, and is this key still good? */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    await requireSystemToken(req, 'products.read');
    return v1Ok(requestId, { ok: true });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
