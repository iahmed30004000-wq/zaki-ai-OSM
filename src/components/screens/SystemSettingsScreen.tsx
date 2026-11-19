'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PostOrderOfferCard } from '@/components/settings/PostOrderOfferCard';
import { AuthenticityCodesCard } from '@/components/settings/AuthenticityCodesCard';
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
 * What is left is the company's name — its only editor — and «العرض بعد الطلب»,
 * the window a customer may still add inside, which is a judgement about this
 * company rather than about one product (19/11, R15a: the score and the
 * deductions moved to «قواعد الموظفين»; the message templates were never
 * drawn here — they live on «الذكاء الاصطناعي والنصوص»).
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
          description="اسم الشركة، ومهلة «العرض بعد الطلب». سكور الموظفين وقواعد الخصم صاروا بـ«قواعد الموظفين»."
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

      {/* «زيد علبة كمان؟» — the window the customer may still add inside.
          It is here rather than on the product because it is a judgement
          about this company, not about one bundle: the OFFER itself is set
          among the product's own offers, where every price in this system
          lives. */}
      <PostOrderOfferCard />

      {/* «رموز الأصالة» (19/11): the codes the public `/verify/[storeId]` page reads «أصلي» for. A card here and not a page of
          its own, because a new page is a line of the registry every staff screen downloads, and those ceilings only hold or fall. */}
      <AuthenticityCodesCard />

      {/*
        THE EIGHT CONFIRMATION-RULE CARDS ARE NOT HERE ANY MORE (18/11, request C1): «نظام الجولات» · «الطلب يرجع للطابور فوراً» · «إثبات المكالمات وجدول المحاولات» ·
        «فلتر الاستقبال» · «أولوية الطابور» · «الاسترجاع اليومي» · «ليدز الصفحات» · «ساعات وضعَي الطابور» moved, unchanged, to «قواعد مركز التأكيد» (`/confirmation/rules`), inside the
        confirmation hub, under a box that says the rule in one reading. What stays on this screen is what belongs to the company as a whole.
      */}
      {/*
        THE TWO MONEY CARDS ARE NOT HERE ANY MORE (19/11, request R13i): «تسوية السطور النظيفة عند الاعتماد» and «الشركاء والنسب» moved, unchanged, to «قواعد المال»
        (`/finance/rules`), the last tab of «المال», on the same `settings.view`. What stays on this screen is the company's name, the score, the deductions and the offer after the order.
      */}
      {/*
        THE TWO STAFF CARDS ARE NOT HERE ANY MORE (19/11, request R15a): «سكور الموظفين» and «قواعد الخصم» moved, unchanged and side by side, to «قواعد الموظفين»
        (`/admin/staff-rules`), beside «الموظفين» in «الإدارة», on the same `settings.view`. What stays on this screen is the company's name and the offer after the order.
      */}
    </div>
  );
}
