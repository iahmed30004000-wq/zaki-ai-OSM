'use client';

import React from 'react';
// The panel's door, asked the way the store's own tab strip asks it — for whether «الدفع» is a link or words.
import { useAppOptional } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { canOpenSection, findTab, readSection } from '@/lib/store-admin';

/**
 * WHERE THE FORM'S FIELDS COME FROM, UNDER THE BUTTON'S WORDS IN THE PAGE EDITOR.
 *
 * The store's «الدفع» answers them for every page the store sells through — said here, never a second copy of its
 * controls. The tab's name is a LINK only for whoever may open that panel, by the same answer the store's own tab
 * strip is drawn from (`canOpenSection`, asked with the client's `userCan`); anybody else reads it as plain words,
 * rather than being handed a door that answers «لا تملك صلاحية». A new tab, so the page being edited is not left
 * half-saved. Outside the dashboard's provider (a preview, a test) there is nobody to ask, so it says the words.
 */
export function StoreCheckoutNote() {
  const user = useAppOptional()?.currentUser ?? null;
  const mayOpen = user !== null && canOpenSection(user, readSection(findTab('front')!, 'look'), userCan);
  return (
    <p className="rounded-lg bg-[var(--sys-surface)] p-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
      الحقول اللي بتظهر وترتيبها وعلامة «إلزامي» ولون زر التأكيد بتيجي من تبويب «الدفع» بـ{' '}
      {mayOpen ? (
        <a href="/store?tab=front&amp;sec=look" target="_blank" rel="noopener noreferrer" className="font-bold text-[var(--sys-primary)] hover:underline">
          «القالب والألوان»
        </a>
      ) : (
        <span className="font-bold">«القالب والألوان»</span>
      )}
      . وإذا تركت النص هون «تأكيد الطلب»، الزر بياخد نص المتجر من هناك (إذا كاتبه).
    </p>
  );
}
