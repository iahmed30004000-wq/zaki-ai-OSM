import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));

import { GET } from './route';

/**
 * THE OWNER'S DOOR ON THE SERVER'S PULSE.
 *
 * It carries memory figures and the names of our own computations, so unlike the public health doors it asks who is calling:
 * the key of the jobs screen, and nothing else opens it.
 */

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({ id: 'u1' });
});

describe('GET /api/admin/pulse', () => {
  it('answers the report to whoever holds «تشغيل المهام المجدولة»', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('settings.jobs');
    const body = await res.json();
    expect(body).toMatchObject({ watching: expect.any(Boolean), stalls: expect.any(Array), slow: expect.any(Array), runningNow: expect.any(Array) });
    expect(body.memoryMb.rss).toBeGreaterThan(0);
  });

  it('is never cached', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses everybody who does not hold the key — and tells them nothing', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission settings.jobs'));
    const res = await GET();
    expect(res.status).toBe(403);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('memoryMb');
    expect(text).not.toContain('stalls');
  });

  it('refuses somebody who is not signed in', async () => {
    requirePermission.mockRejectedValue(new Error('Unauthorized'));
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
