import { sanitizeScopes, type AiScope } from '../ai-assistants';
import { db } from '../db';
import { sanitizePromptOverrides, resolvePrompt, recordVersions, HOUSE_JOB, type PromptHistory } from '../ai-prompts';
import { encryptSecret, encryptionAvailable } from '../secrets';
import { updateCompanySettings } from '../company-settings';
import { SYSTEM_AI, readSystemSetting, systemSettingMeta, updateSystemSetting } from '../system-settings';
import { hasCap, sanitizeCap, type SpendCap } from '../ai-spend';
import { AI_PROVIDERS, providerInfo, type AiProvider } from './catalogue';

/**
 * THE SETTINGS: what is stored (company and installation), what may be shown back, and how it is saved.
 * The key is write-only here too — nothing in this file returns one.
 */

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
  /**
   * THE DAILY AND MONTHLY CEILING, in tokens. A side that is null means «no
   * ceiling», which is what every company has until the owner writes one.
   * See `ai-spend.ts`.
   */
  spendCap?: SpendCap;
}

export interface StoredAi {
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
  /** See AiSettings.spendCap. Absent = no ceiling. */
  spendCap?: SpendCap;
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
export interface SystemAi {
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
export function hostOf(url: string): string | null {
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
export function compatKeyBound(sys: SystemAi): boolean {
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

export function readStored(settings: string | null): StoredAi {
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
      // A local model needs no key at all, so it is never «بلا مفتاح».
      (provider === 'LOCAL' ||
        !!ai.apiKeyEncrypted || !!ai.keys?.[provider] || (provider === 'OPENROUTER' && !!process.env.OPENROUTER_API_KEY)),
    // WHICH vendors this company has a key for — a yes or a no, never a
    // fragment of the key itself.
    providerKeys: Object.fromEntries(
      AI_PROVIDERS.map((p) => [
        p.id,
        p.id !== 'OPENAI_COMPATIBLE' && (!!ai.keys?.[p.id]?.enc || (p.id === provider && !!ai.apiKeyEncrypted)),
      ])
    ),
    assistants: ai.assistants ?? {},
    spendCap: sanitizeCap(ai.spendCap),
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
    /** The daily and monthly ceiling. Absent leaves it; a null side is «no ceiling». */
    spendCap?: SpendCap;
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
      // Carried through EVERY save, like the keys: a prompt save that forgot
      // it would switch the ceiling off. Both sides null is stored as nothing.
      spendCap: input.spendCap === undefined ? current.spendCap : hasCap(sanitizeCap(input.spendCap)) ? sanitizeCap(input.spendCap) : undefined,
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
