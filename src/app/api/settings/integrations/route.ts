import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { clearSetting, integrationKeyInfo, saveSetting, settingsStatus } from '@/lib/integration-settings';

/**
 * GET / PUT / DELETE /api/settings/integrations — the bots' connection settings, entered on the site («الإعدادات ← الربط»; the media buyer's doors, PR-C).
 *
 * WRITE-ONLY, like the ad-account token and the system tokens: no response of this route ever carries a value. GET says, for each setting the person may manage,
 * WHERE it comes from (the site, the environment, nowhere) and the last four characters of a saved one — «محفوظ ✓ · آخر 4». PUT saves one value (sealed, never in the audit
 * row, refused when the application has no encryption key); DELETE removes what the site holds so the environment answers again. A setting needs the key of ITS card:
 * `whatsapp.manage` for WhatsApp's, `telegram.connect` for Telegram's — two grants that stay two (the page opens for either), and the server asks per setting, not per page.
 * One audit row per change with the setting's NAME and its last four characters — never the value.
 */

const putSchema = z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(2000) }).strict();
const deleteSchema = z.object({ key: z.string().min(1).max(80) }).strict();

export async function GET() {
  try {
    const { user } = await requireContext();
    const all = await settingsStatus();
    const mine = all.filter((s) => can(user, s.permission as never));
    // The page opens for either key; a person with neither has nothing here.
    if (mine.length === 0) await requirePermission('whatsapp.manage');
    return NextResponse.json({ items: mine });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'الطلب مش بالشكل المطلوب', code: 'INVALID_BODY' }, { status: 400 });
    const { key, value } = parsed.data;

    const info = integrationKeyInfo(key);
    if (!info) return NextResponse.json({ error: 'إعداد غير معروف', code: 'UNKNOWN_KEY' }, { status: 404 });
    await requirePermission(info.permission);

    const saved = await saveSetting(key, value, user.id);
    if (!saved.ok) {
      const status = saved.code === 'NO_ENCRYPTION_KEY' ? 503 : 400;
      return NextResponse.json({ error: saved.message, code: saved.code }, { status });
    }

    // The NAME and the last four characters; never the value.
    await logAudit({ companyId, userId: user.id, action: 'INTEGRATION_SETTING_SAVED', entity: 'IntegrationSecret', entityId: key, newData: { key, hint: saved.hint } });
    return NextResponse.json({ ok: true, key, hint: saved.hint });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const { user, companyId } = await requireContext();
    const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'الطلب مش بالشكل المطلوب', code: 'INVALID_BODY' }, { status: 400 });
    const { key } = parsed.data;

    const info = integrationKeyInfo(key);
    if (!info) return NextResponse.json({ error: 'إعداد غير معروف', code: 'UNKNOWN_KEY' }, { status: 404 });
    await requirePermission(info.permission);

    const removed = await clearSetting(key);
    if (removed) {
      await logAudit({ companyId, userId: user.id, action: 'INTEGRATION_SETTING_CLEARED', entity: 'IntegrationSecret', entityId: key, newData: { key } });
    }
    return NextResponse.json({ ok: true, key, removed });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
