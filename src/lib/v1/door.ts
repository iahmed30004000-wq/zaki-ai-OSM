import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * THE ENVELOPE `/api/v1` ANSWERS IN — and it is not this product's own.
 *
 * Every other door here answers `{ error, errorAr }`, because a person
 * reads it and the sentence has to say what to do next. Nobody reads this
 * one. `OMS-DOOR-V1.md` fixes the shape another SYSTEM parses:
 *
 *     { "error": { "code", "message", "details" }, "request_id" }
 *
 * — a machine-readable `code` it branches on, a `message` for the log a
 * developer reads, and the request id so a failure in the replies system
 * and a line in this one's log can be put side by side.
 *
 * SO THE ARABIC IS DELIBERATELY ABSENT, and that is not the English-message
 * debt `arabic-refusals.test.ts` was written about: that rule is about
 * sentences a PERSON meets on a screen. Translating a `code` a program
 * switches on would be a translated dead end of the literal kind.
 *
 * ── AND NOTHING IN HERE EVER CARRIES A CUSTOMER ──
 *
 * `details` is for a field name and a constraint, never for the value that
 * broke it. The order door takes a name, a phone and an address; echoing
 * one back inside an error would put a customer's details into the calling
 * system's error log, where nobody decided to keep them.
 */

/** The named faults. A caller branches on these, so they are the contract. */
export const V1_CODE = {
  /** No `Authorization` header, or not a bearer token. */
  TOKEN_MISSING: 'TOKEN_MISSING',
  /** A bearer token that matches nothing, or is revoked, or has expired. */
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** A real token that was not granted this endpoint's scope. */
  SCOPE_MISSING: 'SCOPE_MISSING',
  /** More calls than the token's own per-minute allowance. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** A write with no `Idempotency-Key`. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /** The same key, a different body: two requests claiming one key. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** The same key, still being answered by the first caller. */
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  /** The body did not parse, or did not fit the schema. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** This phone may not place an order (see the blacklist). */
  CUSTOMER_BLACKLISTED: 'CUSTOMER_BLACKLISTED',
  /** A `product_code` this company does not sell. */
  PRODUCT_UNKNOWN: 'PRODUCT_UNKNOWN',
  /** Lines from two different stores in one order. */
  ITEMS_SPAN_STORES: 'ITEMS_SPAN_STORES',
  /** The phone is not a valid number for the store's country. */
  INVALID_PHONE: 'INVALID_PHONE',
  /** The order is confirmed, ended or on a shipment: no machine edits or cancels it any more (`order-editable.ts`). */
  NOT_EDITABLE: 'NOT_EDITABLE',
  /** The phone an amend asked for already belongs to another customer of the store. */
  DUPLICATE_PHONE: 'DUPLICATE_PHONE',
  /** The order, or whatever was asked for, is not this company's. */
  NOT_FOUND: 'NOT_FOUND',
  /** Anything this door did not expect. Never carries an internal message. */
  INTERNAL: 'INTERNAL',
} as const;

export type V1Code = (typeof V1_CODE)[keyof typeof V1_CODE];

/** A refusal with its HTTP status, thrown by the service layer. */
export class V1Fault extends Error {
  readonly status: number;
  readonly code: V1Code;
  readonly details: Record<string, unknown> | null;
  /** Headers the refusal itself requires — `Retry-After` on a 429. */
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: V1Code,
    message: string,
    details: Record<string, unknown> | null = null,
    headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'V1Fault';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

/**
 * THE REQUEST'S ID, WHICH THE CALLER CHOOSES AND THIS DOOR ECHOES.
 *
 * `X-Request-Id: rep_<orderNumber>` is how the replies system finds its own
 * call in this system's log. It is a correlation handle and nothing more —
 * it grants nothing, so a caller inventing one costs nothing — but it is
 * BOUNDED and SANITISED before it is written anywhere: it goes into a
 * response header, and a header value carrying a newline is how a response
 * gets split in two.
 */
export function requestIdOf(req: Request): string {
  const raw = req.headers.get('x-request-id') ?? '';
  const clean = raw.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
  // Nothing usable sent: one is made, so every answer has one and a log
  // line can always be found again.
  return clean || `oms_${crypto.randomUUID()}`;
}

/** A successful answer, with the request id on it. */
export function v1Ok(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'X-Request-Id': requestId, ...headers },
  });
}

/** The body of a refusal, separated so idempotency can store it verbatim. */
export function v1FaultBody(requestId: string, fault: V1Fault): Record<string, unknown> {
  return {
    error: { code: fault.code, message: fault.message, details: fault.details },
    request_id: requestId,
  };
}

/**
 * EVERY REFUSAL THIS DOOR MAKES, SHAPED IN ONE PLACE.
 *
 * A `V1Fault` is answered as it asked to be. ANYTHING ELSE becomes a bare
 * 500 `INTERNAL` with a fixed sentence — the thrown message is logged
 * server-side and never sent, for the reason `api-error.ts` measured: a
 * Prisma message carries the server's own absolute source paths, and this
 * door's replies go to a machine whose log nobody here controls.
 */
export function v1ErrorResponse(requestId: string, error: unknown): NextResponse {
  if (error instanceof V1Fault) {
    return NextResponse.json(v1FaultBody(requestId, error), {
      status: error.status,
      headers: { 'X-Request-Id': requestId, ...error.headers },
    });
  }
  console.error('the systems door failed:', error);
  const internal = new V1Fault(500, V1_CODE.INTERNAL, 'Internal error');
  return NextResponse.json(v1FaultBody(requestId, internal), {
    status: 500,
    headers: { 'X-Request-Id': requestId },
  });
}
