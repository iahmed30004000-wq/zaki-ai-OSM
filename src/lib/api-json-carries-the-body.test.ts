import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '@/lib/api-client';

/**
 * A refusal travels with its whole body. The shipment door answers 409 with `exceptions` (the reason of each order)
 * beside its generic sentence; `apiJson` threw the sentence only, so the screen could not show the reasons.
 */

const answer = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));

afterEach(() => vi.unstubAllGlobals());

describe('apiJson', () => {
  it('throws the sentence as the message and the whole body as data', async () => {
    const body = { error: 'لا يوجد طلب صالح للشحن ضمن الاختيار', code: 'ALL_BLOCKED', exceptions: [{ orderNumber: 'A-1', reasons: ['سبب'] }] };
    answer(409, body);
    const err = await apiJson('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('لا يوجد طلب صالح للشحن ضمن الاختيار');
    expect((err as unknown as { data: unknown }).data).toEqual(body);
    expect((err as unknown as { status: number }).status).toBe(409);
  });

  it('prefers the Arabic sentence when the server sent one', async () => {
    answer(403, { errorAr: 'ممنوع', error: 'forbidden' });
    await expect(apiJson('/x')).rejects.toThrow('ممنوع');
  });

  it('a body that is not JSON still throws, with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const err = await apiJson('/x').catch((e: unknown) => e);
    expect((err as Error).message).toBe('HTTP 500');
  });

  it('a good answer is returned as it came', async () => {
    answer(200, { ok: 1 });
    expect(await apiJson('/x')).toEqual({ ok: 1 });
  });
});
