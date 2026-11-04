// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { IDLE_LIMIT_MS, IDLE_WARN_MS, ON_CALL_CAP_MS, ON_CALL_KEY } from '@/lib/exposure';

/**
 * THE TWO THINGS A WEB PAGE CAN HONESTLY DO ABOUT A PERSONAL PHONE.
 *
 * Neither of them stops a screenshot. A page cannot stop a screenshot on
 * any phone, and a second phone pointed at the first defeats every scheme
 * that claims to. What these do is put a name in the picture, and stop the
 * account being open on a device nobody is holding.
 */

const signOut = vi.fn(async (_reason?: string) => undefined);
vi.mock('@/lib/sign-out', () => ({ signOut: (reason?: string) => signOut(reason) }));

import { Watermark } from './Watermark';
import { IdleGuard } from './IdleGuard';

const VIEWER = { name: 'أحمد المصري', id: '3f2a1b9c-77d4-4e51-9a02-abc123def456' };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the watermark', () => {
  it('names the account in a way a photograph will carry', () => {
    render(<Watermark viewer={VIEWER} />);
    expect(screen.getAllByText(/أحمد المصري/).length).toBeGreaterThan(1);
  });

  it('cannot be clicked, selected, or land in a copy-paste', () => {
    render(<Watermark viewer={VIEWER} />);
    const layer = screen.getByTestId('watermark');
    expect(layer.className).toContain('pointer-events-none');
    expect(layer.className).toContain('select-none');
  });

  it('sits ABOVE the dialogs, which is where one customer is largest', () => {
    // A watermark under the modal layer is absent from exactly the screen
    // worth photographing: one person's name, address and phone, enlarged.
    const modal = readFile('src/components/ui/Modal.tsx');
    const modalZ = Number(/z-(\d+)/.exec(modal)?.[1] ?? 0);
    const mark = readFile('src/components/shell/Watermark.tsx');
    const markZ = Number(/z-\[(\d+)\]/.exec(mark)?.[1] ?? 0);
    expect(markZ).toBeGreaterThan(modalZ);
  });

  /**
   * THE ONE EXEMPTION, AND WHY IT IS SAFE TO HAVE ONE.
   *
   * The owner is exempt: the mark exists to make a leaked screen traceable
   * to the account that was looking at it, and the owner is who that
   * protects rather than who it deters. Everybody else carries it.
   *
   * This asserted that the mark was UNCONDITIONAL, which was the right
   * rule while there were no exemptions and is now too strong. What still
   * has to hold is the shape of the condition: exactly one, on the ROLE
   * the server rendered, and on nothing a client can change. A mark behind
   * a preference or a query parameter is a mark for the honest.
   */
  it('is lifted for the owner, and for nobody else', () => {
    const shell = readFile('src/components/shell/Shell.tsx');
    expect(shell).toContain('<Watermark');
    const conditions = [...shell.matchAll(/\{\s*([^{}]+?)\s*&&\s*<Watermark/g)].map((m) => m[1]);
    expect(conditions.length, 'العلامة بلا شرط، أو بأكثر من شرط').toBe(1);
    expect(conditions[0], 'الإعفاء ليس بالدور').toBe("userRole !== 'SUPER_ADMIN'");
    // The role arrives as a rendered prop from the server layout. Anything
    // the browser can set — storage, a search param, a toggle — is not it.
    for (const escape of ['localStorage', 'sessionStorage', 'searchParams', 'document.cookie']) {
      const near = new RegExp(escape + '[\s\S]{0,200}<Watermark');
      expect(near.test(shell), `الإعفاء من ${escape}`).toBe(false);
    }
  });
});

function readFile(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(require('node:path').join(process.cwd(), rel), 'utf8');
}

describe('a phone left on a counter', () => {
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  /** Move the world forward, letting the guard's interval fire. */
  async function pass(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('says nothing while somebody is working', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS - IDLE_WARN_MS - 10_000);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('warns before it acts', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS - IDLE_WARN_MS + 1000);
    expect(screen.getByTestId('idle-warning')).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('and signs out for real when nobody answers', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS + 1000);
    expect(signOut).toHaveBeenCalledWith('idle');
  });

  it('signs out ONCE, not once per tick', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS + 60_000);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a touch puts the clock back to zero', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS - IDLE_WARN_MS + 1000);
    expect(screen.getByTestId('idle-warning')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('أنا هنا'));
    });
    expect(screen.queryByTestId('idle-warning')).toBeNull();

    await pass(IDLE_LIMIT_MS - 10_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('and so does scrolling, which is the only thing a reader does', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS - 30_000);
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    await pass(IDLE_LIMIT_MS - 30_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('work in another tab keeps this one alive', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS - 30_000);
    // The other tab wrote its own activity a moment ago.
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'salesflow.lastActive', newValue: String(Date.now()) })
      );
    });
    await pass(IDLE_LIMIT_MS - 30_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('but a STALE write from another tab does not cut this one short', async () => {
    // The other tab is a second voice about the same account, and it can be
    // wrong: a tab restored from the back/forward cache replays the value
    // it was holding an hour ago. Taking that as the truth signs out the
    // person who is working in THIS tab right now, which reads as the app
    // throwing people out at random.
    render(<IdleGuard />);
    await pass(5 * 60_000);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'salesflow.lastActive', newValue: String(T0 - 3_600_000) })
      );
    });
    await pass(10 * 60_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('and a garbled one is ignored rather than believed', async () => {
    render(<IdleGuard />);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'salesflow.lastActive', newValue: 'يا سلام' })
      );
    });
    await pass(IDLE_LIMIT_MS - 30_000);
    expect(signOut).not.toHaveBeenCalled();
    await pass(60_000);
    expect(signOut).toHaveBeenCalledWith('idle');
  });

  it('a stale timestamp in storage never signs out a person who just arrived', async () => {
    // The other direction, and the one that would be a lockout rather than
    // a leak: opening the app after a week away must not read last week's
    // timestamp as "twenty minutes idle" and bounce somebody straight back
    // to the login screen they just came from. Loading the shell is a
    // person acting; the shared clock may extend a session, never end one.
    localStorage.setItem('salesflow.lastActive', String(T0 - 7 * 24 * 60 * 60 * 1000));
    render(<IdleGuard />);
    await pass(60_000);
    expect(signOut).not.toHaveBeenCalled();
  });

  /** Off screen, and back. */
  async function hide() {
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  async function show() {
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  it('and coming BACK to the tab is not, by itself, being present', async () => {
    // Somebody picking up a phone that has been face-down for an hour
    // arrives at exactly this moment. It is the moment the session must
    // already be ending.
    //
    // RULING 4/11: the warning is SEEN first. This asserted a sign-out five
    // seconds after the return — the countdown had run while the page was
    // hidden, drawn to nobody. Now the return draws the full minute, and
    // the return alone still buys nothing: unanswered, the minute ends it.
    render(<IdleGuard />);
    await hide();
    await pass(IDLE_LIMIT_MS - 1000);
    await show();
    await pass(5_000);
    expect(signOut, 'طلعت قبل ما تشوف التحذير').not.toHaveBeenCalled();
    expect(screen.getByTestId('idle-warning')).toBeTruthy();
    await pass(IDLE_WARN_MS);
    expect(signOut).toHaveBeenCalledWith('idle');
  });

  it('a page that runs out while hidden is not signed out while hidden', async () => {
    render(<IdleGuard />);
    await hide();
    await pass(2 * IDLE_LIMIT_MS);
    expect(signOut, 'انعمل خروج والصفحة مخفية').not.toHaveBeenCalled();
    await show();
  });

  it('and on return shows the full minute, which any touch cancels', async () => {
    render(<IdleGuard />);
    await hide();
    await pass(2 * IDLE_LIMIT_MS);
    await show();
    await pass(5_000);
    const warning = screen.getByTestId('idle-warning');
    expect(warning.textContent).toMatch(/5[0-9]/); // a countdown in its first seconds, not «انتهت الجلسة»
    expect(signOut).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await pass(IDLE_WARN_MS + 10_000);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a return found by the clock alone (no event) is the same return', async () => {
    render(<IdleGuard />);
    await hide();
    await pass(2 * IDLE_LIMIT_MS);
    // Visible again, and nothing fired.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await pass(5_000);
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByTestId('idle-warning')).toBeTruthy();
  });

  describe('a call started from «اتصال» (ruling 4/11)', () => {
    it('is not idle time', async () => {
      render(<IdleGuard />);
      await pass(60_000);
      // She presses «اتصال»; the dialler takes the screen.
      localStorage.setItem(ON_CALL_KEY, String(Date.now()));
      await hide();
      await pass(40 * 60_000); // a forty-minute call
      await show();
      await pass(5_000);
      expect(screen.queryByTestId('idle-warning'), 'وقت المكالمة انحسب خمول').toBeNull();
      expect(localStorage.getItem(ON_CALL_KEY), 'العلامة ما انمسحت عند الرجوع').toBeNull();
      // And the clock starts from her return: another twenty minutes before anything is said.
      await pass(IDLE_LIMIT_MS - IDLE_WARN_MS - 10_000);
      expect(signOut).not.toHaveBeenCalled();
    });

    it('counts an hour at most — a phone left in the dialler still runs out, with its warning', async () => {
      render(<IdleGuard />);
      localStorage.setItem(ON_CALL_KEY, String(Date.now()));
      await hide();
      await pass(ON_CALL_CAP_MS + IDLE_LIMIT_MS + 60_000);
      await show();
      await pass(5_000);
      expect(screen.getByTestId('idle-warning')).toBeTruthy();
      expect(signOut).not.toHaveBeenCalled();
      await pass(IDLE_WARN_MS);
      expect(signOut).toHaveBeenCalledWith('idle');
    });

    it('a mark from a call long before the page went away counts for nothing', async () => {
      render(<IdleGuard />);
      localStorage.setItem(ON_CALL_KEY, String(Date.now()));
      await pass(10 * 60_000); // she kept working on the page; the call was on a desk phone
      await hide();
      await pass(30 * 60_000);
      await show();
      await pass(5_000);
      expect(screen.getByTestId('idle-warning'), 'علامة قديمة اشترت وقت').toBeTruthy();
    });
  });
});

describe('the app in the background', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('is covered, for the thumbnail the phone keeps of it', async () => {
    render(<IdleGuard />);
    expect(screen.queryByTestId('backgrounded')).toBeNull();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('backgrounded')).toBeTruthy();
  });

  /**
   * THE TWO WAYS THE CURTAIN COULD OUTLIVE ITS REASON.
   *
   * Reported twice from a real screen: «I am away from the site, I come back,
   * and the scroll does not work until I click inside the screen». The test
   * below proved the curtain lifts on `visibilitychange` — and that event is
   * NOT always fired on the way back. Restoring a minimised window can leave
   * the document visible with no event at all.
   *
   * So two rules now. It lifts on any signal that says the person is back,
   * and — whatever happens — it never swallows a scroll while it is up.
   */
  it('lifts on focus, for the return that fires no visibility event', async () => {
    render(<IdleGuard />);
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByTestId('backgrounded')).toBeTruthy();

    // Back, with no visibilitychange at all.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.queryByTestId('backgrounded'), 'الستارة بقيت رغم العودة').toBeNull();
  });

  it('and never swallows a scroll while it is up', async () => {
    render(<IdleGuard />);
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const cover = screen.getByTestId('backgrounded');
    expect(cover.className, 'الستارة تبتلع المؤشّر — فهي قفل لا ستارة').toContain('pointer-events-none');
  });

  it('and uncovered on return — it is a curtain, not a lock', async () => {
    render(<IdleGuard />);
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.queryByTestId('backgrounded')).toBeNull();
  });
});
