import type { ShippingStatus } from '@/lib/shipping-workflow';
import { limitFor, paced } from '../outbound-limit';
import { markOutcomeUnknown } from './types';
import type {
  CourierAdapter,
  CourierEvent,
  CourierShipmentRequest,
  CourierShipmentResult,
} from './types';

/**
 * LogesTechs.
 *
 * Built from their API documentation (v. 9-6-2026). Base URL
 * https://apisv2.logestechs.com/api, and authentication is the account's
 * email and password sent in each request body rather than a token, which
 * is why the credentials live in config and never in the database rows this
 * adapter touches.
 *
 * Endpoints used:
 *   POST /ship/request/by-email          create a shipment
 *   GET  /addresses/cities               cityId for an address
 *   GET  /guests/packages/status         one package's status
 *   POST /guests/{companyId}/packages/pdf   the AWB labels
 *   PUT  /guests/{companyId}/packages/cancel?barcode=
 *
 * Their `cod` is the amount INCLUDING delivery, and `invoiceNumber` is the
 * merchant's own order number — which is our merchantRef, and the key
 * matching reads back off their statement.
 */

export interface LogesTechsConfig {
  baseUrl?: string;
  email: string;
  password: string;
  /** Their numeric company id: the guest-scoped paths, the pacing key, and the `company-id` header on every request. */
  companyId: number;
  /** Ids their account was set up with; sent as-is. */
  serviceTypeId?: number;
  vehicleTypeId?: number;
  parcelTypeId?: number;
  /** Their documentation marks these required on every shipment. */
  sender: { name: string; phone: string; businessName?: string };
  /** Where parcels are collected from. */
  origin: { addressLine1: string; addressLine2?: string; cityId: number };
  fetchImpl?: typeof fetch;
  /** Milliseconds before a request is abandoned. See DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The courier's own display name («الباشا»), so a refusal reads as «الباشا رفض: …». */
  courierName?: string;
}

const DEFAULT_BASE = 'https://apisv2.logestechs.com/api';

/**
 * THE ADDRESS EVERY REQUEST STARTS WITH — NEVER EMPTY.
 *
 * The settings screen says «رابط الـAPI (اتركه فارغاً للافتراضي)», and a box left empty is saved as `''`, not as
 * nothing. `'' ?? DEFAULT_BASE` is `''`, so every request went out as a bare path — «Failed to parse URL from
 * /ship/request/by-email» on every parcel of a batch, and on the city lookup before it. Blank means the official
 * address; an address typed without its scheme gets `https://`; anything that still is not an absolute http(s)
 * address falls back to the official one rather than sending a request that cannot leave the building.
 */
export function logesTechsBase(raw: string | null | undefined): string {
  const typed = (raw ?? '').trim();
  if (!typed) return DEFAULT_BASE;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_BASE;
    return withScheme.replace(/\/+$/, '');
  } catch {
    return DEFAULT_BASE;
  }
}

/**
 * NO REQUEST WAITS FOREVER.
 *
 * `fetch` has no timeout of its own: a server that accepts the connection
 * and then says nothing holds the caller until the socket dies, which on a
 * healthy network can be minutes. This is a courier's server, reached while
 * an operator stands at a screen and — worse — on paths that run inside a
 * database transaction, where a hung call holds locks open behind it.
 *
 * Thirty seconds is chosen against their own slowest observed answer, the
 * city lookup, and is long enough that a merely slow reply still arrives.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A status question gives up sooner. It runs sixty at a time on the worker every two minutes, and one silent server
 * at thirty seconds a barcode held every other job behind it for half an hour. A late answer is asked again in two
 * minutes; a late CREATE is the one that must wait.
 */
export const STATUS_TIMEOUT_MS = 10_000;

/**
 * THE TENANT HEADER — INFERRED, NOT DOCUMENTED.
 *
 * LogesTechs is one server for many courier companies (every answer carries a "companyId"), and a create by e-mail
 * cannot know which company the e-mail belongs to unless the request says so. Their API document lists NO request
 * headers at all; this one is inferred from their own refusal («رقم تعريف الشركة غير صحيح» on every create while the
 * configured id only reached two guest paths) and from how their platform family names the tenant. It is sent on every
 * call, and is harmless where the server ignores it. The proof is the first real dispatch, not this file.
 */
export const COMPANY_HEADER = 'company-id';

/**
 * A REFUSAL WE CAN ASK QUESTIONS OF.
 *
 * `message` is the sentence a screen shows; `said` is the courier's own words, trimmed and with any credential
 * scrubbed out; `status` is the HTTP code. The request body is never part of any of them.
 */
export class CourierRefusal extends Error {
  constructor(message: string, readonly status: number, readonly said: string) {
    super(message);
    this.name = 'CourierRefusal';
  }
}

/**
 * A TIMED-OUT WRITE IS NOT A FAILED WRITE.
 *
 * When a POST times out, the parcel may well have been created — we simply
 * never heard. Anything that retries on failure must be able to tell this
 * apart from a refusal, or it books a second waybill for one parcel. The
 * prefix is the seam: `courier-dispatch` reads it and stops.
 */
export const TIMEOUT_PREFIX = 'LOGESTECHS_TIMEOUT';

/**
 * Their status codes, copied from the documentation's own table.
 *
 * Mapped to ours ONLY where the meaning is unambiguous. Everything about a
 * driver being assigned, rejecting, or a parcel sitting on a shelf is their
 * internal handling — it does not change where the parcel is from our side,
 * so those return null and nothing is applied automatically.
 *
 * DELIVERED_TO_RECIPIENT and RETURNED_BY_RECIPIENT map to our terminal
 * states, but the seam refuses to apply those automatically anyway
 * (COURIER_CANNOT_ASSERT): a person confirms them against the statement,
 * because those two decide whether money is owed.
 */
export const LOGESTECHS_STATUS: Record<string, ShippingStatus | null> = {
  PENDING_CUSTOMER_CARE_APPROVAL: 'READY_FOR_PICKUP',
  APPROVED_BY_CUSTOMER_CARE_AND_WAITING_FOR_DISPATCHER: 'READY_FOR_PICKUP',
  ASSIGNED_TO_DRIVER_AND_PENDING_APPROVAL: 'READY_FOR_PICKUP',
  ACCEPTED_BY_DRIVER_AND_PENDING_PICKUP: 'READY_FOR_PICKUP',
  REJECTED_BY_DRIVER_AND_PENDING_MANGEMENT: null, // their internal reassignment
  SCANNED_BY_DRIVER_AND_IN_CAR: 'OUT_FOR_DELIVERY', // "Picked" — بالمركبة
  MOVED_TO_SHELF_AND_OUT_OF_HANDLER_CUSTODY: 'SHIPPED',
  OPENED_ISSUE_AND_WAITING_FOR_MANAGEMENT: null, // an exception; a human reads it
  POSTPONED_DELIVERY: 'FAILED_DELIVERY', // مؤجلة — an attempt that did not land
  DELIVERED_TO_RECIPIENT: 'DELIVERED',
  RETURNED_BY_RECIPIENT: 'RETURNED',
  DELIVERED_TO_SENDER: 'RETURNED', // back in our hands
  CANCELLED: 'CANCELLED',
  COMPLETED: null, // their bookkeeping close, not a delivery fact
  // Stage 9 landed the state, so their code maps now. It still never
  // applies itself: a partial needs the amount actually collected and which
  // lines came back, and only the person at the door knows that.
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  SWAPPED: null,
  BROUGHT: null,
  TRANSFERRED_OUT: null, // handed to a partner — still in transit, not ours to call
  EXPORTED_TO_THIRD_PARTY: null,
};

/** Arabic names as their documentation writes them, for the audit trail. */
export const LOGESTECHS_STATUS_AR: Record<string, string> = {
  PENDING_CUSTOMER_CARE_APPROVAL: 'طلبات جديدة',
  APPROVED_BY_CUSTOMER_CARE_AND_WAITING_FOR_DISPATCHER: 'بانتظار تعيين سائق',
  CANCELLED: 'ملغاة',
  ASSIGNED_TO_DRIVER_AND_PENDING_APPROVAL: 'بانتظار موافقة سائق',
  REJECTED_BY_DRIVER_AND_PENDING_MANGEMENT: 'رفضها السائق',
  ACCEPTED_BY_DRIVER_AND_PENDING_PICKUP: 'بانتظار التحميل',
  SCANNED_BY_DRIVER_AND_IN_CAR: 'بالمركبة',
  DELIVERED_TO_RECIPIENT: 'تم التوصيل',
  POSTPONED_DELIVERY: 'مؤجلة',
  RETURNED_BY_RECIPIENT: 'تم ارجاعها',
  COMPLETED: 'مغلقة',
  TRANSFERRED_OUT: 'مصدرة لشريك',
  PARTIALLY_DELIVERED: 'تم توصيلها بشكل جزئي',
  SWAPPED: 'تم تبديلها',
  BROUGHT: 'تم احضارها',
  DELIVERED_TO_SENDER: 'مسلمة الى المرسل',
  EXPORTED_TO_THIRD_PARTY: 'مصدرة الى طرف ثالث',
};

/**
 * First word / the rest, for their example's two-field form.
 *
 * Arabic names do not split into "first" and "last" the way the field names
 * assume — «محمد عبد الله الكسواني» has no surname slot. Taking the first
 * word and leaving the remainder whole keeps the full name readable on the
 * label however they choose to join it back up, which is what the driver at
 * the door actually needs.
 */
export function splitName(full: string): { receiverFirstName: string; receiverLastName: string } {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { receiverFirstName: '', receiverLastName: '' };
  if (parts.length === 1) return { receiverFirstName: parts[0], receiverLastName: parts[0] };
  return { receiverFirstName: parts[0], receiverLastName: parts.slice(1).join(' ') };
}

export class LogesTechsAdapter implements CourierAdapter {
  readonly code = 'LOGESTECHS';
  readonly name = 'LogesTechs';
  readonly automated = true;
  // Their API addresses a parcel by their city id, nothing else ("الـ API مع الـ id تبع المناطق").
  readonly needsCourierCityId = true;

  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly timeoutMs: number;

  constructor(readonly config: LogesTechsConfig) {
    this.base = logesTechsBase(config.baseUrl);
    this.http = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get auth() {
    return { email: this.config.email, password: this.config.password };
  }

  /**
   * The courier's words with the account's own secrets taken out. A server that answers 400 by echoing the request it
   * was sent would otherwise carry the password into a screen, an audit row and a log line.
   */
  private scrub(text: string): string {
    let out = text;
    for (const secret of [this.config.password, this.config.email]) {
      if (!secret || secret.length < 3) continue;
      // Once as written, once as it looks inside a JSON string.
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join('***');
    }
    return out;
  }

  /**
   * A refusal as a sentence: `{"error":"…"}` becomes «الباشا رفض: … (400)»; any other body stays «LogesTechs 400: …».
   */
  private refusal(status: number, text: string): CourierRefusal {
    let said = '';
    try {
      const parsed: unknown = JSON.parse(text);
      const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
      if (typeof error === 'string' && error.trim()) said = this.scrub(error).trim().slice(0, 300);
    } catch {
      /* not JSON — the plain form below */
    }
    if (said) {
      const who = this.config.courierName?.trim();
      return new CourierRefusal(`${who ? `${who} رفض` : 'الشركة رفضت'}: ${said} (${status})`, status, said);
    }
    const plain = this.scrub(text).slice(0, 300);
    return new CourierRefusal(`LogesTechs ${status}: ${plain}`, status, plain.trim());
  }

  private async call<T>(path: string, init: RequestInit, timeoutMs: number = this.timeoutMs): Promise<T> {
    /*
     * The caller's own signal is kept, not replaced: a request cancelled
     * because the operator navigated away must still cancel. Whichever
     * fires first wins.
     */
    const budget = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, budget]) : budget;

    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', [COMPANY_HEADER]: String(this.config.companyId), ...(init.headers ?? {}) },
        signal,
      });
    } catch (e) {
      /*
       * `AbortSignal.timeout` aborts with a TimeoutError, and the caller's
       * own cancellation with an AbortError. Only the first is ours to
       * rename — the second is not a courier problem at all.
       */
      if (budget.aborted) {
        throw markOutcomeUnknown(
          new Error(`${TIMEOUT_PREFIX}: لم تردّ شركةُ الشحن خلال ${Math.round(timeoutMs / 1000)} ثانية على ${path}`)
        );
      }
      throw e;
    }

    /*
     * THE BODY IS INSIDE THE BUDGET TOO. A server can send headers at once
     * and then dribble the body forever; a timeout that covered only the
     * handshake would be a timeout in name.
     */
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (budget.aborted) {
        throw markOutcomeUnknown(
          new Error(`${TIMEOUT_PREFIX}: انقطع الردُّ من شركة الشحن قبل اكتماله على ${path}`)
        );
      }
      throw e;
    }
    if (!res.ok) {
      throw this.refusal(res.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Their cityId for a written city name, or null when it is not theirs. */
  async findCityId(name: string): Promise<number | null> {
    const data = await this.call<{ data?: { id: number; name?: string; arabicName?: string; englishName?: string }[] }>(
      `/addresses/cities?search=${encodeURIComponent(name)}`,
      { method: 'GET' }
    );
    const wanted = name.trim().toLocaleLowerCase('ar');
    const rows = data.data ?? [];
    // An EXACT name, or nothing. It used to fall back to the first row the
    // search returned, so a near name — «السويدية» for «السويداء» — was an
    // address.
    const hit = rows.find((c) => [c.arabicName, c.englishName, c.name].some((n) => n?.trim().toLocaleLowerCase('ar') === wanted));
    return hit?.id ?? null;
  }

  async createShipment(req: CourierShipmentRequest): Promise<CourierShipmentResult> {
    // By id only. The name search this fell back to took the first hit of
    // several; dispatch now refuses an order with no id before it gets here
    // (NO_COURIER_CITY), and this stays as the last line if anything else calls.
    const cityId = req.cityId;
    if (!cityId) {
      throw new Error('LOGESTECHS_CITY_UNKNOWN: لم يُعرف رمز المدينة لدى الشركة');
    }

    const body = {
      ...this.auth,
      pkgUnitType: 'METRIC',
      pkg: {
        ...this.auth,
        // Their cod INCLUDES the delivery cost, which is exactly our COD.
        cod: req.codAmount,
        notes: req.note ?? '',
        // Their "customer order number" — our merchant reference, and the
        // key their statement comes back with.
        invoiceNumber: req.merchantRef,
        senderName: this.config.sender.name,
        senderPhone: this.config.sender.phone,
        ...(this.config.sender.businessName ? { businessSenderName: this.config.sender.businessName } : {}),
        // Their documentation contradicts itself here: the request-body
        // TABLE marks `receiverName` required, while the request EXAMPLE on
        // the next page sends `receiverFirstName` and `receiverLastName`.
        // We send all three. Whichever their server reads, it finds; the
        // other two are ignored, as unknown fields are throughout this API.
        // Guessing one would fail every shipment on the first real use.
        receiverName: req.customer.fullName,
        ...splitName(req.customer.fullName),
        receiverPhone: req.customer.phone,
        // The second number their own waybill can carry — ours always printed both.
        ...(req.customer.altPhone ? { receiverPhone2: req.customer.altPhone } : {}),
        quantity: req.pieces,
        shipmentType: 'COD',
        cityId,
        ...(this.config.parcelTypeId !== undefined ? { parcelTypeId: this.config.parcelTypeId } : {}),
        ...(this.config.serviceTypeId !== undefined ? { serviceTypeId: this.config.serviceTypeId } : {}),
        ...(this.config.vehicleTypeId !== undefined ? { vehicleTypeId: this.config.vehicleTypeId } : {}),
      },
      destinationAddress: {
        addressLine1: req.customer.address,
        cityId,
      },
      originAddress: {
        addressLine1: this.config.origin.addressLine1,
        addressLine2: this.config.origin.addressLine2 ?? '',
        cityId: this.config.origin.cityId,
      },
    };

    const created = await this.call<{ barcode?: string; barcodeImage?: string; id?: number; cost?: number }>(
      '/ship/request/by-email',
      { method: 'POST', body: JSON.stringify(body) }
    );

    if (!created.barcode) throw new Error('LOGESTECHS_NO_BARCODE: لم تُرجع الشركة باركود الشحنة');

    return { trackingNumber: created.barcode, labelUrl: created.barcodeImage ?? null, raw: created };
  }

  async fetchEvents(trackingNumbers: string[]): Promise<CourierEvent[]> {
    // Their status endpoint takes one barcode at a time, so a sweep of two
    // hundred parcels is two hundred calls. Paced, because crossing their
    // limit does not slow us down — it suspends the account, on a working
    // day, for a business that cannot ship until somebody there replies.
    return paced(`logestechs:${this.config.companyId}`, limitFor('LOGESTECHS'), trackingNumbers, async (barcode) => {
      try {
        const res = await this.call<{ status?: string; cod?: number; cost?: number; notes?: string }>(
          `/guests/packages/status?barcode=${encodeURIComponent(barcode)}`,
          { method: 'GET' },
          Math.min(this.timeoutMs, STATUS_TIMEOUT_MS)
        );
        const rawStatus = res.status ?? '';
        return {
          trackingNumber: barcode,
          rawStatus,
          occurredAt: new Date(),
          status: this.mapStatus(rawStatus),
          // Their cod is what they expect to collect, not proof of collection.
          collectedAmount: null,
          note: res.notes || LOGESTECHS_STATUS_AR[rawStatus] || null,
          raw: res,
        };
      } catch (e) {
        return {
          trackingNumber: barcode,
          rawStatus: 'ERROR',
          occurredAt: new Date(),
          status: null,
          note: e instanceof Error ? e.message : 'تعذّر الاستعلام',
        };
      }
    });
  }

  /** Their AWB PDFs for a set of barcodes; returns the URL they hand back. */
  async labelUrl(barcodes: string[]): Promise<string | null> {
    const res = await this.call<{ url?: string }>(`/guests/${this.config.companyId}/packages/pdf`, {
      method: 'POST',
      body: JSON.stringify({ barcodes }),
    });
    return res.url ?? null;
  }

  async cancelShipment(barcode: string): Promise<void> {
    await this.call(`/guests/${this.config.companyId}/packages/cancel?barcode=${encodeURIComponent(barcode)}`, {
      method: 'PUT',
      body: JSON.stringify(this.auth),
    });
  }

  mapStatus(rawStatus: string): ShippingStatus | null {
    // Unknown code → null, never a near match. A wrong mapping moves money.
    return LOGESTECHS_STATUS[rawStatus?.trim().toUpperCase()] ?? null;
  }
}

/** Reads the adapter's config from the environment, or null when unset. */
export function logesTechsFromEnv(env: NodeJS.ProcessEnv = process.env): LogesTechsAdapter | null {
  const email = env.LOGESTECHS_EMAIL;
  const password = env.LOGESTECHS_PASSWORD;
  const companyId = Number(env.LOGESTECHS_COMPANY_ID);
  const originCityId = Number(env.LOGESTECHS_ORIGIN_CITY_ID);

  // Their required sender fields are part of the configuration too: without
  // them every create would be rejected at their end, so the adapter simply
  // does not register and the provider stays manual.
  if (
    !email || !password ||
    !Number.isFinite(companyId) || !Number.isFinite(originCityId) ||
    !env.LOGESTECHS_SENDER_NAME || !env.LOGESTECHS_SENDER_PHONE
  ) {
    return null;
  }

  return new LogesTechsAdapter({
    baseUrl: env.LOGESTECHS_BASE_URL,
    email,
    password,
    companyId,
    serviceTypeId: env.LOGESTECHS_SERVICE_TYPE_ID ? Number(env.LOGESTECHS_SERVICE_TYPE_ID) : undefined,
    vehicleTypeId: env.LOGESTECHS_VEHICLE_TYPE_ID ? Number(env.LOGESTECHS_VEHICLE_TYPE_ID) : undefined,
    parcelTypeId: env.LOGESTECHS_PARCEL_TYPE_ID ? Number(env.LOGESTECHS_PARCEL_TYPE_ID) : undefined,
    sender: {
      name: env.LOGESTECHS_SENDER_NAME ?? '',
      phone: env.LOGESTECHS_SENDER_PHONE ?? '',
      businessName: env.LOGESTECHS_SENDER_BUSINESS,
    },
    origin: {
      addressLine1: env.LOGESTECHS_ORIGIN_ADDRESS ?? '',
      addressLine2: env.LOGESTECHS_ORIGIN_ADDRESS2,
      cityId: originCityId,
    },
  });
}

/**
 * A courier's own LogesTechs account, as stored (encrypted) on its row.
 *
 * The sender and origin are part of the account, not of the platform: two
 * couriers on LogesTechs ship from two warehouses under two logins, and
 * their required sender fields differ. Keeping them together means an
 * account is either complete or absent — never half-configured in a way
 * that fails at their end on the first parcel.
 */
export interface LogesTechsCredentials {
  email: string;
  password: string;
  companyId: number;
  originCityId: number;
  senderName: string;
  senderPhone: string;
  senderBusiness?: string;
  originAddress?: string;
  originAddress2?: string;
  baseUrl?: string;
  serviceTypeId?: number;
  vehicleTypeId?: number;
  parcelTypeId?: number;
}

/** The adapter for a stored account, or null when the account is incomplete. */
export function logesTechsFromCredentials(c: LogesTechsCredentials): LogesTechsAdapter | null {
  if (
    !c?.email || !c?.password ||
    !Number.isFinite(Number(c.companyId)) ||
    !Number.isFinite(Number(c.originCityId)) ||
    !c.senderName || !c.senderPhone
  ) {
    return null;
  }

  return new LogesTechsAdapter({
    baseUrl: c.baseUrl,
    email: c.email,
    password: c.password,
    companyId: Number(c.companyId),
    serviceTypeId: Number.isFinite(Number(c.serviceTypeId)) ? Number(c.serviceTypeId) : undefined,
    vehicleTypeId: Number.isFinite(Number(c.vehicleTypeId)) ? Number(c.vehicleTypeId) : undefined,
    parcelTypeId: Number.isFinite(Number(c.parcelTypeId)) ? Number(c.parcelTypeId) : undefined,
    sender: {
      name: c.senderName,
      phone: c.senderPhone,
      businessName: c.senderBusiness,
    },
    origin: {
      addressLine1: c.originAddress ?? '',
      addressLine2: c.originAddress2,
      cityId: Number(c.originCityId),
    },
  });
}
