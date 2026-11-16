import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { queuePrioritySwitch, forgetQueuePrioritySwitch, saveQueuePrioritySwitch } from '@/lib/queue-priority-switch';
import { OPEN_CONFIRMATION } from '@/lib/confirmation-queue';
import { readBacklogShare } from '@/lib/queue-priority-share';

/**
 * GET/PUT /api/settings/queue-priority — «أولوية الطابور v2 (تجريبي)», the owner’s switch (`queue-priority-switch.ts`, step D of Confirmation Center v2).
 *
 * OFF by default, and OFF is the pull exactly as it is today. ON changes WHICH order a girl is given next (a fresh order first, a retry that waited past two hours before the
 * old ones, and a share of her pulls to the backlog), so turning it is `settings.manage` — the box the owner holds for the company's keys — and it is turned outside work
 * hours with a monitoring day, as the other keys. Seen by whoever opens the settings page (`settings.view`).
 *
 * GET also says the share it would use now and how it was reached («قاعدة الاحتساب»), so the owner reads the number and its rule from the same place. The body of PUT is
 * `{ enabled: boolean }` and nothing else: the moment it went on is the server's clock, never the client's.
 */
function view(sw: { enabled: boolean; enabledAt: Date | null }) {
  return { enabled: sw.enabled, enabledAt: sw.enabledAt ? sw.enabledAt.toISOString() : null };
}

export async function GET() {
  try {
    const { companyId, storeId } = await requireContext();
    await requirePermission('settings.view');
    forgetQueuePrioritySwitch(companyId);
    const sw = await queuePrioritySwitch(db, companyId);
    const reading = await readBacklogShare(db, { companyId, storeId }, new Date(), OPEN_CONFIRMATION);
    return NextResponse.json({
      queuePriority: view(sw),
      share: { percent: Math.round(reading.result.share * 100), note: reading.note },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('settings.manage');

    const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).some((k) => k !== 'enabled')) {
      const errorAr = 'أرسل «مفعّل» نعم أو لا فقط.';
      return NextResponse.json({ error: errorAr, errorAr, code: 'INVALID_SWITCH' }, { status: 400 });
    }

    forgetQueuePrioritySwitch(companyId);
    const before = await queuePrioritySwitch(db, companyId);
    const saved = await saveQueuePrioritySwitch(companyId, body.enabled);

    await logAudit({
      companyId,
      userId: user.id,
      action: 'QUEUE_PRIORITY_SWITCHED',
      entity: 'Company',
      entityId: companyId,
      previousData: view(before),
      newData: view(saved),
    });

    return NextResponse.json({ queuePriority: view(saved) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
