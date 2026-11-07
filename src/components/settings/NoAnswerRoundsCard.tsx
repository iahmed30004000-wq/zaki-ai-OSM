'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «نظام الجولات (تجريبي)» — THE OWNER'S SWITCH (`no-answer-rounds.ts`).
 *
 * Off, the desk works exactly as it always has. On, presses of «لا يرد» within three working hours are one round, an order
 * nobody answered for six working hours goes back to the queue (so does a dated one nobody opened three working hours after
 * its date), and the third round closes the order only on a second day. Seen by whoever opens the settings; turned by
 * whoever holds `settings.manage` — the server asks it again.
 */
interface RoundsView {
  enabled: boolean;
  enabledAt: string | null;
}

export function NoAnswerRoundsCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [rounds, setRounds] = useState<RoundsView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ rounds: RoundsView }>('/api/settings/no-answer-rounds');
      setRounds(d.rounds);
    } catch {
      setRounds(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!rounds) return null;

  const flip = async (enabled: boolean) => {
    setBusy(true);
    try {
      const d = await apiJson<{ rounds: RoundsView }>('/api/settings/no-answer-rounds', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setRounds(d.rounds);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="نظام الجولات (تجريبي)"
        subtitle="«لا يرد» خلال 3 ساعات عمل = جولة وحدة، الطلب اللي ما حدا ردّ عليه 6 ساعات عمل بيرجع للطابور، والمؤجّل اللي ما حدا فتحه بعد موعده بـ3 ساعات عمل بيرجع كمان، وما بينلغى إلا بعد 3 جولات بيومين مختلفين. مطفي = القواعد الحالية تماماً."
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={rounds.enabled}
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
