/**
 * GET/PUT /api/whatsapp/bot — the WhatsApp order bot's settings (`whatsapp/bot/settings.ts`).
 *
 * Read with `whatsapp.view` (the people who answer WhatsApp may see how the bot is set up); written with `whatsapp.manage`.
 * The model's key is write-only: it is never in an answer (only its last four characters) and never in the audit row,
 * which names the fields that changed and nothing they hold.
 */
import { NextResponse } from 'next/server';
import { requirePermission, tenantOf } from '@/lib/auth';
import { can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { botSettingsSchema, readBotSettingsView, saveBotSettings } from '@/lib/whatsapp/bot/settings';
import { sandboxProducts } from '@/lib/whatsapp/bot/sandbox-door';

export async function GET() {
  try {
    const user = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(user);
    const [settings, products] = await Promise.all([readBotSettingsView(companyId), sandboxProducts(companyId)]);
    return NextResponse.json({ settings, products, canManage: can(user, 'whatsapp.manage') });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requirePermission('whatsapp.manage');
    const { companyId } = await tenantOf(user);
    const parsed = botSettingsSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const error = parsed.error.issues[0]?.message || 'قيم غير صالحة';
      return NextResponse.json({ error, errorAr: error }, { status: 400 });
    }
    const saved = await saveBotSettings(companyId, parsed.data, user.id);
    if (!saved.ok) return NextResponse.json({ error: saved.error, errorAr: saved.error }, { status: 400 });
    if (saved.changed.length > 0) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'WHATSAPP_BOT_SETTINGS_SAVED',
        entity: 'WhatsAppBotSettings',
        entityId: companyId,
        // The names of what changed, and the switch's new position — never the key, the persona or a note.
        newData: { fields: saved.changed, enabled: saved.view.enabled },
      });
    }
    return NextResponse.json({ settings: saved.view });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
