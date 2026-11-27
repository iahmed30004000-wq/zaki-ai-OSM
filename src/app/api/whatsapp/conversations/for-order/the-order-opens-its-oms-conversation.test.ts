import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «واتساب OMS» from an order (the owner, 27/11): the door finds — or opens — the inbox conversation with the order's customer
 * on the company's number, keyed the way an inbound message keys it, and sends nothing.
 */

const h = vi.hoisted(() => ({
  access: { allowed: true, order: { id: 'o1', customerId: 'cu1', countryId: 'sy' } } as any,
  conn: { id: 'conn1', status: 'CONNECTED' } as any,
  status: 'CONNECTED',
  customer: { id: 'cu1', fullName: 'أبو محمد', rawPhone: '0952554562' } as any,
  upsert: vi.fn(),
}));

vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => ({ id: 'u1' })) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { code: 'SY' } }) }));
vi.mock('@/lib/rbac', () => ({ assertOrderAccess: async () => h.access, ORDER_ACCESS_STATUS: { NOT_FOUND: 404, WRONG_COMPANY: 404, NOT_ASSIGNED: 403 } }));
vi.mock('@/lib/whatsapp/connection', () => ({ getActiveConnection: async () => h.conn, effectiveStatus: async () => h.status }));
vi.mock('@/lib/db', () => ({
  db: {
    customer: { findFirst: async () => h.customer },
    country: { findFirst: async () => ({ code: 'SY' }) },
    whatsAppConversation: { upsert: (...a: unknown[]) => h.upsert(...a) },
  },
}));

import { POST } from './route';

const post = async (body: unknown) => {
  const res = await POST(new Request('http://x/api/whatsapp/conversations/for-order', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => {
  h.upsert.mockReset().mockResolvedValue({ id: 'conv-9' });
  h.access = { allowed: true, order: { id: 'o1', customerId: 'cu1', countryId: 'sy' } };
  h.conn = { id: 'conn1', status: 'CONNECTED' };
  h.status = 'CONNECTED';
  h.customer = { id: 'cu1', fullName: 'أبو محمد', rawPhone: '0952554562' };
});

describe('the order opens its OMS conversation', () => {
  it('found or opened on the company number, keyed by the full international number, and answered by id', async () => {
    const r = await post({ orderId: 'o1' });
    expect(r).toEqual({ status: 200, body: { id: 'conv-9' } });
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ companyId_connectionId_customerPhone: { companyId: 'c1', connectionId: 'conn1', customerPhone: '963952554562' } });
    expect(arg.create).toMatchObject({ customerId: 'cu1', customerName: 'أبو محمد', status: 'OPEN' });
  });

  it('the number not connected: refused in words, nothing opened', async () => {
    h.status = 'NEEDS_SETUP';
    const r = await post({ orderId: 'o1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('NOT_CONNECTED');
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('an order this person may not see is not found, and a body with anything else is refused', async () => {
    h.access = { allowed: false, reason: 'NOT_ASSIGNED' };
    expect((await post({ orderId: 'o1' })).status).toBe(403);
    expect((await post({ orderId: 'o1', phone: '+1' })).status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('no number on the customer: refused', async () => {
    h.customer = { id: 'cu1', fullName: 'x', rawPhone: '—' };
    expect((await post({ orderId: 'o1' })).body.code).toBe('NO_PHONE');
  });
});
