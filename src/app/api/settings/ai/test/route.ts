import { NextResponse } from 'next/server';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { aiChat, describeRoute } from '@/lib/ai-provider';
import { explainAiError } from '@/lib/ai-error-message';
import { tooManyAiCalls } from '@/lib/ai-rate';
import { testSavedLocalServer } from '@/lib/ai-local-probe';

/**
 * POST /api/settings/ai/test — does the key actually work?
 *
 * A key is pasted in and saved, and nothing happens until somebody asks a
 * real question days later and gets a silent fallback answer. The provider
 * never says "your key is wrong" anywhere a seller looks — the assistant
 * simply stops being an assistant.
 *
 * So the settings screen asks the provider one cheap question and reports
 * exactly what came back. The key is never returned, never logged, and
 * never echoed in the answer: the reply says whether it worked, not what
 * it was.
 */


export async function POST(req?: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    // Testing spends the company's own credit with their provider.
    await requirePermission('settings.manage');

    /*
     * ── «اختبار خادمك»: THE OWNER'S OWN SERVER, NOT THE DEFAULT ROUTE (20/11, A1) ──
     *
     * `{ target: 'LOCAL' }` asks the SAVED «نموذج على خادمك» address itself,
     * whatever the default route is. Nothing in the body is dialled — only
     * the word `target` is read; the address, the key and the model are the
     * server's own (`testSavedLocalServer`). The address is the
     * installation's, so the same narrowing as the system settings door
     * applies, and a press is rate-limited: it makes this server dial.
     */
    const body = req ? await req.json().catch(() => null) : null;
    if (body && typeof body === 'object' && (body as { target?: unknown }).target === 'LOCAL') {
      if (user.role !== 'SUPER_ADMIN') {
        const msg = 'إعدادات الذكاء على مستوى النظام يضبطها مدير النظام فقط.';
        return NextResponse.json({ ok: false, error: msg, errorAr: msg, code: 'SUPER_ADMIN_ONLY' }, { status: 403 });
      }
      const limited = tooManyAiCalls('settings-test-local', companyId, user.id, 6);
      if (limited) return limited;
      const probe = await testSavedLocalServer(companyId);
      return NextResponse.json(
        probe.ok
          ? { ok: true, provider: 'LOCAL', host: probe.host, model: probe.model, reply: probe.reply }
          : {
              ok: false,
              provider: 'LOCAL',
              code: probe.code,
              error: probe.errorAr,
              errorAr: probe.errorAr,
              host: probe.host,
              model: probe.model,
              ...(probe.status !== undefined ? { status: probe.status } : {}),
            }
      );
    }

    /**
     * ── IT REPORTS WHERE IT WENT, NOT WHAT THE COMPANY CHOSE ──
     *
     * The answer used to be labelled with `aiSettings()`'s provider and
     * model — the COMPANY's choice. The call itself is routed by the same
     * resolution every other call uses, which also reads the installation
     * default and the keys that actually exist. So the two disagreed
     * exactly when it mattered: the owner read «Anthropic» under a reply
     * that had come from OpenRouter, pressed on, and the assistant kept
     * answering from somewhere he had not chosen.
     *
     * And `keyFrom` is reported with it, because «it worked» raises the
     * next question by itself — with WHICH key — and the answer decides
     * who pays for it.
     */
    const route = await describeRoute(companyId);

    try {
      const reply = await aiChat({
        companyId,
        // No house prompt and no job wording: this asks whether the key and
        // the model work, and a company prompt could make it fail for a
        // reason that has nothing to do with the connection.
        system: 'Reply with the single word: OK',
        user: 'ping',
        timeoutMs: 15_000,
      });

      return NextResponse.json({
        ok: true,
        provider: route.provider,
        model: route.model,
        keyFrom: route.keyFrom,
        // The first words back, so a seller sees a real reply rather than a
        // green tick they have to trust.
        reply: reply.trim().slice(0, 120),
      });
    } catch (error) {
      return NextResponse.json({
        ...explainAiError(error),
        provider: route.provider,
        model: route.model,
        keyFrom: route.keyFrom,
      });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
