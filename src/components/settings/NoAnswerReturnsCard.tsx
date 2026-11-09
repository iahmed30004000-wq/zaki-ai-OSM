'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «الطلب يرجع للطابور فوراً (تجريبي)» — THE OWNER'S SECOND SWITCH (`no-answer-returns.ts`), beside «نظام الجولات».
 *
 * Off, nothing changes. On, an order leaves the agent's hand the moment she presses «لا يرد» or saves a date and goes back to the shared
 * queue with a ready-time (three working hours after a «لا يرد», the date itself otherwise), an order nobody touched for thirty working
 * minutes goes back by itself, and one agent holds at most five. It works only together with «نظام الجولات» (the close is the rounds'
 * counting), so the box is disabled — with the reason — while the rounds are off. Seen by whoever opens the settings; turned by whoever
 * holds `settings.manage` — the server asks it again, and refuses to turn it on while the rounds are off.
 *
 * Plain Arabic, three short lines; the numbers (3 hours, 30 minutes, 5 orders) are the constants' (`RETURNS_MODE`,
 * `ROUND_GAP_BUSINESS_MINUTES`) and a test holds the sentence to them.
 */
interface ReturnsView {
  enabled: boolean;
  enabledAt: string | null;
}
interface ReturnsAnswer {
  returns: ReturnsView;
  roundsOn: boolean;
}

export function NoAnswerReturnsCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<ReturnsAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<ReturnsAnswer>('/api/settings/no-answer-returns'));
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;

  const flip = async (enabled: boolean) => {
    setBusy(true);
    try {
      setState(
        await apiJson<ReturnsAnswer>('/api/settings/no-answer-returns', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
      );
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  // Without the rounds there is nothing to turn on — but a box that is already ticked can always be unticked.
  const locked = !state.roundsOn && !state.returns.enabled;

  return (
    <Card>
      <CardHeader
        title="الطلب يرجع للطابور فوراً (تجريبي)"
        subtitle={
          <>
            «لا يرد» أو تحديد موعد = الطلب بيطلع من إيد الموظفة فوراً وبيرجع للطابور: بعد «لا يرد» بيجهز بعد 3 ساعات دوام، ومع الموعد بيجهز بموعده.
            <br />
            الطلب اللي ما انسجّلت عليه محاولة 30 دقيقة دوام بيرجع للطابور لحاله، والموظفة ما بتمسك أكتر من 5 طلبات (مع المحجوز إلها).
            <br />
            بيشتغل بس مع «نظام الجولات». أول ما تشغّليه بيرجّع الطلبات المتروكة تدريجياً، شغّليه بعد الدوام. مطفي = الشغل زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.returns.enabled}
            disabled={!canManage || busy || locked}
            onChange={(e) => void flip(e.target.checked)}
            className="h-5 w-5 accent-[var(--sys-primary)]"
          />
          مفعّل
        </label>
        {!state.roundsOn && (
          <p className="text-xs text-[var(--sys-muted)]">
            {state.returns.enabled
              ? 'مش شغّال هلأ: «نظام الجولات» مطفي وهالمفتاح ما بيشتغل إلا معه.'
              : 'مقفول: لازم «نظام الجولات» يكون شغّال أول، وهالمفتاح ما بيشتغل إلا معه.'}
          </p>
        )}
        {!canManage && (
          <p className="text-xs text-[var(--sys-muted)]">بيشغّله بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>
        )}
      </CardContent>
    </Card>
  );
}
