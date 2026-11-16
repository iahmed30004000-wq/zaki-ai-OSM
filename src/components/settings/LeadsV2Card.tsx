'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «ليدز الصفحات (تجريبي)» — THE OWNER'S SWITCH FOR KEEPING THE PAGES SYSTEM'S LEADS (`leads/leads-v2-switch.ts`, step E of Confirmation Center v2).
 *
 * Off, the webhook answers «received» and keeps nothing. On, a person who left his details on a page of pages.zakiai.io and has not ordered is kept once, and flagged if his number already ordered the
 * same product in the last day. The card says what it does NOT do — no order is created, nothing is messaged — and that the webhook only accepts what is signed with a secret kept in the server's
 * environment. Its own key. Seen by whoever opens the settings; turned by whoever holds `settings.manage` — the server asks it again.
 */
interface LeadsV2View {
  enabled: boolean;
  enabledAt: string | null;
}
interface LeadsV2Answer {
  leadsV2: LeadsV2View;
}

export function LeadsV2Card() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [state, setState] = useState<LeadsV2Answer | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiJson<LeadsV2Answer>('/api/settings/leads-v2'));
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
        await apiJson<LeadsV2Answer>('/api/settings/leads-v2', {
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
        title="ليدز الصفحات (تجريبي)"
        subtitle={
          <>
            لما حدا بيترك بياناتو بصفحة من صفحات الهبوط وما بيطلب، نظام الصفحات بيبعت بياناتو للنظام بطلب موقّع. مفعّل: بينحفظ مرة وحدة، وبيتعلّم لو رقمو طلب نفس المنتج خلال آخر 24 ساعة.
            <br />
            ما بينعمل طلب ولا بينبعت شي للزبون. والنظام ما بيقبل غير الطلب الموقّع بسرّ محفوظ ببيئة السيرفر، مش بالإعدادات. مطفي: بيرد «وصل» وما بيحفظ شي.
            <br />
            مفتاح لحالو، مش مفتاح «إثبات المكالمات وجدول المحاولات». مطفي = الشغل زي ما هو.
          </>
        }
      />
      <CardContent className="space-y-4">
        <label className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
          <input
            type="checkbox"
            checked={state.leadsV2.enabled}
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
