import { describe, expect, it } from 'vitest';
import { parcelIdToCopy } from './copy-values';

/**
 * THE «الباركود» COLUMN'S ONE BUTTON: THE BARCODE, AND THE REFERENCE WHEN THERE IS NONE.
 *
 * The girls chasing a parcel paste its barcode into the courier's own site, or send it on. A company that hands out no
 * barcode, or a parcel not sent yet, has none — and the button is still there, holding the reference the same site can be
 * searched by: the merchant reference, else the order number (what the row prints as its number). Pure, so each edge is
 * a line: the marks a right-to-left line wraps around a number, the three kinds of nothing, and which of the two wins.
 */

const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0x00a0);

describe('a parcel with a barcode copies the barcode', () => {
  it('— as the courier wrote it, trimmed', () => {
    expect(parcelIdToCopy({ trackingNumber: ' KSA-2026-0148 ', merchantRef: 'M-7', orderNumber: 'ORD-1' })).toEqual({ kind: 'barcode', text: 'KSA-2026-0148' });
  });

  it('and not the reference — even when the reference is the longer, nicer thing to read', () => {
    expect(parcelIdToCopy({ trackingNumber: 'K1', merchantRef: 'SY-2026-0148', orderNumber: 'ORD-SY-2026-0148' }).text).toBe('K1');
  });

  it('and the invisible marks of a right-to-left line are not copied: pasted into a courier’s search box they find nothing', () => {
    expect(parcelIdToCopy({ trackingNumber: `${LRM}KSA77${RLM}`, orderNumber: 'ORD-1' })).toEqual({ kind: 'barcode', text: 'KSA77' });
    expect(parcelIdToCopy({ trackingNumber: `${NBSP}KSA77${NBSP}`, orderNumber: 'ORD-1' }).text).toBe('KSA77');
  });
});

describe('a parcel with none copies the reference', () => {
  it('— the merchant reference when the order has one', () => {
    expect(parcelIdToCopy({ trackingNumber: null, merchantRef: 'M-77', orderNumber: 'ORD-1' })).toEqual({ kind: 'reference', text: 'M-77' });
  });

  it('— else the order number, which is what the row prints as its number', () => {
    expect(parcelIdToCopy({ trackingNumber: null, merchantRef: null, orderNumber: 'ORD-1' })).toEqual({ kind: 'reference', text: 'ORD-1' });
    expect(parcelIdToCopy({ trackingNumber: undefined, orderNumber: 'ORD-2' })).toEqual({ kind: 'reference', text: 'ORD-2' });
  });

  it('— and "none" is every kind of nothing: null, an empty string, spaces, and marks that print as nothing', () => {
    for (const none of [null, undefined, '', '   ', `${LRM}${NBSP}${RLM}`]) {
      expect(parcelIdToCopy({ trackingNumber: none, merchantRef: 'M-1', orderNumber: 'ORD-1' }), JSON.stringify(none)).toEqual({ kind: 'reference', text: 'M-1' });
    }
  });

  it('— and a merchant reference that is only nothing falls through to the order number, never to an empty copy', () => {
    for (const none of ['', '  ', `${LRM}${RLM}`]) {
      expect(parcelIdToCopy({ trackingNumber: null, merchantRef: none, orderNumber: 'ORD-9' }), JSON.stringify(none)).toEqual({ kind: 'reference', text: 'ORD-9' });
    }
  });
});
