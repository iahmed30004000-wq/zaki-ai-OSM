import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiJson } from '@/lib/api-client';

/**
 * Every request the screens make waits fifteen seconds, and gives up with «انتهت مهلة الطلب». A call that is slow by nature — a few
 * parcels handed to a courier, one call each — may name its own wait with `timeoutMs`. Nothing else is given more, and the option is
 * the caller's own: it never reaches `fetch` as a field of the request.
 */

const timeout = vi.spyOn(AbortSignal, 'timeout');
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  timeout.mockClear();
  fetchMock.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the wait of a request', () => {
  it('is fifteen seconds unless the caller says otherwise', async () => {
    await apiFetch('/api/x');
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it('is the caller’s own when it names one — through the JSON door too', async () => {
    await apiFetch('/api/x', { timeoutMs: 120_000 });
    expect(timeout).toHaveBeenLastCalledWith(120_000);
    await apiJson('/api/y', { method: 'POST', timeoutMs: 90_000 });
    expect(timeout).toHaveBeenLastCalledWith(90_000);
  });

  it('is not sent to the network as part of the request', async () => {
    await apiFetch('/api/x', { method: 'POST', timeoutMs: 120_000, headers: { 'Content-Type': 'application/json' } });
    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('timeoutMs');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });

  it('NEGATIVE: a request that waits out its time says so in the same sentence whatever the wait was', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    await expect(apiFetch('/api/x', { timeoutMs: 120_000 })).rejects.toThrow('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.');
  });
});
