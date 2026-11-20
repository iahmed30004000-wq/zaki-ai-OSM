import { allowedHosts, chatCompletionsUrl, parseLocalEndpoint } from './ai-endpoint';
import { decryptSecret } from './secrets';
import { SYSTEM_AI, readSystemSetting } from './system-settings';
import { providerInfo } from './ai-provider/catalogue';
import { routeFor } from './ai-provider/routing';
import type { SystemAi } from './ai-provider/settings';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «اختبار خادمك» — DOES THE OWNER'S OWN MODEL SERVER ANSWER? (20/11, A1)
 *
 * The owner runs a model in his own container and saves its address under
 * «نموذج على خادمك». The general «اختبار الاتصال» asks whatever the default
 * route is — often a vendor — so it cannot say whether THAT server is up.
 * This asks the saved server itself one fixed, harmless question and
 * repeats what really came back, in Arabic.
 *
 * ONLY THE PROTOCOL THE LOCAL PROVIDER ALREADY SPEAKS: a POST to
 * `/v1/chat/completions` in the OpenAI shape (`chatCompletionsUrl`). A
 * server that speaks something else is not adapted to — it is told so:
 * «الخادم ما بيحكي بنفس اللغة».
 *
 * WHAT IT WILL NOT DO, and why:
 *   - dial anything but the SAVED address, re-judged here by the very rule
 *     the save used (`parseLocalEndpoint` + the owner's own
 *     AI_LOCAL_ALLOWED_HOSTS). Nothing typed into the request is dialled;
 *   - follow a redirect: `redirect: 'manual'`, and any 3xx is reported as
 *     refused — the hop is never taken, to that host or any other;
 *   - wait long: a short timeout, then «ما ردّ»;
 *   - send a customer: the question is a fixed «ping»;
 *   - echo the key: it rides in a header, and the reply is scrubbed of it
 *     by value before it is shown.
 * ═══════════════════════════════════════════════════════════════════════
 */

export type LocalProbeCode =
  | 'NO_ADDRESS'
  | 'ADDRESS_REFUSED'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'REDIRECT_REFUSED'
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'NOT_OPENAI'
  | 'SERVER_ERROR';

export interface LocalProbeOk {
  ok: true;
  host: string;
  model: string;
  /** The first words the server answered with. */
  reply: string;
}

export interface LocalProbeFail {
  ok: false;
  code: LocalProbeCode;
  errorAr: string;
  host: string | null;
  model: string;
  /** The HTTP status, when the server answered with one. */
  status?: number;
}

export type LocalProbeResult = LocalProbeOk | LocalProbeFail;

/** The fixed question. No company prompt, no customer — nothing to leak. */
export const PROBE_SYSTEM = 'Reply with the single word: OK';
export const PROBE_USER = 'ping';
export const PROBE_TIMEOUT_MS = 15_000;
/** How much of an answer is read at most, to classify it. */
const MAX_READ = 20_000;

export interface ProbeInput {
  savedUrl: string | null | undefined;
  allowed: string[];
  model: string;
  key: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Remove the key we sent from anything the server says back. */
function scrub(text: string, key: string | null): string {
  if (!key || key.length < 8) return text;
  let out = text;
  for (const spelling of new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)])) {
    out = out.split(spelling).join('«مفتاح»');
  }
  return out;
}

async function readBounded(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, MAX_READ);
  } catch {
    return '';
  }
}

export async function probeLocalServer(input: ProbeInput): Promise<LocalProbeResult> {
  const { model, key } = input;
  const fail = (code: LocalProbeCode, errorAr: string, host: string | null, status?: number): LocalProbeFail => ({
    ok: false,
    code,
    errorAr,
    host,
    model,
    ...(status !== undefined ? { status } : {}),
  });

  if (!input.savedUrl) {
    return fail('NO_ADDRESS', 'ما في عنوان خادم محفوظ — اكتب العنوان تحت «نموذج على خادمك» واحفظ أولاً.', null);
  }
  // The save's own rule, again — a stored address that no longer passes it is
  // refused here with the rule's own sentence, and nothing is dialled.
  const checked = parseLocalEndpoint(input.savedUrl, input.allowed);
  if (!checked.ok) return fail('ADDRESS_REFUSED', checked.message, null);
  const host = checked.host;

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(chatCompletionsUrl(checked.url), {
      method: 'POST',
      signal: controller.signal,
      // Never followed: a redirect is reported, the hop is not taken.
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PROBE_SYSTEM },
          { role: 'user', content: PROBE_USER },
        ],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === 'AbortError');
    return aborted
      ? fail('TIMEOUT', 'الخادم ما ردّ خلال المهلة —تأكّد إنه شغّال وإن النموذج محمّل.', host)
      : fail('UNREACHABLE', 'ما قدرنا نوصل للخادم — تأكّد من العنوان والمنفذ وإن الخادم شغّال وعلى نفس الشبكة.', host);
  }

  try {
    const status = res.status;
    if (res.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      return fail('REDIRECT_REFUSED', 'الخادم حوّلنا لعنوان تاني — ما بنلحق التحويل. اكتب العنوان النهائي للخادم نفسه.', host, status || undefined);
    }
    if (status === 401 || status === 403) {
      return fail(
        'AUTH',
        key
          ? 'الخادم رفض المفتاح المحفوظ — تأكّد إنه مفتاح هالخادم.'
          : 'الخادم طلب مفتاح — الصق مفتاحه بخانة «نموذج على خادمك» واحفظ.',
        host,
        status
      );
    }
    if (!res.ok) {
      const said = scrub(await readBounded(res), key);
      if ((status === 404 || status === 400) && /model/i.test(said)) {
        return fail('MODEL_NOT_FOUND', `النموذج «${model}» مش موجود على خادمك — اكتب اسم نموذج محمّل عليه.`, host, status);
      }
      if (status === 404 || status === 405) {
        return fail(
          'NOT_OPENAI',
          'الخادم ما بيحكي بنفس اللغة — ما عنده /v1/chat/completions على هالعنوان.',
          host,
          status
        );
      }
      return fail('SERVER_ERROR', `الخادم ردّ بخطأ ${status}.`, host, status);
    }

    const text = await readBounded(res);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return fail('NOT_OPENAI', 'الخادم ما بيحكي بنفس اللغة — ردّ بشي مش على شكل OpenAI.', host, status);
    }
    const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return fail('NOT_OPENAI', 'الخادم ما بيحكي بنفس اللغة — ردّ بشي مش على شكل OpenAI.', host, status);
    }
    const reply = scrub(content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, ''), key).trim().slice(0, 120);
    return { ok: true, host, model, reply };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The saved server, its key and the model to ask — read on the server, never
 * from the request. The model is the one a LOCAL call of this company would
 * use; when LOCAL is not the route, the installation's LOCAL choice, then the
 * provider's own default.
 */
export async function testSavedLocalServer(companyId: string, fetchImpl?: typeof fetch): Promise<LocalProbeResult> {
  const sys = (await readSystemSetting<SystemAi>(SYSTEM_AI)) ?? {};
  const route = await routeFor(companyId);
  const model =
    route.provider === 'LOCAL'
      ? route.model
      : (sys.provider === 'LOCAL' && sys.model) || providerInfo('LOCAL').defaultModel;
  let key: string | null = null;
  const enc = sys.keys?.LOCAL?.enc;
  if (enc) {
    try {
      key = decryptSecret(enc);
    } catch {
      key = null;
    }
  }
  return probeLocalServer({ savedUrl: sys.localBaseUrl ?? null, allowed: allowedHosts(), model, key, fetchImpl });
}
