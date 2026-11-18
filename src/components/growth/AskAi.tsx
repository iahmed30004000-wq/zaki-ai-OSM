'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiJson } from '@/lib/api-client';
import { RiBrainLine, RiCpuLine, RiEqualizer2Line, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/**
 * ASKING THE AI ABOUT THIS COMPANY.
 *
 * It sits under the rule-based findings rather than replacing them. Those
 * carry their evidence and can be checked; this reads across them and says
 * something a threshold cannot. Both are on one screen so nobody has to
 * decide which one to trust — the numbers are the same numbers.
 *
 * Three things are stated on the face of it, because an answer from an
 * unnamed model over unnamed data is a rumour:
 *
 *   WHICH MODEL is answering, and from which vendor.
 *   WHICH DATA it was given — and the boxes are switchable, so a question
 *   about products is not paid for with the whole team table.
 *   THE HOUSE PROMPT that was prepended, if the company set one.
 */

interface Source {
  id: string;
  label: string;
  detail: string;
}

interface Info {
  provider: string;
  model: string;
  ready: boolean;
  housePrompt: string;
  sources: Source[];
  /** What this person may not hand the model, and why — said beside the chips. */
  withheld?: { id: string; label: string; why: string }[];
}

export function AskAi({
  /**
   * Which boxes are ticked when the panel opens. The customers screen
   * points it at its own data; the intelligence screen leaves it as it
   * was. Every box stays switchable either way — a preselection is a
   * sensible start, not a restriction.
   */
  preselect,
}: {
  preselect?: string[];
} = {}) {
  const toast = useToast();
  const [info, setInfo] = useState<Info | null>(null);
  const [question, setQuestion] = useState('');
  const [picked, setPicked] = useState<string[]>(preselect ?? ['SALES', 'PRODUCTS', 'TEAM']);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await apiJson<Info>('/api/growth/intelligence/ask');
      setInfo(got);
      // The server lists only what this person may tick; a preselected
      // source it held back is not left ticked to fail on «حلّل».
      setPicked((p) => p.filter((id) => got.sources.some((s) => s.id === id)));
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!info) return null;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const ask = async () => {
    if (!question.trim() || picked.length === 0) return;
    setBusy(true);
    setAnswer(null);
    try {
      const d = await apiJson<{ answer: string; noteAr?: string }>('/api/growth/intelligence/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), sources: picked }),
      });
      setAnswer(d.answer || 'لم يرجع المزوّد إجابة.');
      setNote(d.noteAr ?? null);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التحليل');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <header className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--sys-border)]">
        <RiBrainLine className="w-4 h-4 text-[var(--sys-primary)]" />
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">اسأل الذكاء عن أرقامك</h2>
        <span
          className="inline-flex items-center gap-1.5 text-note text-[var(--sys-muted-foreground)] bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg px-2 py-0.5"
          title={info.housePrompt ? `برومبت ثابت: ${info.housePrompt}` : 'لا برومبت ثابت'}
        >
          <RiCpuLine className="w-4 h-4 text-[var(--sys-muted)]" />
          {info.provider} · <span dir="ltr">{info.model}</span>
        </span>
        <Link
          href="/settings/ai"
          className="ms-auto inline-flex items-center gap-1 text-note text-[var(--sys-muted-foreground)] hover:text-[var(--sys-primary)]"
        >
          <RiEqualizer2Line className="w-4 h-4" />
          غيّر النموذج
        </Link>
      </header>

      <div className="p-4 space-y-3">
        {!info.ready && (
          <p className="text-note text-[var(--sys-warning)] bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)]/40 rounded-lg p-2.5">
            لم يُضبط مفتاح الذكاء بعد. اختر المزوّد وأدخل المفتاح من{' '}
            <Link href="/settings/ai" className="underline font-semibold">
              إعدادات الذكاء الاصطناعي
            </Link>{' '}
            — هذه الشاشة جاهزة وتعمل فور إدخاله.
          </p>
        )}

        <div>
          <p className="text-note text-[var(--sys-muted-foreground)] mb-1.5">ما الذي يُسمح له بقراءته:</p>
          {info.sources.length === 0 && (
            <p className="text-note text-[var(--sys-muted-foreground)] mb-1.5">ما في مصدر متاح لصلاحيتك هون.</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {info.sources.map((s) => {
              const on = picked.includes(s.id);
              return (
                <Button
                  key={s.id}
                  type="button"
                  size="sm"
                  variant={on ? 'primary' : 'secondary'}
                  aria-pressed={on}
                  onClick={() => toggle(s.id)}
                  title={s.detail}
                >
                  {s.label}
                </Button>
              );
            })}
          </div>
          {/* What is held back is named, with the reason — a chip that silently
              is not there reads as a feature the system never had. */}
          {(info.withheld ?? []).length > 0 && (
            <p className="text-note text-[var(--sys-muted)] mt-1.5">
              مش متاح هون:{' '}
              {(info.withheld ?? []).map((w) => `${w.label} (${w.why})`).join('، ')}
            </p>
          )}
        </div>

        <textarea
          ref={box}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl/⌘+Enter sends, so a long prompt can still use Enter.
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void ask();
          }}
          rows={3}
          maxLength={2000}
          placeholder="الصق برومبتك هنا، أو اسأل مباشرة — مثلاً: أي منتج أخسره من كثرة الرفض ولماذا؟"
          className="w-full px-2.5 py-2 rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] text-sm text-[var(--sys-foreground)] focus:outline-none focus:border-[var(--sys-primary)]"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => { void ask(); }}
            disabled={busy || !question.trim() || picked.length === 0}
          >
            {busy ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiSendPlaneLine className="icon-mirror w-4 h-4" />}
            حلّل
          </Button>
          <span className="text-note text-[var(--sys-muted)]">Ctrl + Enter</span>
          {picked.length === 0 && (
            <span className="text-note text-[var(--sys-warning)]">اختر مصدر بيانات واحداً على الأقل.</span>
          )}
        </div>


        {answer && (
          <Card plain padding="sm">
            <p className="text-sm text-[var(--sys-foreground)] whitespace-pre-wrap leading-relaxed">{answer}</p>
            <p className="text-note text-[var(--sys-muted)] mt-2">
              مبني على أرقام الثلاثين يوماً الماضية المعروضة أعلاه — راجِعه قبل التنفيذ.
            </p>
            {note && <p className="text-note text-[var(--sys-muted)] mt-1">{note}</p>}
          </Card>
        )}
      </div>
    </Card>
  );
}
