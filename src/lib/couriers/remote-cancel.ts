import { db } from '../db';
import { adapterFor, type CourierAdapter } from './index';
import { CourierRefusal } from './logestechs';

/**
 * TELLING THE COMPANY WE DO NOT WANT THE PARCEL — BEFORE WE FORGET ABOUT IT.
 *
 * A parcel sent by API exists TWICE: a row here and a waybill at the company.
 * Cancelling or postponing only the row leaves the company with a live
 * waybill for an order that is dead — a driver sent, a fee billed, a statement
 * line that matches nothing.
 *
 * So the order of events is fixed, and every cancel door goes through here:
 *
 *   1. the company is asked to cancel the barcode — OUTSIDE any database
 *      transaction (a call to somebody else's server can hang for thirty
 *      seconds, and holding locks while it does is how a warehouse stops);
 *   2. only on a clear YES does the caller clear the barcode and the claim
 *      and take the order off the trolley, in one conditional write;
 *   3. a refusal is shown in the company's own words, and nothing changes;
 *   4. an answer we never heard (a timeout, a dropped line) changes nothing
 *      either, and says so plainly: the parcel may or may not be cancelled
 *      there, and guessing in either direction is what costs money.
 *
 * It uses the adapter's own `call()` — the same path, the same `company-id`
 * header, the same timeout and the same scrubbing of the account's secrets
 * as creating the parcel did — and never a second HTTP client of its own.
 */

export type RemoteCancel =
  /** No barcode, or a courier nobody calls: there is nothing there to cancel. */
  | { kind: 'NOT_NEEDED' }
  /** A send is still in flight: the parcel may exist, and nobody can say yet. */
  | { kind: 'IN_FLIGHT' }
  | { kind: 'CANCELLED'; barcode: string; courier: string | null }
  | { kind: 'REFUSED'; said: string; courier: string | null }
  | { kind: 'UNKNOWN'; courier: string | null };

export const IN_TRANSIT_NOW_AR = 'الطرد قيد الترحيل الآن — لا تلغيه قبل ما تعرف إذا الشركة أنشأته.';

/** The sentence for an answer nobody heard. */
export function notSureAr(courier: string | null): string {
  return `لم يتأكد الإلغاء عند ${courier?.trim() || 'الشركة'} — لم يتغيّر شيء على الطلب. اسألهم هل ألغوا الطرد ثم جرّب.`;
}

/** The sentence for a refusal: their words, not ours. */
export function refusedAr(courier: string | null, said: string): string {
  return `${courier?.trim() || 'الشركة'} رفضت إلغاء الطرد: ${said || 'بلا سبب مذكور'}`;
}

export async function cancelAtCourier(
  input: {
    companyId: string;
    deliveryProviderId: string | null;
    trackingNumber: string | null;
    courierSendStartedAt: Date | string | null;
  },
  /** For tests: a double instead of the stored account. Never a real call from here. */
  inject?: { adapter?: CourierAdapter; courierName?: string | null }
): Promise<RemoteCancel> {
  if (!input.deliveryProviderId && !inject?.adapter) return { kind: 'NOT_NEEDED' };

  let adapter = inject?.adapter ?? null;
  let courier: string | null = inject?.courierName ?? null;
  if (!adapter) {
    const provider = await db.deliveryProvider.findFirst({
      where: { id: input.deliveryProviderId!, companyId: input.companyId },
      select: { name: true, code: true, adapterCode: true, apiEnabled: true, apiConfig: true, apiCredentials: true },
    });
    if (!provider) return { kind: 'NOT_NEEDED' };
    courier = provider.name;
    adapter = adapterFor(provider);
  }

  if (!adapter.automated || typeof adapter.cancelShipment !== 'function') return { kind: 'NOT_NEEDED' };

  // Claimed, never answered: we cannot cancel a barcode we do not have.
  if (!input.trackingNumber) {
    return input.courierSendStartedAt ? { kind: 'IN_FLIGHT' } : { kind: 'NOT_NEEDED' };
  }

  try {
    await adapter.cancelShipment(input.trackingNumber);
    return { kind: 'CANCELLED', barcode: input.trackingNumber, courier };
  } catch (e) {
    if (e instanceof CourierRefusal) return { kind: 'REFUSED', said: e.said, courier };
    // A timeout, or any other line that dropped: we do not know either way, so nothing changes.
    return { kind: 'UNKNOWN', courier };
  }
}
