import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «محادثة جديدة» and «واتساب OMS» on a customer's number (the owner, 27/11): any number a person types opens — or finds — its
 * inbox thread on the company number, keyed as an inbound message keys it, linked to the customer when there is one, and
 * sends nothing.
 */

const h = vi.hoisted(() => ({
  status: 'CONNECTED',
  customer: null as any,
  upsert: vi.fn(),
  findCustomer: vi.fn(),
}));

vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(async () => ({ id: 'u1' })) }));
vi.mock('@/lib/geo-context', () => ({ requireContext: async () => ({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { code: 'SY' } }) }));
vi.mock('@/lib/whatsapp/connection', () => ({ getActiveConnection: async () => ({ id: 'conn1' }), effectiveStatus: async () => h.status }));
vi.mock('@/lib/db', () => ({
  db: {
    customer: { findFirst: (...a: unknown[]) => h.findCustomer(...a) },
    whatsAppConversation: { upsert: (...a: unknown[]) => h.upsert(...a) },
  },
}));

import { POST } from './route';
import { chatNumber } from '@/lib/whatsapp/chat-number';
import { initials } from '@/components/whatsapp/chat-model';

const post = async (body: unknown) => {
  const res = await POST(new Request('http://x/api/whatsapp/conversations/start', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => {
  h.status = 'CONNECTED';
  h.upsert.mockReset().mockResolvedValue({ id: 'conv-1' });
  h.findCustomer.mockReset().mockResolvedValue(null);
});

describe('the number a person types', () => {
  it('a local number takes the store’s code; + and 00 are international; nonsense is no number', () => {
    expect(chatNumber('0952349466', '963')).toBe('963952349466');
    expect(chatNumber('+962 79 123 4888', '963')).toBe('962791234888');
    expect(chatNumber('00962791234888', '963')).toBe('962791234888');
    expect(chatNumber('٠٩٥٢٣٤٩٤٦٦', '963')).toBe('963952349466');
    expect(chatNumber('12', '963')).toBe('');
    expect(chatNumber('', '963')).toBe('');
  });
});

describe('POST /api/whatsapp/conversations/start', () => {
  it('opens the thread keyed by the full number, named as typed, and answers its id', async () => {
    const r = await post({ phone: '0952349466', name: 'أبو سامي' });
    expect(r).toEqual({ status: 200, body: { id: 'conv-1' } });
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.where.companyId_connectionId_customerPhone).toEqual({ companyId: 'c1', connectionId: 'conn1', customerPhone: '963952349466' });
    expect(arg.create).toMatchObject({ customerPhone: '963952349466', customerName: 'أبو سامي', customerId: null, status: 'OPEN' });
    expect(arg.update).toEqual({ status: 'OPEN', customerName: 'أبو سامي' });
  });

  it('a customer of the company with that number is linked, and his name is used when none is typed', async () => {
    h.findCustomer.mockResolvedValue({ id: 'cu9', fullName: 'سامي' });
    await post({ phone: '+963952349466' });
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ customerId: 'cu9', customerName: 'سامي' });
    // an existing thread keeps its name when none is typed
    expect(arg.update).toEqual({ status: 'OPEN' });
    expect(h.findCustomer.mock.calls[0][0].where.companyId).toBe('c1');
  });

  it('refuses a number that is no number, a body with anything else, and a number not connected', async () => {
    expect((await post({ phone: '12' })).body.code).toBe('INVALID_PHONE');
    expect((await post({ phone: '0952349466', orderId: 'x' })).status).toBe(400);
    h.status = 'NEEDS_SETUP';
    expect((await post({ phone: '0952349466' })).body.code).toBe('NOT_CONNECTED');
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('a thread still loading never breaks the inbox', () => {
  it('no number yet is «؟»', () => {
    expect(initials(null, undefined)).toBe('؟');
  });
});
