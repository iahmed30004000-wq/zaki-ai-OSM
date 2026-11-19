'use client';

import { useCallback, useState } from 'react';
import { ScanButton } from '@/components/scan/ScanButton';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { RiCheckboxCircleFill, RiErrorWarningFill, RiShieldCheckLine } from '@remixicon/react';

/**
 * THE PUBLIC FACE OF ONE COMPANY'S AUTHENTICITY LIST.
 *
 * Reuses `ScanButton`/`ScanSheet` exactly as the warehouse screens do — the
 * camera, the permission prompt, the decoder and the manual-entry fallback
 * are one piece of code, written once (`src/components/scan`). What this
 * component adds is only what is specific to a public visitor: no search,
 * no record — a single POST that answers `{ genuine: boolean }`, and a
 * full result screen (icon, big label, small print) instead of the small
 * inline strip the sheet shows while it is still open.
 */

type Result = { code: string; genuine: boolean } | { failed: true } | null;

export function VerifyBarcodeView({ storeId }: { storeId: string }) {
  const [result, setResult] = useState<Result>(null);

  const onScan = useCallback(
    async (code: string) => {
      try {
        const data = await apiJson<{ genuine?: boolean }>(`/api/public/verify-barcode/${storeId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const genuine = Boolean(data.genuine);
        setResult({ code, genuine });
        return genuine ? { text: 'أصلي', ok: true } : { text: 'غير أصلي', ok: false };
      } catch {
        setResult({ failed: true });
        return { text: 'تعذر التحقق الآن، حاول مرة أخرى', ok: false };
      }
    },
    [storeId]
  );

  if (result && 'genuine' in result) {
    return <ResultScreen genuine={result.genuine} onRetry={() => setResult(null)} />;
  }

  return (
    <main dir="rtl" className="min-h-screen flex items-center justify-center p-6 bg-[var(--sys-background)]">
      <div className="w-full max-w-sm text-center space-y-5">
        <RiShieldCheckLine className="mx-auto h-6 w-6 text-[var(--sys-primary)]" aria-hidden />
        <h1 className="text-xl font-semibold text-[var(--sys-foreground)]">تحقق من أصالة المنتج</h1>
        <p className="text-sm text-[var(--sys-muted-foreground)]">
          وجّه الكاميرا نحو الرمز (الباركود أو QR) الموجود على المنتج لمعرفة إن كان أصلياً.
        </p>
        <ScanButton
          onScan={onScan}
          title="تحقق من أصالة المنتج"
          label="تحقق"
          continuous={false}
          className="h-14 w-full rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-base font-semibold inline-flex items-center justify-center gap-2"
        />
        {result && 'failed' in result && (
          <p className="text-sm text-[var(--sys-destructive)]">تعذر التحقق الآن، حاول مرة أخرى.</p>
        )}
      </div>
    </main>
  );
}

function ResultScreen({ genuine, onRetry }: { genuine: boolean; onRetry: () => void }) {
  // The verdict this scan landed on — fill means "this is the one", same rule as an active tab.
  const VerdictIcon = genuine ? RiCheckboxCircleFill : RiErrorWarningFill;
  return (
    <main dir="rtl" className="min-h-screen flex items-center justify-center p-6 bg-[var(--sys-background)]">
      <div className="w-full max-w-sm text-center space-y-5">
        <div
          className={`mx-auto flex h-20 w-20 items-center justify-center rounded-full ${
            genuine ? 'bg-[var(--sys-success-soft)]' : 'bg-[var(--sys-destructive-soft)]'
          }`}
        >
          <VerdictIcon className={`h-6 w-6 ${genuine ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`} aria-hidden />
        </div>
        <p
          className={`text-2xl font-bold ${genuine ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}
        >
          {genuine ? 'أصلي' : 'غير أصلي'}
        </p>
        <p className="text-sm text-[var(--sys-muted-foreground)]">
          {genuine
            ? 'هذا الرمز موجود في قائمة المنتجات الأصلية لهذا المتجر.'
            : 'هذا الرمز غير معروف لدينا. قد يكون غير أصلي، أو مكتوباً بشكل خاطئ — تحقق من الرمز وأعد المحاولة.'}
        </p>
        <Button variant="secondary" className="w-full" onClick={onRetry}>
          تحقق من رمز آخر
        </Button>
      </div>
    </main>
  );
}
