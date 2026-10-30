'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { createPasskey, passkeySupported } from '@/lib/passkey-browser';
import { useConfirm } from '@/components/ui/Confirm';
import { Input } from '@/components/ui/Input';
import { RiDeleteBinLine, RiFingerprintLine, RiLoader4Line } from '@remixicon/react';

/**
 * THE FINGERPRINTS THAT MAY SIGN ME IN.
 *
 * Registering one is a signed-in act on purpose: adding a way into an
 * account is not something a way in should be able to do on its own. You
 * prove who you are the old way first — password, and the code if your role
 * needs one — and only then may you add a finger.
 *
 * AND IT SAYS WHAT IT REPLACES. «البصمة بدل الرمز» is the whole promise, and
 * a screen that implies a passkey replaces the password would be teaching
 * somebody that a picked-up phone is an open account.
 */

interface Key {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeySection() {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // THE PASSWORD IS ASKED FOR BEFORE A WAY IN IS ADDED (A1): being signed in is not enough to bolt a key onto the account.
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/passkey');
      if (res.ok) setKeys(((await res.json()) as { keys: Key[] }).keys ?? []);
      else setKeys([]);
    } catch {
      setKeys([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void passkeySupported().then(setSupported);
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const start = await fetch('/api/auth/passkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const offer = await start.json();
      if (!start.ok) throw new Error(offer?.error || 'تعذّر بدء التسجيل');

      const made = await createPasskey(offer);
      const label =
        typeof navigator !== 'undefined' && /iphone|ipad|android/i.test(navigator.userAgent)
          ? 'الهاتف'
          : 'هذا الجهاز';

      const res = await fetch('/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...made, label }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'تعذّر تسجيل البصمة');
      setAsking(false);
      await load();
    } catch (e) {
      // A cancelled dialog is not a failure worth a red box.
      const msg = e instanceof Error ? e.message : 'تعذّر تسجيل البصمة';
      setError(/NotAllowedError|abort/i.test(msg) ? null : msg);
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  async function remove(id: string, label: string) {
    // A way to sign in, removed by one press. The device that holds the key still holds it, but this account stops accepting it.
    const ok = await confirm({
      title: `حذف «${label}»؟`,
      body: 'لن تستطيع الدخول بها بعد الآن، وتحتاج تسجيلها من جديد لتعود.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await fetch(`/api/auth/passkey?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <RiFingerprintLine className="h-5 w-5 text-[var(--sys-primary)]" aria-hidden />
            الدخول بالبصمة
          </span>
        }
        subtitle="بصمتُك أو وجهُك على هذا الجهاز تقوم مقام رمز التطبيق عند تسجيل الدخول — لا مقام كلمة المرور."
      />
      <CardContent className="space-y-3">
        {supported === false && (
          <p className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-3 text-sm text-[var(--sys-muted-foreground)]">
            هذا الجهاز لا يوفّر بصمةً أو تعرُّفَ وجه — أو الاتصالُ غير آمن (تحتاج HTTPS). رمزُ التطبيق
            يعمل كالمعتاد.
          </p>
        )}

        {keys && keys.length > 0 && (
          <ul className="divide-y divide-[var(--sys-border)] rounded-lg border border-[var(--sys-border)]">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-2 px-3 py-2">
                <RiFingerprintLine className="h-4 w-4 shrink-0 text-[var(--sys-muted)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--sys-heading)]">
                    {k.label || 'مفتاح'}
                  </span>
                  <span className="block text-xs text-[var(--sys-muted-foreground)]">
                    سُجِّل {new Date(k.createdAt).toISOString().slice(0, 10)}
                    {k.lastUsedAt
                      ? ` · آخر استعمال ${new Date(k.lastUsedAt).toISOString().slice(0, 10)}`
                      : ' · لم يُستعمل بعد'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void remove(k.id, k.label || 'المفتاح')}
                  disabled={busy}
                  title={`احذف ${k.label || 'المفتاح'}`}
                  aria-label={`احذف ${k.label || 'المفتاح'}`}
                  className="min-h-11 md:min-h-0 rounded-md p-2 text-[var(--sys-muted-foreground)] hover:text-[var(--sys-destructive)] disabled:opacity-50"
                >
                  <RiDeleteBinLine className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {keys?.length === 0 && supported !== false && (
          <p className="text-sm text-[var(--sys-muted-foreground)]">
            لا بصمةَ مسجَّلة. سجّل واحدةً لتدخل بلمسةٍ بدل كتابة الرمز في كلّ مرّة.
          </p>
        )}

        {error && (
          <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        {supported !== false && asking && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="space-y-3"
          >
            <Input
              label="كلمة المرور الحالية"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="bg-[var(--sys-card)]"
            />
            <button
              type="submit"
              disabled={busy || password.length === 0}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--sys-primary)] px-4 py-2 text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
            >
              {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiFingerprintLine className="h-4 w-4" />}
              أكّد وسجّل البصمة
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setPassword('');
                setError(null);
              }}
              className="h-11 w-full text-xs text-[var(--sys-muted-foreground)]"
            >
              رجوع
            </button>
          </form>
        )}

        {supported !== false && !asking && (
          <button
            type="button"
            onClick={() => setAsking(true)}
            disabled={busy}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--sys-primary)] px-4 py-2 text-sm font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
          >
            <RiFingerprintLine className="h-4 w-4" />
            سجّل بصمةَ هذا الجهاز
          </button>
        )}

        {/*
          THE WAY BACK IS NEVER REMOVED.
          A fingerprint on a broken phone must not be a locked account — and
          that pressure is exactly how a second factor gets switched off for
          everybody.
        */}
        <p className="text-xs text-[var(--sys-muted)]">
          رمزُ التطبيق ورموزُ الاسترداد تبقى تعمل دائماً. البصمةُ اختصارٌ لا بديلٌ عنها.
        </p>
      </CardContent>
    </Card>
  );
}
