'use client';

import React, { useEffect, useId, useState } from 'react';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { PRODUCT_SHAPES, SHAPE_INFO, unitWord, type ProductShape } from '@/lib/product-shapes';

/**
 * «شكل القطعة على البوليصة» ON THE PRODUCT PAGE (the owner, 27/11).
 *
 * Nine drawings, one of them true: the new waybill designs draw it once per piece for the packer, and count in its word.
 * Real radio buttons, every choice in view, saved as it is pressed through `PUT /api/products/[id]/shape`. A product
 * nobody chose for is «قطعة عامة». The current waybill draws no shape, and the card says so.
 */
export function ProductShapePicker({ productId, canManage }: { productId: string; canManage: boolean }) {
  const toast = useToast();
  const name = useId();
  const [shape, setShape] = useState<ProductShape | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState(false);
  const url = `/api/products/${productId}/shape`;

  useEffect(() => {
    let alive = true;
    apiJson<{ shape?: ProductShape | null }>(url)
      .then((d) => {
        if (!alive) return;
        setShape(d.shape ?? 'generic');
        setState('ready');
      })
      .catch(() => alive && setState('failed'));
    return () => {
      alive = false;
    };
  }, [url]);

  async function choose(next: ProductShape) {
    const before = shape;
    setShape(next);
    setBusy(true);
    try {
      await apiJson(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shape: next === 'generic' ? null : next }),
      });
      toast.done('انحفظ شكل القطعة.');
    } catch (e) {
      setShape(before);
      toast.failed(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'failed') return <p className="text-note text-[var(--sys-destructive)]">تعذّر تحميل شكل القطعة.</p>;
  if (state === 'loading' || shape === null) return <p className="text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل…</p>;

  return (
    <div className="space-y-2">
      <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
        بيظهر على تصاميم البوليصة الجديدة: رسمة لكل قطعة، والعدد بكلمتها — متل «3 {unitWord(shape, 3)}». «التصميم الأساسي» ما
        بيتغيّر.
      </p>
      <fieldset disabled={!canManage || busy} className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <legend className="sr-only">شكل القطعة على البوليصة</legend>
        {PRODUCT_SHAPES.map((key) => (
          <label
            key={key}
            className={`flex min-h-11 flex-col items-center gap-1 rounded-lg border-2 p-2 text-center ${
              shape === key ? 'border-[var(--sys-primary)]' : 'border-[var(--sys-border)]'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-[var(--sys-heading)]" aria-hidden="true">
              <path d={SHAPE_INFO[key].path} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            <span className="flex items-center gap-1 text-note font-medium text-[var(--sys-heading)]">
              <input
                type="radio"
                name={name}
                value={key}
                checked={shape === key}
                onChange={() => void choose(key)}
                className="h-4 w-4 shrink-0 accent-[var(--sys-primary)]"
              />
              {SHAPE_INFO[key].ar}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
