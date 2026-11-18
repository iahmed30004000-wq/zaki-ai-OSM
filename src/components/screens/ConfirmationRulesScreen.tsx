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
import { NoAnswerRoundsCard } from '@/components/settings/NoAnswerRoundsCard';
import { NoAnswerReturnsCard } from '@/components/settings/NoAnswerReturnsCard';

/**
 * «قواعد مركز التأكيد» — THE ONE PAGE OF THE CONFIRMATION RULES (the owner's plan of 17/11, request C1).
 *
 * The eight cards of these rules used to sit among the company's own settings on «إعدادات النظام», two screens away from the desk they govern, and three of them
 * contradicted each other. They are here now, UNCHANGED as components (each still reads and writes its own door and asks its own key), under a short box that says
 * what the rule is in one reading. «/settings/system» keeps the company's name, the score, the deductions, the offer after the order, the clean-line settlement
 * and the partners — and none of these eight.
 *
 * The two OLD cards («نظام الجولات» and «الطلب يرجع للطابور فوراً») are not removed here: they are the rollback path of the one rule above, and they leave with their engine
 * in the next change. They stand together at the bottom under their own heading, which says that.
 *
 * `lines` is the box's text, written on the server from the constants and the switches the engine reads (`confirmation-rule-summary.ts`) — this screen decides nothing and types no number.
 */
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
          </CardContent>
        </Card>

        <CallProofCard />
        <QueuePriorityCard />
        <QueueModesCard />
        <IntakeFilterCard />
        <WinbackV2Card />
        <LeadsV2Card />

        <section className="space-y-4" aria-labelledby="old-rules-heading">
          <div>
            <h2 id="old-rules-heading" className="text-base font-bold text-[var(--sys-heading)]">
              قواعد قديمة — بتنشال بالتحديث الجاي
            </h2>
            <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
              القاعدة الوحدة اللي فوق هي اللي بتحكم لما «إثبات المكالمات وجدول المحاولات» يكون شغّال. هدول الاتنين بيضلّوا طريق الرجوع لو طفّيته.
            </p>
          </div>
          <NoAnswerRoundsCard />
          <NoAnswerReturnsCard />
        </section>
      </div>
    </PageShell>
  );
}
