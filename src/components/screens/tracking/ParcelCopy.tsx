'use client';

import React from 'react';
import { CopyValue } from '@/components/orders/CopyValue';
import { parcelIdToCopy } from '@/lib/copy-values';

/**
 * THE COPY BUTTON OF THE «الباركود» COLUMN — one tap to take the barcode to the courier's own site, or to send it.
 *
 * It is the product's one copy button (`CopyValue`: the clipboard, then the old selection trick, the icon turning to a tick
 * on success) told two things about this column: the tooltip says WHICH value it holds, and a copy the browser refuses is
 * handed to `onRefused` — the screen opens the value in a field to select by hand. What is copied is decided in
 * `copy-values.ts` (`parcelIdToCopy`): the barcode, and for a parcel with none the reference — so the button is there on
 * every row, and says «انسخ المرجع» when it is the reference it holds.
 *
 * It writes nothing and asks nothing (the copy guards hold that for `CopyValue`). `label` gives it words beside the icon:
 * the phone card has no column for the barcode and no hover to read a tooltip on, so there the button speaks.
 */
export function ParcelCopy({
  row,
  label = false,
  onRefused,
}: {
  row: { trackingNumber?: string | null; merchantRef?: string | null; orderNumber: string };
  /** Words beside the icon (the phone card). Without them the button is the icon alone (the desk's column). */
  label?: boolean;
  onRefused: (value: string) => void;
}) {
  const copy = parcelIdToCopy(row);
  const barcode = copy.kind === 'barcode';
  const words = barcode ? 'انسخ الباركود' : 'انسخ المرجع';
  return (
    <CopyValue
      text={copy.text}
      noun={barcode ? 'باركود الشحنة' : 'مرجع الطلب'}
      shown={copy.text}
      title={words}
      label={label ? words : undefined}
      onRefused={onRefused}
    />
  );
}
