/**
 * POST /api/whatsapp/bot/test — «اختبر الاتصال»: one tiny request to the bot's model (no customer, no order in it).
 *
 * `whatsapp.manage`. With a key in the body it tests THAT key before it is saved; without, the saved one. The address is
 * checked by the AI screen's rule (`parseCompatEndpoint`) before anything is dialled. The answer is the model's name, the
 * time and its word, or why it failed — never the key.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { parseCompatEndpoint, parseCompatModel } from '@/lib/ai-endpoint';
import { loadBotSettings } from '@/lib/whatsapp/bot/settings';
import { pingModel } from '@/lib/whatsapp/bot/llm';

const bodySchema = z.object({
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(512).optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requirePermission('whatsapp.manage');
    const { companyId } = await tenantOf(user);
    const rl = rateLimit(`wa-bot-test:${companyId}`, 10, 60_000);
    if (!rl.allowed) return NextResponse.json({ ok: false, error: `محاولات كثيرة — أعد بعد ${rl.retryAfterSec} ثانية` }, { status: 429 });
    const body = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return NextResponse.json({ ok: false, error: 'طلب غير صالح' }, { status: 400 });

    const saved = await loadBotSettings(companyId);
    const url = parseCompatEndpoint(body.data.baseUrl || saved.baseUrl);
    if (!url.ok) return NextResponse.json({ ok: false, error: url.message });
    let model = saved.model;
    if (body.data.model !== undefined) {
      if (body.data.model) {
        const m = parseCompatModel(body.data.model);
        if (!m.ok) return NextResponse.json({ ok: false, error: m.message });
        model = m.model;
      } else model = null;
    }
    const apiKey = body.data.apiKey || saved.apiKey;
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: saved.keyUnreadable ? 'المفتاح المحفوظ ما عاد ينقرأ — أدخله من جديد' : 'أدخل مفتاح الموديل أولاً' });
    }
    return NextResponse.json(await pingModel({ baseUrl: url.url, apiKey, model }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
