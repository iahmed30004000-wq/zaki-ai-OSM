'use client';

import React from 'react';
import { CopyValue } from '@/components/orders/CopyValue';
import { phoneToCopy } from '@/lib/copy-values';

/**
 * THE CUSTOMER'S PHONE, WRITTEN ON THE ROW, WITH THE SMALL BUTTON THAT COPIES IT (the owner, 10/11: «لازم تظهر رقم التلفون»).
 *
 * The girl chasing a parcel rings, messages, or pastes the number into another app. The number used to be behind the three
 * contact buttons and nowhere to read. It is printed here exactly as the row holds it, left-to-right, and the copy button
 * hands over what a dialler is given (`phoneToCopy`: Latin digits, no invisible marks) — the one button of the product
 * (`CopyValue`), so it writes nothing, asks nothing, and counts for nothing: a copy is not a call, and the contact log is
 * written only by the call buttons themselves.
 *
 * A row with no phone draws a dash and no button. `onRefused` is the screen's: a copy the browser refuses opens the value
 * in a field to select by hand.
 */
export function ParcelPhone({
  phone,
  onRefused,
}: {
  phone: string | null | undefined;
  onRefused: (value: string) => void;
}) {
  const shown = (phone ?? '').trim();
  return (
    <span className="inline-flex items-center gap-1">
      <span dir="ltr" className="tabular-nums text-[var(--sys-foreground)]">
        {shown || '—'}
      </span>
      <CopyValue text={phoneToCopy(phone)} noun="رقم هاتف الزبون" onRefused={onRefused} />
    </span>
  );
}
