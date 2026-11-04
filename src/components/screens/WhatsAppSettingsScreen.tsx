'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/Card';
import { useApp } from '@/context/AppContext';
import { screenApi as crmApi } from '@/lib/screen-api';
import { RiCheckboxCircleLine, RiCloseCircleLine, RiErrorWarningLine, RiRefreshLine, RiShieldFlashLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { arDateTime } from '@/lib/format';
import { userCan } from '@/lib/can';
import { WhatsAppAfterNoAnswerCard } from '@/components/settings/WhatsAppAfterNoAnswerCard';

/**
 * `embedded` — a card of «الربط» (`/settings/links`), which owns the page's title: the
 * page padding and the screen's own heading are not drawn, and a plain section heading
 * with the way to the inbox stands instead.
 */
export function WhatsAppSettingsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { currentUser } = useApp();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'test' | 'reconnect' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [conn, setConn] = useState<any>(null);

  const canManage = userCan(currentUser, 'whatsapp.manage');

  const load = useCallback(async () => {
    try {
      const d: any = await crmApi('/api/whatsapp/connection');
      setConn(d);
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'تعذر تحميل الإعدادات' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const runAction = async (kind: 'test' | 'reconnect') => {
    setBusy(kind); setMessage(null);
    try {
      const d: any = await crmApi(`/api/whatsapp/connection/${kind}`, { method: 'POST', body: JSON.stringify({}) });
      if (d.ok) {
        setMessage({ type: 'success', text: kind === 'test' ? 'تم اختبار الاتصال بنجاح' : 'تمت إعادة الاتصال بنجاح' });
      } else {
        setMessage({ type: 'error', text: d.error || 'تعذر الاتصال بواتساب' });
      }
      await load();
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'تعذر الاتصال بواتساب' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <>
        <Card><CardContent className="py-12 text-center text-sm text-[var(--sys-muted-foreground)]">جارٍ التحميل...</CardContent></Card>
      </>
    );
  }

  if (!canManage) {
    return (
      <>
        <div className="p-8">
          <div className="max-w-md mx-auto mt-20 text-center p-8 bg-[var(--sys-card)] rounded-lg border border-[var(--sys-border)]">
            <RiShieldFlashLine className="w-6 h-6 mx-auto text-[var(--sys-primary)]" />
            <h2 className="mt-4 font-bold text-[var(--sys-heading)]">ليس لديك صلاحية لإدارة واتساب</h2>
          </div>
        </div>
      </>
    );
  }

  const status = conn?.status || 'NEEDS_SETUP';
  const c = conn?.connection;

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'WhatsApp Business', value: c?.displayName || '—' },
    { label: 'رقم الهاتف', value: c?.phoneNumber ? <span dir="ltr">{c.phoneNumber}</span> : '—' },
    { label: 'WABA ID', value: c?.wabaId || (conn?.envConfigured ? 'من متغيرات البيئة' : '—') },
    { label: 'Phone Number ID', value: c?.phoneNumberId || (conn?.envConfigured ? 'من متغيرات البيئة' : '—') },
    { label: 'آخر Webhook', value: c?.lastWebhookAt ? arDateTime(c.lastWebhookAt) : 'لا يوجد' },
    { label: 'آخر رسالة', value: c?.lastMessageAt ? arDateTime(c.lastMessageAt) : 'لا يوجد' },
    { label: 'آخر خطأ', value: c?.lastError || 'لا يوجد' },
  ];

  return (
    <>
      <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-2xl'}>
        {embedded ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-[var(--sys-heading)]">واتساب</h2>
              <p className="text-xs text-[var(--sys-muted-foreground)]">ربط رقم WhatsApp Business واحد مشترك لكل الموظفين</p>
            </div>
            <Link href="/growth/whatsapp/inbox" className="text-xs font-semibold text-[var(--sys-primary)] hover:underline">
              صندوق الواتساب
            </Link>
          </div>
        ) : (
        <PageHeader title="إعدادات واتساب"
            description="ربط رقم WhatsApp Business واحد مشترك لكل الموظفين"
            actions={
              <><Link href="/growth/whatsapp/inbox" className="text-xs font-semibold text-[var(--sys-primary)] hover:underline">
            العودة للصندوق
          </Link></>
            }
          />
        )}

        {/* Status */}
        <div className={`p-4 rounded-lg border flex items-center gap-3 ${status === 'CONNECTED' ? 'bg-[var(--sys-success-soft)] border-[var(--sys-success-soft)]' : 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]'}`}>
          <span className={`w-3 h-3 rounded-full ${status === 'CONNECTED' ? 'bg-[var(--sys-success)]' : 'bg-[var(--sys-warning)]'}`} />
          <div className="flex-1">
            <p className={`font-bold text-sm ${status === 'CONNECTED' ? 'text-[var(--sys-success)]' : 'text-[var(--sys-warning)]'}`}>
              {/* The dot above IS the light. Two coloured circles and a word
                  for one state is the state said three times. */}
              {status === 'CONNECTED' ? 'متصل' : 'يحتاج إعداد'}
            </p>
            <p className="text-xs text-[var(--sys-muted-foreground)]">
              {status === 'CONNECTED'
                ? 'الاتصال بواتساب يعمل عبر WhatsApp Business Cloud API'
                : conn?.envConfigured
                  ? 'متغيرات البيئة موجودة — اضغط إعادة الاتصال لتفعيل الرقم'
                  : 'أكمل متغيرات البيئة في الخادم ثم اضغط إعادة الاتصال'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => runAction('test')} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] text-xs font-semibold text-[var(--sys-heading)] hover:bg-[var(--sys-surface)] disabled:opacity-50">
              {busy === 'test' ? <RiRefreshLine className="w-4 h-4 animate-spin" /> : <RiCheckboxCircleLine className="w-4 h-4" />}
              اختبار الاتصال
            </button>
            <button onClick={() => runAction('reconnect')} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-semibold hover:opacity-90 disabled:opacity-50">
              {busy === 'reconnect' ? <RiRefreshLine className="w-4 h-4 animate-spin" /> : <RiRefreshLine className="w-4 h-4" />}
              إعادة الاتصال
            </button>
          </div>
        </div>

        {message && (
          <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${message.type === 'success' ? 'bg-[var(--sys-success-soft)] border border-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-destructive-soft)] border border-[var(--sys-destructive-border)] text-[var(--sys-destructive)]'}`}>
            {message.type === 'success' ? <RiCheckboxCircleLine className="w-4 h-4" /> : <RiCloseCircleLine className="w-4 h-4" />}
            {message.text}
          </div>
        )}

        {/* «واتساب بعد لا يرد» — from the agent's WhatsApp or the company's number, per country. */}
        <WhatsAppAfterNoAnswerCard />

        {/* Details */}
        <Card>
          <CardContent className="p-0 divide-y divide-[var(--sys-surface-strong)]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between px-5 py-3">
                <span className="text-xs text-[var(--sys-muted-foreground)]">{r.label}</span>
                <span className="text-xs font-semibold text-[var(--sys-heading)] text-left">{r.value}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Environment checklist */}
        <Card>
          <CardContent className="p-5 space-y-2">
            <p className="text-sm font-bold text-[var(--sys-heading)] mb-1">متغيرات البيئة المطلوبة (ملف .env على الخادم)</p>
            {[
              ['WHATSAPP_ACCESS_TOKEN', 'رمز الوصول الدائم من Meta'],
              ['WHATSAPP_BUSINESS_ACCOUNT_ID', 'معرف حساب WhatsApp Business'],
              ['WHATSAPP_PHONE_NUMBER_ID', 'معرف رقم الهاتف'],
              ['WHATSAPP_VERIFY_TOKEN', 'رمز التحقق للويبهوك (أي قيمة سرية من عندك)'],
              ['WHATSAPP_APP_SECRET', 'App Secret من إعدادات تطبيق Meta'],
              ['WHATSAPP_ENCRYPTION_KEY', 'مفتاح تشفير (32 حرفًا على الأقل)'],
            ].map(([k, desc]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <code className="px-2 py-1 rounded-lg bg-[var(--sys-surface-strong)] text-[var(--sys-heading)] font-semibold" dir="ltr">{k}</code>
                <span className="text-[var(--sys-muted-foreground)]">{desc}</span>
              </div>
            ))}
            <div className="mt-3 p-3 rounded-lg bg-[var(--sys-surface)] border border-[var(--sys-border)] text-xs text-[var(--sys-muted-foreground)] flex gap-2">
              <RiErrorWarningLine className="w-4 h-4 shrink-0 text-[var(--sys-primary)]" />
              <span>
                لا تُدخل أي بيانات سرية هنا في الواجهة — كل البيانات من متغيرات بيئة الخادم فقط، ولا يتم عرض Access Token مطلقًا.
                بعد إضافة البيانات: أعد تشغيل الخادم، اضغط [إعادة الاتصال]، ثم سجّل رابط الويبهوك في تطبيق Meta:
                <code className="mx-1 px-1.5 py-0.5 rounded-lg bg-[var(--sys-surface-strong)]" dir="ltr">/api/webhooks/whatsapp</code>
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
