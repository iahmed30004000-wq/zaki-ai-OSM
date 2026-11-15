// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';
import { CALL_OPENED_EVENT } from '@/lib/contact-line';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER WINDOW'S «لا يرد» WAITS FOR A PROVEN CALL (Confirmation Center v2, step A).
 *
 * With the company switch «إثبات المكالمات وجدول المحاولات» on, GET /contact-attempts carries `callProof {on, serverNow, state, unlocksAtMs}` and the
 * window believes it: «لا يرد» is a real disabled button with a VISIBLE line saying why (a phone has no tooltip) — «اضغط اتصال أول» when no press is on
 * record, a ticking «استنّى n ث» for the thirty seconds, nothing when ready. The server decides; the window shows and ticks.
 *
 * DEFINITION OF DONE: NO_OPENED / WAIT / READY draw the right text and the right `disabled`; the countdown ticks from the SERVER's clock (a phone
 * whose clock is an hour off says the same number) and asks nothing while it ticks; a press made elsewhere (the strip, another tab, another device)
 * unlocks the panel without a reload — on the press event, on coming back, and by a twelve-second poll that runs only while NO_OPENED and only
 * while the window is visible; the three refusals say the server's Arabic, write nothing (no second request), and «wait n» re-locks; a refusal of
 * the status door's second half says the new message instead of «the attempt was recorded»; and with the switch OFF the DOM and both request bodies
 * are today's, byte for byte, and nothing extra is asked.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ConfirmationActions } from './ConfirmationActions';

const ORDER = { id: 'o-1', orderNumber: 'ORD-2026-1', confirmationStatus: 'IN_PROGRESS', version: 7, regionId: 'r1' };
const NO_OPENED = { callProof: { on: true, serverNow: 0, state: 'NO_OPENED', unlocksAtMs: null } };
const reply = (body: unknown, ok = true, status = ok ? 200 : 409) => ({ ok, status, json: async () => body });

/** What GET /contact-attempts answers now; a test changes it to say «the press landed on another device». */
let get: () => unknown;
/** What the next POSTs answer, by door. */
let attemptAnswer: () => ReturnType<typeof reply>;
let confirmationAnswer: () => ReturnType<typeof reply>;
const onRefreshOrder = vi.fn();

/** A proof answer whose clock is the phone's own, `skew` ms off. */
const proofAnswer = (state: 'NO_OPENED' | 'WAIT' | 'READY', leftMs: number | null = null, skew = 0) => {
  const serverNow = Date.now() + skew;
  return { attempts: [], summary: null, callProof: { on: true, serverNow, state, unlocksAtMs: leftMs === null ? null : serverNow + leftMs } };
};

beforeEach(() => {
  vi.clearAllMocks();
  get = () => ({ attempts: [], summary: null });
  attemptAnswer = () => reply({});
  confirmationAnswer = () => reply({});
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method !== 'POST') return reply(get());
    return String(url).endsWith('/contact-attempts') ? attemptAnswer() : confirmationAnswer();
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

const gets = () => apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method !== 'POST').length;
const posts = () =>
  apiFetch.mock.calls
    .filter((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')
    .map((c) => ({ url: String(c[0]), body: String((c[1] as { body: string }).body) }));
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const noAnswer = () => button('لا يرد');

/** Draw the window under controlled intervals and clock, and let the first GET answer. */
async function draw(order: Record<string, unknown> = ORDER) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
  const view = render(<ConfirmationActions order={order} ar isRtl onRefreshOrder={onRefreshOrder} />);
  await act(async () => {});
  return view;
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const hide = (hidden: boolean) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });

describe('with the switch on, «لا يرد» says why it is shut', () => {
  it('NO_OPENED: disabled, and the visible line says to press «اتصال» first', async () => {
    get = () => ({ attempts: [], summary: null, ...NO_OPENED });
    await draw();
    expect(noAnswer().disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
    // The reason is tied to the button for a screen reader, not only drawn beside it.
    expect(noAnswer().getAttribute('aria-describedby')).toBe(screen.getByText(CALL_PROOF_WORDS.noOpened).id);
  });

  it('NO_OPENED: «العميل أجاب» stays free, but «رقم خاطئ» is shut with the same reason — it also lands on «لا يرد» at the status door, which wants a press first', async () => {
    get = () => ({ attempts: [], summary: null, ...NO_OPENED });
    await draw();
    expect(button('العميل أجاب').disabled).toBe(false);
    expect(button('رقم خاطئ').disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
  });

  it('WAIT and READY: «رقم خاطئ» needs no waiting — a press is all it asks', async () => {
    get = () => proofAnswer('READY');
    await draw();
    expect(button('رقم خاطئ').disabled).toBe(false);
  });

  it('NO_OPENED: pressing the locked button sends nothing', async () => {
    get = () => ({ attempts: [], summary: null, ...NO_OPENED });
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(posts()).toEqual([]);
  });

  it('WAIT: disabled, with the seconds left read from the SERVER clock — a phone an hour fast says the same number', async () => {
    get = () => proofAnswer('WAIT', 20_000, 3_600_000);
    await draw();
    expect(noAnswer().disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(20))).toBeTruthy();
  });

  it('WAIT: ticks every second, asks nothing while it ticks, and opens by itself at zero', async () => {
    get = () => proofAnswer('WAIT', 3_000);
    await draw();
    expect(screen.getByText(CALL_PROOF_WORDS.wait(3))).toBeTruthy();
    const before = gets();
    await advance(1000);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(2))).toBeTruthy();
    await advance(1000);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(1))).toBeTruthy();
    expect(noAnswer().disabled).toBe(true);
    await advance(1000);
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(/استنّى/)).toBeNull();
    expect(gets(), 'the countdown asked the server').toBe(before);
  });

  it('READY: enabled, no text, and the press sends today’s two bodies', async () => {
    get = () => proofAnswer('READY');
    await draw();
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
    expect(noAnswer().hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(noAnswer());
    await advance(0);
    expect(posts()).toEqual([
      { url: '/api/orders/o-1/contact-attempts', body: JSON.stringify({ contactMethod: 'PHONE', result: 'NO_ANSWER' }) },
      { url: '/api/orders/o-1/confirmation', body: JSON.stringify({ action: 'contact_result', result: 'NO_ANSWER', expectedVersion: 7 }) },
    ]);
  });

  it('a terminal order draws no quick actions and so no reason line', async () => {
    get = () => ({ attempts: [], summary: null, ...NO_OPENED });
    await draw({ ...ORDER, confirmationStatus: 'CONFIRMED' });
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
  });
});

describe('a press made elsewhere unlocks the panel — it never stays stuck on NO_OPENED', () => {
  it('the stale panel: the press lands on another device, and the twelve-second poll opens «لا يرد»', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    expect(noAnswer().disabled).toBe(true);
    get = () => proofAnswer('READY');
    await advance(11_000);
    expect(noAnswer().disabled, 'asked too early').toBe(true);
    await advance(1_500);
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
  });

  it('the poll stops once the panel is no longer on NO_OPENED', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    get = () => proofAnswer('READY');
    await advance(12_500);
    const after = gets();
    await advance(60_000);
    expect(gets()).toBe(after);
  });

  it('the poll asks nothing while the window is hidden, and the buttons do not flicker grey while it asks', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    const before = gets();
    hide(true);
    await advance(40_000);
    expect(gets()).toBe(before);
    hide(false);
    await advance(12_500);
    expect(gets()).toBe(before + 1);
    // A quiet refetch never greys the other buttons (`loadingAttempts` is for the ones she asked for).
    expect(button('العميل أجاب').disabled).toBe(false);
  });

  it('the press event of THIS order refetches at once; another order’s press does not', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    const before = gets();
    get = () => proofAnswer('WAIT', 30_000);
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'someone-else' } }));
    });
    await advance(0);
    expect(gets()).toBe(before);
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'o-1' } }));
    });
    await advance(0);
    expect(gets()).toBe(before + 1);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(30))).toBeTruthy();
  });

  it('coming back to the window (focus, then visibility) refetches', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    get = () => proofAnswer('READY');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await advance(0);
    expect(noAnswer().disabled).toBe(false);
    const before = gets();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(gets()).toBe(before + 1);
  });

  it('the listeners are taken off when the window closes — a press afterwards asks nothing', async () => {
    get = () => proofAnswer('NO_OPENED');
    const { unmount } = await draw();
    unmount();
    const before = gets();
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'o-1' } }));
      window.dispatchEvent(new Event('focus'));
    });
    await advance(30_000);
    expect(gets()).toBe(before);
  });

  it('a slow answer that left before a newer one does not paint over it', async () => {
    let release: (v: ReturnType<typeof reply>) => void = () => {};
    const slow = new Promise<ReturnType<typeof reply>>((r) => (release = r));
    let n = 0;
    apiFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return reply({});
      n += 1;
      return n === 1 ? reply(proofAnswer('READY')) : n === 2 ? slow : reply(proofAnswer('READY'));
    });
    await draw(); // 1st: READY
    // Another press event: the 2nd GET is slow and says NO_OPENED; then a 3rd, quick one says READY.
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'o-1' } }));
    });
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'o-1' } }));
    });
    await advance(0);
    release(reply(proofAnswer('NO_OPENED')));
    await advance(0);
    expect(noAnswer().disabled, 'the old answer won').toBe(false);
  });
});

describe('the three refusals say the server’s Arabic and write nothing', () => {
  const refusal = (code: string, errorAr: string, extra: Record<string, unknown> = {}) =>
    reply({ error: 'English', errorAr, code, ...extra }, false, 409);

  it('CALL_NOT_STARTED at the attempt door: said in the server’s words, and the status door is never asked', async () => {
    get = () => proofAnswer('READY');
    attemptAnswer = () => refusal('CALL_NOT_STARTED', CALL_PROOF_WORDS.refusedNotStarted);
    await draw();
    const before = gets();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText(CALL_PROOF_WORDS.refusedNotStarted)).toBeTruthy();
    expect(posts().map((p) => p.url)).toEqual(['/api/orders/o-1/contact-attempts']);
    // ...and the panel asks again what it is waiting for, quietly.
    expect(gets()).toBe(before + 1);
  });

  it('CALL_TOO_SOON: said, the button locks again for waitSeconds with its visible count, and nothing half-recorded', async () => {
    get = () => proofAnswer('READY');
    attemptAnswer = () => refusal('CALL_TOO_SOON', CALL_PROOF_WORDS.refusedTooSoon(20), { waitSeconds: 20 });
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText(CALL_PROOF_WORDS.refusedTooSoon(20))).toBeTruthy();
    expect(noAnswer().disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(20))).toBeTruthy();
    expect(posts().map((p) => p.url)).toEqual(['/api/orders/o-1/contact-attempts']);
    await advance(5_000);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(15))).toBeTruthy();
    await advance(15_000);
    expect(noAnswer().disabled).toBe(false);
  });

  it('CALL_NOT_LOGGED at the attempt door is said in the server’s words too', async () => {
    get = () => proofAnswer('READY');
    attemptAnswer = () => refusal('CALL_NOT_LOGGED', CALL_PROOF_WORDS.notLogged);
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText(CALL_PROOF_WORDS.notLogged)).toBeTruthy();
    expect(posts().map((p) => p.url)).toEqual(['/api/orders/o-1/contact-attempts']);
  });

  it('a body with no errorAr still says the refusal in the window’s own words', async () => {
    get = () => proofAnswer('READY');
    attemptAnswer = () => reply({ error: 'Call not started', code: 'CALL_NOT_STARTED' }, false, 409);
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText(CALL_PROOF_WORDS.refusedNotStarted)).toBeTruthy();
  });

  it.each(['CALL_NOT_LOGGED', 'CALL_NOT_STARTED'])('%s at the status door: step 1 DID write her line, so the message says the call is on record and the status did not move', async (code) => {
    get = () => proofAnswer('READY');
    confirmationAnswer = () => refusal(code, 'x');
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText(/تسجّلت محاولة الاتصال، بس حالة الطلب ما تغيّرت/)).toBeTruthy();
    // …and it never tells her to «record the attempt first» — it IS recorded.
    expect(screen.queryByText(CALL_PROOF_WORDS.notLogged)).toBeNull();
  });

  it('any other failure of the status door keeps today’s sentence, with the switch on', async () => {
    get = () => proofAnswer('READY');
    confirmationAnswer = () => reply({ error: 'x', errorAr: 'النسخة قديمة' }, false, 409);
    await draw();
    fireEvent.click(noAnswer());
    await advance(0);
    expect(screen.getByText('تم تسجيل محاولة الاتصال لكن فشل تحديث حالة الطلب: النسخة قديمة')).toBeTruthy();
  });
});

describe('with the switch OFF the window is today’s window', () => {
  it('no reason line, nothing disabled by the proof, no aria link — and today’s two bodies', async () => {
    const { container } = await draw();
    expect(noAnswer().disabled).toBe(false);
    expect(noAnswer().hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('#call-proof-reason')).toBeNull();
    expect(container.textContent).not.toMatch(/استنّى|اضغط «اتصال»/);
    fireEvent.click(noAnswer());
    await advance(0);
    expect(posts()).toEqual([
      { url: '/api/orders/o-1/contact-attempts', body: JSON.stringify({ contactMethod: 'PHONE', result: 'NO_ANSWER' }) },
      { url: '/api/orders/o-1/confirmation', body: JSON.stringify({ action: 'contact_result', result: 'NO_ANSWER', expectedVersion: 7 }) },
    ]);
  });

  it('an answer that says on:false is the same as none', async () => {
    get = () => ({ attempts: [], summary: null, callProof: { on: false } });
    await draw();
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
  });

  it('asks nothing extra: no poll, no refetch on a press event, on focus or on visibility', async () => {
    await draw();
    const before = gets();
    expect(before).toBe(1);
    act(() => {
      window.dispatchEvent(new CustomEvent(CALL_OPENED_EVENT, { detail: { orderId: 'o-1' } }));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(60_000);
    expect(gets()).toBe(before);
  });

  it('the switch turned off while the window is open: the lock goes away at the next answer', async () => {
    get = () => proofAnswer('NO_OPENED');
    await draw();
    expect(noAnswer().disabled).toBe(true);
    get = () => ({ attempts: [], summary: null });
    await advance(12_500);
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
  });
});
