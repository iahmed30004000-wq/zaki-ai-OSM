'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent } from '@/components/ui/Card';
import { RiCheckboxBlankCircleLine, RiCheckLine, RiErrorWarningLine, RiShieldCheckLine, RiTimerLine, RiUserAddLine } from '@remixicon/react';

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const passwordChecks = [
    { label: '8 أحرف على الأقل', ok: password.length >= 8 },
    { label: 'حرف كبير', ok: /[A-Z]/.test(password) },
    { label: 'حرف صغير', ok: /[a-z]/.test(password) },
    { label: 'رقم', ok: /[0-9]/.test(password) },
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, password, confirmPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'فشل إنشاء الحساب');
      }

      setSuccess(data.message);
      setTimeout(() => {
        /*
         * TO THE LOGIN SCREEN, NOT INTO THE SYSTEM.
         *
         * Registering no longer sets a session cookie: a new account has
         * no second factor enrolled yet, and `/login` is the one door that
         * asks for it. Pushing to `/` here would land on a screen with no
         * session and bounce back anyway — the redirect is the honest
         * version of what now happens.
         */
        router.push(data.status === 'PENDING' ? '/pending' : '/login');
        router.refresh();
      }, 1200);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--sys-surface)] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <img src="/brand/mark.png" alt="" aria-hidden className="h-20 w-20 object-contain" />
          <h1 className="text-2xl font-semibold text-[var(--sys-heading)]">إنشاء حساب جديد</h1>
          <p className="text-note text-[var(--sys-muted-foreground)]">
            Zaki AI OMS — نظام إدارة المبيعات والطلبات والأرباح
          </p>
        </div>

        <Card className="shadow-raised">
          <CardContent className="p-6 space-y-4">
            {error && (
              <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-note rounded-lg flex items-center space-x-2 rtl:space-x-reverse">
                <RiErrorWarningLine className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div className="p-3 bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)] text-note rounded-lg flex items-center space-x-2 rtl:space-x-reverse">
                <RiShieldCheckLine className="w-4 h-4 shrink-0" />
                <span>{success}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="الاسم الكامل *"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />

              <Input
                label="البريد الإلكتروني *"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />

              <div>
                <Input
                  label="كلمة المرور *"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="bg-[var(--sys-card)]"
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {passwordChecks.map((c) => (
                    <span
                      key={c.label}
                      className={`inline-flex items-center gap-1 text-note px-2 py-0.5 rounded-full border ${
                        c.ok
                          ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success-soft)]'
                          : 'bg-[var(--sys-surface)] text-[var(--sys-muted-foreground)] border-[var(--sys-border)]'
                      }`}
                    >
                      {c.ok ? (
                        <RiCheckLine className="h-4 w-4 shrink-0" aria-hidden />
                      ) : (
                        <RiCheckboxBlankCircleLine className="h-4 w-4 shrink-0" aria-hidden />
                      )}
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>

              <Input
                label="تأكيد كلمة المرور *"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />

              <Button type="submit" loading={loading} className="w-full">
                <RiUserAddLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                إنشاء الحساب
              </Button>
            </form>

            <Card plain padding="sm" className="text-note text-[var(--sys-foreground)]">
              <p className="flex items-start space-x-2 rtl:space-x-reverse">
                <RiTimerLine className="w-4 h-4 text-[var(--sys-warning)] shrink-0 mt-0.5" />
                <span>
                  بعد التسجيل يكون حسابك بحالة <strong className="text-[var(--sys-heading)]">بانتظار الموافقة</strong>،
                  ويقوم مدير النظام بتعيين دورك وتنشيط حسابك قبل الوصول للوحدات.
                </span>
              </p>
            </Card>
          </CardContent>
        </Card>

        <p className="text-center text-note text-[var(--sys-muted-foreground)]">
          لديك حساب؟{' '}
          <Link href="/login" className="text-[var(--sys-primary)] font-semibold hover:underline">
            تسجيل الدخول
          </Link>
          {' • '}
          <Link href="/forgot-password" className="text-[var(--sys-foreground)] hover:underline">
            نسيت كلمة المرور؟
          </Link>
        </p>
      </div>
    </div>
  );
}
