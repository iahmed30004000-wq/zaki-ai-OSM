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
import { Modal } from '@/components/ui/Modal';
import {
  RiAddCircleLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiFileCopyLine,
  RiLoader4Line,
  RiPrinterLine,
  RiQrScan2Line,
} from '@remixicon/react';

const QR_API = '/api/settings/authenticity-codes/qr';

/** Text going into the print window's HTML, escaped: a code may hold any character now, «<» and «&» included. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Prints a sheet of labels in a window of its own — no page of the app is added for it (a registry line rides in every
 * staff screen's first load). Each label: the QR, the code under it, and the note when there is one.
 */
function printLabels(items: { code: string; note?: string | null; img: string }[]): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  const cells = items
    .map(
      (i) =>
        `<figure><div class="q">${i.img}</div><figcaption dir="ltr">${esc(i.code)}</figcaption>${
          i.note ? `<small>${esc(i.note)}</small>` : ''
        }</figure>`
    )
    .join('');
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>رموز الأصالة</title><style>
@page{margin:10mm}body{margin:0;font-family:Tahoma,'Segoe UI',sans-serif;color:#000}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(44mm,1fr));gap:6mm}
figure{margin:0;padding:3mm;border:1px dashed #999;text-align:center;break-inside:avoid}
.q svg,.q img{width:100%;height:auto;display:block}
figcaption{font:600 9pt monospace;word-break:break-all;margin-top:2mm}small{display:block;font-size:8pt;color:#444;margin-top:1mm}
</style></head><body><main>${cells}</main></body></html>`);
  w.document.close();
  // Images inside are inline SVG or same-origin, so the sheet is whole a moment after it is written.
  setTimeout(() => {
    w.focus();
    w.print();
  }, 300);
  return true;
}

/**
 * «رموز الأصالة» — THE OWNER'S OWN LIST, READ BY A PUBLIC SCAN AND BY NOBODY ELSE.
 *
 * It was a card of «إعدادات النظام» (19/11, to spare the registry line). 25/11, the owner: «رموز الأصالة» is a page of
 * its own in the menu (`/settings/authenticity`, `AuthenticityScreen`), right beside «باركود المنتجات» — this card moved
 * there whole; it gained only the product a code belongs to.
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
interface ProductRow {
  id: string;
  name: string;
}

export function AuthenticityCodesCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const canManage = useCan('settings.edit');
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [stores, setStores] = useState<StoreRow[]>([]);
  // 25/11 («باركود المنتجات»): which product a code belongs to. A tagged code reads «أصلي» on that product's own page
  // (`/v/<slug>`) and on no other product's; an untagged one reads «أصلي» on every product page and on the store's.
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [draft, setDraft] = useState({ code: '', note: '', productId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The code whose QR window is open (20/11, owner: «يولد qr code خاص بيه»).
  const [qrFor, setQrFor] = useState<Code | null>(null);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<{ codes: Code[]; stores: StoreRow[]; products?: ProductRow[] }>('/api/settings/authenticity-codes');
      setCodes(d.codes ?? []);
      setStores(d.stores ?? []);
      setProducts(d.products ?? []);
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

  /** A file from the QR door, saved with the name the server gives it. */
  const download = (id: string, format: 'png' | 'svg') => {
    const a = document.createElement('a');
    a.href = `${QR_API}?id=${encodeURIComponent(id)}&format=${format}&download=1`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const printOne = (c: Code) => {
    const img = `<img alt="" src="${window.location.origin}${QR_API}?id=${encodeURIComponent(c.id)}&format=svg">`;
    if (!printLabels([{ code: c.code, note: c.note, img }])) toast.failed('المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع');
  };

  const printAll = async () => {
    setPrinting(true);
    try {
      const d = await apiJson<{ items: { code: string; note: string | null; svg: string }[] }>(`${QR_API}?all=1`);
      if (!d.items.length) return;
      if (!printLabels(d.items.map((i) => ({ code: i.code, note: i.note, img: i.svg })))) {
        toast.failed('المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع');
      }
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر تجهيز الطباعة');
    } finally {
      setPrinting(false);
    }
  };

  const add = async () => {
    if (!draft.code.trim()) return;
    setBusy(true);
    try {
      await apiJson('/api/settings/authenticity-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: draft.code.trim(), note: draft.note.trim() || null, productId: draft.productId || null }),
      });
      // The product stays chosen: codes are usually added a batch of one product at a time.
      setDraft({ code: '', note: '', productId: draft.productId });
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
            <select
              value={draft.productId}
              onChange={(e) => setDraft({ ...draft, productId: e.target.value })}
              aria-label="المنتج"
              style={{ minWidth: 160 }}
              className="h-11 md:h-10 flex-1 rounded-lg border border-[var(--sys-border-input)] px-3 text-sm"
            >
              <option value="">لكل المنتجات (بدون منتج)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-note font-semibold text-[var(--sys-foreground)]">الرموز ({codes.length})</p>
              {codes.length > 0 && stores[0] && (
                <Button variant="quiet" size="sm" onClick={() => void printAll()} disabled={printing}>
                  {printing ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiPrinterLine className="h-4 w-4" />}
                  طباعة كل الرموز
                </Button>
              )}
            </div>
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
                    المنتج: {c.productId ? (products.find((p) => p.id === c.productId)?.name ?? 'منتج محذوف') : 'لكل المنتجات'}
                  </span>
                  <span className="text-[var(--sys-muted-foreground)]">
                    عدد الفحوصات: <span className="tabular-nums">{c.scanCount}</span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {stores[0] && (
                    <>
                      <Button variant="quiet" size="sm" onClick={() => setQrFor(c)}>
                        <RiQrScan2Line className="h-4 w-4" /> QR
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => copyQr(stores[0].id, c.code)}>
                        <RiFileCopyLine className="h-4 w-4" /> نسخ رابط QR
                      </Button>
                    </>
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

      <Modal isOpen={!!qrFor} onClose={() => setQrFor(null)} title="QR للقطعة" subtitle="يصوّره الزبون بكاميرا موبايله فتنفتح صفحة التحقق وتتحقق وحدها." maxWidth="sm">
        {qrFor && (
          <div className="space-y-4 text-center">
            {/* Drawn by the server (the same `qrcode` as the waybill); an <img> of our own door, nothing third-party. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${QR_API}?id=${encodeURIComponent(qrFor.id)}&format=svg`}
              alt={`QR للرمز ${qrFor.code}`}
              style={{ width: '100%', maxWidth: 280, aspectRatio: '1', margin: '0 auto', display: 'block', background: 'white' }}
            />
            <p className="font-mono font-semibold text-[var(--sys-foreground)]" dir="ltr" style={{ wordBreak: 'break-all' }}>
              {qrFor.code}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="quiet" size="sm" onClick={() => download(qrFor.id, 'png')}>
                <RiDownload2Line className="h-4 w-4" /> تنزيل PNG
              </Button>
              <Button variant="quiet" size="sm" onClick={() => download(qrFor.id, 'svg')}>
                <RiDownload2Line className="h-4 w-4" /> تنزيل SVG
              </Button>
              <Button size="sm" onClick={() => printOne(qrFor)}>
                <RiPrinterLine className="h-4 w-4" /> طباعة
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
