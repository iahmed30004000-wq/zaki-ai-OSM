'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { apiJson } from '@/lib/api-client';
import { arDateTime } from '@/lib/format';
import { RiCheckLine, RiCloseCircleLine, RiDeleteBinLine, RiKey2Line, RiLoader4Line, RiPlug2Line, RiShieldCheckLine, RiShieldFlashLine } from '@remixicon/react';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { useCan } from '@/hooks/useCan';

/**
 * Where a courier account is entered — and the only place it is.
 *
 * The password goes in and never comes back: the form opens empty even when
 * an account is saved, and the screen is told only that one exists, when it
 * was saved, by whom, and the tail of the login. Showing a stored password
 * back means anyone who reaches this screen has read it.
 */

interface Status {
  providerId: string;
  name: string;
  adapterCode: string;
  apiEnabled: boolean;
  encryptionAvailable: boolean;
  hasCredentials: boolean;
  readable: boolean | null;
  savedAt: string | null;
  savedBy: string | null;
  emailHint: string | null;
  accountCompanyId: number | null;
  senderName: string | null;
  originCityId: number | null;
}

const BLANK = {
  email: '',
  password: '',
  companyId: '',
  originCityId: '',
  senderName: '',
  senderPhone: '',
  senderBusiness: '',
  originAddress: '',
  baseUrl: '',
};

export function CourierCredentials({ providerId }: { providerId: string }) {
  // The account, its test and its removal are «الإعدادات الحسّاسة»; the card opens on «عرض الإعدادات».
  const canManage = useCan('settings.manage');
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiJson<Status>(`/api/delivery-providers/${providerId}/credentials`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر قراءة حالة الحساب');
    }
  }, [providerId]);

  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiJson(`/api/delivery-providers/${providerId}/credentials`, {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      // The password leaves this browser's memory the moment it is saved.
      setForm({ ...BLANK });
      setOpen(false);
      setDone('حُفظ الحساب مشفَّراً');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    // What is deleted cannot be read back — the password goes in and never comes out (see the note at the top) — so it cannot be
    // restored either: somebody has to type the account again. Asked first.
    const ok = await confirm({
      title: `حذف حساب «${status?.name ?? 'شركة الشحن'}»؟`,
      body: 'تعود الشركة يدويّة: لا بوالص ولا تتبّع تلقائي إلى أن تُدخل الحساب من جديد. الحساب المحذوف لا يُسترجَع.',
      tone: 'danger',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await apiJson(`/api/delivery-providers/${providerId}/credentials`, { method: 'DELETE' });
      setDone('حُذف الحساب — الشركة تعود يدوية');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setSaving(false);
    }
  }

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const d = await apiJson<{ ok: boolean; message: string }>(
        `/api/delivery-providers/${providerId}/credentials/test`,
        { method: 'POST' }
      );
      setTest(d);
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : 'تعذّر الفحص' });
    } finally {
      setTesting(false);
    }
  };

  if (!status) {
    return (
      <p className="flex items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ القراءة…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-bold text-[var(--sys-heading)]">
            <RiKey2Line className="h-4 w-4 text-[var(--sys-primary)]" />
            حساب {status.name} على {status.adapterCode}
          </p>
          {status.hasCredentials ? (
            <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
              محفوظ ومشفَّر
              {status.emailHint && <> · الدخول <span dir="ltr">{status.emailHint}</span></>}
              {status.accountCompanyId !== null && <> · رقم الشركة {status.accountCompanyId}</>}
              {status.savedAt && <> · {arDateTime(status.savedAt)}</>}
              {status.savedBy && <> · {status.savedBy}</>}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
              لا حساب محفوظ — الشحنات تُنشأ يدوياً حتى تُدخله.
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* "Saved" is not "works". A typo sits there looking fine until the
              first real batch fails with the parcels already packed. */}
          {canManage && status.hasCredentials && (
            <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
              {testing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiPlug2Line className="h-4 w-4" />}
              اختبر الاتصال
            </Button>
          )}
          {canManage && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!status.encryptionAvailable}>
            <RiKey2Line className="h-4 w-4" /> {status.hasCredentials ? 'تغيير الحساب' : 'إدخال الحساب'}
          </Button>
          )}
          {canManage && status.hasCredentials && (
            <button aria-label="حذف الحساب"
              type="button"
              onClick={clear}
              disabled={saving}
              title="حذف الحساب"
              className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer rounded-lg p-2 text-[var(--sys-destructive)] hover:bg-[var(--sys-destructive-soft)]"
            >
              <RiDeleteBinLine className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {test && (
        <p
          className={`flex items-start gap-1.5 rounded-lg px-2.5 py-2 text-xs ${
            test.ok
              ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border border-[var(--sys-success-soft)]'
              : 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border border-[var(--sys-destructive-border)]'
          }`}
        >
          {test.ok ? (
            <RiCheckLine className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <RiCloseCircleLine className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {test.message}
        </p>
      )}

      {!status.encryptionAvailable && (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-2.5 text-xs leading-relaxed text-[var(--sys-warning)]">
          <RiShieldFlashLine className="mt-0.5 h-4 w-4 shrink-0" />
          مفتاح التشفير غير مُهيّأ على الخادم. أضف <code dir="ltr">APP_ENCRYPTION_KEY</code> إلى
          ملف <code dir="ltr">.env</code> ثم أعد التشغيل — كلمة المرور لن تُحفظ بلا تشفير.
        </p>
      )}

      {status.hasCredentials && status.readable === false && (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs leading-relaxed text-[var(--sys-destructive)]">
          <RiShieldFlashLine className="mt-0.5 h-4 w-4 shrink-0" />
          الحساب محفوظ لكن لا يمكن فكّ تشفيره — غالباً تغيّر مفتاح التشفير. الشحنات
          تُنشأ يدوياً حتى تُدخله من جديد.
        </p>
      )}

      {/* Only what is KNOWN: the account is saved and can be read back. Whether the courier accepts it is what the
          test above answers; this line never asked them, so it never says «سليم» or «تُنشأ آلياً». */}
      {status.hasCredentials && status.readable && !test && (
        <p className="flex items-center gap-2 text-xs text-[var(--sys-muted-foreground)]">
          <RiShieldCheckLine className="h-4 w-4" /> الحساب محفوظ ومشفّر — لم يُفحص مع الشركة بعد.
        </p>
      )}

      {done && <p className="flex items-center gap-1.5 text-xs text-[var(--sys-success)]"><RiCheckLine className="h-4 w-4" />{done}</p>}
      {error && !open && <p className="text-xs text-[var(--sys-destructive)]">{error}</p>}

      <Modal
        isOpen={open}
        onClose={() => { setOpen(false); setForm({ ...BLANK }); setError(null); }}
        title={`حساب ${status.name}`}
        subtitle="يُحفظ مشفَّراً على الخادم، ولا يُعرض مرة أخرى بعد الحفظ"
      >
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="البريد / اسم المستخدم *"
              dir="ltr"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
            <Input
              label="كلمة المرور *"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
            <Input
              label="رقم الشركة لديهم (Company ID) *"
              type="number"
              dir="ltr"
              value={form.companyId}
              onChange={(e) => setForm({ ...form, companyId: e.target.value })}
              required
            />
            <Input
              label="رقم مدينة الانطلاق *"
              type="number"
              dir="ltr"
              value={form.originCityId}
              onChange={(e) => setForm({ ...form, originCityId: e.target.value })}
              required
            />
            <Input
              label="اسم المُرسِل *"
              value={form.senderName}
              onChange={(e) => setForm({ ...form, senderName: e.target.value })}
              required
            />
            <Input
              label="هاتف المُرسِل *"
              dir="ltr"
              value={form.senderPhone}
              onChange={(e) => setForm({ ...form, senderPhone: e.target.value })}
              required
            />
            <Input
              label="اسم النشاط"
              value={form.senderBusiness}
              onChange={(e) => setForm({ ...form, senderBusiness: e.target.value })}
            />
            <Input
              label="عنوان الانطلاق"
              value={form.originAddress}
              onChange={(e) => setForm({ ...form, originAddress: e.target.value })}
            />
          </div>

          <Input
            label="رابط الـAPI (اتركه فارغاً للافتراضي)"
            dir="ltr"
            placeholder="https://…"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />

          <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
            الحقول المطلوبة هي ما تطلبه الشركة على كل شحنة — بدون أيٍّ منها تُرفض
            الشحنة عندهم لا عندنا. كلمة المرور تُشفَّر قبل أن تُكتب، ولا يُعيدها أي
            طلب بعد ذلك: لتغييرها تُدخلها من جديد.
          </p>

          {error && <p className="text-xs text-[var(--sys-destructive)]">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => { setOpen(false); setForm({ ...BLANK }); }}>
              إلغاء
            </Button>
            <Button type="submit" loading={saving}>
              <RiShieldCheckLine className="h-4 w-4" /> احفظ مشفَّراً
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
