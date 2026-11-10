import { describe, expect, it } from 'vitest';
import * as copyValues from './copy-values';
import { barcodeToCopy } from './copy-values';

/**
 * THE BARCODE BUTTON COPIES THE BARCODE — AND A PARCEL WITH NONE COPIES NOTHING.
 *
 * The girls chasing a parcel paste its barcode into the courier's own site, or send it on. The button used to fall back to
 * the merchant reference, then the order number, for a parcel with none; the owner asked (10/11) for the button to be OFF
 * instead — the reference is copied by the button beside the order number, and a button that changes what it holds from row
 * to row has to be read before it is pressed. So «none» must be ONE thing, the empty string, whatever kind of nothing the
 * row held: that is exactly what the screen turns into the OFF button (`ParcelCopy`).
 */

const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const NBSP = String.fromCharCode(0x00a0);

describe('a parcel with a barcode copies the barcode', () => {
  it('— as the courier wrote it, trimmed', () => {
    expect(barcodeToCopy(' KSA-2026-0148 ')).toBe('KSA-2026-0148');
  });

  it('— and the invisible marks of a right-to-left line are not copied: pasted into a courier’s search box they find nothing', () => {
    expect(barcodeToCopy(`${LRM}KSA77${RLM}`)).toBe('KSA77');
    expect(barcodeToCopy(`${NBSP}KSA77${NBSP}`)).toBe('KSA77');
  });
});

describe('a parcel with none copies nothing', () => {
  it('— and "none" is every kind of nothing: null, undefined, an empty string, spaces, and marks that print as nothing', () => {
    for (const none of [null, undefined, '', '   ', `${LRM}${NBSP}${RLM}`]) {
      expect(barcodeToCopy(none), JSON.stringify(none)).toBe('');
    }
  });

  it('— and the old fallback is gone: no function builds a reference to copy in its place', () => {
    expect('parcelIdToCopy' in copyValues).toBe(false);
  });
});
