// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HIDDEN_GRACE_CEILING_MS, IDLE_LIMIT_MS } from '@/lib/exposure';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «بدي الغي ... قصة انو يطلع كل ١٥ دقيقة و كمان يحتفظ بتسجيل الدخول ع طول» — THE SCREEN SIDE.
 *
 * The owner's ruling 11/11. Three things are drawn by the browser: the sign-out of a screen left untouched (IdleGuard),
 * the «تذكرني» box on the login page, and the days printed on the second-factor step. Each is told by the SERVER (the
 * browser has no environment), and each has the old behaviour back when the server says so.
 *
 * The idle control below is deliberately NOT vacuous: the same harness that shows «no sign-out after twenty hours» with the
 * switch off shows the sign-out with it on, in the same file — a test that cannot fail is the thing this repository keeps
 * finding.
 * ═══════════════════════════════════════════════════════════════════════
 */

const signOut = vi.fn<(reason?: string) => Promise<undefined>>(async () => undefined);
vi.mock('@/lib/sign-out', () => ({ signOut: (reason?: string) => signOut(reason) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { IdleGuard } from './IdleGuard';
import { SignInPolicyProvider } from './SignInPolicy';
import { SecondFactor } from './SecondFactor';
import LoginPage from '@/app/(system)/login/page';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const repo = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** The page goes to the background (or comes back), the way a browser says so. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  // @ts-expect-error — drop the own property so jsdom's real `hidden` is back
  delete document.hidden;
});

describe('the idle sign-out — the switch off (the default)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  async function pass(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('does not warn and does not sign out, even after twenty HOURS of nobody touching the screen', async () => {
    render(<IdleGuard idleSignOut={false} />);
    // The old limit is twenty minutes: walk well past it, past its warning, and on to twenty hours — in steps, so no one
    // tick could be what let it through.
    for (let h = 0; h < 20; h += 1) {
      await pass(HOUR);
      expect(screen.queryByTestId('idle-warning'), `بعد ${h + 1} ساعة ظهر تنبيه`).toBeNull();
    }
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.queryByText(/ستُغلق الجلسة/)).toBeNull();
    expect(screen.queryByText('أنا هنا')).toBeNull();
  });

  it('and not after the page sat in the background for hours and came back (a phone in a pocket, a tab left behind)', async () => {
    render(<IdleGuard idleSignOut={false} />);
    await pass(1000);
    await act(async () => setHidden(true));
    await pass(3 * HOUR);
    await act(async () => setHidden(false));
    await pass(10_000);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('the CURTAIN is not a sign-out and stays: it covers the page while it is in the background, and lifts on return', async () => {
    render(<IdleGuard idleSignOut={false} />);
    expect(screen.queryByTestId('backgrounded')).toBeNull();
    await act(async () => setHidden(true));
    expect(screen.getByTestId('backgrounded'), 'الستارة اختفت وهي مش تسجيل خروج').toBeTruthy();
    await act(async () => setHidden(false));
    expect(screen.queryByTestId('backgrounded')).toBeNull();
  });

  it('and nothing is written to storage for the idle clock', async () => {
    render(<IdleGuard idleSignOut={false} />);
    await pass(60_000);
    expect(localStorage.getItem('salesflow.lastActive')).toBeNull();
  });
});

describe('the idle sign-out — the switch on gives back exactly what was there (the control)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  async function pass(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('signs out after twenty minutes when told to (and warns first)', async () => {
    render(<IdleGuard idleSignOut />);
    await pass(IDLE_LIMIT_MS - 30_000);
    expect(screen.getByTestId('idle-warning')).toBeTruthy();
    await pass(31_000);
    expect(signOut).toHaveBeenCalledWith('idle');
  });

  it('a caller that says nothing keeps the protection — the default of the component is ON', async () => {
    render(<IdleGuard />);
    await pass(IDLE_LIMIT_MS + 1000);
    expect(signOut).toHaveBeenCalledWith('idle');
  });

  it('and a page that sat hidden past the grace ceiling is signed out on return — the harness can see a sign-out', async () => {
    render(<IdleGuard idleSignOut />);
    await pass(1000);
    await act(async () => setHidden(true));
    await pass(IDLE_LIMIT_MS + HIDDEN_GRACE_CEILING_MS + HOUR);
    await act(async () => setHidden(false));
    expect(signOut).toHaveBeenCalledWith('idle');
  });
});

describe('the server tells the shell — the layout reads the switch, the shell hands it down', () => {
  it('the layout asks the switch on the SERVER at request time, and the shell gives it to the guard', () => {
    const layout = repo('src/app/(system)/(shell)/layout.tsx');
    expect(layout, 'الـlayout ما بيقرأ المفتاح').toContain('idleSignOut={idleSignOutOn()}');
    expect(layout).toContain("import { idleSignOutOn } from '@/lib/auth-switches'");
    const shell = repo('src/components/shell/Shell.tsx');
    expect(shell, 'الـShell ما بيمرّر المفتاح للحارس').toContain('<IdleGuard idleSignOut={idleSignOut} />');
    // Never a build-time variable: baked into the bundle, out of reach of a changed variable in Coolify.
    for (const file of ['src/components/shell/IdleGuard.tsx', 'src/components/shell/Shell.tsx', 'src/app/(system)/(shell)/layout.tsx']) {
      expect(stripComments(repo(file)), `${file}: متغيّر بناء`).not.toMatch(/NEXT_PUBLIC_/);
    }
  });

  it('the constants of exposure.ts stay — the limit, the warning, the call credit: nothing was removed, only switched', () => {
    const src = repo('src/lib/exposure.ts');
    for (const name of ['IDLE_LIMIT_MS', 'IDLE_WARN_MS', 'HIDDEN_GRACE_CEILING_MS', 'ON_CALL_CAP_MS']) {
      expect(src, name).toContain(`export const ${name}`);
    }
    expect(IDLE_LIMIT_MS).toBe(20 * 60 * 1000);
  });
});

describe('the login page — «تذكرني»', () => {
  it('is NOT drawn while every sign-in lasts a year — a box that does nothing is a box that lies', () => {
    render(
      <SignInPolicyProvider value={{ rememberBox: false, trustDays: 365 }}>
        <LoginPage />
      </SignInPolicyProvider>
    );
    expect(screen.queryByText('تذكرني')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    // The rest of the form is whole: email, password, the button.
    expect(screen.getByText('تسجيل الدخول')).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeTruthy();
    expect(document.querySelector('input[type="email"]')).toBeTruthy();
  });

  it('is drawn — and ticked — under the old rule (7 days, 30 with the box)', () => {
    render(
      <SignInPolicyProvider value={{ rememberBox: true, trustDays: 30 }}>
        <LoginPage />
      </SignInPolicyProvider>
    );
    expect(screen.getByText('تذكرني')).toBeTruthy();
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.checked).toBe(true);
  });

  it('and a page rendered outside the layout keeps the old look — the layout is the only place that says otherwise', () => {
    render(<LoginPage />);
    expect(screen.getByText('تذكرني')).toBeTruthy();
  });

  it('the layout reads the switch on the server, and nothing in the page reads the environment', () => {
    const layout = repo('src/app/(system)/login/layout.tsx');
    expect(layout).toContain('rememberBox: shortSessionsOn()');
    expect(layout).toContain('trustDays: trustDays()');
    const page = repo('src/app/(system)/login/page.tsx');
    expect(stripComments(page), 'صفحة الدخول بتقرأ البيئة بنفسها').not.toMatch(/process\.env|NEXT_PUBLIC_/);
    expect(page).toContain('trustDays={policy.trustDays}');
  });

  it('shows no code step: a sign-in that answers with a session goes straight in', async () => {
    // The page opens the second step only when the server says `twoFactor` — with the switch off it never does.
    const page = repo('src/app/(system)/login/page.tsx');
    expect(page).toMatch(/if \(data\.twoFactor\) \{/);
  });
});

describe('the second-factor step prints the SERVER’s number of days', () => {
  const draw = (trustDays: number) =>
    render(
      <SecondFactor step="verify" challenge="t" email="a@b.c" trustDays={trustDays} onSignedIn={() => undefined} onCancel={() => undefined} />
    );

  it('a year under the long rule, thirty days under the old one — interpolated, never written in', () => {
    draw(365);
    expect(screen.getByText(/لا تطلب الرمز على هذا الجهاز لمدة 365 يوماً/)).toBeTruthy();
    cleanup();
    draw(30);
    expect(screen.getByText(/لا تطلب الرمز على هذا الجهاز لمدة 30 يوماً/)).toBeTruthy();
  });
});
