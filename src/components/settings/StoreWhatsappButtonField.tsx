'use client';

import React, { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { RiLoader4Line, RiWhatsappLine } from '@remixicon/react';
import {
  STORE_WHATSAPP_MODES,
  STORE_WHATSAPP_MODE_AR,
  storeWhatsappModeOf,
  storeWhatsappPhone,
  type StoreWhatsappMode,
} from '@/lib/store-whatsapp';

/**
 * «زر واتساب بالمتجر» (the owner, 26/11) — which way the shop's WhatsApp button opens, picked here and never in code:
 * the company's WhatsApp Business API number (the message lands in the OMS inbox) or an outside number (wa.me). The rule
 * and the fallback are `store-whatsapp.ts`; this says, under the choice, which number a shopper will reach right now.
 */
export function StoreWhatsappButtonField({
  store,
  onSaved,
}: {
  store: { id: string; supportPhone?: string | null; whatsappMode?: string | null; whatsappNumber?: string | null };
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<StoreWhatsappMode>(storeWhatsappModeOf(store.whatsappMode));
  const [number, setNumber] = useState(store.whatsappNumber ?? '');
  // The connected API number, when this person may read it: undefined while asking, null for none.
  const [apiNumber, setApiNumber] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setMode(storeWhatsappModeOf(store.whatsappMode));
    setNumber(store.whatsappNumber ?? '');
  }, [store]);

  useEffect(() => {
    let live = true;
    apiJson<{ connection: { phoneNumber: string | null } | null; status: string }>('/api/whatsapp/connection').then(
      (r) => live && setApiNumber(r.status === 'CONNECTED' ? r.connection?.phoneNumber ?? null : null),
      () => live && setApiNumber(null)
    );
    return () => {
      live = false;
    };
  }, []);

  const changed = mode !== storeWhatsappModeOf(store.whatsappMode) || number.trim() !== (store.whatsappNumber ?? '');
  const reaches = storeWhatsappPhone({ whatsappMode: mode, whatsappNumber: number, supportPhone: store.supportPhone }, apiNumber ?? null);
  const apiFallsBack = mode === 'API' && apiNumber === null;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await apiJson(`/api/geo/stores/${store.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ whatsappMode: mode, whatsappNumber: number.trim() || null }),
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
    <div className="space-y-3 border-t border-[var(--sys-border)] pt-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
          <RiWhatsappLine className="h-4 w-4 text-[var(--sys-success)]" />
          زر واتساب بالمتجر
        </p>
        <p className="mt-0.5 text-note leading-relaxed text-[var(--sys-muted-foreground)]">اختار وين بتروح رسالة الزبون لما يكبس زر الواتساب بالمتجر وصفحات المنتجات.</p>
      </div>

      <div className="space-y-2" role="radiogroup" aria-label="طريقة زر الواتساب">
        {STORE_WHATSAPP_MODES.map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm text-[var(--sys-foreground)]">
            <input type="radio" name={`wa-mode-${store.id}`} value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
            <span>
              <span className="font-semibold">{STORE_WHATSAPP_MODE_AR[m].label}</span>
              <span className="mt-0.5 block text-note text-[var(--sys-muted-foreground)]">{STORE_WHATSAPP_MODE_AR[m].hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'EXTERNAL' && (
        <label className="block text-note font-medium text-[var(--sys-foreground)]">
          رقم الواتساب
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            dir="ltr"
            inputMode="tel"
            maxLength={24}
            placeholder={store.supportPhone || '+963 9xx xxx xxx'}
            className="mt-1 block h-11 md:h-10 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-left text-sm focus:border-[var(--sys-primary)] focus:outline-none"
          />
          <span className="mt-1 block text-note text-[var(--sys-muted)]">مع رمز البلد. إذا تركته فاضي بيفتح على هاتف الدعم.</span>
        </label>
      )}

      {apiFallsBack && (
        <p className="text-note text-[var(--sys-warning)]">
          ما في رقم واتساب API مربوط أو معروف لهلأ، فالزر مؤقتًا بيفتح على الرقم الخارجي. بيتعبّى رقم الشغل لحاله مع أول رسالة بتوصل على صندوق الواتس.
        </p>
      )}
      {apiNumber !== undefined && (
        <p className="text-note text-[var(--sys-muted-foreground)]">
          الزبون رح يوصل لـ: <span dir="ltr" className="font-mono">{reaches ?? '—'}</span>
          {!reaches && ' (ما في رقم، والزر ما رح يبين)'}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={!changed || saving}>
          {saving && <RiLoader4Line className="h-4 w-4 animate-spin" />}
          احفظ زر الواتساب
        </Button>
        {msg && <span className={`text-note ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
