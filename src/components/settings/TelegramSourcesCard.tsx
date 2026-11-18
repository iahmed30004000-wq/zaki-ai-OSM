'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useConfirm, useTell } from '@/components/ui/Confirm';
import { screenApi as crmApi } from '@/lib/screen-api';
import { RiAddCircleLine, RiDeleteBinLine, RiFlaskLine, RiShutDownLine } from '@remixicon/react';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Rows } from '@/components/ui/Rows';
import { EmptyState } from '@/components/ui/EmptyState';
import { arDateTime } from '@/lib/format';

/**
 * WHICH TELEGRAM GROUPS AND TOPICS BECOME ORDERS — configuration, on the
 * settings screen.
 *
 * The groups used to be added, switched and removed from the Telegram
 * ORDERS screen, while the settings screen for the same integration showed
 * only the bot's status. Configuration belongs with configuration; the
 * orders screen keeps the messages and what became of them.
 */

interface TelegramSource {
  id: string;
  chatId: string;
  chatType: string;
  chatTitle: string | null;
  topicId: number | null;
  topicName: string | null;
  isActive: boolean;
  ordersCount: number;
  lastMessageAt: string | null;
  storeName: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'قيد المعالجة',
  PROCESSED: 'تم إنشاء طلب',
  IGNORED: 'تم التجاهل',
  NEEDS_REVIEW: 'قيد المراجعة',
  FAILED: 'فشل',
};

export function TelegramSourcesCard({ canManage }: { canManage: boolean }) {
  const ask = useConfirm();
  const tell = useTell();
  const [sources, setSources] = useState<TelegramSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ chatId: '', chatTitle: '', topicId: '', topicName: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const src = await crmApi('/api/telegram/sources');
      setSources(src.sources || []);
      setError(null);
    } catch (e: any) {
      setSources([]);
      setError(e?.message || 'تعذر تحميل المصادر');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addSource = async () => {
    setFormError(null);
    setSaving(true);
    try {
      await crmApi('/api/telegram/sources', {
        method: 'POST',
        body: JSON.stringify({
          chatId: form.chatId.trim(),
          chatType: 'supergroup',
          chatTitle: form.chatTitle.trim() || null,
          topicId: form.topicId.trim() ? Number(form.topicId.trim()) : null,
          topicName: form.topicName.trim() || null,
          isActive: true,
        }),
      });
      setAddOpen(false);
      setForm({ chatId: '', chatTitle: '', topicId: '', topicName: '' });
      await load();
    } catch (e: any) {
      setFormError(e?.message || 'تعذر إضافة المصدر');
    } finally {
      setSaving(false);
    }
  };

  const act = async (s: TelegramSource, run: () => Promise<unknown>, failure: string) => {
    setBusyId(s.id);
    try {
      await run();
      await load();
    } catch (e: any) {
      setError(e?.message || failure);
    } finally {
      setBusyId(null);
    }
  };

  const deleteSource = async (s: TelegramSource) => {
    const ok = await ask({
      title: `حذف الربط مع «${s.chatTitle || s.chatId}»؟`,
      body: 'الطلبات السابقة تبقى كما هي.',
      tone: 'danger',
    });
    if (!ok) return;
    await act(s, () => crmApi(`/api/telegram/sources/${s.id}`, { method: 'DELETE' }), 'تعذر الحذف');
  };

  const testSource = (s: TelegramSource) =>
    act(s, async () => {
      const r: any = await crmApi(`/api/telegram/sources/${s.id}/test`, { method: 'POST' });
      void tell({
        title: 'نتيجة اختبار المجموعة',
        body: r.lastMessage
          ? `آخر رسالة: ${arDateTime(r.lastMessage.createdAt)} — الحالة: ${STATUS_LABELS[r.lastMessage.processingStatus] || r.lastMessage.processingStatus}`
          : 'لا توجد رسائل مستلمة من هذه المجموعة بعد',
      });
    }, 'تعذر الاختبار');

  return (
    <Card>
      <CardHeader
        title="المجموعات والمواضيع المرتبطة"
        subtitle="كل رسالة طلب في مجموعة أو موضوع مرتبط تصير طلباً في متجره. المصدر الجديد يُربط بالمتجر المختار من الأعلى."
      />
      <CardContent className="p-0">
        {canManage && (
          <div className="flex justify-end px-4 pb-2">
            <Button type="button" size="sm" onClick={() => setAddOpen(true)}><RiAddCircleLine className="ml-1 h-4 w-4" /> إضافة مصدر</Button>
          </div>
        )}
        {error && <p className="mx-4 mb-2 rounded-lg bg-[var(--sys-destructive-soft)] px-3 py-2 text-note text-[var(--sys-destructive)]">{error}</p>}
        {sources === null ? (
          <div className="p-4">
            <SkeletonRows rows={3} />
          </div>
        ) : (
          <Rows
            rows={sources}
            keyOf={(s) => s.id}
            columns={[
              { key: 'c0', label: "المجموعة", primary: true,
                render: (s) => (
                  <><p className="font-semibold text-[var(--sys-heading)]">{s.chatTitle || 'بدون عنوان'}</p>
                    <p className="font-mono text-note text-[var(--sys-muted-foreground)]" dir="ltr">{s.chatId}{s.topicId ? ` • topic ${s.topicId}` : ''}</p>
                    {s.topicName && <p className="text-note text-[var(--sys-muted-foreground)]">الموضوع: {s.topicName}</p>}</>
                ) },
              { key: 'c1', label: "المتجر", primary: true,
                render: (s) => (s.storeName ?? '—') },
              { key: 'c2', label: "النوع",
                render: (s) => (s.chatType === 'supergroup' ? 'مجموعة فائقة' : s.chatType === 'group' ? 'مجموعة' : 'قناة') },
              { key: 'c3', label: "الحالة",
                render: (s) => (
                  <><span className={`rounded-full px-2 py-0.5 text-note font-semibold ${s.isActive ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'}`}>
                      {s.isActive ? 'مفعل' : 'معطل'}
                    </span></>
                ) },
              { key: 'c4', label: "الطلبات",
                render: (s) => (s.ordersCount) },
              { key: 'c5', label: "آخر رسالة",
                render: (s) => (arDateTime(s.lastMessageAt)) },
              { key: 'c6', label: "إجراءات",
                render: (s) => (
                  <><div className="flex items-center justify-end gap-1">
                        <IconButton type="button" size="sm" disabled={busyId === s.id} onClick={() => void testSource(s)} label="اختبار"><RiFlaskLine className="h-4 w-4" /></IconButton>
                        <IconButton
                          type="button"
                          size="sm"
                          disabled={busyId === s.id}
                          onClick={() => void act(s, () => crmApi(`/api/telegram/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !s.isActive }) }), 'تعذر التحديث')}
                          label={s.isActive ? 'تعطيل' : 'تفعيل'}
                        >
                          <RiShutDownLine className="h-4 w-4" />
                        </IconButton>
                        <IconButton type="button" size="sm" className="text-[var(--sys-destructive)]" disabled={busyId === s.id} onClick={() => void deleteSource(s)} label="حذف"><RiDeleteBinLine className="h-4 w-4" /></IconButton>
                      </div></>
                ) },
            ]}
            empty={
              <EmptyState
                title="لا مجموعات مرتبطة بعد"
                why="الطلبات تصل حين يُضاف البوت إلى مجموعةٍ ويُمنح صلاحية القراءة. أضِف مجموعةً من الزرّ أعلاه."
              />
            }
          />
        )}
      </CardContent>

      <Modal isOpen={addOpen} onClose={() => setAddOpen(false)} title="إضافة مصدر تيليجرام">
        <div className="space-y-4" dir="rtl">
          <Input label="Chat ID *" value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} placeholder="-1001234567890" dir="ltr" className="text-left font-mono" />
          <Input label="اسم المجموعة" value={form.chatTitle} onChange={(e) => setForm({ ...form, chatTitle: e.target.value })} placeholder="مجموعة طلبات المتجر" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Topic ID (اختياري)" value={form.topicId} onChange={(e) => setForm({ ...form, topicId: e.target.value })} placeholder="فارغ = المجموعة كاملة" dir="ltr" className="text-left font-mono" />
            <Input label="اسم الموضوع" value={form.topicName} onChange={(e) => setForm({ ...form, topicName: e.target.value })} />
          </div>
          {formError && <p className="text-note text-[var(--sys-destructive)]">{formError}</p>}
          <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
            تأكد من إضافة البوت إلى المجموعة ومن تفعيل Privacy Mode المناسب. اترك Topic ID فارغًا لربط المجموعة بالكامل.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(false)}>إلغاء</Button>
            <Button type="button" size="sm" disabled={!form.chatId.trim() || saving} onClick={() => void addSource()}>{saving ? 'جارٍ الحفظ...' : 'إضافة'}</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
