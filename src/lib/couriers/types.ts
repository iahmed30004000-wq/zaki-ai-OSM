import type { ShippingStatus } from '@/lib/shipping-workflow';

/**
 * The seam every courier integration plugs into.
 *
 * Today one courier is handled by a human typing a tracking number and
 * updating the status; LogesTechs would be a second implementation of THIS
 * interface and nothing else. Writing the boundary now is what stops the
 * first real integration from scattering courier-specific branches through
 * the shipment, tracking and settlement code.
 *
 * The rule that matters: a courier tells us what it observed, and we decide
 * what that means. No adapter writes an order status directly — it returns
 * events, the caller applies them through the normal transition machine.
 */

/**
 * «IT FAILED» AND «I DO NOT KNOW» ARE DIFFERENT ANSWERS.
 *
 * A refused request — bad phone, unknown city, wrong password — is a
 * failure whose outcome is KNOWN: nothing was created, and retrying is
 * free. A request that timed out is not: the courier may have made the
 * parcel and simply not told us in time. Retrying that one books a second
 * waybill for goods that already have one, and the first barcode becomes a
 * parcel nothing in here can name.
 *
 * Any adapter that cannot know marks its error, and whoever retries reads
 * the mark. A message string would do the same job until somebody rewords
 * it, so it is a property.
 */
export interface CourierOutcomeUnknown extends Error {
  outcomeUnknown: true;
}

/** Marks an error as «the courier may have done it anyway». */
export function markOutcomeUnknown(error: Error): CourierOutcomeUnknown {
  (error as CourierOutcomeUnknown).outcomeUnknown = true;
  return error as CourierOutcomeUnknown;
}

/** True when nobody can say whether the courier acted on the request. */
export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof Error && (error as Partial<CourierOutcomeUnknown>).outcomeUnknown === true;
}

export interface CourierShipmentRequest {
  orderId: string;
  merchantRef: string;
  codAmount: number;
  currencyCode: string;
  customer: {
    fullName: string;
    phone: string;
    /** The second number, so the courier's own waybill carries both, as ours does. */
    altPhone?: string | null;
    address: string;
    regionName: string | null;
  };
  pieces: number;
  note?: string | null;
  /**
   * The courier's OWN id for the destination.
   *
   * Agreed once per region and stored on the delivery-fee row. An adapter
   * that needs one (`needsCourierCityId`) is never called without it: the
   * name search it used to fall back to took the FIRST hit when several came
   * back, and a parcel addressed to the wrong governorate is found out about
   * when the driver calls.
   */
  cityId?: number;
}

export interface CourierShipmentResult {
  trackingNumber: string;
  /** Some couriers return their own label; we print ours when they do not. */
  labelUrl?: string | null;
  raw?: unknown;
}

export interface CourierEvent {
  trackingNumber: string;
  /** What the courier called it, kept verbatim for the audit trail. */
  rawStatus: string;
  occurredAt: Date;
  /**
   * Our status, or null when the courier's code is not one we recognise.
   * Null means "a human decides" — never a guess.
   */
  status: ShippingStatus | null;
  /** Present when the courier reports a partial or adjusted collection. */
  collectedAmount?: number | null;
  note?: string | null;
  raw?: unknown;
}

export interface CourierAdapter {
  /** Matches DeliveryProvider.code. */
  readonly code: string;
  readonly name: string;
  /** False for the manual adapter: nothing to call, nothing to poll. */
  readonly automated: boolean;
  /**
   * True when a shipment cannot be created without the courier's own id for
   * the destination region (stored per region on the delivery-fee row).
   * Dispatch refuses such an order BEFORE claiming it, with the region named.
   */
  readonly needsCourierCityId?: boolean;

  createShipment(req: CourierShipmentRequest): Promise<CourierShipmentResult>;
  fetchEvents(trackingNumbers: string[]): Promise<CourierEvent[]>;
  /**
   * Ask the company to cancel a parcel we created — resolving means YES.
   *
   * A refusal throws (the company's own words in the error), and a timeout
   * throws an error marked `outcomeUnknown`: the caller must change nothing
   * on either, because only a clear yes means the waybill is gone. Absent on
   * a courier nobody calls. See `courier-remote-cancel.ts`.
   */
  cancelShipment?(trackingNumber: string): Promise<void>;
  /** Courier status code → ours. Unknown codes MUST return null. */
  mapStatus(rawStatus: string): ShippingStatus | null;
}

/**
 * Statuses an automated courier feed may NEVER assert on its own.
 *
 * DELIVERED makes commission accrue and money expected. RETURNED reverses
 * it. PARTIALLY_DELIVERED needs the amount actually collected and which
 * lines came back, and only the person at the door knows that.
 *
 * A feed that guesses any of them — or an adapter that maps an unrecognised
 * code onto one — would move money on a string we do not understand. They
 * stay a human decision, taken on the screen, against the courier's own
 * statement.
 */
export const COURIER_CANNOT_ASSERT: ShippingStatus[] = [
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'RETURNED',
  'CANCELLED',
];

/** True when this event is safe to apply automatically. */
export function isAutoApplicable(event: CourierEvent): boolean {
  return event.status !== null && !COURIER_CANNOT_ASSERT.includes(event.status);
}
