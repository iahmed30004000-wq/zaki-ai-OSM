'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «فلتر الاستقبال (تجريبي)» — THE OWNER'S SWITCH FOR THE INTAKE FLAGS (`intake-filter-switch.ts`, step C of Confirmation Center v2).
 *
 * Off, nothing changes. On, a NEW order that repeats the same customer's order for the same product within a day, or whose number does not have the shape of a
 * number of the store's country, carries a note the agent reads above the buttons. Nothing is refused, closed, held or messaged — the card says so, because the
 * owner cannot see that from the switch's name. Its own key: it is NOT the «إثبات المكالمات وجدول المحاولات» switch.
 * Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 */
interface IntakeFilterView {
  enabled: boolean;
  enabledAt: string | null;
}
interface IntakeFilterAnswer {
  intakeFilter: IntakeFilterView;
}

export function IntakeFilterCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<IntakeFilterAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<IntakeFilterAnswer>('/api/settings/intake-filter'));
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
        await apiJson<IntakeFilterAnswer>('/api/settings/intake-filter', {
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
        title="فلتر الاستقبال (تجريبي)"
        subtitle={
          <>
            بعد ما يوصل طلب جديد، النظام بيفحصو كل دقيقتين وقبل كل سحب، وبيكتب تنبيه على الطلب بحالتين: الزبون (بأي صيغة للرقم) طلب نفس المنتج خلال 24 ساعة قبل، أو رقمو ما بيطابق شكل أرقام بلد المتجر.
            <br />
            التنبيه بيظهر للموظفة فوق الأزرار وبخط التاريخ. ما في رفض ولا إغلاق ولا حجز ولا رسالة للزبون، والطلب بيضل بالطابور متل ما هو. الطلبات اللي وصلت قبل التشغيل ما بتتوسم.
            <br />
            مفتاح لحالو، مش مفتاح «إثبات المكالمات وجدول المحاولات». مطفي = الشغل زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.intakeFilter.enabled}
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
