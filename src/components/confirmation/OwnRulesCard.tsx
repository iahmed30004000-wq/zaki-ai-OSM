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
 * ORDER NUMBERS (request Q4d, 21/11): a rule that changes an order's attempts, proof seconds or postpone limit names no person and no hours — the dialog then asks «على أي
 * طلبات» (a store, a product, a channel) instead, with the lists the server sends.
 *
 * PRIORITY AND ROUTING (request Q5c, 21/11): «هالطلبات أول» and «هالطلبات بس لهالموظفات» are chosen from the same list «شو بتغيّر», each with the server's side
 * effect written under it. They name orders — store, product, channel, new / retry, and hours — never a person; a routing rule's people are ticked under question
 * four, with the minutes of «طلبات بلا موظفة». The server's warnings (orders that may wait for nobody) stand above its preview.
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
  prefill: { name: string; kind: string; hoursFrom?: string; hoursTo?: string; channelKind?: string; phase?: string; payload: Record<string, unknown>; days: number | null };
}
export interface OwnRuleNumber {
  key: string;
  kind: string;
  label: string;
  unit: string;
  /** null = nothing is typed («هالطلبات أول»); for a routing rule, the minutes of «طلبات بلا موظفة» (Q5c). */
  range: { min: number; max: number } | null;
  defaultValue?: number;
  /** What choosing it does, written under it (Q5c); `{minutes}` is the minutes typed (or the default). */
  effectAr?: string;
}
export interface OwnRulesAnswer {
  rules: OwnRuleRow[];
  templates: OwnRuleTemplate[];
  numbers: OwnRuleNumber[];
  /** null = every kind acts (Q5c). */
  notActingYetAr: string | null;
  days: { min: number; max: number };
  stores: { id: string; name: string }[];
  /** The company's products and the channel kinds — «على أي طلبات» of an order rule (Q4d). Absent from an older answer: no such lists. */
  products?: { id: string; name: string }[];
  channels?: { value: string; label: string }[];
  /** «نوع الطلب» of a priority or routing rule (Q5c). */
  phases?: { value: string; label: string }[];
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
  /** What may leave orders waiting for nobody (Q5c, routing) — the server's sentences. */
  warnings?: string[];
}

interface Draft {
  templateKey: string | null;
  name: string;
  who: 'ALL' | 'NAMED';
  userIds: string[];
  storeId: string;
  productId: string;
  channelKind: string;
  /** '' = every order; NEW / RETRY (Q5c, the two order-wide kinds). */
  phase: string;
  /** The people a routing rule gives its orders to (Q5c). */
  toUserIds: string[];
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
export const ORDER_RULE_NAMES_NOBODY = 'أرقام الطلب بتمشي على الطلب نفسه، مين ما كانت الموظفة اللي عم تتصل.';
export const ORDER_RULE_HAS_NO_HOURS = 'أرقام الطلب ما بتتغيّر حسب الساعة — الطلب بيكمّل دورته على نفس الأرقام.';
const ORDER_KIND = 'ORDER_NUMBERS';
const PRIORITY_KIND = 'PRIORITY';
const ROUTING_KIND = 'ROUTING';
/** The kinds that name ORDERS, never a person: they ask «على أي طلبات» (Q4d, Q5c). */
const ORDER_WIDE = [ORDER_KIND, PRIORITY_KIND, ROUTING_KIND];
export const ORDER_WIDE_NAMES_NOBODY = 'بتمشي على الطلبات اللي بتختارها تحت، مش على موظفات.';
export const ROUTING_PEOPLE_BELOW = 'مين بياخد طلباتها بتختارهن بالسؤال الرابع.';

const isNumberLike = (v: string) => v.trim() !== '' && !Number.isNaN(Number(v));

/** The side effect of a kind (the server's words), with the minutes typed — or the default — where it says `{minutes}`. */
export function effectOf(n: OwnRuleNumber | undefined, value: string): string | null {
  if (!n?.effectAr) return null;
  const minutes = isNumberLike(value) ? String(Number(value)) : n.defaultValue !== undefined ? String(n.defaultValue) : '';
  return n.effectAr.replace('{minutes}', minutes);
}

export function emptyDraft(numbers: OwnRuleNumber[]): Draft {
  return {
    templateKey: null, name: '', who: 'ALL', userIds: [], storeId: '', productId: '', channelKind: '', phase: '', toUserIds: [], timing: 'ALWAYS', hoursFrom: '', hoursTo: '',
    start: 'NEXT_WORK_START', days: '', number: numbers[0]?.key ?? '', value: '',
  };
}

/** A template, as the dialog opens it: its name, hours, number and length; its blanks (the people it names) left for the owner. */
export function draftOfTemplate(t: OwnRuleTemplate, numbers: OwnRuleNumber[]): Draft {
  const number = Object.keys(t.prefill.payload).find((k) => numbers.some((n) => n.key === k)) ?? numbers[0]?.key ?? '';
  // A routing template (Q5c): its number is the people — left for the owner, a fresh empty list — and the box is its fallback minutes.
  const value = number === 'toUserIds' ? t.prefill.payload.fallbackMinutes : t.prefill.payload[number];
  return {
    ...emptyDraft(numbers),
    templateKey: t.key,
    name: t.prefill.name,
    who: t.needs.includes('userIds') ? 'NAMED' : 'ALL',
    timing: t.prefill.hoursFrom && t.prefill.hoursTo ? 'HOURS' : 'ALWAYS',
    hoursFrom: t.prefill.hoursFrom ?? '',
    hoursTo: t.prefill.hoursTo ?? '',
    channelKind: t.prefill.channelKind ?? '',
    phase: t.prefill.phase ?? '',
    toUserIds: [],
    days: t.prefill.days === null ? '' : String(t.prefill.days),
    number,
    value: typeof value === 'number' ? String(value) : '',
  };
}

/** The draft as the door reads it. A box that is not a number goes as it is and the SERVER says why. */
export function bodyOf(d: Draft, numbers: OwnRuleNumber[]): Record<string, unknown> {
  const n = numbers.find((x) => x.key === d.number);
  // An order rule names no person and no hours, and a rule of a person no product or channel: what the dialog does not show is not sent.
  const ofOrders = n?.kind === ORDER_KIND;
  // Q5c: priority and routing name orders too (store, product, channel, new / retry), and keep the hours.
  const wide = !!n && ORDER_WIDE.includes(n.kind);
  const typed = isNumberLike(d.value) ? Number(d.value) : d.value.trim() === '' ? undefined : d.value;
  const payload = !n
    ? {}
    : n.kind === PRIORITY_KIND
      ? { first: true }
      : n.kind === ROUTING_KIND
        ? { toUserIds: [...d.toUserIds], ...(typed === undefined ? {} : { fallbackMinutes: typed }) }
        : { [n.key]: isNumberLike(d.value) ? Number(d.value) : null };
  return {
    kind: n?.kind ?? null,
    name: d.name,
    userIds: !wide && d.who === 'NAMED' ? d.userIds : null,
    storeId: d.storeId || null,
    ...(wide ? { productId: d.productId || null, channelKind: d.channelKind || null } : {}),
    ...(wide && !ofOrders ? { phase: d.phase || null } : {}),
    hoursFrom: !ofOrders && d.timing === 'HOURS' ? d.hoursFrom || null : null,
    hoursTo: !ofOrders && d.timing === 'HOURS' ? d.hoursTo || null : null,
    start: d.start,
    days: d.days.trim() === '' ? null : isNumberLike(d.days) ? Number(d.days) : d.days,
    payload,
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
        subtitle="قاعدة بتغيّر رقم واحد لموظفات بالاسم أو لمتجر أو لساعات — أو لطلبات منتج أو مصدر. الأخص بتغلب: موظفة بالاسم ← منتج أو مصدر ← متجر ← الكل ← القاعدة الأساسية. ما في حذف: القاعدة بتنوقف وبتضل بالسجل."
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
            {answer.notActingYetAr && (
              <p className="text-note text-[var(--sys-muted-foreground)]" data-not-acting-yet>
                {answer.notActingYetAr}
              </p>
            )}
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
  const ofOrders = number?.kind === ORDER_KIND;
  /** Q5c: priority or routing — orders by store, product, channel and new / retry, with hours. */
  const wide = !!number && ORDER_WIDE.includes(number.kind);
  const routing = number?.kind === ROUTING_KIND;
  const priority = number?.kind === PRIORITY_KIND;
  const effect = effectOf(number, d.value);
  const errorOf = (...fields: string[]) => (refusal && fields.some((f) => refusal.field === f || refusal.field.startsWith(`${f}.`)) ? refusal.message : undefined);
  const errorAt = (field: string) => (refusal?.field === field ? refusal.message : undefined);
  const known = ['name', 'userIds', 'storeId', 'productId', 'channelKind', 'hoursFrom', 'hoursTo', 'start', 'days', 'payload', 'kind'];
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
          <p className="text-sm font-medium text-[var(--sys-foreground)]">1. على مين</p>
          {ofOrders ? (
            <p className="text-note text-[var(--sys-muted-foreground)]" data-order-names-nobody>
              {ORDER_RULE_NAMES_NOBODY}
            </p>
          ) : wide ? (
            <p className="text-note text-[var(--sys-muted-foreground)]" data-orders-wide>
              {routing ? `${ORDER_WIDE_NAMES_NOBODY} ${ROUTING_PEOPLE_BELOW}` : ORDER_WIDE_NAMES_NOBODY}
            </p>
          ) : (
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
          )}
          {!wide && d.who === 'NAMED' &&
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
          <p className="text-sm font-medium text-[var(--sys-foreground)]">{wide ? '2. على أي طلبات' : '2. بأي متجر'}</p>
          <Select
            label="المتجر"
            value={d.storeId}
            onChange={(e) => set({ storeId: e.target.value })}
            options={[{ value: '', label: 'كل المتاجر' }, ...answer.stores.map((s) => ({ value: s.id, label: s.name }))]}
            error={errorOf('storeId', ...(wide ? [] : ['productId', 'channelKind']), ...(wide && !ofOrders ? [] : ['phase']))}
          />
          {wide && (
            <>
              <Select
                label="المنتج"
                value={d.productId}
                onChange={(e) => set({ productId: e.target.value })}
                options={[{ value: '', label: 'كل المنتجات' }, ...(answer.products ?? []).map((p) => ({ value: p.id, label: p.name }))]}
                error={errorOf('productId')}
              />
              <Select
                label="مصدر الطلب"
                value={d.channelKind}
                onChange={(e) => set({ channelKind: e.target.value })}
                options={[{ value: '', label: 'كل المصادر' }, ...(answer.channels ?? [])]}
                error={errorOf('channelKind')}
              />
              {!ofOrders && (
                <Select
                  label="نوع الطلب"
                  value={d.phase}
                  onChange={(e) => set({ phase: e.target.value })}
                  options={[{ value: '', label: 'كل الطلبات' }, ...(answer.phases ?? [])]}
                  error={errorOf('phase')}
                />
              )}
            </>
          )}
        </div>

        <div className="space-y-2" data-question="when">
          <p className="text-sm font-medium text-[var(--sys-foreground)]">3. إيمتى</p>
          {ofOrders ? (
            <p className="text-note text-[var(--sys-muted-foreground)]" data-order-has-no-hours>
              {ORDER_RULE_HAS_NO_HOURS}
            </p>
          ) : (
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
          )}
          {!ofOrders && d.timing === 'HOURS' && (
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
          <p className="text-sm font-medium text-[var(--sys-foreground)]">4. شو بتغيّر</p>
          <Select
            label="الرقم"
            value={d.number}
            onChange={(e) => set({ number: e.target.value, value: '' })}
            options={answer.numbers.map((n) => ({ value: n.key, label: n.label }))}
            error={errorOf('kind')}
          />
          {routing && (
            <div className="space-y-1" data-routing-people>
              <p className="text-sm text-[var(--sys-foreground)]">لمين طلباتها</p>
              {answer.people === null ? (
                <p className="text-note text-[var(--sys-warning)]">الأسماء بدها صلاحية «عرض الموظفين».</p>
              ) : answer.people.length === 0 ? (
                <p className="text-note text-[var(--sys-muted-foreground)]">ما في حدا على مكتب التأكيد بهالمتجر.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                  {answer.people.map((p) => (
                    <li key={p.id}>
                      <Checkbox
                        label={p.name}
                        checked={d.toUserIds.includes(p.id)}
                        onChange={(on) => set({ toUserIds: on ? [...d.toUserIds, p.id] : d.toUserIds.filter((u) => u !== p.id) })}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {errorAt('payload.toUserIds') && (
                <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="toUserIds">
                  {errorAt('payload.toUserIds')}
                </p>
              )}
            </div>
          )}
          {!priority && (
            <Input
              label={routing ? `مهلة «طلبات بلا موظفة» (${number?.unit ?? ''})` : number ? `${number.label} (${number.unit})` : 'القيمة'}
              type="number"
              inputMode="numeric"
              value={d.value}
              onChange={(e) => set({ value: e.target.value })}
              helperText={number?.range ? `من ${number.range.min} لـ${number.range.max}` : undefined}
              error={routing ? errorAt('payload.fallbackMinutes') ?? errorAt('payload') : errorOf('payload')}
            />
          )}
          {effect && (
            <p className="text-note text-[var(--sys-warning)] break-words" data-effect>
              {effect}
            </p>
          )}
          {priority && errorOf('payload') && (
            <p className="text-sm text-[var(--sys-destructive)]" role="alert" data-refusal="payload">
              {errorOf('payload')}
            </p>
          )}
          {answer.notActingYetAr && <p className="text-note text-[var(--sys-muted-foreground)]">{answer.notActingYetAr}</p>}
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
                {preview.warnings && preview.warnings.length > 0 && (
                  <ul className="space-y-0.5 text-sm text-[var(--sys-destructive)]" role="alert" data-preview-warnings>
                    {preview.warnings.map((w) => (
                      <li key={w} className="break-words">{w}</li>
                    ))}
                  </ul>
                )}
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
