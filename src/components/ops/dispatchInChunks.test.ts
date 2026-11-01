import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «رحّل إلى الشركة واجلب الباركود» for a batch of a hundred and sixty (the owner, 1/11)
 *
 * He pressed it on BATCH-2026-0005 (الباشا, 160 orders) and got «انتهت مهلة الطلب» twice. The send is one order at a time, each a call
 * to the courier — minutes for 160 — and the screen waited fifteen seconds for the WHOLE batch, then let go while the server went on.
 *
 *  1. The screen asks which orders are left, then sends them EIGHT at a time, each piece waiting up to two minutes (every other
 *     request still waits fifteen seconds), and says how far it has got.
 *  2. An order that already carries its barcode is never sent again, and is answered as the server answers it (`ALREADY_SENT`), so
 *     the screens' reading of «something went» is unchanged.
 *  3. A piece that fails to answer STOPS the send: the next piece would run beside a server that may still be on the last one. What
 *     was done is kept, every order not tried is listed as not sent, and the sentence says to refresh and press again — which is safe,
 *     the server skips what went and what is in flight.
 *  4. Nothing about what is sent changed: the same door, with the `orderIds` it already took to retry the ones that failed.
 *
 * Blockers: no money, no order creation, no change to what is sent to the courier or to the claim before every call.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { DISPATCH_CHUNK, DISPATCH_WAIT_MS, DispatchInterrupted, dispatchInChunks } from './dispatchInChunks';

const ids = (from: number, to: number, tag = 'o') => Array.from({ length: to - from }, (_, i) => ({ id: `${tag}${from + i}`, orderNumber: `ORD-${tag}${from + i}` }));

/** The door's answer for the orders it was handed: every one sent, with a barcode. */
const allSent = (orderIds: string[]) => ({
  sent: orderIds.length, skipped: 0, failed: 0,
  outcomes: orderIds.map((id) => ({ orderId: id, orderNumber: `ORD-${id}`, ok: true, trackingNumber: `K-${id}` })),
});

const posts = () => apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const piecesPosted = () => posts().map((c) => JSON.parse((c[1] as RequestInit).body as string).orderIds as string[]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('«رحّل» in pieces', () => {
  it('twenty orders left and five already sent: one question, three pieces (8, 8, 4), and the count said after each', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return { pending: ids(1, 21), sent: ids(100, 105, 's') };
      return allSent(JSON.parse(init.body as string).orderIds);
    });
    const seen: { done: number; total: number }[] = [];

    const summary = await dispatchInChunks('b1', (p) => seen.push(p));

    expect(apiJson.mock.calls[0][0]).toBe('/api/ops/shipments/b1/dispatch');
    expect(apiJson.mock.calls[0][1]).toBeUndefined();
    expect(piecesPosted().map((p) => p.length)).toEqual([8, 8, 4]);
    expect(piecesPosted().flat()).toEqual(ids(1, 21).map((o) => o.id));
    for (const c of posts()) {
      expect(c[0]).toBe('/api/ops/shipments/b1/dispatch');
      expect((c[1] as { timeoutMs?: number }).timeoutMs).toBe(DISPATCH_WAIT_MS);
    }
    expect(seen).toEqual([{ done: 0, total: 20 }, { done: 8, total: 20 }, { done: 16, total: 20 }, { done: 20, total: 20 }]);

    expect(summary.sent).toBe(20);
    expect(summary.skipped).toBe(5);
    expect(summary.failed).toBe(0);
    expect(summary.outcomes.filter((o) => o.skipped === 'ALREADY_SENT').map((o) => o.orderId)).toEqual(ids(100, 105, 's').map((o) => o.id));
  });

  it('a piece is eight orders, and one piece is given longer than the fifteen seconds every other request gets', () => {
    expect(DISPATCH_CHUNK).toBe(8);
    expect(DISPATCH_WAIT_MS).toBeGreaterThan(15_000);
  });

  it('an order that already has its barcode is never posted — and a batch with nothing left posts nothing', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => (!init?.method ? { pending: [], sent: ids(1, 4, 's') } : allSent([])));
    const summary = await dispatchInChunks('b1');
    expect(posts()).toHaveLength(0);
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.outcomes.every((o) => o.skipped === 'ALREADY_SENT' && !o.ok)).toBe(true);
  });

  it('every order is sent once, in the order the server listed them, with the failures kept as the courier said them', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return { pending: ids(1, 12), sent: [] };
      const orderIds: string[] = JSON.parse(init.body as string).orderIds;
      return {
        sent: 0, skipped: 0, failed: orderIds.length,
        outcomes: orderIds.map((id) => ({ orderId: id, orderNumber: `ORD-${id}`, ok: false, error: 'الباشا رفض: رقم الهاتف غير صالح' })),
      };
    });
    const summary = await dispatchInChunks('b1');
    expect(piecesPosted().flat()).toEqual(ids(1, 12).map((o) => o.id));
    expect(new Set(piecesPosted().flat()).size).toBe(11);
    expect(summary.failed).toBe(11);
    expect(summary.outcomes.every((o) => o.error === 'الباشا رفض: رقم الهاتف غير صالح')).toBe(true);
  });
});

describe('a piece that does not answer stops the send', () => {
  const timedOut = 'انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.';

  it('the second of three: nothing more is sent, what was done is kept, the rest is listed as not sent, and the sentence says what to do', async () => {
    let n = 0;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return { pending: ids(1, 21), sent: [] };
      n += 1;
      if (n === 2) throw new Error(timedOut);
      return allSent(JSON.parse(init.body as string).orderIds);
    });

    const error = await dispatchInChunks('b1').catch((e) => e);

    expect(error).toBeInstanceOf(DispatchInterrupted);
    expect(posts()).toHaveLength(2); // the third piece was never sent
    expect(error.left).toBe(12);
    expect(error.message).toContain('وقف الترحيل عند 8 من 20');
    expect(error.message).toContain(timedOut);
    expect(error.message).toContain('حدّث الصفحة وأعد الضغط');
    expect(error.summary.sent).toBe(8);
    // the second piece failed to answer, and so did the one after it: all twelve are «not sent», by number
    const notSent = error.summary.outcomes.filter((o: { ok: boolean; error?: string }) => !o.ok && o.error);
    expect(notSent).toHaveLength(12);
    expect(notSent.map((o: { orderId: string }) => o.orderId)).toEqual(ids(9, 21).map((o) => o.id));
    expect(error.summary.failed).toBe(12);
  });

  it('the first piece refused outright (a batch no longer being filled): the courier’s own refusal is the sentence, and nothing was sent', async () => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init?.method) return { pending: ids(1, 4), sent: [] };
      throw Object.assign(new Error('الدفعة ما عادت قيد التجميع (سُلّمت أو انغلقت) — ما بيصير ترحيلها للشركة من جديد'), { status: 409 });
    });
    const error = await dispatchInChunks('b1').catch((e) => e);
    expect(error).toBeInstanceOf(DispatchInterrupted);
    expect(error.left).toBe(3);
    expect(error.message).toContain('ما عادت قيد التجميع');
    expect(error.summary.sent).toBe(0);
  });

  it('NEGATIVE: the question itself failing is not an interruption — nothing was started, and the cause comes out as it is', async () => {
    apiJson.mockRejectedValue(Object.assign(new Error('دفعات الشحن ليست من صلاحيّاتك.'), { status: 403 }));
    const error = await dispatchInChunks('b1').catch((e) => e);
    expect(error).not.toBeInstanceOf(DispatchInterrupted);
    expect(error.message).toBe('دفعات الشحن ليست من صلاحيّاتك.');
    expect(posts()).toHaveLength(0);
  });
});
