import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { DESK_WATCH_REFUSAL, mayWatchDesks, watchableAgents } from '@/lib/desk-watch';

/**
 * GET /api/confirmation/desks — the names the «شاشة موظفة» picker offers.
 *
 * Whoever works confirmation in this store, with what each holds open now, for
 * a viewer who may watch a desk (desk-watch.ts). Anybody else is refused, and
 * the screen draws no picker for them: it asks this door and draws what it
 * answers. Reading only — the desk itself comes from `/api/confirmation/mine?agent=`.
 */
export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();
    if (!mayWatchDesks(user)) {
      return NextResponse.json({ error: 'Forbidden: cannot watch desks', errorAr: DESK_WATCH_REFUSAL }, { status: 403 });
    }
    return NextResponse.json({ agents: await watchableAgents(user, companyId, storeId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
