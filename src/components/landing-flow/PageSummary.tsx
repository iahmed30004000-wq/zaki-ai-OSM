'use client';

import React from 'react';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { designById } from '@/lib/landing-designs/catalog';

/**
 * «عرض» — WHAT THIS PAGE IS, ON ONE CARD, ABOVE ITS SETTINGS.
 *
 * His other platform's page view: the product, the link with a copy
 * button, the status, the offers that are live for the product, and
 * edit / preview / duplicate. The offers are the same `activeOffersFor`
 * list the public form sells from, with the price the server computed.
 *
 * THE NUMBERS ARE ONE PRESS AWAY, NOT HERE. His platform prints views on
 * this view; this system's contract (`one-place.test.ts`) gives a page's
 * views, orders and conversion ONE screen — the performance screen, by
 * period, device and campaign — so this card links there instead of
 * printing a second, lifetime-only copy that would disagree with it.
 */
export interface SummaryOffer {
  id: string;
  name: string;
  quantity: number;
  freeQuantity: number;
  price: number;
}

interface Props {
  lp: {
    name: string;
    isPublished: boolean;
    product?: { name?: string } | null;
    theme?: string | null;
  };
  publicUrl: string;
  offers: SummaryOffer[];
  copied: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onPreview: () => void;
  onDuplicate: () => Promise<void> | void;
}

/** The design a page was started from, read from its theme; nothing when it names none or one unknown. */
function designOf(theme: string | null | undefined): string | null {
  if (!theme) return null;
  try {
    return designById((JSON.parse(theme) as { design?: string }).design)?.name ?? null;
  } catch {
    return null;
  }
}

export function PageSummary({ lp, publicUrl, offers, copied, onCopy, onEdit, onPreview, onDuplicate }: Props) {
  const design = designOf(lp.theme);
  return (
    <Card className="mb-6">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-[var(--sys-heading)]">{lp.name}</h2>
            <Badge variant={lp.isPublished ? 'success' : 'warning'}>{lp.isPublished ? 'منشورة' : 'مسودة'}</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onEdit}>تعديل</Button>
            <Button size="sm" variant="outline" onClick={onPreview}>معاينة</Button>
            <Button size="sm" variant="outline" onClick={onDuplicate}>انسخ الصفحة</Button>
          </div>
        </div>

        <dl className="grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-[var(--sys-muted)]">المنتج</dt>
            <dd className="font-semibold text-[var(--sys-heading)]">{lp.product?.name || 'بلا منتج'}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-[var(--sys-muted)]">رابط الصفحة</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="truncate text-[var(--sys-heading)]" dir="ltr">{publicUrl}</code>
              <Button size="sm" variant="secondary" onClick={onCopy}>{copied ? 'انتسخ' : 'انسخ الرابط'}</Button>
            </dd>
          </div>
          {design && (
            <div>
              <dt className="text-[var(--sys-muted)]">التصميم</dt>
              <dd className="font-semibold text-[var(--sys-heading)]">{design}</dd>
            </div>
          )}
        </dl>

        <a
          href="/growth/performance?tab=landing"
          className="inline-block text-xs font-semibold text-[var(--sys-primary)] hover:underline"
        >
          المشاهدات والطلبات والتحويل بشاشة الأداء ←
        </a>

        <div>
          <h3 className="text-xs font-semibold text-[var(--sys-foreground)]">العروض الشغّالة للمنتج</h3>
          {offers.length === 0 ? (
            <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
              {lp.product ? 'ما في عروض شغّالة لهالمنتج.' : 'الصفحة بلا منتج، فما إلها عروض.'}
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {offers.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] px-2.5 py-1.5 text-xs">
                  <span className="font-semibold text-[var(--sys-heading)]">{o.name}</span>
                  <span className="tabular-nums text-[var(--sys-muted-foreground)]" dir="ltr">
                    <Money value={o.price} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
