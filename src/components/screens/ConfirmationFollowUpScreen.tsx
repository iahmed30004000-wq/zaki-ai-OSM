'use client';

import React, { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { routeLabel } from '@/lib/route-registry';
import { Tabs } from '@/components/ui/Tabs';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { ConfirmationPostponedScreen } from '@/components/screens/ConfirmationPostponedScreen';
import { WinbackScreen } from '@/components/screens/WinbackScreen';
import { WinbackDaily } from '@/components/screens/WinbackDaily';
import { LeadsLane } from '@/components/screens/LeadsLane';

/**
 * /confirmation/follow-up — «المتابعة»: THE ORDERS TO CALL AGAIN LATER, IN TWO KINDS.
 *
 * «الطلبات المؤجلة» and «استرجاع الملغى» were two paged lists built from the same
 * kit, and both mean «call this customer again later». The owner (24/10) kept
 * both lists but wanted the difference to be impossible to miss, so they are two
 * tabs of one screen, named for what they ARE:
 *
 *   · «مؤجلة» — orders somebody promised to call back (a day set by the customer);
 *   · «ملغاة سابقاً» — orders that were cancelled for a reason that fades with time
 *     or price, offered again with a new price.
 *
 * It is the SUPERVISOR's screen (`confirmation.supervise`): the postponed tab
 * carries the filter by agent, and the other kind is a discount, which is money.
 * An agent sees HER postponed orders as a tab of «طلباتي» — the same component,
 * drawn there — so nobody is shown the same list twice.
 *
 * Nothing about either list changed: the same components, the same doors
 * (`/api/confirmation/postponed`, `/api/confirmation/winback`) and the same
 * permission each of them asks. Only where they are drawn.
 */

type Tab = 'postponed' | 'winback';

export function ConfirmationFollowUpScreen() {
  const { currentUser } = useApp();
  // The win-back door asks `confirmation.supervise` itself; the tab is drawn only for
  // who can use it, so a person is never offered a list that answers 403.
  const mayWinback = userCan(currentUser, 'confirmation.supervise');
  const asked = useSearchParams().get('tab');
  const [tab, setTab] = useState<Tab>(asked === 'winback' && mayWinback ? 'winback' : 'postponed');

  const tabs = [
    { key: 'postponed', label: 'مؤجلة' },
    ...(mayWinback ? [{ key: 'winback', label: 'ملغاة سابقاً' }] : []),
  ];

  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title={routeLabel('/confirmation/follow-up')} />
      {/* the pages system's leads (step E2): its own door, drawn only when the owner turned «ليدز الصفحات» on and there is a lead waiting */}
      <LeadsLane />
      <Tabs tabs={tabs} value={tab} onChange={(k) => setTab(k as Tab)} />
      {tab === 'postponed' ? (
        <ConfirmationPostponedScreen embedded />
      ) : (
        <>
          {/* the daily list of step F1: its own door, drawn only when the owner turned it on — and then nothing below it changes */}
          <WinbackDaily />
          <WinbackScreen embedded />
        </>
      )}
    </div>
  );
}
