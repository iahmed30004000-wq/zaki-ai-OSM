import { describe, expect, it, vi } from 'vitest';
import { COMPANY_HEADER, CourierRefusal, LogesTechsAdapter } from './logestechs';
import { adapterFor } from './index';
import { encryptJson } from '@/lib/secrets';

/**
 * «رقم تعريف الشركة غير صحيح» — THE COMPANY ID RIDES ON EVERY CALL, AND A REFUSAL READS AS A SENTENCE.
 *
 * Thirty-five of thirty-six creates were refused with that sentence while the account's company id (744) reached only
 * two guest paths. LogesTechs serves many courier companies from one server; the create call has to say which one.
 * Their document lists no headers, so the header is inferred — these tests pin that every request carries it, that the
 * create body is untouched, and that no refusal ever carries the account's own secrets.
 *
 * No network: a fetch double records what would have left the building.
 */

const PASSWORD = 'pa"ss-Secret-9';
const EMAIL = 'shop-owner@example.com';

const config = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  email: EMAIL,
  password: PASSWORD,
  companyId: 744,
  serviceTypeId: 1,
  vehicleTypeId: 0,
  sender: { name: 'متجر', phone: '0790000000', businessName: 'متجر' },
  origin: { addressLine1: 'Main Street', cityId: 36237 },
  fetchImpl,
  ...over,
});

interface Seen { method: string; url: string; headers: Record<string, string>; body: string | undefined }

/** A fetch double that records every request and answers with the next canned reply. */
function recorder(replies: (Response | ((init: RequestInit) => Response))[]) {
  const seen: Seen[] = [];
  const queue = [...replies];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    seen.push({
      method: String(init.method),
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return typeof next === 'function' ? next(init) : next.clone();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const request = {
  orderId: 'o1',
  merchantRef: 'ORD-2026-0004',
  codAmount: 17.5,
  currencyCode: 'SYP',
  customer: { fullName: 'محمد عبد الله', phone: '0990123456', altPhone: '0980000000', address: 'شارع المدينة', regionName: 'دمشق' },
  pieces: 2,
  note: 'اتصل قبل الوصول',
  cityId: 445053,
};

describe('every request carries the company id', () => {
  it('create, cities, status, pdf and cancel — each with company-id = the configured id, as a string', async () => {
    const { seen, fetchImpl } = recorder([json({ barcode: 'KSA1' })]);
    const adapter = new LogesTechsAdapter(config(fetchImpl));

    await adapter.createShipment(request);
    await adapter.findCityId('دمشق');
    await adapter.fetchEvents(['KSA1']);
    await adapter.labelUrl(['KSA1']);
    await adapter.cancelShipment('KSA1');

    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /api/ship/request/by-email',
      'GET /api/addresses/cities',
      'GET /api/guests/packages/status',
      'POST /api/guests/744/packages/pdf',
      'PUT /api/guests/744/packages/cancel',
    ]);
    for (const s of seen) {
      expect(s.headers[COMPANY_HEADER], `${s.method} ${s.url} went without the company id`).toBe('744');
      // The header joins the content type; it does not replace it.
      expect(s.headers['Content-Type']).toBe('application/json');
    }
    expect(COMPANY_HEADER).toBe('company-id');
  });

  it('is the account’s own id, not a constant — another company, another header', async () => {
    const { seen, fetchImpl } = recorder([json({ barcode: 'KSA1' })]);
    await new LogesTechsAdapter(config(fetchImpl, { companyId: 136 })).createShipment(request);
    expect(seen[0].headers['company-id']).toBe('136');
  });

  it('the create body is byte-identical to what it was before the header — only the header is new', async () => {
    const { seen, fetchImpl } = recorder([json({ barcode: 'KSA1' })]);
    await new LogesTechsAdapter(config(fetchImpl)).createShipment(request);

    const auth = { email: EMAIL, password: PASSWORD };
    const expected = {
      ...auth,
      pkgUnitType: 'METRIC',
      pkg: {
        ...auth,
        cod: 17.5,
        notes: 'اتصل قبل الوصول',
        invoiceNumber: 'ORD-2026-0004',
        senderName: 'متجر',
        senderPhone: '0790000000',
        businessSenderName: 'متجر',
        receiverName: 'محمد عبد الله',
        receiverFirstName: 'محمد',
        receiverLastName: 'عبد الله',
        receiverPhone: '0990123456',
        receiverPhone2: '0980000000',
        quantity: 2,
        shipmentType: 'COD',
        cityId: 445053,
        serviceTypeId: 1,
        vehicleTypeId: 0,
      },
      destinationAddress: { addressLine1: 'شارع المدينة', cityId: 445053 },
      originAddress: { addressLine1: 'Main Street', addressLine2: '', cityId: 36237 },
    };
    expect(seen[0].body).toBe(JSON.stringify(expected));
  });
});

describe('a refusal reads as a sentence', () => {
  const refused = async (reply: Response, name?: string) => {
    const { fetchImpl } = recorder([reply]);
    const adapter = new LogesTechsAdapter(config(fetchImpl, name ? { courierName: name } : {}));
    return adapter.createShipment(request).then(
      () => { throw new Error('should have been refused'); },
      (e: unknown) => e as Error,
    );
  };

  it('{"error":"…"} becomes «الباشا رفض: … (400)» with the courier’s display name', async () => {
    const e = await refused(json({ error: 'رقم تعريف الشركة غير صحيح' }, 400), 'الباشا');
    expect(e.message).toBe('الباشا رفض: رقم تعريف الشركة غير صحيح (400)');
    expect(e).toBeInstanceOf(CourierRefusal);
    expect((e as CourierRefusal).status).toBe(400);
    expect((e as CourierRefusal).said).toBe('رقم تعريف الشركة غير صحيح');
  });

  it('without a display name it still reads as a sentence, not as «LogesTechs 400: {"error":…}»', async () => {
    const e = await refused(json({ error: 'رقم تعريف الشركة غير صحيح' }, 400));
    expect(e.message).toBe('الشركة رفضت: رقم تعريف الشركة غير صحيح (400)');
    expect(e.message).not.toContain('{');
  });

  it('a body that is not JSON keeps today’s text', async () => {
    const e = await refused(new Response('upstream down', { status: 502 }), 'الباشا');
    expect(e.message).toBe('LogesTechs 502: upstream down');
  });

  it('a JSON body without «error» keeps today’s text — the raw words, not a guessed sentence', async () => {
    const e = await refused(json({ message: 'something else' }, 400), 'الباشا');
    expect(e.message).toBe('LogesTechs 400: {"message":"something else"}');
    expect(e.message).not.toContain('الباشا');
  });

  it('a very long reason is cut, and the sentence stays one line of bounded size', async () => {
    const e = await refused(json({ error: 'س'.repeat(5000) }, 400), 'الباشا');
    expect((e as CourierRefusal).said).toHaveLength(300);
    expect(e.message.length).toBeLessThan(330);
  });

  it('an empty «error» is not a sentence', async () => {
    const e = await refused(json({ error: '   ' }, 400), 'الباشا');
    expect(e.message.startsWith('LogesTechs 400')).toBe(true);
  });
});

describe('no refusal carries the account’s own secrets', () => {
  /** A server that answers 400 by reading the request back to us — the worst case for a leak. */
  const echo = (shape: 'json-error' | 'plain') => (init: RequestInit) =>
    shape === 'json-error'
      ? json({ error: `bad request: ${init.body}` }, 400)
      : new Response(`bad request: ${init.body}`, { status: 400 });

  for (const shape of ['json-error', 'plain'] as const) {
    it(`create — a server that echoes the request (${shape}) leaks neither password nor e-mail`, async () => {
      const { fetchImpl } = recorder([echo(shape)]);
      const adapter = new LogesTechsAdapter(config(fetchImpl, { courierName: 'الباشا' }));
      const e = await adapter.createShipment(request).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      for (const secret of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), EMAIL]) {
        expect((e as Error).message, `الرفض يحمل ${secret.slice(0, 3)}…`).not.toContain(secret);
        expect((e as CourierRefusal).said ?? '').not.toContain(secret);
      }
    });
  }

  it('cancel — the other call whose body holds the password — leaks nothing either', async () => {
    const { fetchImpl } = recorder([echo('json-error')]);
    const adapter = new LogesTechsAdapter(config(fetchImpl));
    const e = await adapter.cancelShipment('KSA1').catch((x: Error) => x);
    expect((e as Error).message).not.toContain(PASSWORD);
    expect((e as Error).message).not.toContain(EMAIL);
  });

  it('a status lookup that fails puts only the scrubbed sentence in the event’s note', async () => {
    const { fetchImpl } = recorder([json({ error: `bad ${PASSWORD}` }, 400)]);
    const [event] = await new LogesTechsAdapter(config(fetchImpl, { courierName: 'الباشا' })).fetchEvents(['KSA1']);
    expect(event.rawStatus).toBe('ERROR');
    expect(event.note).toContain('الباشا رفض');
    expect(event.note).not.toContain(PASSWORD);
  });

  it('NEGATIVE: the secret is really there to find — the scrub is what removes it', async () => {
    const { fetchImpl, seen } = recorder([echo('plain')]);
    await new LogesTechsAdapter(config(fetchImpl)).createShipment(request).catch(() => undefined);
    // The request did carry the password (that is how this API logs in) — so the test above is not vacuous.
    expect(seen[0].body).toContain(EMAIL);
    expect(seen[0].body).toContain(JSON.stringify(PASSWORD).slice(1, -1));
  });
});

describe('the adapter the registry builds for a stored account', () => {
  it('speaks as the courier («الباشا رفض») and sends the account’s own company id', async () => {
    process.env.APP_ENCRYPTION_KEY = 'd'.repeat(64);
    const apiCredentials = encryptJson({
      email: EMAIL, password: PASSWORD, companyId: 744, originCityId: 445053, senderName: 'متجر', senderPhone: '0999000000',
    });
    const { seen, fetchImpl } = recorder([json({ error: 'رقم تعريف الشركة غير صحيح' }, 400)]);
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const adapter = adapterFor({ code: 'BASHA', name: 'الباشا', adapterCode: 'LOGESTECHS', apiEnabled: true, apiConfig: {}, apiCredentials });
      const e = await adapter.createShipment(request).catch((x: Error) => x);
      expect((e as Error).message).toBe('الباشا رفض: رقم تعريف الشركة غير صحيح (400)');
      expect(seen[0].headers['company-id']).toBe('744');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
