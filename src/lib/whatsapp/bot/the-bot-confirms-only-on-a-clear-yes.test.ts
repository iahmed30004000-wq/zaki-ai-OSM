import { describe, expect, it, vi } from 'vitest';
import { converse, historyFor, lineForModel } from './engine';
import { complete, LlmError, modelsUrl } from './llm';
import { SYSTEM_PROMPT, systemPromptFor } from './prompt';
import type { BotDoor, BotOrderView } from './door';

/**
 * THE MODEL PROPOSES, THE CODE DECIDES (the owner, 2026-11-26).
 *
 * No real model is called: `fetch` is a script that answers like an OpenAI-compatible server, one reply per call. No order
 * is written: the door is a fake that counts what was asked of it. What is held:
 *  · a confirmation the model asks for is refused until the current amount was written to the customer, and refused
 *    again when the customer's latest words are not a clear yes — the door is never asked;
 *  · with both, the door confirms once;
 *  · a hand-off ends the turn with a goodbye and no further tool;
 *  · the tool calls of a turn are capped;
 *  · the key rides only in the header and never comes back in an error.
 */

const ORDER: BotOrderView = {
  orderNumber: 'A-1001',
  createdAt: '2026-11-26T08:00:00.000Z',
  status: 'NEW',
  shippingStatus: 'NOT_READY',
  editable: true,
  offerChangeAllowed: true,
  product: { id: 'p1', name: 'كريم' },
  offer: { id: 'o1', name: 'قطعة' },
  items: [{ name: 'كريم', quantity: 1, freeQuantity: 0 }],
  currency: 'JOD',
  total: 20,
  cod: 23,
  deliveryFee: 3,
  deliveryIncluded: false,
  feeKnown: true,
  feeExact: true,
  customer: { name: 'سارة', city: 'عمان', address: 'شارع 1', notes: '' },
  offers: [{ id: 'o1', name: 'قطعة', quantity: 1, freeQuantity: 0, price: 20 }],
  cities: ['عمان'],
};

function fakeDoor() {
  const calls = { confirm: 0, amend: 0, offer: 0 };
  const door: BotDoor = {
    orders: async () => [ORDER],
    order: async (n) => (n === ORDER.orderNumber ? ORDER : null),
    product: async () => null,
    amend: async () => {
      calls.amend++;
      return { ok: true, order: ORDER };
    },
    changeOffer: async () => {
      calls.offer++;
      return { ok: true, order: ORDER };
    },
    confirm: async () => {
      calls.confirm++;
      return { ok: true, order: { ...ORDER, status: 'CONFIRMED' } };
    },
  };
  return { door, calls };
}

type Reply = { content?: string; tool?: { name: string; args: Record<string, unknown> } | Array<{ name: string; args: Record<string, unknown> }> };

/** A compatible server, scripted: each call answers the next reply. Records what it was sent. */
function script(replies: Reply[]) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(i++, replies.length - 1)];
    const tools = r.tool ? (Array.isArray(r.tool) ? r.tool : [r.tool]) : [];
    const message = {
      content: r.content ?? '',
      tool_calls: tools.map((t, k) => ({ id: `c${i}-${k}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })),
    };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: tools.length ? 'tool_calls' : 'stop' }] }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, sent };
}

const conn = { baseUrl: 'https://glm.example-host.io/v1', apiKey: 'fake-model-key-for-tests', model: 'glm-test' };

function ctx(door: BotDoor, over: Partial<{ customerText: string; lastCustomerText: string; said: boolean }> = {}) {
  return {
    door,
    customerText: over.customerText ?? 'إي أكدولي الطلب',
    lastCustomerText: over.lastCustomerText ?? over.customerText ?? 'إي أكدولي الطلب',
    amountSaid: async () => over.said ?? true,
    onChanged: async () => {},
  };
}

const CONFIRM = { name: 'confirm_order', args: { order_number: 'A-1001', customer_words: 'إي أكدولي الطلب' } };

describe('a confirmation is the customer’s, read by code', () => {
  it('NEGATIVE: refused while the current amount was not written to them — the door is never asked', async () => {
    const { door, calls } = fakeDoor();
    const { fetchImpl } = script([{ tool: CONFIRM }, { content: 'المبلغ 23 دينار، منأكد؟' }]);
    const out = await converse(conn, 'rules', [], ctx(door, { said: false }), { fetchImpl });
    expect(calls.confirm).toBe(0);
    expect(out.trace[0]).toMatchObject({ name: 'confirm_order', ok: false });
    expect(out.trace[0].error).toMatch(/amount payable/);
  });

  it('NEGATIVE: refused when the latest words are not a clear yes', async () => {
    const { door, calls } = fakeDoor();
    const { fetchImpl } = script([{ tool: { ...CONFIRM, args: { ...CONFIRM.args, customer_words: 'يمكن بعدين' } } }, { content: 'تمام، خبّرني' }]);
    await converse(conn, 'rules', [], ctx(door, { customerText: 'يمكن بعدين' }), { fetchImpl });
    expect(calls.confirm).toBe(0);
  });

  it('NEGATIVE: refused when the model quotes words the customer never wrote', async () => {
    const { door, calls } = fakeDoor();
    const { fetchImpl } = script([{ tool: CONFIRM }, { content: 'شو بتحب؟' }]);
    await converse(conn, 'rules', [], ctx(door, { customerText: 'تمام' }), { fetchImpl });
    expect(calls.confirm).toBe(0);
  });

  it('with the amount said and a clear yes, the door confirms once', async () => {
    const { door, calls } = fakeDoor();
    const { fetchImpl } = script([{ tool: CONFIRM }, { content: 'تمام، تأكد طلبك ✅' }]);
    const out = await converse(conn, 'rules', [], ctx(door), { fetchImpl });
    expect(calls.confirm).toBe(1);
    expect(out.reply).toBe('تمام، تأكد طلبك ✅');
    expect(out.handoff).toBeNull();
  });

  it('an order of somebody else is not found, and nothing is asked of the door', async () => {
    const { door, calls } = fakeDoor();
    const { fetchImpl } = script([{ tool: { name: 'confirm_order', args: { order_number: 'B-9', customer_words: 'إي أكدولي الطلب' } } }, { content: 'ما لقيت هالطلب' }]);
    const out = await converse(conn, 'rules', [], ctx(door), { fetchImpl });
    expect(calls.confirm).toBe(0);
    expect(out.trace[0].error).toMatch(/No such order/);
  });
});

describe('the turn has limits', () => {
  it('a hand-off ends the turn: one goodbye, no further tool', async () => {
    const { door } = fakeDoor();
    const { fetchImpl, sent } = script([{ tool: { name: 'transfer_to_human', args: { reason: 'بدو موظف' } } }, { content: 'رح يكمل معك زميلي' }]);
    const out = await converse(conn, 'rules', [], ctx(door), { fetchImpl });
    expect(out.handoff).toBe('بدو موظف');
    expect(out.reply).toBe('رح يكمل معك زميلي');
    // The goodbye was asked for without tools.
    expect(JSON.parse(String(sent[1].init.body)).tools).toBeUndefined();
  });

  it('NEGATIVE: tool calls beyond the cap are refused, not run', async () => {
    const { door, calls } = fakeDoor();
    const many = Array.from({ length: 12 }, () => ({ name: 'update_customer_details', args: { order_number: 'A-1001', notes: 'بعد الضهر' } }));
    const { fetchImpl } = script([{ tool: many }, { content: 'تمام' }]);
    const out = await converse(conn, 'rules', [], ctx(door), { fetchImpl });
    expect(calls.amend).toBe(8);
    expect(out.trace.filter((t) => !t.ok)).toHaveLength(4);
  });

  it('NEGATIVE: there is no tool to cancel, to price or to create an order', async () => {
    const { door } = fakeDoor();
    const { fetchImpl } = script([{ tool: { name: 'cancel_order', args: { order_number: 'A-1001' } } }, { content: 'ما بقدر' }]);
    const out = await converse(conn, 'rules', [], ctx(door), { fetchImpl });
    expect(out.trace[0]).toMatchObject({ ok: false, error: 'unknown tool cancel_order' });
  });
});

describe('the model connection', () => {
  it('the key rides only in the Authorization header, and a redirect is an error', async () => {
    const { fetchImpl, sent } = script([{ content: 'مرحبا' }]);
    await complete(conn, [{ role: 'user', content: 'x' }], [], { fetchImpl });
    expect(sent[0].url).toBe('https://glm.example-host.io/v1/chat/completions');
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${conn.apiKey}`);
    expect(String(sent[0].init.body)).not.toContain(conn.apiKey);
    expect(sent[0].init.redirect).toBe('error');
  });

  it('NEGATIVE: an error answer never carries the key back', async () => {
    const fetchImpl = (async () => new Response(`bad key ${conn.apiKey}`, { status: 400 })) as unknown as typeof fetch;
    const e = await complete(conn, [{ role: 'user', content: 'x' }], [], { fetchImpl }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(String(e.message)).not.toContain(conn.apiKey);
    const auth = (async () => new Response(`no ${conn.apiKey}`, { status: 401 })) as unknown as typeof fetch;
    const e2 = await complete(conn, [{ role: 'user', content: 'x' }], [], { fetchImpl: auth }).catch((x) => x);
    expect(e2.code).toBe('AUTH');
    expect(String(e2.message)).not.toContain(conn.apiKey);
  });

  it('the models list sits beside the chat endpoint', () => {
    expect(modelsUrl('https://glm.erv.zakiai.io/v1')).toBe('https://glm.erv.zakiai.io/v1/models');
    expect(modelsUrl('https://x.example-host.io')).toBe('https://x.example-host.io/v1/models');
  });
});

describe('what the model is told', () => {
  it('the fixed rules first, then the owner’s words — and the rules say they win', () => {
    const p = systemPromptFor({ name: 'ليلى', persona: 'احكي بلطف', ordersLine: '#A-1001', productNotes: [], customerName: 'سارة', now: new Date('2026-11-26T00:00:00Z') });
    expect(p.startsWith('You are ليلى,')).toBe(true);
    expect(p.indexOf('<owner_notes>')).toBeGreaterThan(p.indexOf('What you may do'));
    expect(p).toMatch(/the rules above win/);
    expect(SYSTEM_PROMPT).toMatch(/never confirm|confirm_order only right after/i);
    expect(SYSTEM_PROMPT).toMatch(/cannot cancel an order, change a price, give a discount, or take a new order/);
    expect(SYSTEM_PROMPT).toMatch(/automated assistant/);
    expect(SYSTEM_PROMPT).toMatch(/cures or treats/);
  });

  it('a person’s line is a note from the system, the customer’s voice note is said to be unheard', () => {
    const h = historyFor([
      { direction: 'INBOUND', messageType: 'AUDIO', text: null, sentByBot: false },
      { direction: 'OUTBOUND', messageType: 'TEXT', text: 'أهلين', sentByBot: false },
      { direction: 'OUTBOUND', messageType: 'TEXT', text: 'كيف بقدر ساعدك؟', sentByBot: true },
    ]);
    expect(h[0]).toMatchObject({ role: 'user' });
    expect(String(h[0].content)).toMatch(/رسالة صوتية/);
    expect(String(h[0].content)).toMatch(/موظف من الفريق/);
    expect(h[1]).toEqual({ role: 'assistant', content: 'كيف بقدر ساعدك؟' });
    expect(lineForModel({ direction: 'INBOUND', messageType: 'REACTION', text: '👍', sentByBot: false })).toBeNull();
    expect(lineForModel({ direction: 'INBOUND', messageType: 'IMAGE', text: 'هيك اللون', sentByBot: false })).toMatch(/هيك اللون/);
  });
});
