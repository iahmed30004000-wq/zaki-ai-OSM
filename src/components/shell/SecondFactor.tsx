'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { TRUST_DAYS } from '@/lib/trusted-device';
import Image from 'next/image';
import { RiFingerprintLine, RiLoader4Line, RiShieldKeyholeLine } from '@remixicon/react';
import { passkeySupported, signWithPasskey } from '@/lib/passkey-browser';

/**
 * THE SECOND STEP OF SIGNING IN.
 *
 * Two shapes from one component, because they are two halves of one moment:
 * a protected role that has an authenticator types six digits, and one that
 * has none sets it up first. Splitting them into two screens would mean two
 * places holding a challenge ticket that expires in ten minutes.
 *
 * THE RECOVERY CODES ARE SHOWN ONCE AND THE SCREEN SAYS SO. They are hashed
 * on the server, so «show them again» is not a feature that was left out —
 * it is a thing that cannot exist. A person who closes this without keeping
 * them has an authenticator and no way back from a broken phone, which is
 * why the button that moves on is the last thing on the page.
 */

interface Props {
  step: 'enrol' | 'verify';
  challenge: string;
  email: string;
  /**
   * WHY THE CODE IS BEING ASKED FOR, from the server's own verdict.
   *
   * A trusted device skips the six digits, so being asked ON a device that
   * was trusted needs a reason — otherwise the measure looks broken and
   * somebody asks for it to be switched off. `suspicious` is the one the
   * owner will meet: a wrong password at this account minutes ago.
   */
  askedBecause?: string;
  onSignedIn: (status: string) => void;
  onCancel: () => void;
}

export function SecondFactor({ step, challenge, email, askedBecause, onSignedIn, onCancel }: Props) {
  return step === 'verify' ? (
    <VerifyStep
      challenge={challenge}
      askedBecause={askedBecause}
      onSignedIn={onSignedIn}
      onCancel={onCancel}
    />
  ) : (
    <EnrolStep challenge={challenge} email={email} onCancel={onCancel} />
  );
}

function VerifyStep({
  challenge,
  askedBecause,
  onSignedIn,
  onCancel,
}: {
  challenge: string;
  askedBecause?: string;
  onSignedIn: (status: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  /**
   * Ticked by default, because the owner asked for this feature and a box
   * they have to find every time is a box that does not solve the problem.
   * The cookie is still only set AFTER the code is accepted — asking to be
   * trusted is not what makes a device trusted.
   */
  const [trustDevice, setTrustDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * THE FINGERPRINT, WHERE THE SIX DIGITS ARE TYPED.
   *
   * Offered only when this device HAS a sensor and this account HAS a key
   * registered — asked of the server, which answers `challenge: null` when
   * there is none. A button that opens a dialog the device cannot show is
   * worse than no button: the person concludes the product is broken
   * rather than that the feature is not set up.
   *
   * It replaces the typing, never the password: getting here at all means
   * the password was already accepted.
   */
  const [offer, setOffer] = useState<{ challenge: string; rpId: string; allowCredentials: string[] } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!(await passkeySupported())) return;
      try {
        const res = await fetch('/api/auth/passkey/assert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge }),
        });
        const data = await res.json().catch(() => ({}));
        if (alive && res.ok && data?.challenge) setOffer(data);
      } catch {
        // No passkey offer is not an error: the code below still works.
      }
    })();
    return () => {
      alive = false;
    };
  }, [challenge]);

  async function withFinger() {
    if (!offer) return;
    setBusy(true);
    setError(null);
    try {
      const assertion = await signWithPasskey(offer);
      const res = await fetch('/api/auth/passkey/assert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, ...assertion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذّر التحقّق بالبصمة');
      onSignedIn(data.status);
    } catch (err) {
      // A refused fingerprint must never be a locked door: the code field
      // is still there, and the message says so.
      setError(
        (err instanceof Error ? err.message : 'تعذّر التحقّق بالبصمة') + ' — يمكنك كتابة الرمز بدلاً منها.'
      );
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, code, trustDevice }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذّر التحقّق');
      onSignedIn(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر التحقّق');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="flex items-start gap-2 text-sm leading-relaxed text-[var(--sys-muted-foreground)]">
        <RiShieldKeyholeLine className="mt-0.5 h-5 w-5 shrink-0 text-[var(--sys-primary)]" aria-hidden />
        <span>افتح تطبيق المصادقة واكتب الرمز المعروض. أو اكتب أحد رموز الاسترداد إن لم يكن الهاتف بيدك.</span>
      </p>

      {askedBecause === 'suspicious' && (
        /*
          THE ONE REASON A PERSON WILL MEET ON THEIR OWN DEVICE.
          Without this sentence the feature reads as unreliable — «it said
          it would not ask and it asked» — and an unreliable security
          measure is one somebody asks to have removed.
        */
        <p
          data-testid="asked-because"
          className="rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-2.5 text-xs leading-relaxed text-[var(--sys-warning)]"
        >
          طُلب الرمز هذه المرة لأنَّ كلمة مرور خاطئة جُرِّبت على هذا الحساب خلال الربع ساعة الماضية — جهازك ما زال موثوقاً.
        </p>
      )}

      {askedBecause === 're-enrolled' && (
        <p
          data-testid="asked-because"
          className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]"
        >
          أُعيد ضبط التحقّق الثنائيّ، فسقطت ثقة كل الأجهزة. اكتب الرمز مرّة واحدة ليُوثَّق هذا الجهاز من جديد.
        </p>
      )}

      {offer && (
        <>
          <button
            type="button"
            onClick={() => void withFinger()}
            disabled={busy}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--sys-primary)] px-4 py-2.5 text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            {busy ? (
              <RiLoader4Line className="h-5 w-5 animate-spin" />
            ) : (
              <RiFingerprintLine className="h-5 w-5" aria-hidden />
            )}
            ادخل ببصمتك
          </button>
          <p className="text-center text-xs text-[var(--sys-muted-foreground)]">أو اكتب الرمز</p>
        </>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">الرمز</span>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="______"
          dir="ltr"
          className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-center text-lg tracking-[0.4em] tabular-nums"
          // The code is read by eye, spaced out: the phone rule that lifts fields to 16px (system.css) would shrink 18 to 16.
          style={{ fontSize: '1.125rem' }}
        />
      </label>

      {/*
        THIRTY DAYS, AND IT REPLACES THE CODE — NEVER THE PASSWORD.
        Said on the box itself, because a person agreeing to «remember this
        device» deserves to know exactly what they are agreeing to.
      */}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
            className="h-4 w-4 rounded-sm border-[var(--sys-border-input)] bg-[var(--sys-card)] accent-[var(--sys-primary)]"
          />
        </span>
        <span className="text-xs leading-relaxed text-[var(--sys-foreground)]">
          لا تطلب الرمز على هذا الجهاز لمدة {TRUST_DAYS} يوماً
          <span className="mt-0.5 block text-[var(--sys-muted-foreground)]">
            كلمة المرور تبقى مطلوبة في كل مرة، والرمز يُطلب فوراً إن حدث نشاط غير معتاد أو أُعيد ضبط التحقّق.
          </span>
        </span>
      </label>

      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || code.trim().length < 6}
        className="h-11 w-full rounded-lg bg-[var(--sys-primary)] text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
      >
        {busy ? <RiLoader4Line className="mx-auto h-5 w-5 animate-spin" aria-hidden /> : 'تحقّق وادخل'}
      </button>
      <button type="button" onClick={onCancel} className="h-11 w-full text-xs text-[var(--sys-muted-foreground)]">
        رجوع
      </button>
    </form>
  );
}

function EnrolStep({ challenge, email, onCancel }: { challenge: string; email: string; onCancel: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // THE OWNER'S CODE (A2). Asked for only when the server says it is required: the first call goes without one, and the
  // answer decides whether this screen shows the code box or the QR.
  const [needCode, setNeedCode] = useState(false);
  const [enrolCode, setEnrolCode] = useState('');

  const start = useCallback(async (typed?: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/auth/2fa/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, enrolCode: typed }),
      });
      const data = await res.json();
      if (typeof data?.code === 'string' && data.code.startsWith('ENROL_CODE')) {
        setNeedCode(true);
        setError(data.code === 'ENROL_CODE_REQUIRED' ? null : data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'تعذّر بدء التفعيل');
      setNeedCode(false);
      setError(null);
      setSetup(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر بدء التفعيل');
    } finally {
      setBusy(false);
    }
  }, [challenge]);

  useEffect(() => {
    void start();
  }, [start]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/2fa/enrol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, secret: setup.secret, code, enrolCode: enrolCode || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذّر التفعيل');
      setCodes(data.recoveryCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر التفعيل');
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-[var(--sys-warning)]/50 bg-[var(--sys-warning-soft)] p-3 text-sm leading-relaxed text-[var(--sys-warning)]">
          <span className="font-bold">احفظ هذه الرموز الآن.</span> تُعرض مرّةً واحدةً ولا يمكن عرضها ثانيةً —
          فهي مخزَّنةٌ مشفّرةً كما تُخزَّن كلمةُ المرور. كلُّ رمزٍ يُستعمل مرّةً، وهو طريقُك للدخول إن ضاع الهاتف.
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3">
          {codes.map((c) => (
            <li key={c} className="text-center text-sm font-semibold tabular-nums text-[var(--sys-heading)]" dir="ltr">
              {c}
            </li>
          ))}
        </ul>
        <button
          onClick={onCancel}
          className="h-11 w-full rounded-lg bg-[var(--sys-primary)] text-sm font-medium text-[var(--sys-primary-foreground)]"
        >
          حفظتُها — إلى تسجيل الدخول
        </button>
      </div>
    );
  }

  if (needCode && !setup) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start(enrolCode);
        }}
        className="space-y-4"
      >
        <p className="text-sm leading-relaxed text-[var(--sys-muted-foreground)]">
          تفعيل التحقّق بخطوتين يحتاج رمزاً يعطيك إياه المدير. اطلبه منه واكتبه هنا.
        </p>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">رمز التفعيل</span>
          <input
            autoFocus
            value={enrolCode}
            onChange={(e) => setEnrolCode(e.target.value)}
            placeholder="_____-_____"
            dir="ltr"
            autoComplete="off"
            className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-center text-lg tracking-[0.4em] tabular-nums"
            style={{ fontSize: '1.125rem' }}
          />
        </label>
        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || enrolCode.trim().length < 8}
          className="h-11 w-full rounded-lg bg-[var(--sys-primary)] text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
        >
          {busy ? <RiLoader4Line className="mx-auto h-5 w-5 animate-spin" aria-hidden /> : 'تابع'}
        </button>
        <button type="button" onClick={onCancel} className="h-11 w-full text-xs text-[var(--sys-muted-foreground)]">
          رجوع
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={confirm} className="space-y-4">
      <p className="text-sm leading-relaxed text-[var(--sys-muted-foreground)]">
        دورُك يتطلّب تحقّقاً ثنائيّاً. امسح الرمز بتطبيق مصادقة (Google Authenticator أو ما يشبهه)، ثمّ اكتب
        الرمز الذي يعرضه لإثبات أنّه يعمل.
      </p>

      {setup ? (
        <>
          <div className="flex justify-center">
            <Image
              src={setup.qr}
              alt="رمز الإعداد"
              width={200}
              height={200}
              unoptimized
              className="rounded-lg"
            />
          </div>
          <details className="text-xs text-[var(--sys-muted-foreground)]">
            <summary className="cursor-pointer">لا تستطيع المسح؟ أدخل المفتاح يدويّاً</summary>
            <p className="mt-2 break-all rounded-lg bg-[var(--sys-surface)] p-2 font-mono text-[var(--sys-heading)]" dir="ltr">
              {setup.secret}
            </p>
            <p className="mt-1">الحساب: <span dir="ltr">{email}</span></p>
          </details>
        </>
      ) : (
        !error && <p className="text-center text-sm text-[var(--sys-muted-foreground)]">…يُحضَّر الرمز</p>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-[var(--sys-heading)]">الرمز من التطبيق</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="______"
          dir="ltr"
          className="h-11 w-full rounded-lg border border-[var(--sys-border-input)] bg-[var(--sys-card)] px-3 text-center text-lg tracking-[0.4em] tabular-nums"
          // The code is read by eye, spaced out: the phone rule that lifts fields to 16px (system.css) would shrink 18 to 16.
          style={{ fontSize: '1.125rem' }}
        />
      </label>

      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !setup || code.trim().length < 6}
        className="h-11 w-full rounded-lg bg-[var(--sys-primary)] text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
      >
        {busy ? <RiLoader4Line className="mx-auto h-5 w-5 animate-spin" aria-hidden /> : 'فعّل التحقّق الثنائيّ'}
      </button>
      <button type="button" onClick={onCancel} className="h-11 w-full text-xs text-[var(--sys-muted-foreground)]">
        رجوع
      </button>
    </form>
  );
}
