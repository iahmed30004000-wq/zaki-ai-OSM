'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import type { PerformanceSettings } from '@/lib/performance-settings';
import { RiCheckLine, RiDashboard3Line, RiLoader4Line, RiLockLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * THE BARS — AND THE WEIGHTS, SHOWN AND LOCKED.
 *
 * The weights are printed here on purpose, with a padlock beside them. An
 * employee asked to raise a score is owed the arithmetic, and hiding it
 * would make the number feel arbitrary; showing it as an editable field
 * would make it worthless, because a score whose weights move cannot be
 * compared with last month's.
 *
 * What the owner sets is the BAR: what this shop calls an acceptable
 * delivery rate, how many entry problems it tolerates, how small a sample
 * it refuses to judge anybody on, and whether it looks at a week or a
 * month. A bar colours a line. It never moves a point.
 */

interface Weight {
  key: string;
  ar: string;
  weight: number;
  negative: boolean;
}

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]';

export function PerformanceSettingsCard() {
  const toast = useToast();
  // The thresholds are «تعديل عتبات أداء الفريق»: seen by whoever opens the page, changed by whoever holds that key.
  const canManage = useCan('team.settings');
  const [settings, setSettings] = useState<PerformanceSettings | null>(null);
  const [weights, setWeights] = useState<Weight[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ settings: PerformanceSettings; weights: Weight[] }>('/api/settings/performance');
      setSettings(d.settings);
      setWeights(d.weights ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) return null;

  const patch = (fields: Partial<PerformanceSettings>) => setSettings({ ...settings, ...fields });

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const d = await apiJson<{ settings: PerformanceSettings }>('/api/settings/performance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSettings(d.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="سكور الموظفين"
        subtitle="الأوزان ثابتة ليبقى الرقم قابلاً للمقارنة بين الشهور — والعتبات وحدها لك"
      />
      <CardContent className="space-y-4">
        {/* Shown, explained, and not a field. */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
          <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-[var(--sys-muted-foreground)]">
            <RiLockLine className="h-4 w-4" /> الأوزان — مثبّتة بالكود، لا تُعدَّل من هنا ولا من غيره
          </p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {weights.map((w) => (
              <li key={w.key} className="flex items-baseline justify-between text-xs">
                <span className="text-[var(--sys-muted-foreground)]">
                  {w.ar}
                  {w.negative && <span className="text-[var(--sys-muted)]"> (بالسالب)</span>}
                </span>
                <span className="font-semibold tabular-nums text-[var(--sys-foreground)]">{w.weight}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">عتبة نسبة التسليم المقبولة</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                disabled={!canManage}
                value={Math.round(settings.deliveryRateBar * 100)}
                onChange={(e) => patch({ deliveryRateBar: Number(e.target.value) / 100 })}
                className={FIELD}
              />
              <span className="text-xs text-[var(--sys-muted)]">٪</span>
            </div>
            <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">دونها يُعلَّم السطر بالأحمر — ولا تتغيّر النقاط.</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">عتبة نسبة الإشكالات</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                disabled={!canManage}
                value={Math.round(settings.issuesRateBar * 100)}
                onChange={(e) => patch({ issuesRateBar: Number(e.target.value) / 100 })}
                className={FIELD}
              />
              <span className="text-xs text-[var(--sys-muted)]">٪</span>
            </div>
            <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">فوقها يُعلَّم السطر — والإشكال المُلغى لا يُحتسب على أحد.</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">الحد الأدنى للعيّنة</span>
            <input
              type="number"
              min={1}
              max={1000}
              disabled={!canManage}
              value={settings.minSample}
              onChange={(e) => patch({ minSample: Number(e.target.value) })}
              className={FIELD}
            />
            <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">
              تحته لا يُحتسب سكور أصلاً. غير الحد الأدنى في قواعد العمولة: ذاك يحكم المال، وهذا يحكم القياس.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">فترة القياس</span>
            <select
              disabled={!canManage}
              value={settings.period}
              onChange={(e) => patch({ period: e.target.value as PerformanceSettings['period'] })}
              className={FIELD}
            >
              <option value="WEEKLY">أسبوع</option>
              <option value="MONTHLY">شهر</option>
            </select>
            <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">الأسبوع يبدأ السبت، كتقويم العمل.</span>
          </label>
        </div>

        {!canManage && <p className="text-xs text-[var(--sys-muted)]">قراءة فقط — التعديل لمن عنده «تعديل عتبات أداء الفريق».</p>}
        {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiDashboard3Line className="h-4 w-4" />}
            احفظ العتبات
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-success)]">
              <RiCheckLine className="h-4 w-4" /> تم الحفظ
            </span>
          )}
        </div>
        )}

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
