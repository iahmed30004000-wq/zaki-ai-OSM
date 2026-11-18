// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SIGN-IN DOOR ON THE KIT (R17a, 18/11) — AND NOTHING ELSE MOVED.
 *
 * The door everybody walks through every morning: the password, the second step, the store picker, the account-state
 * screens, and the three error pages. Their presses, ticks and surfaces were hand-written; they are the kit's now. What
 * this file holds is that the LOOK moved and the DOOR did not:
 *
 *   · password → shell, password → code → shell, the fingerprint where it was;
 *   · a wrong code shows the server's own sentence and empties the box;
 *   · a second press while the first is in the air reaches the server ZERO more times (the code, the fingerprint, the
 *     password, the store tile);
 *   · the code box keeps its one-time-code autofill, its numeric keyboard, its six-character gate;
 *   · «تذكرني» is the kit's tick box with an id of its own, and `remember` still travels in the JSON body;
 *   · the picker's tiles stay whole-card presses a keyboard can reach;
 *   · at 375px nothing on these screens asks for a width the phone does not have.
 *
 * Class names below are built from pieces: the stylesheet is generated from every source file, tests included, and a
 * class-like token written here would become a rule in the first-load sheet.
 * ═══════════════════════════════════════════════════════════════════════
 */

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh }),
  useSearchParams: () => search,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const passkey = vi.hoisted(() => ({
  supported: false,
  loginWithPasskey: vi.fn<(o: unknown) => Promise<unknown>>(),
  signWithPasskey: vi.fn<(o: unknown) => Promise<unknown>>(),
}));
vi.mock('@/lib/passkey-browser', () => ({
  passkeySupported: async () => passkey.supported,
  loginWithPasskey: (o: unknown) => passkey.loginWithPasskey(o),
  signWithPasskey: (o: unknown) => passkey.signWithPasskey(o),
}));

const apiJson = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>());
vi.mock('@/lib/api-client', () => ({ apiJson: (url: string, init?: RequestInit) => apiJson(url, init) }));

const signOut = vi.hoisted(() => vi.fn<(reason?: string) => Promise<undefined>>(async () => undefined));
vi.mock('@/lib/sign-out', () => ({ signOut: (reason?: string) => signOut(reason) }));

const refreshUser = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { email: 'a@b.c' }, refreshUser }),
}));

import LoginPage from '@/app/(system)/login/page';
import { SignInPolicyProvider } from './SignInPolicy';
import { SecondFactor } from './SecondFactor';
import { EntryPicker } from './EntryPicker';
import { NoAccessScreen, PendingScreen } from './AccountScreens';
import SystemError from '@/app/(system)/error';
import NotFound from '@/app/(system)/not-found';
import Forbidden from '@/app/forbidden';
import RegisterPage from '@/app/(system)/register/page';
import ForgotPasswordPage from '@/app/(system)/forgot-password/page';

// The frame paints the theme and loads the fonts (server-only work); the pages inside it are what is under test.
vi.mock('@/app/(system)/SystemFrame', () => ({ SystemFrame: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const repo = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** A fetch whose answers are queued per call; each call is recorded with its parsed body. */
type Answer = { ok: boolean; body: unknown } | 'hang';
function fakeFetch(answers: Answer[]) {
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers.shift() ?? { ok: true, body: {} };
    if (a === 'hang') return new Promise<Response>(() => undefined);
    return { ok: a.ok, json: async () => a.body } as Response;
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

function drawLogin(rememberBox = true) {
  return render(
    <SignInPolicyProvider value={{ rememberBox, trustDays: 30 }}>
      <LoginPage />
    </SignInPolicyProvider>
  );
}

async function typeAndSend(email = 'a@b.c', password = 'secret-1') {
  fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: email } });
  fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: password } });
  await act(async () => {
    fireEvent.submit(document.querySelector('form')!);
  });
}

/** Every class on every element in the container, split into single tokens. */
function tokens(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
}

/** A class that asks for a width wider than a 375px phone: an arbitrary px/rem width, a screen-wide or a fixed big step. */
function tooWide(root: HTMLElement): string[] {
  const W = ['w', 'min-w'].map((p) => p + '-' + '[');
  return tokens(root).filter((t) => {
    const bare = t.replace(/^[a-z]+:/, '') === t ? t : '';
    if (!bare) return false; // a desk-only (`md:`…) width never reaches the phone
    for (const w of W) {
      if (!bare.startsWith(w)) continue;
      const m = bare.slice(w.length).match(/^(\d+(?:\.\d+)?)(px|rem)\]$/);
      if (m && Number(m[1]) * (m[2] === 'rem' ? 16 : 1) > 375) return true;
    }
    return bare === 'w' + '-screen' || /^(?:min-)?w-(?:9[6-9]|\d{3,})$/.test(bare);
  });
}

beforeEach(() => {
  passkey.supported = false;
  search = new URLSearchParams();
  window.history.replaceState(null, '', '/login');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─────────────────────────── the password door ───────────────────────────

describe('the password door', () => {
  it('a right password with no second step goes straight in, and «تذكرني» is sent as it was ticked', async () => {
    const calls = fakeFetch([{ ok: true, body: { status: 'ACTIVE' } }]);
    drawLogin(true);
    const box = document.getElementById('login-remember') as HTMLInputElement;
    expect(box, 'الصندوق بلا معرّف خاص به').toBeTruthy();
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(true);
    // The words are the target: pressing «تذكرني» unticks the box.
    fireEvent.click(screen.getByText('تذكرني'));
    expect(box.checked).toBe(false);
    await typeAndSend();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/auth/login');
    expect(calls[0].body).toEqual({ email: 'a@b.c', password: 'secret-1', remember: false });
    expect(push).toHaveBeenCalledWith('/');
    expect(refresh).toHaveBeenCalled();
  });

  it('NEGATIVE: a ticked box sends remember: true — the value is the box, not a constant', async () => {
    const calls = fakeFetch([{ ok: true, body: { status: 'ACTIVE' } }]);
    drawLogin(true);
    await typeAndSend();
    expect(calls[0].body?.remember).toBe(true);
  });

  it('a pending account goes to /pending', async () => {
    fakeFetch([{ ok: true, body: { status: 'PENDING' } }]);
    drawLogin(false);
    await typeAndSend();
    expect(push).toHaveBeenCalledWith('/pending');
  });

  it('a refused password shows the server sentence and stays on the door', async () => {
    fakeFetch([{ ok: false, body: { error: 'بيانات الدخول غير صحيحة' } }]);
    drawLogin(false);
    await typeAndSend();
    expect(screen.getByText('بيانات الدخول غير صحيحة')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('a second press of «تسجيل الدخول» while the first is in the air reaches the server zero more times', async () => {
    const calls = fakeFetch(['hang']);
    drawLogin(false);
    fireEvent.change(document.querySelector('input[type="email"]')!, { target: { value: 'a@b.c' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'secret-1' } });
    const send = screen.getByText('تسجيل الدخول').closest('button') as HTMLButtonElement;
    expect(send.type).toBe('submit');
    await act(async () => {
      fireEvent.click(send);
    });
    expect(send.disabled, 'الزر بقي مفتوحاً أثناء الطلب').toBe(true);
    await act(async () => {
      fireEvent.click(send);
    });
    expect(calls.filter((c) => c.url === '/api/auth/login')).toHaveLength(1);
  });

  it('the register and «نسيت كلمة المرور» links are where they were', () => {
    fakeFetch([]);
    drawLogin(false);
    expect(screen.getByText('أنشئ حساباً جديداً').closest('a')?.getAttribute('href')).toBe('/register');
    // Off a production build the forgot link is drawn (forgot-link.ts).
    expect(screen.getByText('نسيت كلمة المرور؟').closest('a')?.getAttribute('href')).toBe('/forgot-password');
  });

  it('the idle and replaced notices are still drawn from the address, inside a card', () => {
    fakeFetch([]);
    window.history.replaceState(null, '', '/login?idle=1&replaced=1');
    drawLogin(false);
    expect(screen.getByTestId('idle-notice')).toBeTruthy();
    expect(screen.getByTestId('replaced-notice')).toBeTruthy();
  });
});

// ─────────────────────────── the fingerprint ───────────────────────────

describe('the fingerprint at the door', () => {
  it('is a kit button where the device can answer, and a second press does not start a second prompt', async () => {
    passkey.supported = true;
    passkey.loginWithPasskey.mockReturnValue(new Promise(() => undefined));
    const calls = fakeFetch([{ ok: true, body: { challenge: 'c', rpId: 'localhost' } }]);
    drawLogin(false);
    const finger = (await screen.findByText('ادخل ببصمتك')).closest('button') as HTMLButtonElement;
    expect(finger.type).toBe('button');
    await act(async () => {
      fireEvent.click(finger);
    });
    expect(finger.disabled, 'زر البصمة بقي مفتوحاً').toBe(true);
    await act(async () => {
      fireEvent.click(finger);
    });
    expect(calls.filter((c) => c.url === '/api/auth/passkey/login')).toHaveLength(1);
    expect(passkey.loginWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: no sensor, no button', async () => {
    fakeFetch([]);
    drawLogin(false);
    await act(async () => undefined);
    expect(screen.queryByText('ادخل ببصمتك')).toBeNull();
  });
});

// ─────────────────────────── the second step ───────────────────────────

describe('password → the code → in', () => {
  it('the server asks for a code: the step opens, the code box keeps its autofill, keyboard and gate', async () => {
    fakeFetch([{ ok: true, body: { twoFactor: 'verify', challenge: 't1', email: 'a@b.c' } }, { ok: true, body: {} }]);
    drawLogin(false);
    await typeAndSend();
    const code = document.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
    expect(code, 'خانة الرمز فقدت one-time-code').toBeTruthy();
    expect(code.getAttribute('inputmode')).toBe('numeric');
    const go = screen.getByText('تحقّق وادخل').closest('button') as HTMLButtonElement;
    expect(go.type).toBe('submit');
    fireEvent.change(code, { target: { value: '12345' } });
    expect(go.disabled, 'خمسة أرقام فتحت الزر').toBe(true);
    fireEvent.change(code, { target: { value: '123456' } });
    expect(go.disabled).toBe(false);
  });

  it('a right code signs in; the trust box is the kit tick box with its own id and is sent', async () => {
    const calls = fakeFetch([{ ok: true, body: { status: 'ACTIVE' } }]);
    const onSignedIn = vi.fn();
    render(<SecondFactor step="verify" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={onSignedIn} onCancel={() => undefined} />);
    const trust = document.getElementById('second-factor-trust') as HTMLInputElement;
    expect(trust?.type).toBe('checkbox');
    expect(trust.checked).toBe(true);
    fireEvent.click(screen.getByText(/لا تطلب الرمز على هذا الجهاز لمدة 30 يوماً/));
    expect(trust.checked).toBe(false);
    fireEvent.change(document.querySelector('input[autocomplete="one-time-code"]')!, { target: { value: '123456' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form')!);
    });
    const verify = calls.filter((c) => c.url === '/api/auth/2fa/verify');
    expect(verify).toHaveLength(1);
    expect(verify[0].body).toEqual({ challenge: 't1', code: '123456', trustDevice: false });
    expect(onSignedIn).toHaveBeenCalledWith('ACTIVE');
  });

  it('a wrong code shows the SAME server sentence and empties the box', async () => {
    fakeFetch([{ ok: false, body: { error: 'الرمز غير صحيح' } }]);
    render(<SecondFactor step="verify" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={() => undefined} />);
    const code = document.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
    fireEvent.change(code, { target: { value: '000000' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form')!);
    });
    expect(screen.getByText('الرمز غير صحيح')).toBeTruthy();
    expect(code.value).toBe('');
  });

  it('a second press of «تحقّق وادخل» while the first is in the air reaches the server zero more times', async () => {
    const calls = fakeFetch(['hang']);
    render(<SecondFactor step="verify" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(document.querySelector('input[autocomplete="one-time-code"]')!, { target: { value: '123456' } });
    const go = screen.getByText('تحقّق وادخل').closest('button') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(go);
    });
    expect(go.disabled, 'الزر بقي مفتوحاً أثناء التحقق').toBe(true);
    await act(async () => {
      fireEvent.click(go);
    });
    expect(calls.filter((c) => c.url === '/api/auth/2fa/verify')).toHaveLength(1);
  });

  it('«رجوع» is a press that is not a submit, and goes back', () => {
    fakeFetch([]);
    const onCancel = vi.fn();
    render(<SecondFactor step="verify" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={onCancel} />);
    const back = screen.getByText('رجوع').closest('button') as HTMLButtonElement;
    expect(back.type, '«رجوع» صار يرسل النموذج').toBe('button');
    fireEvent.click(back);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the fingerprint inside the step: one press, one assertion', async () => {
    passkey.supported = true;
    passkey.signWithPasskey.mockReturnValue(new Promise(() => undefined));
    const calls = fakeFetch([{ ok: true, body: { challenge: 'p', rpId: 'localhost', allowCredentials: [] } }]);
    render(<SecondFactor step="verify" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={() => undefined} />);
    const finger = (await screen.findByText('ادخل ببصمتك')).closest('button') as HTMLButtonElement;
    expect(finger.type).toBe('button');
    await act(async () => {
      fireEvent.click(finger);
    });
    await act(async () => {
      fireEvent.click(finger);
    });
    expect(passkey.signWithPasskey).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === '/api/auth/passkey/assert')).toHaveLength(1); // the offer only
  });

  it('enrolment: the setup code box keeps one-time-code, and the recovery codes end on a kit press back', async () => {
    fakeFetch([
      { ok: true, body: { secret: 'S', uri: 'otpauth://x', qr: 'data:image/png;base64,AA' } },
      { ok: true, body: { recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] } },
    ]);
    const onCancel = vi.fn();
    render(<SecondFactor step="enrol" challenge="t1" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={onCancel} />);
    await screen.findByAltText('رمز الإعداد');
    const code = document.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
    expect(code.getAttribute('inputmode')).toBe('numeric');
    fireEvent.change(code, { target: { value: '123456' } });
    await act(async () => {
      fireEvent.submit(document.querySelector('form')!);
    });
    expect(screen.getByText('AAAAA-BBBBB')).toBeTruthy();
    fireEvent.click(screen.getByText('حفظتُها — إلى تسجيل الدخول'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────── the picker ───────────────────────────

const CONTEXT = {
  countries: [
    { id: 'c1', code: 'SY', name: 'بلد أول', currencyCode: 'SYP', activeStores: 2 },
    { id: 'c2', code: 'JO', name: 'بلد ثانٍ', currencyCode: 'JOD', activeStores: 1 },
  ],
  stores: [],
  selection: null,
  next: 'PICK_COUNTRY',
  canAddCountry: true,
  canAddStore: false,
  skipCountryPicker: false,
};

describe('the picker', () => {
  it('each country is a whole-card press a keyboard reaches, and choosing one posts it once', async () => {
    let release: () => void = () => undefined;
    apiJson.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') await new Promise<void>((r) => (release = r));
      return url === '/api/context' && !init ? CONTEXT : {};
    });
    render(<EntryPicker />);
    const tile = (await screen.findByText('بلد أول')).closest('button') as HTMLButtonElement;
    expect(tile, 'البلد لم يعد زراً').toBeTruthy();
    expect(tile.disabled).toBe(false);
    tile.focus();
    expect(document.activeElement, 'لوحة المفاتيح لا تصل البلد').toBe(tile);
    await act(async () => {
      fireEvent.click(tile);
    });
    expect(tile.disabled, 'البلد بقي مفتوحاً أثناء الاختيار').toBe(true);
    await act(async () => {
      fireEvent.click(tile);
    });
    expect(apiJson.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    await act(async () => release());
  });

  it('a store tile posts {countryId, storeId} once, and locks while the choice is in the air', async () => {
    let release: () => void = () => undefined;
    const ctx = {
      ...CONTEXT,
      next: 'PICK_STORE',
      selection: { countryId: 'c1', storeId: null },
      stores: [{ id: 's1', name: 'متجر أول', slug: 's1', logo: null, status: 'ACTIVE', type: 'GENERAL' }],
    };
    apiJson.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') await new Promise<void>((r) => (release = r));
      return url === '/api/context' && !init ? ctx : {};
    });
    render(<EntryPicker />);
    const tile = (await screen.findByText('متجر أول')).closest('button') as HTMLButtonElement;
    expect(tile.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(tile);
    });
    expect(tile.disabled, 'المتجر بقي مفتوحاً أثناء الاختيار').toBe(true);
    await act(async () => {
      fireEvent.click(tile);
    });
    const posts = apiJson.mock.calls.filter(([, i]) => i?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/context');
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ countryId: 'c1', storeId: 's1' });
    await act(async () => release());
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('«إضافة بلد» opens the form, and its submit is the kit button', async () => {
    apiJson.mockResolvedValue(CONTEXT);
    render(<EntryPicker />);
    const add = (await screen.findByText('إضافة بلد')).closest('button') as HTMLButtonElement;
    expect(add.type).toBe('button');
    fireEvent.click(add);
    const submit = screen.getByText('إضافة البلد').closest('button') as HTMLButtonElement;
    expect(submit.type).toBe('submit');
  });

  it('the store step: «تغيير البلد» goes back to the countries', async () => {
    apiJson.mockResolvedValue({
      ...CONTEXT,
      next: 'PICK_STORE',
      selection: { countryId: 'c1', storeId: null },
      stores: [{ id: 's1', name: 'متجر أول', slug: 's1', logo: null, status: 'ACTIVE', type: 'GENERAL' }],
    });
    render(<EntryPicker />);
    await screen.findByText('متجر أول');
    const back = screen.getByText('تغيير البلد').closest('button') as HTMLButtonElement;
    expect(back.type).toBe('button');
    fireEvent.click(back);
    expect(await screen.findByText('اختر البلد')).toBeTruthy();
  });

  it('a single country the server marks READY skips the picker, as today', async () => {
    apiJson.mockResolvedValue({ ...CONTEXT, next: 'READY' });
    render(<EntryPicker />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
  });
});

// ─────────────────────────── account states ───────────────────────────

describe('the account-state screens', () => {
  it('pending: «تحديث الحالة» asks again then reloads, and «تسجيل الخروج» signs out', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<PendingScreen />);
    await act(async () => {
      fireEvent.click(screen.getByText('تحديث الحالة'));
    });
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByText('تسجيل الخروج'));
    });
    expect(signOut).toHaveBeenCalledWith('manual');
  });

  it('no access: «تحديث» and «تسجيل الخروج» both still answer', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<NoAccessScreen />);
    fireEvent.click(screen.getByText('تحديث'));
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByText('تسجيل الخروج'));
    });
    expect(signOut).toHaveBeenCalledWith('manual');
  });
});

// ─────────────────────────── the error pages ───────────────────────────

describe('the error pages', () => {
  it('the system error offers the first screen and a retry that retries', () => {
    const retry = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SystemError error={new Error('x')} retry={retry} />);
    expect(screen.getByText('العودة إلى شاشتك الأولى').closest('a')?.getAttribute('href')).toBe('/');
    const again = screen.getByText('أعد المحاولة').closest('button') as HTMLButtonElement;
    expect(again.type).toBe('button');
    fireEvent.click(again);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('not-found and forbidden still lead home', () => {
    render(<NotFound />);
    expect(screen.getByText('الصفحة غير موجودة')).toBeTruthy();
    expect(screen.getByText('العودة إلى شاشتك الأولى').closest('a')?.getAttribute('href')).toBe('/');
    cleanup();
    render(<Forbidden />);
    expect(screen.getByText('لا تملك صلاحية لهذه الشاشة')).toBeTruthy();
    expect(screen.getByText('العودة إلى شاشتك الأولى').closest('a')?.getAttribute('href')).toBe('/');
  });
});

// ─────────────────────────── 375px ───────────────────────────

describe('at 375px, nothing on the door is wider than the phone', () => {
  it('the helper is not vacuous: it catches a wide arbitrary width and a big fixed step', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p class="${'w' + '-[' + '420px]'}"></p><p class="${'w' + '-' + '120'}"></p><p class="md:${'w' + '-[' + '900px]'}"></p>`;
    expect(tooWide(root)).toHaveLength(2);
  });

  it('login, the code step, the picker (both steps), the account screens and the error pages', async () => {
    fakeFetch([]);
    const screens: [string, () => ReturnType<typeof render>][] = [
      ['login', () => drawLogin(true)],
      ['code', () => render(<SecondFactor step="verify" challenge="t" email="a@b.c" trustDays={30} onSignedIn={() => undefined} onCancel={() => undefined} />)],
      ['pending', () => render(<PendingScreen />)],
      ['no-access', () => render(<NoAccessScreen />)],
      ['error', () => render(<SystemError error={new Error('x')} retry={() => undefined} />)],
      ['not-found', () => render(<NotFound />)],
      ['forbidden', () => render(<Forbidden />)],
      ['register', () => render(<RegisterPage />)],
      ['forgot', () => render(<ForgotPasswordPage />)],
    ];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [name, draw] of screens) {
      const { container } = draw();
      expect(tooWide(container), `${name}: عرض ثابت أعرض من الهاتف`).toEqual([]);
      cleanup();
    }
    apiJson.mockResolvedValue({
      ...CONTEXT,
      next: 'PICK_STORE',
      selection: { countryId: 'c1', storeId: null },
      stores: [{ id: 's1', name: 'متجر أول', slug: 's1', logo: null, status: 'ACTIVE', type: 'GENERAL' }],
    });
    const { container } = render(<EntryPicker />);
    await screen.findByText('متجر أول');
    expect(tooWide(container), 'المتاجر: عرض ثابت').toEqual([]);
    // The tiles fill the column and wrap their words: full width, a shrinkable text block, no nowrap.
    const tile = screen.getByText('متجر أول').closest('button') as HTMLButtonElement;
    expect(tile.className.split(/\s+/)).toContain('w' + '-full');
    expect(tile.querySelector('.' + 'min-w-0'), 'نص البطاقة لا ينكمش').toBeTruthy();
    expect(tokens(container)).not.toContain('whitespace' + '-nowrap');
  });
});

// ─────────────────────────── the source, where a render cannot see ───────────────────────────

describe('the sign-in door is on the kit, and its logic did not move', () => {
  const FILES = [
    'src/app/(system)/login/page.tsx',
    'src/components/shell/SecondFactor.tsx',
    'src/components/shell/AccountScreens.tsx',
    'src/app/(system)/error.tsx',
  ];

  it('no hand-written press and no hand-written tick box is left in the door (the picker tiles are the listed exception)', () => {
    for (const f of FILES) {
      const src = stripComments(repo(f));
      expect(src, `${f}: زر مكتوب باليد`).not.toMatch(/<button[\s>]/);
      expect(src, `${f}: صندوق اختيار مكتوب باليد`).not.toMatch(/<input[^>]*type="checkbox"/);
    }
    const picker = stripComments(repo('src/components/shell/EntryPicker.tsx'));
    // Exactly the two whole-card tiles (country, store) stay raw — a tile with an icon and two lines is not a kit button.
    expect((picker.match(/<button[\s>]/g) ?? []).length, 'زر خام جديد في المنتقي').toBe(2);
  });

  it('the handlers with their own lock are not handed to the kit as promises (one lock, as before)', () => {
    const login = stripComments(repo('src/app/(system)/login/page.tsx'));
    expect(login).toMatch(/onClick=\{\(\) => \{\s*void signInWithFinger\(\);\s*\}\}/);
    expect(login).toMatch(/disabled=\{fingerBusy\}/);
    const second = stripComments(repo('src/components/shell/SecondFactor.tsx'));
    expect(second).toMatch(/onClick=\{\(\) => \{\s*void withFinger\(\);\s*\}\}/);
    expect(second).toMatch(/disabled=\{busy \|\| code\.trim\(\)\.length < 6\}/);
  });

  /*
   * MEASURED 18/11, NOT GUESSED. The kit's `Card` on the pending / no-access screens and on the picker's two forms made
   * Turbopack re-cut a chunk the layout shares: «طلباتي» went 410.7 → 416.7 KB gzipped (29 files, over its 416 ceiling)
   * and the sign-in page 222.0 → 228.3, for three hand-drawn boxes. Without it: 410.9. The system error page, the
   * dashboard 404 and the 403 sit in every route's tree as boundaries, so they keep their hand-drawn card too. These
   * surfaces are on R19's allowed list until the kit's card stops pulling the figure helpers (Sparkline, HealthChip,
   * money) into anything that imports it.
   */
  it('the screens outside the sign-in route do not import the kit card (it cost every screen 6 KB)', () => {
    for (const f of [
      'src/components/shell/AccountScreens.tsx',
      'src/components/shell/EntryPicker.tsx',
      'src/app/(system)/error.tsx',
      'src/app/(system)/not-found.tsx',
      'src/app/forbidden.tsx',
    ]) {
      expect(stripComments(repo(f)), `${f}: يستورد بطاقة الطقم`).not.toMatch(/from '@\/components\/ui\/Card'/);
    }
  });

  it('the doors called are the same doors', () => {
    const login = stripComments(repo('src/app/(system)/login/page.tsx'));
    expect(login).toContain("fetch('/api/auth/login'");
    expect(login).toContain('body: JSON.stringify({ email, password, remember })');
    const second = stripComments(repo('src/components/shell/SecondFactor.tsx'));
    for (const door of ["'/api/auth/2fa/verify'", "'/api/auth/2fa/start'", "'/api/auth/2fa/enrol'", "'/api/auth/passkey/assert'"]) {
      expect(second, door).toContain(door);
    }
    expect(second).toContain('body: JSON.stringify({ challenge, code, trustDevice })');
  });
});
