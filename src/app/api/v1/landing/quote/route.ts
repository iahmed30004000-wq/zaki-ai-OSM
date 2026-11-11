import { NextResponse } from 'next/server';
import { requireSystemToken } from '@/lib/v1/system-token';
import { V1_CODE, V1Fault, requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import { quoteLandingOrder } from '@/lib/v1/landing-door';

/**
 * GET /api/v1/landing/quote?productId=&offerId=&city=
 *
 * What the customer will pay, before they press «اطلب». A GET because it
 * writes nothing, and a city is not a customer's detail. A refusal is the
 * Arabic the visitor reads, in the shape the order door answers with.
 */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'products.read');
    const { searchParams: params } = new URL(req.url);
    const productId = params.get('productId') ?? '';
    const city = params.get('city') ?? '';
    if (!productId || !city) {
      throw new V1Fault(422, V1_CODE.VALIDATION_FAILED, 'productId and city are required', { fields: ['productId', 'city'] });
    }
    const result = await quoteLandingOrder(caller.companyId, {
      productId: productId.slice(0, 64),
      offerId: (params.get('offerId') ?? '').slice(0, 64),
      city: city.slice(0, 120),
    });
    if (!result.ok) return NextResponse.json(result.body, { status: result.status, headers: { 'X-Request-Id': requestId } });
    return v1Ok(requestId, result.quote);
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
