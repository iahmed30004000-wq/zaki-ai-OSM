'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import {
  fillTemplate,
  SITUATIONS,
  type FillContext,
  type MessageTemplate,
  type Situation,
} from '@/lib/message-templates';
import { RiAddCircleLine, RiArrowDownSLine, RiCheckLine, RiDeleteBinLine, RiLoader4Line, RiMessage3Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * THE SENTENCES SENT TO CUSTOMERS, FILED BY THE MOMENT THEY BELONG TO.
 *
 * They were one flat pile in the order somebody happened to add them, so an
 * agent hunting the right words mid-call read all of them. They are grouped
 * by the MOMENT now — she knows which moment she is in, and never knows
 * which of two channels a sentence was filed under.
 *
 * Two smaller things, both learned from messages that reached customers:
 *
 * The placeholders are BUTTONS. Typed from memory, `{اسم_الزبون}` becomes
 * `{اسم الزبون}` and goes out with a brace in it that the customer can do
 * nothing about. Clicked, it cannot be misspelled.
 *
 * And the preview runs on a REAL order of this store, not an invented one.
 * A made-up order checks the spelling of the placeholders and nothing else:
 * a template reads perfectly against "محمد / SY-2026-0150" and comes out
 * with a hole in it on the orders this shop actually takes, because nobody
 * here fills in a governorate, or the courier is set after the message goes.
 */

interface Loaded {
  templates: MessageTemplate[];
  vars: { key: string; label: string }[];
  languages: { code: string; label: string }[];
  /** The newest real order of this store. Null on a shop with no orders yet. */
  sample: FillContext | null;
}

const INPUT =
  'h-10 px-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-xs text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]';

/** Nothing to fill from — said plainly rather than previewed against a lie. */
const NO_SAMPLE = 'لا طلبات في هذا المتجر بعد، فلا معاينة بطلب حقيقي.';

export function MessageTemplatesCard() {
  const toast = useToast();
  // The templates are edited with «الإعدادات الحسّاسة», and the preview on a real order is read with it too
  // (`?sample=1` is refused without it — which used to draw a red box for everybody else).
  const canManage = useCan('settings.manage');
  const [data, setData] = useState<Loaded | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<Situation | null>(null);
  /** The body box last touched — where a clicked placeholder goes. */
  const boxes = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      const d = await apiJson<Loaded>('/api/settings/messages?sample=1');
      setData(d);
      setTemplates(d.templates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canManage) {
    return <p className="text-xs text-[var(--sys-muted)]">قوالب الرسائل تتعدّل لمن عنده «الإعدادات الحسّاسة».</p>;
  }
  if (error && !data) {
    return <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">{error}</p>;
  }
  if (!data) return null;

  const patch = (id: string, fields: Partial<MessageTemplate>) =>
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, ...fields } : t)));

  /**
   * Put a placeholder where the cursor is.
   *
   * Appending it to the end would be worse than typing it: the sentence is
   * being written in the middle, and a name that lands after the full stop
   * has to be cut and pasted back anyway.
   */
  const insertVar = (id: string, key: string) => {
    const box = boxes.current[id];
    const token = `{${key}}`;
    const body = templates.find((t) => t.id === id)?.body ?? '';
    if (!box) return patch(id, { body: body + token });
    const at = box.selectionStart ?? body.length;
    const to = box.selectionEnd ?? at;
    patch(id, { body: body.slice(0, at) + token + body.slice(to) });
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const d = await apiJson<{ templates: MessageTemplate[] }>('/api/settings/messages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates }),
      });
      setTemplates(d.templates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const add = (situation: Situation) =>
    setTemplates([
      ...templates,
      {
        id: `t-${situation}-${templates.length + 1}-${templates.length}`,
        name: '',
        channel: 'BOTH',
        body: '',
        situation,
        lang: data.languages[0]?.code ?? 'ar',
        active: true,
      },
    ]);

  return (
    <div className="space-y-2" dir="rtl">
      <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        تُرسَل من رقم شركتك عبر تطبيقك — بلا بوابة ولا اشتراك ولا كلفة لكل رسالة. مجمّعة حسب الموقف
        الذي تُقال فيه، لا حسب القناة.
      </p>

      {SITUATIONS.map((s) => {
        const mine = templates.filter((t) => t.situation === s.key);
        const isOpen = openGroup === s.key;
        const live = mine.filter((t) => t.active).length;
        return (
          <section key={s.key} className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)]">
            <button
              type="button"
              onClick={() => setOpenGroup(isOpen ? null : s.key)}
              className="flex w-full items-center gap-2 px-3 py-2 text-start"
            >
              <span className="flex-1 text-xs font-semibold text-[var(--sys-foreground)]">{s.ar}</span>
              <span className="text-xs tabular-nums text-[var(--sys-muted)]">
                {mine.length === 0 ? 'لا قوالب' : `${live} من ${mine.length} مفعّلة`}
              </span>
              <RiArrowDownSLine className={`h-4 w-4 text-[var(--sys-muted)] transition ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
              <div className="space-y-2 border-t border-[var(--sys-surface-strong)] p-2.5">
                {mine.map((t) => (
                  <div
                    key={t.id}
                    className={`space-y-2 rounded-lg border p-2.5 ${
                      t.active ? 'border-[var(--sys-border)]' : 'border-dashed border-[var(--sys-border)] bg-[var(--sys-surface)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={t.name}
                        onChange={(e) => patch(t.id, { name: e.target.value })}
                        placeholder="اسم القالب"
                        className={`${INPUT} min-w-[8rem] flex-1 font-semibold`}
                      />
                      <select
                        value={t.situation}
                        onChange={(e) => patch(t.id, { situation: e.target.value as Situation })}
                        className={`${INPUT} w-28`}
                        aria-label="الموقف"
                      >
                        {SITUATIONS.map((x) => (
                          <option key={x.key} value={x.key}>{x.ar}</option>
                        ))}
                      </select>
                      <select
                        value={t.channel}
                        onChange={(e) => patch(t.id, { channel: e.target.value as MessageTemplate['channel'] })}
                        className={`${INPUT} w-24`}
                        aria-label="القناة"
                      >
                        <option value="BOTH">الاثنتان</option>
                        <option value="SMS">SMS</option>
                        <option value="WHATSAPP">واتساب</option>
                      </select>
                      <select
                        value={t.lang}
                        onChange={(e) => patch(t.id, { lang: e.target.value })}
                        className={`${INPUT} w-24`}
                        aria-label="اللغة"
                      >
                        {data.languages.map((l) => (
                          <option key={l.code} value={l.code}>{l.label}</option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                        <input
                          type="checkbox"
                          checked={t.active}
                          onChange={(e) => patch(t.id, { active: e.target.checked })}
                          className="h-5 w-5 accent-[var(--sys-primary)]"
                        />
                        مفعّل
                      </label>
                      <button
                        type="button"
                        onClick={() => setTemplates(templates.filter((x) => x.id !== t.id))}
                        aria-label="احذف القالب"
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg p-1.5 text-[var(--sys-muted)] hover:bg-[var(--sys-destructive-soft)] hover:text-[var(--sys-destructive)]"
                      >
                        <RiDeleteBinLine className="h-4 w-4" />
                      </button>
                    </div>

                    <textarea
                      ref={(el) => {
                        boxes.current[t.id] = el;
                      }}
                      value={t.body}
                      onChange={(e) => patch(t.id, { body: e.target.value })}
                      rows={2}
                      maxLength={1000}
                      className="w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-2 py-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]"
                    />

                    {/* Clicked, never typed: a hand-written placeholder with a
                        space in it reaches the customer as a brace. */}
                    <div className="flex flex-wrap gap-1">
                      {data.vars.map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          title={v.label}
                          onClick={() => insertVar(t.id, v.key)}
                          className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-1.5 py-0.5 text-xs text-[var(--sys-primary)] hover:border-[var(--sys-primary)]"
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>

                    <p className="rounded-lg bg-[var(--sys-surface)] px-2 py-1.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                      {data.sample ? fillTemplate(t.body, data.sample) || '—' : NO_SAMPLE}
                    </p>
                  </div>
                ))}

                <Button variant="outline" size="sm" onClick={() => add(s.key)}>
                  <RiAddCircleLine className="h-4 w-4" />
                  قالب في «{s.ar}»
                </Button>
              </div>
            )}
          </section>
        );
      })}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={busy}>
          {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiMessage3Line className="h-4 w-4" />}
          احفظ القوالب
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-success)]">
            <RiCheckLine className="h-4 w-4" /> تم الحفظ
          </span>
        )}
        {data.sample && (
          <span className="text-xs text-[var(--sys-muted)]">
            المعاينة بالطلب{' '}
            <span dir="ltr" className="tabular-nums">{data.sample.orderNumber}</span>
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">{error}</p>
      )}
    </div>
  );
}
