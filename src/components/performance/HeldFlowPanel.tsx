'use client';

import React, { useEffect, useState } from 'react';
import { HealthChip } from '@/components/ui/HealthChip';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { apiFetch, saidBy } from '@/lib/api-client';
import type { HealthTone } from '@/lib/health';
import {
  DEFAULT_FLOW_WINDOW,
  FLOW_WINDOWS,
  FLOW_WINDOW_KEYS,
  ageWords,
  minutesWords,
  percentOf,
  type FlowTone,
  type FlowWindowKey,
  type HeldFlow,
} from '@/lib/held-flow';

/**
 * «حركة الطلبات» — A SMALL PANEL AT THE TOP OF «لا رد والطلبات المحجوزة» (the owner, 13/11: «بدي لوحة تحكم صغيرة هون بس ذكية
 * نفهم الارقام وديناميكا حركة الطلبات وسلاستها»).
 *
 * Read only: nothing here presses anything but the choice of the window. It asks for `part=flow` ON ITS OWN — the board under it
 * never waits for it and never asks again when the window changes — and a failure is its own small line, never a blank board.
 * The sentence and its tone come from the server (`readFlow`); this draws them. Every share stands beside the counts it was made
 * from, and a base of zero is a dash, never «0%». No customer field, no order number: counts only.
 */

const FAILED = 'تعذّر تحميل حركة الطلبات. غيّر المدة أو أعد المحاولة بعد قليل.';
const OFFLINE = 'تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.';
const OLD_SERVER = 'حركة الطلبات مش متوفرة بنسخة الخادم الحالية — حدّث الصفحة بعد التحديث.';

type Asked = { ok: true; flow: HeldFlow } | { ok: false; said: string };

/** `part=flow` alone. A 200 without `flow` is a server that does not know the part (it answered the board and the report instead). */
async function ask(span: FlowWindowKey): Promise<Asked> {
  try {
    const res = await apiFetch(`/api/orders/confirmation/no-answer?part=flow&window=${span}`);
    if (!res.ok) return { ok: false, said: await saidBy(res, FAILED) };
    const body = (await res.json()) as { flow?: HeldFlow };
    return body.flow ? { ok: true, flow: body.flow } : { ok: false, said: OLD_SERVER };
  } catch {
    return { ok: false, said: OFFLINE };
  }
}

/** The card's surface by tone: calm · watch · problem — and the chip says it in a word, so colour never carries it alone. */
const TONE_CLASS: Record<FlowTone, string> = {
  CALM: 'bg-[var(--sys-card)] border-[var(--sys-border)]',
  WATCH: 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40',
  PROBLEM: 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]',
};
const CHIP_TONE: Record<FlowTone, HealthTone> = { CALM: 'good', WATCH: 'ok', PROBLEM: 'bad' };
const CHIP_WHY: Record<FlowTone, string> = {
  CALM: 'الأرقام تحت ما فيها شي بدّه متابعة',
  WATCH: 'في رقم بدّه متابعة',
  PROBLEM: 'في رقم تجاوز الحد',
};

/** A signed figure: «+27» when the pile grew, «−12» when it shrank. Left-to-right inside, so the sign never trails the digits. */
function signed(n: number) {
  return <span dir="ltr">{n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'}</span>;
}

function Tile({ label, value, detail }: { label: string; value: React.ReactNode; detail?: string }) {
  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] p-4 rounded-lg">
      <span className="text-xs font-bold text-[var(--sys-muted-foreground)]">{label}</span>
      <p className="text-lg font-black tabular-nums text-[var(--sys-heading)] mt-1.5">{value}</p>
      {detail && <p className="text-xs text-[var(--sys-muted-foreground)] mt-1">{detail}</p>}
    </div>
  );
}

export function HeldFlowPanel() {
  const [span, setSpan] = useState<FlowWindowKey>(DEFAULT_FLOW_WINDOW);
  // The answer carries the window it answered, so «loading» is simply «the answer on hand is for another window»: choosing a window
  // never has to clear anything, and an old figure can never be taken for the new window's.
  const [answer, setAnswer] = useState<{ span: FlowWindowKey; result: Asked } | null>(null);

  // On mount and on every choice of the window — and only this part. A stale answer never lands over a newer choice.
  useEffect(() => {
    let live = true;
    void ask(span).then((result) => {
      if (live) setAnswer({ span, result });
    });
    return () => {
      live = false;
    };
  }, [span]);

  const current = answer && answer.span === span ? answer.result : null;
  const flow = current && current.ok ? current.flow : null;
  const said = current && !current.ok ? current.said : null;

  return (
    <section
      aria-label="حركة الطلبات"
      aria-busy={!flow && !said}
      className={`rounded-lg border p-4 ${TONE_CLASS[flow?.reading.tone ?? 'CALM']}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--sys-heading)]">حركة الطلبات</h3>
          <p className="text-xs text-[var(--sys-muted-foreground)] mt-0.5">
            شو دخل أيدي الموظفات وشو طلع منها، وقديش بتضل الطلبات عندهن — للمتجر كله، أرقام بلا أسماء زبائن
          </p>
        </div>
        <div role="group" aria-label="مدة القراءة" className="flex flex-wrap gap-1.5">
          {FLOW_WINDOW_KEYS.map((key) => {
            const on = key === span;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setSpan(key)}
                className={`min-h-11 md:min-h-0 rounded-lg border px-3 py-1 text-xs font-semibold transition-colors ${
                  on
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                    : 'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]'
                }`}
              >
                {FLOW_WINDOWS[key].label}
              </button>
            );
          })}
        </div>
      </div>

      {said && (
        <p role="alert" className="mt-3 text-xs text-[var(--sys-warning)]">
          {said}
        </p>
      )}
      {!flow && !said && (
        <div className="mt-4">
          <SkeletonRows rows={3} />
        </div>
      )}
      {flow && <FlowBody flow={flow} />}
    </section>
  );
}

function FlowBody({ flow }: { flow: HeldFlow }) {
  const { entered, exits, held, speed, bounced, truncated } = flow;
  const others = entered.typed + entered.onTheLine;
  const pulledDetail = [
    'سحبة من الطابور',
    entered.typed > 0 ? `${entered.typed} أدخلتها الموظفات بنفسهن` : '',
    entered.onTheLine > 0 ? `${entered.onTheLine} أخدوها على الخط` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const netWords = flow.net > 0 ? 'المحجوز زاد' : flow.net < 0 ? 'المحجوز نقص' : 'متعادل';
  const buckets: [string, number][] = [
    ['أقل من 6 ساعات', held.under6h],
    ['من 6 لـ 24 ساعة', held.from6hTo24h],
    ['من يوم لـ 3 أيام', held.from1dTo3d],
    ['أكتر من 3 أيام', held.over3d],
  ];
  const fastShare = speed ? percentOf(speed.fast, speed.judged) : null;
  const notes = [
    flow.moved > 0 ? `حوّل المشرف أو أخد المالك ${flow.moved} طلب بين الأيدي — ما دخل بالصافي.` : '',
    flow.unknown > 0 ? `وفي ${flow.unknown} سجل بسبب أو نوع ما بنعرفو — ما دخل بأي رقم.` : '',
  ].filter(Boolean);

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-start gap-2">
        <HealthChip health={{ tone: CHIP_TONE[flow.reading.tone], label: flow.reading.label, why: CHIP_WHY[flow.reading.tone] }} className="shrink-0 mt-0.5" />
        <div className="space-y-1">
          {flow.reading.sentences.map((s) => (
            <p key={s} className="text-sm font-semibold text-[var(--sys-heading)]">
              {s}
            </p>
          ))}
        </div>
      </div>

      {(truncated.ledger || truncated.decisions) && (
        <p className="text-xs text-[var(--sys-warning)]">قراءة السجل وصلت حدها — الأرقام حد أدنى. اختر مدة أقصر.</p>
      )}

      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--sys-heading)]">الحركة — {flow.window.label}</p>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <Tile label="دخل النظام" value={flow.created} detail="طلب جديد بهالمدة" />
          <Tile label="انسحب" value={entered.pulled} detail={pulledDetail} />
          <Tile
            label="طلع من الأيدي"
            value={exits.total}
            detail={`أُكِّد ${exits.confirmed} · رجع للطابور ${exits.returned} · انلغى ${exits.cancelled}`}
          />
          <Tile label="الصافي" value={signed(flow.net)} detail={`دخل الأيدي ${entered.total} − طلع ${exits.total} = ${netWords}`} />
        </div>
        {others > 0 && (
          <p className="text-xs text-[var(--sys-muted-foreground)]">«بغير السحب» = طلب كتبته الموظفة بنفسها أو أخدته على الخط. دخل بالصافي، وما دخل بـ«انسحب».</p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--sys-heading)]">
          من قديش محجوزة — المحجوز هلّق {held.total}
          {held.oldestMs !== null && <span className="text-xs font-normal text-[var(--sys-muted-foreground)]"> · أقدمها من {ageWords(held.oldestMs)}</span>}
        </p>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {buckets.map(([label, n]) => (
            <Tile key={label} label={label} value={n} detail={held.total > 0 ? `من ${held.total}` : undefined} />
          ))}
        </div>
        {held.unknownAge > 0 && (
          <p className="text-xs text-[var(--sys-muted-foreground)]">وفي {held.unknownAge} طلب ما انسجّل وقت استلامه — ما دخل بأي خانة.</p>
        )}
        {truncated.held && <p className="text-xs text-[var(--sys-warning)]">قائمة المحجوز أطول من حد القراءة — الأرقام حد أدنى.</p>}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--sys-heading)]">سلاسة الشغل</p>
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
          <Tile
            label="وسيط الوقت لأول اتصال"
            value={speed && speed.medianMinutes !== null ? minutesWords(speed.medianMinutes) : '—'}
            detail={
              !speed
                ? 'ما انحسب — القراءة وصلت حدها'
                : speed.withAttempt > 0
                  ? `من ${speed.withAttempt} سحبة عليها محاولة — بدقائق الدوام`
                  : 'ما في سحبة عليها محاولة بهالمدة'
            }
          />
          <Tile
            label={`سحبات وصلها اتصال خلال ${flow.rules.fastMinutes} دقيقة`}
            value={fastShare === null ? '—' : `${fastShare}%`}
            detail={speed && speed.judged > 0 ? `${speed.fast} من ${speed.judged} سحبة` : 'ما في سحبة تنحكم عليها'}
          />
          <Tile
            label="طلبات تنقّلت بين موظفتين أو أكتر"
            value={bounced.of > 0 ? bounced.orders : '—'}
            detail={bounced.of > 0 ? `من ${bounced.of} طلب انسحب` : 'ما انسحب طلب بهالمدة'}
          />
        </div>
        {truncated.attempts && <p className="text-xs text-[var(--sys-warning)]">قراءة محاولات الاتصال وصلت حدها — اختر مدة أقصر.</p>}
      </div>

      <div className="space-y-1">
        {notes.map((n) => (
          <p key={n} className="text-xs text-[var(--sys-muted-foreground)]">
            {n}
          </p>
        ))}
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          الأرقام من سجل الاستلام وقرارات التأكيد لهالمتجر. أعمار المحجوز بالساعات الفعلية، وسرعة الاتصال بدقائق الدوام. إرجاع إشكال الإدخال وإرجاع
          المؤجَّل بدري وإيقاف الشحنة ما بينكتبوا بالسجل، فما دخلوا بـ«طلع من الأيدي».
        </p>
      </div>
    </div>
  );
}
