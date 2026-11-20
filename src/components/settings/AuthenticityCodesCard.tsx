'use client';

import React, { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { useCan } from '@/hooks/useCan';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { RiAddCircleLine, RiDeleteBinLine, RiFileCopyLine, RiLoader4Line } from '@remixicon/react';

/**
 * «رموز الأصالة» — THE OWNER'S OWN LIST, READ BY A PUBLIC SCAN AND BY NOBODY ELSE.
 *
 * A card of «إعدادات النظام», not a page of its own (19/11): a new page is a new line of the registry, and the registry
 * rides in the first load of every staff screen, whose ceilings only hold or fall (R19). A card costs that load nothing.
 *
 * One add at a time, as asked: no bulk import. A code typed here is the only thing that makes `/verify/[storeId]` say
 * «أصلي» for it — nothing is genuine by default, and nothing here ever marks a code "used": the same code reads «أصلي»
 * the first time it is scanned and the thousandth. `note` is this card's own words for itself; the public endpoint
 * never reads or returns it (`src/lib/authenticity.ts`).
 *
 * The list reads on `settings.view` (the screen's own door); adding and removing ask the screen's `settings.edit`.
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

export function AuthenticityCodesCard() {
  const toast = useToast();
  const confirm = useConfirm();
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
      setError(null);
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

  /**
   * The text to print as this piece's QR (19/11, owner): the verify link with the code in it, so a phone's own camera
   * opens the page and it checks by itself. A code that is already a link is its own QR text.
   */
  const qrText = (storeId: string, code: string) =>
    /^https?:\/\//i.test(code) ? code : `${window.location.origin}/verify/${storeId}?code=${encodeURIComponent(code)}`;

  const copyQr = async (storeId: string, code: string) => {
    const text = qrText(storeId, code);
    const ok = await copyText(text);
    if (ok) toast.done('تم نسخ رابط الـQR — ضعه في مولّد QR واطبعه على القطعة');
    else toast.failed('تعذر النسخ — الرابط: ' + text);
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

  return (
    <Card>
      <CardHeader title="رموز الأصالة" subtitle="الرموز التي تظهر «أصلي» عند فحصها من صفحة التحقق العامة." />
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        {stores.length > 0 && (
          <div className="space-y-2">
            <p className="text-note text-[var(--sys-muted-foreground)]">رابط الفحص العام — شاركه مع أي شخص، لا يحتاج تسجيل دخول.</p>
            {stores.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                <span className="font-medium text-[var(--sys-foreground)]">{s.name}</span>
                <Button variant="quiet" size="sm" onClick={() => copyLink(s.id)}>
                  <RiFileCopyLine className="h-4 w-4" /> نسخ الرابط
                </Button>
              </div>
            ))}
          </div>
        )}

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              placeholder="رمز جديد (باركود، أو رابط QR)"
              aria-label="رمز جديد"
              dir="ltr"
              style={{ minWidth: 160 }}
              className="h-11 md:h-10 flex-1 rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
            />
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="ملاحظة (اختياري، لك فقط)"
              aria-label="ملاحظة"
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

        {codes && (
          <div className="space-y-2">
            <p className="text-note font-semibold text-[var(--sys-foreground)]">الرموز ({codes.length})</p>
            {codes.length === 0 && (
              <p className="rounded-lg border border-[var(--sys-border)] p-3 text-note text-[var(--sys-muted-foreground)]">
                لا رموز بعد — كل فحص عام يُظهر «غير أصلي» إلى أن تضيف رموزاً هنا.
              </p>
            )}
            {codes.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--sys-border)] p-2.5 text-note">
                {/* Codes run to 300 characters and may be links: the text wraps anywhere instead of pushing the card wide. */}
                <div className="flex flex-col gap-0.5" style={{ minWidth: 0, flex: '1 1 16rem' }}>
                  <span className="font-mono font-semibold text-[var(--sys-foreground)]" dir="ltr" style={{ wordBreak: 'break-all' }}>
                    {c.code}
                  </span>
                  {c.note && <span className="text-[var(--sys-muted-foreground)]">{c.note}</span>}
                  <span className="text-[var(--sys-muted-foreground)]">
                    عدد الفحوصات: <span className="tabular-nums">{c.scanCount}</span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {stores[0] && (
                    <Button variant="quiet" size="sm" onClick={() => copyQr(stores[0].id, c.code)}>
                      <RiFileCopyLine className="h-4 w-4" /> نسخ رابط QR
                    </Button>
                  )}
                  {canManage && (
                    <Button variant="danger" size="sm" onClick={() => remove(c.id, c.code)}>
                      <RiDeleteBinLine className="h-4 w-4" /> حذف
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
