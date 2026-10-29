import { AiEndpointMissing, AiNotConfigured } from './ai-provider';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG, IN WORDS THE OWNER CAN ACT ON.
 *
 * Lifted out of `POST /api/settings/ai/test` so it can be read without a
 * request. A Next.js route file may only export its handlers, so a mapper
 * that lives there is a mapper nobody can test — and this one decides what
 * the owner is told when the assistant stops working, which is exactly the
 * moment a wrong sentence costs an hour.
 * ═══════════════════════════════════════════════════════════════════════
 */
export function explainAiError(error: unknown): { ok: false; error: string } {
  if (error instanceof AiEndpointMissing) {
    // A local model, or an OpenAI-compatible server, was chosen and nobody
    // said where it lives (or the saved address no longer passes the check).
    // Distinct from "no key": the local provider usually needs no key at all,
    // so telling somebody to paste one would send them looking for a thing
    // that does not exist. «العنوان» stays in the sentence: the connection
    // test pins it.
    return { ok: false, error: 'لم يُحفظ عنوان الخادم بعد — اكتب العنوان في «حسابات المزوّدين» واحفظ.' };
  }
  if (error instanceof AiNotConfigured) {
    return { ok: false, error: 'لم يُحفظ مفتاح بعد — الصق المفتاح واحفظ، ثم جرّب الاتصال.' };
  }
  const message = error instanceof Error ? error.message : '';
  /*
   * `AI_HTTP_<status>|<model>|<what the vendor said>` — the status alone
   * was not enough to answer two of the commonest failures in words the
   * owner can act on.
   */
  /*
   * Both shapes, because both exist: the vendor suffix is added where the
   * response is in hand, and a thrower that only knows the status still
   * says `AI_HTTP_429`. A mapper that understood only the new one answered
   * «تعذّر الوصول إلى المزوّد» to a refused key — the generic sentence, for
   * the one case it had a precise one for.
   */
  const [, status, model, said] = message.match(/^AI_HTTP_(\d+)(?:\|([^|]*)\|([\s\S]*))?$/) ?? [];

  if (status === '401' || status === '403') {
    return { ok: false, error: 'المزوّد رفض المفتاح — تأكد أنه مفتاح هذا المزوّد وأنه ما زال صالحاً.' };
  }
  /*
   * ANTHROPIC'S EMPTY WALLET IS A 400, NOT A 402.
   *
   * «Your credit balance is too low to access the Anthropic API» arrives
   * with the same status as a malformed request, so it used to read
   * «المزوّد ردّ بخطأ 400» — which sent the owner looking for a bug in his
   * settings. And the usual cause is not an empty wallet at all: it is a
   * key issued by a different organisation from the one holding the
   * credit, which is why the sentence says so.
   */
  if (status === '400' && /credit balance/i.test(said ?? '')) {
    return {
      ok: false,
      error: 'رصيدك عند Anthropic صفر — المفتاح لازم يكون من نفس المنظمة اللي فيها الرصيد.',
    };
  }
  if (status === '404') {
    // Naming it matters: «اختر نموذجاً من القائمة» on its own leaves the
    // owner guessing which of the names he is looking at was refused.
    return {
      ok: false,
      error: model
        ? `النموذج «${model}» غير موجود عند هذا المزوّد — اختر نموذجاً من القائمة.`
        : 'النموذج غير موجود عند هذا المزوّد — اختر نموذجاً من القائمة.',
    };
  }
  if (status === '429') {
    return { ok: false, error: 'المزوّد يطلب التمهّل — الحساب تجاوز حدّه أو رصيده انتهى.' };
  }
  if (status) return { ok: false, error: `المزوّد ردّ بخطأ ${status}.` };
  if (message.includes('abort')) {
    return { ok: false, error: 'انتهت المهلة بلا رد — تحقق من الاتصال بالإنترنت من الخادم.' };
  }
  return { ok: false, error: 'تعذّر الوصول إلى المزوّد.' };
}
