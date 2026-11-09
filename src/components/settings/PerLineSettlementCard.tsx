'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «تسوية السطور النظيفة عند الاعتماد (تجريبي)» — THE OWNER'S SWITCH FOR WHEN A STATEMENT'S CLEAN ORDERS ARE SETTLED
 * (`per-line-settlement-switch.ts`).
 *
 * Off, nothing changes: the orders of a statement are settled when its matching closes, and the matching closes only when every line is
 * answered. On, the approval also settles every clean line at once and a line still a question holds only its own order. The money is
 * the receipts and is posted at the approval either way; the switch moves only the time at which the matching orders are settled.
 * Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 *
 * Plain Arabic, three short lines. Nothing else is needed for it to work: no other switch, no setup.
 */
interface PerLineView {
  enabled: boolean;
  enabledAt: string | null;
}
interface PerLineAnswer {
  perLine: PerLineView;
}

export function PerLineSettlementCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<PerLineAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<PerLineAnswer>('/api/settings/per-line-settlement'));
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
        await apiJson<PerLineAnswer>('/api/settings/per-line-settlement', {
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
        title="تسوية السطور النظيفة عند الاعتماد (تجريبي)"
        subtitle={
          <>
            لما تعتمد الكشف، الطلبات اللي سطرها مطابق بتتسوّى فوراً (بتصير عمولتها مستحقة وبينسحب مخزونها)، والسطر اللي لسا ما انبتّ فيه بيعلّق طلبه هو بس.
            <br />
            المصاري ما بتتغيّر ولا بقرش: بتدخل المحفظة باعتماد الكشف زي ما هي. اللي بيتغيّر هو وقت تسوية الطلبات المطابقة بس.
            <br />
            الكشف اللي انعتمد قبل ما تشغّليه ما بيتغيّر لحاله: بتسوّي طلباته المطابقة بزر «سوّي الطلبات النظيفة» اللي بيظهر عليه. مطفي = الشغل زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.perLine.enabled}
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
