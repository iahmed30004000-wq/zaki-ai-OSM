import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE INBOX OBEYS THE SCOPE `whatsapp.view` WAS SAVED AT (perm-plan PR-13, WA-3 and D1-i).
 *
 * The screens that grant `whatsapp.view` offer «المسندة إليه», and the engine stores it — but no inbox door read it, so a person
 * limited to her own conversations listed, opened, answered, assigned and closed every conversation of the company. ASSIGNED
 * now means: the conversations assigned to her, and the ones nobody has taken yet. «كل الشركة», the owner (who holds every key
 * centrally) and a person with no view scope at all (the send door does not ask for the view key) see no extra filter.
 *
 * And the CUSTOMER PANEL (WA-2): the linked customer's card needs the customer tier, and the recent orders are only the ones the
 * viewer may list — a chat is not a way round the customers and orders keys. The answer keeps its shape: `customer` is null and
 * `recentOrders` is empty, so no screen breaks.
 *
 * Every door has its NEGATIVE: the same request from a person whose scope is wider, which must NOT gain the filter, and the
 * out-of-scope conversation answering exactly as an unknown one does.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    whatsAppConversation: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    whatsAppMessage: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    whatsAppConnection: { update: vi.fn() },
    order: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
  },
  who: { current: null as unknown },
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
vi.mock('@/lib/pii-alert', () => ({ noteCustomersHandedOut: async () => undefined }));
vi.mock('@/lib/auth', () => ({
  requireAuth: async () => h.who.current,
  requirePermission: async () => h.who.current,
  requireCompanyTenant: async () => ({ user: h.who.current, companyId: 'c1' }),
  tenantOf: async (user: unknown) => ({ user, companyId: 'c1' }),
}));
vi.mock('@/lib/whatsapp/config', () => ({ getAccessToken: () => 'tok', getPhoneNumberId: () => 'pn' }));
vi.mock('@/lib/whatsapp/cloud-api', () => ({
  markMessageRead: async () => undefined,
  sendTextMessage: async () => ({ ok: true, wamid: 'w1' }),
}));
vi.mock('@/lib/whatsapp/connection', () => ({
  getActiveConnection: async () => ({ id: 'cn1' }),
  effectiveStatus: () => 'CONNECTED',
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ allowed: true }) }));

import { attachGrants } from '@/lib/authorization';
import type { SessionUser } from '@/types/auth';
import { GET as list } from './route';
import { GET as one, PATCH as close } from './[id]/route';
import { POST as read } from './[id]/read/route';
import { POST as assign } from './[id]/assign/route';
import { sendOutboundMessage } from '@/lib/whatsapp/send';

type G = Record<string, { scope: 'ALL_COMPANY' | 'OWN' | 'ASSIGNED' }>;
const person = (id: string, grants: G, over: Record<string, unknown> = {}): SessionUser =>
  attachGrants(
    { id, role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1', permissions: Object.keys(grants), ...over } as unknown as SessionUser,
    { fullAccess: false, grants }
  );

const MINE_OR_FREE = { OR: [{ assignedUserId: 'me' }, { assignedUserId: null }] };
const ALL: G = { 'whatsapp.view': { scope: 'ALL_COMPANY' }, 'whatsapp.send': { scope: 'ALL_COMPANY' }, 'whatsapp.assign': { scope: 'ALL_COMPANY' } };
const ASSIGNED: G = { ...ALL, 'whatsapp.view': { scope: 'ASSIGNED' } };

const asParams = (id = 'cv1') => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method: string) => new Request('http://x/y', { method, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.who.current = person('me', ASSIGNED);
  h.db.whatsAppConversation.findMany.mockResolvedValue([]);
  h.db.whatsAppConversation.findFirst.mockResolvedValue({
    id: 'cv1', customerPhone: '0790', customerName: 'ن', status: 'OPEN', unreadCount: 0, lastMessageAt: null, assignedUserId: null, assignedTo: null,
    customerId: 'cu1', customer: { id: 'cu1', fullName: 'عميل', phone: '0790', rawPhone: '0790', city: 'عمّان' }, connectionId: 'cn1',
  });
  h.db.whatsAppConversation.update.mockResolvedValue({ status: 'CLOSED', assignedUserId: 'me', assignedTo: null });
  h.db.whatsAppMessage.findMany.mockResolvedValue([]);
  h.db.whatsAppMessage.findFirst.mockResolvedValue(null);
  h.db.whatsAppMessage.create.mockResolvedValue({ id: 'm1', direction: 'OUTBOUND', messageType: 'TEXT', text: 'x', status: 'SENT', createdAt: new Date() });
  h.db.whatsAppConnection.update.mockResolvedValue({});
  h.db.order.findMany.mockResolvedValue([]);
  h.db.user.findFirst.mockResolvedValue({ id: 'other' });
});

const whereOf = (fn: { mock: { calls: unknown[][] } }) => (fn.mock.calls[0][0] as { where: Record<string, unknown> }).where;

describe('the list', () => {
  it('ASSIGNED sees hers and the unassigned — inside AND, beside the search’s own OR', async () => {
    await list(new Request('http://x/api/whatsapp/conversations?q=%D8%A3%D8%AD%D9%85%D8%AF'));
    const where = whereOf(h.db.whatsAppConversation.findMany);
    expect(where.AND).toEqual([MINE_OR_FREE]);
    expect(where.OR, 'the search keeps its own OR').toBeDefined();
    expect(where).toMatchObject({ companyId: 'c1', status: 'OPEN' });
  });

  it('NEGATIVE: «كل الشركة» gets no extra filter', async () => {
    h.who.current = person('me', ALL);
    await list(new Request('http://x/api/whatsapp/conversations'));
    expect(whereOf(h.db.whatsAppConversation.findMany)).not.toHaveProperty('AND');
  });

  it('NEGATIVE: the owner (every key, centrally) gets no extra filter', async () => {
    h.who.current = attachGrants({ id: 'root', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser, { fullAccess: true, grants: {} });
    await list(new Request('http://x/api/whatsapp/conversations'));
    expect(whereOf(h.db.whatsAppConversation.findMany)).not.toHaveProperty('AND');
  });

  it('NEGATIVE: asking for someone else’s conversations by id does not widen it — the scope is ANDed with the asked filter', async () => {
    await list(new Request('http://x/api/whatsapp/conversations?assigned=colleague-7'));
    const where = whereOf(h.db.whatsAppConversation.findMany);
    expect(where).toMatchObject({ assignedUserId: 'colleague-7' });
    expect(where.AND).toEqual([MINE_OR_FREE]);
  });
});

describe('only ASSIGNED narrows, and the list keeps the customer tier too', () => {
  it('NEGATIVE: a stored OWN row (copied from the orders rows by the 2026-09 migration, never tickable) is NOT read as narrowing - no door is taken on deploy', async () => {
    h.who.current = person('me', { ...ALL, 'whatsapp.view': { scope: 'OWN' } });
    await list(new Request('http://x/api/whatsapp/conversations'));
    expect(whereOf(h.db.whatsAppConversation.findMany)).not.toHaveProperty('AND');
  });

  it('the list hides the linked customer from a reader without the customer tier, and keeps the row', async () => {
    h.who.current = person('me', ALL);
    h.db.whatsAppConversation.findMany.mockResolvedValue([{ id: 'cv1', customerName: 'ن', customer: { id: 'cu1', fullName: 'عميل', phone: '0790' } }]);
    const body = await (await list(new Request('http://x/api/whatsapp/conversations'))).json();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({ id: 'cv1', customer: null });
  });

  it('with the customer tier the list carries it as before', async () => {
    h.who.current = person('me', { ...ALL, 'customers.view_basic': { scope: 'ALL_COMPANY' } });
    h.db.whatsAppConversation.findMany.mockResolvedValue([{ id: 'cv1', customer: { id: 'cu1', fullName: 'عميل', phone: '0790' } }]);
    const body = await (await list(new Request('http://x/api/whatsapp/conversations'))).json();
    expect(body.conversations[0].customer).toMatchObject({ fullName: 'عميل' });
  });
});

describe('opening one conversation', () => {
  it('ASSIGNED: the lookup carries the scope — a conversation outside it is the same 404 as an unknown one', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue(null);
    const res = await one(new Request('http://x/y'), asParams());
    expect(res.status).toBe(404);
    expect(whereOf(h.db.whatsAppConversation.findFirst)).toMatchObject({ id: 'cv1', companyId: 'c1', AND: [MINE_OR_FREE] });
    expect(h.db.whatsAppMessage.findMany, 'قرأ رسائل محادثة خارج نطاقه').not.toHaveBeenCalled();
  });

  it('NEGATIVE: «كل الشركة» opens it with no extra filter', async () => {
    h.who.current = person('me', { ...ALL, 'customers.view_basic': { scope: 'ALL_COMPANY' } });
    const res = await one(new Request('http://x/y'), asParams());
    expect(res.status).toBe(200);
    expect(whereOf(h.db.whatsAppConversation.findFirst)).toEqual({ id: 'cv1', companyId: 'c1' });
  });
});

describe('the customer panel and the recent orders (WA-2)', () => {
  it('NEGATIVE: without the customer tier the card is null — the answer keeps its shape, and the conversation still opens', async () => {
    h.who.current = person('me', ALL);
    const body = await (await one(new Request('http://x/y'), asParams())).json();
    expect(body.customer).toBeNull();
    expect(body.conversation.customerName).toBe('ن');
    expect(Array.isArray(body.recentOrders)).toBe(true);
  });

  it('with the basic tier the card is there', async () => {
    h.who.current = person('me', { ...ALL, 'customers.view_basic': { scope: 'ALL_COMPANY' } });
    expect((await (await one(new Request('http://x/y'), asParams())).json()).customer).toMatchObject({ fullName: 'عميل' });
  });

  it('the full tier covers the basic one', async () => {
    h.who.current = person('me', { ...ALL, 'customers.view': { scope: 'ALL_COMPANY' } });
    expect((await (await one(new Request('http://x/y'), asParams())).json()).customer).not.toBeNull();
  });

  it('the recent orders are asked through the viewer’s own envelope of orders', async () => {
    h.who.current = person('me', { ...ALL, 'orders.view': { scope: 'ASSIGNED' } });
    await one(new Request('http://x/y'), asParams());
    const where = whereOf(h.db.order.findMany);
    expect(where).toMatchObject({ companyId: 'c1', customerId: 'cu1' });
    expect(JSON.stringify(where.AND)).toContain('"assignedToId":"me"');
  });

  it('NEGATIVE: a viewer with no orders key at all matches no order', async () => {
    h.who.current = person('me', ALL);
    await one(new Request('http://x/y'), asParams());
    expect(whereOf(h.db.order.findMany)).toMatchObject({ AND: [{ id: '__no_access__' }] });
  });

  it('the owner’s window keeps the whole history', async () => {
    h.who.current = attachGrants({ id: 'root', role: 'SUPER_ADMIN', status: 'ACTIVE', companyId: 'c1', permissions: [] } as unknown as SessionUser, { fullAccess: true, grants: {} });
    await one(new Request('http://x/y'), asParams());
    expect(whereOf(h.db.order.findMany)).toEqual({ companyId: 'c1', customerId: 'cu1', AND: [{}] });
  });
});

describe('closing, marking read, assigning, and answering', () => {
  it('ASSIGNED: each lookup carries the scope, and an out-of-scope conversation is refused with nothing written', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue(null);
    expect((await close(json({ status: 'CLOSED' }, 'PATCH'), asParams())).status).toBe(404);
    expect((await read(json({}, 'POST'), asParams())).status).toBe(404);
    expect((await assign(json({ userId: 'other' }, 'POST'), asParams())).status).toBe(404);
    const sent = await sendOutboundMessage('cv1', 'مرحبا');
    expect(sent).toMatchObject({ ok: false, status: 404 });
    for (const call of h.db.whatsAppConversation.findFirst.mock.calls) {
      expect((call[0] as { where: unknown }).where, 'بحث بلا نطاق').toMatchObject({ AND: [MINE_OR_FREE] });
    }
    expect(h.db.whatsAppConversation.findFirst).toHaveBeenCalledTimes(4);
    expect(h.db.whatsAppConversation.update).not.toHaveBeenCalled();
    expect(h.db.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  it('inside her scope all four work', async () => {
    expect((await close(json({ status: 'CLOSED' }, 'PATCH'), asParams())).status).toBe(200);
    expect((await read(json({}, 'POST'), asParams())).status).toBe(200);
    expect((await assign(json({ userId: 'other' }, 'POST'), asParams())).status).toBe(200);
    expect((await sendOutboundMessage('cv1', 'مرحبا')).ok).toBe(true);
  });

  it('NEGATIVE: «كل الشركة» looks conversations up by id and company only', async () => {
    h.who.current = person('me', ALL);
    await close(json({ status: 'CLOSED' }, 'PATCH'), asParams());
    await read(json({}, 'POST'), asParams());
    await assign(json({ userId: 'other' }, 'POST'), asParams());
    await sendOutboundMessage('cv1', 'مرحبا');
    for (const call of h.db.whatsAppConversation.findFirst.mock.calls) {
      expect((call[0] as { where: unknown }).where).toEqual({ id: 'cv1', companyId: 'c1' });
    }
  });

  it('NEGATIVE: a sender with NO view scope at all (send without view) is not newly narrowed — the engine never narrowed her', async () => {
    h.who.current = person('me', { 'whatsapp.send': { scope: 'ALL_COMPANY' } });
    await sendOutboundMessage('cv1', 'مرحبا');
    expect((h.db.whatsAppConversation.findFirst.mock.calls[0][0] as { where: unknown }).where).toEqual({ id: 'cv1', companyId: 'c1' });
  });
});
