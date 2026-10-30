import type { CourierEvent } from './types';

/**
 * IS THE COURIER THERE AT ALL — THE FIRST CHUNK DECIDES.
 *
 * When every barcode of the first chunk (two or more) comes back as an error, the courier is down, or does not know
 * a single one of ten parcels, or has refused our account. None of those is ten lost parcels, and counting them as
 * misses would raise «مفقودة» alerts after three sweeps for parcels nobody has lost. The courier is skipped and named,
 * and nothing is recorded as missing. (It stays this way on purpose: a first chunk that is ALL «not found» is far more
 * likely a wrong address or account than ten parcels gone at once — measured against no real server, RV146.)
 *
 * What the error class adds is the SENTENCE: «unreachable» and «does not know any of them» ask the owner to look in
 * different places.
 */
const OUTAGE_MIN_ERRORS = 2;

/** True when this first chunk is an outage and not a list of individual misses. */
export function isAnOutage(chunk: CourierEvent[]): boolean {
  return chunk.length >= OUTAGE_MIN_ERRORS && chunk.every((e) => e.rawStatus === 'ERROR');
}

/** Why the courier is called unavailable, in a short Arabic phrase. Only meaningful when `isAnOutage(chunk)`. */
export function outageReason(chunk: CourierEvent[]): string {
  if (chunk.length > 0 && chunk.every((e) => e.errorClass === 'UNKNOWN_PARCEL')) {
    return `ردّت «غير موجود» على أول ${chunk.length} باركودات كلها`;
  }
  if (chunk.some((e) => e.errorClass === 'UNREACHABLE' || e.errorClass === undefined)) return 'لا تردّ';
  return 'رفضت الطلب أو الحساب';
}
