// @vitest-environment jsdom
'use client';
/* eslint-disable */
// ═══════════════════════════════════════════════════════════════════════
// A FROZEN COPY — NOT A SCREEN. src/components/screens/users/UserShift.tsx exactly as it stood on main at 7638cf10 (R16b2, 19/11), before it moved
// onto the kit. The differential test beside it (the-employee-money-sends-what-it-sent.test.tsx) draws THIS and the live
// file through the same presses and asks for byte-identical figures and request bodies. Its name ends in «.test.tsx» so no
// census, ratchet or menu ever counts it as a screen. Do not edit it: a copy that drifts proves nothing. When the
// differential has served its purpose it is deleted whole.
// ═══════════════════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest';

import React, { useState } from 'react';
import { RiTimerLine } from '@remixicon/react';

/**
 * WHEN THIS PERSON STARTS, AND WHEN THEY HAND OVER.
 *
 * Lateness was measured against the COUNTRY's work hours — right for a shop
 * where everybody comes at nine, and wrong for every shop that has ever run
 * two shifts. Somebody whose day genuinely begins at noon read as three
 * hours late every day of their life, and once a deduction is built on that
 * figure the mistake stops being cosmetic.
 *
 * Both boxes empty means the country's hours, which is what everybody has
 * today: setting a shift is a deliberate act, and until somebody performs
 * it nothing about their record moves.
 *
 * Rest days are here for the same reason. A night shift does not rest on
 * the country's weekend, and a day somebody is not expected in must never
 * be counted as a day they were late.
 */

const DAYS = [
  { n: 0, ar: 'الأحد' },
  { n: 1, ar: 'الاثنين' },
  { n: 2, ar: 'الثلاثاء' },
  { n: 3, ar: 'الأربعاء' },
  { n: 4, ar: 'الخميس' },
  { n: 5, ar: 'الجمعة' },
  { n: 6, ar: 'السبت' },
];

const FIELD =
  'h-10 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)] disabled:bg-[var(--sys-surface)]';

export function UserShift({
  userId,
  initial,
  canEdit,
}: {
  userId: string;
  initial: { shiftStart: string | null; shiftEnd: string | null; restDays: string | null };
  canEdit: boolean;
}) {
  const [start, setStart] = useState(initial.shiftStart ?? '');
  const [end, setEnd] = useState(initial.shiftEnd ?? '');
  const [rest, setRest] = useState<number[] | null>(
    initial.restDays === null ? null : initial.restDays.split(',').filter(Boolean).map(Number)
  );
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const current = JSON.stringify({
    shiftStart: start || null,
    shiftEnd: end || null,
    restDays: rest === null ? null : rest.slice().sort((a, b) => a - b).join(','),
  });
  const changed = current !== saved;
  // Refused here as well as on the server, so the person is told before
  // they press rather than after.
  const inverted = !!start && !!end && end <= start;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updateContact',
          shiftStart: start || null,
          shiftEnd: end || null,
          restDays: rest === null ? null : rest.join(','),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذّر الحفظ');
      setSaved(current);
      setMsg({ ok: true, text: 'حُفظ.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  const toggleDay = (n: number) => {
    const now = rest ?? [];
    setRest(now.includes(n) ? now.filter((d) => d !== n) : [...now, n]);
  };

  return (
    <div className="col-span-full rounded-lg bg-[var(--sys-surface)] px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1 text-xs text-[var(--sys-muted)]">
        <RiTimerLine className="h-4 w-4" /> الدوام
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">يبدأ</span>
          <input
            type="time"
            value={start}
            disabled={!canEdit}
            onChange={(e) => setStart(e.target.value)}
            className={FIELD}
            dir="ltr"
          />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-xs text-[var(--sys-muted-foreground)]">يسلّم</span>
          <input
            type="time"
            value={end}
            disabled={!canEdit}
            onChange={(e) => setEnd(e.target.value)}
            className={FIELD}
            dir="ltr"
          />
        </label>

        {canEdit && (
          <button
            type="button"
            onClick={save}
            disabled={busy || !changed || inverted}
            className="h-11 md:h-10 rounded-lg bg-[var(--sys-primary)] px-3 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            {busy ? 'جارٍ…' : 'احفظ'}
          </button>
        )}
      </div>

      <div className="mt-2">
        <span className="mb-1 block text-xs text-[var(--sys-muted-foreground)]">
          أيام الراحة{' '}
          {rest === null && <span className="text-[var(--sys-muted)]">— عطلة البلد</span>}
        </span>
        <div className="flex flex-wrap gap-1">
          {DAYS.map((d) => (
            <button
              key={d.n}
              type="button"
              disabled={!canEdit}
              onClick={() => toggleDay(d.n)}
              className={`min-h-11 md:min-h-0 inline-flex items-center rounded-lg border px-1.5 py-0.5 text-xs ${
                rest?.includes(d.n)
                  ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'
                  : 'border-[var(--sys-border)] bg-[var(--sys-card)] text-[var(--sys-muted-foreground)]'
              } disabled:opacity-60`}
            >
              {d.ar}
            </button>
          ))}
          {canEdit && rest !== null && (
            <button
              type="button"
              onClick={() => setRest(null)}
              className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg px-1.5 py-0.5 text-xs text-[var(--sys-muted)] hover:text-[var(--sys-primary)]"
            >
              أعد عطلة البلد
            </button>
          )}
        </div>
      </div>

      {inverted && <p className="mt-1 text-xs text-[var(--sys-destructive)]">وقت التسليم يجب أن يكون بعد وقت البدء.</p>}
      {!inverted && !start && !end && rest === null && (
        <p className="mt-1 text-xs text-[var(--sys-muted)]">فارغ = ساعات البلد وعطلته. التأخير يُقاس بما هنا.</p>
      )}
      {msg && <p className={`mt-1 text-xs ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>}
    </div>
  );
}

describe('the copy of UserShift as it stood on main', () => {
  it('is a component the differential can draw', () => {
    expect(typeof UserShift).toBe('function');
  });
});
