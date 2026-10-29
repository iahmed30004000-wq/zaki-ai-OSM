import { describe, expect, it, vi } from 'vitest';
import { LogesTechsAdapter, COMPANY_HEADER } from './couriers/logestechs';
import { manualAdapter } from './couriers/manual';
import { cancelAtCourier, notSureAr, refusedAr } from './courier-remote-cancel';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * CANCELLING A PARCEL AT THE COMPANY — THE SAME PATH THAT CREATED IT.
 *
 * A parcel sent by API exists twice. Cancelling our row and not theirs leaves
 * a live waybill for a dead order, so the company is asked first — through the
 * adapter's own `call()` (the `company-id` header, the timeout, the scrubbing
 * of the account's secrets), outside any transaction. Only a clear YES lets the
 * order change; a refusal shows their words; an answer nobody heard changes
 * nothing and says so.
 *
 * NO NETWORK: a fetch double records what would have left the building. These
 * tests never reach a real company.
 * ═══════════════════════════════════════════════════════════════════════
 */

const PASSWORD = 'pa"ss-Secret-9';

const adapterWith = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new LogesTechsAdapter({
    email: 'shop-owner@example.com',
    password: PASSWORD,
    companyId: 744,
    sender: { name: 'متجر', phone: '0790000000' },
    origin: { addressLine1: 'Main Street', cityId: 36237 },
    courierName: 'الباشا',
    fetchImpl,
    ...over,
  });

interface Seen { method: string; url: string; headers: Record<string, string>; body: string | undefined }
function recorder(reply: Response | ((init: RequestInit) => Promise<Response>)) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({
      method: String(init.method),
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return typeof reply === 'function' ? reply(init) : reply.clone();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const parcel = (over: Record<string, unknown> = {}) => ({
  companyId: 'c1', deliveryProviderId: 'p1', trackingNumber: 'KSA1', courierSendStartedAt: new Date(), ...over,
});

describe('a clear yes', () => {
  it('goes out as the adapter’s own cancel call: PUT, the barcode, and the company id header', async () => {
    const { seen, fetchImpl } = recorder(new Response('{}', { status: 200 }));

    const out = await cancelAtCourier(parcel(), { adapter: adapterWith(fetchImpl), courierName: 'الباشا' });

    expect(out).toEqual({ kind: 'CANCELLED', barcode: 'KSA1', courier: 'الباشا' });
    expect(seen).toHaveLength(1);
    expect(`${seen[0].method} ${new URL(seen[0].url).pathname}`).toBe('PUT /api/guests/744/packages/cancel');
    expect(new URL(seen[0].url).searchParams.get('barcode')).toBe('KSA1');
    // The same tenant header as creating the parcel — the call that was once refused as «رقم تعريف الشركة غير صحيح».
    expect(seen[0].headers[COMPANY_HEADER]).toBe('744');
  });
});

describe('a refusal', () => {
  it('shows THEIR words, scrubbed of the account’s own secrets', async () => {
    const { fetchImpl } = recorder(
      new Response(JSON.stringify({ error: `الطرد مع السائق ${PASSWORD}` }), { status: 400 })
    );

    const out = await cancelAtCourier(parcel(), { adapter: adapterWith(fetchImpl), courierName: 'الباشا' });

    expect(out.kind).toBe('REFUSED');
    if (out.kind !== 'REFUSED') return;
    expect(out.said).toContain('الطرد مع السائق');
    expect(out.said, 'كلمة سر الحساب خرجت في رسالة').not.toContain(PASSWORD);
    expect(refusedAr(out.courier, out.said)).toBe(`الباشا رفضت إلغاء الطرد: ${out.said}`);
  });
});

describe('an answer nobody heard', () => {
  it('a timeout is UNKNOWN — and the sentence says the cancel was not confirmed', async () => {
    const silent = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const { fetchImpl } = recorder(silent);

    const out = await cancelAtCourier(parcel(), { adapter: adapterWith(fetchImpl, { timeoutMs: 30 }), courierName: 'الباشا' });

    expect(out).toEqual({ kind: 'UNKNOWN', courier: 'الباشا' });
    expect(notSureAr('الباشا')).toBe('لم يتأكد الإلغاء عند الباشا — لم يتغيّر شيء على الطلب. اسألهم هل ألغوا الطرد ثم جرّب.');
  });

  it('a dropped line is UNKNOWN too — never a yes', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const out = await cancelAtCourier(parcel(), { adapter: adapterWith(fetchImpl), courierName: 'الباشا' });

    expect(out.kind).toBe('UNKNOWN');
  });
});

describe('when there is nothing to cancel there', () => {
  it('a manual courier is never called', async () => {
    const out = await cancelAtCourier(parcel(), { adapter: manualAdapter });
    expect(out).toEqual({ kind: 'NOT_NEEDED' });
  });

  it('a courier with no provider on the order is never called', async () => {
    expect(await cancelAtCourier(parcel({ deliveryProviderId: null }))).toEqual({ kind: 'NOT_NEEDED' });
  });

  it('a send that was claimed and never answered cannot be cancelled by a barcode we do not have', async () => {
    const { seen, fetchImpl } = recorder(new Response('{}', { status: 200 }));

    const out = await cancelAtCourier(parcel({ trackingNumber: null }), { adapter: adapterWith(fetchImpl) });

    expect(out).toEqual({ kind: 'IN_FLIGHT' });
    expect(seen, 'اتُّصل بالشركة بلا باركود').toHaveLength(0);
  });

  it('and no claim, no barcode: nothing to do, nobody called', async () => {
    const { seen, fetchImpl } = recorder(new Response('{}', { status: 200 }));

    const out = await cancelAtCourier(parcel({ trackingNumber: null, courierSendStartedAt: null }), { adapter: adapterWith(fetchImpl) });

    expect(out).toEqual({ kind: 'NOT_NEEDED' });
    expect(seen).toHaveLength(0);
  });
});

describe('the seam', () => {
  it('cancelShipment is part of the adapter interface, optional, and LogesTechs fulfils it', () => {
    const adapter: import('./couriers/types').CourierAdapter = adapterWith(recorder(new Response('{}')).fetchImpl);
    expect(typeof adapter.cancelShipment).toBe('function');
    // The courier nobody calls simply does not have one.
    expect((manualAdapter as import('./couriers/types').CourierAdapter).cancelShipment).toBeUndefined();
  });
});
