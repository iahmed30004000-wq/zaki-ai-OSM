import { requireSystemToken } from '@/lib/v1/system-token';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { readLandingRegions } from '@/lib/v1/landing-door';

interface Ctx {
  params: Promise<{ country: string }>;
}

/** GET /api/v1/landing/geo/:country — the cities a page's form offers. */
export async function GET(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read');
    const { country } = await ctx.params;
    return v1Ok(requestId, await readLandingRegions(caller.companyId, country.toUpperCase()));
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
