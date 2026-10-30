import { db } from '../db';
import { decryptSecret } from '../secrets';
import { SYSTEM_AI, readSystemSetting } from '../system-settings';
import { parseCompatEndpoint } from '../ai-endpoint';
import { AI_PROVIDERS, liveModel, providerInfo, type AiProvider } from './catalogue';
import { compatKeyBound, hostOf, readStored, type SystemAi } from './settings';

/**
 * THE ROUTING: where one call goes (vendor, model, key) and the key-free description of it.
 */

/**
 * WHERE ONE CALL GOES: vendor, model and key, for THIS assistant.
 *
 * Resolved in one place because the three have to agree. Pointing an
 * assistant at Anthropic while handing it the OpenAI key is a setting that
 * saves cleanly and fails only when somebody asks a question — so the key
 * is chosen by the provider that was resolved, never by what happens to be
 * stored first.
 *
 * Order, narrowest first:
 *   the assistant's own provider and model
 *   the company's default provider and model
 *   the provider's own default model, when only a provider was chosen
 *
 * Never leaves the server.
 */
export interface AiRoute {
  provider: AiProvider;
  model: string;
  key: string | null;
  /**
   * WHICH stored key this is — never its value. The screen and the test
   * button both need to say «المفتاح من النظام» or «من الشركة», and the
   * only honest source for that is the resolution that picked it.
   */
  keyFrom: KeySource;
  /**
   * LOCAL: the server the owner runs. OPENAI_COMPATIBLE: the address that
   * passed `parseCompatEndpoint` and that the stored key is bound to, or null
   * when either fails. Null for a vendor.
   */
  baseUrl?: string | null;
}

export async function routeFor(companyId: string, job?: string): Promise<AiRoute> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  const ai = readStored(company?.settings ?? null);
  const sys = (await readSystemSetting<SystemAi>(SYSTEM_AI)) ?? {};

  /**
   * ── NARROWEST FIRST, AND A COMPANY'S CHOICE IS NARROWER THAN A
   *    DEFAULT ──
   *
   * This read the installation's provider BEFORE the company's, with the
   * reasoning that «a deployment configured before the system card
   * existed keeps answering without anybody re-entering anything». That
   * holds only for a company that never chose — and it is why «المزوّد»
   * appeared to do nothing: on `main` every key save stamped
   * `SYSTEM_AI.provider`, so every installation that ever saved a key had
   * one, and it beat whatever the company picked. «حطّيت المفتاح وما
   * اشتغل», exactly.
   *
   * The order is the one the task names: the assistant's own choice, then
   * the COMPANY's when it made one, then the installation default, then
   * OpenRouter. `readStored` hands back the raw stored object, so an
   * absent `ai.provider` is genuinely «never chose» and not a default
   * standing in for one — which is what makes «when it chose one»
   * expressible at all.
   */
  const fallback = (AI_PROVIDERS.find((p) => p.id === ai.provider)?.id ??
    AI_PROVIDERS.find((p) => p.id === sys.provider)?.id ??
    'OPENROUTER') as AiProvider;
  const override = job ? ai.assistants?.[job] : undefined;
  const chosen = AI_PROVIDERS.find((p) => p.id === override?.provider)?.id as AiProvider | undefined;
  const provider = chosen ?? fallback;

  // A model belongs to a vendor. When the assistant switched vendor and
  // named no model, the company's model is the WRONG default — it is the
  // other vendor's name — so the new vendor's own default is used.
  // `liveModel` repairs a name that was offered and is not real — a setting
  // saved as `claude-sonnet-4-5` would otherwise 404 on every call for ever.
  const model = liveModel(
    override?.model?.trim() ||
      (provider === 'OPENAI_COMPATIBLE'
        // The name the server answers to lives beside its address. The
        // company's stamped model belongs to ANOTHER vendor and would 404.
        ? sys.compat?.model || providerInfo(provider).defaultModel
        : chosen && chosen !== fallback
        ? providerInfo(provider).defaultModel
        // The same order as the vendor above: the company's own model
        // first, because it is the narrower statement.
        : ai.model || sys.model || providerInfo(provider).defaultModel)
  );

  let key: string | null = null;
  let keyFrom: KeySource = 'none';
  /*
   * THE COMPATIBLE SERVER'S ADDRESS, JUDGED AGAIN AT THE CALL.
   *
   * The route checked it when it was saved; a document edited by hand does
   * not pass through the route. And its key is used only while it is the key
   * issued for THIS address — otherwise it would be sent to whatever host the
   * address now names.
   */
  const compatChecked = provider === 'OPENAI_COMPATIBLE' && sys.compat?.baseUrl ? parseCompatEndpoint(sys.compat.baseUrl) : null;
  const compatUrl = compatChecked && compatChecked.ok ? compatChecked.url : null;
  // The installation's key for THIS vendor, then the company's own. The
  // compatible server has no company key and no legacy one.
  const fromSystem =
    provider === 'OPENAI_COMPATIBLE'
      ? compatUrl && compatKeyBound(sys)
        ? sys.keys?.OPENAI_COMPATIBLE?.enc
        : undefined
      : sys.keys?.[provider]?.enc;
  const fromCompany = provider === 'OPENAI_COMPATIBLE' ? undefined : ai.keys?.[provider]?.enc;
  const stored = fromSystem ?? fromCompany;
  if (stored) {
    try {
      key = decryptSecret(stored);
      keyFrom = fromSystem ? 'system' : 'company';
    } catch {
      key = null;
    }
  } else if (provider !== 'OPENAI_COMPATIBLE' && provider === fallback && ai.apiKeyEncrypted) {
    // The legacy single key belongs to whichever provider was the default
    // when it was entered — never handed to a vendor it was not issued by.
    try {
      key = decryptSecret(ai.apiKeyEncrypted);
      keyFrom = 'legacy';
    } catch {
      key = null;
    }
  }
  if (!key && provider === 'OPENROUTER') {
    key = process.env.OPENROUTER_API_KEY ?? null;
    if (key) keyFrom = 'env';
  }
  if (!key) keyFrom = 'none';

  return {
    provider,
    model,
    key,
    keyFrom,
    baseUrl: provider === 'LOCAL' ? sys.localBaseUrl ?? null : compatUrl,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE A CALL WOULD GO, WITHOUT CARRYING THE KEY THERE.
 *
 * The settings screen needs to say «بيروح على: Anthropic · claude-sonnet-5-5
 * — المفتاح من النظام» beside each assistant, and the test button needs to
 * report the same thing. Both of those used to re-derive it: the screen
 * read the company's own provider and model, and the test labelled its
 * answer with those — so a call routed by an assistant override, or by the
 * installation default, was described as something else entirely. Two
 * answers to one question, and the wrong one on the screen.
 *
 * This is the same resolution `aiChat` uses, with the key dropped before
 * it leaves. `keyFrom` says WHICH stored key would be used, never its
 * value — that is the whole reason this exists rather than a `route.key`
 * the screen could read.
 * ═══════════════════════════════════════════════════════════════════════
 */
export type KeySource = 'system' | 'company' | 'legacy' | 'env' | 'none';

export interface RouteDescription {
  provider: AiProvider;
  model: string;
  keyFrom: KeySource;
  /**
   * The local server's address when the route is LOCAL. For the compatible
   * server it is the HOST NAME ONLY: this description reaches every company
   * that can open the AI screen, and the full address is the installation's.
   */
  baseUrl: string | null;
}

export async function describeRoute(companyId: string, job?: string): Promise<RouteDescription> {
  const { provider, model, keyFrom, baseUrl } = await routeFor(companyId, job);
  return {
    provider,
    model,
    keyFrom,
    baseUrl: provider === 'OPENAI_COMPATIBLE' ? (baseUrl ? hostOf(baseUrl) : null) : baseUrl ?? null,
  };
}
