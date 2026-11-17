import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE OWNER WRITES «اوقف …» TO THE BOT (PR-B, O5) — who may, what is forwarded, and that nothing else is touched.
 * The Telegram send and the installed-apps queue are doubles; the owner-chat rule, the spellings, the freshness and the privacy check are the real ones.
 */

const h = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  companyListeningToStop: vi.fn(),
  emitOwnerStop: vi.fn(),
}));

vi.mock('./cloud-api', () => ({ sendMessage: (...a: unknown[]) => h.sendMessage(...a) }));
vi.mock('../apps/events', () => ({
  companyListeningToStop: (...a: unknown[]) => h.companyListeningToStop(...a),
  emitOwnerStop: (...a: unknown[]) => h.emitOwnerStop(...a),
}));

import { handleOwnerCommand, STOP_FRESH_MS, STOP_QUERY_MAX } from './owner-commands';

const NOW = new Date('2026-11-18T07:05:00Z');
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const privateMsg = (text: string, over: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 5, chat: { id: 111222333, type: 'private' }, from: { id: 111222333 }, text, date: unix(NOW), ...over },
});

const ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_OWNER_CHAT_ID = '111222333';
  h.sendMessage.mockResolvedValue({ ok: true, result: { message_id: 9 } });
  h.companyListeningToStop.mockResolvedValue('c1');
  h.emitOwnerStop.mockResolvedValue(1);
});
afterEach(() => {
  process.env = { ...ENV };
});

describe('the owner’s «اوقف»', () => {
  it('is forwarded as the stop request, and the owner is told it was sent', async () => {
    const out = await handleOwnerCommand(privateMsg('اوقف CR00147'), NOW);
    expect(out).toEqual({ handled: true, status: 'OWNER_STOP' });
    expect(h.emitOwnerStop).toHaveBeenCalledWith('c1', { query: 'CR00147', source_chat: 'owner' });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0][0]).toBe('111222333');
    expect(h.sendMessage.mock.calls[0][1]).toContain('CR00147');
  });

  it.each(['اوقف CR00147', 'أوقف CR00147', 'وقّف CR00147', 'وقف CR00147', '  اوقف   CR00147  '])('reads the spelling «%s»', async (text) => {
    await handleOwnerCommand(privateMsg(text), NOW);
    expect(h.emitOwnerStop).toHaveBeenCalledWith('c1', { query: 'CR00147', source_chat: 'owner' });
  });

  it('the query is everything after the word, with its spaces gathered', async () => {
    await handleOwnerCommand(privateMsg('اوقف  كل  إعلانات   TRF01'), NOW);
    expect(h.emitOwnerStop).toHaveBeenCalledWith('c1', { query: 'كل إعلانات TRF01', source_chat: 'owner' });
  });
});

describe('who may', () => {
  it('only a PRIVATE chat with the owner’s id: a group, another person, and no owner chat set are not commands — and nothing is touched', async () => {
    const group = { update_id: 2, message: { message_id: 1, chat: { id: -100555, type: 'supergroup' }, text: 'اوقف CR00147', date: unix(NOW) } };
    const other = privateMsg('اوقف CR00147', { chat: { id: 999, type: 'private' } });
    expect(await handleOwnerCommand(group, NOW)).toEqual({ handled: false });
    expect(await handleOwnerCommand(other, NOW)).toEqual({ handled: false });
    // the owner's id typed in a GROUP is still not the owner's private chat
    expect(await handleOwnerCommand({ update_id: 3, message: { message_id: 1, chat: { id: 111222333, type: 'group' }, text: 'اوقف CR00147', date: unix(NOW) } }, NOW)).toEqual({ handled: false });
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    expect(await handleOwnerCommand(privateMsg('اوقف CR00147'), NOW)).toEqual({ handled: false });
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.companyListeningToStop).not.toHaveBeenCalled();
  });

  it('an edited message is not a new command, and a channel post is not one either', async () => {
    expect(await handleOwnerCommand({ update_id: 4, edited_message: privateMsg('اوقف CR00147').message }, NOW)).toEqual({ handled: false });
    expect(await handleOwnerCommand({ update_id: 5, channel_post: privateMsg('اوقف CR00147').message }, NOW)).toEqual({ handled: false });
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
  });

  it('the owner’s other messages fall through to the order reader: not a command, not handled', async () => {
    for (const text of ['مرحبا', 'اوقف', 'اوقفنا', 'please اوقف x', '']) {
      expect(await handleOwnerCommand(privateMsg(text), NOW), text).toEqual({ handled: false });
    }
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('garbage is not a crash', async () => {
    for (const bad of [null, undefined, 'x', 7, {}, { message: null }, { message: { chat: null } }]) {
      expect(await handleOwnerCommand(bad, NOW)).toEqual({ handled: false });
    }
  });
});

describe('what is not forwarded', () => {
  it('a stop older than five minutes is not acted on — a replayed backfill never pauses an ad — and says nothing', async () => {
    const old = privateMsg('اوقف CR00147', { date: unix(new Date(NOW.getTime() - STOP_FRESH_MS - 60_000)) });
    expect(await handleOwnerCommand(old, NOW)).toEqual({ handled: true, status: 'OWNER_STOP_REFUSED' });
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    // exactly on the edge is still fresh
    const edge = privateMsg('اوقف CR00147', { date: unix(new Date(NOW.getTime() - STOP_FRESH_MS)) });
    expect((await handleOwnerCommand(edge, NOW)).status).toBe('OWNER_STOP');
  });

  it('a query over 200 characters is refused with a sentence', async () => {
    const res = await handleOwnerCommand(privateMsg(`اوقف ${'x'.repeat(STOP_QUERY_MAX + 1)}`), NOW);
    expect(res).toEqual({ handled: true, status: 'OWNER_STOP_REFUSED' });
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect((await handleOwnerCommand(privateMsg(`اوقف ${'x'.repeat(STOP_QUERY_MAX)}`), NOW)).status).toBe('OWNER_STOP');
  });

  it('a phone number or an address in it is refused — and not repeated back', async () => {
    for (const text of ['اوقف 0936654998', 'اوقف شارع الجلاء']) {
      h.sendMessage.mockClear();
      const res = await handleOwnerCommand(privateMsg(text), NOW);
      expect(res, text).toEqual({ handled: true, status: 'OWNER_STOP_REFUSED' });
      expect(h.sendMessage.mock.calls[0][1]).not.toContain('0936654998');
      expect(h.sendMessage.mock.calls[0][1]).not.toContain('الجلاء');
    }
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
  });

  it('no app listening (or more than one company) is said to the owner, and nothing is queued', async () => {
    h.companyListeningToStop.mockResolvedValue(null);
    const res = await handleOwnerCommand(privateMsg('اوقف CR00147'), NOW);
    expect(res).toEqual({ handled: true, status: 'OWNER_STOP_REFUSED' });
    expect(h.emitOwnerStop).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls[0][1]).toContain('التطبيقات');
  });

  it('a queue that told nobody is said, not claimed as sent', async () => {
    h.emitOwnerStop.mockResolvedValue(0);
    await handleOwnerCommand(privateMsg('اوقف CR00147'), NOW);
    expect(h.sendMessage.mock.calls[0][1]).not.toContain('بعتّو للميديا باير');
  });

  it('a Telegram that will not take the answer does not undo the command', async () => {
    h.sendMessage.mockRejectedValue(new Error('network'));
    expect(await handleOwnerCommand(privateMsg('اوقف CR00147'), NOW)).toEqual({ handled: true, status: 'OWNER_STOP' });
    expect(h.emitOwnerStop).toHaveBeenCalledTimes(1);
  });
});
