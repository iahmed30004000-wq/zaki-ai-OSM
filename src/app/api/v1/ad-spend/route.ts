import { readLimit } from '@/lib/numeric-input';
import { requireSystemToken } from '@/lib/v1/system-token';
import { requestIdOf, v1ErrorResponse, v1Ok } from '@/lib/v1/door';
import {
  AD_SPEND_PAGE_DEFAULT,
  AD_SPEND_PAGE_MAX,
  decodeSpendCursor,
  readAdSpendPage,
  readLevel,
  readWindow,
} from '@/lib/v1/ad-spend';

/**
 * GET /api/v1/ad-spend?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&level=ad|adset|campaign&cursor=…&limit=…
 *
 * «What did each ad spend each day?» — the media buyer's read that sets a cost per order. `{ items, next_cursor, as_of }`; follow
 * `next_cursor` until it is null. Every rule lives in `src/lib/v1/ad-spend.ts`. It reads the table the daily spend pull fills and never
 * calls Meta, so it costs the ad account nothing however often it is asked.
 *
 * Its own scope, `ads.spend.read`: money the replies system and a key that only reads orders have no business seeing.
 */
export async function GET(req: Request) {
  const requestId = requestIdOf(req);
  try {
    const caller = await requireSystemToken(req, 'ads.spend.read');
    const { searchParams } = new URL(req.url);

    const { from, to } = readWindow(searchParams.get('date_from'), searchParams.get('date_to'));
    const level = readLevel(searchParams.get('level'));
    const rawCursor = searchParams.get('cursor');
    const cursor = rawCursor ? decodeSpendCursor(rawCursor) : null;
    const limit = readLimit(searchParams, AD_SPEND_PAGE_DEFAULT, AD_SPEND_PAGE_MAX);

    const page = await readAdSpendPage({ companyId: caller.companyId, from, to, level, cursor, limit });
    return v1Ok(requestId, page);
  } catch (error) {
    return v1ErrorResponse(requestId, error);
  }
}
