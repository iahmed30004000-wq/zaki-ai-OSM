'use client';

import React from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { PerformanceSettingsCard } from '@/components/settings/PerformanceSettingsCard';
import { PenaltyRulesCard } from '@/components/settings/PenaltyRulesCard';

/**
 * «قواعد الموظفين» — HOW THE STAFF ARE MEASURED AND WHAT A SLIP COSTS, IN «الإدارة» (the owner's plan of 17/11, request R15a).
 *
 * The two cards sat on «إعدادات النظام» among the company's own name: «سكور الموظفين» sets the bars the work is judged by, and «قواعد الخصم» proposes the
 * deductions. They are about the people, so they stand beside «الموظفين» now. They moved UNCHANGED as components: each still reads and writes its own door
 * and asks its own key to edit (the score `team.settings`, the deductions `penalties.rules`; without it each says «قراءة فقط»). The page opens on
 * `settings.view`, the key of the page they came from — nobody gains or loses them.
 *
 * The two stay side by side on purpose: one measures and the other charges, and an owner setting a deduction should be looking at the bars they judge by.
 *
 * This screen decides nothing, fetches nothing and types no number.
 */
export function StaffRulesScreen() {
  return (
    <PageShell title={routeLabel('/admin/staff-rules')} description="بأي مقياس بينحكم على شغل الموظفين، وشو بينقترح خصم عليه." width="narrow">
      <div className="space-y-4" dir="rtl">
        {/* «سكور الموظفين» — the weights are fixed, the bars are the owner's. Edited by whoever holds `team.settings`. */}
        <PerformanceSettingsCard />

        {/* «قواعد الخصم» — they only propose: no deduction becomes money without a person's decision on «خصومات الموظفين». Edited with `penalties.rules`. */}
        <PenaltyRulesCard />
      </div>
    </PageShell>
  );
}
