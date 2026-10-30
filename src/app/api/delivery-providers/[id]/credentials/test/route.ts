import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { courierScope } from '@/lib/couriers/scope';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { decryptJson } from '@/lib/secrets';
import { CourierRefusal, logesTechsFromCredentials, type LogesTechsCredentials } from '@/lib/couriers/logestechs';

/**
 * POST — does the saved account actually work?
 *
 * "Saved" and "works" are different facts, and the screen could only report
 * the first.
 *
 * It asks the courier something harmless and read-only — their city list —
 * and reports whether the answer came back. It creates nothing, cancels
 * nothing and costs nothing.
 *
 * WHAT IT PROVES, EXACTLY. The city list carries the company id (the `company-id` header, like every call) and no
 * password, so a good answer proves the network path and the company id — and NOT the password. The password is
 * first proven by the first dispatch. The message says so; it never says «الحساب يعمل».
 *
 * The password is never read by the caller. It is decrypted here, used for
 * one request, and the response says only whether it was accepted.
 */

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settings.manage');
    const { id } = await params;

    const provider = await db.deliveryProvider.findFirst({
      where: { id, ...courierScope(companyId, storeId) },
      select: { id: true, name: true, adapterCode: true, code: true, apiCredentials: true },
    });
    if (!provider) return NextResponse.json({ error: 'غير موجود' }, { status: 404 });

    if (!provider.apiCredentials) {
      return NextResponse.json({ ok: false, reason: 'NO_ACCOUNT', message: 'لا حساب محفوظ بعد.' });
    }

    const key = (provider.adapterCode || provider.code || '').trim().toUpperCase();
    if (key !== 'LOGESTECHS') {
      return NextResponse.json({
        ok: false,
        reason: 'NO_TEST',
        message: 'لا يوجد فحص آلي لهذه الشركة.',
      });
    }

    const stored = decryptJson<LogesTechsCredentials>(provider.apiCredentials);
    if (!stored) {
      // The row holds something we can no longer read — almost always a
      // changed encryption key. Saying so beats "wrong password".
      return NextResponse.json({
        ok: false,
        reason: 'UNREADABLE',
        message: 'تعذّر فكّ تشفير الحساب المحفوظ — غالباً تغيّر مفتاح التشفير. أعد إدخال الحساب.',
      });
    }

    const adapter = logesTechsFromCredentials(stored);
    if (!adapter) {
      return NextResponse.json({ ok: false, reason: 'INCOMPLETE', message: 'الحساب المحفوظ ناقص.' });
    }

    const started = Date.now();
    let result: { ok: boolean; reason: string; message: string };
    try {
      // Their city search: read-only. It carries the company id and no password, so it proves the company id and the
      // network path — the password is proven at the first dispatch.
      const cityId = await adapter.findCityId('عمان');
      const took = Date.now() - started;
      result = {
        ok: true,
        reason: cityId ? 'OK' : 'OK_NO_MATCH',
        message: `وصلنا للشركة خلال ${took}ms ورقم الشركة مقبول. كلمة المرور تُفحص عند أول ترحيل.`,
      };
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Their own words, trimmed — the adapter has already taken the account's secrets out of them, and the request
      // body is never part of them. Blaming the user name and password for every 4xx sent people to retype a right
      // password; the city list carries none.
      const refused = e instanceof CourierRefusal;
      result = {
        ok: false,
        reason: refused ? 'REFUSED' : 'UNREACHABLE',
        message: refused
          ? `ردّت الشركة برفض (${e.status})${e.said ? `: ${e.said.slice(0, 200)}` : ''}`
          : 'تعذّر الوصول إلى الشركة — قد تكون خدمتهم متوقفة أو الشبكة محجوبة.',
      };
      await logAudit({
        companyId,
        userId: user.id,
        action: 'COURIER_CREDENTIALS_TEST_FAILED',
        entity: 'DeliveryProvider',
        entityId: provider.id,
        // Their message, never ours to the screen — and never the password.
        newData: { courier: provider.name, reason: result.reason, courierSaid: raw.slice(0, 300) },
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
