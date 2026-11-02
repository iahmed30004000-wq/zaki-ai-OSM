import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * SALMA CONFIRMED AN ORDER AND THE CUSTOMER CHANGED THE ADDRESS (the owner, 2/11).
 *
 * «بدي التعديل التأجيل أو الالغاء … أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية مرحلة الشحنة. مجرد ما الشحنة اتوزعت ع شركة شحن
 * ودخلت باتش ما بقدرو يعدلو، بصير يقدمو طلب تعديل.»
 *
 * THE RAISING DOOR, THROUGH THE REAL PERMISSION ENGINE. Each person is built the way a session is (`computeEffectiveGrants` +
 * `attachGrants`) and the REAL `can`, `mayDecide`, `orderSeal` and `handedToCourier` answer. Only the database and the side
 * effects are fakes. The keys are the live CONFIRMATION_AGENT role (22, 1/11) plus the one the owner ticks for her (no migration grants it).
 *
 * WHAT IS HELD, as rows: the holder with the key, on her own confirmed order in no batch, is APPLIED AT ONCE for an edit (with and
 * without a figure), a postponement and a cancellation — with a decision note that says so, a named decider, no notification and an
 * audit row of the shape it always had; and every neighbour of that row is what it was: a colleague’s order, an order on a
 * trolley, with the courier, a printed waybill (an EDIT only), no key, a figure without the price key.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, assertOrderAccess, createNotification, logAudit } = vi.hoisted(() => ({
  db: {
    orderChangeRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(async (..._a: unknown[]) => ({})) },
    shippingBatch: { findFirst: vi.fn() },
    order: { findFirst: vi.fn() },
    orderNote: { create: vi.fn() },
  },
  requireContext: vi.fn(),
  assertOrderAccess: vi.fn(),
  createNotification: vi.fn(async (..._a: unknown[]) => 1),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/rbac', () => ({
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
  assertOrderReadable: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/notification', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('@/lib/notify', () => ({ afterResponse: (fn: () => Promise<void>) => void fn() }));

import { attachGrants } from '@/lib/authorization';
import { computeEffectiveGrants } from '@/lib/permissions-core';
import { EDIT_WINDOW_NOTE_AR } from '@/lib/edit-confirmed-window';
import { POST } from './route';

const LIVE_AGENT = [
  'ai.assist', 'ai.use', 'confirmation.issues', 'confirmation.issues_correct', 'confirmation.pull', 'confirmation.raise_issue',
  'confirmation.reassign', 'confirmation.supervise', 'confirmation.winback', 'confirmation.work', 'customers.view_basic', 'insights.view',
  'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit', 'orders.note', 'orders.rating_link',
  'orders.release', 'orders.request_change', 'orders.view',
];
const WITH_KEY = [...LIVE_AGENT, 'orders.edit_confirmed'];
const NO_PRICE = WITH_KEY.filter((k) => k !== 'orders.change_price');
const SUPERVISOR = ['orders.view', 'orders.request_change', 'control.change_requests', 'control.change_requests_view', 'orders.change_price'];
const WAREHOUSE_HAND = ['orders.view', 'orders.request_change', 'ops.decide_changes', 'ops.ship', 'orders.change_price'];

async function person(id: string, role: string, keys: string[]): Promise<SessionUser> {
  const base = { id, email: `${id}@x`, name: id, role, roleId: `r-${id}`, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants = await computeEffectiveGrants(base as never, {
    roleRows: async () => keys.map((k) => ({ permission: k, scope: 'ALL_COMPANY', scopeIds: null })),
    overrideRows: async () => [],
  });
  return attachGrants(base, grants);
}

const COUNTRY = { workHoursStart: '09:00', workHoursEnd: '17:00', weekendDays: [5], timezone: 'Asia/Amman' };

/** A confirmed order Salma holds, in no batch, nothing printed, nothing shipped. */
const confirmed = (over: Record<string, unknown> = {}) => ({
  id: 'o1', companyId: 'c1', storeId: 's1', orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED',
  shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, claimedById: 'salma', shippingBatchId: null,
  ...over,
});

const EDIT = { intent: 'EDIT', reason: 'الزبون غيّر العنوان بالتلفون', changes: { customerAddress: { to: 'شارع جديد' } } };
const EDIT_MONEY = { intent: 'EDIT', reason: 'الزبون زاد الكمية بالتلفون', changes: { quantity: { to: 5 } } };
const POSTPONE = { intent: 'POSTPONE', reason: 'الزبون مسافر', postponeUntil: new Date(Date.now() + 5 * 86_400_000).toISOString() };
const CANCEL = { intent: 'CANCEL', reason: 'الزبون تراجع بالاتصال', cancelReason: 'CUSTOMER_CHANGED_MIND' };

const OLD_NOTE = 'طُبِّق مباشرةً — رافعُه يملك البتَّ فيه، والطرد لم يُسلَّم لشركة الشحن بعد.';

async function raise(user: SessionUser, order: Record<string, unknown>, body: Record<string, unknown>, batch: Record<string, unknown> | null = null) {
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1', country: COUNTRY });
  assertOrderAccess.mockResolvedValue({ allowed: true, order });
  db.shippingBatch.findFirst.mockResolvedValue(batch);
  const res = await POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'o1' }) }
  );
  // The notification is sent after the response: let it run before looking.
  await new Promise((r) => setTimeout(r, 0));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const decided = () => (db.orderChangeRequest.update.mock.calls[0] as unknown as [{ where: { id: string }; data: Record<string, unknown> }] | undefined)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  db.orderChangeRequest.findFirst.mockResolvedValue(null);
  db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
  db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
  db.shippingBatch.findFirst.mockResolvedValue(null);
});

describe('Ⅰ · the holder, with the key, on her own confirmed order in no batch — applied at once', () => {
  it.each([
    ['an edit that moves no figure (the address)', EDIT],
    ['an edit that moves a figure (the quantity), she holding the price key too', EDIT_MONEY],
    ['a postponement', POSTPONE],
    ['a cancellation', CANCEL],
  ])('%s ⇒ approved on the spot by HER, with the note that says which rule', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await raise(salma, confirmed(), body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.readyToApply).toBe(true);
    expect(res.body.viaEditWindow).toBe(true);
    expect(decided()).toBeDefined();
    expect(decided()!.where).toEqual({ id: 'cr1' });
    expect(decided()!.data).toMatchObject({ status: 'APPROVED', decidedById: 'salma', decisionNote: EDIT_WINDOW_NOTE_AR });
    expect(decided()!.data.decidedAt).toBeInstanceOf(Date);
  });

  it('and nobody is told — she decided it herself, and a notice to a supervisor about a thing already done is noise', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await raise(salma, confirmed(), EDIT);

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('and the audit row and the order note are the ones a request always had — the shape is unchanged', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    await raise(salma, confirmed(), EDIT);
    const hers = { audit: logAudit.mock.calls[0][0], note: db.orderNote.create.mock.calls[0][0] };
    vi.clearAllMocks();
    db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
    db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    await raise(sup, confirmed(), EDIT);
    const his = { audit: logAudit.mock.calls[0][0], note: db.orderNote.create.mock.calls[0][0] };

    expect(hers.audit.action).toBe('CHANGE_REQUEST_RAISED');
    expect(Object.keys(hers.audit).sort()).toEqual(Object.keys(his.audit).sort());
    expect(Object.keys(hers.audit.newData).sort()).toEqual(Object.keys(his.audit.newData).sort());
    expect(hers.audit).toMatchObject({ userId: 'salma', entity: 'Order', entityId: 'o1', newData: { requestId: 'cr1', intent: 'EDIT' } });
    expect(hers.note.data).toMatchObject({ authorId: 'salma', kind: 'internal', orderId: 'o1' });
    expect(Object.keys(hers.note.data).sort()).toEqual(Object.keys(his.note.data).sort());
  });

  it('the request is raised by her and stored as hers — the self-decision records a named decider, not a row that appeared approved', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    await raise(salma, confirmed(), EDIT);

    expect(db.orderChangeRequest.create.mock.calls[0][0].data).toMatchObject({ requestedById: 'salma', orderId: 'o1', intent: 'EDIT' });
    expect(decided()!.data.decidedById).toBe('salma');
  });
});

describe('Ⅱ · a figure without the price key — the money rule is exactly what it was', () => {
  it('the same agent without orders.change_price ⇒ a quantity WAITS for a decider; an address does not', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', NO_PRICE);

    const money = await raise(salma, confirmed(), EDIT_MONEY);
    expect(money.status).toBe(201);
    expect(money.body.readyToApply).toBe(false);
    expect(money.body.viaEditWindow).toBe(false);
    expect(decided()).toBeUndefined();
    // …and it goes to the people who decide, as any waiting request does.
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][0]).toMatchObject({ audience: { permission: 'control.change_requests' } });

    vi.clearAllMocks();
    db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
    db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    const address = await raise(salma, confirmed(), EDIT);
    expect(address.body.readyToApply).toBe(true);
    expect(address.body.viaEditWindow).toBe(true);
  });

  it.each([
    ['a price', { sellingPrice: { to: 60 } }],
    ['a discount', { discountAmount: { to: 5 } }],
    ['a product', { productId: { to: '33333333-3333-4333-8333-333333333333' } }],
  ])('and %s waits the same way', async (_name, changes) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', NO_PRICE);

    const res = await raise(salma, confirmed(), { intent: 'EDIT', reason: 'الزبون طلب هذا', changes });

    expect(res.body.readyToApply).toBe(false);
    expect(decided()).toBeUndefined();
  });
});

describe('Ⅲ · every neighbour of that row is what it was — she waits for a decision', () => {
  const PENDING_ALL = [['an edit', EDIT], ['a postponement', POSTPONE], ['a cancellation', CANCEL]] as const;

  it.each(PENDING_ALL)('%s on a COLLEAGUE’s order ⇒ pending — an agent acting on somebody else’s order still waits', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await raise(salma, confirmed({ claimedById: 'someone-else' }), body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ readyToApply: false, viaEditWindow: false });
    expect(decided()).toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it.each(PENDING_ALL)('%s on an order NOBODY holds ⇒ pending', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await raise(salma, confirmed({ claimedById: null }), body);

    expect(res.body.readyToApply).toBe(false);
    expect(decided()).toBeUndefined();
  });

  it.each(PENDING_ALL)('%s on HER order once it is on a trolley still being filled (READY, not handed) ⇒ pending — the packing table decides, as today', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const onTheTrolley = confirmed({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' });

    const res = await raise(salma, onTheTrolley, body, { status: 'READY', batchNumber: 'B-1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ readyToApply: false, viaEditWindow: false });
    expect(decided()).toBeUndefined();
  });

  it.each(PENDING_ALL)('%s when the order NAMES a trolley whose row cannot be read ⇒ pending — a batch named is a batch', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await raise(salma, confirmed({ shippingBatchId: 'b-gone' }), body, null);

    expect(res.body.readyToApply).toBe(false);
    expect(decided()).toBeUndefined();
  });

  it('the trolley was pressed («سُلّمت للشركة») ⇒ an edit and a cancellation are pending; a postponement is refused at the door', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const gone = confirmed({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' });
    const pressed = { status: 'SHIPPED', batchNumber: 'B-1' };

    expect((await raise(salma, gone, EDIT, pressed)).body.readyToApply).toBe(false);
    expect((await raise(salma, gone, CANCEL, pressed)).body.readyToApply).toBe(false);
    const hold = await raise(salma, gone, POSTPONE, pressed);
    expect(hold.status).toBe(409);
    expect(hold.body.code).toBe('INTENT_IMPOSSIBLE');
    expect(decided()).toBeUndefined();
  });

  it('shipped by itself, in NO batch (marked shipped by hand) ⇒ the same: the courier has it', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const byHand = confirmed({ shippingStatus: 'SHIPPED', shippedAt: new Date() });

    expect((await raise(salma, byHand, EDIT)).body.readyToApply).toBe(false);
    expect((await raise(salma, byHand, CANCEL)).body.readyToApply).toBe(false);
    expect((await raise(salma, byHand, POSTPONE)).status).toBe(409);
    expect(decided()).toBeUndefined();
  });

  it('A PRINTED WAYBILL, in no batch (a parcel held off its trolley) ⇒ an EDIT is pending (the seal is on top) and a cancel or a hold are applied (their line is the handover)', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);
    const labelled = confirmed({ shippingStatus: 'READY_FOR_PICKUP', labelPrintedAt: new Date('2026-11-01T08:00:00Z') });

    const edit = await raise(salma, labelled, EDIT);
    expect(edit.body).toMatchObject({ readyToApply: false, viaEditWindow: false });
    expect(decided()).toBeUndefined();

    for (const body of [CANCEL, POSTPONE]) {
      vi.clearAllMocks();
      db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
      db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
      db.orderChangeRequest.findFirst.mockResolvedValue(null);
      const res = await raise(salma, labelled, body);
      expect(res.body, JSON.stringify(body)).toMatchObject({ readyToApply: true, viaEditWindow: true });
    }
  });

  it.each(PENDING_ALL)('%s WITHOUT the key (the live role as it was on 1/11) ⇒ pending — exactly as today', async (_name, body) => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', LIVE_AGENT);

    const res = await raise(salma, confirmed(), body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ readyToApply: false, viaEditWindow: false });
    expect(decided()).toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('the key without the right to raise a request at all ⇒ refused at the door, as before', async () => {
    const odd = await person('salma', 'CONFIRMATION_AGENT', ['orders.view', 'confirmation.work', 'orders.edit_confirmed']);

    const res = await raise(odd, confirmed(), EDIT);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REQUEST_CHANGE_FORBIDDEN');
    expect(db.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('BEFORE confirmation she decides as she always did — old note, and the window is not what let her', async () => {
    const salma = await person('salma', 'CONFIRMATION_AGENT', WITH_KEY);

    const res = await raise(salma, confirmed({ confirmationStatus: 'IN_PROGRESS' }), EDIT);

    expect(res.body).toMatchObject({ readyToApply: true, viaEditWindow: false });
    expect(decided()!.data.decisionNote).toBe(OLD_NOTE);
  });
});

describe('Ⅳ · everybody else is untouched — the old note, byte for byte, and no «via»', () => {
  it('a supervisor decides a request on a trolley, as ever', async () => {
    const sup = await person('sup', 'CONFIRMATION_SUPERVISOR', SUPERVISOR);

    const res = await raise(sup, confirmed({ shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' }), EDIT, { status: 'READY', batchNumber: 'B-1' });

    expect(res.body).toMatchObject({ readyToApply: true, viaEditWindow: false });
    expect(decided()!.data).toMatchObject({ status: 'APPROVED', decidedById: 'sup', decisionNote: OLD_NOTE });
  });

  it('a supervisor who ALSO holds the key keeps the old sentence on her own order — the earlier rule let her', async () => {
    const sup = await person('salma', 'CONFIRMATION_SUPERVISOR', [...SUPERVISOR, 'orders.edit_confirmed']);

    const res = await raise(sup, confirmed(), EDIT);

    expect(res.body).toMatchObject({ readyToApply: true, viaEditWindow: false });
    expect(decided()!.data.decisionNote).toBe(OLD_NOTE);
  });

  it('the packing table decides a request on an order on its floor, as ever — and not one that left', async () => {
    const hand = await person('hand', 'WAREHOUSE', WAREHOUSE_HAND);
    const onTheTrolley = confirmed({ claimedById: 'salma', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: 'b1' });

    const yes = await raise(hand, onTheTrolley, CANCEL, { status: 'READY', batchNumber: 'B-1' });
    expect(yes.body).toMatchObject({ readyToApply: true, viaEditWindow: false });
    expect(decided()!.data.decisionNote).toBe(OLD_NOTE);

    vi.clearAllMocks();
    db.orderChangeRequest.create.mockImplementation(async ({ data }: any) => ({ id: 'cr1', ...data }));
    db.order.findFirst.mockResolvedValue({ quantity: 1, productId: 'p1', sellingPrice: 10, discountAmount: 0, customerNotes: null, regionId: null, deliveryAddress: null, customer: {} });
    db.orderChangeRequest.findFirst.mockResolvedValue(null);
    const no = await raise(hand, onTheTrolley, EDIT, { status: 'SHIPPED', batchNumber: 'B-1' });
    expect(no.body.readyToApply).toBe(false);
  });

  it('the owner (SUPER_ADMIN) decides his own request anywhere, with the old sentence', async () => {
    const owner = await person('owner', 'SUPER_ADMIN', []);

    const res = await raise(owner, confirmed({ claimedById: 'someone-else' }), CANCEL);

    expect(res.body).toMatchObject({ readyToApply: true, viaEditWindow: false });
    expect(decided()!.data).toMatchObject({ decidedById: 'owner', decisionNote: OLD_NOTE });
  });

  it('a moderator with neither the key nor a deciding role is still pending on a confirmed order', async () => {
    const mod = await person('mod', 'MODERATOR', ['orders.view', 'orders.request_change']);

    const res = await raise(mod, confirmed({ claimedById: null }), EDIT);

    expect(res.body.readyToApply).toBe(false);
    expect(decided()).toBeUndefined();
  });
});
