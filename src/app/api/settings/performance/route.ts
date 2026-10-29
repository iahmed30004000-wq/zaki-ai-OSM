import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { performanceSettings, savePerformanceSettings } from '@/lib/performance-settings';
import { BANDS } from '@/lib/performance-score';

/**
 * GET/PUT /api/settings/performance — the BARS, never the weights.
 *
 * The weights travel with the GET so the screen can show them, and they are
 * not read from the body on the way back in. That is the guard: a client
 * that posted a weight would change nothing, because a score whose weights
 * move cannot be compared with last month's — and comparing with last
 * month is the only thing anybody ever does with a score.
 */
export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    return NextResponse.json({
      settings: await performanceSettings(companyId),
      // Shown, explained, and not editable anywhere.
      weights: BANDS.map((b) => ({ key: b.key, ar: b.ar, weight: b.weight, negative: !!b.negative })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('team.settings');

    const before = await performanceSettings(companyId);
    // Parsed, clamped and narrowed by the settings module: anything that is
    // not one of the four bars is dropped rather than stored.
    const saved = await savePerformanceSettings(companyId, await req.json().catch(() => null));

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PERFORMANCE_SETTINGS_UPDATED',
      entity: 'Company',
      entityId: companyId,
      previousData: { ...before },
      newData: { ...saved },
    });

    return NextResponse.json({ settings: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
