import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission, can } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { encryptSecret, encryptionAvailable } from '@/lib/secrets';
import { builtInApps, APP_CATEGORY_AR } from '@/lib/apps/registry';
import { APP_EVENTS, APP_EVENT_AR, EXTRA_APP_EVENTS, EXTRA_APP_EVENT_AR, isRegisterableEvent } from '@/lib/apps/events';
import { zodMessage } from '@/lib/zod-message';

/**
 * GET  /api/apps — the shelf: built-ins and this company's own apps.
 * POST /api/apps — register an external app.
 *
 * A built-in's availability comes from the code registry, not from a table:
 * what the code supports IS the code, and a catalogue row claiming otherwise
 * would be wrong the moment an adapter is renamed. Only the INSTALL is
 * stored.
 */

export async function GET() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('apps.view');

    const [installs, external] = await Promise.all([
      db.appInstall.findMany({
        where: { companyId },
        select: { id: true, appCode: true, enabled: true, installedAt: true, appId: true },
      }),
      db.app.findMany({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, code: true, name: true, description: true, developerName: true,
          iconUrl: true, webhookUrl: true, events: true, status: true, createdAt: true,
          // Never `secret`. An endpoint that can return it will one day
          // return it to the wrong person.
          _count: { select: { installs: true } },
        },
      }),
    ]);

    const installByCode = new Map(installs.map((i) => [i.appCode, i]));

    const builtIn = await Promise.all(
      builtInApps(db).map(async (a) => ({
        kind: 'BUILTIN' as const,
        code: a.code,
        name: a.name,
        summary: a.summary,
        description: a.description,
        category: a.category,
        categoryLabel: APP_CATEGORY_AR[a.category],
        settingsPath: a.settingsPath,
        // The permission is reported so a screen can grey out what this user
        // could not install anyway, instead of failing after the click.
        canManage: can(user, a.permission as never),
        installed: installByCode.has(a.code),
        enabled: installByCode.get(a.code)?.enabled ?? false,
        installedAt: installByCode.get(a.code)?.installedAt ?? null,
        // A live check, not a stored flag: a courier whose credentials were
        // cleared is not configured any more.
        configured: await a.configured({ companyId }),
      }))
    );

    return NextResponse.json({
      builtIn,
      external: external.map((a) => ({
        kind: 'EXTERNAL' as const,
        id: a.id,
        code: a.code,
        name: a.name,
        description: a.description,
        developerName: a.developerName,
        iconUrl: a.iconUrl,
        webhookUrl: a.webhookUrl,
        events: safeEvents(a.events),
        status: a.status,
        createdAt: a.createdAt,
        installed: installByCode.has(a.code),
        enabled: installByCode.get(a.code)?.enabled ?? false,
        installCount: a._count.installs,
      })),
      // The six of the replies contract, then the extras an app may register for by name (the owner's stop request).
      availableEvents: [
        ...APP_EVENTS.map((e) => ({ code: e, label: APP_EVENT_AR[e] })),
        ...EXTRA_APP_EVENTS.map((e) => ({ code: e, label: EXTRA_APP_EVENT_AR[e] })),
      ],
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function safeEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{3,40}$/, 'الرمز أحرف إنجليزية كبيرة وأرقام وشرطة سفلية فقط'),
  description: z.string().trim().max(500).optional(),
  developerName: z.string().trim().max(80).optional(),
  webhookUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https:\/\/.+/i.test(v), 'عنوان الويبهوك يجب أن يبدأ بـ https://'),
  events: z.array(z.string()).min(1, 'اختر حدثاً واحداً على الأقل').max(20),
});

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await requirePermission('apps.manage');

    if (!encryptionAvailable()) {
      return NextResponse.json(
        {
          error: 'مفتاح التشفير غير مُهيّأ على الخادم (APP_ENCRYPTION_KEY) — لن يُحفظ سرّ التوقيع بلا تشفير.',
          code: 'ENCRYPTION_KEY_MISSING',
        },
        { status: 503 }
      );
    }

    const parsed = registerSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    const events = input.events.filter(isRegisterableEvent);
    if (events.length === 0) {
      return NextResponse.json({ error: 'أحداث غير معروفة' }, { status: 400 });
    }

    // A built-in's code is reserved: an external app answering to LOGESTECHS
    // would make "installed" ambiguous, and the installs table is keyed on
    // the code alone.
    const clash = await db.app.findFirst({ where: { companyId, code: input.code }, select: { id: true } });
    if (clash || builtInApps(db).some((b) => b.code === input.code)) {
      return NextResponse.json({ error: 'هذا الرمز مستخدم بالفعل' }, { status: 409 });
    }

    // The signing secret. Generated here — never chosen by the caller, who
    // would choose a weak one — shown once, and stored encrypted.
    const secret = `zk_${crypto.randomBytes(32).toString('hex')}`;

    const app = await db.app.create({
      data: {
        companyId,
        code: input.code,
        name: input.name,
        description: input.description || null,
        developerName: input.developerName || null,
        webhookUrl: input.webhookUrl,
        events: JSON.stringify(events),
        secret: encryptSecret(secret),
        createdById: user.id,
      },
      select: { id: true, code: true, name: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'APP_REGISTERED',
      entity: 'App',
      entityId: app.id,
      // The secret is never in the audit log: an audit log holding secrets
      // is a second place to steal them from.
      newData: { code: app.code, name: app.name, events, webhookUrl: input.webhookUrl },
    });

    return NextResponse.json({
      success: true,
      app,
      // The only time this is ever returned.
      secret,
      notice: 'احفظ هذا السرّ الآن — لن يُعرض مرة أخرى.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
