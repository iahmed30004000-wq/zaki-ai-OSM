import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVICE_COOKIE,
  SUSPICION_WINDOW_MS,
  claimsFor,
  deviceCookieOptions,
  forgetBadPasswords,
  judgeTrust,
  noteBadPassword,
  recentBadPassword,
  trustDays,
} from './trusted-device';
import {
  createDeviceToken,
  verifyDeviceToken,
  createSessionToken,
  verifySessionToken,
  sessionCookieOptions,
} from './auth';
import { IDLE_LIMIT_MS } from './exposure';
import { stripComments } from './guard-source';
import { SignJWT } from 'jose';

/**
 * «ال 2fa يحتفظ بتسجيل الدخول لاني مش كل شوي خ ادخل الرمز
 *  بس اذا صار نشاط مشبوه يطلبو»
 *
 * WHY IT WAS BEING ASKED FOR SO OFTEN, MEASURED: a screen untouched for
 * twenty minutes signs the account out, and every sign-in verified the
 * second factor again. Four meetings in a day is four reaches for the
 * phone — and a rule reached for that often is a rule people work around,
 * which ends with the second factor switched off for everybody.
 *
 * THE ONE SENTENCE THIS WHOLE FILE DEFENDS: a trusted device stands in for
 * the SIX DIGITS and never for the PASSWORD. Ⅰ.a is that sentence as a
 * test, read out of the login route itself.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const ENROLLED = new Date('2026-10-01T08:00:00.000Z');
const user = { id: 'u-1', totpEnabledAt: ENROLLED };

beforeEach(forgetBadPasswords);
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Ⅰ · what a trusted device replaces', () => {
  it('a · the password is checked BEFORE the verdict is even asked for', () => {
    /*
     * The most important ordering in the feature, so it is read from the
     * source rather than trusted. If `judgeTrust` ran before the password
     * comparison, a device cookie alone would open the account.
     */
    const src = read('src/app/api/auth/login/route.ts');
    const password = src.indexOf('verifyPassword(password');
    const refuse = src.indexOf("return NextResponse.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, { status: 401 });", password);
    const verdict = src.indexOf('judgeTrust(');
    expect(password, 'لا فحصَ لكلمةِ المرور').toBeGreaterThan(-1);
    expect(verdict, 'لا حُكمَ على الجهاز').toBeGreaterThan(-1);
    expect(refuse, 'لا رفضَ لكلمةِ مرورٍ خاطئة').toBeGreaterThan(password);
    expect(verdict, 'حُكمُ الجهازِ قبلَ كلمةِ المرور — الكوكي وحدَها تَفتَح').toBeGreaterThan(refuse);
  });

  it('b · and the skip only ever bypasses the code, never the password', () => {
    const src = read('src/app/api/auth/login/route.ts');
    // The trusted branch issues the session; it does not sit before the
    // password check, and it is inside the `step === 'verify'` arm.
    const verify = src.indexOf("if (step === 'verify')");
    const trusted = src.indexOf('if (verdict.trusted)');
    expect(verify).toBeGreaterThan(-1);
    expect(trusted).toBeGreaterThan(verify);
    expect(src).toContain("factor: 'password+device'");
  });
});

describe('Ⅱ · the verdict, as a pure function', () => {
  it('trusts a device whose token matches the enrolment', () => {
    expect(judgeTrust({ claims: claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED }), user, suspicious: false }))
      .toEqual({ trusted: true });
  });

  it('asks for the code when there is no token at all — a new phone', () => {
    expect(judgeTrust({ claims: null, user, suspicious: false })).toEqual({ trusted: false, why: 'no-token' });
  });

  it('and a device trusted for one person is not trusted for the next', () => {
    const other = claimsFor({ id: 'u-2', totpEnabledAt: ENROLLED });
    expect(judgeTrust({ claims: other, user, suspicious: false })).toEqual({ trusted: false, why: 'other-user' });
  });

  it('and re-enrolling 2FA drops every device in the world at once', () => {
    /*
     * THE REVOCATION, AND IT NEEDS NO LIST. The token carries the moment
     * the authenticator was enrolled. Reset it and the number no longer
     * matches — on every device, immediately, with nothing to clean up.
     */
    const old = claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED });
    const reset = { id: 'u-1', totpEnabledAt: new Date('2026-10-09T12:00:00.000Z') };
    expect(judgeTrust({ claims: old, user: reset, suspicious: false }))
      .toEqual({ trusted: false, why: 're-enrolled' });
  });

  it('and one millisecond of difference is a different enrolment', () => {
    const old = claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED });
    const off = { id: 'u-1', totpEnabledAt: new Date(ENROLLED.getTime() + 1) };
    expect(judgeTrust({ claims: old, user: off, suspicious: false }).trusted).toBe(false);
  });

  it('and trusts nothing when there is no authenticator to stand in for', () => {
    const claims = claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED });
    expect(judgeTrust({ claims, user: { id: 'u-1', totpEnabledAt: null }, suspicious: false }))
      .toEqual({ trusted: false, why: 'not-enrolled' });
  });

  it('and suspicion overrides a token that is otherwise perfect', () => {
    const claims = claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED });
    expect(judgeTrust({ claims, user, suspicious: true })).toEqual({ trusted: false, why: 'suspicious' });
  });

  it('and a structural failure reports itself rather than hiding behind suspicion', () => {
    // Both wrong at once: the reason on the audit row should be the one a
    // person can act on, and «this is not your device» is that one.
    const other = claimsFor({ id: 'u-2', totpEnabledAt: ENROLLED });
    expect(judgeTrust({ claims: other, user, suspicious: true })).toEqual({ trusted: false, why: 'other-user' });
  });
});

describe('Ⅲ · what counts as suspicious — «اذا صار نشاط مشبوه»', () => {
  const T = 1_760_000_000_000;

  it('a wrong password just now makes the next sign-in ask for the code', () => {
    noteBadPassword('Owner@Example.com', T);
    expect(recentBadPassword('owner@example.com', T + 1000)).toBe(true);
  });

  it('and the email is matched however it was typed', () => {
    noteBadPassword('  OWNER@example.COM ', T);
    expect(recentBadPassword('owner@example.com', T)).toBe(true);
  });

  it('and it wears off after a quarter of an hour', () => {
    noteBadPassword('owner@example.com', T);
    expect(recentBadPassword('owner@example.com', T + SUSPICION_WINDOW_MS - 1)).toBe(true);
    expect(recentBadPassword('owner@example.com', T + SUSPICION_WINDOW_MS)).toBe(false);
  });

  it('and an account nobody has fumbled is not suspicious', () => {
    expect(recentBadPassword('quiet@example.com', T)).toBe(false);
  });

  it('and a later success does NOT clear it, deliberately', () => {
    /*
     * «Somebody guessed wrong at this account minutes ago» stays true
     * whoever typed next. The cost is one code entry after a typo, and
     * that is the trade — written here so it is a decision rather than an
     * accident, and so changing it is a decision too.
     */
    noteBadPassword('owner@example.com', T);
    expect(recentBadPassword('owner@example.com', T + 60_000)).toBe(true);
  });

  it('and it is noted only after the account was found', () => {
    /*
     * Otherwise anyone could type a stranger's email with any password and
     * make that stranger's next login stricter — a way to pester somebody
     * through a login form.
     */
    const src = stripComments(read('src/app/api/auth/login/route.ts'));
    /*
     * COUNTED, NOT ONLY PLACED. The first version of this test compared
     * two indices — and a mutation that ADDED a second call inside the
     * «no such user» branch sat after the first index and passed it. One
     * call, and it is the one after the password was compared.
     */
    const calls = [...src.matchAll(/noteBadPassword\(/g)];
    expect(calls.length, 'عددُ مواضعِ التسجيلِ ليس واحداً').toBe(1);
    const compared = src.indexOf('await verifyPassword(password');
    expect(compared, 'لا مقارنةَ لكلمةِ المرور').toBeGreaterThan(-1);
    expect(calls[0].index!, 'سُجِّلَ قبلَ مقارنةِ كلمةِ المرور').toBeGreaterThan(compared);
  });

  it('and an address is NOT one of the signals, because it cannot vary here', () => {
    /*
     * `getClientIp` returns the constant `'local'` unless TRUST_PROXY is
     * set, so «a new address» would be always-true or always-false. A
     * signal that cannot vary reads as a protection while protecting
     * nothing — which is worse than having none.
     */
    const src = read('src/lib/trusted-device.ts');
    // The REASON is in the prose, so the prose names `getClientIp`. The
    // rule is about the CODE — which is the fifth time in this repository
    // that a sweep reading comments has been the bug rather than the find.
    expect(src, 'السببُ غيرُ مكتوب').toMatch(/TRUST_PROXY/);
    expect(stripComments(src)).not.toMatch(/getClientIp|x-forwarded-for/);
  });
});

describe('Ⅳ · the two tokens are signed with one key and are not interchangeable', () => {
  it('a device token verifies as a device token', async () => {
    const token = await createDeviceToken(claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED }));
    expect(await verifyDeviceToken(token)).toEqual({ typ: 'device', sub: 'u-1', enr: ENROLLED.getTime() });
  });

  it('and is REFUSED as a session, though the signature is perfectly valid', async () => {
    /*
     * Both are HS256 over the same `JWT_SECRET`. Without `typ` a device
     * token is a structurally valid session token — `getCurrentUser` would
     * reject it today only because it carries no `tv`, and that is luck,
     * not a rule.
     */
    const token = await createDeviceToken(claimsFor({ id: 'u-1', totpEnabledAt: ENROLLED }));
    expect(await verifySessionToken(token), 'رمزُ جهازٍ قُبِلَ كجلسة').toBeNull();
  });

  it('and a session token is refused as a device token', async () => {
    const token = await createSessionToken({
      userId: 'u-1',
      email: 'o@e.com',
      role: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      companyId: 'c-1',
      tv: 3,
    });
    expect(await verifyDeviceToken(token), 'رمزُ جلسةٍ قُبِلَ كجهازٍ موثوق').toBeNull();
  });

  it('and `typ` is what refuses it — not the shape it happens to have', async () => {
    /*
     * THE TEST ABOVE PASSED FOR THE WRONG REASON, and a mutation proved
     * it: a session token carries `userId`, not `sub`, so dropping the
     * `typ` check entirely still refused it. The real question is what
     * happens to a token that LOOKS exactly like a device token and does
     * not say it is one.
     *
     * Signed with the server's own key on purpose — the strongest case
     * there is, an attacker who already holds `JWT_SECRET`. Even then the
     * token must be refused, because `typ` is a claim and not a guess.
     */
    const secret = new TextEncoder().encode(
      process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
        ? process.env.JWT_SECRET
        : 'development_only_insecure_jwt_secret_key_0000'
    );
    const shaped = async (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(secret);

    // Right shape, no `typ` at all.
    expect(
      await verifyDeviceToken(await shaped({ sub: 'u-1', enr: ENROLLED.getTime() })),
      'رمزٌ بلا نوعٍ قُبِلَ كجهازٍ موثوق'
    ).toBeNull();

    // Right shape, the WRONG `typ`.
    expect(
      await verifyDeviceToken(await shaped({ typ: 'session', sub: 'u-1', enr: ENROLLED.getTime() })),
      'نوعٌ آخرُ قُبِلَ كجهازٍ موثوق'
    ).toBeNull();

    // And `enr` must be a number, not a string that looks like one.
    expect(
      await verifyDeviceToken(await shaped({ typ: 'device', sub: 'u-1', enr: String(ENROLLED.getTime()) })),
      'تاريخُ تسجيلٍ نصّيٌّ قُبِل'
    ).toBeNull();

    // The control: the same signer, the right claims, accepted. Without
    // this the three refusals above could all be «the key is wrong».
    expect(
      await verifyDeviceToken(await shaped({ typ: 'device', sub: 'u-1', enr: ENROLLED.getTime() })),
      'المفتاحُ في الاختبارِ ليس مفتاحَ الخادم — الرفوضُ أعلاه لا تُثبِتُ شيئاً'
    ).toEqual({ typ: 'device', sub: 'u-1', enr: ENROLLED.getTime() });
  });

  it('and nothing unsigned gets through', async () => {
    expect(await verifyDeviceToken(undefined)).toBeNull();
    expect(await verifyDeviceToken('')).toBeNull();
    expect(await verifyDeviceToken('not.a.token')).toBeNull();
    // A payload somebody wrote by hand, unsigned (alg: none style).
    const forged = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ typ: 'device', sub: 'u-1', enr: ENROLLED.getTime() })
    ).toString('base64url')}.`;
    expect(await verifyDeviceToken(forged), 'رمزٌ غيرُ موقَّعٍ قُبِل').toBeNull();
  });
});

describe('Ⅴ · the cookie', () => {
  it('is its own, so ending a session never ends the trust', () => {
    expect(DEVICE_COOKIE).not.toBe('salesflow_session');
    // And the logout route clears the session cookie only.
    const src = read('src/app/api/auth/logout/route.ts');
    expect(src).not.toContain(DEVICE_COOKIE);
  });

  it('lasts the thirty days «تذكرني» lasts — two numbers that disagree is a bug nobody sees', () => {
    // 11/11 (the owner's ruling: «يحتفظ بتسجيل الدخول ع طول»): «تذكرني» is thirty days only under `AUTH_SHORT_SESSIONS=on` now,
    // so this is the rule as it was, under that switch — the trust must still equal the longest sign-in. The default (a year)
    // is the test below. Modified, not removed.
    vi.stubEnv('AUTH_SHORT_SESSIONS', 'on');
    expect(trustDays()).toBe(30);
    expect(deviceCookieOptions().maxAge).toBe(60 * 60 * 24 * 30);
    expect(deviceCookieOptions().maxAge, 'الثقة غير «تذكرني»').toBe(sessionCookieOptions(true).maxAge);
    // The number is read from ONE place (session-length.ts), not written a second time in auth.ts.
    const auth = read('src/lib/auth.ts');
    expect(auth).toMatch(/maxAge: 60 \* 60 \* 24 \* sessionDays\(remember\)/);
    expect(auth).not.toMatch(/\(remember \? 30 : 7\)/);
  });

  it('and under the owner’s rule (the default) it lasts the year every sign-in lasts — still agreeing', () => {
    expect(trustDays()).toBe(365);
    expect(deviceCookieOptions().maxAge).toBe(60 * 60 * 24 * 365);
    expect(deviceCookieOptions().maxAge, 'الثقة غير أطول جلسة').toBe(sessionCookieOptions(true).maxAge);
    expect(deviceCookieOptions().maxAge).toBe(sessionCookieOptions(false).maxAge);
  });

  it('and is http-only and strict — the login endpoint is the only reader', () => {
    const o = deviceCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe('strict');
    expect(o.path).toBe('/');
  });

  it('and outlives the idle timeout by a wide margin, which is the whole point', () => {
    // Twenty minutes signs the session out; the trust must not go with it,
    // or the feature answers nothing.
    expect(deviceCookieOptions().maxAge * 1000).toBeGreaterThan(IDLE_LIMIT_MS * 100);
  });
});

describe('Ⅵ · a device becomes trusted by PROVING, not by asking', () => {
  const src = stripComments(read('src/app/api/auth/2fa/verify/route.ts'));
  const issuer = stripComments(read('src/lib/sign-in.ts'));

  it('the trust is granted on the far side of the code check', () => {
    const checked = src.indexOf('checkSecondFactor(');
    const granted = src.indexOf('trustDevice:');
    expect(checked, 'لا فحصَ للرمز').toBeGreaterThan(-1);
    expect(granted, 'لا منحَ للثقة').toBeGreaterThan(-1);
    expect(granted, 'الثقةُ تُمنَحُ قبلَ فحصِ الرمز').toBeGreaterThan(checked);
  });

  it('and NEITHER door writes a cookie of its own', () => {
    /*
     * The rule is `two-factor.test.ts`'s and it predates this feature: the
     * day a route is allowed to set a cookie is the day one sets the
     * SESSION cookie without the `tokenVersion` bump. The trust is a
     * cookie, so it goes where the session cookie goes — which is also
     * why `issueSession` is the only thing that touches `cookies.set`.
     */
    for (const rel of ['src/app/api/auth/login/route.ts', 'src/app/api/auth/2fa/verify/route.ts']) {
      expect(stripComments(read(rel)), `${rel}: يكتب كوكي بنفسه`).not.toContain('cookies.set');
    }
    expect(issuer, 'مُصدِرُ الجلسةِ لا يَمنَحُ الثقة').toContain('DEVICE_COOKIE');
  });

  it('and never after a recovery code — refused twice over', () => {
    /*
     * A recovery code means the authenticator was not to hand — which is
     * also what it means when somebody else holds the account. One printed
     * code must not buy thirty days of skipping the second factor, and
     * printed codes are exactly what gets photographed.
     *
     * Two independent refusals, deliberately: the caller knows
     * `usedRecovery`, and the issuer insists the factor be `password+totp`.
     * Either one alone still refuses.
     */
    expect(src, 'الطالبُ لا يَستثني رمزَ الاسترداد').toMatch(/trustDevice: trustThisDevice && !result\.usedRecovery/);
    expect(issuer, 'المُصدِرُ لا يَشترِطُ عاملاً حقيقيّاً').toMatch(
      /input\.trustDevice && input\.factor === 'password\+totp'/
    );
  });

  it('and the browser’s word is read as a yes/no and nothing else', () => {
    expect(src).toMatch(/trustDevice === true/);
  });

  it('and the trusting is its own audit row', () => {
    expect(issuer).toContain('TWO_FACTOR_DEVICE_TRUSTED');
  });

  it('and the sign-in that skipped the code says so on its own row', () => {
    const signIn = read('src/lib/sign-in.ts');
    expect(signIn).toContain("'password+device'");
    // And that word can never itself grant trust: a device-skipped sign-in
    // must not silently renew the thirty days it is spending.
    expect(issuer).not.toMatch(/factor === 'password\+device'/);
    // The factor already travels onto the audit row; this pins that the new
    // word is part of the same union rather than a second mechanism.
    expect(signIn).toMatch(/factor: input\.factor/);
  });
});

describe('Ⅶ · and the person is told why, when they are asked anyway', () => {
  it('the server sends its reason', () => {
    expect(read('src/app/api/auth/login/route.ts')).toMatch(/askedBecause: verdict\.why/);
  });

  it('and the screen has a sentence for the one reason a person will meet', () => {
    const src = read('src/components/shell/SecondFactor.tsx');
    expect(src).toMatch(/askedBecause === 'suspicious'/);
    expect(src).toContain('كلمة مرور خاطئة');
    // «it said it would not ask, and it asked» is how a security measure
    // gets switched off. The sentence is the thing that prevents that.
    expect(src).toContain('جهازك ما زال موثوقاً');
  });

  it('and the box says what it is really promising', () => {
    const src = read('src/components/shell/SecondFactor.tsx');
    // The number is INTERPOLATED, for two reasons at once: the screen rule
    // forbids Arabic-Indic digits in anything a person reads, and a label
    // that hard-codes «30» is a label that keeps saying 30 after the
    // constant is changed to 14.
    // 11/11: the number is the SERVER's now — a year or thirty days by `AUTH_SHORT_SESSIONS` — and the browser has no
    // environment, so the box takes it as a prop (`trustDays`) the login page hands down from the login layout; it is still
    // interpolated and never written in. Modified, not removed: the promise of the test is the same.
    expect(src).toContain('لا تطلب الرمز على هذا الجهاز لمدة {trustDays} يوماً');
    expect(src, 'الصندوقُ يُحدِّدُ المدّةَ بنفسِه').toMatch(/trustDays: number;/);
    expect(src, 'الصندوقُ يقرأ الرقمَ من بيئةِ المتصفّحِ بدل الخادم').not.toMatch(/from '@\/lib\/trusted-device'/);
    expect(read('src/app/(system)/login/page.tsx'), 'صفحةُ الدخولِ لا تُمرِّرُ رقمَ الخادم').toContain(
      'trustDays={policy.trustDays}'
    );
    expect(read('src/app/(system)/login/layout.tsx'), 'الـlayout لا يقرأُ الرقمَ من مكانِه الواحد').toContain('trustDays()');
    expect(src, 'الصندوقُ لا يَقولُ إنَّ كلمةَ المرورِ تَبقى مطلوبة').toContain('كلمة المرور تبقى مطلوبة');
  });
});
