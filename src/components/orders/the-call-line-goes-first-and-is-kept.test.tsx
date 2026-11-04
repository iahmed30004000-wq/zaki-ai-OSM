// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE LINE «اتصال» LEAVES GOES FIRST, AND IS KEPT UNTIL IT LANDS (the owner's ruling 4/11).
 *
 * That line is what tells the ninety-minute release she is working the order. It was sent fire-and-forget while the
 * dialler took the screen, and dropped for good on the first failure — so ninety working minutes later the order she was
 * ringing was taken from her.
 *
 *   · the request is started in the click, with `keepalive`, before the link's own navigation — and nothing stops or
 *     delays that navigation;
 *   · a dropped line or a failing server keeps it, says «ما انسجّلت المحاولة — عم نعيد», and sends it again until it
 *     lands; a resend asks the log first, so one press is never two lines;
 *   · a refusal is said and not retried; a reload picks up what was kept; signing out forgets it.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { ContactButtons, LINE_RETRYING } from './ContactButtons';
import {
  CONTACT_LINES_KEY,
  LINE_RETRY_MS,
  flushContactLines,
  forgetContactLines,
  sendContactLine,
} from '@/lib/contact-line';

const CONTEXT = { orderNumber: 'ORD-1', customerName: 'أبو محمد', amount: 25 };
const URL_ = '/api/orders/o1/contact-attempts';

type Init = { method?: string; body?: string; keepalive?: boolean } | undefined;
const posts = () => apiJson.mock.calls.filter((c) => c[0] === URL_ && (c[1] as Init)?.method === 'POST');
const reads = () => apiJson.mock.calls.filter((c) => c[0] === URL_ && !(c[1] as Init)?.method);
/** As the real client throws: no status = the line dropped; a status = the server answered. */
const dropped = () => new TypeError('Failed to fetch');
const refused = (status: number, msg: string) => Object.assign(new Error(msg), { status });

/** The answers the door gives, in order; the log read answers `log`. */
let answers: (unknown | Error)[] = [];
let log: { result: string; createdAt: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  forgetContactLines();
  sessionStorage.clear();
  answers = [];
  log = [];
  vi.stubGlobal('open', vi.fn());
  apiJson.mockImplementation(async (url: string, init?: Init) => {
    if (url === URL_ && init?.method === 'POST') {
      const next = answers.length ? answers.shift() : { success: true };
      if (next instanceof Error) throw next;
      return next;
    }
    if (url === URL_) return { attempts: log };
    return { templates: [] };
  });
});

afterEach(() => {
  cleanup();
  forgetContactLines();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('«اتصال» sends its line first', () => {
  it('started inside the click, with keepalive — before the click reaches the page, so before the link opens', () => {
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    // The browser follows the link only after the click has finished travelling; the document hears it last.
    let sentByThen = -1;
    const last = () => (sentByThen = posts().length);
    document.addEventListener('click', last);
    const followed = fireEvent.click(screen.getByTitle('اتصال'));
    document.removeEventListener('click', last);

    expect(sentByThen, 'السطر انبعت بعد ما انفتح الاتصال').toBe(1);
    expect((posts()[0][1] as Init)?.keepalive, 'الطلب بيموت مع الصفحة لما يفتح الاتصال').toBe(true);
    expect(JSON.parse((posts()[0][1] as Init)!.body!)).toEqual({ contactMethod: 'PHONE', result: 'OPENED' });
    // Nothing held the call back: the link's own navigation goes ahead.
    expect(followed, 'الضغطة منعت فتح الاتصال').toBe(true);
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0791234567');
  });

  it('and through the real client: fetch itself is called in the same tick, with keepalive', async () => {
    const real = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
    apiJson.mockImplementation((...a: unknown[]) => (real.apiJson as (...x: unknown[]) => Promise<unknown>)(...a));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    void sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    // No await between the call and this line.
    expect(fetchMock, 'fetch ما انطلب بنفس اللحظة').toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ method: 'POST', keepalive: true });
  });
});

describe('a line that did not land is kept and sent again', () => {
  it('a dropped line: said while it waits, sent again, and the words go when it lands', async () => {
    answers = [dropped()];
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));

    expect(await screen.findByText(LINE_RETRYING)).toBeTruthy();
    expect(sessionStorage.getItem(CONTACT_LINES_KEY), 'السطر ما انحفظ').not.toBeNull();

    await flushContactLines(true);
    expect(reads(), 'ما سأل السجل قبل ما يعيد').toHaveLength(1);
    expect(posts()).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText(LINE_RETRYING)).toBeNull());
    expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
  });

  it('NEVER TWO LINES: the first send landed and only its answer was lost — the log says so, nothing is sent again', async () => {
    answers = [dropped()];
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    await screen.findByText(LINE_RETRYING);
    log = [{ result: 'OPENED', createdAt: new Date().toISOString() }];

    await flushContactLines(true);
    expect(posts(), 'نفس الضغطة انكتبت سطرين').toHaveLength(1);
    await waitFor(() => expect(screen.queryByText(LINE_RETRYING)).toBeNull());
  });

  it('NEGATIVE: an OLDER line of another result is not this press — it is sent', async () => {
    answers = [dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    log = [{ result: 'NO_ANSWER', createdAt: new Date().toISOString() }];
    await flushContactLines(true);
    expect(posts()).toHaveLength(2);
  });

  it('a failing server (5xx) is tried again; a dropped resend waits and goes the next time', async () => {
    answers = [refused(503, 'السيرفر مشغول'), dropped()];
    expect((await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' })).state).toBe('waiting');
    await flushContactLines(true);
    expect(sessionStorage.getItem(CONTACT_LINES_KEY), 'انرمى بعد أول فشل').not.toBeNull();
    await flushContactLines(true);
    expect(posts()).toHaveLength(3);
    expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
  });

  it('on its own clock: fifteen seconds later it goes without anybody pressing anything', async () => {
    vi.useFakeTimers();
    answers = [dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LINE_RETRY_MS + 5_000);
    expect(posts(), 'ما في إعادة لحالها').toHaveLength(2);
    expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
  });

  it('a reload: what this tab kept is sent by the next strip drawn', async () => {
    const kept = { key: 'o1:1', orderId: 'o1', method: 'PHONE', result: 'OPENED', pressedAt: Date.now(), sendAt: 0 };
    sessionStorage.setItem(CONTACT_LINES_KEY, JSON.stringify([kept]));
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull());
  });
});

describe('NEGATIVE: a refusal is final', () => {
  it('403 — said beside the strip, never kept, never sent again', async () => {
    answers = [refused(403, 'الطلب مش بين إيديك.')];
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    expect((await screen.findByRole('alert')).textContent).toContain('الطلب مش بين إيديك.');
    expect(screen.queryByText(LINE_RETRYING)).toBeNull();
    expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
    await flushContactLines(true);
    expect(posts()).toHaveLength(1);
  });

  it('a resend refused (the order is no longer hers) is dropped and said', async () => {
    answers = [dropped(), refused(403, 'الطلب مش بين إيديك.')];
    render(<ContactButtons phone="0791234567" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('اتصال'));
    await screen.findByText(LINE_RETRYING);
    await flushContactLines(true);
    expect((await screen.findByRole('alert')).textContent).toContain('الطلب مش بين إيديك.');
    expect(sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
  });

  it('signing out forgets what was kept: nothing of hers goes under the next session', async () => {
    answers = [dropped()];
    await sendContactLine({ orderId: 'o1', method: 'PHONE', result: 'OPENED' });
    forgetContactLines();
    await flushContactLines(true);
    expect(posts()).toHaveLength(1);
  });
});
