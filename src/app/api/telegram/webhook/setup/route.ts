/**
 * POST /api/telegram/webhook/setup — registers the Telegram webhook.
 * Requires telegram.connect (the connection key, T-09 — not telegram.manage, which is the day's
 * message work) + configured env (token + secret + APP_URL).
 * Safe to call anytime: fails closed with a clear (Arabic) status when env
 * is missing — no secrets are returned or logged.
 */
import { NextResponse } from 'next/server';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { botConfigured, webhookSecretConfigured, getAppUrl, getWebhookSecret, WEBHOOK_PATH } from '@/lib/telegram/config';
import { setWebhook } from '@/lib/telegram/cloud-api';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

export async function POST() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('telegram.connect');

    if (!botConfigured() || !webhookSecretConfigured()) {
      return NextResponse.json(
        { error: 'إعدادات تيليجرام غير مكتملة (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET)' },
        { status: 409 }
      );
    }
    const appUrl = getAppUrl();
    if (!appUrl) {
      return NextResponse.json(
        { error: 'لم يتم ضبط APP_URL — لا يمكن بناء رابط الويبهوك' },
        { status: 409 }
      );
    }

    const result = await setWebhook(`${appUrl}${WEBHOOK_PATH}`, getWebhookSecret()!);
    if (!result.ok) {
      return NextResponse.json({ error: 'فشل تسجيل الويبهوك لدى تيليجرام' }, { status: 502 });
    }

    await logAudit({
      companyId,
      userId: user.id,
      action: 'TELEGRAM_WEBHOOK_SETUP',
      entity: 'TelegramWebhook',
      entityId: appUrl,
      newData: { webhookUrl: `${appUrl}${WEBHOOK_PATH}` },
    });

    return NextResponse.json({ success: true, webhookUrl: `${appUrl}${WEBHOOK_PATH}` });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
