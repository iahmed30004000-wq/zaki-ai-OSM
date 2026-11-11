import { requireSystemToken } from '@/lib/v1/system-token';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { readLandingProduct } from '@/lib/v1/landing-door';

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/v1/landing/products/:id — one product, as its page shows it. */
export async function GET(req: Request, ctx: Ctx) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read');
    const { id } = await ctx.params;
    return v1Ok(requestId, await readLandingProduct(caller.companyId, id));
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
