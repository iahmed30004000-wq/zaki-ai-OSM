import type { LabelView } from './label-sheet';

/**
 * THE MADE-UP ORDERS THE PREVIEW OF A NEW DESIGN SHOWS — no customer of any store is ever read for a preview.
 * Two, because the designs draw two things: one product (the big count, a drawing per piece, the offer ticket) and
 * several (a count box per line, a variant, an add-on).
 */
const WHO = {
  courier: 'شركة الشحن',
  name: 'اسم الزبون',
  phones: ['0900000000'],
  place: 'المحافظة — المنطقة، الشارع',
  note: 'ملاحظة الزبون على الطلب',
  cod: '0.00',
} as const;

export const DESIGN_SAMPLES: readonly Omit<LabelView, 'qrSvg'>[] = [
  {
    ...WHO,
    phones: [...WHO.phones],
    orderId: 'preview-1',
    ref: 'SY-10001',
    courierCode: 'SY-10001',
    items: [{ name: 'المنتج الأول', qty: 3 }],
    parcel: { lines: [{ name: 'المنتج الأول', qty: 3, shape: 'bottle', main: true }], offer: 'قطعتين + قطعة هدية' },
  },
  {
    ...WHO,
    phones: [...WHO.phones],
    orderId: 'preview-2',
    ref: 'SY-10002',
    courierCode: 'SY-10002',
    items: [{ name: 'المنتج الأول', qty: 2 }, { name: 'المنتج الثاني', qty: 1, addOn: true }],
    parcel: {
      lines: [
        { name: 'المنتج الأول', variant: 'اللون والمقاس', qty: 2, shape: 'clothing', main: true },
        { name: 'المنتج الثاني', qty: 1, shape: 'jar', addOn: true },
      ],
      offer: 'قطعتين بسعر خاص',
    },
  },
];
