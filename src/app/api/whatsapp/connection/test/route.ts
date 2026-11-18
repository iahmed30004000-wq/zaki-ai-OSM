/**
 * POST /api/whatsapp/connection/test — live-check against Meta Cloud API.
 * whatsapp.manage only. Updates connection status/lastError (sanitized).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant, requirePermission } from '@/lib/auth';
import { getAccessToken, getWabaId, getPhoneNumberId, envConfigured } from '@/lib/whatsapp/config';
import { getPhoneNumberInfo } from '@/lib/whatsapp/cloud-api';
import { getActiveConnection, serializeConnection } from '@/lib/whatsapp/connection';
import { whatsappEncrypt } from '@/lib/whatsapp/crypto';
import { rateLimit } from '@/lib/rate-limit';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';

const bodySchema = z.object({}).strict();

export async function POST(req: Request) {
  try {
    await requirePermission('whatsapp.manage');
    const { user, companyId } = await requireCompanyTenant();
    const rl = rateLimit(`wa-test:${companyId}:${user.id}`, 6, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ error: `محاولات كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` }, { status: 429 });
    }
    await bodySchema.parseAsync({});

    const token = await getAccessToken();
    const wabaId = await getWabaId();
    const phoneNumberId = await getPhoneNumberId();
    if (!await envConfigured() || !token || !wabaId || !phoneNumberId) {
      return NextResponse.json({ error: 'الاتصال غير مكتمل — أكمل متغيرات البيئة أولًا' }, { status: 400 });
    }

    const res = await getPhoneNumberInfo({ wabaId, token });
    const match = res.ok ? res.phones.find((p) => p.id === phoneNumberId) : undefined;

    const existing = await getActiveConnection(companyId);
    if (res.ok) {
      const data = {
        status: 'CONNECTED' as const,
        lastError: null,
        phoneNumber: match?.display_phone_number ?? existing?.phoneNumber ?? null,
        displayName: match?.verified_name ?? match?.name ?? existing?.displayName ?? null,
      };
      const conn = existing
        ? await db.whatsAppConnection.update({ where: { id: existing.id }, data })
        : await db.whatsAppConnection.create({
            data: {
              companyId,
              wabaId,
              phoneNumberId,
              accessTokenEncrypted: process.env.WHATSAPP_ENCRYPTION_KEY ? whatsappEncrypt(token) : null,
              ...data,
            },
          });
      logAudit({ companyId, userId: user.id, action: 'whatsapp.connection.test', entity: 'WhatsAppConnection', entityId: conn.id, newData: { result: 'CONNECTED' } }).catch(() => {});
      return NextResponse.json({ ok: true, connection: await serializeConnection(conn) });
    }

    if (existing) {
      await db.whatsAppConnection.update({
        where: { id: existing.id },
        data: { status: 'NEEDS_SETUP', lastError: res.error },
      });
    }
    return NextResponse.json({ ok: false, error: res.error || 'تعذر الاتصال بواتساب' }, { status: 502 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
