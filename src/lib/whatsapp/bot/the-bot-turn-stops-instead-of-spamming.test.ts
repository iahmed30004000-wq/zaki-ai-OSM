import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ONE REAL TURN: WHEN THE BOT SPEAKS, AND WHEN IT STOPS INSTEAD (the owner, 2026-11-26).
 *
 * The database, the order door and the WhatsApp send are fakes; the model is a scripted `fetch`. Nothing leaves. Held:
 *  · switched off, paused, closed or outside the window: no model call and nothing sent;
 *  · one turn at a time (a held lock answers BUSY);
 *  · the hourly cap pauses and flags instead of answering;
 *  · a model failure pauses and flags — nothing is sent to the customer;
 *  · a hand-off sends the goodbye, then pauses and flags;
 *  · the reply goes out through the bot's own send, and the lock is always released.
 */

const h = vi.hoisted(() => ({
  db: {
    whatsAppConversation: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    whatsAppMessage: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  },
  settings: vi.fn(),
  send: vi.fn(),
  typing: vi.fn(),
  pause: vi.fn(),
}));
vi.mock('../../db', () => ({ db: h.db }));
vi.mock('./settings', async (orig) => ({ ...(await orig<typeof import('./settings')>()), loadBotSettings: h.settings }));
vi.mock('../send', () => ({ sendBotText: h.send, botTyping: h.typing }));
vi.mock('./state', async (orig) => ({ ...(await orig<typeof import('./state')>()), pauseBot: h.pause }));
vi.mock('./order-door', () => ({
  realDoor: () => ({
    orders: async () => [],
    order: async () => null,
    product: async () => null,
    amend: async () => ({ ok: false, error: 'x' }),
    changeOffer: async () => ({ ok: false, error: 'x' }),
    confirm: async () => ({ ok: false, error: 'x' }),
  }),
}));

import { runBotTurn, MAX_REPLIES_PER_HOUR } from './engine';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const conv = {
  id: 'cv1',
  companyId: 'co1',
  customerId: null,
  customerPhone: '962790000000',
  customerName: 'سارة',
  status: 'OPEN',
  botPaused: false,
  botChangedAt: null,
  lastInboundAt: new Date(NOW.getTime() - 60_000),
};
const settings = {
  companyId: 'co1',
  enabled: true,
  name: 'سارة',
  avatarText: 'س',
  persona: '',
  productNotes: [],
  baseUrl: 'https://glm.example-host.io/v1',
  model: 'glm-test',
  apiKey: 'fake-model-key-for-tests',
  keyUnreadable: false,
};
const inbound = { id: 'm1', direction: 'INBOUND', messageType: 'TEXT', text: 'مرحبا، وين طلبي؟', sentByBot: false, meta: null, createdAt: new Date(NOW.getTime() - 60_000), externalMessageId: 'wamid.1' };

function model(content: string, tool?: { name: string; args: object }) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content, tool_calls: tool ? [{ id: 't1', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] : [] }, finish_reason: tool ? 'tool_calls' : 'stop' }],
      }),
      { status: 200 }
    )
  ) as unknown as typeof fetch;
}

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, now: () => NOW, send: h.send, typing: h.typing });

beforeEach(() => {
  vi.clearAllMocks();
  h.db.whatsAppConversation.findUnique.mockResolvedValue(conv);
  h.db.whatsAppConversation.updateMany.mockResolvedValue({ count: 1 });
  h.db.whatsAppConversation.update.mockResolvedValue({});
  h.db.whatsAppMessage.count.mockResolvedValue(0);
  h.db.whatsAppMessage.findMany.mockResolvedValue([inbound]);
  h.settings.mockResolvedValue(settings);
  h.send.mockResolvedValue({ ok: true, message: { id: 'out1' } });
  h.typing.mockResolvedValue(true);
  h.pause.mockResolvedValue(true);
});

describe('when the bot may not speak, it does not', () => {
  it.each([
    ['switched off', () => h.settings.mockResolvedValue({ ...settings, enabled: false }), 'OFF'],
    ['no key', () => h.settings.mockResolvedValue({ ...settings, apiKey: null }), 'OFF'],
    ['paused here', () => h.db.whatsAppConversation.findUnique.mockResolvedValue({ ...conv, botPaused: true }), 'PAUSED'],
    ['a closed conversation', () => h.db.whatsAppConversation.findUnique.mockResolvedValue({ ...conv, status: 'CLOSED' }), 'CLOSED'],
    ['outside the 24-hour window', () => h.db.whatsAppConversation.findUnique.mockResolvedValue({ ...conv, lastInboundAt: new Date(NOW.getTime() - 25 * 3600_000) }), 'CLOSED'],
    ['another turn holds the lock', () => h.db.whatsAppConversation.updateMany.mockResolvedValueOnce({ count: 0 }), 'BUSY'],
  ])('NEGATIVE: %s', async (_name, arrange, expected) => {
    arrange();
    const fetchImpl = model('أهلين');
    expect(await runBotTurn('cv1', deps(fetchImpl))).toBe(expected);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('NEGATIVE: nothing new from the customer — no answer', async () => {
    h.db.whatsAppMessage.findMany.mockResolvedValue([{ ...inbound, direction: 'OUTBOUND', sentByBot: true }]);
    const fetchImpl = model('أهلين');
    expect(await runBotTurn('cv1', deps(fetchImpl))).toBe('NOTHING');
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('it stops instead of spamming', () => {
  it(`the hourly cap (${MAX_REPLIES_PER_HOUR}) pauses and flags the conversation — no model call`, async () => {
    h.db.whatsAppMessage.count.mockResolvedValue(MAX_REPLIES_PER_HOUR);
    const fetchImpl = model('أهلين');
    expect(await runBotTurn('cv1', deps(fetchImpl))).toBe('RATE_LIMIT');
    expect(h.pause).toHaveBeenCalledWith('cv1', 'RATE_LIMIT', expect.objectContaining({ handoff: true }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a model that fails pauses and flags; the customer is sent nothing; the lock is released', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    expect(await runBotTurn('cv1', deps(fetchImpl))).toBe('FAILED');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.pause).toHaveBeenCalledWith('cv1', 'FAILED', expect.objectContaining({ handoff: true }));
    expect(h.db.whatsAppConversation.updateMany).toHaveBeenLastCalledWith({ where: { id: 'cv1' }, data: { botBusyUntil: null } });
  });

  it('an empty answer is a failure, not an empty message', async () => {
    expect(await runBotTurn('cv1', deps(model('')))).toBe('FAILED');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a hand-off sends the goodbye, then pauses and flags', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      const message = n === 1
        ? { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'transfer_to_human', arguments: JSON.stringify({ reason: 'بدو يلغي' }) } }] }
        : { content: 'رح يكمل معك زميلي هون' };
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await runBotTurn('cv1', deps(fetchImpl))).toBe('HANDOFF');
    expect(h.send).toHaveBeenCalledWith('co1', 'cv1', 'رح يكمل معك زميلي هون');
    expect(h.pause).toHaveBeenCalledWith('cv1', 'HANDOFF', expect.objectContaining({ handoff: true, note: 'بدو يلغي' }));
  });
});

describe('it answers', () => {
  it('the reply leaves through the bot’s own send, with «يكتب…» shown first', async () => {
    expect(await runBotTurn('cv1', deps(model('أهلين فيك، ما لقيت طلب على هالرقم')))).toBe('SENT');
    expect(h.typing).toHaveBeenCalledWith('co1', 'wamid.1');
    expect(h.send).toHaveBeenCalledWith('co1', 'cv1', 'أهلين فيك، ما لقيت طلب على هالرقم');
    expect(h.pause).not.toHaveBeenCalled();
  });

  it('a person who answered while the model was thinking keeps the conversation — nothing is flagged', async () => {
    h.send.mockResolvedValue({ ok: false, error: 'paused', status: 409, code: 'BOT_PAUSED' });
    expect(await runBotTurn('cv1', deps(model('أهلين')))).toBe('PAUSED');
    expect(h.pause).not.toHaveBeenCalled();
  });
});
