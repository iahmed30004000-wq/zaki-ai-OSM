import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * ═════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE LEAD-LANE DOOR (step E2)
 *
 *  1. OFF (the owner's «ليدز الصفحات»): GET answers `{ enabled: false }` and reads nothing; POST is refused 409 and works nothing.
 *  2. Whoever pulls OR supervises may work the lane; anybody else is refused by the usual permission engine before anything is read.
 *  3. A conversion needs the offer and the address, passes them to the lane and writes ONE `LEAD_CONVERTED` audit line with the order number — a refusal writes none.
 *  4. A dismissal writes ONE `LEAD_DISMISSED` line; an unknown lead is 404.
 *  5. The door prices nothing and writes no order: it carries no price field and calls no order write of its own.
 * ═════════════════════════════════════════════════════════════════
 */
const { st, lane, audit } = vi.hoisted(() => ({
  st: { on: true, pull: true, supervise: false, forbid: false },
  lane: {
    readLeadLane: vi.fn(async (..._a: unknown[]) => [{ id: 'L1' }] as unknown),
    convertLead: vi.fn(async (..._a: unknown[]) => ({ ok: true, orderNumber: 'LP-9' }) as unknown),
    dismissLead: vi.fn(async (..._a: unknown[]) => true),
  },
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/db', () => ({ db: { store: { findUnique: vi.fn(async () => ({ country: { minorUnit: 2 } })) } } }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' }) }));
vi.mock('@/lib/authorization', () => ({
  can: (_u: unknown, p: string) => (p === 'confirmation.pull' ? st.pull : p === 'confirmation.supervise' ? st.supervise : false),
  requirePermission: async (p: string) => {
    if (st.forbid || !st.supervise) throw Object.assign(new Error('forbidden ' + p), { status: 403 });
  },
}));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: { status?: number }) => Response.json({ error: 'x' }, { status: e.status ?? 500 }) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => audit(...a) }));
vi.mock('@/lib/leads/leads-v2-switch', () => ({ leadsV2Switch: async () => ({ enabled: st.on, enabledAt: st.on ? new Date(0) : null }) }));
vi.mock('@/lib/leads/lead-lane', async (orig) => ({ ...((await orig()) as object), readLeadLane: (...a: unknown[]) => lane.readLeadLane(...a), convertLead: (...a: unknown[]) => lane.convertLead(...a), dismissLead: (...a: unknown[]) => lane.dismissLead(...a) }));

import { GET, POST } from './route';

const post = (body: unknown) => POST(new Request('http://x/api/confirmation/leads', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  st.on = true;
  st.pull = true;
  st.supervise = false;
  lane.convertLead.mockResolvedValue({ ok: true, orderNumber: 'LP-9' });
  lane.dismissLead.mockResolvedValue(true);
});

describe('the switch (rule 1)', () => {
  it('OFF: GET says disabled and reads nothing; POST is 409 and works nothing', async () => {
    st.on = false;
    expect(await (await GET()).json()).toEqual({ enabled: false });
    expect(lane.readLeadLane).not.toHaveBeenCalled();
    const r = await post({ action: 'convert', leadId: 'L1', offerId: 'o1', address: 'العنوان' });
    expect(r.status).toBe(409);
    expect(lane.convertLead).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('ON: GET answers the lane', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true, leads: [{ id: 'L1' }] });
  });
});

describe('the key (rule 2)', () => {
  it('a supervisor who does not pull may work the lane; somebody with neither is refused and nothing is read', async () => {
    st.pull = false;
    st.supervise = true;
    expect((await GET()).status).toBe(200);
    st.supervise = false;
    expect((await GET()).status).toBe(403);
    expect((await post({ action: 'dismiss', leadId: 'L1' })).status).toBe(403);
    expect(lane.dismissLead).not.toHaveBeenCalled();
  });
});

describe('a conversion and a dismissal (rules 3 and 4)', () => {
  it('converts with the offer and the address, and writes one audit line carrying the order number', async () => {
    const r = await post({ action: 'convert', leadId: 'L1', offerId: 'o1', address: 'المزة، شارع 5' });
    expect(await r.json()).toEqual({ ok: true, orderNumber: 'LP-9' });
    expect(lane.convertLead.mock.calls[0][2]).toEqual({ leadId: 'L1', offerId: 'o1', address: 'المزة، شارع 5' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'LEAD_CONVERTED', entity: 'Lead', entityId: 'L1', newData: { orderNumber: 'LP-9', offerId: 'o1' } });
  });

  it('a missing offer or a short address is refused before the lane is asked', async () => {
    expect((await post({ action: 'convert', leadId: 'L1', address: 'العنوان' })).status).toBe(400);
    expect((await post({ action: 'convert', leadId: 'L1', offerId: 'o1', address: 'x' })).status).toBe(400);
    expect(lane.convertLead).not.toHaveBeenCalled();
  });

  it('a refusal of the lane carries its status and code, and writes no audit line', async () => {
    lane.convertLead.mockResolvedValueOnce({ ok: false, status: 409, code: 'OFFER_NOT_LIVE', message: 'العرض مش متاح' });
    const r = await post({ action: 'convert', leadId: 'L1', offerId: 'o1', address: 'العنوان هنا' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('OFFER_NOT_LIVE');
    expect(audit).not.toHaveBeenCalled();
  });

  it('dismisses with one audit line; an unknown lead is 404; an unknown action is 400', async () => {
    expect((await post({ action: 'dismiss', leadId: 'L1' })).status).toBe(200);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: 'LEAD_DISMISSED', entityId: 'L1' });
    lane.dismissLead.mockResolvedValueOnce(false);
    expect((await post({ action: 'dismiss', leadId: 'gone' })).status).toBe(404);
    expect((await post({ action: 'burn' })).status).toBe(400);
  });
});

describe('what the door is not (rule 5)', () => {
  it('prices nothing and writes no order itself', () => {
    const src = readFileSync('src/app/api/confirmation/leads/route.ts', 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
    expect(src).not.toMatch(/\bprice\b|sellingPrice|totalAmount|discount/i);
    expect(src).not.toMatch(/order\.(create|update|upsert|delete)\w*\(/);
  });
});
