'use client';

import React from 'react';
import { RiExternalLinkLine, RiPaletteLine, RiStore2Line } from '@remixicon/react';
import { EditingStoreBar } from '@/components/shell/EditingStoreBar';
import { Card } from '@/components/ui/Card';

/**
 * WHERE A STORE'S FACE IS MANAGED — A SIGNPOST, NOT A SECOND EDITOR.
 *
 * Open/close, tagline and about moved to the store's card at `/store`:
 * one editor, so the two can never disagree. This panel keeps a single
 * link there, plus the rows that genuinely live here: the read-only
 * domain (edited on its own screen, with DNS checks) and the link to
 * the templates.
 */

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  type: 'SINGLE_PRODUCT' | 'MULTI_PRODUCT';
  storefrontEnabled?: boolean;
  domain?: string | null;
  landingPageId?: string | null;
}

export function StorefrontSettings({ store }: { store: StoreRow; onSaved?: () => void }) {
  return (
    <Card padding="md" className="space-y-4">
      {/* Which store this edits — same bar every storefront screen carries. */}
      <EditingStoreBar />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-bold text-[var(--sys-heading)]">
            <RiStore2Line className="h-4 w-4 text-[var(--sys-primary)]" />
            واجهة متجر {store.name}
          </p>
          <p className="mt-0.5 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
            يعرض منتجات هذا المتجر ويستقبل الطلبات بنفس مسار صفحات الهبوط —
            نفس العروض، نفس نموذج الطلب، نفس التحقق.
          </p>
        </div>

        {store.storefrontEnabled && (
          <a
            href={`/s/${store.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 text-note font-bold text-[var(--sys-primary)] hover:underline"
          >
            <RiExternalLinkLine className="icon-mirror h-4 w-4" /> افتح المتجر
          </a>
        )}
      </div>

      {/* The one place these are edited now. */}
      <a
        href="/store"
        className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2.5 text-note text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
      >
        <span className="flex items-center gap-1.5">
          <RiStore2Line className="h-4 w-4" />
          الفتح والإغلاق والسطر التعريفي والنبذة
        </span>
        <span className="font-semibold">في «المتجر» ←</span>
      </a>

      <div>
        <span className="mb-1.5 block text-note font-medium text-[var(--sys-heading)]">نطاق خاص</span>
        <Card plain padding="sm">
        <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
          {store.domain ? (
            <span dir="ltr" className="font-medium text-[var(--sys-foreground)]">{store.domain}</span>
          ) : (
            'لا نطاق خاص.'
          )}{' '}
          يُضبط من{' '}
          <a href="/store?tab=address&amp;sec=domain" className="font-medium text-[var(--sys-primary)] hover:underline">
            «المتجر ← العنوان»
          </a>{' '}
          — هناك يُفحص الـDNS فعلاً ويُعاد التحقق عند كل تغيير.
        </p>
        </Card>
      </div>

      {store.type === 'SINGLE_PRODUCT' && !store.landingPageId && (
        <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] px-3 py-2 text-note leading-relaxed text-[var(--sys-warning)]">
          هذا المتجر واجهتُه صفحةُ هبوط، ولم تُختَر صفحةٌ بعد — فلا شيء يُعرض لزائره.{' '}
          <a
            href="/store"
            className="font-semibold underline"
          >
            اختر صفحته الآن
          </a>
        </p>
      )}

      {store.type === 'SINGLE_PRODUCT' && store.landingPageId && (
        <p className="rounded-lg bg-[var(--sys-surface-strong)] px-3 py-2 text-note leading-relaxed text-[var(--sys-foreground)]">
          واجهة هذا المتجر صفحة هبوط — ألوانها وخطها ونصوصها تُعدَّل من{' '}
          <a href="/store" className="font-semibold text-[var(--sys-primary)] hover:underline">
            المتجر ← بطاقة المتجر
          </a>
          . اللون والنصوص هنا لا تظهر عليها؛ الشعار ورقم الدعم يُطبعان على البوالص.
        </p>
      )}

      <a
        href="/store?tab=front&amp;sec=look"
        className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] px-3 py-2.5 text-note text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]"
      >
        <span className="flex items-center gap-1.5">
          <RiPaletteLine className="h-4 w-4" />
          الألوان والخطوط والترويسة والتذييل وشكل الدفع
        </span>
        <span className="font-semibold">في «المتجر ← الواجهة» ←</span>
      </a>
    </Card>
  );
}
