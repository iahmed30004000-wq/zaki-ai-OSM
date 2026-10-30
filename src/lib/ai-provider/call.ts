import { ASSISTANTS } from '../ai-assistants';
import { resolvePrompt } from '../ai-prompts';
import { chatCompletionsUrl } from '../ai-endpoint';
import type { AiProvider } from './catalogue';
import { aiSettings } from './settings';
import { routeFor } from './routing';

/**
 * THE CALL: the request shape, the refusals, and the one fetch to a model.
 * The localOnly and pii guards, the timeout and the redirect rule all live in `aiChat` below.
 */

/**
 * ── WHAT THE VENDOR ACTUALLY SAID, CARRIED WITH THE STATUS ──
 *
 * The thrown error used to be the status and nothing else, so every 400
 * from Anthropic arrived at the owner as «المزوّد ردّ بخطأ 400» — including
 * the one that means «your credit balance is too low», which is not a
 * programming error at all and has a four-word answer he can act on.
 *
 * The body is the VENDOR's words about the request. It carries no key: the
 * key goes up in a header and nothing sends it back. Trimmed to 300
 * characters so a vendor's HTML error page cannot become the message.
 */
async function vendorError(res: Response, model: string, key?: string | null): Promise<Error> {
  let said = '';
  try {
    // Bounded before it is scrubbed (a vendor's HTML page can be large) but NOT
    // cut to the message length yet: a key that straddles character 300 would
    // be cut in two, and neither half equals the key any more.
    said = (await res.text()).slice(0, 20_000);
  } catch {
    said = '';
  }
  /*
   * ── THE KEY WE SENT, BY ITS EXACT VALUE ──
   *
   * The patterns below know the shapes of the big vendors' keys. A gateway's
   * key has no shape (`gw.…`, a bare token), and a server that echoes the
   * request back would print it into the log. The key is known — it is the
   * one this call carried — so every occurrence is removed by value, in the
   * three spellings an echo takes: as it is, JSON-escaped, and URL-encoded.
   * Shorter than 8 characters is not removed: that would eat ordinary words.
   */
  if (key && key.length >= 8) {
    const spellings = new Set([key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]);
    for (const spelling of spellings) said = said.split(spelling).join('«مفتاح»');
  }
  /*
   * ── AND NOTHING KEY-SHAPED SURVIVES THE TRIP ──
   *
   * The body is the vendor's words about OUR request, and some vendors
   * quote the request back. OpenAI's 401 reads «Incorrect API key
   * provided: sk-proj-…», and a proxy in front of a local model can echo
   * the whole `Authorization` header.
   *
   * This message is thrown, and three callers log the error — the daily
   * summary, the assistant and the order intake all `console.warn` it. So
   * without this line a rotated key would put its own prefix in the
   * server log, in a repository that deliberately refuses to show even
   * the last four characters on the settings screen.
   *
   * The body is kept for CLASSIFICATION — «credit balance» and nothing
   * else is read out of it — so redacting it costs nothing.
   */
  const scrubbed = said
    .replace(/(sk|sk-ant|sk-or|sk-proj|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{6,}/gi, '«مفتاح»')
    .replace(/(Bearer|x-api-key|api[-_]?key)\s*[:=]?\s*[A-Za-z0-9_\-.]{12,}/gi, '$1 «مفتاح»');
  return new Error(`AI_HTTP_${res.status}|${model}|${scrubbed.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
}

/**
 * A PICTURE THAT GOES WITH THE WORDS — base64, never a URL.
 *
 * A URL would mean the vendor fetching it, which means the image must be
 * public, which means a seller's product photograph behind a signed media
 * route either fails or has to be opened to the world. The bytes go in the
 * request instead, so nothing about the shop has to be reachable from
 * outside to make this work.
 *
 * Only the three types this product stores (`storage.ts`:
 * `ALLOWED_MIME_TYPES`) — a type list that is wider than what can be
 * uploaded is a list that invites somebody to pass a PDF.
 */
export interface AiImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** The raw bytes, base64, with no `data:` prefix. */
  base64: string;
}

export interface ChatRequest {
  companyId: string;
  /**
   * The words for this call. Pass a `job` instead to use the company's own
   * wording for one of the named jobs — which is what every caller in the
   * system does, so that editing a prompt in settings actually changes
   * what the model is told.
   */
  system?: string;
  /** A key from AI_JOBS. Its prompt is resolved per company. */
  job?: string;
  user: string;
  /**
   * PICTURES THE MODEL IS MEANT TO READ — and the caller has already asked
   * whether it can.
   *
   * The landing-page builder is the first caller: the owner presses
   * «ابنيلي صفحة الهبوط» and the model reads the box in the product's own
   * photograph. `ai-vision.ts` decides whether the chosen model reads
   * images at all, and a caller that skips that check will have its image
   * ignored by a text model — or, worse, answered with an invented box.
   *
   * ⚠️ A PRODUCT PHOTOGRAPH IS NOT CUSTOMER DATA, which is why this is
   * allowed to leave the building at all: the owner's rule names «اسم ·
   * رقم · عنوان», and S3's own text settles it — «صور المنتج مش بيانات
   * زباين، فبتمشي حسب توجيه إعدادات الذكاء». A caller that ever wants to
   * send a picture WITH a person in it passes `localOnly` as well, and
   * this field changes nothing about that check.
   */
  images?: readonly AiImage[];
  /** Ask for a JSON object back. Only OpenRouter and OpenAI honour it. */
  json?: boolean;
  timeoutMs?: number;
  /**
   * REFUSE THE CALL UNLESS THE MODEL RUNS ON THE OWNER'S OWN MACHINE.
   *
   * Set by a caller whose payload carries a CUSTOMER — a name, a phone, an
   * address. The order-intake door is the one that does today: a seller
   * pastes a WhatsApp message and the whole of it, the person included, is
   * the prompt.
   *
   * It is a property of the CALL and not of the assistant, because the same
   * company may route one assistant to a vendor and another to a local
   * server, and an assistant row cannot refuse a route it does not choose.
   *
   * The check happens before the first byte leaves: see `aiChat`.
   */
  localOnly?: boolean;
  /**
   * «THE PERSON IS ALREADY OUT OF THIS PAYLOAD.»
   *
   * Set by a caller for an assistant declared `pii: true` that has
   * redacted the customer before building the prompt — the confirmation
   * assistant replaces the name with a placeholder the screen fills in
   * from the order it is already showing, and sends `hasNotes` instead of
   * the notes.
   *
   * It is the opposite of `localOnly`: that one says «refuse unless the
   * model is ours», this one says «it is safe anywhere, and here is why».
   * The order extractor never passes it — a pasted WhatsApp message IS
   * the customer, and there is nothing to take out of it.
   */
  piiSafe?: true;
}

export class AiNotConfigured extends Error {
  constructor() {
    super('AI_NOT_CONFIGURED');
  }
}

/** A local model was chosen and nobody said where it lives. */
export class AiEndpointMissing extends Error {
  constructor() {
    super('AI_ENDPOINT_MISSING');
  }
}

/**
 * THE CALLER DEMANDED A LOCAL MODEL AND THE ROUTE POINTS SOMEWHERE ELSE.
 *
 * Thrown BEFORE any request is made, so a payload carrying a customer's
 * name and phone never reaches a vendor. It carries the provider it found
 * because the screen has to tell the seller what to change — «إعدادات
 * الذكاء ← مستخرج الطلبات ← LOCAL» is only actionable if we know it is
 * currently OPENROUTER.
 */
export class AiNotLocal extends Error {
  constructor(readonly provider: AiProvider) {
    super('AI_NOT_LOCAL');
  }
}

/**
 * THE USER TURN, WITH OR WITHOUT PICTURES.
 *
 * One function for both vendor shapes, so the decision «a call with no
 * images sends exactly what it always sent» is made once. That decision is
 * the reason it returns a plain string in the common case: every assertion
 * in this repository about an outgoing payload — and `ai-provider.test.ts`
 * has several — was written against `content: req.user`, and a wrapper
 * applied unconditionally would have rewritten all of them to buy nothing.
 */
function imageContent(req: ChatRequest, shape: 'anthropic' | 'openai'): unknown {
  const images = (req.images ?? []).filter((i) => i && i.base64);
  if (images.length === 0) return req.user;

  if (shape === 'anthropic') {
    return [
      ...images.map((i) => ({
        type: 'image',
        source: { type: 'base64', media_type: i.mediaType, data: i.base64 },
      })),
      { type: 'text', text: req.user },
    ];
  }
  return [
    ...images.map((i) => ({
      type: 'image_url',
      image_url: { url: `data:${i.mediaType};base64,${i.base64}` },
    })),
    { type: 'text', text: req.user },
  ];
}

/**
 * One call, five vendors — and exactly one of them, LOCAL, is ever allowed to
 * receive a customer. The OpenAI-compatible server is an outside party: the
 * two guards below (`localOnly` and the pii declaration) refuse it because it
 * is not LOCAL, and there is deliberately no switch that makes it one.
 *
 * Anthropic's API differs enough to be worth naming: the system prompt is a
 * top-level field rather than a message, the key rides in `x-api-key`, and
 * `max_tokens` is required. Everything else is the OpenAI shape, which
 * OpenRouter also speaks.
 */
export async function aiChat(req: ChatRequest): Promise<string> {
  const settings = await aiSettings(req.companyId);
  // Vendor, model and key for THIS assistant — `req.job` is the assistant.
  const route = await routeFor(req.companyId, req.job);

  /*
   * BEFORE THE KEY, BEFORE THE URL, BEFORE ANYTHING LEAVES.
   *
   * Placed here and not lower because everything below this line is
   * preparation for a network call: the moment the route is known is the
   * last moment at which refusing costs nothing. A caller that passed
   * `localOnly` is a caller whose prompt has a person in it.
   */
  if (req.localOnly && route.provider !== 'LOCAL') {
    throw new AiNotLocal(route.provider);
  }

  /**
   * ── AND THE ASSISTANT'S OWN DECLARATION, WHICH NOBODY WAS READING ──
   *
   * `ai-assistants.ts` marks three assistants `pii: true` — «whether a
   * customer's phone or address may be in its payload». The order intake
   * backs that up with `localOnly`. The confirmation assistant did not:
   * it declared `pii: true` and sent the customer's name and the seller's
   * free-text notes to whatever vendor the route resolved to.
   *
   * A declaration nothing enforces is a comment. So the declaration is
   * read here, at the same line `localOnly` is read, and the call is
   * refused unless the caller says it has already taken the person out —
   * `piiSafe`. The caller says it because only the caller knows what it
   * put in the payload; this function cannot look at a JSON blob and tell
   * a customer's name from a product's.
   *
   * ⚠️ Which means `piiSafe` is a PROMISE, and a caller that passes it
   * while still carrying a name breaks the owner's rule with the guard
   * switched on. 🔧 Every caller that passes it does its redaction in one
   * place, with a test that reads the payload — see the confirmation
   * route.
   */
  if (!req.piiSafe && route.provider !== 'LOCAL' && req.job) {
    const assistant = ASSISTANTS.find((a) => a.promptJob === req.job);
    if (assistant?.pii) throw new AiNotLocal(route.provider);
  }

  const key = route.key;
  /**
   * A LOCAL SERVER IS CONFIGURED BY ITS ADDRESS, NOT BY A KEY.
   *
   * Most of them are not authenticated at all, so demanding a key here would
   * make the one provider the owner actually runs himself the only one he
   * cannot turn on. What it cannot do without is somewhere to send the
   * request.
   */
  if (route.provider === 'LOCAL' || route.provider === 'OPENAI_COMPATIBLE') {
    // For the compatible server `baseUrl` is null when the stored address
    // does not pass `parseCompatEndpoint` — judged here, at the call, and not
    // only when it was saved.
    if (!route.baseUrl) throw new AiEndpointMissing();
  }
  // Every vendor but LOCAL needs a key. A compatible server on the internet
  // is a public https host: it carries one.
  if (route.provider !== 'LOCAL' && !key) {
    throw new AiNotConfigured();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);

  try {
    /**
     * ── THE JOB'S OWN WORDING, AND NEVER THE WORD «undefined» ──
     *
     * `ChatRequest` says it plainly ten lines up: «Pass a `job` instead to
     * use the company's own wording». Three callers do exactly that and
     * pass no `system` — picking, the confirmation assistant and the
     * landing copywriter — and this line never looked the job up. So the
     * template literal stringified `undefined`, and what reached the model
     * was the house prompt, two newlines, and the literal word
     * «undefined» as its instructions. With no house prompt it was
     * `undefined` alone.
     *
     * Three assistants have been running that way. They answered — models
     * answer almost anything — which is why nobody saw it: a worse answer
     * looks like a worse model.
     *
     * `resolvePrompt` is the function the settings screen edits through,
     * so this is the line that makes «عدّلت النصّ» mean something for
     * those three.
     */
    const job = req.system ?? (req.job ? resolvePrompt(req.job, settings.prompts) : '');
    const house = settings.prompt.trim();
    const body = job.trim();
    // Neither half is sent empty: an empty system prompt is a different
    // request from no system prompt, and «\n\n» on its own is noise.
    const system = house && body ? `${house}\n\n${body}` : house || body;

    if (route.provider === 'ANTHROPIC') {
      // Proved by the guard above; re-stated because the compiler cannot
      // narrow across it, and an empty key here would be sent as a real one.
      if (!key) throw new AiNotConfigured();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: route.model,
          max_tokens: 2000,
          system,
          messages: [
            {
              role: 'user',
              /*
               * ── THE PICTURE BEFORE THE WORDS, AND ANTHROPIC'S OWN SHAPE ──
               *
               * Anthropic takes `{ type: 'image', source: { type: 'base64',
               * media_type, data } }` and OpenAI takes an `image_url` with a
               * data URI; they are different enough that one adapter would
               * have to lie to one of them. The image goes FIRST because
               * both vendors document that order for «read this, then do
               * what I say», and a model handed instructions before the
               * picture answers about the instructions.
               *
               * With no images the content stays a plain STRING — the shape
               * every call in this product has always sent, so nothing that
               * does not pass a picture changes at all.
               */
              content: imageContent(req, 'anthropic'),
            },
          ],
        }),
      });
      if (!res.ok) throw await vendorError(res, route.model, key);
      const data = await res.json();
      return data?.content?.[0]?.text ?? '';
    }

    /**
     * OpenAI, OpenRouter, a local server and an OpenAI-compatible server all
     * speak one shape, which is why the owner's own machine needs no adapter
     * — only an address.
     *
     * `route.baseUrl` reached here through `parseLocalEndpoint` (LOCAL) or
     * `parseCompatEndpoint` (OPENAI_COMPATIBLE, judged again in `routeFor`),
     * which are the only things standing between this `fetch` and an address
     * somebody typed. See `ai-endpoint.ts`.
     */
    const url =
      route.provider === 'OPENAI'
        ? 'https://api.openai.com/v1/chat/completions'
        : route.provider === 'LOCAL' || route.provider === 'OPENAI_COMPATIBLE'
          ? chatCompletionsUrl(route.baseUrl as string)
          : 'https://openrouter.ai/api/v1/chat/completions';

    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      // A redirect from the compatible server is an error, not a hop: the
      // body and the Bearer key would be replayed to wherever it points.
      ...(route.provider === 'OPENAI_COMPATIBLE' ? { redirect: 'error' as const } : {}),
      headers: {
        'Content-Type': 'application/json',
        // A local server usually wants no key at all, and sending
        // `Bearer null` is how a server that ignores auth starts refusing.
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(route.provider === 'OPENROUTER'
          ? { 'HTTP-Referer': 'https://salesflow.io', 'X-Title': 'SALESFLOW Business Intelligence' }
          : {}),
      },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: imageContent(req, 'openai') },
        ],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw await vendorError(res, route.model, key);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    // A reasoning model behind a server with no reasoning parser answers with
    // its thinking in front of the answer, and `JSON.parse` of that fails.
    // Only the compatible server, only one leading block — and only when the
    // content IS text: a gateway may return an array of parts, which has no
    // `replace` and is handed back untouched as every other vendor's is.
    return route.provider === 'OPENAI_COMPATIBLE' && typeof content === 'string'
      ? content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '')
      : content;
  } finally {
    clearTimeout(timer);
  }
}
