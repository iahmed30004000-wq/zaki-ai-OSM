/**
 * POST /api/telegram/upsell-merge — «دمج الأب سيل — تجربة», then «نعم، نفّذ الدمج» (telegram.manage).
 *
 *   `{ mode: 'preview' }`                         → `{ rows }`: what the new rules would do with the waiting messages of the
 *                                                    person's store scope (`upsell-plan.ts`). WRITES NOTHING.
 *   `{ mode: 'apply', confirm: true, keys? }`      → `{ results }`: plans again on the server and runs the live door on every
 *                                                    row that would become an order. Without `confirm: true` it is 400 and
 *                                                    nothing happens — the owner's «Apply only after Ahmad's «نعم»».
 *
 * The scope is `telegramStoreWhere(storeId, true)`: the selected store's sources, and the unplaced ones (this key manages).
 * One audit row per apply (`TELEGRAM_UPSELL_MERGED`) with what was asked and what each row became.
 */
import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { telegramStoreWhere } from '@/lib/telegram/store-scope';
import { applyWaitingMessages, planWaitingMessages } from '@/lib/telegram/upsell-plan';

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('telegram.manage');
    const body = (await req.json().catch(() => null)) as { mode?: unknown; confirm?: unknown; keys?: unknown } | null;
    const scope = telegramStoreWhere(storeId, true);

    if (body?.mode === 'preview') {
      const rows = await planWaitingMessages(companyId, scope);
      return NextResponse.json({ rows });
    }

    if (body?.mode === 'apply') {
      if (body.confirm !== true) {
        return NextResponse.json({ error: 'التنفيذ بدو تأكيد صريح («نعم»)' }, { status: 400 });
      }
      const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string').slice(0, 500) : undefined;
      const results = await applyWaitingMessages(companyId, scope, keys);
      await logAudit({
        companyId,
        userId: user.id,
        action: 'TELEGRAM_UPSELL_MERGED',
        entity: 'TelegramMessage',
        entityId: storeId,
        newData: { storeId, asked: keys ?? 'all', results },
      });
      return NextResponse.json({ results });
    }

    return NextResponse.json({ error: 'الطلب لازم يكون تجربة أو تنفيذ' }, { status: 400 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
