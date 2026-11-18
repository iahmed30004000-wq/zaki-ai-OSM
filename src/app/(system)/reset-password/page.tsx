'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent } from '@/components/ui/Card';
import { RiErrorWarningLine, RiLockPasswordLine } from '@remixicon/react';

function ResetForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      /*
       * The password changed; the second factor is still owed. The reset
       * door no longer signs a session, so this goes where both halves
       * are asked.
       */
      router.push(data.status === 'PENDING' ? '/pending' : '/login');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-note rounded-lg">
        رابط إعادة التعيين غير صالح — اطلب رابطاً جديداً من صفحة استعادة كلمة المرور.
      </div>
    );
  }

  return (
    <Card className="shadow-raised">
      <CardContent className="p-6 space-y-4">
        {error && (
          <div className="p-3 bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)] text-note rounded-lg flex items-center space-x-2 rtl:space-x-reverse">
            <RiErrorWarningLine className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="كلمة المرور الجديدة *"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="bg-[var(--sys-card)]"
          />
          <Input
            label="تأكيد كلمة المرور *"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className="bg-[var(--sys-card)]"
          />
          <Button type="submit" loading={loading} className="w-full">
            <RiLockPasswordLine className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
            تعيين كلمة المرور الجديدة
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen bg-[var(--sys-surface)] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <img src="/brand/mark.png" alt="" aria-hidden className="h-20 w-20 object-contain" />
          <h1 className="text-2xl font-semibold text-[var(--sys-heading)]">تعيين كلمة مرور جديدة</h1>
        </div>

        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>

        <p className="text-center text-note text-[var(--sys-muted-foreground)]">
          <Link href="/login" className="text-[var(--sys-primary)] font-semibold hover:underline">
            العودة لتسجيل الدخول
          </Link>
        </p>
      </div>
    </div>
  );
}
