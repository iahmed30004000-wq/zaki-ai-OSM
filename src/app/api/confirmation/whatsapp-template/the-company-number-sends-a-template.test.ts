import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «ابعت من رقم الشركة» — the door. Every refusal hands the agent back her own WhatsApp (`fallback: true`) and makes no
 * network call; a send is one Graph call with the template, one TEMPLATE message, one WHATSAPP · MESSAGE_SENT line, and
 * nothing written to the order.
 */

const { state, db, assertOrderAccess, logAudit } = vi.hoisted(() => {
  const state = {
    perms: new Set<string>(),
    order: null as null | Record<string, unknown>,
    settings: {} as Record<string, unknown>,
    connected: true,
    seq: 0,
    // The order she let go (the exception of ruling 7): her counted press's history line, and what the order looks like now.
    line: null as null | { userId: string; reason: string },
    pullable: null as null | { id: string; orderNumber: string; customerId: string; countryId: string | null },
  };
  const db = {
    company: { findUnique: vi.fn(async () => ({ settings: JSON.stringify(state.settings) })) },
    country: { findFirst: vi.fn(async () => ({ code: 'JO' })) },
    customer: { findFirst: vi.fn(async () => ({ id: 'cu1', fullName: 'سارة', rawPhone: '0791234567' })) },
    whatsAppConversation: {
      upsert: vi.fn(async (_a: unknown) => ({ id: 'conv1' })),
      update: vi.fn(async (_a: unknown) => ({})),
    },
    whatsAppMessage: { create: vi.fn(async (_a: unknown) => ({ id: 'msg1' })) },
    whatsAppConnection: { update: vi.fn(async (_a: unknown) => ({})) },
    orderContactAttempt: {
      findFirst: vi.fn(async () => ({ attemptNumber: 2 })),
      create: vi.fn(async (_a: unknown) => ({ id: 'att1' })),
    },
    // The two reads of the exception answer by their `where`, like the database: a line of another person or another reason is no line.
    orderClaimHistory: {
      findFirst: vi.fn(async (a: { where: { userId: string; reason: string; action: string } }) =>
        state.line && a.where.userId === state.line.userId && a.where.reason === state.line.reason && a.where.action === 'RELEASED' ? { id: 'h1' } : null
      ),
    },
    order: { update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(async () => state.pullable) },
    $transaction: vi.fn(),
  };
  return { state, db, assertOrderAccess: vi.fn(), logAudit: vi.fn(async (_a: unknown) => undefined) };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({
    user: { id: 'agent1', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
    companyId: 'c1',
    storeId: 's1',
    country: { code: 'JO' },
  }),
}));
vi.mock('@/lib/authorization', async (orig) => ({
  ...(await orig<typeof import('@/lib/authorization')>()),
  can: (_u: unknown, p: string) => state.perms.has(p),
}));
vi.mock('@/lib/rbac', async (orig) => ({
  ...(await orig<typeof import('@/lib/rbac')>()),
  assertOrderAccess: (...a: unknown[]) => assertOrderAccess(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (a: unknown) => logAudit(a) }));
vi.mock('@/lib/whatsapp/config', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/config')>()),
  getAccessToken: () => 'SECRET-TOKEN-123',
  getPhoneNumberId: () => 'pn1',
}));
vi.mock('@/lib/whatsapp/connection', () => ({
  getActiveConnection: async () => ({ id: 'w1', status: 'CONNECTED' }),
  effectiveStatus: () => (state.connected ? 'CONNECTED' : 'NEEDS_SETUP'),
}));

import { POST } from './route';
import { forgetAfterNoAnswer } from '@/lib/whatsapp/after-no-answer';
import { ORDER_WORK_DOOR } from '@/lib/order-work-door';
import { forgetCallProofSwitch } from '@/lib/call-proof-switch';
import { forgetRoundsSwitch } from '@/lib/no-answer-rounds-switch';
import { forgetReturnsSwitch } from '@/lib/no-answer-returns-switch';
import { NOT_HELD_MESSAGE, OPEN_CONFIRMATION, RETURNED_PRESS_GRACE_MS } from '@/lib/confirmation-queue';
import { NO_ANSWER_RETURNED_REASON } from '@/lib/no-answer-returns';

const fetchMock = vi.fn();

const COMPANY = { byDialCode: { '962': 'COMPANY', '963': 'AGENT' }, templateName: 'no_answer_followup', templateLang: 'ar', templateParams: 'name_order' };
const AGENT_PERMS = ['whatsapp.send', 'confirmation.work', 'orders.contact_log', 'orders.claim'];

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/confirmation/whatsapp-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  forgetAfterNoAnswer();
  forgetCallProofSwitch();
  state.line = null;
  state.pullable = null;
  state.seq += 1;
  state.perms = new Set(AGENT_PERMS);
  state.order = {
    id: `o${state.seq}`,
    orderNumber: 'ORD-2026-0042',
    customerId: 'cu1',
    countryId: 'jo',
    claimedById: 'agent1',
    confirmationStatus: 'NO_ANSWER',
    companyId: 'c1',
    storeId: 's1',
  };
  state.settings = { whatsappAfterNoAnswer: COMPANY };
  state.connected = true;
  assertOrderAccess.mockImplementation(async () => ({ allowed: true, order: state.order }));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const expectNothingWritten = () => {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.whatsAppMessage.create).not.toHaveBeenCalled();
  expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
  expect(db.order.update).not.toHaveBeenCalled();
  expect(db.order.updateMany).not.toHaveBeenCalled();
};

describe('who may press it', () => {
  it('refuses without whatsapp.send — and hands her own WhatsApp back', async () => {
    state.perms.delete('whatsapp.send');
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ fallback: true, error: expect.stringMatching(/[؀-ۿ]/) });
    expect(assertOrderAccess).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses an order outside what she may work on (the work door says no)', async () => {
    assertOrderAccess.mockImplementation(async () => ({ allowed: false, reason: 'NOT_ASSIGNED' }));
    const res = await post({ orderId: 'o-other' });
    expect(res.status).toBe(404);
    expectNothingWritten();
  });

  it('refuses an order she does not hold, when she must hold to work', async () => {
    state.order = { ...state.order!, claimedById: 'colleague' };
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_HELD');
    expectNothingWritten();
  });

  it('asks the door the other call-sheet presses use', async () => {
    await post({ orderId: 'o1' });
    expect(assertOrderAccess).toHaveBeenCalledWith('o1', expect.objectContaining({ id: 'agent1' }), { companyId: 'c1', storeId: 's1' }, ORDER_WORK_DOOR);
  });
});

describe('when the company number is not the way', () => {
  it('the country is on the agent’s WhatsApp — fallback, no network call', async () => {
    db.country.findFirst.mockImplementationOnce(async () => ({ code: 'SY' }));
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fallback: true, code: 'ROUTE_IS_AGENT' });
    expectNothingWritten();
  });

  it('nothing saved at all — AGENT, fallback, no network call', async () => {
    state.settings = {};
    const res = await post({ orderId: 'o1' });
    expect((await res.json()).fallback).toBe(true);
    expectNothingWritten();
  });

  it('not connected — fallback, no network call', async () => {
    state.connected = false;
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fallback: true, code: 'NOT_CONNECTED' });
    expectNothingWritten();
  });

  it('a customer with no phone at all — its own sentence, not «the country code is missing»', async () => {
    db.customer.findFirst.mockImplementationOnce(async () => ({ id: 'cu1', fullName: 'سارة', rawPhone: '' }));
    const res = await post({ orderId: 'o1' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ fallback: true, code: 'NO_PHONE' });
    expect(body.error).toMatch(/ما في رقم للزبون/);
    expect(body.error).not.toMatch(/رمز الدولة/);
    expectNothingWritten();
  });

  it('a «number» with no digit in it is no number either', async () => {
    db.customer.findFirst.mockImplementationOnce(async () => ({ id: 'cu1', fullName: 'سارة', rawPhone: ' — ' }));
    expect(await (await post({ orderId: 'o1' })).json()).toMatchObject({ fallback: true, code: 'NO_PHONE' });
    expectNothingWritten();
  });

  it('no template named — fallback, no network call', async () => {
    state.settings = { whatsappAfterNoAnswer: { ...COMPANY, templateName: '' } };
    const res = await post({ orderId: 'o1' });
    expect(await res.json()).toMatchObject({ fallback: true, code: 'NO_TEMPLATE' });
    expectNothingWritten();
  });
});

describe('COMPANY and connected', () => {
  it('calls Graph once with the template, writes a TEMPLATE message and the contact line, and leaves the order alone', async () => {
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, logged: true });
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/graph\.facebook\.com\/v[\d.]+\/pn1\/messages$/);
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '962791234567',
      type: 'template',
      template: {
        name: 'no_answer_followup',
        language: { code: 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'سارة' }, { type: 'text', text: 'ORD-2026-0042' }] }],
      },
    });

    expect(db.whatsAppConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId_connectionId_customerPhone: { companyId: 'c1', connectionId: 'w1', customerPhone: '962791234567' } } })
    );
    expect(db.whatsAppMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ messageType: 'TEMPLATE', direction: 'OUTBOUND', externalMessageId: 'wamid.ABC', status: 'SENT' }),
    });
    expect(db.orderContactAttempt.create).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: state.order!.id, contactMethod: 'WHATSAPP', result: 'MESSAGE_SENT', attemptNumber: 3, employeeId: 'agent1' }),
    });
    // Not a no-answer, not a state change: the order row is never written, and the line is not one the 1/2/3 close reads.
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    const line = (db.orderContactAttempt.create.mock.calls[0][0] as { data: { result: string } }).data.result;
    expect(['NO_ANSWER', 'BUSY', 'UNREACHABLE']).not.toContain(line);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'whatsapp.template.send', entityId: state.order!.id }));
  });

  it('a template with no blanks sends no components', async () => {
    state.settings = { whatsappAfterNoAnswer: { ...COMPANY, templateParams: 'none' } };
    await post({ orderId: state.order!.id });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).template).toEqual({ name: 'no_answer_followup', language: { code: 'ar' } });
  });

  it('a second press on the same order a moment later is not a second message', async () => {
    expect((await post({ orderId: state.order!.id })).status).toBe(200);
    const again = await post({ orderId: state.order!.id });
    expect(again.status).toBe(429);
    expect((await again.json()).fallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a send Meta refused does not use up the order’s slot — the next press goes', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 400 }));
    expect((await post({ orderId: state.order!.id })).status).toBe(502);
    expect((await post({ orderId: state.order!.id })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.whatsAppMessage.create).toHaveBeenCalledTimes(1);
  });

  it('a role without the contact-log key sends, and is told the line is missing', async () => {
    state.perms.delete('orders.contact_log');
    const res = await post({ orderId: state.order!.id });
    expect(await res.json()).toEqual({ ok: true, logged: false });
    expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
  });

  it('Meta says no — fallback 502, nothing stored, the token nowhere in the answer', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Template name does not exist', code: 132001 } }), { status: 400 }));
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.error).toMatch(/[؀-ۿ]/);
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
    expect(db.whatsAppMessage.create).not.toHaveBeenCalled();
    expect(db.orderContactAttempt.create).not.toHaveBeenCalled();
    expect(db.order.update).not.toHaveBeenCalled();
  });
});

/**
 * THE ORDER SHE JUST LET GO (the owner's ruling 7).
 *
 * With «جدول المحاولات» on, her counted «لا يرد» sends the order back to the queue in the same press, and the call sheet offers this button AFTER the press
 * landed. So the door that used to refuse an order she no longer holds accepts ONE kind of unheld order: the one her own press released in the last two
 * minutes (`RELEASED` / `NO_ANSWER_RETURNED`, her own `userId`), that nobody has pulled since, still open at the desk and never shipped. Both refusals —
 * 404 for a bound agent whose scope does not reach it, 403 NOT_HELD for one whose scope does — stay what they were for everything else.
 *
 * ONLY THE PLAN'S (the planner 15/11, answer 14): the older «الطلب يرجع للطابور فوراً» mode with the plan off keeps both refusals as they were (RV1651 stays open for
 * it) — pinned below — and with everything off the door reads nothing new on a refusal and nothing at all on a held order.
 */
const PLAN_ON = { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };
const LET_GO = (id: string) => ({ id, orderNumber: 'ORD-2026-0042', customerId: 'cu1', countryId: 'jo' });

/** The plan is on, she pressed «لا يرد» a moment ago, the order is unheld and the sheet's door (`assertOrderAccess`) says what it says for an unheld one. */
const letGoOrder = (access: 'NOT_HELD' | 'NOT_ASSIGNED' = 'NOT_HELD') => {
  state.settings = { whatsappAfterNoAnswer: COMPANY, callProofAndCadence: PLAN_ON };
  forgetCallProofSwitch();
  forgetAfterNoAnswer();
  state.order = { ...state.order!, claimedById: null };
  state.line = { userId: 'agent1', reason: NO_ANSWER_RETURNED_REASON };
  state.pullable = LET_GO(state.order.id as string);
  if (access === 'NOT_ASSIGNED') assertOrderAccess.mockImplementation(async () => ({ allowed: false, reason: 'NOT_ASSIGNED' }));
};
const neitherRead = () => {
  expect(db.orderClaimHistory.findFirst).not.toHaveBeenCalled();
  expect(db.order.findFirst).not.toHaveBeenCalled();
};

describe('ON — the order her own press just released', () => {
  it('a bound agent whose scope reaches the order (403 NOT_HELD before): sent, once, and the audit row says why', async () => {
    letGoOrder();
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logged: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.whatsAppMessage.create).toHaveBeenCalledTimes(1);
    expect(db.orderContactAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: state.order!.id, contactMethod: 'WHATSAPP', result: 'MESSAGE_SENT', employeeId: 'agent1' }),
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'whatsapp.template.send', entityId: state.order!.id, newData: expect.objectContaining({ afterHerOwnPress: true, templateName: 'no_answer_followup' }) })
    );
    // The order row is never written: not a claim, not a status, not a date.
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a bound agent whose scope does NOT reach it (404 NOT_ASSIGNED before): sent too — the exception sits on both refusals', async () => {
    letGoOrder('NOT_ASSIGNED');
    const res = await post({ orderId: state.order!.id });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await res.json()).toEqual({ ok: true, logged: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ newData: expect.objectContaining({ afterHerOwnPress: true }) }));
  });

  it('asks the two questions exactly: HER line, from the last two minutes, and an order nobody holds, still open, never shipped, in her store', async () => {
    letGoOrder();
    const before = Date.now();
    await post({ orderId: state.order!.id });
    const after = Date.now();

    expect(db.orderClaimHistory.findFirst).toHaveBeenCalledTimes(1);
    const history = (db.orderClaimHistory.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown> & { createdAt: { gt: Date } } }])[0].where;
    expect(history).toMatchObject({ companyId: 'c1', orderId: state.order!.id, userId: 'agent1', action: 'RELEASED', reason: 'NO_ANSWER_RETURNED' });
    // The one pinned constant (120 s), measured from the moment of the press.
    expect(RETURNED_PRESS_GRACE_MS).toBe(120_000);
    expect(before - history.createdAt.gt.getTime()).toBeGreaterThanOrEqual(RETURNED_PRESS_GRACE_MS - 1_000);
    expect(after - history.createdAt.gt.getTime()).toBeLessThanOrEqual(RETURNED_PRESS_GRACE_MS + 5_000);

    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
    const order = (db.order.findFirst.mock.calls[0] as unknown as [{ where: Record<string, unknown>; select: Record<string, boolean> }])[0];
    expect(order.where).toEqual({
      id: state.order!.id,
      companyId: 'c1',
      storeId: 's1',
      claimedById: null,
      confirmationStatus: { in: OPEN_CONFIRMATION },
      shippingStatus: 'NOT_READY',
      shippingBatchId: null,
      trackingNumber: null,
      labelPrintedAt: null,
    });
    expect(order.select).toEqual({ id: true, orderNumber: true, customerId: true, countryId: true });
  });
});

describe('ON — and nothing else is let through: each answers today’s refusal and sends and writes nothing', () => {
  it('no line of hers (never pressed, or a line from the earlier window) — 403 NOT_HELD for the held-scope agent', async () => {
    letGoOrder();
    state.line = null;
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_HELD');
    expect(db.order.findFirst, 'the order is not even read without her line').not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('no line of hers — 404 for the agent whose scope does not reach it', async () => {
    letGoOrder('NOT_ASSIGNED');
    state.line = null;
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(404);
    expectNothingWritten();
  });

  it('her line, but a colleague pulled the order since (or it was closed, or shipped) — the order read finds nothing: NOT_HELD', async () => {
    letGoOrder();
    state.pullable = null;
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_HELD');
    expect(db.order.findFirst).toHaveBeenCalledTimes(1);
    expectNothingWritten();
  });

  it.each(['DATE_RETURNED', 'AUTO_RELEASE_IDLE_RETURNED', 'MANUAL_RELEASE'])('a line of another reason (%s) is not her «لا يرد» — refused as before', async (reason) => {
    letGoOrder();
    state.line = { userId: 'agent1', reason };
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(403);
    expect(db.order.findFirst).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('a line written for a COLLEAGUE’s press is not hers — refused as before', async () => {
    letGoOrder();
    state.line = { userId: 'colleague', reason: NO_ANSWER_RETURNED_REASON };
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(403);
    expectNothingWritten();
  });

  it('without whatsapp.send nothing is asked at all', async () => {
    letGoOrder();
    state.perms.delete('whatsapp.send');
    const res = await post({ orderId: state.order!.id });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('WHATSAPP_SEND_NOT_ALLOWED');
    expect(assertOrderAccess).not.toHaveBeenCalled();
    neitherRead();
    expectNothingWritten();
  });

  it('the exception replaces the hold check and NOTHING after it: a country on her own WhatsApp, no template, not connected, no phone — still refused', async () => {
    letGoOrder();
    db.country.findFirst.mockImplementationOnce(async () => ({ code: 'SY' }));
    expect(await (await post({ orderId: state.order!.id })).json()).toMatchObject({ fallback: true, code: 'ROUTE_IS_AGENT' });
    expectNothingWritten();

    letGoOrder();
    state.settings = { whatsappAfterNoAnswer: { ...COMPANY, templateName: '' }, callProofAndCadence: PLAN_ON };
    forgetAfterNoAnswer();
    expect(await (await post({ orderId: state.order!.id })).json()).toMatchObject({ code: 'NO_TEMPLATE' });
    expectNothingWritten();

    letGoOrder();
    state.connected = false;
    expect(await (await post({ orderId: state.order!.id })).json()).toMatchObject({ code: 'NOT_CONNECTED' });
    expectNothingWritten();

    letGoOrder();
    state.connected = true;
    db.customer.findFirst.mockImplementationOnce(async () => ({ id: 'cu1', fullName: 'سارة', rawPhone: '' }));
    expect(await (await post({ orderId: state.order!.id })).json()).toMatchObject({ code: 'NO_PHONE' });
    expectNothingWritten();
  });

  it('a second press within a minute is not a second message — the per-order dedupe holds on the exception too', async () => {
    letGoOrder();
    expect((await post({ orderId: state.order!.id })).status).toBe(200);
    const again = await post({ orderId: state.order!.id });
    expect(again.status).toBe(429);
    expect((await again.json()).code).toBe('ALREADY_SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OFF — the door is exactly what it was, and asks nothing new', () => {
  it('the plan off and both legacy switches off: the 403 and the 404 are today’s and neither new read is made', async () => {
    state.line = { userId: 'agent1', reason: NO_ANSWER_RETURNED_REASON };
    state.pullable = LET_GO(state.order!.id as string);
    state.order = { ...state.order!, claimedById: 'colleague' };
    const held = await post({ orderId: state.order!.id });
    expect(held.status).toBe(403);
    expect((await held.json()).code).toBe('NOT_HELD');
    neitherRead();

    assertOrderAccess.mockImplementation(async () => ({ allowed: false, reason: 'NOT_ASSIGNED' }));
    expect((await post({ orderId: state.order!.id })).status).toBe(404);
    neitherRead();
    expectNothingWritten();
  });

  /**
   * ANSWER 14 (the planner 15/11): the exception is the PLAN's. A company on the older «الطلب يرجع للطابور فوراً» mode — «نظام الجولات» and its own switch both plainly
   * on, the plan off — also lets the order go with her «لا يرد», but its door is what it was at b1df2af3: the 403 NOT_HELD and the 404, word for word, with her line and
   * the order both there to be found (so a gate that asked `returnsModeOn` instead of the plan's own switch would send, and this would fail).
   */
  it('the OLDER returns mode on and the plan OFF: the 403 and the 404 are today’s — RV1651 stays open for it, and neither new read is made', async () => {
    const LEGACY_ON = { enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };
    state.settings = { whatsappAfterNoAnswer: COMPANY, noAnswerRounds: LEGACY_ON, noAnswerReturns: LEGACY_ON };
    forgetCallProofSwitch();
    forgetRoundsSwitch();
    forgetReturnsSwitch();
    forgetAfterNoAnswer();
    state.line = { userId: 'agent1', reason: NO_ANSWER_RETURNED_REASON };
    state.pullable = LET_GO(state.order!.id as string);
    state.order = { ...state.order!, claimedById: null };

    const held = await post({ orderId: state.order!.id });
    expect(held.status).toBe(403);
    expect(await held.json()).toMatchObject({ code: 'NOT_HELD', error: NOT_HELD_MESSAGE });
    neitherRead();

    assertOrderAccess.mockImplementation(async () => ({ allowed: false, reason: 'NOT_ASSIGNED' }));
    expect((await post({ orderId: state.order!.id })).status).toBe(404);
    neitherRead();
    expectNothingWritten();
  });

  it('the happy path asks neither read either way — zero extra reads when nothing is refused', async () => {
    expect((await post({ orderId: state.order!.id })).status).toBe(200);
    neitherRead();

    letGoOrder();
    state.order = { ...state.order!, id: `${state.order!.id}b`, claimedById: 'agent1' };
    expect((await post({ orderId: state.order!.id })).status).toBe(200);
    neitherRead();
    // …and a send on a HELD order carries no marker: the key exists only on the new path.
    const audit = logAudit.mock.calls.at(-1)![0] as { newData: Record<string, unknown> };
    expect('afterHerOwnPress' in audit.newData).toBe(false);
  });
});
