'use client';

import React, { useEffect, useState } from 'react';
import { RiLoader4Line, RiPrinterLine } from '@remixicon/react';
import { apiFetch, apiJson, saidBy } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Segmented } from '@/components/ui/Segmented';
import { useLabelSize } from '@/components/labels/LabelSize';
import { StoreBrandField } from './StoreBrandField';

/**
 * «البوليصة المطبوعة» — WHAT THIS STORE'S WAYBILL SHOWS (25/11, F15).
 *
 * The owner: «أضيف شعار للفاتورة … وأتحكم بعناصر الفاتورة شو اللي رح ينعرض». The waybill IS the document an order
 * prints here; this card tells its one renderer which logo to draw and which parts to leave off, per store. Beside it,
 * the preview is that renderer's own page for a made-up order, on the paper this device prints on — what is seen is
 * what prints. The parts the courier works from are drawn ticked and locked, with the reason (the door refuses them too).
 * Until «حفظ» nothing changes; with nothing saved the waybill is today's, byte for byte.
 */

type LogoChoice = 'store' | 'own' | 'none';
interface Element { key: string; ar: string; locked: boolean }
interface Loaded {
  settings: { hide: string[]; logo: LogoChoice };
  ownLogo: string | null;
  storeLogo: string | null;
  elements: Element[];
  lockedReason: string;
}

const LOGO_OPTIONS = [
  { value: 'store', label: 'شعار المتجر' },
  { value: 'own', label: 'شعار خاص' },
  { value: 'none', label: 'بلا شعار' },
];

export function WaybillPrintCard({ storeId, mayManage }: { storeId: string; mayManage: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hide, setHide] = useState<string[]>([]);
  const [logo, setLogo] = useState<LogoChoice>('store');
  const [ownLogo, setOwnLogo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const { dims } = useLabelSize();
  // By value: `dims` is a new object on every render, and the preview must not ask again for the same paper.
  const { width, height, sheetWidth, sheetHeight } = dims;

  useEffect(() => {
    let alive = true;
    apiJson<Loaded>(`/api/geo/stores/${storeId}/waybill`)
      .then((d) => {
        if (!alive) return;
        setLoaded(d);
        setHide(d.settings.hide);
        setLogo(d.settings.logo);
        setOwnLogo(d.ownLogo);
      })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : 'تعذّر التحميل'));
    return () => {
      alive = false;
    };
  }, [storeId]);

  // The live preview: the draft, drawn by the print page's own renderer, a moment after the last change.
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/geo/stores/${storeId}/waybill/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hide, logo, width, height, sheetWidth, sheetHeight }),
        });
        if (!alive) return;
        if (!res.ok) {
          setPreviewError(await saidBy(res, 'تعذّرت المعاينة'));
          return;
        }
        setPreviewError(null);
        setPreview(await res.text());
      } catch (e) {
        if (alive) setPreviewError(e instanceof Error ? e.message : 'تعذّرت المعاينة');
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loaded, storeId, hide, logo, ownLogo, width, height, sheetWidth, sheetHeight]);

  if (loadError) return <Card padding="md"><p className="text-note text-[var(--sys-destructive)]">{loadError}</p></Card>;
  if (!loaded) return <Card padding="md"><RiLoader4Line className="h-4 w-4 animate-spin" aria-label="جارٍ التحميل" /></Card>;

  const changed = logo !== loaded.settings.logo || hide.join(',') !== loaded.settings.hide.join(',');
  const isDefault = logo === 'store' && hide.length === 0;
  const toggle = (key: string, shown: boolean) =>
    setHide((cur) => (shown ? cur.filter((k) => k !== key) : [...cur, key]));

  async function save(next: { hide: string[]; logo: LogoChoice }) {
    setSaving(true);
    setMsg(null);
    try {
      const d = await apiJson<{ settings: { hide: string[]; logo: LogoChoice } }>(`/api/geo/stores/${storeId}/waybill`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      setLoaded((cur) => (cur ? { ...cur, settings: d.settings } : cur));
      setHide(d.settings.hide);
      setLogo(d.settings.logo);
      setMsg({ ok: true, text: 'تم الحفظ — البوالص اللي بتنطبع من هلق بتطلع هيك' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذّر الحفظ' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="md" className="space-y-4">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
          <RiPrinterLine className="h-4 w-4 text-[var(--sys-primary)]" />
          البوليصة المطبوعة
        </p>
        <p className="mt-0.5 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          شو بينطبع على بوليصة هالمتجر (الطباعة وحفظ PDF). ملف الإكسل لشركة الشحن ما بيتغيّر.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-note font-semibold text-[var(--sys-heading)]">الشعار</p>
            <Segmented
              aria-label="شعار البوليصة"
              options={LOGO_OPTIONS.map((o) => (o.value === 'own' && !ownLogo ? { ...o, disabled: true } : o))}
              value={logo}
              onChange={(v) => setLogo(v as LogoChoice)}
              disabled={!mayManage}
            />
            {logo === 'store' && !loaded.storeLogo && (
              <p className="text-note text-[var(--sys-muted-foreground)]">المتجر ما إلو شعار لسا — ارفعو من «هوية المتجر» فوق.</p>
            )}
            {mayManage && (
              <StoreBrandField
                storeId={storeId}
                kind="waybillLogo"
                value={ownLogo}
                onChange={(v) => {
                  setOwnLogo(v);
                  // The upload picks it; the removal falls back to the store's logo — as the door stored it.
                  setLogo(v ? 'own' : logo === 'own' ? 'store' : logo);
                  setLoaded((cur) => (cur ? { ...cur, settings: { ...cur.settings, logo: v ? 'own' : cur.settings.logo === 'own' ? 'store' : cur.settings.logo } } : cur));
                }}
              />
            )}
          </div>

          <div className="space-y-2 border-t border-[var(--sys-border)] pt-3">
            <p className="text-note font-semibold text-[var(--sys-heading)]">العناصر</p>
            {loaded.elements.map((e) => (
              <Checkbox
                key={e.key}
                id={`waybill-${storeId}-${e.key}`}
                checked={e.locked || !hide.includes(e.key)}
                onChange={(shown) => toggle(e.key, shown)}
                disabled={e.locked || !mayManage}
                label={e.ar}
                hint={e.locked ? loaded.lockedReason : undefined}
              />
            ))}
          </div>

          {mayManage && (
            <div className="flex items-center gap-2">
              <Button type="button" onClick={() => void save({ hide, logo })} disabled={!changed || saving}>
                {saving && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                حفظ
              </Button>
              <Button type="button" variant="secondary" onClick={() => void save({ hide: [], logo: 'store' })} disabled={saving || (isDefault && !changed && loaded.settings.logo === 'store')}>
                رجّع متل الأول
              </Button>
              {msg && <span className={`text-note ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</span>}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-note font-semibold text-[var(--sys-heading)]">
            معاينة — {dims.width}×{dims.height} مم (مقاس الطباعة على هالجهاز)
          </p>
          {previewError && <p className="text-note text-[var(--sys-destructive)]">{previewError}</p>}
          {preview && (
            // No script runs in the frame (an empty sandbox list but same-origin, so the logo loads with the session).
            <Card plain className="overflow-hidden">
              <iframe title="معاينة البوليصة" sandbox="allow-same-origin" srcDoc={preview} className="block h-[60vh] w-full" />
            </Card>
          )}
        </div>
      </div>
    </Card>
  );
}
