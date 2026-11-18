'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { POSTPONE_MAX_TIMES, QUEUE_PRIORITY, QUEUE_PRIORITY_LIMITS } from '@/lib/queue-priority';

/**
 * «أولوية الطابور (تجريبي)» — THE OWNER'S SWITCH FOR THE PULL ORDER (`queue-priority-switch.ts`, step D of Confirmation Center v2).
 *
 * Off, the pull is today's. On, it changes WHICH order the next «اسحب» gives: a fresh one first, a retry that waited past two hours before the others, and a share of every
 * agent's pulls for the backlog. The card says so, says what it does NOT change (the hand limit, the untouched-order return), shows the share the system would use now and
 * the rule it came from, and says that it is not the call-proof switch. The two figures in the sentence are read from the rule's constants, never typed twice.
 * Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 */
interface QueuePriorityView {
  enabled: boolean;
  enabledAt: string | null;
}
interface QueuePriorityAnswer {
  queuePriority: QueuePriorityView;
  share?: { percent: number; note: string };
}

export function QueuePriorityCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<QueuePriorityAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<QueuePriorityAnswer>('/api/settings/queue-priority'));
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
      // The answer of a PUT has no share: keep the one on the screen.
      const saved = await apiJson<QueuePriorityAnswer>('/api/settings/queue-priority', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setState((was) => ({ ...saved, share: was?.share }));
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="أولوية الطابور (تجريبي)"
        subtitle={
          <>
            بيغيّر أي طلب بيطلع للموظفة بالسحب الجاي: الطلب الجديد (أقل من {QUEUE_PRIORITY.freshMinutes} دقيقة) أول، والطلب اللي ما ردّ وتأخر أكتر من {QUEUE_PRIORITY.agingHours} ساعة عن موعدو بيتقدّم على الجدد الأقدم،
            وحصة من سحبات كل موظفة بتروح للمتأخر (بتنحسب من آخر {QUEUE_PRIORITY.windowDays} أيام).
            <br />
            من 9 الصبح للـ11 ومن 9 بالليل للـ12: الجديد أول والأقدم أول، بلا حصة. حد اليد ({QUEUE_PRIORITY_LIMITS.handLimit} طلبات) ورجوع الطلب اللي ما انلمس ({QUEUE_PRIORITY_LIMITS.idleBusinessMinutes} دقيقة دوام) وحد تأجيل الموعد ({POSTPONE_MAX_TIMES} مرات) صاروا من قاعدة «إثبات المكالمات وجدول المحاولات» نفسها، شغّالين معها مهما كان هالمفتاح؛ ولما هي مطفية، هالمفتاح لحالو بيرفض التأجيل التالت. ما في إغلاق ولا رسالة للزبون.
            <br />
            مفتاح لحالو، مش مفتاح «إثبات المكالمات وجدول المحاولات». مطفي = السحب زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.queuePriority.enabled}
            disabled={!canManage || busy}
            onChange={(e) => void flip(e.target.checked)}
            className="h-5 w-5 accent-[var(--sys-primary)]"
          />
          مفعّل
        </label>
        {state.share && <p className="text-xs text-[var(--sys-muted)]">{state.share.note}</p>}
        {!canManage && <p className="text-xs text-[var(--sys-muted)]">بيشغّله بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>}
      </CardContent>
    </Card>
  );
}
