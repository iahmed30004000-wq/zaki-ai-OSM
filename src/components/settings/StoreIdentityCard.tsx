'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { StoreBrandField } from './StoreBrandField';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { RiLoader4Line, RiVerifiedBadgeLine } from '@remixicon/react';

/**
 * WHO THE STORE IS — its name, logo, favicon and support phone.
 *
 * Identity, not look: the system reads these too — the waybill prints the
 * logo and the phone, the store picker shows the name and logo — so they
 * live with the store itself in «البلدان والمتاجر», once. The store's pages
 * (the storefront, the landing pages' footer, the browser tab) read them
 * from here; nothing else keeps a copy. The store's look — its theme,
 * sections and pages — lives in the store section.
 */

interface IdentityRow {
  id: string;
  name: string;
  logo?: string | null;
  favicon?: string | null;
  supportPhone?: string | null;
}

export function StoreIdentityCard({ store, onSaved }: { store: IdentityRow; onSaved?: () => void }) {
  const [name, setName] = useState(store.name);
  const [phone, setPhone] = useState(store.supportPhone ?? '');
  const [logo, setLogo] = useState<string | null>(store.logo ?? null);
  const [favicon, setFavicon] = useState<string | null>(store.favicon ?? null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setName(store.name);
    setPhone(store.supportPhone ?? '');
    setLogo(store.logo ?? null);
    setFavicon(store.favicon ?? null);
  }, [store]);

  const nameChanged = name.trim() !== store.name;
  const phoneChanged = phone.trim() !== (store.supportPhone ?? '');
  const changed = nameChanged || phoneChanged;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      // Only what was edited. Re-sending an untouched phone meant a value
      // saved before this field was validated — a legacy one the new rule
      // refuses — failed every rename, with an error pointing at a field the
      // seller never opened.
      const body: Record<string, unknown> = {};
      if (nameChanged) body.name = name.trim();
      if (phoneChanged) body.supportPhone = phone.trim() || null;
      await apiJson(`/api/geo/stores/${store.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMsg({ ok: true, text: 'تم الحفظ' });
      onSaved?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="md" className="space-y-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
          <RiVerifiedBadgeLine className="h-4 w-4 text-[var(--sys-primary)]" />
          هوية المتجر
        </p>
        <p className="mt-0.5 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          تُكتب هنا مرة واحدة، وتقرؤها صفحات المتجر والبوالص واختيار المتجر.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-note font-medium text-[var(--sys-foreground)]">
          اسم المتجر
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="mt-1 block h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-sm focus:border-[var(--sys-primary)] focus:outline-none"
          />
        </label>
        <label className="block text-note font-medium text-[var(--sys-foreground)]">
          هاتف الدعم
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            dir="ltr"
            inputMode="tel"
            maxLength={24}
            placeholder="0999 000 000"
            className="mt-1 block h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-left text-sm focus:border-[var(--sys-primary)] focus:outline-none"
          />
          <span className="mt-1 block text-note text-[var(--sys-muted)]">يظهر للزبون في المتجر وتذييل الصفحات، ويُطبع على البوليصة.</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={!changed || saving || name.trim().length < 2}>
          {saving && <RiLoader4Line className="h-4 w-4 animate-spin" />}
          حفظ
        </Button>
        {msg && <span className={`text-note ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
      </div>

      {/* Saved on upload, not with the form: a file is not a field to
          remember to press save for. */}
      <div className="space-y-3 border-t border-[var(--sys-border)] pt-3">
        <StoreBrandField storeId={store.id} kind="logo" value={logo} onChange={(v) => { setLogo(v); onSaved?.(); }} />
        <StoreBrandField storeId={store.id} kind="favicon" value={favicon} onChange={(v) => { setFavicon(v); onSaved?.(); }} />
      </div>
    </Card>
  );
}
