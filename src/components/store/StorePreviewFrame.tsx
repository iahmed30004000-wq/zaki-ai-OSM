'use client';

import { useCallback, useEffect, useState } from 'react';
import { RiCloseLine, RiComputerLine, RiLoader4Line, RiRefreshLine, RiSmartphoneLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';

/**
 * «المعاينة الحقيقية» — the shop itself, in a frame, drawn from the saved DRAFT.
 *
 * Their theme builder's preview: six pages (الرئيسية · كل المنتجات · قسم ·
 * منتج · بحث · السلة) and two widths, before anything is published. The
 * frame loads the very pages a customer opens; only this frame, for this
 * signed-in seller, draws the draft (see store-preview.ts). What is not
 * saved yet is not in it — the miniature beside the controls shows that.
 */
const PAGES = [
  ['home', 'الرئيسية'],
  ['products', 'كل المنتجات'],
  ['category', 'قسم'],
  ['product', 'منتج'],
  ['search', 'بحث'],
  ['cart', 'السلة'],
] as const;
type Page = (typeof PAGES)[number][0];

export function StorePreviewFrame({ unsaved, onClose }: { unsaved: boolean; onClose: () => void }) {
  const [page, setPage] = useState<Page>('home');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [href, setHref] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const open = useCallback(async (p: Page) => {
    setError(null);
    setHref(null);
    try {
      const res = await apiJson<{ href: string }>('/api/store/preview', { method: 'POST', body: JSON.stringify({ page: p }) });
      setHref(res.href);
    } catch {
      setError('تعذّر فتح المعاينة');
    }
  }, []);

  useEffect(() => {
    void open(page);
  }, [open, page]);

  // Leaving the preview turns draft mode off again.
  const close = () => {
    void fetch('/api/store/preview', { method: 'DELETE' }).catch(() => {});
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--sys-card)]" dir="rtl" role="dialog" aria-label="المعاينة الحقيقية">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--sys-border)] p-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="الصفحة">
          {PAGES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={page === key}
              onClick={() => setPage(key)}
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                page === key
                  ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]'
                  : 'border border-[var(--sys-border)] text-[var(--sys-muted-foreground)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <div role="group" aria-label="العرض" className="inline-flex overflow-hidden rounded-lg border border-[var(--sys-border)]">
            {([['desktop', 'حاسوب', RiComputerLine], ['mobile', 'جوال', RiSmartphoneLine]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                aria-pressed={device === key}
                aria-label={label}
                onClick={() => setDevice(key)}
                className={`px-2.5 py-1.5 ${device === key ? 'bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)]' : 'text-[var(--sys-muted-foreground)]'}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <Button size="sm" variant="secondary" aria-label="حدّث" onClick={() => setNonce((n) => n + 1)}>
            <RiRefreshLine className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="secondary" aria-label="أغلق المعاينة" onClick={close}>
            <RiCloseLine className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="border-b border-[var(--sys-border)] bg-[var(--sys-surface)] p-2 text-xs text-[var(--sys-muted-foreground)]">
        {unsaved
          ? 'عندك تغييرات غير محفوظة — المعاينة بتعرض المسوّدة المحفوظة بس. احفظ المسوّدة ثم حدّث.'
          : 'هيك رح يشوف الزبون متجرك بعد «انشر». هلّق لسّا بيشوف المنشور. نموذج الطلب هون هو المنشور حالياً.'}
      </p>
      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-[var(--sys-surface)] p-2">
        {error ? (
          <p className="p-6 text-sm text-[var(--sys-destructive)]">{error}</p>
        ) : href ? (
          <iframe
            key={`${href}-${nonce}`}
            src={href}
            title="المعاينة الحقيقية"
            className="h-full rounded-lg border border-[var(--sys-border)] bg-white"
            style={{ width: device === 'mobile' ? 390 : '100%' }}
          />
        ) : (
          <RiLoader4Line className="m-6 h-5 w-5 animate-spin text-[var(--sys-muted-foreground)]" />
        )}
      </div>
    </div>
  );
}
