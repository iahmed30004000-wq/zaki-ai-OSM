import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { LANDING_DOOR, scopeOf } from '@/lib/v1/landing-country';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { quoteLandingOrder } from '@/lib/v1/landing-door';

/**
 * GET /api/v1/landing/quote?productId=&offerId=&city=&units=
 *
 * What the customer will pay, before they press «اطلب». A GET because it
 * writes nothing, and a city is not a customer's detail. A refusal is the
 * Arabic the visitor reads, in the shape the order door answers with.
 *
 * A blank `city` is asked too (the owner, 15/11: a page may ask for «العنوان» only): the goods are priced and the
 * fee is `feeKnown: false`, as for a region the fee table has no row for. A city that is written and is not the
 * country's is still refused.
 */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read', LANDING_DOOR);
    const { searchParams: params } = new URL(req.url);
    const productId = params.get('productId') ?? '';
    const city = params.get('city') ?? '';
    if (!productId) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'productId is required', { fields: ['productId'] });
    }
    const result = await quoteLandingOrder(caller.companyId, {
      productId: productId.slice(0, 64),
      offerId: (params.get('offerId') ?? '').slice(0, 64),
      city: city.slice(0, 120),
      // One combination id per piece for a product with variants (oms-lp.v1 §10); absent or blank is the base offer.
      units: (params.get('units') ?? '')
        .split(',')
        .map((u) => u.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 200),
    }, scopeOf(caller));
    if (!result.ok) return NextResponse.json(result.body, { status: result.status, headers: { 'X-Request-Id': requestId } });
    return v1Ok(requestId, result.quote);
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
