'use client';

import React from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { AuthenticityCodesCard } from '@/components/settings/AuthenticityCodesCard';

/**
 * «رموز الأصالة» — THE OWNER'S LIST OF PIECE CODES, A PAGE OF ITS OWN IN «الإدارة» (25/11, the owner).
 *
 * The card sat on «إعدادات النظام»; the owner asked for it as its own menu page, right beside «باركود المنتجات», where
 * each product's own page checks these codes. The card moved whole (it still reads on `settings.view` and adds and
 * deletes on `settings.edit`); the page opens on `settings.view`, the key of the page it came from.
 *
 * This screen decides nothing and fetches nothing.
 */
export function AuthenticityScreen() {
  return (
    <PageShell
      title={routeLabel('/settings/authenticity')}
      description="الرموز اللي بتطلع «أصلي» لما ينفحصوا — كل رمز لقطعة، وفيك تربطه بمنتج."
      width="narrow"
    >
      <div className="space-y-4" dir="rtl">
        <AuthenticityCodesCard />
      </div>
    </PageShell>
  );
}
