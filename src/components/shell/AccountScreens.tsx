'use client';

import React, { useState } from 'react';
import { useApp } from '@/context/AppContext';
import { signOut } from '@/lib/sign-out';
import { RiLockLine, RiLogoutBoxLine, RiMailCheckLine, RiRefreshLine, RiTimerLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';

/** Account-state screens for PENDING / SUSPENDED / DISABLED users. */

export function PendingScreen() {
  const { currentUser, refreshUser } = useApp();
  const [checking, setChecking] = useState(false);

  const handleLogout = () => signOut('manual');

  return (
    <div className="min-h-screen bg-[var(--sys-surface)] flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-lg bg-[var(--sys-card)] rounded-lg shadow-raised p-8 text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] flex items-center justify-center">
          <RiTimerLine className="w-6 h-6 text-[var(--sys-destructive)]" />
        </div>

        <PageHeader title="الحساب بانتظار موافقة المدير"
          /* `description` is a STRING rendered as text (PageHeader.tsx), so the
             tags that were written into it were printed to the person
             verbatim — `<strong className=...>` and `<br />` shown on the
             screen of somebody who has just registered. */
          description={`تم إنشاء حسابك بنجاح (${currentUser?.email ?? ''}) وهو الآن بانتظار موافقة المدير. سيتم منحك صلاحيات الوصول بعد أن يقوم المدير بتعيين دور حسابك وتنشيطه.`}
        />

        <div className="bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg p-4 text-note text-[var(--sys-muted-foreground)] space-y-1">
          <p className="flex items-center justify-center space-x-2 rtl:space-x-reverse text-[var(--sys-heading)]">
            <RiMailCheckLine className="w-4 h-4 text-[var(--sys-warning)]" />
            <span>حالتك الحالية: قيد المراجعة (PENDING)</span>
          </p>
          <p>لن تتمكن من الوصول للطلبات أو العملاء أو المنتجات أو التقارير حتى يتم تنشيط حسابك.</p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* `checking` is this screen's own flag (it spins the icon): the press returns nothing, so the kit adds no
              second lock and the reload still follows the refresh exactly as before. */}
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void (async () => {
                setChecking(true);
                await refreshUser();
                setChecking(false);
                window.location.reload();
              })();
            }}
          >
            <RiRefreshLine className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            <span>تحديث الحالة</span>
          </Button>
          <Button type="button" variant="danger" onClick={handleLogout}>
            <RiLogoutBoxLine className="icon-mirror w-4 h-4" />
            <span>تسجيل الخروج</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * AN ACTIVE ACCOUNT WITH NOTHING IT MAY OPEN.
 *
 * Not «pending» — the account works and has been approved — and not an
 * error: the manager simply has not given it a role that reaches a screen.
 * It says that, and offers the two things a person can do about it: ask,
 * and look again after they have asked.
 *
 * The card is PendingScreen's, class for class. The stylesheet is capped to
 * the byte, and a new screen that needed three new utilities would have
 * been refused by the build for a reason that has nothing to do with it.
 */
export function NoAccessScreen() {
  const { currentUser } = useApp();
  return (
    <div className="min-h-screen bg-[var(--sys-surface)] flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-lg bg-[var(--sys-card)] rounded-lg shadow-raised p-8 text-center space-y-6">
        <div className="mx-auto w-16 h-16 rounded-lg bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] flex items-center justify-center">
          <RiLockLine className="w-6 h-6 text-[var(--sys-destructive)]" />
        </div>

        <PageHeader title="لا توجد شاشة متاحة لحسابك"
          description={`حسابك (${currentUser?.email ?? ''}) فعّال، لكنه لا يملك صلاحية فتح أي شاشة حالياً. اطلب من المدير أن يعيّن لحسابك دوراً، ثم اضغط «تحديث».`}
        />

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
            <RiRefreshLine className="w-4 h-4" />
            <span>تحديث</span>
          </Button>
          <Button type="button" variant="danger" onClick={() => signOut('manual')}>
            <RiLogoutBoxLine className="icon-mirror w-4 h-4" />
            <span>تسجيل الخروج</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
