'use client';

import React, { useCallback, useState } from 'react';
import { PageShell } from '@/components/ui/PageShell';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { useCan } from '@/hooks/useCan';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { routeLabel } from '@/lib/route-registry';
import { RiAddCircleLine, RiDeleteBinLine, RiFileCopyLine, RiLoader4Line } from '@remixicon/react';

/**
 * «رموز الأصالة» — THE OWNER'S OWN LIST, READ BY A PUBLIC SCAN AND BY NOBODY ELSE.
 *
 * One add at a time, as asked: no bulk import. A code typed here is the only
 * thing that makes `/verify/[storeId]` say «أصلي» for it — nothing is
 * genuine by default, and nothing here ever marks a code "used": the same
 * code reads «أصلي» the first time it is scanned and the thousandth.
 *
 * `note`/`productId` are this screen's own words for itself; the public
 * endpoint never reads or returns them (`src/lib/authenticity.ts`).
 */

interface Code {
  id: string;
  code: string;
  note: string | null;
  productId: string | null;
  scanCount: number;
  lastScanAt: string | null;
  createdAt: string;
}
interface StoreRow {
  id: string;
  name: string;
}

export function AuthenticityCodesScreen() {
  const toast = useToast();
  const confirm = useConfirm();
  // The list is read by `settings.view` (the page's own door); adding and removing ask the finer key.
  const canManage = useCan('settings.edit');
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [draft, setDraft] = useState({ code: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ codes: Code[]; stores: StoreRow[] }>('/api/settings/authenticity-codes');
      setCodes(d.codes ?? []);
      setStores(d.stores ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  const copyLink = async (storeId: string) => {
    const url = `${window.location.origin}/verify/${storeId}`;
    const ok = await copyText(url);
    if (ok) toast.done('تم نسخ الرابط');
    else toast.failed('تعذر النسخ — الرابط: ' + url);
  };

  const add = async () => {
    if (!draft.code.trim()) return;
    setBusy(true);
    try {
      await apiJson('/api/settings/authenticity-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: draft.code.trim(), note: draft.note.trim() || null }),
      });
      setDraft({ code: '', note: '' });
      toast.done('أُضيف الرمز');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الإضافة');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, code: string) => {
    // A deleted code can be scanned again — nothing restores it but typing it in once more. Asked first, like
    // every other delete in the product.
    const ok = await confirm({
      title: `حذف الرمز «${code}»؟`,
      body: 'أي فحص لاحق لهذا الرمز سيُظهر «غير أصلي» إلى أن يُضاف من جديد.',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiJson('/api/settings/authenticity-codes', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحذف');
    } finally {
      setBusy(false);
    }
  };

  if (!codes) {
    return error ? (
      <PageShell title={routeLabel('/settings/authenticity')} width="narrow">
        <p className="text-sm text-[var(--sys-destructive)]">{error}</p>
      </PageShell>
    ) : null;
  }

  return (
    <PageShell
      title={routeLabel('/settings/authenticity')}
      description="الرموز التي تظهر «أصلي» عند فحصها من صفحة التحقق العامة."
      width="narrow"
    >
      <div className="space-y-4" dir="rtl">
        {stores.length > 0 && (
          <Card>
            <CardHeader title="رابط الفحص العام" subtitle="شاركه مع أي شخص — لا يحتاج تسجيل دخول" />
            <CardContent className="space-y-2">
              {stores.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                  <span className="font-medium text-[var(--sys-foreground)]">{s.name}</span>
                  <Button variant="quiet" size="sm" onClick={() => copyLink(s.id)}>
                    <RiFileCopyLine className="h-4 w-4" /> نسخ الرابط
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader title="رمز جديد" subtitle="رمز واحد في كل مرة — بدون استيراد جماعي" />
          <CardContent className="space-y-2">
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="الرمز (باركود أو QR)"
                  dir="ltr"
                  style={{ minWidth: 160 }}
                  className="h-11 md:h-10 flex-1 rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
                />
                <input
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  placeholder="ملاحظة (اختياري، لك فقط)"
                  style={{ minWidth: 160 }}
                  className="h-11 md:h-10 flex-1 rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
                />
                <Button onClick={() => void add()} disabled={busy || !draft.code.trim()}>
                  {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiAddCircleLine className="h-4 w-4" />}
                  إضافة
                </Button>
              </div>
            ) : (
              <p className="text-note text-[var(--sys-muted-foreground)]">قراءة فقط — لا تملك صلاحية الإضافة أو الحذف.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader title={`الرموز (${codes.length})`} />
          <CardContent className="space-y-2">
            {codes.length === 0 && (
              <p className="rounded-lg border border-[var(--sys-border)] p-3 text-note text-[var(--sys-muted-foreground)]">
                لا رموز بعد — كل فحص عام يُظهر «غير أصلي» إلى أن تضيف رموزاً هنا.
              </p>
            )}
            {codes.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono font-semibold text-[var(--sys-foreground)]" dir="ltr">{c.code}</span>
                  {c.note && <span className="text-[var(--sys-muted-foreground)]">{c.note}</span>}
                  <span className="text-[var(--sys-muted-foreground)]">
                    عدد الفحوصات: <span className="tabular-nums">{c.scanCount}</span>
                  </span>
                </div>
                {canManage && (
                  <Button variant="danger" size="sm" onClick={() => remove(c.id, c.code)}>
                    <RiDeleteBinLine className="h-4 w-4" /> حذف
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
