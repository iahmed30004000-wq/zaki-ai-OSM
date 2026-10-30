/**
 * THE CATALOGUE: which vendors exist, what each offers, and which tier a model is.
 * Pure data and pure lookups — no database, no key, no network.
 */

export type AiProvider = 'OPENROUTER' | 'OPENAI' | 'ANTHROPIC' | 'LOCAL' | 'OPENAI_COMPATIBLE';

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  /** What to put in the model box if they have no preference. */
  defaultModel: string;
  /** Examples, so the box is not a blank line with no clue what goes in it. */
  models: string[];
  keyHelp: string;
  /**
   * This vendor is a machine the owner runs, so it needs an address and the
   * model list is whatever HE loaded onto it.
   *
   * Set only on LOCAL. Everything reading it must also apply
   * `parseLocalEndpoint` — see `ai-endpoint.ts` for what a free-text address
   * can be abused for.
   */
  needsEndpoint?: boolean;
  /**
   * An OpenAI-compatible server on the internet: it needs an https address
   * and a model name, both kept once for the installation. Never LOCAL —
   * it is an outside party, so `localOnly` and the pii guard refuse it.
   */
  needsHttpsEndpoint?: boolean;
  /** A key is optional: most local servers are not authenticated at all. */
  keyOptional?: boolean;
}

/**
 * THE MODELS EACH VENDOR OFFERS, NEWEST FIRST.
 *
 * THIS LIST WAS WRONG AND IT COST A 404. It carried `claude-sonnet-4-5` and
 * `claude-haiku-4-5`, and neither is a model id Anthropic answers to. The
 * owner picked the first of them from the box, the vendor said 404, and the
 * screen reported «النموذج غير موجود عند هذا المزوّد» — which was true, and
 * pointed at a list that had lied to him.
 *
 * The reasoning that produced it was: a list in code goes stale the week a
 * vendor ships something, so keep it a SUGGESTION and let the box accept
 * anything. That is half right. Staleness is real — but a free text box does
 * not solve it, it only moves the invention from this file to the screen,
 * where a typo looks exactly like a choice. The models are a closed list
 * now, with one explicit «أخرى» door for a name that ships before this file
 * is edited.
 *
 * Ordered newest first and annotated by what each is FOR, because the
 * choice that matters is not the vendor but the tier: a note classifier
 * running thousands of times a day and a business analysis run once an
 * hour should not be the same model, and picking the expensive one for
 * both is the commonest way an AI bill becomes a surprise.
 */
export const AI_PROVIDERS: ProviderInfo[] = [
  {
    id: 'ANTHROPIC',
    label: 'Anthropic',
    /*
     * `claude-sonnet-5-5` and `claude-haiku-5-5` are the current ids and
     * neither was offered — so the owner could not pick the model that is
     * both newer and cheaper than the one the box defaulted to. The older
     * names stay listed rather than deleted: a company already answering
     * on one of them keeps answering, and a list that removes what people
     * chose is a list that breaks them to look tidy.
     */
    defaultModel: 'claude-sonnet-5-5',
    models: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-sonnet-5',
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
    ],
    keyHelp: 'مفتاح من console.anthropic.com — يبدأ بـ sk-ant-',
  },
  {
    id: 'OPENAI',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3-mini'],
    keyHelp: 'مفتاح من platform.openai.com — يبدأ بـ sk-',
  },
  {
    id: 'OPENROUTER',
    label: 'OpenRouter',
    /**
     * The free model stays the default, and that is not a preference.
     * OpenRouter is what a company with no key falls back to, so this is
     * the model the product runs on before anybody has paid anyone — and
     * making it a paid one would turn "AI is not configured yet" into a
     * bill.
     */
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    keyHelp: 'مفتاح من openrouter.ai — يبدأ بـ sk-or-',
  },
  {
    /**
     * A MODEL THE OWNER RUNS HIMSELF.
     *
     * «وإذا بدي أحمّل نموذج محلي ع السيرفر مستقبلاً». Ollama, vLLM and LM
     * Studio all answer the OpenAI chat-completions shape, which is why this
     * needs no adapter of its own — only an address.
     *
     * The suggested names are the models people actually run on one machine,
     * and they are only suggestions: the real list is whatever was pulled
     * onto that server, which this file cannot know. The box accepts any
     * name for that reason, and for this vendor alone — for a paid vendor a
     * free-text model is a typo that looks like a choice, but here the
     * operator IS the catalogue.
     */
    id: 'LOCAL',
    label: 'نموذج على خادمك',
    defaultModel: 'llama3.1:8b',
    models: ['llama3.1:8b', 'qwen2.5:14b', 'mistral-small', 'gemma2:9b'],
    keyHelp:
      'أكثر الخوادم المحلية بلا مفتاح — اتركه فارغاً إن لم يطلب خادمك مفتاحاً.',
    needsEndpoint: true,
    keyOptional: true,
  },
  {
    /**
     * A SERVER ON THE INTERNET THAT SPEAKS THE OPENAI SHAPE — and is therefore
     * EXTERNAL, always.
     *
     * A gateway, a hosted open model, a vLLM behind a name of the owner's own.
     * The code cannot tell «the owner's machine» from «a proxy that forwards
     * to a vendor», so it never calls this LOCAL: `localOnly` and the pii
     * guard refuse it exactly as they refuse OpenAI, and a customer's name
     * never reaches it. There is no «this is my own server» switch.
     *
     * The names below are only suggestions (the existing guard wants every
     * vendor to list its default). The real name is whatever the server
     * lists, kept beside the address.
     */
    id: 'OPENAI_COMPATIBLE',
    label: 'خادم متوافق مع OpenAI',
    defaultModel: 'glm-4.6',
    models: ['glm-4.6', 'glm-4.5-air'],
    keyHelp: 'مفتاح خادمك أو بوّابتك — بيُرسَل Bearer. العنوان واسم النموذج تحت.',
    needsHttpsEndpoint: true,
  },
];

/**
 * WHICH TIER A JOB DESERVES.
 *
 * Shown beside the model box so the tier is a decision rather than a
 * default nobody revisited.
 */
/**
 * NAMES THAT WERE OFFERED AND ARE NOT REAL.
 *
 * Anyone who picked one has it saved, and dropping it from the list would
 * leave them with a setting that 404s and a box that cannot show what is in
 * it. Read-time repair, not a migration: the id is mapped to the real model
 * it was meant to be, once, wherever settings are read.
 */
export const RETIRED_MODELS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/** The real name for a model id, if the one stored was retired. */
export function liveModel(model: string): string {
  return RETIRED_MODELS[model] ?? model;
}

export const MODEL_TIERS: { match: RegExp; tier: string; note: string }[] = [
  { match: /opus|gpt-4o(?!-mini)|o3(?!-mini)/i, tier: 'الأعلى', note: 'للتحليل والقرارات — أغلى بكثير، لا يُستعمل لكلّ رسالة' },
  { match: /sonnet|o4-mini|o3-mini/i, tier: 'متوازن', note: 'الاستخراج والتأكيد والتلخيص' },
  { match: /haiku|mini|free/i, tier: 'اقتصادي', note: 'التصنيف عالي التكرار — آلاف الرسائل يومياً' },
];

export function tierOf(model: string): { tier: string; note: string } | null {
  return MODEL_TIERS.find((t) => t.match.test(model)) ?? null;
}

export function providerInfo(id: string): ProviderInfo {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];
}
