'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api-client';
import { RiCheckLine, RiKey2Line, RiLoader4Line, RiPlugLine } from '@remixicon/react';

/**
 * «صفحات ذكي» — WHERE THIS SYSTEM TELLS ZAKI PAGES AN ORDER'S STATUS (2026-11-21).
 *
 * Zaki Pages sends some orders' custom conversions to Meta itself; it must hear when such an order is confirmed,
 * delivered and paid, cancelled or returned. The owner points it here: the address Pages listens on, and the signing
 * secret Pages verifies with. The secret is WRITTEN ONLY — the field is empty when the card opens and after a save, and
 * the server never returns it (`/api/settings/pages-link`). The card draws nothing for anybody but the owner: the door
 * answers 403 and the card stays away.
 */

interface Link {
  configured: boolean;
  url: string;
  secretSet: boolean;
  enabled: boolean;
  deliveries: { pending: number; ok: number; failed: number };
  lastFailure: { error: string | null; status: string; at: string } | null;
}

export function PagesLinkCard() {
  const [link, setLink] = useState<Link | null>(null);
  const [urlEdit, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/pages-link');
      setLink(res.ok ? ((await res.json()) as Link) : null);
    } catch {
      setLink(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!link) return null;
  const url = urlEdit ?? link.url;

  async function save(enabled?: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/settings/pages-link', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}), ...(enabled === undefined ? {} : { enabled }) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الحفظ');
      // Emptied at once: a secret left in a field is a secret on a screen somebody else can walk past.
      setSecret('');
      setUrl(null);
      setLink(json as Link);
      setMsg({ ok: true, text: 'حُفظ الربط.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  const ready = /^https:\/\/\S+$/i.test(url.trim()) && (link.secretSet || secret.trim().length >= 16);

  return (
    <Card padding="md">
    <div dir="rtl">
      <div className="mb-1 flex items-center gap-2">
        <RiPlugLine className="h-4 w-4 text-[var(--sys-primary)]" />
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">صفحات ذكي</h2>
      </div>
      <p className="mb-3 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
        حين ترسل صفحات ذكي التحويلات المخصّصة بنفسها، نخبرها بحالة طلباتها: تأكّد · استلم ودفع · ملغي · راجع — رقم الطلب
        والصفحة والحالة فقط، بلا أي بيانات للزبون، موقّعة بالسرّ.
      </p>

      <div className="mb-3 rounded-lg bg-[var(--sys-surface)] p-3">
        {link.configured && (
          <p className="mb-2 flex items-center gap-1.5 text-note font-semibold text-[var(--sys-success)]">
            <RiCheckLine className="h-4 w-4" />
            {link.enabled ? 'الربط شغّال' : 'الربط موقوف'}
          </p>
        )}
        <label className="mb-1 block text-note font-semibold text-[var(--sys-foreground)]">عنوان الاستقبال في صفحات ذكي</label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" dir="ltr" />
        <label className="mb-1 mt-2 flex items-center gap-1.5 text-note font-semibold text-[var(--sys-foreground)]">
          <RiKey2Line className="h-4 w-4 text-[var(--sys-primary)]" />
          سرّ التوقيع
        </label>
        <Input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={link.secretSet ? 'محفوظ — اتركه فارغاً للإبقاء عليه' : ''}
          dir="ltr"
          autoComplete="off"
        />
        <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted)]">
          نفس السرّ المحفوظ في صفحات ذكي. يُشفَّر قبل الحفظ ولا يُعرَض بعدها أبداً، ولا يُكتب في سجل التدقيق.
        </p>
        <div className="mt-2 flex gap-2">
          <Button type="button" size="sm" onClick={() => { void save(); }} disabled={busy || !ready}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null}
            حفظ
          </Button>
          {link.configured && (
            <Button type="button" size="sm" variant="secondary" onClick={() => { void save(!link.enabled); }} disabled={busy || !ready}>
              {link.enabled ? 'أوقف' : 'شغّل'}
            </Button>
          )}
        </div>
      </div>

      {link.configured && (
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-note text-[var(--sys-muted-foreground)]">
          <span>وصل <b className="text-[var(--sys-success)]">{link.deliveries.ok}</b></span>
          {link.deliveries.pending > 0 && <span>بالانتظار {link.deliveries.pending}</span>}
          {link.deliveries.failed > 0 && <span className="text-[var(--sys-destructive)]">فشل {link.deliveries.failed}</span>}
          {link.lastFailure?.error && <span className="text-[var(--sys-warning)]">آخر خطأ: {link.lastFailure.error}</span>}
        </p>
      )}

      {msg && (
        <p className={`mt-2 text-note font-medium leading-relaxed ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
          {msg.text}
        </p>
      )}
    </div>
    </Card>
  );
}
