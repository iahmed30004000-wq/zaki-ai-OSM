// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

/**
 * ONLY A REAL 401 SENDS HER TO /login (the owner's ruling 4/11).
 *
 * A 503 — the server could not check the session because the database was busy — is handed back to the screen like
 * any other refusal. And a 401 that says SESSION_REPLACED lands on the login page that explains it.
 */

let href = '';

beforeEach(() => {
  href = '';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(to: string) {
        href = to;
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('apiFetch and the session', () => {
  it('a 503 SERVICE_BUSY is not a sign-out', async () => {
    answer(503, { error: 'Service busy', code: 'SERVICE_BUSY' });
    const res = await apiFetch('/api/orders');
    expect(res.status).toBe(503);
    expect(href, 'زحمة السيرفر ودّتها على الدخول').toBe('');
  });

  it('a 401 from a device a third sign-in ended lands on the page that says so', async () => {
    answer(401, { error: 'Unauthorized', code: 'SESSION_REPLACED' });
    await expect(apiFetch('/api/orders')).rejects.toThrow();
    expect(href).toBe('/login?replaced=1');
  });

  it('a plain 401 is the plain login page', async () => {
    answer(401, { error: 'Unauthorized' });
    await expect(apiFetch('/api/orders')).rejects.toThrow();
    expect(href).toBe('/login');
  });

  it('and a 401 with no readable body is still the login page, never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 401 })));
    await expect(apiFetch('/api/orders')).rejects.toThrow('انتهت الجلسة');
    expect(href).toBe('/login');
  });
});
