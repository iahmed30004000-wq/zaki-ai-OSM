'use client';

import React from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { PerLineSettlementCard } from '@/components/settings/PerLineSettlementCard';
import { PartnersCard } from '@/components/settings/PartnersCard';
import { ExchangeRatesCard } from '@/components/settings/ExchangeRatesCard';

/**
 * «قواعد المال» — THE MONEY RULES, IN «المال» (the owner's plan of 17/11, request R13i).
 *
 * The two money cards of «إعدادات النظام» had no home of their own there: «تسوية السطور النظيفة عند الاعتماد» decides when a matched line settles its
 * order, and «الشركاء والنسب» decides how the net profit is split. Both are read by the person who reads the money, so they are the last tab of «المال» now.
 * They moved UNCHANGED as components: each still reads and writes its own door and asks its own key (the per-line switch `settings.manage` to flip it,
 * the partners card `finance.partners` to be drawn at all). The page opens on `settings.view`, the key of the page they came from — nobody gains or loses them.
 *
 * This screen decides nothing, fetches nothing and types no number.
 */
export function FinanceRulesScreen() {
  return (
    <PageShell title={routeLabel('/finance/rules')} description="قواعد المال اللي بتنطبق على كل الشركة: متى بتتسوّى الطلبات، وكيف بينقسم الصافي." width="narrow">
      <div className="space-y-4" dir="rtl">
        {/* «تسوية السطور النظيفة عند الاعتماد (تجريبي)» — the approval also settles every clean line; a line still a question holds only its own order. Off by default. */}
        <PerLineSettlementCard />

        {/* «الشركاء والنسب» — each partner's share of the net profit. Drawn only for who holds `finance.partners` (the owner's to tick). */}
        <PartnersCard />

        {/* «أسعار الصرف» (23/11, F8) — the rates a partner's draw is converted at; behind the same key as the partners card. */}
        <ExchangeRatesCard />
      </div>
    </PageShell>
  );
}
