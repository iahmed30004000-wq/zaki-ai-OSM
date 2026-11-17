import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner's «اوقف» is read BEFORE the order reader and short-circuits it (PR-B, O5): it is a command, so it must not become a Telegram message row, a source lookup or an order —
 * and anything that is not a command goes on to the reader exactly as it did.
 */

const h = vi.hoisted(() => ({
  handleOwnerCommand: vi.fn(),
  db: {
    telegramSource: { findFirst: vi.fn() },
    telegramMessage: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../db', () => ({ db: h.db }));
vi.mock('./owner-commands', () => ({ handleOwnerCommand: (...a: unknown[]) => h.handleOwnerCommand(...a) }));

import { processTelegramUpdate } from './inbound';

const GROUP = {
  update_id: 7,
  message: { message_id: 1, chat: { id: -100555, type: 'supergroup', title: 'g' }, text: 'طلب جديد', date: Math.floor(Date.now() / 1000) },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db.telegramSource.findFirst.mockResolvedValue(null);
});

describe('the owner’s command and the order reader', () => {
  it('a handled command stops there: no source lookup, no message row, no order', async () => {
    h.handleOwnerCommand.mockResolvedValue({ handled: true, status: 'OWNER_STOP' });
    expect(await processTelegramUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, text: 'اوقف CR00147' } })).toEqual({ handled: true, status: 'OWNER_STOP' });
    expect(h.db.telegramSource.findFirst).not.toHaveBeenCalled();
    expect(h.db.telegramMessage.create).not.toHaveBeenCalled();
  });

  it('a refused command is handled too — it is not an order either', async () => {
    h.handleOwnerCommand.mockResolvedValue({ handled: true, status: 'OWNER_STOP_REFUSED' });
    expect(await processTelegramUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, text: 'اوقف 0936654998' } })).toEqual({ handled: true, status: 'OWNER_STOP_REFUSED' });
    expect(h.db.telegramMessage.create).not.toHaveBeenCalled();
  });

  it('anything else goes on to the reader exactly as before: a group message is looked up as an order source', async () => {
    h.handleOwnerCommand.mockResolvedValue({ handled: false });
    const res = await processTelegramUpdate(GROUP);
    expect(h.handleOwnerCommand).toHaveBeenCalledWith(GROUP);
    expect(h.db.telegramSource.findFirst).toHaveBeenCalled();
    expect(res).toEqual({ handled: false, status: 'NO_SOURCE' });
  });

  it('a private message that is not a command is still ignored by the reader, as it always was', async () => {
    h.handleOwnerCommand.mockResolvedValue({ handled: false });
    expect(await processTelegramUpdate({ update_id: 8, message: { message_id: 2, chat: { id: 5, type: 'private' }, text: 'hello', date: Math.floor(Date.now() / 1000) } })).toEqual({ handled: false });
    expect(h.db.telegramSource.findFirst).not.toHaveBeenCalled();
  });
});
