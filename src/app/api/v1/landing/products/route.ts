import { requireSystemToken } from '@/lib/v1/system-token';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { listLandingProducts } from '@/lib/v1/landing-door';

/** GET /api/v1/landing/products — every product, for the page builder's picker. */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read');
    return v1Ok(requestId, { products: await listLandingProducts(caller.companyId) });
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
