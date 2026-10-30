'use client';

import React, { useState } from 'react';
import { RiCheckLine, RiLoader4Line } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import { readTypedFigure } from '@/lib/numeric-input';
import { MAX_CAP_TOKENS } from '@/lib/ai-spend-core';

/**
 * HOW MUCH THE ASSISTANTS MAY USE IN A DAY AND IN A MONTH.
 *
 * The per-minute limit stops a loop; it does not stop a company that uses
 * the assistant all day with a picture each time. This is the owner's own
 * line, in the unit the provider bills in.
 *
 * An empty box is «no ceiling» — which is what everybody has until they
 * write one. Saving goes through the same door as the rest of the
 * assistants' settings, with the same key (`settings.manage`).
 */

interface Props {
  cap: { dailyTokens: number | null; monthlyTokens: number | null };
  usage: { dayTokens: number; monthTokens: number } | null;
  canManage: boolean;
  onSaved: () => void | Promise<void>;
}

const show = (n: number) => n.toLocaleString('ar-u-nu-latn');

/** Empty → none; a whole number in range → itself; anything else → refused. */
function read(raw: string): { ok: true; value: number | null } | { ok: false } {
  if (raw.trim() === '') return { ok: true, value: null };
  const n = readTypedFigure(raw);
  if (n == null || !Number.isInteger(n) || n < 1 || n > MAX_CAP_TOKENS) return { ok: false };
  return { ok: true, value: n };
}

export function AiSpendCapCard({ cap, usage, canManage, onSaved }: Props) {
  const [daily, setDaily] = useState(cap.dailyTokens == null ? '' : String(cap.dailyTokens));
  const [monthly, setMonthly] = useState(cap.monthlyTokens == null ? '' : String(cap.monthlyTokens));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    const d = read(daily);
    const m = read(monthly);
    if (!d.ok || !m.ok) {
      setMsg({ ok: false, text: 'اكتب عدداً صحيحاً، أو اترك الخانة فارغة لتعني بلا سقف.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await apiJson('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spendCap: { dailyTokens: d.value, monthlyTokens: m.value } }),
      });
      await onSaved();
      setMsg({ ok: true, text: d.value == null && m.value == null ? 'حُفظ: بلا سقف.' : 'حُفظ السقف.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-4">
      <h2 className="mb-3 text-sm font-bold text-[var(--sys-heading)]">سقف الاستعمال</h2>
      <p className="mb-3 text-xs leading-relaxed text-[var(--sys-muted)]">
        أعلى ما يستعمله المساعد في اليوم وفي الشهر، ويُحسب بالرموز (الرمز الواحد نحو ثلاثة أحرف). الخانة الفارغة تعني بلا
        سقف. إذا بلغ المساعد السقف توقّف وقال السبب. نموذج جهازك الخاص لا يُحسب. اليوم والشهر بتوقيت غرينتش.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Input
          label="السقف اليومي (رمز)"
          inputMode="numeric"
          dir="ltr"
          disabled={!canManage}
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          helperText={usage ? `استُعمل اليوم: ${show(usage.dayTokens)}` : undefined}
        />
        <Input
          label="السقف الشهري (رمز)"
          inputMode="numeric"
          dir="ltr"
          disabled={!canManage}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
          helperText={usage ? `استُعمل هذا الشهر: ${show(usage.monthTokens)}` : undefined}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canManage ? (
          <Button onClick={save} disabled={busy}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
            احفظ السقف
          </Button>
        ) : (
          <span className="text-xs text-[var(--sys-muted)]">قراءة فقط — التعديل لمن عنده «الإعدادات الحسّاسة».</span>
        )}
        {msg && (
          <span className={`text-xs font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>
        )}
      </div>
    </section>
  );
}
