'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useApp } from '@/context/AppContext';
import { ScoreCard } from '@/components/performance/ScoreCard';
import { ThemePicker } from '@/components/settings/ThemePicker';
import { MenuOrderCard } from '@/components/settings/MenuOrderCard';
import { PasskeySection } from '@/components/settings/PasskeySection';
import { RiCheckboxCircleLine, RiErrorWarningLine, RiShieldCheckLine } from '@remixicon/react';
import { PageShell } from '@/components/ui/PageShell';
import { routeLabel } from '@/lib/route-registry';

export function ProfileScreen() {
  const { currentUser, refreshUser } = useApp();

  const [name, setName] = useState(currentUser?.name || '');
  const [avatar, setAvatar] = useState(currentUser?.avatar || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const payload: any = {};
      if (name !== currentUser?.name) payload.name = name;
      if (avatar !== (currentUser?.avatar || '')) payload.avatar = avatar;
      if (newPassword) {
        if (newPassword !== confirmPassword) {
          throw new Error('كلمتا المرور غير متطابقتين');
        }
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }

      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setMessage({ type: 'success', text: 'تم حفظ التغييرات بنجاح' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await refreshUser();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
      <PageShell
        title={routeLabel('/admin/profile')}
        width="narrow"
        description="تحديث بياناتك الشخصية وكلمة المرور — الدور والصلاحيات يديرها المدير فقط"
      >
        {message && (
          <div
            className={`p-3 rounded-lg text-sm flex items-center space-x-2 rtl:space-x-reverse ${
              message.type === 'success'
                ? 'bg-[var(--sys-success-soft)] border-0 text-[var(--sys-success)]'
                : 'bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'
            }`}
          >
            {message.type === 'success' ? (
              <RiCheckboxCircleLine className="w-4 h-4 shrink-0" />
            ) : (
              <RiErrorWarningLine className="w-4 h-4 shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* Their own numbers, on their own page, without anybody having to
            grant them anything. A person who cannot see where they stand
            cannot be asked to improve it. */}
        {/* How the system looks, on the page about them. It applies the
            moment it is clicked — choosing a theme means looking at it. */}
        <Card padding="md">
          <ThemePicker initial={currentUser?.systemTheme} />
        </Card>

        {/*
          AND THE MENU, ON THE SAME PAGE AND FOR THE SAME REASON.

          Arranging your own menu is a personal preference, exactly like
          the theme above it — and it needs no permission, because it
          opens nothing: the menu it arranges is already filtered per
          viewer and every door checks itself when it is opened.

          It is here and NOT a screen of its own in the menu, because the
          one rule about that menu is that only «حسابي» is open to
          everybody (`acceptance.test.ts`). A screen everybody may open
          would have had to be an exception to it, and the page about the
          person was the right place anyway.

          Setting a ROLE's base is the part that needs authority, and this
          component offers it only to `roles.edit` — checked again on the
          server.
        */}
        <MenuOrderCard />

        <ScoreCard />

        <form onSubmit={handleSave} className="space-y-6">
          {/* Account info (read-only) */}
          <Card>
            <CardHeader
              title="معلومات الحساب"
              subtitle="تُدار من قِبل مدير النظام — للقراءة فقط"
            />
            <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-[var(--sys-muted)] block">البريد الإلكتروني</span>
                <span className="font-bold text-[var(--sys-heading)]">{currentUser?.email}</span>
              </div>
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-[var(--sys-muted)] block">الدور</span>
                <Badge variant="info">{currentUser?.role}</Badge>
              </div>
              <div className="bg-[var(--sys-surface)] p-3 rounded-lg">
                <span className="text-[var(--sys-muted)] block">حالة الحساب</span>
                <Badge variant={currentUser?.status === 'ACTIVE' ? 'success' : 'warning'}>
                  {currentUser?.status}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Editable profile */}
          <Card>
            <CardHeader
              title="البيانات الشخصية"
              subtitle="الاسم وصورة الملف"
            />
            <CardContent className="space-y-4">
              <Input
                label="الاسم الكامل"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label="رابط صورة الملف (اختياري)"
                placeholder="https://example.com/avatar.jpg"
                value={avatar || ''}
                onChange={(e) => setAvatar(e.target.value)}
              />
              {avatar && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt="معاينة الصورة"
                  className="w-16 h-16 rounded-full object-cover border-2 border-[var(--sys-destructive-border)]"
                />
              )}
            </CardContent>
          </Card>

          {/* Password */}
          <Card>
            <CardHeader
              title="تغيير كلمة المرور"
              subtitle="اتركها فارغة إن لم ترغب بالتغيير"
            />
            <CardContent className="space-y-4">
              <Input
                label="كلمة المرور الحالية"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="كلمة المرور الجديدة"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <Input
                  label="تأكيد كلمة المرور الجديدة"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <p className="text-note text-[var(--sys-muted-foreground)] flex items-center space-x-1.5 rtl:space-x-reverse">
                <RiShieldCheckLine className="w-4 h-4 text-[var(--sys-destructive)]" />
                <span>تغيير كلمة المرور يُنهي جميع الجلسات النشطة على حسابك.</span>
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button type="submit" loading={loading}>
              حفظ التغييرات
            </Button>
          </div>
        </form>

        {/* Outside the form: registering a key is its own act, and a finger
            on the sensor must not be submitting a name change with it. */}
        <PasskeySection />
      </PageShell>
  );
}
