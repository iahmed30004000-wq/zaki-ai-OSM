'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';
import type { AgentCommissionConfig } from '@/lib/agent-commission-settings';

/**
 * «حاسبة عمولة الموظفات (تقدير)» — THE OWNER'S TIERS, BONUS AND QUALITY GATE (step G2 of Confirmation Center v2, `agent-commission-settings.ts`).
 *
 * It edits an ESTIMATE only: the card says plainly that it changes nothing in the commission rules, the accrual or the payout (those are on the commission screen). The whole document is
 * saved at once and the server validates it whole — a refusal comes back as its Arabic sentence and the card keeps what the owner typed. Seen by whoever opens the settings;
 * edited by whoever holds `settings.manage` — the server asks it again.
 */
interface Answer {
  agentCommission: AgentCommissionConfig;
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

export function AgentCommissionCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [saved, setSaved] = useState<AgentCommissionConfig | null>(null);
  const [draft, setDraft] = useState<AgentCommissionConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await apiJson<Answer>('/api/settings/agent-commission');
      setSaved(a.agentCommission);
      setDraft(a.agentCommission);
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
      const a = await apiJson<Answer>('/api/settings/agent-commission', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      setSaved(a.agentCommission);
      setDraft(a.agentCommission);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-8 w-28 rounded-md border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs tabular-nums';
  const setTier = (i: number, key: 'from' | 'value', v: string) => setDraft({ ...draft, tiers: draft.tiers.map((t, j) => (j === i ? { ...t, [key]: num(v) } : t)) });

  return (
    <Card>
      <CardHeader
        title="حاسبة عمولة الموظفات (تقدير)"
        subtitle={
          <>
            الشرائح مبلغ ثابت للشهر حسب عدد الطلبات المؤكَّدة، وبونص لكل طلب لما يوصل العدد لحد معيّن (بدل مبلغ الشريحة)، وبوابة جودة اختيارية: لو نسبة التسليم أقل من الحد بتنزل الموظفة شريحة.
            <br />
            هاد تقدير بس بيطلع بتبويب سكور الأداء. ما بيغيّر قواعد العمولة ولا المحسوب ولا المصروف (هدول بشاشة العمولة).
          </>
        }
      />
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-bold text-[var(--sys-foreground)]">الشرائح</p>
          {draft.tiers.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
              <span>من</span>
              <input aria-label={`بداية الشريحة ${i + 1}`} type="number" min={1} className={field} value={Number.isNaN(t.from) ? '' : t.from} disabled={!canManage || busy} onChange={(e) => setTier(i, 'from', e.target.value)} />
              <span>طلب</span>
              <input aria-label={`مبلغ الشريحة ${i + 1}`} type="number" min={0} className={field} value={Number.isNaN(t.value) ? '' : t.value} disabled={!canManage || busy} onChange={(e) => setTier(i, 'value', e.target.value)} />
              {canManage && draft.tiers.length > 1 && (
                <button type="button" className="text-[var(--sys-destructive)]" disabled={busy} onClick={() => setDraft({ ...draft, tiers: draft.tiers.filter((_, j) => j !== i) })}>
                  حذف
                </button>
              )}
            </div>
          ))}
          {canManage && (
            <button
              type="button"
              className="text-xs text-[var(--sys-primary)]"
              disabled={busy || draft.tiers.length >= 12}
              onClick={() => setDraft({ ...draft, tiers: [...draft.tiers, { from: (draft.tiers.at(-1)?.from ?? 0) + 20, value: draft.tiers.at(-1)?.value ?? 0 }] })}
            >
              إضافة شريحة
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
          <span className="font-bold text-[var(--sys-foreground)]">البونص:</span>
          <span>من</span>
          <input aria-label="حد البونص" type="number" min={1} className={field} value={Number.isNaN(draft.bonus.minOrders) ? '' : draft.bonus.minOrders} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, bonus: { ...draft.bonus, minOrders: num(e.target.value) } })} />
          <span>طلب بالشهر، لكل طلب</span>
          <input aria-label="سعر طلب البونص" type="number" min={0} className={field} value={Number.isNaN(draft.bonus.perOrder) ? '' : draft.bonus.perOrder} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, bonus: { ...draft.bonus, perOrder: num(e.target.value) } })} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={draft.qualityGate.enabled} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, qualityGate: { ...draft.qualityGate, enabled: e.target.checked } })} className="h-5 w-5 accent-[var(--sys-primary)]" />
            بوابة الجودة
          </label>
          <span>نسبة التسليم المطلوبة</span>
          <input aria-label="نسبة التسليم المطلوبة" type="number" min={1} max={100} className={field} value={Number.isNaN(draft.qualityGate.minDeliveryRate) ? '' : draft.qualityGate.minDeliveryRate} disabled={!canManage || busy} onChange={(e) => setDraft({ ...draft, qualityGate: { ...draft.qualityGate, minDeliveryRate: num(e.target.value) } })} />
          <span>%</span>
        </div>

        {canManage ? (
          <button type="button" className="rounded-md bg-[var(--sys-primary)] px-3 py-1.5 text-xs font-bold text-[var(--sys-primary-foreground)] disabled:opacity-50" disabled={!dirty || busy} onClick={() => void save()}>
            حفظ
          </button>
        ) : (
          <p className="text-xs text-[var(--sys-muted)]">بيعدّلها بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>
        )}
      </CardContent>
    </Card>
  );
}
