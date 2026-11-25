'use client';

import React, { useRef, useState } from 'react';
import { useConfirm } from '@/components/ui/Confirm';
import { RiDeleteBinLine, RiImageAddLine, RiLoader4Line } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

/**
 * THE STORE'S LOGO AND FAVICON — one place to set each, used everywhere.
 *
 * The storefront header, the landing pages' footer, the store picker and
 * the waybill show Store.logo; the browser tab of the store's pages shows
 * Store.favicon. Both live in the store's settings rather than in a theme or
 * on a page, because they are the store's, and a second copy anywhere else
 * is a second place for them to be out of date.
 */

// F15 (25/11): «waybillLogo» — the store's own waybill logo, uploaded by the waybill card through its own door.
type Kind = 'logo' | 'favicon' | 'waybillLogo';

const COPY: Record<Kind, {
  title: string; hint: string; upload: string; failed: string;
  confirmTitle: string; confirmBody: string; removeTitle: string; removeFailed: string;
}> = {
  logo: {
    title: 'شعار المتجر',
    hint: 'يظهر في واجهة المتجر، وفي تذييل صفحاته، وعلى البوالص. صورة مربّعة بخلفية فاتحة تُقرأ أوضح على الطابعة الحرارية.',
    upload: 'رفع شعار',
    failed: 'تعذر رفع الشعار',
    confirmTitle: 'إزالة الشعار؟',
    confirmBody: 'يختفي من واجهة المتجر ومن البوالص، ويبقى اسم المتجر وحده.',
    removeTitle: 'إزالة الشعار',
    removeFailed: 'تعذر إزالة الشعار',
  },
  waybillLogo: {
    title: 'شعار البوليصة',
    hint: 'بينطبع على البوليصة بس، مش بالمتجر. بالأبيض والأسود أوضح على الطابعة الحرارية. JPG أو PNG أو WEBP، لحد 2 ميجابايت.',
    upload: 'رفع شعار',
    failed: 'تعذر رفع الشعار',
    confirmTitle: 'إزالة شعار البوليصة؟',
    confirmBody: 'البوليصة بترجع تطبع شعار المتجر.',
    removeTitle: 'إزالة شعار البوليصة',
    removeFailed: 'تعذر إزالة الشعار',
  },
  favicon: {
    title: 'أيقونة المتصفح',
    hint: 'تظهر في تبويب المتصفح لصفحات المتجر وصفحات الهبوط. صورة مربّعة بسيطة؛ بدونها يظهر الشعار.',
    upload: 'رفع أيقونة',
    failed: 'تعذر رفع الأيقونة',
    confirmTitle: 'إزالة الأيقونة؟',
    confirmBody: 'يعود تبويب المتصفح لعرض الشعار.',
    removeTitle: 'إزالة الأيقونة',
    removeFailed: 'تعذر إزالة الأيقونة',
  },
};

export function StoreBrandField({
  storeId,
  kind,
  value,
  onChange,
}: {
  storeId: string;
  kind: Kind;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const copy = COPY[kind];
  const endpoint = kind === 'waybillLogo' ? `/api/geo/stores/${storeId}/waybill/logo` : `/api/geo/stores/${storeId}/${kind}`;

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(endpoint, { method: 'POST', body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || copy.failed);
      onChange(data[kind]);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : copy.failed);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    const ok = await confirm({ title: copy.confirmTitle, body: copy.confirmBody, confirmLabel: 'أزل', tone: 'danger' });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error(copy.removeFailed);
      onChange(null);
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : copy.removeFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden border border-[var(--sys-border)] bg-[var(--sys-card)] ${
          kind === 'favicon' ? 'h-10 w-10 rounded-lg' : 'h-14 w-14 rounded-lg'
        }`}
      >
        {value ? (
          <img src={value} alt="" className="h-full w-full object-contain" />
        ) : (
          <RiImageAddLine className="h-5 w-5 text-[var(--sys-muted)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-note font-semibold text-[var(--sys-heading)]">{copy.title}</p>
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">{copy.hint}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label={copy.upload}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <div className="flex shrink-0 gap-1.5">
        <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiImageAddLine className="h-4 w-4" />}
          {value ? 'تغيير' : copy.upload}
        </Button>
        {value && (
          <IconButton type="button" size="sm" label={copy.removeTitle} onClick={() => void remove()} disabled={busy}>
            <RiDeleteBinLine className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
