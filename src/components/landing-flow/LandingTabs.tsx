'use client';

import React from 'react';

/**
 * «الصفحات» · «مكتبة القوالب» — two tabs under the one menu entry.
 *
 * The storefront group of the menu is held at two entries by the owner's
 * own ruling (`a-shop-is-two-entries.test.ts`), so the library is not a
 * third line in the menu: it is the second tab of the entry landing pages
 * already live under, visible on both screens without a click.
 */
export function LandingTabs({ current }: { current: 'pages' | 'library' }) {
  const tabs = [
    { key: 'pages', label: 'الصفحات', href: '/store/landing-pages' },
    { key: 'library', label: 'مكتبة القوالب', href: '/store/landing-pages/library' },
  ] as const;
  return (
    <nav aria-label="صفحات الهبوط" className="mb-4 flex gap-1 border-b border-[var(--sys-border)]">
      {tabs.map((t) => {
        const on = t.key === current;
        return (
          <a
            key={t.key}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-bold md:min-h-9 ${
              on
                ? 'border-[var(--sys-primary)] text-[var(--sys-primary)]'
                : 'border-transparent text-[var(--sys-muted-foreground)] hover:text-[var(--sys-foreground)]'
            }`}
          >
            {t.label}
          </a>
        );
      })}
    </nav>
  );
}
