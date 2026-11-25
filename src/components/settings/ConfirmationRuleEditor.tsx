'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RiArrowDownLine, RiArrowUpLine, RiDeleteBinLine } from '@remixicon/react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { LoadFailed } from '@/components/ui/LoadFailed';
import { apiJson } from '@/lib/api-client';
import { useCan } from '@/hooks/useCan';
import { arDateTime } from '@/lib/format';

/**
 * «أرقام القاعدة» — THE OWNER EDITS THE NUMBERS OF THE ONE CONFIRMATION RULE (request Q3c of the rules plan, 20/11).
 *
 * One card on the rules page. It reads `GET /api/settings/confirmation-rule` (the rule in force, the pending change with its moment, the last ten versions, the
 * ranges, when «بداية الدوام الجاي» is) and `GET /api/settings/confirmation-rule/editors` (who holds the edit key, and the names behind the versions) — and it
 * DECIDES NOTHING: every range printed under a box is the server's, a save is sent whole and the server validates it whole; a refusal comes back as the server's
 * Arabic sentence and its field, and the sentence is printed beside THAT field while everything typed stays as it was typed.
 *
 *  · one box per number, its range under it; the steps as a list (add · remove · up · down) — «بعد كذا دقيقة» or «على موعد الصبح / المسا، مش قبل كذا ساعة»;
 *  · «يسري: هلق / من بداية الدوام الجاي» — the second by default (the owner's decision R5); the moment is the server's;
 *  · a pending change with its moment and «إلغاء التعديل»; the kept versions, each with «رجّع»;
 *  · who may edit, by name; without the edit key (`settings.manage`) the card is read-only and names the key it needs.
 *
 * Imported by the rules page only — never by the desk («طلباتي»), whose bundle sits at its ceiling. Nothing is imported from the rule's lib, not even its types
 * (`confirmation-rule-settings.test.ts` pins that no screen names it): the shapes below are the door's answer as `confirmation-rule-settings.ts` writes it.
 */

type RuleStep = { kind: 'after'; minutes: number } | { kind: 'anchor'; anchor: 'morning' | 'evening'; floorHours: number };
interface ConfirmationRuleNumbers {
  steps: RuleStep[];
  minDays: number;
  proofSeconds: number;
  hand: number;
  idleMinutes: number;
  morning: string;
  evening: string;
  freshMinutes: number;
  postponeMax: number;
}

type Ranges = Record<string, { min: number; max: number }>;
type WithAttempts = ConfirmationRuleNumbers & { attempts: number };
export interface RuleAnswer {
  rule: WithAttempts;
  pending: { rule: WithAttempts; effectiveAt: string; byUserId: string | null } | null;
  previous: { version: number; rule: WithAttempts; replacedAt: string; byUserId: string | null }[];
  savedAt: string | null;
  byUserId: string | null;
  defaults: WithAttempts;
  ranges: Ranges;
  nextWorkStart: string;
}
export interface EditorsAnswer {
  keyLabel: string;
  editors: { id: string; name: string }[] | null;
  names: Record<string, string> | null;
}

type DraftStep = { id: number; kind: 'after'; minutes: string } | { id: number; kind: 'anchor'; anchor: 'morning' | 'evening'; floorHours: string };
const NUMBER_FIELDS = ['minDays', 'proofSeconds', 'hand', 'idleMinutes', 'freshMinutes', 'postponeMax'] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];
interface Draft {
  steps: DraftStep[];
  numbers: Record<NumberField, string>;
  morning: string;
  evening: string;
}
type When = 'NEXT_WORK_START' | 'NOW';
type Refusal = { field: string; message: string };

const RULE_DOOR = '/api/settings/confirmation-rule';
const EDITORS_DOOR = '/api/settings/confirmation-rule/editors';

/** Each number's box: its label and which range of the server's answer is printed under it. */
export const NUMBER_LABELS: Record<NumberField, string> = {
  minDays: 'على كم يوم مختلف',
  proofSeconds: 'ثواني إثبات الاتصال',
  hand: 'حد اليد (كم طلب بإيدها)',
  idleMinutes: 'مهلة الطلب المتروك (دقيقة دوام)',
  freshMinutes: 'الطلب الطازج (دقيقة)',
  postponeMax: 'حد تأجيل الزبون (مرات)',
};
export const WHEN_OPTIONS = [
  { value: 'NEXT_WORK_START', label: 'من بداية الدوام الجاي' },
  { value: 'NOW', label: 'هلق' },
] as const;
export const SOMEONE_SAVED_FIRST = 'في حدا حفظ تعديل بعد ما فتحت الصفحة — حفظك صار هو الأخير (آخر حفظ بيربح).';
export const PENDING_ALREADY_ACTS = 'التعديل المعلّق صار ساري — إذا بدك ترجع عنه استعمل «رجّع» من النسخ تحت.';
export const ORIGINAL_NUMBERS = 'الأرقام الأصلية';
/** «رجّع الافتراضي» (the owner, 20/11): fills the boxes with the default numbers the server sent; nothing is saved until «احفظ الأرقام». */
export const BACK_TO_DEFAULT = 'رجّع الافتراضي';
export const BACK_TO_DEFAULT_NOTE = 'بيعبّي الأرقام الأصلية بالخانات — ما بيسري شي لحد ما تضغط «احفظ الأرقام».';

const rangeLine = (r: { min: number; max: number } | undefined, unit = '') => (r ? `من ${r.min} لـ${r.max}${unit}` : undefined);
let nextStepId = 1;

function draftOf(rule: ConfirmationRuleNumbers): Draft {
  return {
    steps: rule.steps.map((s) =>
      s.kind === 'after' ? { id: nextStepId++, kind: 'after', minutes: String(s.minutes) } : { id: nextStepId++, kind: 'anchor', anchor: s.anchor, floorHours: String(s.floorHours) }
    ),
    numbers: Object.fromEntries(NUMBER_FIELDS.map((f) => [f, String(rule[f])])) as Record<NumberField, string>,
    morning: rule.morning,
    evening: rule.evening,
  };
}

/** What is typed, as the door reads it. A box that is not a number goes as it is (JSON `null`) and the SERVER says why. */
const asNumber = (v: string) => (v.trim() === '' ? null : Number(v));
function ruleOf(d: Draft): Record<string, unknown> {
  return {
    steps: d.steps.map((s) => (s.kind === 'after' ? { kind: 'after', minutes: asNumber(s.minutes) } : { kind: 'anchor', anchor: s.anchor, floorHours: asNumber(s.floorHours) })),
    ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f, asNumber(d.numbers[f])])),
    morning: d.morning,
    evening: d.evening,
  };
}

/** One step in words. */
export function stepWords(s: RuleStep): string {
  if (s.kind === 'after') return `بعد ${s.minutes} دقيقة`;
  return `${s.anchor === 'morning' ? 'موعد الصبح' : 'موعد المسا'}، مش قبل ${s.floorHours} ساعة`;
}

/** A whole rule on one line — every figure as the server sent it. */
export function ruleWords(r: WithAttempts): string {
  return [
    `${r.attempts} محاولات: ${r.steps.map(stepWords).join(' ← ')}`,
    `على ${r.minDays} يوم`,
    `إثبات ${r.proofSeconds} ثانية`,
    `حد اليد ${r.hand}`,
    `المتروك ${r.idleMinutes} دقيقة`,
    `الطازج ${r.freshMinutes} دقيقة`,
    `التأجيل ${r.postponeMax} مرات`,
    `الصبح ${r.morning} · المسا ${r.evening}`,
  ].join(' · ');
}

export function ConfirmationRuleEditor() {
  const router = useRouter();
  const canEdit = useCan('settings.manage');
  const [answer, setAnswer] = useState<RuleAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [people, setPeople] = useState<EditorsAnswer | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [when, setWhen] = useState<When>('NEXT_WORK_START');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const take = useCallback((a: RuleAnswer) => {
    setAnswer(a);
    setDraft(draftOf(a.pending?.rule ?? a.rule));
  }, []);

  const loadPeople = useCallback(async () => {
    try {
      setPeople(await apiJson<EditorsAnswer>(EDITORS_DOOR));
    } catch {
      setPeople(null);
    }
  }, []);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      take((await apiJson<{ confirmationRule: RuleAnswer }>(RULE_DOOR)).confirmationRule);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'تعذّر التحميل');
    }
  }, [take]);

  useEffect(() => {
    void load();
    void loadPeople();
  }, [load, loadPeople]);

  /** A write went through: the card shows what the server now holds, and the box above («القاعدة بالمختصر») is read again. */
  const written = (a: RuleAnswer) => {
    setRefusal(null);
    take(a);
    router.refresh();
    void loadPeople();
  };
  const refused = (e: unknown) => {
    const data = (e as { data?: { field?: unknown } }).data;
    setRefusal({ field: typeof data?.field === 'string' ? data.field : 'rule', message: e instanceof Error ? e.message : 'تعذّر الحفظ' });
  };

  const send = async (method: 'PUT' | 'POST', body: unknown) => {
    const a = await apiJson<{ confirmationRule: RuleAnswer }>(RULE_DOOR, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    written(a.confirmationRule);
  };

  const save = async () => {
    if (!draft || !answer) return;
    setBusy(true);
    setNotice(null);
    try {
      // Last write wins — but the person saving is told when somebody else saved since this card was read.
      const fresh = (await apiJson<{ confirmationRule: RuleAnswer }>(RULE_DOOR)).confirmationRule;
      if (fresh.savedAt !== answer.savedAt) setNotice(SOMEONE_SAVED_FIRST);
      await send('PUT', { rule: ruleOf(draft), when });
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  const cancelPending = async () => {
    if (!answer?.pending) return;
    if (Date.now() >= new Date(answer.pending.effectiveAt).getTime()) {
      setNotice(PENDING_ALREADY_ACTS);
      await load();
      return;
    }
    setBusy(true);
    try {
      await send('POST', { action: 'revert' });
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  const revertTo = async (version: number) => {
    setBusy(true);
    try {
      await send('POST', { action: 'revert', version });
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <Card>
        <CardHeader title="أرقام القاعدة" />
        <CardContent>
          <LoadFailed message={failed} onRetry={() => void load()} />
        </CardContent>
      </Card>
    );
  }
  if (!answer || !draft) return null;

  const R = answer.ranges;
  const locked = !canEdit || busy;
  const errorOf = (field: string) => (refusal?.field === field ? refusal.message : undefined);
  const nameOf = (id: string | null) => (id ? people?.names?.[id] ?? '—' : ORIGINAL_NUMBERS);
  const setNumber = (f: NumberField, v: string) => setDraft({ ...draft, numbers: { ...draft.numbers, [f]: v } });
  const setStep = (i: number, s: DraftStep) => setDraft({ ...draft, steps: draft.steps.map((x, j) => (j === i ? s : x)) });
  const moveStep = (i: number, by: -1 | 1) => {
    const steps = [...draft.steps];
    [steps[i], steps[i + by]] = [steps[i + by], steps[i]];
    setDraft({ ...draft, steps });
  };
  const firstAfter = answer.defaults.steps.find((s) => s.kind === 'after');
  const firstAnchor = answer.defaults.steps.find((s) => s.kind === 'anchor');
  const blankAfter = (): DraftStep => ({ id: nextStepId++, kind: 'after', minutes: firstAfter?.kind === 'after' ? String(firstAfter.minutes) : '' });
  const blankAnchor = (): DraftStep => ({ id: nextStepId++, kind: 'anchor', anchor: 'morning', floorHours: firstAnchor?.kind === 'anchor' ? String(firstAnchor.floorHours) : '' });
  const listError = errorOf('steps') ?? errorOf('attempts');
  const topError = refusal && !['steps', 'attempts', 'when', 'version', 'morning', 'evening', ...NUMBER_FIELDS].includes(refusal.field) && !refusal.field.startsWith('steps.') ? refusal.message : null;

  return (
    <Card>
      <CardHeader
        title="أرقام القاعدة"
        subtitle="من هون بتتغيّر أرقام القاعدة اللي فوق: عدد المحاولات ومواعيدها وحد اليد وباقي الأرقام. الخادم بيفحص كل رقم بنطاقه قبل ما ينحفظ."
      />
      <CardContent className="space-y-4">
        <div className="space-y-1" data-rule-editors>
          {people?.editors ? (
            <p className="text-sm text-[var(--sys-foreground)]">
              {`مين بيقدر يعدّل: ${people.editors.length ? people.editors.map((p) => p.name).join('، ') : 'ما حدا'}`}
            </p>
          ) : null}
          {!canEdit && (
            <p className="text-sm text-[var(--sys-warning)]" data-read-only>
              {`للقراءة بس — التعديل بدّو صلاحية «${people?.keyLabel ?? 'إعدادات النظام الحسّاسة'}».`}
            </p>
          )}
          {answer.savedAt && (
            <p className="text-note text-[var(--sys-muted-foreground)]" data-last-save>
              {`آخر حفظ: ${nameOf(answer.byUserId)} · ${arDateTime(answer.savedAt)}`}
            </p>
          )}
        </div>

        {answer.pending && (
          <div className="space-y-1" data-pending>
            <p className="text-sm font-medium text-[var(--sys-warning)]">{`في تعديل معلّق — بيسري ${arDateTime(answer.pending.effectiveAt)} (حفظو ${nameOf(answer.pending.byUserId)})`}</p>
            <p className="text-note text-[var(--sys-muted-foreground)]">{ruleWords(answer.pending.rule)}</p>
            {canEdit && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => cancelPending()}>
                إلغاء التعديل المعلّق
              </Button>
            )}
          </div>
        )}

        {topError && (
          <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="rule">
            {topError}
          </p>
        )}
        {notice && (
          <p className="text-sm text-[var(--sys-warning)]" data-notice>
            {notice}
          </p>
        )}

        <div className="space-y-2" data-steps>
          <p className="text-sm font-medium text-[var(--sys-foreground)]">
            {`المحاولات: ${draft.steps.length + 1} — الأولى أول اتصال، وبعدها كل خطوة محاولة (${rangeLine(R.steps) ?? ''} خطوات)`}
          </p>
          <ol className="divide-y divide-[var(--sys-border)]">
            {draft.steps.map((s, i) => (
              <li key={s.id} className="space-y-2 py-3" data-step={i}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--sys-foreground)]">{`المحاولة ${i + 2}`}</span>
                  <Segmented
                    size="sm"
                    aria-label={`نوع الخطوة ${i + 1}`}
                    disabled={locked}
                    value={s.kind}
                    onChange={(v) => setStep(i, v === s.kind ? s : v === 'after' ? { ...blankAfter(), id: s.id } : { ...blankAnchor(), id: s.id })}
                    options={[
                      { value: 'after', label: 'بعد دقائق' },
                      { value: 'anchor', label: 'على موعد' },
                    ]}
                  />
                  <IconButton label={`طلّع الخطوة ${i + 1} لفوق`} size="sm" disabled={locked || i === 0} onClick={() => moveStep(i, -1)}>
                    <RiArrowUpLine className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`نزّل الخطوة ${i + 1} لتحت`} size="sm" disabled={locked || i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}>
                    <RiArrowDownLine className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`شيل الخطوة ${i + 1}`}
                    size="sm"
                    disabled={locked || draft.steps.length <= (R.steps?.min ?? 0)}
                    onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}
                  >
                    <RiDeleteBinLine className="h-4 w-4" />
                  </IconButton>
                </div>
                {s.kind === 'after' ? (
                  <Input
                    label={`الخطوة ${i + 1}: بعد كم دقيقة`}
                    type="number"
                    inputMode="numeric"
                    value={s.minutes}
                    disabled={locked}
                    onChange={(e) => setStep(i, { ...s, minutes: e.target.value })}
                    helperText={rangeLine(R.afterMinutes, ' دقيقة')}
                    error={errorOf(`steps.${i}`)}
                  />
                ) : (
                  <div className="space-y-2">
                    <Segmented
                      size="sm"
                      aria-label={`موعد الخطوة ${i + 1}`}
                      disabled={locked}
                      value={s.anchor}
                      onChange={(v) => setStep(i, { ...s, anchor: v === 'evening' ? 'evening' : 'morning' })}
                      options={[
                        { value: 'morning', label: 'موعد الصبح' },
                        { value: 'evening', label: 'موعد المسا' },
                      ]}
                    />
                    <Input
                      label={`الخطوة ${i + 1}: مش قبل كم ساعة من اللي قبلها`}
                      type="number"
                      inputMode="numeric"
                      value={s.floorHours}
                      disabled={locked}
                      onChange={(e) => setStep(i, { ...s, floorHours: e.target.value })}
                      helperText={rangeLine(R.floorHours, ' ساعة')}
                      error={errorOf(`steps.${i}`)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
          {listError && (
            <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="steps">
              {listError}
            </p>
          )}
          {canEdit && (
            <Button variant="secondary" size="sm" disabled={busy || draft.steps.length >= (R.steps?.max ?? Infinity)} onClick={() => setDraft({ ...draft, steps: [...draft.steps, blankAfter()] })}>
              زيد خطوة
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-numbers>
          {NUMBER_FIELDS.map((f) => (
            <Input
              key={f}
              label={NUMBER_LABELS[f]}
              type="number"
              inputMode="numeric"
              value={draft.numbers[f]}
              disabled={locked}
              onChange={(e) => setNumber(f, e.target.value)}
              helperText={rangeLine(R[f])}
              error={errorOf(f)}
            />
          ))}
          <Input label="موعد الصبح" type="time" value={draft.morning} disabled={locked} onChange={(e) => setDraft({ ...draft, morning: e.target.value })} helperText="ساعة ودقيقة، قبل موعد المسا" error={errorOf('morning')} />
          <Input label="موعد المسا" type="time" value={draft.evening} disabled={locked} onChange={(e) => setDraft({ ...draft, evening: e.target.value })} helperText="ساعة ودقيقة، بعد موعد الصبح" error={errorOf('evening')} />
        </div>

        {canEdit && (
          <div className="space-y-2" data-save>
            <p className="text-sm font-medium text-[var(--sys-foreground)]">يسري:</p>
            <Segmented aria-label="يسري" disabled={busy} value={when} onChange={(v) => setWhen(v === 'NOW' ? 'NOW' : 'NEXT_WORK_START')} options={WHEN_OPTIONS.map((o) => ({ ...o }))} />
            <p className="text-note text-[var(--sys-muted-foreground)]" data-next-start>
              {when === 'NOW' ? 'من لحظة الحفظ.' : `بداية الدوام الجاي: ${arDateTime(answer.nextWorkStart)}`}
            </p>
            {errorOf('when') && (
              <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="when">
                {errorOf('when')}
              </p>
            )}
            <p className="text-note text-[var(--sys-muted-foreground)]" data-default-note>
              {BACK_TO_DEFAULT_NOTE}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy} onClick={() => save()}>
                احفظ الأرقام
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => { setRefusal(null); setDraft(draftOf(answer.defaults)); }} data-back-to-default>
                {BACK_TO_DEFAULT}
              </Button>
            </div>
          </div>
        )}

        {answer.previous.length > 0 && (
          <div className="space-y-1" data-versions>
            <p className="text-sm font-medium text-[var(--sys-foreground)]">النسخ السابقة — «رجّع» بيسري هلق</p>
            <ul className="divide-y divide-[var(--sys-border)]">
              {answer.previous.map((p) => (
                <li key={`${p.version}-${p.replacedAt}`} className="flex flex-col gap-1 py-3 md:flex-row md:items-start md:justify-between" data-version={p.version}>
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--sys-foreground)] break-words">{`${nameOf(p.byUserId)} · انتهت ${arDateTime(p.replacedAt)}`}</p>
                    <p className="text-note text-[var(--sys-muted-foreground)] break-words">{ruleWords(p.rule)}</p>
                  </div>
                  {canEdit && (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => revertTo(p.version)}>
                      رجّع
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {errorOf('version') && (
              <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="version">
                {errorOf('version')}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
