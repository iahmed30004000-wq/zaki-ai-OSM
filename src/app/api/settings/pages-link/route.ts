import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { hasFullAccess, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { encryptSecret, encryptionAvailable } from '@/lib/secrets';
import { PAGES_APP_CODE, PAGES_ORDER_STATUS_EVENT } from '@/lib/apps/events';

/**
 * «صفحات ذكي» — WHERE THIS SYSTEM TELLS ZAKI PAGES AN ORDER'S STATUS (2026-11-21).
 *
 * GET  /api/settings/pages-link — the link as it stands: the address, whether a secret is saved (never the secret), and
 *                                 how the deliveries are going (queued · delivered · failed, and the last failure).
 * PUT  /api/settings/pages-link — save the address, a NEW secret (optional once one is saved), on/off.
 *
 * NOT A SECOND CHANNEL. Zaki Pages is an installed app like any other (`App` + `AppInstall`, code `ZAKI_PAGES`): the
 * events go through the same signed outbox (`AppDelivery`, `deliverOne`, the retries, the log on /apps/installed). What
 * this adds is the owner's own way to point it at Pages: the secret is the one Zaki Pages verifies with, so it is TYPED
 * here (written only — encrypted at rest, never returned, never in the audit log, never in a log line), not generated.
 * An app already registered under this code keeps its secret when the field is left empty, and gains the event.
 * There is no environment variable for it, before or after.
 *
 * OWNER ONLY: `apps.manage` AND every key (`hasFullAccess`) — a webhook address decides where order facts go.
 */

const PAGES_APP_NAME = 'صفحات ذكي';

const ownerOnly = () =>
  NextResponse.json({ error: 'ربط صفحات ذكي للمالك وحده.', code: 'OWNER_ONLY' }, { status: 403 });

async function owner() {
  const { user, companyId } = await requireCompanyTenant();
  await requirePermission('apps.manage');
  return { user, companyId, isOwner: hasFullAccess(user) };
}

function eventsOf(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** The link as the screen may see it. Never the secret — only whether one is saved. */
async function view(companyId: string) {
  const app = await db.app.findFirst({
    where: { companyId, code: PAGES_APP_CODE },
    select: { id: true, webhookUrl: true, secret: true, events: true, status: true },
  });
  const install = await db.appInstall.findFirst({
    where: { companyId, appCode: PAGES_APP_CODE },
    select: { id: true, enabled: true },
  });
  const counts = install
    ? await db.appDelivery.groupBy({
        by: ['status'],
        where: { companyId, installId: install.id, event: PAGES_ORDER_STATUS_EVENT },
        _count: { _all: true },
      })
    : [];
  const lastFailure = install
    ? await db.appDelivery.findFirst({
        where: { companyId, installId: install.id, event: PAGES_ORDER_STATUS_EVENT, error: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { error: true, status: true, createdAt: true },
      })
    : null;
  const by = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
  return {
    configured: !!app?.webhookUrl && !!app?.secret && !!install,
    url: app?.webhookUrl ?? '',
    secretSet: !!app?.secret,
    enabled: !!install?.enabled && app?.status === 'ACTIVE',
    listening: eventsOf(app?.events).includes(PAGES_ORDER_STATUS_EVENT),
    deliveries: { pending: by('PENDING'), ok: by('OK'), failed: by('FAILED') },
    lastFailure: lastFailure ? { error: lastFailure.error, status: lastFailure.status, at: lastFailure.createdAt } : null,
  };
}

export async function GET() {
  try {
    const { companyId, isOwner } = await owner();
    if (!isOwner) return ownerOnly();
    return NextResponse.json(await view(companyId));
  } catch (e) {
    return apiErrorResponse(e);
  }
}

const saveSchema = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https:\/\/\S+$/i.test(v), 'العنوان يجب أن يبدأ بـ https://'),
  /** Written only. Empty or absent = keep the saved one. */
  secret: z.string().trim().max(256).optional(),
  enabled: z.boolean().optional(),
});

export async function PUT(req: Request) {
  try {
    const { user, companyId, isOwner } = await owner();
    if (!isOwner) return ownerOnly();

    const parsed = saveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      // The message only — never the body, which may carry the secret.
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'البيانات غير صالحة' }, { status: 400 });
    }
    const { url, enabled } = parsed.data;
    const secret = parsed.data.secret || '';
    if (secret && secret.length < 16) {
      return NextResponse.json({ error: 'سرّ التوقيع قصير — 16 خانة على الأقل.' }, { status: 400 });
    }

    const existing = await db.app.findFirst({
      where: { companyId, code: PAGES_APP_CODE },
      select: { id: true, secret: true, events: true },
    });
    if (!existing?.secret && !secret) {
      return NextResponse.json({ error: 'اكتب سرّ التوقيع نفسه المحفوظ في صفحات ذكي.' }, { status: 400 });
    }
    if (secret && !encryptionAvailable()) {
      return NextResponse.json(
        { error: 'مفتاح التشفير غير مُهيّأ على الخادم — لن يُحفظ سرّ التوقيع بلا تشفير.', code: 'ENCRYPTION_KEY_MISSING' },
        { status: 503 }
      );
    }

    const events = JSON.stringify([...new Set([...eventsOf(existing?.events), PAGES_ORDER_STATUS_EVENT])]);
    const app = existing
      ? await db.app.update({
          where: { id: existing.id },
          data: { webhookUrl: url, events, status: 'ACTIVE', ...(secret ? { secret: encryptSecret(secret) } : {}) },
          select: { id: true },
        })
      : await db.app.create({
          data: {
            companyId,
            code: PAGES_APP_CODE,
            name: PAGES_APP_NAME,
            description: 'حالة طلبات صفحات ذكي: تأكّد · استلم ودفع · ملغي · راجع.',
            webhookUrl: url,
            events,
            secret: encryptSecret(secret),
            createdById: user.id,
          },
          select: { id: true },
        });
    await db.appInstall.upsert({
      where: { companyId_appCode: { companyId, appCode: PAGES_APP_CODE } },
      create: { companyId, appCode: PAGES_APP_CODE, appId: app.id, enabled: enabled ?? true, installedById: user.id },
      update: { appId: app.id, ...(enabled === undefined ? {} : { enabled }) },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'PAGES_LINK_SAVED',
      entity: 'App',
      entityId: app.id,
      // Whether the secret changed — never the secret.
      newData: { webhookUrl: url, secretChanged: !!secret, enabled: enabled ?? null },
    });

    return NextResponse.json({ success: true, ...(await view(companyId)) });
  } catch (e) {
    return apiErrorResponse(e);
  }
}
