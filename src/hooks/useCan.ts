'use client';

import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';

/**
 * «DOES THE PERSON AT THE KEYBOARD HOLD THIS KEY?» — ASKED BY THE BUTTON THAT NEEDS IT.
 *
 * A control that is drawn and then refused is worse than one that is not
 * there: it reads as a broken system, not as a boundary, and the refusal
 * arrives in the server's words. The settings pages open on «عرض الإعدادات»
 * alone, so everybody who reached them was offered the sensitive buttons
 * (courier accounts, ad accounts, the AI key, the scheduled jobs) and only
 * the door said no.
 *
 * This is the same answer `userCan` gives everywhere (the server's own rule,
 * handed the effective keys on the session). It decides what to OFFER; the
 * door still decides what is ALLOWED.
 */
export function useCan(permission: string): boolean {
  const { currentUser } = useApp();
  return userCan(currentUser, permission);
}
