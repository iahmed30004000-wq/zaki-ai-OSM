import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE DAILY LIST WRITES ONE LINE AND NOTHING ELSE (step F1)
 *
 *  1. OFF (the owner's switch): GET answers `{ enabled: false }` and POST is refused in Arabic (409); nothing is read for the list and nothing is written.
 *  2. The keys: the tab's own `confirmation.supervise` for the list; `confirmation.reassign` to name who calls; `confirmation.winback` to record a call — each asked BEFORE anything is read.
 *  3. Only an order ON TODAY'S LIST can be assigned or called (re-read at the write): the audit line is a record of work, not a way to write about any order.
 *  4. An assignee must be an active person of this company in a calling role; a result must be one of the four; the note is cut to 200.
 *  5. ONE append-only audit line per press — `WINBACK_ASSIGNED` / `WINBACK_CALLED` — and no order, note to the customer, discount or commission is written.
 * ═════════════════════════════════════════════════════════════════
 */
const { requirePermission, can, logAudit, daily, sw, db } = vi.hoisted(() => ({
  requirePermission: vi.fn(async (_k: string) => undefined),
  can: { reassign: true, winback: true },
  logAudit: vi.fn(),
  daily: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  sw: { on: true },
  db: { user: { findMany: vi.fn(async (..._a: unknown[]) => [{ id: 'u1', name: 'سارة' }]), findFirst: vi.fn(async (..._a: unknown[]) => ({ id: 'u1' }) as unknown) } },
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'boss' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: (k: string) => requirePermission(k),
  can: (_u: unknown, k: string) => (k === 'confirmation.reassign' ? can.reassign : k === 'confirmation.winback' ? can.winback : false),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/winback-v2-switch', () => ({ winbackV2Switch: async () => ({ enabled: sw.on, enabledAt: sw.on ? new Date(0) : null }) }));
vi.mock('@/lib/winback-daily', async (orig) => ({ ...((await orig()) as object), readDailyList: (...a: unknown[]) => daily(...a) }));

import { GET, POST } from './route';

const item = (id: string) => ({ orderId: id, orderNumber: `ORD-${id}`, kind: 'LOST', reason: 'PRICE_TOO_HIGH', reasonAr: 'السعر مرتفع', happenedAt: '2026-11-18T00:00:00Z', assignee: null, lastCall: null });
const post = (body: unknown) => POST(new Request('http://x/api/confirmation/winback/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  sw.on = true;
  can.reassign = true;
  can.winback = true;
  daily.mockResolvedValue([item('o1')]);
  db.user.findFirst.mockResolvedValue({ id: 'u1' });
});

describe('off', () => {
  it('GET says it is off and reads nothing for the list; POST is refused in Arabic and writes nothing', async () => {
    sw.on = false;
    expect(await (await (GET as () => Promise<Response>)()).json()).toEqual({ enabled: false });
    expect(daily).not.toHaveBeenCalled();
    const res = await post({ action: 'call', orderId: 'o1', result: 'AGREED' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WINBACK_V2_OFF');
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('the keys', () => {
  it('the list asks the tab\'s key first', async () => {
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    expect((await (GET as () => Promise<Response>)()).status).toBeGreaterThanOrEqual(400);
    expect(daily).not.toHaveBeenCalled();
    await (GET as () => Promise<Response>)();
    expect(requirePermission).toHaveBeenCalledWith('confirmation.supervise');
  });

  it('naming who calls asks the reassign key, recording a call asks the winback key — before anything is read', async () => {
    await post({ action: 'assign', orderId: 'o1', userId: 'u1' });
    expect(requirePermission).toHaveBeenCalledWith('confirmation.reassign');
    await post({ action: 'call', orderId: 'o1', result: 'AGREED' });
    expect(requirePermission).toHaveBeenCalledWith('confirmation.winback');
    requirePermission.mockRejectedValueOnce(Object.assign(new Error('FORBIDDEN'), { status: 403 }));
    daily.mockClear();
    logAudit.mockClear();
    expect((await post({ action: 'call', orderId: 'o1', result: 'AGREED' })).status).toBeGreaterThanOrEqual(400);
    expect(daily).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('GET tells the screen what this person may do, and who can be named', async () => {
    can.reassign = false;
    const body = await (await (GET as () => Promise<Response>)()).json();
    expect(body).toMatchObject({ enabled: true, canAssign: false, canCall: true, window: { fromHours: 24, toHours: 72 }, assignees: [{ id: 'u1', name: 'سارة' }] });
    expect(body.items).toHaveLength(1);
  });
});

describe('the writes', () => {
  it('assign: one audit line with the assignee, for an order on the list, to an active calling person of this company', async () => {
    const res = await post({ action: 'assign', orderId: 'o1', userId: 'u1' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'c1', userId: 'boss', action: 'WINBACK_ASSIGNED', entity: 'Order', entityId: 'o1', newData: { assigneeId: 'u1' } }));
    const who = (db.user.findFirst.mock.calls[0] as unknown as [{ where: Record<string, any> }])[0].where;
    expect(who).toMatchObject({ id: 'u1', companyId: 'c1', status: 'ACTIVE' });
    expect(who.role.in).toEqual(expect.arrayContaining(['CONFIRMATION_AGENT', 'TEAM_LEADER']));
  });

  it('call: one audit line with the result and the note', async () => {
    const res = await post({ action: 'call', orderId: 'o1', result: 'CALL_LATER', note: '  بدو بعد العصر  ' });
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'WINBACK_CALLED', entityId: 'o1', newData: { result: 'CALL_LATER', note: 'بدو بعد العصر' } }));
    await post({ action: 'call', orderId: 'o1', result: 'AGREED', note: 'ا'.repeat(500) });
    expect((logAudit.mock.calls.at(-1)![0] as { newData: { note: string } }).newData.note).toHaveLength(200);
  });

  it('an order that is not on today\'s list is refused (409) and nothing is written', async () => {
    for (const body of [{ action: 'call', orderId: 'elsewhere', result: 'AGREED' }, { action: 'assign', orderId: 'elsewhere', userId: 'u1' }]) {
      const res = await post(body);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('NOT_ON_TODAYS_LIST');
    }
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses in Arabic: an unknown action, no order, a result outside the four, a person who is not a caller', async () => {
    db.user.findFirst.mockResolvedValueOnce(null);
    for (const [body, code] of [
      [{ action: 'delete', orderId: 'o1' }, 'INVALID_ACTION'],
      [{ action: 'call', result: 'AGREED' }, 'INVALID_ORDER'],
      [{ action: 'call', orderId: 'o1', result: 'PAID' }, 'INVALID_RESULT'],
      [{ action: 'call', orderId: 'o1' }, 'INVALID_RESULT'],
      [{ action: 'assign', orderId: 'o1', userId: 'stranger' }, 'INVALID_ASSIGNEE'],
      [{ action: 'assign', orderId: 'o1' }, 'INVALID_ASSIGNEE'],
    ] as const) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = await res.json();
      expect(json.code).toBe(code);
      expect(json.errorAr).toMatch(/[؀-ۿ]/);
    }
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('what the door never does', () => {
  it('writes no order, note, discount or commission — only the audit line — and reads no customer field', () => {
    const src = readFileSync('src/app/api/confirmation/winback/daily/route.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src).not.toMatch(/computeCod|discount|commission|orderNote|customer|rawPhone/i);
    expect((src.match(/logAudit\(/g) ?? []).length).toBe(2);
  });
});
