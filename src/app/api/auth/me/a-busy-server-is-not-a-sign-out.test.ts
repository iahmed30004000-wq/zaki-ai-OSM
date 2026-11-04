import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «WHO AM I» — THREE ANSWERS, NOT TWO (the owner's ruling 4/11).
 *
 * The screen (AppContext) reads a 401 here as «signed out» and anything else as «no answer yet». So a database that did
 * not answer must come back as something other than 401, and a device a newer sign-in ended must come back saying so.
 */

const { getSessionVerdict } = vi.hoisted(() => ({ getSessionVerdict: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getSessionVerdict: (...a: unknown[]) => getSessionVerdict(...a) }));

import { GET } from './route';
import { AuthBackendDown } from '@/lib/auth-errors';

beforeEach(() => vi.clearAllMocks());

describe('/api/auth/me', () => {
  it('a database that did not answer is 503 SERVICE_BUSY, never 401', async () => {
    getSessionVerdict.mockRejectedValue(new AuthBackendDown());
    const res = await GET();
    expect(res.status, 'زحمة القاعدة صارت «طلعتِ»').toBe(503);
    expect((await res.json()).code).toBe('SERVICE_BUSY');
  });

  it('a device a third sign-in ended is 401 with SESSION_REPLACED', async () => {
    getSessionVerdict.mockResolvedValue({ user: null, reason: 'REPLACED' });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ user: null, code: 'SESSION_REPLACED' });
  });

  it('nobody at all is the plain 401 it always was', async () => {
    getSessionVerdict.mockResolvedValue({ user: null, reason: 'NONE' });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ user: null });
  });

  it('and somebody is somebody', async () => {
    getSessionVerdict.mockResolvedValue({ user: { id: 'u1' } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe('u1');
  });
});
