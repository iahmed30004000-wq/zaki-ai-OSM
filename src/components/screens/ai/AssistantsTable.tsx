'use client';

import React, { useState } from 'react';
import {
  ASSISTANTS, AI_SCOPES, SCOPE_LABEL_AR, SCOPE_NOTE_AR, type AiScope,
} from '@/lib/ai-assistants';
import { RiAlertLine, RiShieldCheckLine, RiShieldCrossLine, RiToolsLine } from '@remixicon/react';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * EVERY ASSISTANT, AND WHAT IT IS ALLOWED TO SEE.
 *
 * One assistant answered everything and was handed the whole business, so
 * there was nothing to show here: no list, no scope, no way for the owner
 * to know that the person confirming orders could ask what the company
 * earned.
 *
 * Each row says who it is for, what it may read, and what it may never do.
 * The scopes are not decoration — the service refuses to fetch a fact
 * outside them, so a row that says "no customer data" is a promise the
 * code keeps rather than a label on a prompt.
 *
 * Only the business-intelligence assistant has boxes to tick. The others
 * are narrow because their job is narrow; widening them would not be a
 * setting, it would be a different assistant.
 */

/**
 * A MODEL IS PICKED FROM A LIST, NOT TYPED AT.
 *
 * This was an `<input list>` with a `<datalist>`, and that was wrong three
 * ways at once, all of them reported from a real screen:
 *
 *   A datalist FILTERS ITS SUGGESTIONS BY WHAT IS IN THE BOX. A field already
 *   holding a full model id matches nothing, so the list opened empty — «even
 *   in the assistants tab they do not show».
 *
 *   Its popup is drawn by the browser and cannot be styled, so it arrived as a
 *   bare white panel over a dark screen — «and if they show, they show in a
 *   very stupid way».
 *
 *   And a text box beside a password field is a box Chrome offers to autofill
 *   with an email address.
 *
 * So: a real select of names that exist, and one explicit «أخرى» door for a
 * model a vendor ships before this file is edited. The door is the point —
 * the old free-text box was defended as future-proofing, and it did buy that,
 * at the price of every typo looking exactly like a choice.
 */
function ModelPicker({
  value,
  models,
  fallbackLabel,
  onChange,
  label,
}: {
  value: string | undefined;
  models: string[];
  fallbackLabel: string;
  onChange: (model: string | undefined) => void;
  label: string;
}) {
  const known = !value || models.includes(value);
  const [typing, setTyping] = React.useState(!known);

  return (
    <span className="flex flex-col gap-1">
      <select
        value={typing ? '__other__' : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === '__other__') {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(e.target.value || undefined);
        }}
        dir="ltr"
        aria-label={label}
        className="h-11 md:h-8 w-44 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
      >
        <option value="">{fallbackLabel ? `\u200fالافتراضي — ${fallbackLabel}` : '\u200fالافتراضي'}</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value="__other__">\u200fأخرى…</option>
      </select>
      {typing && (
        <input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="اسم النموذج كما عند المزوّد"
          dir="ltr"
          autoComplete="off"
          aria-label={`${label} — اسم آخر`}
          className="h-11 md:h-8 w-44 rounded-lg border border-[var(--sys-warning)]/60 bg-[var(--sys-card)] px-2 text-xs"
        />
      )}
    </span>
  );
}

export function AssistantsTable({
  enabled,
  onSaved,
  providers,
  fallback,
  routing,
  onRouted,
  routes,
}: {
  /** The scopes the owner turned on for business intelligence. */
  enabled: string[];
  onSaved: (scopes: string[]) => void;
  /** Vendors this system speaks, with their suggested models. */
  providers: { id: string; label: string; defaultModel: string; models: string[] }[];
  /** The company default, used by any assistant that names nothing. */
  fallback: { provider: string; model: string };
  /** Per-assistant overrides, keyed by the assistant's prompt job. */
  routing: Record<string, { provider?: string; model?: string }>;
  onRouted: (next: Record<string, { provider?: string; model?: string }>) => void;
  /**
   * WHERE EACH ASSISTANT'S CALL WOULD ACTUALLY GO — from the server, not
   * worked out here. This table used to describe the route by reading the
   * company default and the row's own override, which is the resolution
   * written a second time: it knew nothing of the installation default or
   * of which key exists, so it could say «Anthropic» beside an assistant
   * whose calls were going to OpenRouter.
   */
  routes: Record<string, { provider: string; model: string; keyFrom: string; baseUrl: string | null }>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function toggle(scope: AiScope) {
    const next = enabled.includes(scope) ? enabled.filter((s) => s !== scope) : [...enabled, scope];
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings/ai', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ intelligenceScopes: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      onSaved(next);
      setMsg({ ok: true, text: 'حُفظ.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-[var(--sys-surface)] px-3 py-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        كل مساعد يقرأ ما هو مكتوب في سطره فقط — الخدمة ترفض جلب غيره، فالسطر وعدٌ يحفظه الكود لا وصفٌ
        على برومبت. ولا مساعد، مهما كان نطاقه، ينقل حالة طلب أو يسجّل حركة صندوق أو يغيّر سعراً أو
        يعتمد تسوية.
      </p>

      <div className="overflow-hidden rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
                <Rows
          rows={ASSISTANTS}
          keyOf={(a) => a.key}
          columns={[
            { key: 'c0', label: "المساعد", primary: true,
              render: (a) => (
                  <><p className="font-semibold text-[var(--sys-heading)]">{a.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{a.note}</p></>
                ) },
            { key: 'c1', label: "لمن", primary: true,
              render: (a) => (
                  <>{a.who}
                  <span className="mt-0.5 block text-xs text-[var(--sys-muted)]" dir="ltr">{a.needs}</span></>
                ) },
            { key: 'c2', label: "يقرأ",
              render: (a) => (
                  <>{a.scopes.length === 0 && !a.optionalScopes ? (
                    <span className="text-[var(--sys-muted)]">لا شيء من قاعدة البيانات</span>
                  ) : (
                    <span className="text-[var(--sys-foreground)]">
                      {a.scopes.map((s) => SCOPE_LABEL_AR[s]).join(' · ') || '—'}
                    </span>
                  )}
                  {a.optionalScopes && (
                    <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">
                      {enabled.length === 0 ? 'ولا مجال مؤشَّر' : `مؤشَّر: ${enabled.map((s) => SCOPE_LABEL_AR[s as AiScope]).join(' · ')}`}
                    </span>
                  )}</>
                ) },
            { key: 'c3', label: "بيانات الزبون",
              render: (a) => (a.pii ? (
                    <span className="inline-flex items-center gap-1 text-[var(--sys-warning)]">
                      <RiShieldCheckLine className="h-4 w-4" /> نعم
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[var(--sys-success)]">
                      <RiShieldCrossLine className="h-4 w-4" /> لا — أبداً
                    </span>
                  )) },
            /**
             * WHICH BRAIN THIS ONE USES.
             *
             * The tier is a per-assistant decision and the settings could
             * not express it: the note classifier runs on every follow-up
             * note — thousands a day — and the business analysis runs when
             * somebody asks. One model for both is either a surprising
             * bill or a useless analysis.
             *
             * «الافتراضي» is a real choice and the common one, so it is
             * first and costs nothing to keep.
             */
            { key: 'route', label: 'النموذج',
              render: (a) => {
                const mine = routing[a.promptJob] ?? {};
                const provider = mine.provider ?? fallback.provider;
                const models = providers.find((p) => p.id === provider)?.models ?? [];
                const set = (patch: { provider?: string; model?: string }) => {
                  const next = { ...routing };
                  const merged = { ...mine, ...patch };
                  // Switching vendor drops a model that belonged to the old
                  // one: `gpt-4o` is not a name Anthropic answers to.
                  if (patch.provider !== undefined && patch.provider !== mine.provider) delete merged.model;
                  const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => !!v));
                  if (Object.keys(clean).length === 0) delete next[a.promptJob];
                  else next[a.promptJob] = clean;
                  onRouted(next);
                };
                const actual = routes[a.promptJob];
                const vendorLabel = providers.find((p) => p.id === actual?.provider)?.label ?? actual?.provider;
                // LOCAL needs an address, not a key; everyone else needs a key,
                // and a compatible server needs its address as well.
                const unreachable = actual
                  ? actual.provider === 'LOCAL'
                    ? !actual.baseUrl
                    : actual.provider === 'OPENAI_COMPATIBLE'
                      ? !actual.baseUrl || actual.keyFrom === 'none'
                      : actual.keyFrom === 'none'
                  : false;
                return (
                  <span className="flex flex-col gap-1">
                    <select
                      value={mine.provider ?? ''}
                      onChange={(e) => set({ provider: e.target.value || undefined })}
                      className="h-11 md:h-8 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 text-xs"
                      aria-label={`مزوّد ${a.label}`}
                    >
                      <option value="">الافتراضي — {providers.find((p) => p.id === fallback.provider)?.label}</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                    <ModelPicker
                      value={mine.model}
                      models={models}
                      fallbackLabel={
                        mine.provider
                          ? (providers.find((p) => p.id === provider)?.defaultModel ?? '')
                          : fallback.model
                      }
                      onChange={(model) => set({ model })}
                      label={`نموذج ${a.label}`}
                    />
                    {/*
                      WHERE IT GOES, SAID BY THE THING THAT DECIDES.
                      The two controls above are a CHOICE; this line is the
                      ANSWER, and they are not the same thing — an assistant
                      that chooses nothing still goes somewhere, and that
                      somewhere may be the installation default rather than
                      the company's.
                    */}
                    {actual && (
                      <span className="text-xs text-[var(--sys-muted)]">
                        بيروح على: {vendorLabel} · {actual.model}
                        {unreachable ? (
                          <span className="text-[var(--sys-warning)]">
                            {' '}— {actual.provider === 'LOCAL' || (actual.provider === 'OPENAI_COMPATIBLE' && !actual.baseUrl) ? 'بلا عنوان' : 'بلا مفتاح'}
                          </span>
                        ) : null}
                      </span>
                    )}
                    {/*
                      AND A WARNING WHERE IT COSTS SOMETHING.
                      An assistant declared `pii: true` reads a customer. Off
                      the owner's own server the name and the notes are taken
                      out before the call — which is correct, and it is also a
                      worse answer. He should know that is the trade he is
                      making, beside the control that makes it.
                    */}
                    {actual && a.pii && actual.provider !== 'LOCAL' && (
                      <span className="flex flex-col gap-0.5 text-xs">
                        <span className="flex items-start gap-1 text-[var(--sys-warning)]">
                          <RiAlertLine className="mt-px h-4 w-4 shrink-0" />
                          هالمساعد بيقرا بيانات زبون — الاسم والملاحظات ما بيطلعوا لمزوّد خارجي
                        </span>
                        <span className="flex items-start gap-1 text-[var(--sys-heading)]">
                          <RiToolsLine className="mt-px h-4 w-4 shrink-0 text-[var(--sys-warning)]" />
                          لنتيجة كاملة: نموذج على خادمك
                        </span>
                      </span>
                    )}
                  </span>
                );
              } },
          ]}
          empty={
            <EmptyState
              title="لا مساعدين مُعرَّفين"
              why="كلُّ مساعدٍ يُربط بمزوّدٍ ونموذجٍ ونطاقٍ يقرأ منه. بلا تعريف، لا يعمل أيٌّ منها."
            />
          }
        />
      </div>

      {/* The one assistant whose reach is a decision rather than a job. */}
      <section className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
        <h3 className="text-sm font-bold text-[var(--sys-heading)]">ما يقرؤه مركز الذكاء</h3>
        <p className="mb-3 mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
          يبدأ بلا مجال واحد. أشّر ما تسمح له بقراءته — وغير المؤشَّر لا يُجلَب أصلاً، فلا يمكن
          استخراجه بسؤال ذكي.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {AI_SCOPES.filter((s) => s !== 'customer').map((scope) => (
            <label
              key={scope}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                enabled.includes(scope) ? 'border-[var(--sys-success-soft)] bg-[var(--sys-success-soft)]' : 'border-[var(--sys-border)]'
              }`}
            >
              <input
                type="checkbox"
                checked={enabled.includes(scope)}
                disabled={busy}
                onChange={() => void toggle(scope)}
                className="h-5 w-5 mt-0.5"
              />
              <span>
                <span className="block text-xs font-semibold text-[var(--sys-heading)]">{SCOPE_LABEL_AR[scope]}</span>
                <span className="block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{SCOPE_NOTE_AR[scope]}</span>
              </span>
            </label>
          ))}
        </div>
        {msg && (
          <p className={`mt-2 text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>
        )}
      </section>
    </div>
  );
}
