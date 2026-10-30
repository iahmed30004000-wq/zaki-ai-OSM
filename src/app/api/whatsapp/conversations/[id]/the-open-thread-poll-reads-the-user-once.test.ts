import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE OPEN THREAD IS POLLED TOO (RV182/RV183).
 *
 * `GET /api/whatsapp/conversations/[id]` asked the session twice per poll: `requirePermission` (which reads the user, the
 * role and the grants and returns the user) and then `requireCompanyTenant` (which reads them all again) to learn a
 * company id that was already in hand. The company now comes from the user `requirePermission` returned.
 *
 * What does NOT change, and is held here: no permission, no read; another company's conversation is a 404; a missing
 * conversation is a 404; the answer is the same shape.
 */

const { requirePermission, requireCompanyTenant, tenantOf, db } = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireCompanyTenant: vi.fn(),
  tenantOf: vi.fn(),
  db: {
    whatsAppConversation: { findFirst: vi.fn() },
    whatsAppMessage: { findMany: vi.fn() },
    order: { findMany: vi.fn() },
  },
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requirePermission, requireCompanyTenant, tenantOf }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { GET } from './route';

const conv = {
  id: 'cv1', customerPhone: '0790000000', customerName: 'سارة', status: 'OPEN', unreadCount: 2, lastMessageAt: null,
  assignedUserId: null, assignedTo: null, customerId: null, customer: null,
};
const call = (id = 'cv1', qs = '') => GET(new Request(`http://x/api/whatsapp/conversations/${id}${qs}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'co1' });
  tenantOf.mockImplementation(async (user: { companyId: string }) => ({ user, companyId: user.companyId }));
  db.whatsAppConversation.findFirst.mockResolvedValue(conv);
  db.whatsAppMessage.findMany.mockResolvedValue([]);
  db.order.findMany.mockResolvedValue([]);
});

describe('GET /api/whatsapp/conversations/[id]', () => {
  it('asks who the caller is once, and still scopes to that company', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(requirePermission, 'قرأ الجلسة أكثر من مرة').toHaveBeenCalledTimes(1);
    expect(requirePermission).toHaveBeenCalledWith('whatsapp.view');
    expect(requireCompanyTenant, 'قرأ الجلسة مرة تانية بعد الصلاحية').not.toHaveBeenCalled();
    expect(db.whatsAppConversation.findFirst.mock.calls[0][0].where).toEqual({ id: 'cv1', companyId: 'co1' });
    expect(db.whatsAppMessage.findMany.mock.calls[0][0].where).toMatchObject({ conversationId: 'cv1', companyId: 'co1' });
  });

  it('keeps its answer: the conversation, the customer, the messages and the recent orders', async () => {
    const b = await (await call()).json();
    expect(Object.keys(b).sort()).toEqual(['conversation', 'customer', 'messages', 'recentOrders']);
    expect(b.conversation).toMatchObject({ id: 'cv1', unreadCount: 2 });
  });

  it('NEGATIVE: without `whatsapp.view` nothing is read and the company is never resolved', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission whatsapp.view'));
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(tenantOf).not.toHaveBeenCalled();
    expect(db.whatsAppConversation.findFirst).not.toHaveBeenCalled();
    expect(db.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a conversation of another company is a 404 and its messages are never read', async () => {
    db.whatsAppConversation.findFirst.mockResolvedValue(null);
    const res = await call('cv-of-someone-else');
    expect(res.status).toBe(404);
    expect(db.whatsAppConversation.findFirst.mock.calls[0][0].where.companyId).toBe('co1');
    expect(db.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('an incremental poll asks only for what came after', async () => {
    await call('cv1', '?after=2026-10-30T10:00:00.000Z');
    expect(db.whatsAppMessage.findMany.mock.calls[0][0].where.createdAt).toEqual({ gt: new Date('2026-10-30T10:00:00.000Z') });
  });
});
