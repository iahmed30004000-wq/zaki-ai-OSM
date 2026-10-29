'use client';

import { AssistantsTable } from '@/components/screens/ai/AssistantsTable';
import { MessageTemplatesCard } from '@/components/settings/MessageTemplatesCard';
import React, { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MAX_PROMPT, missingSlots, type AiJob, type PromptVersion } from '@/lib/ai-prompts';
import { tierOf } from '@/lib/ai-provider';
import { RiAlertLine, RiArrowDownSLine, RiArrowGoBackLine, RiCheckLine, RiKey2Line, RiLoader4Line, RiPlugLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { arDate } from '@/lib/format';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * THE AI, AND EVERY WORD THE SYSTEM SAYS TO IT.
 *
 * It lived as one card at the bottom of system settings — a provider, a
 * model and a key — while the actual instructions were written into the
 * files that send them. The person who knows whether "be concise" suits
 * their business, in their dialect, for their customers, could not change
 * a syllable of it.
 *
 * So: its own screen, and every job's prompt beside its default. The
 * default is shown because a seller editing a prompt needs to see what
 * they are replacing, and because a prompt they have broken must be one
 * click from working again.
 *
 * Only OVERRIDES are stored. A prompt equal to the default is not an
 * override, and a cleared box means "go back to normal" — a company that
 * never touched a prompt gets this year's wording and not the one they
 * were created with.
 */

interface Provider {
  id: string;
  label: string;
  defaultModel: string;
  models: string[];
  keyHelp: string;
  /** LOCAL only: a machine the owner runs, so it needs an address. */
  needsEndpoint?: boolean;
  /** An OpenAI-compatible server on the internet: an https address and a model name. */
  needsHttpsEndpoint?: boolean;
  /** Most local servers are not authenticated at all. */
  keyOptional?: boolean;
}

/**
 * THE INSTALLATION'S VENDOR ACCOUNTS — «واحفظو للـ System».
 *
 * A company's prompts are its own voice and stay on /api/settings/ai. The
 * accounts are infrastructure: one key, entered once, for the whole box.
 *
 * NOTHING OF A KEY COMES BACK. Not the key, not a mask, not the last few
 * characters — this screen used to print «محفوظ — ينتهي بـ ••••abc», and the
 * pattern this product already follows for a courier's account hints the
 * LOGIN and never the PASSWORD. An AI key has no login beside it, so what
 * says which key is in there is the vendor's name and the date it was saved.
 */
interface SystemAi {
  provider: string;
  model: string;
  providerKeys: Record<string, { configured: boolean; savedAt: string | null }>;
  localBaseUrl: string | null;
  /** The OpenAI-compatible server. Never a key. */
  compat?: { baseUrl: string | null; host: string | null; model: string | null };
  savedAt: string | null;
  savedBy: string | null;
  encryptionAvailable: boolean;
}
interface Settings {
  /** What the business-intelligence assistant may read. */
  intelligenceScopes?: string[];
  provider: string;
  model: string;
  /** Per-assistant vendor and model, where one was chosen. */
  assistants?: Record<string, { provider?: string; model?: string }>;
  /** WHICH vendors this company has a key for — a yes or a no, never a fragment. */
  providerKeys?: Record<string, boolean>;
  prompt: string;
  prompts: Record<string, string>;
  /** What each job's prompt said before, newest first. */
  promptHistory?: Record<string, PromptVersion[]>;
  hasKey: boolean;
}

export function AiSettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  /** Where each assistant's call would actually go — from the server. */
  type RouteDesc = { provider: string; model: string; keyFrom: string; baseUrl: string | null };
  const [routes, setRoutes] = useState<Record<string, RouteDesc>>({});
  const [defaultRoute, setDefaultRoute] = useState<RouteDesc | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** A key box per vendor, so several can be entered without switching first. */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [system, setSystem] = useState<SystemAi | null>(null);
  const [localUrl, setLocalUrl] = useState('');
  const [compatUrl, setCompatUrl] = useState('');
  const [compatModel, setCompatModel] = useState('');
  const [systemBusy, setSystemBusy] = useState(false);
  const [systemMsg, setSystemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** Null until the first load says whether this account may see it at all. */
  const [systemAllowed, setSystemAllowed] = useState<boolean | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<'provider' | 'assistants' | 'prompts'>('provider');
  /** The provider's own answer to one cheap question — not a green tick. */
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * Would a call find something to use? One question, answered by the
   * same resolution the call performs — LOCAL needs an address, every
   * other vendor needs a key.
   */
  const canTest = defaultRoute
    ? defaultRoute.provider === 'LOCAL'
      ? !!defaultRoute.baseUrl
      : defaultRoute.provider === 'OPENAI_COMPATIBLE'
        ? !!defaultRoute.baseUrl && defaultRoute.keyFrom !== 'none'
        : defaultRoute.keyFrom !== 'none'
    : false;

  async function testConnection() {
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch('/api/settings/ai/test', { method: 'POST', credentials: 'same-origin' });
      const r = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; reply?: string;
        provider?: string; model?: string; keyFrom?: string;
      };
      /*
        «رد» on its own left the next question unanswered: from WHERE, and
        with WHOSE key. Both are in the reply now, because the route that
        answered is not always the one the dropdown above shows.
      */
      const vendor = providers.find((p) => p.id === r.provider)?.label ?? r.provider ?? '';
      const from = r.keyFrom && r.keyFrom !== 'none' ? ` · المفتاح من ${KEY_SOURCE_AR[r.keyFrom] ?? r.keyFrom}` : '';
      const where = [vendor, r.model].filter(Boolean).join(' · ');
      setTest(
        r.ok
          ? { ok: true, text: `${where}${from} — ردّ${r.reply ? `: «${r.reply}»` : ''}` }
          : { ok: false, text: `${r.error ?? 'تعذّر الاتصال'}${where ? ` (${where})` : ''}` }
      );
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الاتصال' });
    } finally {
      setTesting(false);
    }
  }

  const load = useCallback(async () => {
    const res = await fetch('/api/settings/ai');
    const json = await res.json();
    setSettings(json.settings);
    // What the SERVER holds, so a save can tell a changed dropdown from an
    // untouched one — the same rule the installation card follows.
    savedCompany.current = {
      provider: json.settings?.provider ?? null,
      model: json.settings?.model ?? null,
    };
    setProviders(json.providers || []);
    setJobs(json.jobs || []);
    // Where each assistant's call would actually go, answered by the
    // resolver rather than re-derived here.
    setRoutes(json.routes ?? {});
    setDefaultRoute(json.defaultRoute ?? null);
    setDrafts(json.settings?.prompts ?? {});

    /**
     * The installation's accounts, which only a system administrator may
     * see. A 403 here is not an error to show — it is this account being
     * told, correctly, that the key every company runs on is not theirs to
     * change. The card is simply not drawn.
     */
    const sys = await fetch('/api/settings/ai/system');
    if (sys.ok) {
      const sysJson = await sys.json();
      setSystem(sysJson.system);
      // What the SERVER holds, so a save can tell a changed dropdown from
      // an untouched one. See `saveSystem`.
      savedDefault.current = {
        provider: sysJson.system?.provider ?? null,
        model: sysJson.system?.model ?? null,
      };
      setLocalUrl(sysJson.system?.localBaseUrl ?? '');
      setCompatUrl(sysJson.system?.compat?.baseUrl ?? '');
      setCompatModel(sysJson.system?.compat?.model ?? '');
      setSystemAllowed(true);
      if (sysJson.providers) setProviders(sysJson.providers);
    } else {
      setSystemAllowed(false);
    }
  }, []);

  useLiveRefresh(load);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        /*
          KEYS NO LONGER TRAVEL WITH THE PROMPTS.
          This form used to carry `apiKey` alongside the wording, so saving a
          sentence and saving a vendor account were one action with one
          permission. They are different things owned by different people:
          the accounts are the installation's, and they are saved by the card
          above through their own endpoint.
        */
        /*
          AND THE SAME RULE ON THIS CARD: a prompt save is a prompt save.
          `aiSettings()` COMPUTES provider and model when the company
          never chose, so echoing them back stored a choice nobody made —
          and since a company's choice now outranks the installation
          default, that stamp would override a deliberate LOCAL.
        */
        body: JSON.stringify({
          ...(settings.provider !== savedCompany.current.provider ? { provider: settings.provider } : {}),
          ...(settings.model !== savedCompany.current.model ? { model: settings.model } : {}),
          prompts: drafts,
          /*
            AND THE PER-ASSISTANT ROUTING, WHICH NEVER LEFT THIS SCREEN.

            `AssistantsTable` wrote every choice into local state through
            `onRouted` and the body here never carried it, so «المساعدون»
            was a tab where every control worked, nothing was refused, and
            nothing survived a reload. The route has accepted `assistants`
            all along.
          */
          assistants: settings.assistants ?? {},
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحفظ');
      await load();
      setMsg({ ok: true, text: 'حُفظ. النصوص الجديدة مستعملة من الآن في كل طلب.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save the installation's accounts.
   *
   * Every non-empty key box is sent at once, so registering three vendors is
   * one action rather than three round trips through a dropdown. The boxes
   * are cleared on success: nothing typed into them is ever read back.
   */
  /** What the server last gave us, so a save can tell changed from untouched. */
  const savedDefault = useRef<{ provider: string | null; model: string | null }>({ provider: null, model: null });
  /** The same, for the COMPANY's own choice. */
  const savedCompany = useRef<{ provider: string | null; model: string | null }>({ provider: null, model: null });

  async function saveSystem() {
    if (!system) return;
    setSystemBusy(true);
    setSystemMsg(null);
    try {
      const providerKeys = Object.fromEntries(
        Object.entries(keyDrafts)
          .filter(([, v]) => v.trim().length > 0)
          .map(([id, v]) => [id, v.trim()])
      );
      const res = await fetch('/api/settings/ai/system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        /*
         * ── A KEY SAVE IS NOT A CHANGE OF DEFAULT ──
         *
         * This body used to carry `provider` and `model` unconditionally —
         * whatever the dropdown happened to be showing — so pasting an
         * Anthropic key stamped the installation default with it. With
         * nothing stored that default is OpenRouter and a free Llama, and
         * from then on «المزوّد» could not move it: the next key save put
         * it back. The dropdown looked broken because it was being
         * overwritten by its own form.
         *
         * They are sent only when they differ from what the server last
         * gave us, and the route now treats absent as «leave it alone».
         */
        body: JSON.stringify({
          ...(system.provider !== savedDefault.current.provider ? { provider: system.provider } : {}),
          ...(system.model !== savedDefault.current.model ? { model: system.model } : {}),
          ...(Object.keys(providerKeys).length > 0 ? { providerKeys } : {}),
          localBaseUrl: localUrl.trim() || null,
          // Only what changed: an address sent again is, to the server, a new
          // place for the key to go, and it asks for a new key.
          ...(compatUrl.trim() !== (system.compat?.baseUrl ?? '') ? { compatBaseUrl: compatUrl.trim() || null } : {}),
          ...(compatModel.trim() !== (system.compat?.model ?? '') ? { compatModel: compatModel.trim() || null } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحفظ');
      setKeyDrafts({});
      setSystem(json.system);
      setLocalUrl(json.system?.localBaseUrl ?? '');
      setCompatUrl(json.system?.compat?.baseUrl ?? '');
      setCompatModel(json.system?.compat?.model ?? '');
      setSystemMsg({ ok: true, text: 'حُفظت حسابات المزوّدين للنظام.' });
    } catch (e) {
      setSystemMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setSystemBusy(false);
    }
  }

  /** Forget one vendor's key, without touching the others. */
  async function clearKey(id: string) {
    if (!system) return;
    setSystemBusy(true);
    setSystemMsg(null);
    try {
      const res = await fetch('/api/settings/ai/system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        /*
         * ── AND DELETING A KEY IS DELETING A KEY ──
         *
         * This sent `provider` and `model` too, and the independent
         * review found why that is worse than it looks: `systemAi()`
         * COMPUTES them when nothing is stored, so what looks like
         * echoing the current value is in fact a write. Deleting an
         * unused OpenAI key would stamp OpenRouter and a free Llama as
         * the installation default and kill a company's Anthropic choice.
         *
         * The sibling `saveSystem` was fixed and this one was not —
         * which is the whole reason the review reads the code and not
         * the commit message.
         */
        body: JSON.stringify({ providerKeys: { [id]: null } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحذف');
      setSystem(json.system);
      savedDefault.current = {
        provider: json.system?.provider ?? null,
        model: json.system?.model ?? null,
      };
      setSystemMsg({ ok: true, text: 'حُذف المفتاح.' });
    } catch (e) {
      setSystemMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحذف' });
    } finally {
      setSystemBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="flex h-40 items-center justify-center text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  // The vendor's own help text moved into the per-vendor list above, where
  // each row carries its own — so there is no single "current vendor" whose
  // hints this screen needs to look up any more.
  const tier = settings.model ? tierOf(settings.model) : null;

  return (
    <div className="max-w-3xl space-y-4" dir="rtl">
      <PageHeader title="الذكاء الاصطناعي والنصوص"
          description="أي نموذج تستعمل، وبأي كلمات يخاطبه النظام."
        />

      {/* Three questions, three places: which model, who may read what, and
          in whose words. They were one long scroll, so the assistants — the
          part that decides what leaves the company — had nowhere to live. */}
      <div className="flex gap-1.5">
        {([
          ['provider', 'المزوّد والمفتاح'],
          ['assistants', 'المساعدون'],
          ['prompts', 'النصوص والقوالب'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`h-11 md:h-10 flex-1 rounded-lg border text-xs font-medium ${
              tab === value ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]' : 'border-[var(--sys-border)] text-[var(--sys-foreground)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'assistants' && (
        <AssistantsTable
          enabled={settings.intelligenceScopes ?? []}
          onSaved={(scopes) => setSettings({ ...settings, intelligenceScopes: scopes })}
          providers={providers}
          fallback={{ provider: settings.provider, model: settings.model }}
          routing={settings.assistants ?? {}}
          onRouted={(assistants) => setSettings({ ...settings, assistants })}
          routes={routes}
        />
      )}

      {/* ── the vendor ── */}
      <section className={`rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 ${tab === 'provider' ? '' : 'hidden'}`}>
        <h2 className="mb-3 text-sm font-bold text-[var(--sys-heading)]">المزوّد والمفتاح</h2>
        {/*
          THE MODEL IS NOT CHOSEN HERE ANY MORE.
          A model was editable in two places — here and per assistant — and two
          places to set one thing is two places to get it wrong. The choice
          that matters is per assistant anyway: a note classifier running
          thousands of times a day and an analysis run once an hour are not
          the same model. What belongs here is the pairing that cannot be
          split: a KEY belongs to a VENDOR.
          The line below is not a field. It says which model answers a call
          that names no assistant, so nothing is hidden.
        */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]" htmlFor="ai-provider">
            المزوّد
          </label>
          <select
            id="ai-provider"
            value={settings.provider}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              setSettings({ ...settings, provider: e.target.value, model: p?.defaultModel ?? settings.model });
            }}
            className={INPUT}
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted)]">
            النموذج يُختار لكلِّ مساعدٍ في تبويب «المساعدون». وما لا يخصّه مساعدٌ يُجاب بـ
            <span className="mx-1 font-semibold text-[var(--sys-foreground)]" dir="ltr">{settings.model}</span>
            {tier && <>— {tier.tier}: {tier.note}</>}
          </p>
          {/*
            AND WHAT THE RESOLVER SAYS, WHICH IS NOT ALWAYS THE LINE ABOVE.
            The sentence above describes the COMPANY's choice. The answer
            also depends on the installation default and on which key
            exists, and when those disagree the owner was reading one and
            getting the other.
          */}
          {defaultRoute && (
            <p className="mt-1 text-xs text-[var(--sys-muted)]">
              الجواب الفعليّ:
              <span className="mx-1 font-semibold text-[var(--sys-foreground)]" dir="ltr">
                {providers.find((p) => p.id === defaultRoute.provider)?.label ?? defaultRoute.provider} · {defaultRoute.model}
              </span>
              {defaultRoute.keyFrom === 'none' && defaultRoute.provider !== 'LOCAL' ? (
                <span className="text-[var(--sys-warning)]">— بلا مفتاح</span>
              ) : defaultRoute.keyFrom === 'none' ? null : (
                <>— المفتاح من {KEY_SOURCE_AR[defaultRoute.keyFrom] ?? defaultRoute.keyFrom}</>
              )}
            </p>
          )}
        </div>

        {/*
          MORE THAN ONE VENDOR, ENTERED AT ONCE — «أقدر أدخل أكثر من موديل».
          A single key box beside a dropdown meant registering three vendors
          was three visits: pick, paste, save, pick again. Every vendor has
          its own box here and they all save together, and each row says
          whether a key is already in it — which is also the only honest way
          to answer «which key is in there» without showing any part of it.
        */}
        {systemAllowed && system && (
          <div className="mt-4 border-t border-[var(--sys-border)] pt-3">
            <h3 className="flex items-center gap-1 text-xs font-bold text-[var(--sys-heading)]">
              <RiKey2Line className="h-4 w-4" /> حسابات المزوّدين — للنظام كله
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              تُحفظ مرة واحدة للنظام لا لكل شركة. المفتاح يُشفَّر، ولا يعود منه شيء إلى الشاشة
              بعد حفظه — ولا آخر حروفه — ولا يُكتب في سجل التدقيق.
            </p>

            {!system.encryptionAvailable && (
              <p className="mt-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs leading-relaxed text-[var(--sys-destructive)]">
                مفتاح التشفير غير مُهيّأ على الخادم — لن يُقبل حفظ أي مفتاح حتى يُضبط. لا يُحفظ مفتاح بلا تشفير.
              </p>
            )}

            <ul className="mt-2 space-y-2">
              {providers.map((p) => (
                <li key={p.id} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-[var(--sys-heading)]">{p.label}</span>
                    {system.providerKeys[p.id]?.configured ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md border border-[var(--sys-success)]/40 bg-[var(--sys-success-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--sys-success)]">
                          مفتاح محفوظ
                        </span>
                        {system.providerKeys[p.id]?.savedAt && (
                          <span className="text-xs text-[var(--sys-muted)]">
                            منذ {arDate(system.providerKeys[p.id]!.savedAt as string)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void clearKey(p.id)}
                          disabled={systemBusy}
                          className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--sys-destructive)] hover:underline disabled:opacity-50 md:min-h-0"
                        >
                          احذف المفتاح
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--sys-muted)]">
                        {p.keyOptional ? 'بلا مفتاح — وأكثر الخوادم المحلية لا تطلب مفتاحاً' : 'بلا مفتاح'}
                      </span>
                    )}
                  </div>
                  {/* Drawn by the shared field, not by hand: a key pasted
                      into a box with no eye is a key nobody can check before
                      pressing save, and the hand-written version also drew
                      its edge with the divider token at 1.25:1. */}
                  <Input
                    type="password"
                    value={keyDrafts[p.id] ?? ''}
                    onChange={(e) => setKeyDrafts({ ...keyDrafts, [p.id]: e.target.value })}
                    placeholder={system.providerKeys[p.id]?.configured ? 'الصق مفتاحاً جديداً ليحلّ محلّه' : 'الصق المفتاح هنا'}
                    dir="ltr"
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted)]">{p.keyHelp}</p>

                  {/*
                    THE ADDRESS OF A MODEL THE OWNER RUNS HIMSELF.
                    Refused unless it is on his own network — the server would
                    otherwise send every prompt, with its customer names and
                    its figures, wherever this box said. The server applies the
                    rule and names the reason; nothing is checked only here.
                  */}
                  {p.needsEndpoint && (
                    <div className="mt-2 border-t border-[var(--sys-border)] pt-2">
                      <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]" htmlFor="ai-local-url">
                        عنوان الخادم
                      </label>
                      <input
                        id="ai-local-url"
                        value={localUrl}
                        onChange={(e) => setLocalUrl(e.target.value)}
                        placeholder="http://localhost:11434"
                        className={INPUT}
                        dir="ltr"
                        autoComplete="off"
                      />
                      <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted)]">
                        على الخادم نفسه أو على شبكتك الداخلية فقط. عنوان على الإنترنت مرفوض — مزوّد على
                        الإنترنت يُضاف كـ«خادم متوافق مع OpenAI» بمفتاحه.
                      </p>
                    </div>
                  )}

                  {/*
                    AN OPENAI-COMPATIBLE SERVER ON THE INTERNET.
                    Always an outside party: the server refuses to send it a
                    customer, whatever is typed here. The address is https and a
                    public name; the key is bound to it, so changing the address
                    asks for a new key.
                  */}
                  {p.needsHttpsEndpoint && (
                    <div className="mt-2 space-y-2 border-t border-[var(--sys-border)] pt-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]" htmlFor="ai-compat-url">
                          عنوان الخادم (https)
                        </label>
                        <input
                          id="ai-compat-url"
                          value={compatUrl}
                          onChange={(e) => setCompatUrl(e.target.value)}
                          placeholder="https://…/v1"
                          className={INPUT}
                          dir="ltr"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]" htmlFor="ai-compat-model">
                          اسم النموذج على خادمك
                        </label>
                        <input
                          id="ai-compat-model"
                          value={compatModel}
                          onChange={(e) => setCompatModel(e.target.value)}
                          className={INPUT}
                          dir="ltr"
                          autoComplete="off"
                        />
                      </div>
                      <p className="text-xs leading-relaxed text-[var(--sys-muted)]">
                        اسم النموذج كما يعرّفه خادمك، وكل مساعد بيقدر يختار غيره من «أخرى». هذا الخادم خارجي:
                        اسم الزبون ورقمه وعنوانه ما بيوصلوه أبداً. وتغيير العنوان بيحذف المفتاح — الصق مفتاحاً جديداً معه.
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void saveSystem()}
                disabled={systemBusy}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-[var(--sys-primary)] px-4 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-50 md:h-10"
              >
                {systemBusy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
                احفظ حسابات النظام
              </button>
              {system.savedAt && (
                <span className="text-xs text-[var(--sys-muted)]">
                  آخر تعديل {arDate(system.savedAt)}
                  {system.savedBy ? ` — ${system.savedBy}` : ''}
                </span>
              )}
              {systemMsg && (
                <span className={`text-xs ${systemMsg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
                  {systemMsg.text}
                </span>
              )}
            </div>
          </div>
        )}

        {systemAllowed === false && (
          <p className="mt-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            حسابات المزوّدين تُضبط على مستوى النظام، ويضبطها مدير النظام. النصوص وتوجيه المساعدين
            في التبويبات الأخرى تخصّ شركتك ويمكنك تعديلها.
          </p>
        )}

        {/* A key is pasted and saved, and nothing says whether it works —
            the assistant just quietly stops being an assistant. This asks
            the provider one cheap question and repeats what came back. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--sys-border)] pt-3">
          <button
            type="button"
            onClick={() => void testConnection()}
            /* A local server needs no key, so "has a key" is the wrong gate
               for it — the gate is whether anything is configured at all. */
            /*
              ENABLED WHEN THE RESOLVER WOULD FIND SOMETHING TO USE.
              The old gate asked three separate questions — the company's
              `hasKey`, the installation's key for the provider the screen
              happens to show, and the local address — and could say «no
              key» beside a key the resolver would in fact have used (the
              installation's, for a provider the dropdown was not showing).
              `describeRoute` answers it once, the same way the call will.
            */
            disabled={testing || !canTest}
            className="inline-flex h-11 md:h-8 items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-3 text-xs font-semibold text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] disabled:opacity-50"
          >
            {testing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiPlugLine className="h-4 w-4" />}
            اختبار الاتصال
          </button>
          {!canTest && (
            <span className="text-xs text-[var(--sys-muted)]">احفظ المفتاح أو عنوان الخادم أولاً.</span>
          )}
          {test && (
            <span className={`text-xs ${test.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{test.text}</span>
          )}
        </div>
      </section>

      {/* ── the words ── */}
      <section className={`rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 ${tab === 'prompts' ? '' : 'hidden'}`}>
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">النصوص</h2>
        <p className="mb-3 mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          كل وظيفة ونصّها. اترك الحقل فارغاً ليعود النص الأصلي — لا يُحفَظ إلا ما غيّرته أنت،
          فتبقى الوظائف التي لم تلمسها على أحدث صياغة.
        </p>

        <div className="space-y-2">
          {jobs.map((job) => {
            const value = drafts[job.key] ?? '';
            const overridden = Boolean(value.trim()) && value.trim() !== job.default.trim();
            const isOpen = open === job.key;
            const missing = overridden ? missingSlots(job.key, value) : [];
            return (
              <div key={job.key} className="rounded-lg border border-[var(--sys-border)]">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : job.key)}
                  className="flex w-full items-start justify-between gap-2 px-3 py-2 text-start"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-[var(--sys-foreground)]">{job.label}</span>
                      {overridden && (
                        <span className="rounded-lg bg-[var(--sys-primary-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--sys-primary)]">
                          معدّل
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">{job.where}</span>
                  </span>
                  <RiArrowDownSLine className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--sys-muted)] transition ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                {isOpen && (
                  <div className="border-t border-[var(--sys-surface-strong)] p-3">
                    <p className="mb-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{job.note}</p>

                    {job.slots.length > 0 && (
                      <p className="mb-2 text-xs text-[var(--sys-muted-foreground)]">
                        يستبدل النظام:{' '}
                        {job.slots.map((s) => (
                          <code key={s} className="mx-0.5 rounded-lg bg-[var(--sys-surface-strong)] px-1 font-mono text-xs">{s}</code>
                        ))}
                      </p>
                    )}

                    <textarea
                      value={value}
                      onChange={(e) => setDrafts({ ...drafts, [job.key]: e.target.value.slice(0, MAX_PROMPT) })}
                      rows={8}
                      placeholder={job.default || 'لا نصّ افتراضي لهذه الوظيفة — اكتب تعليماتك.'}
                      className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 w-full rounded-lg border border-[var(--sys-border-input)] p-2 font-mono text-xs leading-relaxed text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]"
                    />

                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-[var(--sys-muted)]">{value.length} / {MAX_PROMPT}</span>
                      {overridden && (
                        <button
                          type="button"
                          onClick={() => setDrafts({ ...drafts, [job.key]: '' })}
                          className="flex items-center gap-1 text-xs font-semibold text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]"
                        >
                          <RiArrowGoBackLine className="icon-mirror h-4 w-4" /> أعد النص الأصلي
                        </button>
                      )}
                    </div>

                    {/* What it said before. A prompt is the one setting where
                        a good change and a ruinous one look identical in the
                        box, and the wording that worked is otherwise gone. */}
                    {(settings.promptHistory?.[job.key]?.length ?? 0) > 0 && (
                      <details className="mt-2 rounded-lg border border-[var(--sys-border)]">
                        <summary className="min-h-11 md:min-h-0 inline-flex items-center cursor-pointer px-2 py-1.5 text-xs font-semibold text-[var(--sys-muted-foreground)]">
                          النسخ السابقة ({settings.promptHistory![job.key].length})
                        </summary>
                        <ul className="divide-y divide-[var(--sys-surface-strong)] border-t border-[var(--sys-surface-strong)]">
                          {settings.promptHistory![job.key].map((v, n) => (
                            <li key={n} className="px-2 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-[var(--sys-muted)]">
                                  <span dir="ltr" className="tabular-nums">{v.at.slice(0, 16).replace('T', ' ')}</span>
                                  {v.by && <span> · {v.by}</span>}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setDrafts({ ...drafts, [job.key]: v.text })}
                                  className="flex items-center gap-1 text-xs font-semibold text-[var(--sys-primary)]"
                                >
                                  <RiArrowGoBackLine className="icon-mirror h-4 w-4" /> استرجع
                                </button>
                              </div>
                              {/* Restoring puts it in the box; the save button
                                  is still the one that commits it. */}
                              <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                                {v.text || 'النص الأصلي (بلا تعديل)'}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {/* Not an error — a seller may well want a prompt that
                        ignores the context — but said out loud, because a
                        summary prompt with no {context} summarises nothing
                        and fails silently otherwise. */}
                    {missing.length > 0 && (
                      <p className="mt-1.5 flex items-start gap-1 rounded-lg bg-[var(--sys-warning-soft)] p-1.5 text-xs leading-relaxed text-[var(--sys-warning)]">
                        <RiAlertLine className="mt-px h-4 w-4 shrink-0" />
                        <span>
                          نصّك لا يحتوي {missing.join('، ')} — لن تصل الأرقام إلى النموذج، وسيجيب من
                          عنده. أضفها حيث تريد أن تُدرَج.
                        </span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* The words said to a CUSTOMER, on the same tab as the words said to
          the model — they are the same job of work, and a seller fixing how
          the shop speaks should not have to remember which of two screens
          holds which half of it. Its own save button, because these are
          stored apart and one form saving both would be a form where half
          of it silently did nothing. */}
      <section className={`rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4 ${tab === 'prompts' ? '' : 'hidden'}`}>
        <h2 className="mb-3 text-sm font-bold text-[var(--sys-heading)]">قوالب رسائل الزبائن</h2>
        <MessageTemplatesCard />
      </section>

      {/*
        AND THE SAVE BUTTON IS ON EVERY TAB.

        It was hidden on «المساعدون» — which made sense while that tab's
        choices were not saved by it. Now they are, and a tab with changes
        and no way to keep them is the shape of the original defect.
      */}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
          احفظ الإعدادات والنصوص
        </Button>
        {msg && (
          <span className={`text-xs font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

/** Which stored key answered — never the key. */
const KEY_SOURCE_AR: Record<string, string> = {
  system: 'النظام',
  company: 'الشركة',
  legacy: 'المفتاح القديم',
  env: 'متغيّر البيئة',
};

const INPUT =
  'w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-3 py-2 text-sm text-[var(--sys-heading)] outline-none focus:border-[var(--sys-primary)]';
