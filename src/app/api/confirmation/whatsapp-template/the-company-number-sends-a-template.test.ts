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
    order: { update: vi.fn(), updateMany: vi.fn() },
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

const fetchMock = vi.fn();

const COMPANY = { byDialCode: { '962': 'COMPANY', '963': 'AGENT' }, templateName: 'no_answer_followup', templateLang: 'ar', templateParams: 'name_order' };
const AGENT_PERMS = ['whatsapp.send', 'confirmation.work', 'orders.contact_log', 'orders.claim'];

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/confirmation/whatsapp-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  forgetAfterNoAnswer();
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
