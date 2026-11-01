'use client';

import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { apiFetch, apiJson } from '@/lib/api-client';
import { RiAlertLine, RiCheckLine, RiCloseLine, RiDownload2Line, RiLoader4Line, RiUploadCloud2Line } from '@remixicon/react';

/**
 * A SHEET OF ORDERS, READ BEFORE ANY OF IT IS WRITTEN.
 *
 * Three steps, because the middle one is the whole point: upload, look, then
 * import. A file is not a promise — a marketer re-uploading yesterday's
 * export is the commonest thing that happens to an importer, and the person
 * holding the sheet is the only one who knows whether the same number twice
 * is one household or one mistake.
 *
 * So nothing is refused on their behalf. Rows that cannot become orders —
 * a missing address, a phone three digits short, a blocked number — are
 * unticked and say why. Rows that merely look suspicious stay ticked and say
 * what looks suspicious. Everything is a tick the person can change.
 *
 * AND IT IMPORTS THROUGH THE ORDINARY DOOR, one row at a time. Not for want
 * of a bulk endpoint: `POST /api/orders` is where stock is reserved, cost of
 * goods is read, COD is computed and the commission is written, and a second
 * path for imported rows would be a second set of money rules. One at a time
 * is also what makes a half-failed import survivable — row forty failing is
 * row forty, not a rollback of thirty-nine orders somebody re-uploads.
 */

interface Problem {
  field: string;
  kind: string;
  ar: string;
}

interface Row {
  line: number;
  values: Record<string, string>;
  phone: string | null;
  /** `null` when the cell held something the parser would not guess at. */
  quantity: number | null;
  sellingPrice: number | null;
  problems: Problem[];
  duplicateOfLine: number | null;
  blocked: boolean;
  existingOrder: { orderNumber: string; at: string } | null;
  productId: string | null;
  productLabel: string | null;
  importable: boolean;
}

interface Parsed {
  rows: Row[];
  counts: {
    total: number;
    importable: number;
    problems: number;
    duplicatesInFile: number;
    alreadyOrdered: number;
    blocked: number;
  };
  recentDays: number;
}

export function ImportOrdersDialog({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [take, setTake] = useState<Record<number, boolean>>({});
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // «شامل التوصيل» for the whole file: ticked unless unticked — the sheets sell with free delivery, so the price already carries it.
  const [includesDelivery, setIncludesDelivery] = useState(true);
  const [failed, setFailed] = useState<{ line: number; why: string }[]>([]);

  const upload = async (file: File) => {
    setReading(true);
    setError(null);
    setFailed([]);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch('/api/orders/import', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.errorAr || data?.error || 'تعذّر قراءة الملف');
      setParsed(data);
      setTake(Object.fromEntries((data.rows as Row[]).map((r) => [r.line, r.importable])));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر قراءة الملف');
      setParsed(null);
    } finally {
      setReading(false);
    }
  };

  const chosen = (parsed?.rows ?? []).filter((r) => take[r.line]);

  /**
   * THROUGH `POST /api/orders`, ROW BY ROW.
   *
   * Sequential on purpose: twenty parallel creations of orders for the same
   * new customer would race each other into twenty customer records, and the
   * stock each one reserves is read from the same shelf.
   */
  const run = async () => {
    setProgress({ done: 0, total: chosen.length });
    const bad: { line: number; why: string }[] = [];
    let made = 0;

    for (const r of chosen) {
      /**
       * A ROW WITH NOTHING TO SEND IS REFUSED HERE, NOT GUESSED AT.
       *
       * The tick for such a row is disabled above, so this is unreachable
       * through the screen — which is the reason it is three lines rather
       * than a dialog. What it buys is that there is no path, reachable or
       * not, that turns an unreadable quantity into a quantity of one — or an
       * empty price into a price of ZERO — on its way to the order door.
       */
      if (!r.productId || r.quantity === null || r.sellingPrice === null) {
        bad.push({ line: r.line, why: 'صفٌّ ناقص — لا يُنشأ' });
        setProgress({ done: made + bad.length, total: chosen.length });
        continue;
      }
      try {
        await apiJson('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: r.values.customerName,
            customerPhone: r.values.customerPhone,
            customerAltPhone: r.values.customerAltPhone || undefined,
            customerAddress: r.values.customerAddress,
            customerCity: r.values.customerCity || undefined,
            // The id the server matched, never the name the sheet typed.
            productId: r.productId,
            quantity: r.quantity,
            sellingPrice: r.sellingPrice,
            customerNotes: r.values.notes || undefined,
            source: 'استيراد ملفّ',
            // The box above the button, for every row of this file: her word for these orders, sent either way.
            priceIncludesDelivery: includesDelivery,
            /*
             * THE DIALOG SAYS WHAT IT IS.
             *
             * There is no bulk endpoint — every row above is a separate
             * `POST /api/orders`, indistinguishable from somebody typing
             * one order. So the request names itself, and the door asks
             * for `orders.import` when it sees this. Without the flag a
             * row is a row, which is what it was before.
             */
            viaImport: true,
          }),
        });
        made += 1;
      } catch (e) {
        bad.push({ line: r.line, why: e instanceof Error ? e.message : 'تعذّر الإنشاء' });
      }
      setProgress({ done: made + bad.length, total: chosen.length });
    }

    setFailed(bad);
    setProgress(null);
    if (bad.length === 0) onDone(made);
    else {
      // The ones that failed stay on screen with their reason, and the ones
      // that worked are gone from the list: pressing import again must not
      // create them twice.
      setParsed((p) =>
        p ? { ...p, rows: p.rows.filter((r) => bad.some((b) => b.line === r.line)) } : p
      );
      setError(`أُنشئ ${made} من ${chosen.length}. البقية أدناه بأسبابها.`);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="استيراد طلبات من ملف">
      <div className="space-y-3">
        {!parsed && (
          <>
            <p className="text-sm text-[var(--sys-foreground)]">
              ارفع ملف CSV أو Excel. يُقرأ ويُعرض عليك صفّاً صفّاً قبل أن يُكتب أيُّ طلب — تُلغي ما لا
              تريده، ويُنشأ الباقي كطلباتٍ جديدة.
            </p>
            {/*
              A button, not an anchor. The path is an API route that answers
              with a file, and the framework's own lint rule reads an <a> to
              it as a page navigation somebody forgot to make a <Link> — a
              <Link> here would be wrong, so the download says what it is.
            */}
            <button
              type="button"
              onClick={() => window.open('/api/orders/import', '_blank', 'noopener')}
              className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs font-medium text-[var(--sys-foreground)]"
            >
              <RiDownload2Line className="w-4 h-4" aria-hidden />
              حمّل النموذج
            </button>
            {/*
              WHAT THE MODEL FILE IS, SAID WHERE IT IS DOWNLOADED.

              «لما اعمل استثيراد طلبات ما في ملف مرجعي نموذج» — THE OWNER, 21/10. The file existed behind a button that said only
              «حمّل النموذج», and its example row did not import. It now carries rows made from THIS store (its own products at
              their prices, a phone its country accepts, one of its own regions), and this line says so, names the five columns
              that must be filled — the same five `IMPORT_COLUMNS` marks required, held equal by a test — and says the one
              thing that is not obvious: a row whose price cell is empty is not imported (22/10, the owner's ruling «ارفض الصف»;
              before it, an empty cell stored an order at a price of ZERO), so the price is to be written every time.
            */}
            <p className="text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
              في النموذج صفوف مثال من منتجات متجرك بأسعارها، وبرقم هاتف من بلدك — عدّلها أو امسحها واكتب طلباتك مكانها. المطلوب: اسم العميل،
              الهاتف، العنوان، المنتج، السعر (المنتج باسمه كما في كتالوجك، والسعر للسطر كلّه). الصفّ الذي سعره فارغ لا يُستورَد.
            </p>
            <label className="block cursor-pointer rounded-lg border-2 border-dashed border-[var(--sys-border)] p-6 text-center hover:border-[var(--sys-primary)]">
              <input
                type="file"
                accept=".csv,.xlsx,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
              <RiUploadCloud2Line className="mx-auto mb-2 h-6 w-6 text-[var(--sys-muted)]" aria-hidden />
              <span className="text-sm text-[var(--sys-foreground)]">
                {reading ? 'جارٍ القراءة…' : 'اختر الملف'}
              </span>
            </label>
          </>
        )}

        {error && (
          <p className="rounded-lg bg-[var(--sys-destructive-soft)] px-3 py-2 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}

        {parsed && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Pill tone="ok">{parsed.counts.importable} جاهز</Pill>
              {parsed.counts.problems > 0 && <Pill tone="bad">{parsed.counts.problems} فيه نقص</Pill>}
              {parsed.counts.duplicatesInFile > 0 && (
                <Pill tone="warn">{parsed.counts.duplicatesInFile} مكرّر داخل الملف</Pill>
              )}
              {parsed.counts.alreadyOrdered > 0 && (
                <Pill tone="warn">{parsed.counts.alreadyOrdered} طلب سابقاً خلال {parsed.recentDays} يوماً</Pill>
              )}
              {parsed.counts.blocked > 0 && <Pill tone="bad">{parsed.counts.blocked} محظور</Pill>}
            </div>

            <ul className="max-h-80 overflow-y-auto rounded-lg border border-[var(--sys-border)] divide-y divide-[var(--sys-border)]">
              {parsed.rows.map((r) => (
                <li key={r.line} className="flex items-start gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setTake((t) => ({ ...t, [r.line]: !t[r.line] }))}
                    disabled={r.problems.length > 0 || r.blocked}
                    title={
                      r.problems.length > 0 || r.blocked
                        ? 'هذا الصفّ لا يمكن إنشاؤه'
                        : take[r.line]
                          ? 'ألغِ هذا الصفّ'
                          : 'أعِده'
                    }
                    className={`mt-0.5 shrink-0 rounded-md border p-1 disabled:opacity-40 ${
                      take[r.line]
                        ? 'border-[var(--sys-success)] text-[var(--sys-success)]'
                        : 'border-[var(--sys-border)] text-[var(--sys-muted)]'
                    }`}
                  >
                    {take[r.line] ? <RiCheckLine className="h-4 w-4" /> : <RiCloseLine className="h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-[var(--sys-heading)]">
                      <span className="tabular-nums text-[var(--sys-muted)]">#{r.line}</span>{' '}
                      {r.values.customerName || '—'} · <span dir="ltr">{r.values.customerPhone || '—'}</span>
                    </p>
                    <p className="truncate text-xs text-[var(--sys-muted-foreground)]">
                      {r.productLabel || r.values.productName || '—'} × {r.quantity ?? `«${r.values.quantity}»`} · {r.values.customerCity || r.values.customerAddress || '—'}
                    </p>
                    {r.problems.map((p) => (
                      <p key={p.field} className="text-xs text-[var(--sys-destructive)]">
                        {p.ar}
                      </p>
                    ))}
                    {r.blocked && <p className="text-xs text-[var(--sys-destructive)]">الرقم في القائمة السوداء</p>}
                    {r.duplicateOfLine !== null && (
                      <p className="text-xs text-[var(--sys-warning)]">
                        نفس رقم الصفّ #{r.duplicateOfLine} في هذا الملف
                      </p>
                    )}
                    {r.existingOrder && (
                      <p className="text-xs text-[var(--sys-warning)]">
                        لهذا الرقم طلبٌ سابق {r.existingOrder.orderNumber} خلال {parsed.recentDays} يوماً
                      </p>
                    )}
                    {failed.find((f) => f.line === r.line) && (
                      <p className="text-xs text-[var(--sys-destructive)]">
                        {failed.find((f) => f.line === r.line)!.why}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <label className="flex min-h-11 md:min-h-0 items-start gap-2 text-xs text-[var(--sys-foreground)]">
              <input
                type="checkbox"
                checked={includesDelivery}
                onChange={(e) => setIncludesDelivery(e.target.checked)}
                disabled={!!progress}
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold">شامل التوصيل (لكل طلبات الملف)</span>
                <span className="block text-[var(--sys-muted-foreground)]">
                  {includesDelivery
                    ? 'الزبون بيدفع السعر اللي بالملف بس، وأجرة التوصيل على المتجر.'
                    : 'بينضاف توصيل على كل طلب لما تنعمل الشحنة.'}
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--sys-border)] pt-2">
              <button
                type="button"
                onClick={() => void run()}
                disabled={chosen.length === 0 || !!progress}
                className="min-h-11 md:min-h-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--sys-primary)] px-4 py-1.5 text-xs font-medium text-[var(--sys-primary-foreground)] disabled:opacity-50"
              >
                {progress && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                {progress ? `جارٍ الإنشاء ${progress.done}/${progress.total}…` : `استورد ${chosen.length} طلباً`}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="min-h-11 md:min-h-0 inline-flex items-center rounded-lg border border-[var(--sys-border)] px-4 py-1.5 text-xs"
              >
                إغلاق
              </button>
              {parsed.counts.problems > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                  <RiAlertLine className="h-4 w-4 text-[var(--sys-destructive)]" aria-hidden />
                  الصفوف الناقصة تُصحَّح في الملف وتُرفع من جديد.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)] border-[var(--sys-success)]/30'
      : tone === 'warn'
        ? 'bg-[var(--sys-warning-soft)] text-[var(--sys-warning)] border-[var(--sys-warning)]/30'
        : 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)] border-[var(--sys-destructive-border)]';
  return <span className={`rounded-md border px-2 py-0.5 ${cls}`}>{children}</span>;
}
