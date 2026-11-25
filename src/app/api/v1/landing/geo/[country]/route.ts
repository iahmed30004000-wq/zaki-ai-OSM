import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, requireCountryCode } from '@/lib/v1/landing-country';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { readLandingRegions } from '@/lib/v1/landing-door';

interface Ctx {
  params: Promise<{ country: string }>;
}

/** GET /api/v1/landing/geo/:country — the cities a page's form offers. */
export async function GET(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read', LANDING_DOOR);
    const { country } = await ctx.params;
    // A key bound to one country asks for its own country's cities only; another code answers as an unknown one.
    await requireCountryCode(caller, country);
    return v1Ok(requestId, await readLandingRegions(caller.companyId, country.toUpperCase()));
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
