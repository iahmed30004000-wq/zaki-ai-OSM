import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE INBOX LIST IS POLLED EVERY FEW SECONDS, PER OPEN TAB (RV182/RV183).
 *
 * It asked «who is this?» TWICE per poll — `requireCompanyTenant()` once for
 * the company and once more for the user — and every such call re-reads the
 * user, the role and the grants (7 to 10 queries). One call gives both.
 *
 * The first fix left it at two: `requirePermission` reads the session (and returns the user) and then
 * `requireCompanyTenant` read it again. Now `requirePermission` is the ONLY read and the company comes from
 * the user it returned (`tenantOf`).
 */

const { requirePermission, requireCompanyTenant, tenantOf, db, noteCustomersHandedOut } = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireCompanyTenant: vi.fn(),
  tenantOf: vi.fn(),
  db: { whatsAppConversation: { findMany: vi.fn() } },
  noteCustomersHandedOut: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requirePermission, requireCompanyTenant, tenantOf }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({ id: 'u1', companyId: 'co1' });
  requireCompanyTenant.mockResolvedValue({ companyId: 'co1', user: { id: 'u1' } });
  tenantOf.mockImplementation(async (user: { companyId: string }) => ({ user, companyId: user.companyId }));
  db.whatsAppConversation.findMany.mockResolvedValue([]);
});

describe('GET /api/whatsapp/conversations', () => {
  it('asks who the caller is once, and still scopes to that company', async () => {
    const res = await GET(new Request('http://x/api/whatsapp/conversations?status=OPEN'));
    expect(res.status).toBe(200);
    expect(requirePermission, 'سأل مين المستخدم مرتين بنفس الطلب').toHaveBeenCalledTimes(1);
    expect(requireCompanyTenant, 'قرأ الجلسة مرة تانية بعد الصلاحية').not.toHaveBeenCalled();
    expect(db.whatsAppConversation.findMany.mock.calls[0][0].where).toMatchObject({ companyId: 'co1', status: 'OPEN' });
  });

  it('and «mine» still means the caller’s own user, from that same single answer', async () => {
    await GET(new Request('http://x/api/whatsapp/conversations?assigned=me'));
    expect(db.whatsAppConversation.findMany.mock.calls[0][0].where).toMatchObject({ assignedUserId: 'u1' });
  });

  it('NEGATIVE: without the permission nothing is read', async () => {
    requirePermission.mockRejectedValue(new Error('Forbidden'));
    await GET(new Request('http://x/api/whatsapp/conversations'));
    expect(db.whatsAppConversation.findMany).not.toHaveBeenCalled();
  });
});
