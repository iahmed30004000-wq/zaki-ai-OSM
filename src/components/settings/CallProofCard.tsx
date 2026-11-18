'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { CONFIRMATION_RULE as RULE } from '@/lib/confirmation-rule';

/** «19:30» → «20:30»: the evening anchor plus the hour it keeps before the end of work (request C2's sentence). */
const hourAfter = (hhmm: string): string => `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}${hhmm.slice(2)}`;

/**
 * «إثبات المكالمات وجدول المحاولات (تجريبي)» — THE OWNER'S SWITCH FOR PROVABLE CALL ATTEMPTS (`call-proof-switch.ts`, step A of Confirmation Center v2).
 *
 * Off, nothing changes: «لا يرد» can be pressed at any time. On, «لا يرد» (and «مشغول» and «مسكّر») opens only after the agent pressed «اتصال» on that order and
 * thirty seconds went by; the server refuses it otherwise and the button says why. And (step B) the same switch brings the five-attempt plan over two days — and with it the returns mode
 * («الطلب يرجع للطابور فوراً»: the hand limit, the idle release), which the owner cannot see from the switch's name, so the sentence says it.
 * Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 *
 * Plain Arabic, five short lines. The numbers in it are held to the constants by `the-call-proof-card-says-what-the-switch-changes.test.tsx`. Since request C2 (18/11) every
 * number is READ from the one rule set (`confirmation-rule.ts`) — the hand and the idle release are its 3 and 20 whatever «أولوية الطابور» says, #4 is at 11:00, #5 at 19:30.
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
            زر «لا يرد» (و«مشغول» و«مسكّر») ما بينفتح إلا بعد ما الموظفة تضغط «اتصال» على الطلب وتمرّ {RULE.proofSeconds} ثانية. السيرفر بيرفض غير هيك، والزر بيشرح ليش.
            <br />
            كل مكالمة بتنسجّل بمدتها (من ضغطة «اتصال» لحد تسجيل النتيجة)، وكل رفض بينكتب بسجل المراجعة. هاد إثبات إنو في ضغطة ووقت مرّ، مش إثبات إنو صارت مكالمة.
            <br />
            الطلب اللي بإيد موظفة بدون ضغطة «اتصال» لحظة التشغيل بيقفل عندها «لا يرد» لحد ما تضغط «اتصال» — شغّله برّا الدوام.
            <br />
            ونفس المفتاح بيشغّل جدول المحاولات: «لا يرد» بتصير {RULE.attempts} محاولات على يومين — الأولى هلّق، التانية بعد نص ساعة، التالتة بعد ساعتين — بس التانية والتالتة لازم تقع ضمن ساعات دوام البلد وأيام عملو (إذا وقعت برّا الدوام أو بيوم عطلة بتصير أول بداية دوام جاية؛ وإذا ما في دوام مكتوب للبلد بيحسب من 10 الصبح لحد 10 بالليل). الرابعة الساعة {RULE.morning} الصبح (أو ببداية دوام البلد إذا بيبلّش بعدها) وبعد {RULE.floorsHours.beforeFourth} ساعات على الأقل من التالتة، والخامسة الساعة {RULE.evening} مسا (أو قبل نهاية دوام البلد بساعة إذا دوامو بيخلص قبل {hourAfter(RULE.evening)}) وبعد {RULE.floorsHours.beforeFifth} ساعات على الأقل من الرابعة، وبتضل ضمن ساعات الدوام (إذا وقعت برّا الدوام بتروح لموعد المسا بيوم العمل اللي بعدو). أيام العطلة المحددة بإعدادات البلد بتنتخطّى بكل المواعيد (وإذا ما في أيام محددة ما بتنتخطّى شي). بعد كل محاولة محسوبة بيرجع الطلب للطابور وبيجهز بموعدو، والضغطة قبل موعدها بتنسجّل بس ما بتنحسب. المحاولة الخامسة (على يومين) بتسكّر الطلب لحالو وبيروح لقائمة «ملغاة سابقاً». اللي انسجّل قبل التشغيل ما بينحسب.
            <br />
            وبيشغّل معو رجوع الطلب للطابور: الموظفة ما بتمسك أكتر من {RULE.hand} طلبات، والطلب اللي ما انسجّلت عليه حركة {RULE.idleMinutes} دقيقة دوام بيرجع للطابور لحاله، وأول ما تشغّلو بيرجّع الطلبات المتروكة تدريجياً. موعد الزبون {RULE.postponeMax} مرات بالأكثر، والتأجيل بسبب «لا يرد» ممنوع. ما في واتساب تلقائي. مطفي = الشغل زي ما هو.
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
