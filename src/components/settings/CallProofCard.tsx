'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «إثبات المكالمات وجدول المحاولات (تجريبي)» — THE OWNER'S SWITCH FOR PROVABLE CALL ATTEMPTS (`call-proof-switch.ts`, step A of Confirmation Center v2).
 *
 * Off, nothing changes: «لا يرد» can be pressed at any time. On, «لا يرد» (and «مشغول» and «مسكّر») opens only after the agent pressed «اتصال» on that order and
 * thirty seconds went by; the server refuses it otherwise and the button says why. Later (step B) the same switch brings the five-attempt close and the two-day schedule.
 * Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 *
 * Plain Arabic, three short lines.
 */
interface CallProofView {
  enabled: boolean;
  enabledAt: string | null;
}
interface CallProofAnswer {
  callProof: CallProofView;
}

export function CallProofCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<CallProofAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<CallProofAnswer>('/api/settings/call-proof'));
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
        await apiJson<CallProofAnswer>('/api/settings/call-proof', {
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

  return (
    <Card>
      <CardHeader
        title="إثبات المكالمات وجدول المحاولات (تجريبي)"
        subtitle={
          <>
            زر «لا يرد» (و«مشغول» و«مسكّر») ما بينفتح إلا بعد ما الموظفة تضغط «اتصال» على الطلب وتمرّ 30 ثانية. السيرفر بيرفض غير هيك، والزر بيشرح ليش.
            <br />
            كل مكالمة بتنسجّل بمدتها (من ضغطة «اتصال» لحد تسجيل النتيجة)، وكل رفض بينكتب بسجل المراجعة. هاد إثبات إنو في ضغطة ووقت مرّ، مش إثبات إنو صارت مكالمة.
            <br />
            الطلب اللي بإيد موظفة بدون ضغطة «اتصال» لحظة التشغيل بيقفل عندها «لا يرد» لحد ما تضغط «اتصال» — شغّله برّا الدوام. لاحقاً نفس المفتاح بيشغّل 5 محاولات على يومين. مطفي = الشغل زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.callProof.enabled}
            disabled={!canManage || busy}
            onChange={(e) => void flip(e.target.checked)}
            className="h-5 w-5 accent-[var(--sys-primary)]"
          />
          مفعّل
        </label>
        {!canManage && (
          <p className="text-xs text-[var(--sys-muted)]">بيشغّله بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>
        )}
      </CardContent>
    </Card>
  );
}
