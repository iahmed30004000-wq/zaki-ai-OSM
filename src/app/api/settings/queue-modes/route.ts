import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { readQueueModes, saveQueueModes, validateQueueModes } from '@/lib/queue-modes-settings';

/**
 * GET/PUT /api/settings/queue-modes — the hours of the two time-of-day modes of «أولوية الطابور» (step D2 of Confirmation Center v2): the morning mode (the night's orders first) and the
 * evening peak (new orders first), in whole hours of the store's day. They only matter while the queue-priority key is on. Seen by whoever opens the settings page (\`settings.view\`); changed by
 * \`settings.manage\`. The body is the whole document, validated whole: an invalid one is refused with an Arabic sentence and nothing is stored. One audit row with the before and the after.
 */
export async function GET() {
  try {
    const { companyId } = await requireContext();
    await requirePermission('settings.view');
    return NextResponse.json({ queueModes: await readQueueModes(db, companyId) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const body = await req.json().catch(() => null);
    const checked = validateQueueModes(body);
    if (!checked.ok) return NextResponse.json({ error: checked.error, errorAr: checked.error, code: 'INVALID_QUEUE_MODES' }, { status: 400 });

    const before = await readQueueModes(db, companyId);
    const saved = await saveQueueModes(companyId, checked.config);

    await logAudit({ companyId, userId: user.id, action: 'QUEUE_MODES_CHANGED', entity: 'Company', entityId: companyId, previousData: before, newData: saved });

    return NextResponse.json({ queueModes: saved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
