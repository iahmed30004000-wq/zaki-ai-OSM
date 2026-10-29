import { describe, expect, it, vi } from 'vitest';

/**
 * THE CONTAINER'S OWN QUESTION: IS THE PROCESS ALIVE.
 *
 * It must answer 200 when the database is down, when it is slow, and when
 * the worker is dead — because the container's health check restarts or
 * un-routes the container on a failure, and none of those three is fixed
 * by that (RV185).
 */

// Anything that reaches for the database or the heartbeat fails the test loudly,
// instead of quietly answering from a mock.
const { dbTouched, heartbeatTouched } = vi.hoisted(() => ({ dbTouched: vi.fn(), heartbeatTouched: vi.fn() }));
vi.mock('@/lib/db', () => ({
  get db(): never {
    dbTouched();
    throw new Error('connection refused');
  },
  get default(): never {
    dbTouched();
    throw new Error('connection refused');
  },
}));
vi.mock('@/lib/jobs/heartbeat', () => ({
  readHeartbeat: () => {
    heartbeatTouched();
    throw new Error('the database is down');
  },
}));

import { GET } from './route';

describe('GET /api/health/live', () => {
  it('is 200 and one fixed word, with no session', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('NEGATIVE: with the database unreachable and the heartbeat failing, it is still 200 — and neither was asked', async () => {
    const res = await GET();
    expect(res.status, 'الفحص بيسقط لمّا القاعدة بطيئة').toBe(200);
    expect(dbTouched, 'سأل القاعدة').not.toHaveBeenCalled();
    expect(heartbeatTouched, 'سأل نبض العامل').not.toHaveBeenCalled();
  });

  it('cannot be cached by a proxy, a CDN or the framework', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const route = await import('./route');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('leaks nothing: no version, host, name, time or count — one status word', async () => {
    const body = await (await GET()).json();
    expect(Object.keys(body)).toEqual(['status']);
    expect(JSON.stringify(body)).not.toMatch(/\d/);
  });
});
