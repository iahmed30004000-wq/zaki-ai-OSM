// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شو صار؟» WITH «إثبات المكالمات» ON — THE PHONE SHEET.
 *
 * On: «ما رد» · «مشغول» · «مسكّر» are shut (disabled, with the reason printed under them — a phone has no tooltip) until thirty seconds
 * and the phone's two seconds of slack after the press, ticking each second; «رقم غلط» · «ردّ» · «اتصل لاحقاً» · «ما اتصلت» stay free.
 * «ردّ» and the «اتصل لاحقاً» chips also leave a line in the contact log, with the call's length when it is known.
 * Off (or absent): the sheet is exactly what it was — same buttons, no reason line, no extra POST, no timer.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { sendContactLine } = vi.hoisted(() => ({ sendContactLine: vi.fn() }));
vi.mock('@/lib/contact-line', () => ({ sendContactLine: (...a: unknown[]) => sendContactLine(...a) }));

import { CallOutcomeSheet } from './CallOutcomeSheet';
import { CALL_PROOF_WORDS } from '@/lib/call-proof-words';
import { PENDING_KEY } from '@/lib/call-outcome';

const NOW = 1_800_000_000_000;
const THREE = ['ما رد', 'مشغول', 'مسكّر'];
const FREE = ['رقم غلط', 'رد', 'اتصل لاحقاً', 'ما اتصلت'];

type Props = React.ComponentProps<typeof CallOutcomeSheet>;
const spies = { onAnswered: vi.fn(), onLogged: vi.fn(() => true), onCallback: vi.fn(() => true), onNotCalled: vi.fn() };

const props = (over: Partial<Props> = {}): Props => ({
  customerName: 'نور',
  awayMs: 40_000,
  closesOnNext: false,
  confirmLock: null,
  waiting: null,
  refused: null,
  offline: false,
  canPull: true,
  pulling: false,
  whatsapp: null,
  onAnswered: spies.onAnswered,
  onLogged: spies.onLogged,
  onCallback: spies.onCallback,
  onNotCalled: spies.onNotCalled,
  onConfirm: vi.fn(),
  onPostpone: vi.fn(),
  onReject: vi.fn(),
  onUndo: () => true,
  onNext: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

const btn = (name: string) => screen.getByRole('button', { name: new RegExp(`^\\s*${name}\\s*$`) }) as HTMLButtonElement;
const lockLine = () => document.querySelector('p.text-xs.text-\\[var\\(--sys-warning\\)\\]');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.clearAllMocks();
  sendContactLine.mockResolvedValue({ state: 'sent' });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('with the proof on', () => {
  it('shuts the three «didn’t answer» outcomes, says why in visible text, and leaves the others free', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 5_000 })} />);
    for (const w of THREE) {
      expect(btn(w).disabled).toBe(true);
      expect(btn(w).getAttribute('aria-disabled')).toBe('true');
      // Never a tooltip alone: the lock has no title on the button.
      expect(btn(w).getAttribute('title')).toBeNull();
    }
    for (const w of FREE) expect(btn(w).disabled).toBe(false);
    // 5 s gone of 30 s + 2 s: 27 s left.
    expect(screen.getByText(CALL_PROOF_WORDS.wait(27))).toBeTruthy();
    fireEvent.click(btn('ما رد'));
    expect(spies.onLogged).not.toHaveBeenCalled();
  });

  it('ticks the reason each second and opens the three when the time is up — and then stops ticking', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 5_000 })} />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(screen.getByText(CALL_PROOF_WORDS.wait(26))).toBeTruthy();
    expect(btn('مشغول').disabled).toBe(true);
    act(() => void vi.advanceTimersByTime(25_000));
    expect(screen.getByText(CALL_PROOF_WORDS.wait(1))).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1_000));
    for (const w of THREE) expect(btn(w).disabled).toBe(false);
    expect(screen.queryByText(/استنّى/)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(btn('ما رد'));
    expect(spies.onLogged).toHaveBeenCalledWith('NO_ANSWER');
  });

  it('runs its one-second ticker only while a locked outcome is on screen', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 5_000 })} />);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(btn('اتصل لاحقاً'));
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(btn('رجوع'));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('with no usable start (nothing kept, or a press from the future) shuts the three with «اضغط اتصال أول» and ticks nothing', () => {
    const { unmount } = render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: null })} />);
    for (const w of THREE) expect(btn(w).disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW + 10 * 60_000 })} />);
    for (const w of THREE) expect(btn(w).disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
  });

  it('a press older than the thirty seconds (a reloaded call) opens them at once, with no reason line', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 10 * 60_000 })} />);
    for (const w of THREE) expect(btn(w).disabled).toBe(false);
    expect(lockLine()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the press from the phone’s kept call when the screen does not pass it', () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'o-9', startedAt: NOW - 2_000, userId: 'u1' }));
    render(<CallOutcomeSheet {...props({ proofOn: true })} />);
    expect(btn('ما رد').disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(30))).toBeTruthy();
    fireEvent.click(btn('رد'));
    expect(sendContactLine.mock.calls[0][0]).toMatchObject({ orderId: 'o-9', result: 'ANSWERED' });
  });

  it('keeps «ما اتصلت» first under six seconds away, even with the three shut', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 4_000, awayMs: 4_000 })} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'سكّر');
    expect(buttons[0].textContent!.trim()).toBe('ما اتصلت');
  });

  it('«ردّ» then «رجوع»: the line it wrote used the press up, so the three shut again with «اضغط اتصال أول» (the server would refuse them too)', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 60_000 })} />);
    for (const w of THREE) expect(btn(w).disabled).toBe(false);
    fireEvent.click(btn('رد'));
    fireEvent.click(btn('رجوع'));
    for (const w of THREE) expect(btn(w).disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
    // …and a new «اتصال» is a new sheet (keyed by the call): it opens by its own thirty seconds, not by this one.
    act(() => void vi.runOnlyPendingTimers()); // leave no scheduler work behind for the next test's timer count
  });

  it('the screen’s own order and press time win over what storage kept (storage may be blocked on a phone)', () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'someone-else', startedAt: NOW - 1_000, userId: 'u1' }));
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 60_000 })} />);
    for (const w of THREE) expect(btn(w).disabled).toBe(false);
    fireEvent.click(btn('رد'));
    expect(sendContactLine).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o-1', result: 'ANSWERED' }));
    act(() => void vi.runOnlyPendingTimers());
  });
});

describe('«ردّ» and «اتصل لاحقاً» leave a line', () => {
  const sentLine = () => sendContactLine.mock.calls[0][0] as { orderId: string; method: string; result: string; durationSeconds?: number };

  it('«ردّ» sends an ANSWERED line with the helper’s talk time, then still opens confirm / postpone / cancel', () => {
    render(
      <CallOutcomeSheet
        {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: 95_000, reading: { answered: true, talkSeconds: 133, ringSeconds: 5 } })}
      />
    );
    fireEvent.click(btn('رد'));
    expect(sendContactLine).toHaveBeenCalledTimes(1);
    expect(sentLine()).toEqual({ orderId: 'o-1', method: 'PHONE', result: 'ANSWERED', durationSeconds: 133 });
    expect(spies.onAnswered).toHaveBeenCalledTimes(1);
    expect(btn('تأكيد الطلب')).toBeTruthy();
    expect(btn('تأجيل')).toBeTruthy();
    expect(btn('ألغِ')).toBeTruthy();
  });

  it('without an «answered» reading the duration is the time away, rounded', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: 41_600 })} />);
    fireEvent.click(btn('رد'));
    expect(sentLine().durationSeconds).toBe(42);
  });

  it('a reading that says «not answered» does not set the duration: the time away does', () => {
    render(
      <CallOutcomeSheet
        {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: 60_000, reading: { answered: false, talkSeconds: 0, ringSeconds: 25 } })}
      />
    );
    fireEvent.click(btn('رد'));
    expect(sentLine().durationSeconds).toBe(60);
  });

  it('with neither a reading nor a time away the duration is left out', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: null })} />);
    fireEvent.click(btn('رد'));
    expect(sendContactLine).toHaveBeenCalledTimes(1);
    expect(sentLine().durationSeconds).toBeUndefined();
    expect('durationSeconds' in sentLine() && sentLine().durationSeconds !== undefined).toBe(false);
  });

  it('clamps the duration to the door’s 0..14400', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: 20_000_000 })} />);
    fireEvent.click(btn('رد'));
    expect(sentLine().durationSeconds).toBe(14_400);
  });

  it('going back and tapping «ردّ» again does not write a second line', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000 })} />);
    fireEvent.click(btn('رد'));
    fireEvent.click(btn('رجوع'));
    fireEvent.click(btn('رد'));
    expect(sendContactLine).toHaveBeenCalledTimes(1);
  });

  it('a chip of «اتصل لاحقاً» sends a CALLBACK_REQUESTED line, and a chip the screen refuses sends none', () => {
    render(<CallOutcomeSheet {...props({ proofOn: true, orderId: 'o-1', startedAt: NOW - 90_000, awayMs: 30_000 })} />);
    fireEvent.click(btn('اتصل لاحقاً'));
    spies.onCallback.mockReturnValueOnce(false);
    fireEvent.click(btn('\\+1 س'));
    expect(sendContactLine).not.toHaveBeenCalled();
    fireEvent.click(btn('\\+1 س'));
    expect(spies.onCallback).toHaveBeenCalledTimes(2);
    expect(sendContactLine).toHaveBeenCalledTimes(1);
    expect(sentLine()).toEqual({ orderId: 'o-1', method: 'PHONE', result: 'CALLBACK_REQUESTED', durationSeconds: 30 });
  });
});

describe('with the proof off or absent the sheet is exactly today’s', () => {
  const dom = (over: Partial<Props>) => {
    const { container, unmount } = render(<CallOutcomeSheet {...props(over)} />);
    const html = container.innerHTML;
    const enabled = screen.getAllByRole('button').map((b) => `${b.textContent!.trim()}:${(b as HTMLButtonElement).disabled}`);
    unmount();
    return { html, enabled };
  };

  it('absent and false draw the same DOM, every button enabled, no reason line, no timer', () => {
    const absent = dom({ awayMs: 8_000 });
    const off = dom({ awayMs: 8_000, proofOn: false, orderId: 'o-1', startedAt: NOW - 1_000 });
    expect(off.html).toBe(absent.html);
    expect(absent.enabled.every((e) => e.endsWith(':false'))).toBe(true);
    for (const w of THREE) expect(absent.enabled).toContain(`${w}:false`);
    expect(absent.html).not.toMatch(/استنّى|اضغط «اتصال»/);
    render(<CallOutcomeSheet {...props({ proofOn: false, startedAt: NOW - 1_000 })} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('«ردّ» and a chip send nothing to the contact log', () => {
    render(<CallOutcomeSheet {...props({ proofOn: false, orderId: 'o-1', startedAt: NOW - 1_000, reading: { answered: true, talkSeconds: 90, ringSeconds: 4 } })} />);
    fireEvent.click(btn('رد'));
    fireEvent.click(btn('رجوع'));
    fireEvent.click(btn('اتصل لاحقاً'));
    fireEvent.click(btn('\\+1 س'));
    expect(spies.onAnswered).toHaveBeenCalledTimes(1);
    expect(spies.onCallback).toHaveBeenCalledTimes(1);
    expect(sendContactLine).not.toHaveBeenCalled();
  });

  it('«ما رد» is tappable at once and goes to the screen as before', () => {
    render(<CallOutcomeSheet {...props({ proofOn: false })} />);
    fireEvent.click(btn('ما رد'));
    expect(spies.onLogged).toHaveBeenCalledWith('NO_ANSWER');
  });
});
