'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PerformanceSettingsCard } from '@/components/settings/PerformanceSettingsCard';
import { PostOrderOfferCard } from '@/components/settings/PostOrderOfferCard';
import { PenaltyRulesCard } from '@/components/settings/PenaltyRulesCard';
import { NoAnswerRoundsCard } from '@/components/settings/NoAnswerRoundsCard';
import { RiBuildingLine, RiCheckLine, RiLoader4Line } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * SYSTEM SETTINGS — what belongs to the company as a whole, and only that.
 *
 * This screen used to carry an org currency and a country of operation
 * (the Country model owns both), a default fee and a default commission
 * nothing read, an AI model nothing used, a second copy of the AI settings
 * and a card advertising "webhooks" that needed a logged-in session. Its
 * Save button replaced the whole settings document with three of those
 * fields, wiping the AI key and the message templates as it went.
 *
 * What is left is the company's name — its only editor — and the message
 * templates, which are written for every store the company runs.
 */
export function SystemSettingsScreen() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          setName(data.company?.name ?? '');
          setSaved(data.company?.name ?? '');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحفظ');
      setSaved(json.company?.name ?? name.trim());
      setMsg({ ok: true, text: 'حُفظ اسم الشركة.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  const dirty = name.trim() !== saved.trim();

  return (
    <div className="max-w-3xl space-y-4" dir="rtl">
      <PageHeader title="إعدادات النظام"
          description="ما يخصّ الشركة كلها. العملة والبلد في «البلدان والمتاجر والمحافظ»، والذكاء الاصطناعي في شاشته."
        />

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <RiBuildingLine className="h-4 w-4 text-[var(--sys-primary)]" /> بيانات الشركة
            </span>
          }
        />
        <CardContent>
          {loading ? (
            <div className="flex h-16 items-center justify-center text-[var(--sys-muted-foreground)]">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <form onSubmit={save} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px] flex-1">
                <Input label="اسم الشركة" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
                {/*
                  THE SENTENCE USED TO PROMISE MORE THAN IS TRUE.
                  It read «لا يظهر هذا الاسم لزبائنك» flatly. The shop and
                  the landing pages do indeed carry the STORE's name and
                  logo — but /api/public/landing-pages/[slug]/meta is a
                  public, CORS-open endpoint that answers with
                  `company.name` to anybody holding a published page's
                  slug. It exists so a seller can embed a page on their own
                  site, and the key is kept for embeds already pasted out
                  there. So the promise is narrowed to what is actually
                  kept: a reassurance that is not true is worse than none.
                */}
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  هذا اسمُ حسابك في المنصّة، لا اسمُ متجرك — شركتُك قد تملك عدّة متاجر، وكلُّ متجرٍ
                  يحمل اسمَه وشعارَه على صفحاته. وبه تُعرَف شركتك في سجلّ التدقيق.
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  ويظهر في موضعٍ واحدٍ للعلن: بياناتُ التضمين التي يقرؤها من يلصق إحدى صفحات هبوطك
                  على موقعه. فاجعله اسماً لا يضيرك أن يُقرأ.
                </p>
              </div>
              <Button type="submit" disabled={busy || !dirty || name.trim().length < 2}>
                {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiCheckLine className="h-4 w-4" />}
                احفظ
              </Button>
              {msg && (
                <p className={`w-full text-xs font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>

      {/* How people are measured belongs with what the company is, not on a
          reports screen: these are the bars the business judges by, and
          they are a decision rather than a reading. */}
      <PerformanceSettingsCard />

      {/* Beside the score on purpose. One measures and the other charges,
          and an owner setting a deduction should be looking at the bars
          they judge by on the same screen. */}
      <PenaltyRulesCard />

      {/* «زيد علبة كمان؟» — the window the customer may still add inside.
          It is here rather than on the product because it is a judgement
          about this company, not about one bundle: the OFFER itself is set
          among the product's own offers, where every price in this system
          lives. */}
      <PostOrderOfferCard />

      {/* «نظام الجولات (تجريبي)» — how «لا يرد» counts and when an unanswered order goes back to the queue. Off by default. */}
      <NoAnswerRoundsCard />

    </div>
  );
}
