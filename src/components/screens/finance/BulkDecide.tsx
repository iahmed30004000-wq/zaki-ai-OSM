'use client';

import React, { useMemo, useState } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { PARKED, PARKED_AR, RESOLUTION_AR, RESOLUTIONS } from '@/lib/settlement-difference';
import { EXPLANATION_SENTENCE, explanationOf } from '@/lib/decision-words';

/**
 * بتّ جماعي — ONE ANSWER FOR THE LINES THAT CARRY THE SAME WORD OF THE COMPANY.
 *
 * «بتّ جماعي لمجموعة أسطر بنفس كلمة الشركة.» A statement can carry thirty lines the company marks with the same
 * word and a zero beside them; answering each with the same sentence is how an explanation becomes a habit. Here
 * the person writes it once, for the group. Only lines nobody has answered are offered, and only groups of two or
 * more — one line is answered on its own row. The server holds the rule: every row is allowed the answer for its
 * own order or nothing is saved (see the decisions door).
 */

export interface BulkRow {
  id: string;
  /** The key the server groups by: the same courier word, or the same meaning of it. */
  wordGroup: string | null;
  /** The word as the company wrote it, for the label. */
  word: string | null;
  answered: boolean;
}

export function BulkDecide({
  statementId,
  rows,
  onDone,
}: {
  statementId: string;
  rows: BulkRow[];
  onDone: () => void;
}) {
  const toast = useToast();
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; word: string; ids: string[] }>();
    for (const r of rows) {
      if (r.answered || !r.wordGroup) continue;
      const g = byKey.get(r.wordGroup) ?? { key: r.wordGroup, word: r.word ?? 'بلا كلمة', ids: [] };
      g.ids.push(r.id);
      byKey.set(r.wordGroup, g);
    }
    return [...byKey.values()].filter((g) => g.ids.length >= 2);
  }, [rows]);

  const [key, setKey] = useState('');
  const [choice, setChoice] = useState<string>(PARKED);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (groups.length === 0) return null;
  const group = groups.find((g) => g.key === key) ?? groups[0];

  const submit = async () => {
    const explanation = explanationOf(note);
    if (!explanation) {
      setError(EXPLANATION_SENTENCE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiJson<{ message: string }>(`/api/finance/statements/${statementId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchIds: group.ids, resolution: choice, note: explanation }),
      });
      toast.done(res.message);
      setNote('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4 flex flex-wrap gap-3 items-end">
      <label className="flex-1 min-w-[220px]">
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">بتّ جماعي — أسطر بكلمة واحدة للشركة</span>
        <select
          value={group.key}
          onChange={(e) => setKey(e.target.value)}
          className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
        >
          {groups.map((g) => (
            <option key={g.key} value={g.key}>
              «{g.word}» — {g.ids.length} أسطر
            </option>
          ))}
        </select>
      </label>
      <label className="flex-1 min-w-[220px]">
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البتّ</span>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
        >
          {RESOLUTIONS.map((r) => (
            <option key={r} value={r}>
              {RESOLUTION_AR[r]}
            </option>
          ))}
          <option value={PARKED}>{PARKED_AR}</option>
        </select>
      </label>
      <label className="flex-1 min-w-[220px]">
        <span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">التفسير</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={EXPLANATION_SENTENCE}
          className="w-full h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border-input)] text-sm bg-[var(--sys-card)]"
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
      >
        {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : null}
        بتّ الأسطر
      </button>
      {error && <p className="w-full text-xs text-[var(--sys-destructive)]">{error}</p>}
    </div>
  );
}
