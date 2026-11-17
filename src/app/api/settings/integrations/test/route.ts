import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { getMe } from '@/lib/telegram/cloud-api';
import { GRAPH_BASE, GRAPH_VERSION, getAccessToken, getPhoneNumberId } from '@/lib/whatsapp/config';

/**
 * POST /api/settings/integrations/test — «جرّب» next to the saved settings (the media buyer's doors, PR-C).
 *
 * `{ group: 'telegram' }` asks Telegram who the bot is (`getMe`); `{ group: 'whatsapp' }` asks Meta for the phone number's own name. Both with what is configured NOW (saved on
 * the site, else the environment). The answer is a verdict and a name — «يشتغل · @zaki_bot» — and never a token, an id or Telegram's / Meta's raw reply. The key needed is the
 * card's own, as for saving.
 */

const schema = z.object({ group: z.enum(['telegram', 'whatsapp']) }).strict();

export async function POST(req: Request) {
  try {
    await requireContext();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'الطلب مش بالشكل المطلوب', code: 'INVALID_BODY' }, { status: 400 });

    if (parsed.data.group === 'telegram') {
      await requirePermission('telegram.connect');
      const me = await getMe();
      if (!me.ok) {
        const why = me.errorCode === 'NO_TOKEN' ? 'ما في رمز بوت محفوظ' : me.errorCode === 'API_ERROR' ? 'تيليجرام رفض الرمز' : 'تعذّر الوصول لتيليجرام';
        return NextResponse.json({ ok: false, message: why });
      }
      return NextResponse.json({ ok: true, message: `يشتغل${me.result?.username ? ` · @${me.result.username}` : ''}` });
    }

    await requirePermission('whatsapp.manage');
    const [token, phoneNumberId] = await Promise.all([getAccessToken(), getPhoneNumberId()]);
    if (!token || !phoneNumberId) return NextResponse.json({ ok: false, message: 'رمز الوصول أو معرّف رقم الهاتف ناقص' });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      const data = (await res.json().catch(() => null)) as { verified_name?: unknown; display_phone_number?: unknown; error?: unknown } | null;
      if (!res.ok || data?.error) return NextResponse.json({ ok: false, message: 'ميتا رفضت الرمز أو المعرّف' });
      const name = typeof data?.verified_name === 'string' ? data.verified_name : null;
      return NextResponse.json({ ok: true, message: `يشتغل${name ? ` · ${name}` : ''}` });
    } catch {
      return NextResponse.json({ ok: false, message: 'تعذّر الوصول لميتا' });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
