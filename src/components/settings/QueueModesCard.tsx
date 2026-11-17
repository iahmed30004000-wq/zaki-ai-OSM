'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import type { QueueModesConfig } from '@/lib/queue-modes-settings';

/**
 * «ساعات وضعَي الطابور» — THE OWNER'S HOURS FOR THE MORNING MODE AND THE EVENING PEAK (step D2 of Confirmation Center v2, `queue-modes-settings.ts`).
 *
 * Whole hours of the store's day. They only matter while «أولوية الطابور» is on: in both modes the share and the aging are suspended and the pull is plainly «الجديد أول والأقدم أول».
 * The whole document is saved at once and the server validates it whole — a refusal comes back as its Arabic sentence and the card keeps what the owner typed. Seen by whoever opens the
 * settings; edited by whoever holds `settings.manage` — the server asks it again.
 */
interface Answer {
  queueModes: QueueModesConfig;
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

export function QueueModesCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [saved, setSaved] = useState<QueueModesConfig | null>(null);
  const [draft, setDraft] = useState<QueueModesConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await apiJson<Answer>('/api/settings/queue-modes');
      setSaved(a.queueModes);
      setDraft(a.queueModes);
    } catch {
      setSaved(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!saved || !draft) return null;
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  const save = async () => {
    setBusy(true);
    try {
      const a = await apiJson<Answer>('/api/settings/queue-modes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      setSaved(a.queueModes);
      setDraft(a.queueModes);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-11 md:h-8 w-20 rounded-md border border-[var(--sys-border-strong)] bg-[var(--sys-card)] px-2 text-xs tabular-nums';
  const row = (label: string, from: keyof QueueModesConfig, to: keyof QueueModesConfig) => (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
      <span className="font-bold text-[var(--sys-foreground)]">{label}:</span>
      <span>من الساعة</span>
      <input aria-label={`${label} — من`} type="number" min={0} max={24} className={field} value={Number.isNaN(draft[from]) ? '' : draft[from]} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, [from]: num(e.target.value) })} />
      <span>لحد</span>
      <input aria-label={`${label} — لحد`} type="number" min={0} max={24} className={field} value={Number.isNaN(draft[to]) ? '' : draft[to]} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, [to]: num(e.target.value) })} />
    </div>
  );

  return (
    <Card>
      <CardHeader
        title="ساعات وضعَي الطابور"
        subtitle="بالوضعين بيوقف نصيب المتأخر والتقادم والسحب بيصير «الجديد أول والأقدم أول». الساعات كاملة بتوقيت المتجر (24 = منتصف الليل). بتشتغل بس لما «أولوية الطابور» مفعّلة."
      />
      <CardContent className="space-y-3">
        {row('وضع الصبح (طلبات الليل أول)', 'nightFrom', 'nightTo')}
        {row('وضع الذروة (الجديد أول)', 'peakFrom', 'peakTo')}
        {canManage ? (
          <button type="button" className="h-11 md:h-8 rounded-md bg-[var(--sys-primary)] px-3 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-50" disabled={!dirty || busy} onClick={() => void save()}>
            حفظ
          </button>
        ) : (
          <p className="text-xs text-[var(--sys-muted-foreground)]">بيعدّلها بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>
        )}
      </CardContent>
    </Card>
  );
}
