'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiCheckLine, RiLoader4Line, RiLockLine, RiTimerLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «العرض بعد الطلب» — THE WINDOW, AND THE WHOLE RULE BESIDE IT.
 *
 * The offer itself is set on the PRODUCT, among its bundles, because that is
 * where a price lives in this system and a second place for one is the
 * defect the offers screen exists to have fixed. What belongs to the company
 * rather than to any product is the window: how long after ordering a
 * customer may still add the box themselves, before the confirmation team
 * picks the order up.
 *
 * The three conditions nobody sets are printed with a padlock, exactly as
 * the performance card prints its weights. A seller reading «١٥ دقيقة» alone
 * would believe that is the whole rule and wonder why a fourteen-minute-old
 * order refused the offer — the answer is that somebody had already called,
 * and the screen should say so before it is asked.
 */

interface PostOrderOfferSettings {
  windowMinutes: number;
}

const FIELD =
  'h-10 w-full rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 text-xs text-[var(--sys-foreground)] outline-none focus:border-[var(--sys-primary)]';

export function PostOrderOfferCard() {
  const toast = useToast();
  // The window is «تعديل قواعد العروض»: seen by whoever opens the page, changed by whoever holds that key.
  const canManage = useCan('offers.rules');
  const [settings, setSettings] = useState<PostOrderOfferSettings | null>(null);
  const [defaults, setDefaults] = useState<PostOrderOfferSettings | null>(null);
  const [fixed, setFixed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{
        settings: PostOrderOfferSettings;
        defaults: PostOrderOfferSettings;
        fixed: string[];
      }>('/api/settings/post-order-offer');
      setSettings(d.settings);
      setDefaults(d.defaults ?? null);
      setFixed(d.fixed ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings) {
    return error ? (
      <Card>
        <CardHeader title="العرض بعد الطلب" />
        <CardContent>
          <p className="text-xs text-[var(--sys-destructive)]">{error}</p>
        </CardContent>
      </Card>
    ) : null;
  }

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const d = await apiJson<{ settings: PostOrderOfferSettings }>(
        '/api/settings/post-order-offer',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        }
      );
      // The SERVER's answer, not the typed number: it clamps, and a screen
      // that kept showing 0 after the server stored 1 would be lying about
      // what is live.
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
        title="العرض بعد الطلب"
        subtitle="«زيد علبة كمان؟» على شاشة الشكر — العرضُ نفسه تضبطه داخل عروض المنتج، وهنا المهلة وحدها"
      />
      <CardContent className="space-y-4">
        {/* Shown, explained, and not fields. */}
        <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
          <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-[var(--sys-muted-foreground)]">
            <RiLockLine className="h-4 w-4" /> شروطٌ ثابتة — لا تُعدَّل من هنا ولا من غيره
          </p>
          <ul className="space-y-0.5">
            {fixed.map((line) => (
              <li key={line} className="text-xs text-[var(--sys-muted-foreground)]">
                · {line}
              </li>
            ))}
          </ul>
        </div>

        <label className="block max-w-xs">
          <span className="mb-1 block text-xs font-semibold text-[var(--sys-foreground)]">
            مهلة الإضافة من لحظة الطلب
          </span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={1440}
              disabled={!canManage}
              value={settings.windowMinutes}
              onChange={(e) =>
                // The box's own characters, or nothing: `Number('') || 15`
                // would make a cleared box and a typed 15 the same request
                // and write the fabricated figure back into the box.
                setSettings({
                  ...settings,
                  windowMinutes: e.target.value === '' ? 0 : Number(e.target.value),
                })
              }
              className={FIELD}
            />
            <span className="text-xs text-[var(--sys-muted)]">دقيقة</span>
          </div>
          <span className="mt-0.5 block text-xs text-[var(--sys-muted)]">
            <RiTimerLine className="inline h-4 w-4 align-text-bottom" /> بعدها يرفض السيرفر
            الإضافة ويخبر الزبون أن يحكي معكم. الافتراضي{' '}
            {defaults ? defaults.windowMinutes : 15} دقيقة، والمدى من دقيقة إلى يوم.
          </span>
        </label>

        {!canManage && <p className="text-xs text-[var(--sys-muted)]">قراءة فقط — التعديل لمن عنده «تعديل قواعد العروض».</p>}
        {canManage && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? (
              <RiLoader4Line className="h-4 w-4 animate-spin" />
            ) : (
              <RiCheckLine className="h-4 w-4" />
            )}
            احفظ
          </Button>
          {saved && <span className="text-xs font-medium text-[var(--sys-success)]">تم الحفظ</span>}
        </div>
        )}
      </CardContent>
    </Card>
  );
}
