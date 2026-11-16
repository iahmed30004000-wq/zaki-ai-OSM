'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import { DAILY_FROM_HOURS, DAILY_TO_HOURS } from '@/lib/winback-daily-words';

/**
 * «الاسترجاع اليومي (تجريبي)» — THE OWNER'S SWITCH FOR THE DAILY WINBACK LIST (`winback-v2-switch.ts`, step F of Confirmation Center v2).
 *
 * Off, nothing changes. On, the «ملغاة سابقاً» tab opens with a daily list: orders lost for a changed mind, a price, or five unanswered calls, and postponed orders whose date passed — each 24 to
 * 72 hours after it happened — with whoever should call and what the call came to. Nothing is offered, discounted or closed by the list; the existing offer is unchanged. The card says so,
 * because the owner cannot see that from the switch's name. Its own key. Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 */
interface WinbackV2View {
  enabled: boolean;
  enabledAt: string | null;
}
interface WinbackV2Answer {
  winbackV2: WinbackV2View;
}

export function WinbackV2Card() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<WinbackV2Answer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<WinbackV2Answer>('/api/settings/winback-v2'));
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
        await apiJson<WinbackV2Answer>('/api/settings/winback-v2', {
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
        title="الاسترجاع اليومي (تجريبي)"
        subtitle={
          <>
            بتبيّن بتبويب «ملغاة سابقاً» قائمة يومية: الطلبات اللي انرفضت لأنو الزبون غيّر رأيو أو السعر مرتفع أو ما ردّ بعد خمس محاولات، والطلبات المؤجّلة اللي فاتها موعدها. كل طلب بيظهر من {DAILY_FROM_HOURS} لحد {DAILY_TO_HOURS} ساعة بعد ما صار.
            <br />
            بتحدّد مين بيتصل وبتسجّل نتيجة الاتصال. القايمة ما بتعرض خصم ولا بتسكّر ولا بتبعت شي للزبون، والعرض الموجود بالتبويب ما تغيّر. الطلبات المؤجّلة للاتصال بس، ما بينعمل لها عرض.
            <br />
            مفتاح لحالو، مش مفتاح «إثبات المكالمات وجدول المحاولات». مطفي = الشاشة زي ما هي.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.winbackV2.enabled}
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
