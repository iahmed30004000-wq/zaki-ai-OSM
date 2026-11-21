'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadFailed } from '@/components/ui/LoadFailed';
import { useAsk, useConfirm } from '@/components/ui/Confirm';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';

/**
 * «قواعد خاصة» — THE OWNER'S OWN RULES OF THE DESK, ON THE RULES PAGE (request Q4c of the rules plan, 21/11; the owner's decision of 20/11).
 *
 * Two ways in, side by side: «قوالب جاهزة» — the eight example rules, every one OFF until pressed; pressing one opens the same dialog, filled — and «اكتب قاعدتك» —
 * the same dialog, empty: on whom · in which store · when · what → which number. Before a save the dialog shows «مين بتمسك ومين لا — وليش», computed by the server
 * from each person's real grants (`POST /api/confirmation/rules/preview`); a rule that binds nobody is saved only after a tick that says so. Under them, every rule
 * written, stopped ones too: a rule is stopped, renamed or re-dated — never deleted.
 *
 * It DECIDES NOTHING: every word about a rule, every range and every reason is the server's (`GET /api/confirmation/rules`); a refusal comes back as the server's
 * sentence beside the field that caused it, and what was typed stays. The order's amount is not a condition (the owner, 20/11): there is no such box.
 * Imported by the rules page only — never by the desk («طلباتي»), whose bundle sits at its ceiling. Nothing is imported from the rules' libraries.
 */

export interface OwnRuleRow {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  state: 'ACTIVE' | 'PENDING' | 'ENDED' | 'STOPPED';
  stateAr: string;
  whatAr: string;
  scopeAr: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  createdBy: string | null;
  broken: boolean;
}
export interface OwnRuleTemplate {
  key: string;
  name: string;
  kind: string;
  kindLabel: string;
  whatAr: string;
  hoursAr: string | null;
  needs: string[];
  acts: boolean;
  blockedAr: string | null;
  activeCount: number;
  prefill: { name: string; kind: string; hoursFrom?: string; hoursTo?: string; payload: Record<string, unknown>; days: number | null };
}
export interface OwnRuleNumber {
  key: string;
  kind: string;
  label: string;
  unit: string;
  range: { min: number; max: number };
}
export interface OwnRulesAnswer {
  rules: OwnRuleRow[];
  templates: OwnRuleTemplate[];
  numbers: OwnRuleNumber[];
  notActingYetAr: string;
  days: { min: number; max: number };
  stores: { id: string; name: string }[];
  people: { id: string; name: string }[] | null;
  canEdit: boolean;
  editKeyLabel: string;
  nextWorkStart: string;
}
export interface OwnRulePreview {
  bound: { id: string; name: string; numbers: string[] }[];
  notBound: { id: string; name: string; reason: string }[];
  notes: string[];
  bindsNobody: boolean;
}

interface Draft {
  templateKey: string | null;
  name: string;
  who: 'ALL' | 'NAMED';
  userIds: string[];
  storeId: string;
  timing: 'ALWAYS' | 'HOURS';
  hoursFrom: string;
  hoursTo: string;
  start: 'NEXT_WORK_START' | 'NOW';
  days: string;
  number: string;
  value: string;
}

const DOOR = '/api/confirmation/rules';
const PREVIEW_DOOR = '/api/confirmation/rules/preview';
export const NO_RULES_YET = 'ما في ولا قاعدة خاصة — كل الأرقام من القاعدة الأساسية.';
export const TEMPLATES_ARE_OFF = 'كلها مطفية لحد ما تشغّلها. الضغط بيفتح القاعدة معبّاية، وبتشوف مين بتمسك قبل الحفظ.';
export const WRITE_YOUR_OWN = 'اختار: على مين، بأي متجر، إيمتى، وشو بتغيّر.';
export const I_KNOW_IT_BINDS_NOBODY = 'بعرف إنها ما بتمسك حدا هلق — احفظها هيك';
export const BINDS_NOBODY_LINE = 'هالقاعدة ما بتمسك حدا هلق.';

const isNumberLike = (v: string) => v.trim() !== '' && !Number.isNaN(Number(v));

export function emptyDraft(numbers: OwnRuleNumber[]): Draft {
  return {
    templateKey: null, name: '', who: 'ALL', userIds: [], storeId: '', timing: 'ALWAYS', hoursFrom: '', hoursTo: '',
    start: 'NEXT_WORK_START', days: '', number: numbers[0]?.key ?? '', value: '',
  };
}

/** A template, as the dialog opens it: its name, hours, number and length; its blanks (the people it names) left for the owner. */
export function draftOfTemplate(t: OwnRuleTemplate, numbers: OwnRuleNumber[]): Draft {
  const number = Object.keys(t.prefill.payload).find((k) => numbers.some((n) => n.key === k)) ?? numbers[0]?.key ?? '';
  const value = t.prefill.payload[number];
  return {
    ...emptyDraft(numbers),
    templateKey: t.key,
    name: t.prefill.name,
    who: t.needs.includes('userIds') ? 'NAMED' : 'ALL',
    timing: t.prefill.hoursFrom && t.prefill.hoursTo ? 'HOURS' : 'ALWAYS',
    hoursFrom: t.prefill.hoursFrom ?? '',
    hoursTo: t.prefill.hoursTo ?? '',
    days: t.prefill.days === null ? '' : String(t.prefill.days),
    number,
    value: typeof value === 'number' ? String(value) : '',
  };
}

/** The draft as the door reads it. A box that is not a number goes as it is and the SERVER says why. */
export function bodyOf(d: Draft, numbers: OwnRuleNumber[]): Record<string, unknown> {
  const n = numbers.find((x) => x.key === d.number);
  return {
    kind: n?.kind ?? null,
    name: d.name,
    userIds: d.who === 'NAMED' ? d.userIds : null,
    storeId: d.storeId || null,
    hoursFrom: d.timing === 'HOURS' ? d.hoursFrom || null : null,
    hoursTo: d.timing === 'HOURS' ? d.hoursTo || null : null,
    start: d.start,
    days: d.days.trim() === '' ? null : isNumberLike(d.days) ? Number(d.days) : d.days,
    payload: n ? { [n.key]: isNumberLike(d.value) ? Number(d.value) : null } : {},
    templateKey: d.templateKey,
  };
}

export function OwnRulesCard({ onChanged }: { onChanged?: () => void }) {
  const [answer, setAnswer] = useState<OwnRulesAnswer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  const ask = useAsk();

  const load = useCallback(async () => {
    setFailed(null);
    try {
      setAnswer(await apiJson<OwnRulesAnswer>(DOOR));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'تعذّر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    await load();
    onChanged?.();
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    setActionError(null);
    try {
      await apiJson(`${DOOR}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await changed();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    }
  };

  const stop = async (r: OwnRuleRow) => {
    const yes = await confirm({
      title: `توقيف «${r.name}»؟`,
      body: 'بترجع الأرقام اللي بتغيّرها لحالها من هلق. القاعدة ما بتنحذف — بتضل بالسجل موقوفة.',
      confirmLabel: 'وقّفها',
      tone: 'danger',
    });
    if (yes) await patch(r.id, { action: 'stop' });
  };
  const rename = async (r: OwnRuleRow) => {
    const name = await ask({ title: 'اسم القاعدة', input: { label: 'الاسم الجديد', initial: r.name, required: true, maxLength: 80 }, confirmLabel: 'احفظ الاسم' });
    if (name !== null) await patch(r.id, { action: 'rename', name });
  };
  const redate = async (r: OwnRuleRow) => {
    const days = await ask({
      title: 'مدة القاعدة',
      body: 'كم يوم من بدايتها؟ فاضي = لحد ما توقّفها.',
      input: { label: 'عدد الأيام', initial: '' },
      confirmLabel: 'احفظ المدة',
    });
    if (days !== null) await patch(r.id, { action: 'dates', days: days.trim() === '' ? null : isNumberLike(days) ? Number(days) : days });
  };

  if (failed) {
    return (
      <Card>
        <CardHeader title="قواعد خاصة" />
        <CardContent>
          <LoadFailed message={failed} onRetry={() => void load()} />
        </CardContent>
      </Card>
    );
  }
  if (!answer) return null;

  return (
    <Card>
      <CardHeader
        title="قواعد خاصة"
        subtitle="قاعدة بتغيّر رقم واحد لموظفات بالاسم أو لمتجر أو لساعات. الأخص بتغلب: موظفة بالاسم ← متجر ← الكل ← القاعدة الأساسية. ما في حذف: القاعدة بتنوقف وبتضل بالسجل."
      />
      <CardContent className="space-y-4">
        {!answer.canEdit && (
          <p className="text-sm text-[var(--sys-warning)]" data-read-only>
            {`للقراءة بس — الكتابة بدها صلاحية «${answer.editKeyLabel}».`}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <section className="space-y-2" aria-label="قوالب جاهزة" data-templates>
            <h4 className="text-sm font-semibold text-[var(--sys-heading)]">قوالب جاهزة</h4>
            <p className="text-note text-[var(--sys-muted-foreground)]">{TEMPLATES_ARE_OFF}</p>
            <ul className="divide-y divide-[var(--sys-border)]">
              {answer.templates.map((t) => (
                <li key={t.key} className="space-y-1 py-3" data-template={t.key}>
                  <p className="text-sm font-medium text-[var(--sys-foreground)] break-words">{t.name}</p>
                  <p className="text-note text-[var(--sys-muted-foreground)] break-words">{[t.kindLabel, t.whatAr, t.hoursAr].filter(Boolean).join(' · ')}</p>
                  <p className={`text-note ${t.activeCount > 0 ? 'text-[var(--sys-foreground)]' : 'text-[var(--sys-muted-foreground)]'}`} data-template-state>
                    {t.activeCount > 0 ? `شغّالة — ${t.activeCount} قاعدة منها` : 'مطفية'}
                  </p>
                  {t.blockedAr && (
                    <p className="text-note text-[var(--sys-warning)]" data-template-blocked>
                      {t.blockedAr}
                    </p>
                  )}
                  {answer.canEdit && (
                    <Button variant="secondary" size="sm" disabled={!t.acts} onClick={() => setDraft(draftOfTemplate(t, answer.numbers))}>
                      شغّلها
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-2" aria-label="اكتب قاعدتك" data-write-own>
            <h4 className="text-sm font-semibold text-[var(--sys-heading)]">اكتب قاعدتك</h4>
            <p className="text-note text-[var(--sys-muted-foreground)]">{WRITE_YOUR_OWN}</p>
            {answer.canEdit && (
              <Button onClick={() => setDraft(emptyDraft(answer.numbers))} disabled={answer.numbers.length === 0}>
                قاعدة جديدة
              </Button>
            )}
            <p className="text-note text-[var(--sys-muted-foreground)]" data-not-acting-yet>
              {answer.notActingYetAr}
            </p>
          </section>
        </div>

        <section className="space-y-2 border-t border-[var(--sys-border)] pt-4" aria-label="القواعد المكتوبة" data-rules>
          <h4 className="text-sm font-semibold text-[var(--sys-heading)]">القواعد المكتوبة</h4>
          {actionError && (
            <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-action-error>
              {actionError}
            </p>
          )}
          {answer.rules.length === 0 ? (
            <p className="text-sm text-[var(--sys-muted-foreground)]" data-no-rules>
              {NO_RULES_YET}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--sys-border)]">
              {answer.rules.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 py-3 md:flex-row md:items-start md:justify-between" data-rule={r.id} data-state={r.state}>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-[var(--sys-foreground)] break-words">
                      {r.name} <span className="text-note text-[var(--sys-muted-foreground)]">· {r.stateAr}</span>
                    </p>
                    <p className={`text-note break-words ${r.broken ? 'text-[var(--sys-destructive)]' : 'text-[var(--sys-foreground)]'}`}>{r.whatAr}</p>
                    {r.scopeAr && <p className="text-note text-[var(--sys-muted-foreground)] break-words">{r.scopeAr}</p>}
                    <p className="text-note text-[var(--sys-muted-foreground)] break-words" data-rule-dates>
                      {`من ${arDateTime(r.effectiveFrom)}${r.effectiveTo ? ` لـ${arDateTime(r.effectiveTo)}` : ' — لحد ما تنوقف'}${r.createdBy ? ` · كتبها ${r.createdBy}` : ''}`}
                    </p>
                  </div>
                  {answer.canEdit && r.state !== 'STOPPED' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => rename(r)}>
                        غيّر الاسم
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => redate(r)}>
                        غيّر المدة
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => stop(r)}>
                        وقّفها
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>

      {draft && (
        <OwnRuleDialog
          answer={answer}
          initial={draft}
          onClose={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null);
            await changed();
          }}
        />
      )}
    </Card>
  );
}

type Refusal = { field: string; message: string };

function OwnRuleDialog({ answer, initial, onClose, onSaved }: { answer: OwnRulesAnswer; initial: Draft; onClose: () => void; onSaved: () => unknown }) {
  const [d, setD] = useState<Draft>(initial);
  const [preview, setPreview] = useState<OwnRulePreview | null>(null);
  const [overlap, setOverlap] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [knowsNobody, setKnowsNobody] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Any change makes the last preview stale: it is dropped, with the tick that answered it. */
  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setKnowsNobody(false);
    setPreview(null);
    setOverlap(null);
  };
  const number = answer.numbers.find((n) => n.key === d.number);
  const errorOf = (...fields: string[]) => (refusal && fields.some((f) => refusal.field === f || refusal.field.startsWith(`${f}.`)) ? refusal.message : undefined);
  const known = ['name', 'userIds', 'storeId', 'hoursFrom', 'hoursTo', 'start', 'days', 'payload', 'kind'];
  const topError = refusal && !known.some((f) => refusal.field === f || refusal.field.startsWith(`${f}.`)) ? refusal.message : null;

  const refused = useCallback((e: unknown) => {
    const data = (e as { data?: { field?: unknown; preview?: OwnRulePreview } }).data;
    if (data?.preview) setPreview(data.preview);
    setRefusal({ field: typeof data?.field === 'string' ? data.field : 'rule', message: e instanceof Error ? e.message : 'تعذّر' });
  }, []);

  const look = useCallback(async (draft: Draft) => {
    setBusy(true);
    setRefusal(null);
    try {
      const a = await apiJson<{ preview: OwnRulePreview; overlap: { errorAr: string } | null }>(PREVIEW_DOOR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyOf(draft, answer.numbers)),
      });
      setPreview(a.preview);
      setOverlap(a.overlap?.errorAr ?? null);
    } catch (e) {
      setPreview(null);
      refused(e);
    } finally {
      setBusy(false);
    }
  }, [answer.numbers, refused]);

  // A template opens on its preview at once (the owner, 20/11: pressing one opens «مين مربوطة»); a blank it still needs comes back as the server's sentence.
  useEffect(() => {
    if (initial.templateKey) void look(initial);
  }, [initial, look]);

  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await apiJson(DOOR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bodyOf(d, answer.numbers), confirmBindsNobody: knowsNobody }),
      });
      await onSaved();
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };

  const nobody = preview?.bindsNobody === true;
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={d.templateKey ? 'شغّل القالب' : 'قاعدة جديدة'}
      subtitle="أربع أسئلة: على مين · بأي متجر · إيمتى · شو بتغيّر."
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => look(d)}>
            شوف مين بتمسك
          </Button>
          <Button disabled={busy || (nobody && !knowsNobody)} onClick={() => save()}>
            احفظ وشغّل
          </Button>
        </div>
      }
    >
      <div className="space-y-4" dir="rtl" data-rule-dialog>
        {topError && (
          <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="rule">
            {topError}
          </p>
        )}
        <Input label="اسم القاعدة" value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} error={errorOf('name')} />

        <div className="space-y-2" data-question="who">
          <p className="text-sm font-medium text-[var(--sys-foreground)]">١. على مين</p>
          <Segmented
            size="sm"
            aria-label="على مين"
            value={d.who}
            onChange={(v) => set({ who: v === 'NAMED' ? 'NAMED' : 'ALL' })}
            options={[
              { value: 'ALL', label: 'كل الموظفات' },
              { value: 'NAMED', label: 'موظفات بالاسم' },
            ]}
          />
          {d.who === 'NAMED' &&
            (answer.people === null ? (
              <p className="text-note text-[var(--sys-warning)]">الأسماء بدها صلاحية «عرض الموظفين».</p>
            ) : answer.people.length === 0 ? (
              <p className="text-note text-[var(--sys-muted-foreground)]">ما في حدا على مكتب التأكيد بهالمتجر.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-x-3 sm:grid-cols-2" data-people>
                {answer.people.map((p) => (
                  <li key={p.id}>
                    <Checkbox
                      label={p.name}
                      checked={d.userIds.includes(p.id)}
                      onChange={(on) => set({ userIds: on ? [...d.userIds, p.id] : d.userIds.filter((u) => u !== p.id) })}
                    />
                  </li>
                ))}
              </ul>
            ))}
          {errorOf('userIds') && (
            <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="userIds">
              {errorOf('userIds')}
            </p>
          )}
        </div>

        <div className="space-y-2" data-question="store">
          <p className="text-sm font-medium text-[var(--sys-foreground)]">٢. بأي متجر</p>
          <Select
            label="المتجر"
            value={d.storeId}
            onChange={(e) => set({ storeId: e.target.value })}
            options={[{ value: '', label: 'كل المتاجر' }, ...answer.stores.map((s) => ({ value: s.id, label: s.name }))]}
            error={errorOf('storeId', 'productId', 'channelKind', 'phase')}
          />
        </div>

        <div className="space-y-2" data-question="when">
          <p className="text-sm font-medium text-[var(--sys-foreground)]">٣. إيمتى</p>
          <Segmented
            size="sm"
            aria-label="ساعات القاعدة"
            value={d.timing}
            onChange={(v) => set({ timing: v === 'HOURS' ? 'HOURS' : 'ALWAYS' })}
            options={[
              { value: 'ALWAYS', label: 'طول الدوام' },
              { value: 'HOURS', label: 'ساعات معيّنة' },
            ]}
          />
          {d.timing === 'HOURS' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="من الساعة" type="time" value={d.hoursFrom} onChange={(e) => set({ hoursFrom: e.target.value })} error={errorOf('hoursFrom')} />
              <Input label="لـلساعة" type="time" value={d.hoursTo} onChange={(e) => set({ hoursTo: e.target.value })} error={errorOf('hoursTo')} />
            </div>
          )}
          <Segmented
            size="sm"
            aria-label="بداية القاعدة"
            value={d.start}
            onChange={(v) => set({ start: v === 'NOW' ? 'NOW' : 'NEXT_WORK_START' })}
            options={[
              { value: 'NEXT_WORK_START', label: 'من بداية الدوام الجاي' },
              { value: 'NOW', label: 'هلق' },
            ]}
          />
          <p className="text-note text-[var(--sys-muted-foreground)]" data-next-start>
            {d.start === 'NOW' ? 'من لحظة الحفظ.' : `بداية الدوام الجاي: ${arDateTime(answer.nextWorkStart)}`}
          </p>
          <Input
            label="كم يوم (فاضي = لحد ما توقّفها)"
            type="number"
            inputMode="numeric"
            value={d.days}
            onChange={(e) => set({ days: e.target.value })}
            helperText={`من ${answer.days.min} لـ${answer.days.max} يوم`}
            error={errorOf('days', 'start', 'effectiveFrom', 'effectiveTo')}
          />
        </div>

        <div className="space-y-2" data-question="what">
          <p className="text-sm font-medium text-[var(--sys-foreground)]">٤. شو بتغيّر</p>
          <Select
            label="الرقم"
            value={d.number}
            onChange={(e) => set({ number: e.target.value, value: '' })}
            options={answer.numbers.map((n) => ({ value: n.key, label: n.label }))}
            error={errorOf('kind')}
          />
          <Input
            label={number ? `${number.label} (${number.unit})` : 'القيمة'}
            type="number"
            inputMode="numeric"
            value={d.value}
            onChange={(e) => set({ value: e.target.value })}
            helperText={number ? `من ${number.range.min} لـ${number.range.max}` : undefined}
            error={errorOf('payload')}
          />
          <p className="text-note text-[var(--sys-muted-foreground)]">{answer.notActingYetAr}</p>
        </div>

        {(preview || overlap) && (
          <div className="space-y-2 border-t border-[var(--sys-border)] pt-4" data-preview>
            {overlap && (
              <p className="text-sm text-[var(--sys-destructive)]" data-overlap>
                {overlap}
              </p>
            )}
            {preview && (
              <>
                {preview.notes.length > 0 && (
                  <ul className="space-y-0.5 text-note text-[var(--sys-warning)]" data-preview-notes>
                    {preview.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <p className="text-sm font-medium text-[var(--sys-foreground)]" data-bound-count>{`بتمسك ${preview.bound.length}`}</p>
                <ul className="space-y-0.5 text-note text-[var(--sys-foreground)]" data-bound>
                  {preview.bound.map((p) => (
                    <li key={p.id} className="break-words">{`${p.name} — ${p.numbers.join('، ')}`}</li>
                  ))}
                </ul>
                <p className="text-sm font-medium text-[var(--sys-foreground)]" data-not-bound-count>{`ما بتمسك ${preview.notBound.length}`}</p>
                <ul className="space-y-0.5 text-note text-[var(--sys-muted-foreground)]" data-not-bound>
                  {preview.notBound.map((p) => (
                    <li key={p.id} className="break-words">{`${p.name} — ${p.reason}`}</li>
                  ))}
                </ul>
                {nobody && (
                  <div className="space-y-1" data-binds-nobody>
                    <p className="text-sm text-[var(--sys-warning)]">{BINDS_NOBODY_LINE}</p>
                    <Checkbox label={I_KNOW_IT_BINDS_NOBODY} checked={knowsNobody} onChange={setKnowsNobody} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
