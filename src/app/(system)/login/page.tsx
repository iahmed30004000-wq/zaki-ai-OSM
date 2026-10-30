'use client';

import React, { useEffect, useState } from 'react';
import { SecondFactor } from '@/components/shell/SecondFactor';
import { loginWithPasskey, passkeySupported } from '@/lib/passkey-browser';
import { forgetDock } from '@/lib/dock-memory';
import { showForgotLink } from '@/lib/forgot-link';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent } from '@/components/ui/Card';
import { RiErrorWarningLine, RiFingerprintLine, RiLoader4Line, RiLoginBoxLine, RiTimerLine } from '@remixicon/react';
import { BrandStage } from '@/components/shell/BrandStage';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFlag, setPendingFlag] = useState(false);

  /**
   * SIGNING IN WITH THE FINGERPRINT ALONE.
   *
   * Offered only where the device has a sensor and the page is on a secure
   * origin — `passkeySupported()` answers both. Whether a key exists is
   * never asked here: the browser knows what it holds for this site, and a
   * server that answered «this account has one» would be answering a
   * question nobody signed in has the right to ask.
   */
  const [canFinger, setCanFinger] = useState(false);
  const [fingerBusy, setFingerBusy] = useState(false);

  useEffect(() => {
    void passkeySupported().then(setCanFinger);
    // A session the server ended lands here without the sign-out button —
    // the assistant's conversation from it is forgotten here too.
    forgetDock();
  }, []);

  async function signInWithFinger() {
    setFingerBusy(true);
    setError(null);
    try {
      const started = await fetch('/api/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const offer = await started.json();
      if (!started.ok) throw new Error(offer?.error || 'تعذّر بدء الدخول بالبصمة');

      const assertion = await loginWithPasskey(offer);

      const res = await fetch('/api/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...assertion, challenge: offer.challenge, remember }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذّر الدخول بالبصمة');

      router.push(data.status === 'PENDING' ? '/pending' : '/');
      router.refresh();
    } catch (e) {
      // A cancelled prompt is a person changing their mind, not a failure
      // worth a red box — the password field is still right there.
      const msg = e instanceof Error ? e.message : 'تعذّر الدخول بالبصمة';
      if (!/NotAllowedError|abort|لم تُقرأ/i.test(msg)) setError(msg);
      setFingerBusy(false);
    }
  }
  // Not an error: nothing went wrong, the phone was put down. Saying so
  // plainly is what stops somebody concluding the app signed them out at
  // random and asking for the whole measure to be removed.
  const [wasIdle, setWasIdle] = useState(false);
  /**
   * The second step, for the roles whose password moves money.
   *
   * Held in state rather than routed to: the challenge ticket lives ten
   * minutes and exists only in this page. A route would mean putting it in a
   * URL or a cookie, and a ticket the browser sends everywhere is one some
   * other route eventually gets asked to interpret.
   */
  const [second, setSecond] = useState<{
    step: 'enrol' | 'verify';
    challenge: string;
    email: string;
    /** The server's verdict on why the code is being asked for. */
    askedBecause?: string;
  } | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.search.includes('suspended=1')) {
      setError('تم إيقاف حسابك. يرجى التواصل مع المدير.');
    }
    if (window.location.search.includes('idle=1')) setWasIdle(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setPendingFlag(false);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (data.status === 'PENDING') setPendingFlag(true);
        throw new Error(data.error || 'فشل تسجيل الدخول');
      }

      // The password was right and is not enough. Nothing has been issued.
      if (data.twoFactor) {
        setSecond({
          step: data.twoFactor,
          challenge: data.challenge,
          email: data.email,
          askedBecause: data.askedBecause,
        });
        return;
      }

      // Route by server-verified status — never by client-supplied role
      if (data.status === 'PENDING') {
        router.push('/pending');
      } else {
        router.push('/');
      }
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <BrandStage caption="نظام المبيعات والطلبات والأرباح والذكاء الاصطناعي">
      <div className="space-y-6">
        <Card className="shadow-raised">
          <CardContent className="p-6 space-y-4">
            {wasIdle && !error && (
              <div
                data-testid="idle-notice"
                className="p-3 text-xs rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]"
              >
                أُغلقت الجلسة تلقائياً لعدم الاستخدام — حمايةً للجهاز إن تُرك مفتوحاً. سجّل الدخول للمتابعة.
              </div>
            )}

            {error && (
              <div
                className={`p-3 text-xs rounded-lg flex items-start space-x-2 rtl:space-x-reverse ${
                  pendingFlag
                    ? 'bg-[var(--sys-warning-soft)] border border-[var(--sys-warning)] text-[var(--sys-warning)]'
                    : 'bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
                }`}
              >
                {pendingFlag ? (
                  <RiTimerLine className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <RiErrorWarningLine className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span>
                  {error}
                  {pendingFlag && (
                    <>
                      {' '}
                      <Link href="/pending" className="underline font-semibold">
                        عرض حالة الحساب
                      </Link>
                    </>
                  )}
                </span>
              </div>
            )}

            {second ? (
              <SecondFactor
                step={second.step}
                challenge={second.challenge}
                email={second.email}
                askedBecause={second.askedBecause}
                onSignedIn={(status) => {
                  router.push(status === 'PENDING' ? '/pending' : '/');
                  router.refresh();
                }}
                onCancel={() => {
                  setSecond(null);
                  setPassword('');
                }}
              />
            ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="البريد الإلكتروني"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />

              <Input
                label="كلمة المرور"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />

              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center space-x-2 rtl:space-x-reverse text-[var(--sys-foreground)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="w-3.5 h-3.5 rounded-lg border-[var(--sys-border)] bg-[var(--sys-card)] accent-[var(--sys-primary)]"
                  />
                  <span>تذكرني</span>
                </label>
                {/*
                  «نسيت كلمة المرور» DOES NOTHING ON A REAL SERVER (A5). No mail is sent from here, so the link led a person to
                  a promise nobody keeps; the owner sets a new password from the user's page. It stays in development, where
                  the token is printed for the developer, and NEXT_PUBLIC_SHOW_RESET_LINK=true brings it back in
                  production (read when the app is built).
                */}
                {showForgotLink() && (
                  <Link href="/forgot-password" className="text-[var(--sys-primary)] hover:underline">
                    نسيت كلمة المرور؟
                  </Link>
                )}
              </div>

              <Button type="submit" loading={loading} className="w-full">
                <RiLoginBoxLine className="icon-mirror w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                تسجيل الدخول
              </Button>

              {/*
                THE FINGERPRINT AS THE DOOR, NOT A SECOND LOCK ON IT.

                Shown only where the device can actually answer: a button
                that opens a prompt the device cannot show teaches somebody
                the product is broken. Nothing here says whether a key
                exists for this account — that would be a way to ask the
                login page which accounts have one.
              */}
              {canFinger && (
                <>
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-[var(--sys-border)]" />
                    <span className="text-xs text-[var(--sys-muted)]">أو</span>
                    <span className="h-px flex-1 bg-[var(--sys-border)]" />
                  </div>
                  <button
                    type="button"
                    onClick={() => void signInWithFinger()}
                    disabled={fingerBusy}
                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--sys-border)] px-4 py-2.5 text-sm font-medium text-[var(--sys-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)] disabled:opacity-50"
                  >
                    {fingerBusy ? (
                      <RiLoader4Line className="h-5 w-5 animate-spin" />
                    ) : (
                      <RiFingerprintLine className="h-5 w-5" aria-hidden />
                    )}
                    ادخل ببصمتك
                  </button>
                  <p className="text-center text-xs text-[var(--sys-muted)]">
                    بعد تسجيل بصمة هذا الجهاز من «الملف الشخصي».
                  </p>
                </>
              )}
            </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-[var(--sys-muted-foreground)]">
          ليس لديك حساب؟{' '}
          <Link href="/register" className="text-[var(--sys-primary)] font-semibold hover:underline">
            أنشئ حساباً جديداً
          </Link>{' '}
          — سيكون بانتظار موافقة المدير
        </p>
      </div>
    </BrandStage>
  );
}
