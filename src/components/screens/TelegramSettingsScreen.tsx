'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useApp } from '@/context/AppContext';
import { screenApi as crmApi } from '@/lib/screen-api';
import { copyText } from '@/lib/clipboard';
import { TelegramSourcesCard } from '@/components/settings/TelegramSourcesCard';
import { RiCheckboxCircleLine, RiCloseCircleLine, RiFileCopyLine, RiRefreshLine } from '@remixicon/react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { userCan } from '@/lib/can';

/** `embedded` — a card of «الربط» (`/settings/links`): no page padding, a section heading instead of the page header. */
export function TelegramSettingsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { currentUser } = useApp();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The connection's own key (T-09): the day's message work (telegram.manage) no longer registers the webhook or binds a group.
  const canManage = userCan(currentUser, 'telegram.connect');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await crmApi('/api/telegram/status'));
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل الحالة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setupWebhook = async () => {
    setBusy(true);
    try {
      await crmApi('/api/telegram/webhook/setup', { method: 'POST' });
      await load();
    } catch (e: any) {
      toast.failed(e?.message || 'تعذر تسجيل الويبهوك');
    } finally {
      setBusy(false);
    }
  };

  const copyWebhook = () => {
    if (status?.webhookUrl) {
      void copyText(status.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const Row = ({ label, ok, value }: { label: string; ok: boolean; value?: string }) => (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-[var(--sys-surface-strong)] last:border-0">
      <span className="min-w-0 break-words text-note text-[var(--sys-muted-foreground)]">{label}</span>
      <span className={`text-note font-semibold flex items-center gap-1.5 ${ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
        {ok ? <RiCheckboxCircleLine className="w-4 h-4" /> : <RiCloseCircleLine className="w-4 h-4" />}
        {value ?? (ok ? 'مضبوط' : 'غير مضبوط')}
      </span>
    </div>
  );

  return (
    <>
      <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-3xl mx-auto'} dir="rtl">
        {embedded ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-[var(--sys-heading)]">تلجرام</h2>
              <p className="text-note text-[var(--sys-muted-foreground)]">حالة اتصال البوت والويبهوك (لا تُعرض أي مفاتيح سرية هنا أبدًا)</p>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/growth/telegram/orders" className="text-note font-semibold text-[var(--sys-primary)] hover:underline">طلبات تلجرام</Link>
              <IconButton type="button" size="sm" onClick={() => { void load(); }} label="تحديث حالة تلجرام"><RiRefreshLine className="w-4 h-4" /></IconButton>
            </div>
          </div>
        ) : (
        <PageHeader title="إعدادات تلجرام"
            description="حالة اتصال البوت والويبهوك (لا تُعرض أي مفاتيح سرية هنا أبدًا)"
            actions={
              <><div className="flex gap-2">
            <Link href="/growth/telegram/orders"><Button type="button" variant="secondary" size="sm">رجوع</Button></Link>
            <IconButton type="button" size="sm" onClick={() => { void load(); }} label="تحديث حالة تلجرام"><RiRefreshLine className="w-4 h-4" /></IconButton>
          </div></>
            }
          />
        )}

        {error && (
          <div className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] px-3 py-2.5 text-note">{error}</div>
        )}

        <Card>
          <CardHeader title="حالة البوت" subtitle="تُقرأ الحالة من القيم المحفوظة بالموقع، ومن البيئة كاحتياط" />
          <CardContent>
            {loading ? (
              <p className="text-note text-[var(--sys-muted-foreground)] py-4">جارٍ التحميل...</p>
            ) : (
              <div>
                <Row label="TELEGRAM_BOT_TOKEN" ok={Boolean(status?.botConfigured)} />
                <Row label="الاتصال بواجهة Telegram API" ok={Boolean(status?.botApiOk)} value={status?.botApiOk ? 'يعمل' : undefined} />
                <Row label="TELEGRAM_WEBHOOK_SECRET" ok={Boolean(status?.webhookSecretConfigured)} />
                <Row label="APP_URL (لبناء رابط الويبهوك)" ok={Boolean(status?.appUrlConfigured)} />
                <div className="flex items-center justify-between py-2.5 border-b border-[var(--sys-surface-strong)]">
                  <span className="text-note text-[var(--sys-muted-foreground)]">Bot username</span>
                  <span className="text-note font-mono text-[var(--sys-heading)] font-semibold" dir="ltr">
                    {status?.botUsername ? `@${status.botUsername}` : '—'}
                  </span>
                </div>
                <div className="pt-3">
                  <p className="text-note text-[var(--sys-muted-foreground)] mb-1">Webhook URL:</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 text-note bg-[var(--sys-surface)] border border-[var(--sys-border)] rounded-lg px-3 py-2 font-mono break-all" dir="ltr">
                      {status?.webhookUrl || '— لم يتم ضبط APP_URL —'}
                    </code>
                    {status?.webhookUrl && (
                      <Button type="button" variant="secondary" size="sm" onClick={copyWebhook}><RiFileCopyLine className="w-4 h-4 ml-1" />{copied ? 'تم النسخ' : 'نسخ'}</Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {canManage && (
          <Card>
            <CardHeader title="تسجيل الويبهوك" subtitle="يسجّل رابط الويبهوك لدى تيليجرام باستخدام السرّ السري المحفوظ" />
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <span className={`text-note font-semibold ${status?.telegramWebhookSet ? 'text-[var(--sys-success)]' : 'text-[var(--sys-muted-foreground)]'}`}>
                {status?.telegramWebhookSet ? 'الويبهوك مسجل لدى تيليجرام' : 'الويبهوك غير مسجل'}
              </span>
              <Button type="button" size="sm" disabled={busy || !status?.botConfigured || !status?.appUrlConfigured} onClick={() => { void setupWebhook(); }}>
                {busy ? 'جارٍ التسجيل...' : 'تسجيل / تحديث الويبهوك'}
              </Button>
            </CardContent>
          </Card>
        )}

        <TelegramSourcesCard canManage={!!canManage} />

        <Card>
          <CardHeader title="ملاحظات مهمة" />
          <CardContent className="text-note text-[var(--sys-muted-foreground)] leading-relaxed space-y-2">
            <p>• يجب أن يكون البوت عضوًا في المجموعة لاستقبال الرسائل، وقد يتطلب تعطيل Privacy Mode أو منحه صلاحية قراءة الرسائل حسب نوع المجموعة.</p>
            <p>• في المجموعات ذات المواضيع (Topics/Forum) يستقبل البوت رسائل المواضيع تلقائيًا؛ يمكنك ربط موضوع محدد من «المجموعات والمواضيع المرتبطة» أعلاه.</p>
            <p>• لا تشارك مفتاح البوت أو سر الويبهوك مع أي شخص. لا تُعرض هذه القيم في هذه الصفحة مطلقًا.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
