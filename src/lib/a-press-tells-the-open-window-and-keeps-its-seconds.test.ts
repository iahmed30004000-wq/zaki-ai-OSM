// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE LINE A PRESS LEAVES, EXTENDED FOR «إثبات المكالمات» (Confirmation Center v2, step A)
 *
 *  1. Every body the line sent before is BYTE FOR BYTE what it was: `{ contactMethod, result }` — no `durationSeconds` key unless a number was given.
 *  2. `ANSWERED` and `CALLBACK_REQUESTED` ride the same keep-and-retry path (a failing server keeps them, a resend asks the log first), and a kept line keeps its seconds.
 *  3. When an «اتصال» press has LANDED the window is told (`CALL_OPENED_EVENT`, with the order) — once for a send that landed at once, once for a resend that landed
 *     later, never for a refusal, never for any other result.
 *  4. `openedWaiting(order)` says whether a press of THAT order is still waiting to land — the call sheet's outcome must not treat «no press logged» as final while one is.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import {
  CALL_OPENED_EVENT,
  CONTACT_LINES_KEY,
  LINE_RETRY_MS,
  flushContactLines,
  forgetContactLines,
  openedWaiting,
  sendContactLine,
  setContactLineOwner,
} from './contact-line';

const URL_ = '/api/orders/o1/contact-attempts';
const isDoor = (url: unknown) => typeof url === 'string' && /^\/api\/orders\/[^/]+\/contact-attempts$/.test(url);
type Init = { method?: string; body?: string } | undefined;
const posts = () => apiJson.mock.calls.filter((c) => c[0] === URL_ && (c[1] as Init)?.method === 'POST');
const bodies = () => posts().map((c) => (c[1] as Init)!.body);
const dropped = () => new TypeError('Failed to fetch');

let answers: (unknown | Error)[] = [];
const heard: { orderId: string }[] = [];
const onOpened = (e: Event) => heard.push((e as CustomEvent).detail);

beforeEach(() => {
  vi.clearAllMocks();
  forgetContactLines();
  sessionStorage.clear();
  answers = [];
  heard.length = 0;
  setContactLineOwner(null);
  setContactLineOwner('sara');
  window.addEventListener(CALL_OPENED_EVENT, onOpened);
  apiJson.mockImplementation(async (url: string, init?: Init) => {
    if (isDoor(url) && init?.method === 'POST') {
      const next = answers.length ? answers.shift() : { success: true };
      if (next instanceof Error) throw next;
      return next;
    }
    if (isDoor(url)) return { attempts: [] };
    return {};
  });
});

afterEach(() => {
  window.removeEventListener(CALL_OPENED_EVENT, onOpened);
  forgetContactLines();
  vi.useRealTimers();
});

describe('the bodies', () => {
  it('«اتصال» and a sent message are exactly what they always were — no new key', async () => {
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    await sendContactLine({ orderId: 'o1', method: 'WHATSAPP', result: 'MESSAGE_SENT' });
    expect(bodies()).toEqual([JSON.stringify({ contactMethod: 'PHONE', result: 'OPENED' }), JSON.stringify({ contactMethod: 'WHATSAPP', result: 'MESSAGE_SENT' })]);
  });

  it('an answered call carries its whole seconds, and omits the key when none is known', async () => {
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'ANSWERED', durationSeconds: 95 });
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'CALLBACK_REQUESTED' });
    expect(bodies()).toEqual([
      JSON.stringify({ contactMethod: 'PHONE', result: 'ANSWERED', durationSeconds: 95 }),
      JSON.stringify({ contactMethod: 'PHONE', result: 'CALLBACK_REQUESTED' }),
    ]);
  });

  it('a kept line keeps its seconds: the resend carries them too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    answers = [dropped()];
    expect((await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'ANSWERED', durationSeconds: 42 })).state).toBe('waiting');
    expect(JSON.parse(sessionStorage.getItem(CONTACT_LINES_KEY)!)[0]).toMatchObject({ result: 'ANSWERED', durationSeconds: 42 });
    vi.setSystemTime(Date.now() + LINE_RETRY_MS + 1);
    await flushContactLines();
    expect(bodies()).toEqual([
      JSON.stringify({ contactMethod: 'PHONE', result: 'ANSWERED', durationSeconds: 42 }),
      JSON.stringify({ contactMethod: 'PHONE', result: 'ANSWERED', durationSeconds: 42 }),
    ]);
  });
});

describe('telling the open window', () => {
  it('an «اتصال» that landed tells it, with the order — once', async () => {
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    expect(heard).toEqual([{ orderId: 'o1' }]);
  });

  it('a resend that landed later tells it then, and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    answers = [dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    expect(heard).toEqual([]);
    vi.setSystemTime(Date.now() + LINE_RETRY_MS + 1);
    await flushContactLines();
    expect(heard).toEqual([{ orderId: 'o1' }]);
  });

  it('a refusal tells nobody, and no other result does', async () => {
    answers = [Object.assign(new Error('لا'), { status: 403 })];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'ANSWERED' });
    await sendContactLine({ orderId: 'o1', method: 'WHATSAPP', result: 'MESSAGE_SENT' });
    expect(heard).toEqual([]);
  });
});

describe('«is a press of this order still waiting?»', () => {
  it('true only for an OPENED of THIS order that has not landed', async () => {
    expect(openedWaiting('o1')).toBe(false);
    answers = [dropped(), dropped(), dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'ANSWERED' });
    await sendContactLine({ orderId: 'o2', method: 'PHONE', result: 'OPENED' });
    expect(openedWaiting('o1')).toBe(false); // a waiting ANSWERED is not a press
    expect(openedWaiting('o2')).toBe(true);
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    expect(openedWaiting('o1')).toBe(true);
  });

  it('false again once it landed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    answers = [dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    expect(openedWaiting('o1')).toBe(true);
    vi.setSystemTime(Date.now() + LINE_RETRY_MS + 1);
    await flushContactLines();
    expect(openedWaiting('o1')).toBe(false);
  });
});
