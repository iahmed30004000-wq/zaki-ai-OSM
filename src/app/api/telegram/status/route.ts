/**
 * GET  /api/telegram/status — safe connection info (never the token/secrets).
 */
import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authorization';
import { requireCompanyTenant } from '@/lib/auth';
import { botConfigured, webhookSecretConfigured, getAppUrl, WEBHOOK_PATH } from '@/lib/telegram/config';
import { getMe, getWebhookInfo } from '@/lib/telegram/cloud-api';
import { db } from '@/lib/db';
import { apiErrorResponse } from '@/lib/api-error';

export async function GET() {
  try {
    const { companyId } = await requireCompanyTenant();
    await requirePermission('telegram.view');

    const tokenOk = await botConfigured();
    let botUsername: string | null = null;
    let botApiOk = false;
    if (tokenOk) {
      const me = await getMe();
      botApiOk = me.ok;
      botUsername = me.result?.username ?? null;
    }

    let webhookUrl: string | null = null;
    let telegramWebhookSet = false;
    const appUrl = getAppUrl();
    if (appUrl) webhookUrl = `${appUrl}${WEBHOOK_PATH}`;
    if (tokenOk) {
      const info = await getWebhookInfo();
      telegramWebhookSet = Boolean(info.ok && info.result?.url);
    }

    const [sourcesCount, messagesStats] = await Promise.all([
      db.telegramSource.count({ where: { companyId } }),
      db.telegramMessage.groupBy({
        by: ['processingStatus'],
        where: { companyId },
        _count: { _all: true },
      }),
    ]);

    const stats: Record<string, number> = { CREATED: 0, NEEDS_REVIEW: 0, IGNORED: 0, FAILED: 0 };
    for (const g of messagesStats) stats[g.processingStatus] = g._count._all;

    return NextResponse.json({
      botConfigured: tokenOk,
      botApiOk,
      botUsername,
      webhookSecretConfigured: await webhookSecretConfigured(),
      telegramWebhookSet,
      webhookUrl,
      appUrlConfigured: Boolean(appUrl),
      sourcesCount,
      stats,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
