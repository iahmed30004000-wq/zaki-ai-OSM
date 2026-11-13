import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { pulseReport } from '@/lib/server-pulse';

/**
 * GET /api/admin/pulse — THE LAST STALLS OF THE SERVER, AND ITS VITAL NUMBERS.
 *
 * Behind «تشغيل المهام المجدولة» (`settings.jobs`), the key of the jobs screen: this is the same kind of reading — is anything
 * quietly not running — for the web process itself. It is NOT one of the public health doors (`/api/health/*`, which any monitor
 * may call and which leak nothing): it carries memory figures and the names of our own computations, so it asks who is calling.
 *
 * Numbers, times and our own words only (`lib/server-pulse.ts`): no request, no id, no person.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requirePermission('settings.jobs');
    return NextResponse.json(pulseReport(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
