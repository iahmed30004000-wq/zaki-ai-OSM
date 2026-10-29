import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';
import { withFrom, type OrderSnapshot } from '@/lib/change-request-fields';

/**
 * ط47 (the readers the first pass missed) — THE AGENT SEES, AND CONFIRMS, THE ADDRESS THE PARCEL GOES TO.
 *
 * A returning customer who typed a new street on a landing page has it on the ORDER (`deliveryAddress`); the customer
 * row keeps the first one ever given. The waybill and the courier read the order's first, but the confirmation desk,
 * the pull, the «before» of an address change request and the assistant's «is there an address» still read the
 * customer's alone — so the agent confirmed the OLD street on the phone and the parcel went to the new one.
 *
 * «اي قرار بعد الان اتخذو دون الرجوع الي» — decided: the order's own address first everywhere an address is READ; the
 * assistant still receives no address text, only whether one exists.
 */

const src = (p: string) => stripComments(repoFile(p));

const snapshot = (deliveryAddress: string | null): OrderSnapshot => ({
  quantity: 1, productId: 'p', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: 'r',
  deliveryAddress,
  customer: { fullName: 'a', phone: '1', altPhone: null, address: 'العنوان القديم', city: 'c' },
});

describe('the desk and the pull', () => {
  it('both read the order\'s own address', () => {
    expect(src('src/app/api/confirmation/mine/route.ts')).toContain('deliveryAddress: true');
    expect(src('src/app/api/confirmation/pull/route.ts')).toContain('deliveryAddress: true');
  });

  it('the card shows it before the customer\'s, and a response without it still draws', () => {
    const s = src('src/components/screens/ConfirmationMineScreen.tsx');
    expect(s).toContain('{order.deliveryAddress ?? order.customer.address}');
    expect(s).toContain('deliveryAddress?: string | null;');
  });
});

describe('the «before» of an address change', () => {
  it('is the address the parcel goes to', () => {
    const out = withFrom(snapshot('العنوان الجديد'), { customerAddress: 'شارع ثالث' } as never) as Record<string, { from: unknown }>;
    expect(out.customerAddress.from).toBe('العنوان الجديد');
  });

  it('NEGATIVE: an order with no address of its own says the customer\'s, as before', () => {
    const out = withFrom(snapshot(null), { customerAddress: 'شارع ثالث' } as never) as Record<string, { from: unknown }>;
    expect(out.customerAddress.from).toBe('العنوان القديم');
  });

  it('and the door that builds the snapshot reads the column', () => {
    expect(src('src/app/api/orders/[id]/change-requests/route.ts')).toContain('deliveryAddress: true,');
  });
});

describe('the assistant', () => {
  const route = () => src('src/app/api/ai/confirmation/route.ts');

  it('knows whether an address exists from the order\'s own first', () => {
    expect(route()).toContain('hasAddress: !!(order.deliveryAddress ?? order.customer?.address)?.trim(),');
  });

  it('NEGATIVE: no address TEXT is put in the payload (customer data stays off an outside model)', () => {
    const r = route();
    expect(r).not.toMatch(/\baddress:\s*(?:local|order\.)/);
    expect(r).not.toContain('deliveryAddress: order.');
  });
});
