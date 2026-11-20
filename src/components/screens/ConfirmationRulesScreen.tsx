'use client';

import React from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';
import { CallProofCard } from '@/components/settings/CallProofCard';
import { IntakeFilterCard } from '@/components/settings/IntakeFilterCard';
import { QueuePriorityCard } from '@/components/settings/QueuePriorityCard';
import { WinbackV2Card } from '@/components/settings/WinbackV2Card';
import { LeadsV2Card } from '@/components/settings/LeadsV2Card';
import { QueueModesCard } from '@/components/settings/QueueModesCard';
import { DeskPeopleTable } from '@/components/confirmation/DeskPeopleTable';
import { ConfirmationRuleEditor } from '@/components/settings/ConfirmationRuleEditor';

/**
 * «قواعد مركز التأكيد» — THE ONE PAGE OF THE CONFIRMATION RULES (the owner's plan of 17/11, request C1).
 *
 * The eight cards of these rules used to sit among the company's own settings on «إعدادات النظام», two screens away from the desk they govern, and three of them
 * contradicted each other. They are here now, UNCHANGED as components (each still reads and writes its own door and asks its own key), under a short box that says
 * what the rule is in one reading. «/settings/system» keeps the company's name, the score, the deductions, the offer after the order, the clean-line settlement
 * and the partners — and none of these eight.
 *
 * The two OLD cards («نظام الجولات» and «الطلب يرجع للطابور فوراً») LEFT this page in request C2 (18/11): the one rule replaced them, and one line under the box says so.
 * Their doors keep GET and refuse every write (409 `RULE_RETIRED`); their stored values are not touched; their engine code leaves later (C4).
 *
 * «مين مربوطة بالقواعد» (request Q1b, 19/11) stands under the box: who is at the desk, bound or not and by which key, and «افحص موظفة» — read from the server, decided nowhere here.
 *
 * «أرقام القاعدة» (request Q3c, 20/11) stands under that section: the owner edits the rule's numbers there; the server checks every one, and the box is read
 * again after a save (`router.refresh`).
 *
 * `lines` is the box's text, written on the server from the constants and the switches the engine reads (`confirmation-rule-summary.ts`) — this screen decides nothing and types no number.
 */
/** The one line that says where the two old cards went (request C2). */
export const RULE_REPLACED_LINE = 'القاعدة الوحدة اللي فوق بدّلت «نظام الجولات» و«الطلب يرجع للطابور فوراً» — انشالوا من هون وما بيتغيّروا بعد هلّق.';

export function ConfirmationRulesScreen({ lines }: { lines: string[] }) {
  return (
    <PageShell title={routeLabel('/confirmation/rules')} description="كل قواعد التأكيد بمكان واحد." width="narrow">
      <div className="space-y-4" dir="rtl">
        <Card>
          <CardHeader title="القاعدة بالمختصر" subtitle="هيك بيصير بالطلب اللي ما بيرد، بأرقام الإعدادات الحالية. للقراءة بس." />
          <CardContent>
            <ul className="space-y-1.5 ps-5 text-sm leading-relaxed text-[var(--sys-foreground)]" data-rule-summary>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-note leading-relaxed text-[var(--sys-muted-foreground)]" data-rule-replaced>
              {RULE_REPLACED_LINE}
            </p>
          </CardContent>
        </Card>

        <DeskPeopleTable />

        <ConfirmationRuleEditor />

        <CallProofCard />
        <QueuePriorityCard />
        <QueueModesCard />
        <IntakeFilterCard />
        <WinbackV2Card />
        <LeadsV2Card />

      </div>
    </PageShell>
  );
}
