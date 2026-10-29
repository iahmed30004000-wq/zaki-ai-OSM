import { ASSISTANTS, sanitizeScopes, type AiScope } from './ai-assistants';
import { db } from './db';
import { sanitizePromptOverrides, resolvePrompt, recordVersions, HOUSE_JOB, type PromptHistory } from './ai-prompts';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secrets';
import { updateCompanySettings } from './company-settings';
import { SYSTEM_AI, readSystemSetting, systemSettingMeta, updateSystemSetting } from './system-settings';
import { chatCompletionsUrl, parseCompatEndpoint } from './ai-endpoint';

/**
 * WHICH AI, AND WITH WHOSE KEY.
 *
 * The analysis used to read one environment variable and talk to one
 * vendor. That is a decision made once, at deploy time, by whoever had
 * shell access — and it is the wrong person: the company pays for the key,
 * and the company should be able to change vendor without a deploy.
 *
 * So the provider, the model and the key live in company settings, and the
 * three vendors share one call. They differ in exactly three ways — the
 * URL, the auth header, and where the answer sits in the response — and
 * nothing above this file needs to know which one is configured.
 *
 * THE KEY IS WRITE-ONLY. It is encrypted before it is stored, no endpoint
 * ever returns it, and only a hint (last four characters) is shown back so
 * somebody can tell which key is in there. If encryption is unavailable the
 * save is REFUSED rather than writing a key in the clear — a key in a
 * database anybody can read is worse than no AI at all.
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

export interface AiSettings {
  provider: AiProvider;
  model: string;
  /**
   * The house prompt prepended to every request — the one in force. It is
   * the 'house' entry of `prompts`, read here so no caller has to know.
   */
  prompt: string;
  /**
   * The company's own wording for each AI job, where they wrote one.
   *
   * Only overrides are stored. A job the seller never touched is absent,
   * and gets the current default — a default copied into the database is a
   * default that stops improving the day it is written.
   */
  prompts: Record<string, string>;
  /**
   * The fields the business-intelligence assistant is allowed to read.
   *
   * Empty by default, and it stays empty until the owner ticks a box: an
   * assistant that reads the company's money because nobody turned it off
   * is an assistant nobody decided on.
   */
  intelligenceScopes: AiScope[];
  /**
   * The wording each job had before, newest first.
   *
   * Kept beside the prompts rather than in an audit table: it is not a
   * record of who did what — it is the sentence somebody needs back, and
   * it has to be one click from the box they are staring at.
   */
  promptHistory: PromptHistory;
  hasKey: boolean;
  /**
   * WHICH vendors hold a key. Not which characters are in it.
   *
   * This used to be the last three characters of each key, and the screen
   * printed them as «محفوظ — ينتهي بـ ••••abc». The pattern this repo
   * already follows for a courier's account hints the LOGIN and never the
   * PASSWORD — «Never the password. Enough of the login to recognise the
   * account» — and an AI key is the password: it has no login beside it to
   * hint instead. So nothing of it comes back at all, and «which key is in
   * there» is answered by the vendor's name and the date it was saved.
   */
  providerKeys: Record<string, boolean>;
  /** Per-assistant vendor and model, where one was chosen. */
  assistants: Record<string, { provider?: string; model?: string }>;
}

interface StoredAi {
  provider?: string;
  model?: string;
  /**
   * LEGACY house prompt. It was written by a card on the system settings
   * screen while /settings/ai wrote `prompts.house`, and only this one was
   * read — so the screen built for it edited a prompt nothing used. Now
   * `prompts.house` is the only one: this is read as its fallback until
   * the next save through /settings/ai, which drops it.
   */
  prompt?: string;
  prompts?: Record<string, string>;
  /** See AiSettings.intelligenceScopes. */
  intelligenceScopes?: string[];
  /** See AiSettings.promptHistory. */
  promptHistory?: PromptHistory;
  /**
   * LEGACY single key: the one the default provider uses. Kept and still
   * read, so a company that configured a key before this existed does not
   * have to touch anything.
   */
  apiKeyEncrypted?: string;
  /**
   * LEGACY, and no longer written. It held `secretHint(key)` — the last
   * three characters of the key — and it was returned to the browser. It is
   * dropped from the document on the next save of these settings rather
   * than migrated, because there is nothing to preserve: a fragment of a
   * secret is not information anybody needs back.
   */
  keyHint?: string;
  /**
   * A key PER PROVIDER, so several vendors can be configured at once.
   * Without this an assistant could be pointed at Anthropic while the only
   * key in the box belonged to OpenAI — a setting that saves and then
   * fails at the moment somebody needs an answer.
   */
  keys?: Record<string, { enc: string; hint?: string }>;
  /**
   * Per-assistant routing. Absent = the company default, which is what
   * every assistant did before and what most should keep doing.
   */
  assistants?: Record<string, { provider?: string; model?: string }>;
}

/**
 * THE INSTALLATION'S OWN VENDOR ACCOUNTS.
 *
 * «واحفظو للـ System». A prompt is a company's voice and belongs to the
 * company; a vendor account is infrastructure and belongs to whoever
 * installed the system. Keeping the key per company stores one secret once
 * per seller, and every extra copy is another place it leaks from.
 *
 * This is the SAME shape the company document already used for `keys` — a
 * key per vendor, encrypted — moved up a scope, not a second system beside
 * it. `routeFor` reads this first and falls back to the company's own stored
 * key, so an installation that configured one before this existed keeps
 * working untouched.
 *
 * NO HINT IS STORED. What used to sit beside each key was `secretHint(key)` —
 * the last three characters — and it was returned to the browser and printed
 * on the settings screen as «محفوظ — ينتهي بـ ••••abc». The pattern this
 * repo already follows for courier credentials hints the LOGIN and never the
 * PASSWORD, and an AI key is the password. «Which key is in there» is
 * answered by the vendor's name, the date it was saved and who saved it —
 * none of which is any part of the secret.
 */
interface SystemAi {
  provider?: string;
  model?: string;
  /** Encrypted key per vendor, with when it was set. Never the key, never a hint. */
  keys?: Record<string, { enc: string; at?: string; url?: string }>;
  /**
   * The OpenAI-compatible server: where it is and what it is called.
   *
   * Its key lives in `keys.OPENAI_COMPATIBLE` WITH the address it was issued
   * for (`url`), and is used only while that equals `compat.baseUrl`. A key
   * that survived an address change would be sent to the new host by the
   * next call — so a change of address deletes it.
   */
  compat?: { baseUrl: string; model?: string };
  /**
   * Where the owner's own model server lives.
   *
   * Written ONLY after `parseLocalEndpoint` has accepted it. Stored as a
   * plain string because it is not a secret — but it IS the most dangerous
   * field in the product, and `ai-endpoint.ts` says at length why.
   */
  localBaseUrl?: string;
}

/** What the installation has configured. Never a key, never part of one. */
export interface SystemAiSettings {
  provider: AiProvider;
  model: string;
  /** Which vendors hold a key, and when it was put there. */
  providerKeys: Record<string, { configured: boolean; savedAt: string | null }>;
  localBaseUrl: string | null;
  /**
   * The OpenAI-compatible server. `host` is the name alone, for a sentence on
   * the screen. Never a key, never a hint of one.
   */
  compat: { baseUrl: string | null; host: string | null; model: string | null };
  /** Who last changed the installation's AI settings, and when. */
  savedAt: string | null;
  savedBy: string | null;
  /** Can a key be stored at all right now? A screen should say so first. */
  encryptionAvailable: boolean;
}

/** The host name of a stored address, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The vendor keys with the compatible server's removed (undefined when none are left). */
function withoutCompatKey(keys: SystemAi['keys']): SystemAi['keys'] {
  if (!keys?.OPENAI_COMPATIBLE) return keys;
  const rest = { ...keys };
  delete rest.OPENAI_COMPATIBLE;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Is the stored compatible-server key the one issued for the stored address? */
function compatKeyBound(sys: SystemAi): boolean {
  const entry = sys.keys?.OPENAI_COMPATIBLE;
  return !!entry?.enc && !!sys.compat?.baseUrl && entry.url === sys.compat.baseUrl;
}

export async function systemAi(): Promise<SystemAiSettings> {
  const stored = (await readSystemSetting<SystemAi>(SYSTEM_AI)) ?? {};
  const meta = await systemSettingMeta(SYSTEM_AI);
  const provider = (AI_PROVIDERS.find((p) => p.id === stored.provider)?.id ?? 'OPENROUTER') as AiProvider;
  return {
    provider,
    model: stored.model || providerInfo(provider).defaultModel,
    providerKeys: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        {
          // A compatible server's key counts only while it is bound to the
          // address it is saved for — a key that would not be sent is not
          // «محفوظ».
          configured: !!stored.keys?.[p.id]?.enc && (p.id !== 'OPENAI_COMPATIBLE' || compatKeyBound(stored)),
          savedAt: stored.keys?.[p.id]?.at ?? null,
        },
      ])
    ),
    localBaseUrl: stored.localBaseUrl ?? null,
    compat: {
      baseUrl: stored.compat?.baseUrl ?? null,
      host: stored.compat?.baseUrl ? hostOf(stored.compat.baseUrl) : null,
      model: stored.compat?.model ?? null,
    },
    savedAt: meta?.updatedAt.toISOString() ?? null,
    savedBy: meta?.updatedBy ?? null,
    encryptionAvailable: encryptionAvailable(),
  };
}

export interface SaveSystemAiInput {
  /** Absent leaves the stored default alone — see the route's schema. */
  provider?: AiProvider;
  /** Absent leaves the stored default alone. */
  model?: string;
  /** A key per vendor: a value sets it, null clears it, absent leaves it. */
  providerKeys?: Record<string, string | null>;
  /** The local server's address, already checked by `parseLocalEndpoint`. */
  localBaseUrl?: string | null;
  /**
   * The compatible server's address, already checked by `parseCompatEndpoint`.
   * A different address (or null) deletes the key kept for the old one.
   */
  compatBaseUrl?: string | null;
  /** The name that server answers to, already checked by `parseCompatModel`. */
  compatModel?: string | null;
}

/**
 * Save the installation's vendor accounts.
 *
 * Refused outright when encryption is unavailable — a key written in the
 * clear is worse than no AI at all, and that is the whole reason the courier
 * credentials route refuses too.
 */
export async function saveSystemAi(input: SaveSystemAiInput, actorId?: string | null): Promise<SystemAiSettings> {
  const settingKey = Object.values(input.providerKeys ?? {}).some((v) => !!v);
  if (settingKey && !encryptionAvailable()) throw new Error('ENCRYPTION_KEY_MISSING');

  await updateSystemSetting<SystemAi>(
    SYSTEM_AI,
    (current) => {
      const next: SystemAi = { ...(current ?? {}) };
      /*
       * Absent means «leave it». A key save used to carry whatever the
       * screen was holding and overwrite the installation default with
       * it, which is why the dropdown appeared not to work.
       */
      if (input.provider !== undefined) {
        next.provider = AI_PROVIDERS.find((p) => p.id === input.provider)?.id ?? next.provider;
      }
      if (input.model !== undefined) {
        const chosen = input.model.trim();
        next.model = chosen || providerInfo(next.provider ?? 'OPENROUTER').defaultModel;
      }

      /*
       * ── THE COMPATIBLE SERVER: ADDRESS, NAME, AND THE KEY THAT GOES WITH IT ──
       *
       * Before the keys below, in the same row lock, because a key saved in
       * this request is bound to the address as it is AFTER this block.
       *
       * A key kept across an address change would be sent to the new host
       * by the very next call, and a company user pressing «اختبار الاتصال»
       * makes that call. So a different address, or none, deletes the key
       * kept for the old one; a new key arriving in the same save is added
       * back by the loop below, bound to the new address.
       */
      if (input.compatBaseUrl === null) {
        delete next.compat;
        next.keys = withoutCompatKey(next.keys);
      } else if (input.compatBaseUrl && input.compatBaseUrl !== next.compat?.baseUrl) {
        next.compat = { baseUrl: input.compatBaseUrl, model: next.compat?.model };
        next.keys = withoutCompatKey(next.keys);
      }
      if (input.compatModel !== undefined && next.compat) {
        if (input.compatModel === null) delete next.compat.model;
        else next.compat = { ...next.compat, model: input.compatModel };
      }

      if (input.providerKeys) {
        const keys = { ...(next.keys ?? {}) };
        for (const [id, value] of Object.entries(input.providerKeys)) {
          // A vendor this system does not know is dropped, never stored: a
          // typo would otherwise sit there holding a real key under a name
          // nothing ever reads.
          if (!AI_PROVIDERS.some((p) => p.id === id)) continue;
          if (value === null) delete keys[id];
          else if (value) {
            const entry: { enc: string; at: string; url?: string } = {
              enc: encryptSecret(value.trim()),
              at: new Date().toISOString(),
            };
            if (id === 'OPENAI_COMPATIBLE') {
              // Bound to the address it is saved for. With no address there is
              // nowhere this key could ever be sent, so it is not kept.
              if (!next.compat?.baseUrl) throw new Error('COMPAT_ENDPOINT_REQUIRED');
              entry.url = next.compat.baseUrl;
            }
            keys[id] = entry;
          }
        }
        next.keys = Object.keys(keys).length > 0 ? keys : undefined;
      }

      if (input.localBaseUrl === null) delete next.localBaseUrl;
      else if (input.localBaseUrl) next.localBaseUrl = input.localBaseUrl;

      return next;
    },
    actorId
  );

  return systemAi();
}

/** The overrides as the editor should show them: the legacy house prompt folded in. */
function overridesOf(ai: StoredAi): Record<string, string> {
  const prompts = sanitizePromptOverrides(ai.prompts);
  if (!prompts[HOUSE_JOB] && ai.prompt?.trim()) prompts[HOUSE_JOB] = ai.prompt.trim().slice(0, 4000);
  return prompts;
}

function readStored(settings: string | null): StoredAi {
  try {
    return (settings ? JSON.parse(settings) : {}).ai ?? {};
  } catch {
    return {};
  }
}

/** What the settings screen may see. Never the key itself. */
export async function aiSettings(companyId: string): Promise<AiSettings> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  const ai = readStored(company?.settings ?? null);
  const provider = (AI_PROVIDERS.find((p) => p.id === ai.provider)?.id ?? 'OPENROUTER') as AiProvider;
  const prompts = overridesOf(ai);
  return {
    provider,
    model: ai.model || providerInfo(provider).defaultModel,
    prompt: resolvePrompt(HOUSE_JOB, prompts),
    prompts,
    // The environment key still counts as configured, so an existing deploy
    // keeps working without anybody re-entering anything.
    // Nothing until the owner ticks a box: an assistant reading the money
    // because nobody turned it off is an assistant nobody decided on.
    intelligenceScopes: sanitizeScopes(ai.intelligenceScopes),
    promptHistory: ai.promptHistory ?? {},
    /*
     * The environment key is OpenRouter's, by its own name — `routeFor` hands
     * it to that vendor alone. Counting it for every vendor made the screen
     * say «مفتاح موجود» beside a company on Anthropic whose calls then failed
     * with no key at all. And the compatible server's key is the
     * installation's, bound to its address, so a company-level answer here
     * is always no.
     */
    hasKey:
      provider !== 'OPENAI_COMPATIBLE' &&
      (!!ai.apiKeyEncrypted || !!ai.keys?.[provider] || (provider === 'OPENROUTER' && !!process.env.OPENROUTER_API_KEY)),
    // WHICH vendors this company has a key for — a yes or a no, never a
    // fragment of the key itself.
    providerKeys: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        p.id !== 'OPENAI_COMPATIBLE' && (!!ai.keys?.[p.id]?.enc || (p.id === provider && !!ai.apiKeyEncrypted)),
      ])
    ),
    assistants: ai.assistants ?? {},
  };
}

export async function saveAiSettings(
  companyId: string,
  input: {
    /**
     * ABSENT MEANS «LEAVE IT», for the same reason as the installation
     * settings: the screen echoes the COMPUTED value, so a required field
     * turns «I edited a prompt» into «I chose OpenRouter».
     */
    provider?: AiProvider;
    model?: string;
    prompts?: Record<string, string>;
    intelligenceScopes?: string[];
    apiKey?: string | null;
    /** A key per vendor: value = set it, null = clear it, absent = leave it. */
    providerKeys?: Record<string, string | null>;
    /** Per-assistant vendor and model. An empty object clears an override. */
    assistants?: Record<string, { provider?: string; model?: string }>;
  },
  /** Whoever pressed save, for the prompt versions. */
  actor?: { name: string | null; now?: Date }
): Promise<AiSettings> {
  // Refused before anything is touched: a key stored in the clear is worse
  // than no AI at all.
  const anyKey = input.apiKey || Object.values(input.providerKeys ?? {}).some((v) => !!v);
  if (anyKey && !encryptionAvailable()) throw new Error('ENCRYPTION_KEY_MISSING');

  // Only the `ai` key, under a row lock: a template save running at the
  // same moment used to write back the key this save had just removed.
  await updateCompanySettings<StoredAi>(companyId, 'ai', (stored) => {
    const current: StoredAi = stored ?? {};
    const nextPrompts =
      input.prompts !== undefined ? sanitizePromptOverrides(input.prompts) : current.prompts;

    const next: StoredAi = {
      /*
       * ── EDITING A PROMPT IS NOT CHOOSING A VENDOR ──
       *
       * `aiSettings()` COMPUTES `provider` and `model` when the company
       * never chose, so the screen echoing them back is a write, not an
       * echo. Saving a sentence, or ticking an intelligence scope, used
       * to store `provider: 'OPENROUTER'` — and since the company's
       * choice now outranks the installation default, that stamp would
       * override a deliberate installation LOCAL or Anthropic.
       *
       * The same defect the key card had, on the other card. Absent
       * leaves what is stored, and «never chose» stays expressible.
       */
      provider: input.provider ?? current.provider,
      model:
        input.model === undefined
          ? current.model
          : input.model.trim() ||
            providerInfo((input.provider ?? current.provider ?? 'OPENROUTER') as AiProvider).defaultModel,
      // Sanitised on the way in: unknown jobs are dropped, and an override
      // equal to the default is not stored at all.
      prompts: nextPrompts,
      // The replaced wording, kept before it is overwritten. Inside the
      // same row lock as the write itself: read it outside and a second
      // save between the two loses a version.
      promptHistory:
        input.prompts === undefined
          ? current.promptHistory
          : recordVersions(
              current.promptHistory,
              overridesOf(current),
              nextPrompts ?? {},
              { at: (actor?.now ?? new Date()).toISOString(), by: actor?.name ?? null }
            ),
      // Only names this system knows — an unknown one is dropped, never
      // guessed at, so a typo can never widen what an assistant reads.
      intelligenceScopes:
        input.intelligenceScopes !== undefined
          ? sanitizeScopes(input.intelligenceScopes)
          : current.intelligenceScopes,
      // The editor was shown the legacy house prompt as `prompts.house`, so
      // what it sends back is the whole truth — keeping the legacy key would
      // bring a prompt the seller just cleared back to life.
      ...(input.prompts === undefined && current.prompt ? { prompt: current.prompt } : {}),
      apiKeyEncrypted: current.apiKeyEncrypted,
      // `keyHint` is deliberately NOT carried over: every save drops it.
      keys: current.keys,
      /**
       * Only vendors and models this system knows.
       *
       * An unknown provider is dropped rather than stored: a typo would
       * otherwise route an assistant to a vendor that does not exist, and
       * the failure would appear as «الذكاء غير مضبوط» on a screen far
       * from the setting that caused it.
       */
      assistants:
        input.assistants === undefined
          ? current.assistants
          : Object.fromEntries(
              Object.entries(input.assistants)
                .map(([job, v]) => {
                  const provider = AI_PROVIDERS.find((p) => p.id === v.provider)?.id;
                  const model = v.model?.trim() || undefined;
                  return [job, { ...(provider ? { provider } : {}), ...(model ? { model } : {}) }] as const;
                })
                // An override that says nothing is not stored at all.
                .filter(([, v]) => Object.keys(v).length > 0)
            ),
    };

    // Per-vendor keys, each encrypted on the way in.
    if (input.providerKeys) {
      const keys = { ...(current.keys ?? {}) };
      for (const [id, value] of Object.entries(input.providerKeys)) {
        if (!AI_PROVIDERS.some((p) => p.id === id)) continue;
        // The compatible server's key is the installation's and is bound to
        // its address; a company never holds one, so a value sent here is
        // dropped rather than stored under a name nothing reads.
        if (id === 'OPENAI_COMPATIBLE') continue;
        if (value === null) delete keys[id];
        else if (value) keys[id] = { enc: encryptSecret(value.trim()) };
      }
      next.keys = Object.keys(keys).length > 0 ? keys : undefined;
    }

    if (input.apiKey === null) {
      // Explicitly cleared.
      delete next.apiKeyEncrypted;
      delete next.keyHint;
    } else if (input.apiKey) {
      next.apiKeyEncrypted = encryptSecret(input.apiKey.trim());
    }
    return next;
  });
  return aiSettings(companyId);
}

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

async function routeFor(companyId: string, job?: string): Promise<AiRoute> {
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
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    // A reasoning model behind a server with no reasoning parser answers with
    // its thinking in front of the answer, and `JSON.parse` of that fails.
    // Only the compatible server, only one leading block.
    return route.provider === 'OPENAI_COMPATIBLE' ? content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '') : content;
  } finally {
    clearTimeout(timer);
  }
}
