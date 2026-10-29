'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/Confirm';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { RiAlertLine, RiCheckLine, RiExchangeLine, RiFileCopyLine, RiLoader4Line, RiRefreshLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * The address the courier pushes statuses to.
 *
 * Shown once, when it is minted, and never again — it is a credential, the
 * same as the password one card up. The screen afterwards knows only that a
 * URL exists, when it was made, and whether the courier has ever used it.
 *
 * That last fact is the useful one: a URL created three days ago that has
 * never been called means the courier did not actually add it, and the
 * statuses are still arriving only by polling.
 */

interface Status {
  configured: boolean;
  setAt: string | null;
  lastSeenAt: string | null;
  /** The status job pulls this courier's parcels from its API. */
  polled?: boolean;
}

export function CourierWebhook({ providerId }: { providerId: string }) {
  const ask = useConfirm();
  const toast = useToast();
  // Minting and stopping the link are «الإعدادات الحسّاسة».
  const canManage = useCan('settings.manage');
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiJson<Status>(`/api/settings/couriers/${providerId}/webhook`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = async () => {
    if (
      status?.configured &&
      !(await ask({
        title: 'رابط جديد؟',
        body: 'الرابط الحالي سيتوقف فوراً، وعليك إرسال الجديد لشركة الشحن.',
        confirmLabel: 'ولّد رابطاً جديداً',
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const d = await apiJson<{ url: string }>(`/api/settings/couriers/${providerId}/webhook`, { method: 'POST' });
      setUrl(d.url);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التوليد');
    } finally {
      setBusy(false);
    }
  };

  // «الغي الويب هوك وخليك API» — the URL stops; the statuses keep coming from the API.
  const revoke = async () => {
    if (
      !(await ask({
        title: 'إيقاف الرابط؟',
        body: 'أي حالة ترسلها الشركة على هذا الرابط رح تنرفض. الحالات بتضل تنسحب من الشركة تلقائياً.',
        confirmLabel: 'أوقف الرابط',
        tone: 'danger',
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await apiJson(`/api/settings/couriers/${providerId}/webhook`, { method: 'DELETE' });
      setUrl(null);
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذّر الإيقاف');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    const ok = await copyText(url);
    if (!ok) {
      setError('تعذر النسخ — حدّد الرابط وانسخه يدوياً.');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (!status) return null;

  return (
    <div className="space-y-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--sys-heading)]">
            <RiExchangeLine className="h-4 w-4 text-[var(--sys-primary)]" />
            رابط استقبال الحالات
          </p>
          <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
            {!status.configured ? (
              status.polled ? (
                <>لا رابط — الحالات تُسحب من شركة الشحن تلقائياً كل دقيقتين.</>
              ) : (
                <>هذه الشركة غير مربوطة — الحالات تُحدَّث يدوياً من شاشة الشحنة.</>
              )
            ) : status.polled ? (
              <>الحالات تُسحب تلقائياً، والرابط إضافة ما في حاجة إلها.</>
            ) : status.lastSeenAt ? (
              <>
                يعمل · آخر استقبال {arDateTime(status.lastSeenAt)}
              </>
            ) : (
              <>
                أُنشئ {status.setAt && arDateTime(status.setAt)} — ولم تصل عليه أي حالة بعد.
              </>
            )}
          </p>
        </div>
        {canManage && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={mint} disabled={busy}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiRefreshLine className="h-4 w-4" />}
            {status.configured ? 'رابط جديد' : 'أنشئ الرابط'}
          </Button>
          {status.configured && (
            <Button size="sm" variant="outline" onClick={revoke} disabled={busy}>
              أوقف الرابط
            </Button>
          )}
        </div>
        )}
      </div>

      {/* Shown once. Reloading this screen will not bring it back. */}
      {url && (
        <div className="space-y-1.5 rounded-lg border border-[var(--sys-primary-soft)] bg-[var(--sys-primary-soft)] p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--sys-primary)]">
            <RiAlertLine className="h-4 w-4" />
            انسخه الآن — لن يُعرَض مرة أخرى.
          </p>
          <div className="flex items-center gap-1.5">
            <code
              dir="ltr"
              className="flex-1 truncate rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] px-2 py-1.5 text-xs text-[var(--sys-foreground)]"
            >
              {url}
            </code>
            <button
              type="button"
              onClick={copy}
              title="انسخ"
              className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 shrink-0 cursor-pointer rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-1.5 text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
            >
              {copied ? <RiCheckLine className="h-4 w-4 text-[var(--sys-success)]" /> : <RiFileCopyLine className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            أرسله لشركة الشحن ليضيفوه عندهم. الرابط كلمة سرّ: من يملكه يستطيع إرسال
            حالات باسمهم — لا تنشره في مجموعة.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-[var(--sys-destructive)]">{error}</p>}
    </div>
  );
}
