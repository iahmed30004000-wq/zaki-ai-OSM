import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «لخّصلي اليوم» IS OFFERED, AND ANSWERED, ONLY TO WHO HOLDS BOTH KEYS (perm-plan PR-5, PAL-1).
 *
 * It was offered to everybody who could open the box and answered whoever held `orders.view`; a press wakes a model. Now
 * `GET /api/palette` says `may.today` — the numbers (`orders.view`, any scope) AND the assistants' box (`ai.assist`) — and
 * `POST /api/palette/today` refuses the same people the box no longer offers it to. The offer and the door ask the SAME two
 * things, so the box cannot show a button that only ever answers «لا صلاحية», and a hand-made request cannot get past a
 * hidden one.
 */

const { db, requireContext, aiChat } = vi.hoisted(() => ({
  db: { order: { count: vi.fn() }, product: { findMany: vi.fn() }, user: { findMany: vi.fn() } },
  requireContext: vi.fn(),
  aiChat: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (u: { __perms?: string[] }, p: string) => (u.__perms ?? []).includes(p),
  requirePermission: vi.fn(),
  getPermissionScope: (u: { __scope?: string }) => (u.__scope ? { scope: u.__scope } : null),
}));
vi.mock('@/lib/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiChat: (...a: unknown[]) => aiChat(...a),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { GET } from './route';
import { POST as today } from './today/route';

const account = (perms: string[], scope: string | null = 'ALL_COMPANY') => ({
  id: 'u1', status: 'ACTIVE', role: 'MODERATOR', companyId: 'c1', __scope: scope ?? undefined, __perms: perms,
});
const asUser = (user: unknown) => requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });
const mayToday = async () => ((await (await GET()).json()) as { may: { today: boolean } }).may.today;

beforeEach(() => {
  vi.clearAllMocks();
  db.order.count.mockResolvedValue(3);
  db.product.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  aiChat.mockResolvedValue('اليوم فيه ثلاثة طلبات.');
});

describe('the box is told `today` for the account that asked', () => {
  it('orders.view AND the box → true', async () => {
    asUser(account(['orders.view', 'ai.assist']));
    expect(await mayToday()).toBe(true);
  });

  it('NEGATIVE: orders.view without the box → false (the owner took the model away)', async () => {
    asUser(account(['orders.view']));
    expect(await mayToday()).toBe(false);
  });

  it('NEGATIVE: the box without orders.view → false (the numbers are not hers to read)', async () => {
    asUser(account(['ai.assist'], null));
    expect(await mayToday()).toBe(false);
  });

  it('NEGATIVE: neither → false, and the answer still arrives (the box is also the way to a screen)', async () => {
    asUser(account([], null));
    const body = await (await GET()).json();
    expect(body.may.today).toBe(false);
    expect(body.facts).toEqual([]);
  });
});

describe('the door refuses exactly who the box stopped offering it to', () => {
  it('both keys → the sentence', async () => {
    asUser(account(['orders.view', 'ai.assist']));
    const res = await today();
    expect(res.status).toBe(200);
    expect((await res.json()).from).toBe('LOCAL_MODEL');
  });

  it('NEGATIVE: orders.view alone → 403 and the model is never asked', async () => {
    asUser(account(['orders.view']));
    const res = await today();
    expect(res.status).toBe(403);
    expect(aiChat).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the box alone → 403 and nothing is counted', async () => {
    asUser(account(['ai.assist'], null));
    const res = await today();
    expect(res.status).toBe(403);
    expect(aiChat).not.toHaveBeenCalled();
    expect(db.order.count).not.toHaveBeenCalled();
  });
});
