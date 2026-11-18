'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent } from '@/components/ui/Card';
import { RiErrorWarningLine, RiKey2Line, RiShieldCheckLine } from '@remixicon/react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuccess(data.message);
      setDevToken(data.devToken || null);
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
          <h1 className="text-2xl font-semibold text-[var(--sys-heading)]">استعادة كلمة المرور</h1>
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
              <div className="p-3 bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)] text-note rounded-lg space-y-2">
                <p className="flex items-center space-x-2 rtl:space-x-reverse">
                  <RiShieldCheckLine className="w-4 h-4 shrink-0" />
                  <span>{success}</span>
                </p>
                {devToken && (
                  <Card plain padding="sm">
                    <p className="text-note text-[var(--sys-muted-foreground)] mb-1">وضع التطوير — رابط إعادة التعيين:</p>
                    <Link
                      href={`/reset-password?token=${devToken}`}
                      className="text-[var(--sys-primary)] font-mono text-note break-all hover:underline"
                    >
                      /reset-password?token={devToken.slice(0, 20)}...
                    </Link>
                  </Card>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="البريد الإلكتروني المسجل"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-[var(--sys-card)]"
              />
              <Button type="submit" loading={loading} className="w-full">
                <RiKey2Line className="w-4 h-4 ml-1.5 rtl:ml-0 rtl:mr-1.5" />
                إرسال رابط إعادة التعيين
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-note text-[var(--sys-muted-foreground)]">
          <Link href="/login" className="text-[var(--sys-primary)] font-semibold hover:underline">
            العودة لتسجيل الدخول
          </Link>
        </p>
      </div>
    </div>
  );
}
