import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, landingStores } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';

/**
 * GET /api/v1/landing/stores â€” the stores this key sees, each with its country and currency: what Zaki Pages lists when
 * the owner adds a country or a store (a country-bound key: its country's; a store-bound key: its own store).
 */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read', LANDING_DOOR);
    return v1Ok(requestId, { stores: await landingStores(caller) });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
