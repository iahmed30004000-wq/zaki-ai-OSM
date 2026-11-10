'use client';

import React from 'react';
import { CopyValue } from '@/components/orders/CopyValue';
import { barcodeToCopy } from '@/lib/copy-values';

/**
 * THE SMALL BUTTON THAT COPIES THE BARCODE — one tap to take it to the courier's own site, or to send it.
 *
 * It is the product's one copy button (`CopyValue`: the clipboard, then the old selection trick, the icon turning to a tick
 * on success) told three things about this value: the tooltip says WHICH value it holds, a copy the browser refuses is
 * handed to `onRefused` (the screen opens the value in a field to select by hand), and — the owner's words, 10/11 — a
 * parcel with NO barcode keeps the button in its place, OFF: dimmed, not pressable, «ما في باركود للشحنة» on it.
 *
 * It copies the barcode and nothing else. It used to turn into «انسخ المرجع» for a parcel with none; that copied what the
 * button beside the order number (`OrderRef`) already copies, and a button that changes what it holds from row to row is
 * one the girl has to read before she presses. The reference is still one tap away, where it always was.
 *
 * It writes nothing and asks nothing (the copy guards hold that for `CopyValue`). The same button is drawn in the desk's
 * column and as a line of the phone card, where it is a 44px target.
 */
export function ParcelCopy({
  row,
  onRefused,
}: {
  row: { trackingNumber?: string | null };
  onRefused: (value: string) => void;
}) {
  const barcode = barcodeToCopy(row.trackingNumber);
  return (
    <CopyValue
      text={barcode}
      noun="باركود الشحنة"
      shown={barcode}
      title="انسخ الباركود"
      whenEmpty="ما في باركود للشحنة"
      onRefused={onRefused}
    />
  );
}
