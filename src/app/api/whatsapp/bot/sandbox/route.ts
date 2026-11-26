/**
 * POST /api/whatsapp/bot/sandbox — «جرّبه»: the owner talks to the order bot as a made-up customer.
 *
 * `whatsapp.manage` (every turn asks the model, which costs). `{ start: { productId? } }` opens a practice order on a real
 * product of the company; `{ transcript, state, changedAt }` runs one turn of the SAME engine (`runSandboxTurn`) against
 * that order. Nothing is written to any order, nothing is sent to WhatsApp, and nothing of the chat is stored: the screen
 * holds the transcript and sends it back.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { rateLimit } from '@/lib/rate-limit';
import { loadBotSettings } from '@/lib/whatsapp/bot/settings';
import { openSandbox, SandboxMissing, type SandboxState } from '@/lib/whatsapp/bot/sandbox-door';
import { runSandboxTurn } from '@/lib/whatsapp/bot/engine';
import { LlmError } from '@/lib/whatsapp/bot/llm';

const lineSchema = z.object({ role: z.enum(['customer', 'bot']), text: z.string().max(4096) });
const bodySchema = z.union([
  z.object({ start: z.object({ productId: z.string().max(64).optional().nullable() }) }),
  z.object({
    transcript: z.array(lineSchema).min(1).max(120),
    changedAt: z.number().int().min(0).max(200),
    state: z.object({ productId: z.string().min(1).max(64), order: z.record(z.string(), z.unknown()) }),
  }),
]);

export async function POST(req: Request) {
  try {
    const user = await requirePermission('whatsapp.manage');
    const { companyId } = await tenantOf(user);
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 });

    if ('start' in parsed.data) {
      try {
        return NextResponse.json({ state: await openSandbox(companyId, parsed.data.start.productId ?? null), changedAt: 0 });
      } catch (e) {
        if (e instanceof SandboxMissing) return NextResponse.json({ error: e.message }, { status: 409 });
        throw e;
      }
    }

    const rl = rateLimit(`wa-bot-sandbox:${companyId}`, 30, 60_000);
    if (!rl.allowed) return NextResponse.json({ error: `محاولات كثيرة — أعد بعد ${rl.retryAfterSec} ثانية` }, { status: 429 });
    const settings = await loadBotSettings(companyId);
    if (!settings.apiKey) return NextResponse.json({ error: 'احفظ مفتاح الموديل أولاً، بعدين جرّب' }, { status: 409 });

    // The practice order is the company's own product: a product id of another company is refused like a missing one.
    const fresh = await openSandbox(companyId, parsed.data.state.productId).catch(() => null);
    if (!fresh || fresh.productId !== parsed.data.state.productId) return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    const state: SandboxState = { productId: fresh.productId, order: { ...fresh.order, ...(parsed.data.state.order as object), product: fresh.order.product, offers: fresh.order.offers, cities: fresh.order.cities } };

    try {
      const turn = await runSandboxTurn(settings, { transcript: parsed.data.transcript, state, changedAt: parsed.data.changedAt });
      return NextResponse.json(turn);
    } catch (e) {
      if (e instanceof LlmError) return NextResponse.json({ error: e.message }, { status: 502 });
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
