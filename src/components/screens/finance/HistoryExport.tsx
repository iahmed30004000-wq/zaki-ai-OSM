'use client';

import React, { useState } from 'react';
import { RiFileExcel2Line, RiPrinterLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DateRange, initialRange, validRange, type Range } from '@/components/ui/DateRange';
import { Select } from '@/components/ui/Input';
import { apiFetch } from '@/lib/api-client';
import { HISTORY_PDF_HELP, historyExportUrl, type HistoryBasis, type HistoryList, type HistoryQuery } from '@/lib/history-export-url';

/**
 * «سحب السجل» — THE FILTERS AND THE TWO BUTTONS OF A HISTORY FILE (22/11, F5), on the wallets, transfers and withdrawals screens.
 *
 * The screen keeps its own list; this strip only builds the address of the file from what it holds (lib/history-export-url) and
 * the server does the work. «تنزيل Excel» FETCHES the file, so a refusal (too many rows, a missing key) is said here in Arabic and
 * never saved as a file; «PDF» opens the print page in a new tab, where the browser's dialog saves it.
 */

export interface HistoryChoice {
  key: 'walletId' | 'currency' | 'direction' | 'category' | 'partnerId';
  label: string;
  options: { value: string; label: string }[];
}

const BASIS_OPTIONS = [
  { value: 'real', label: 'حسب تاريخ الحركة' },
  { value: 'registered', label: 'حسب تاريخ التسجيل' },
];

export function HistoryExport({
  list,
  fixed,
  choices = [],
  realLabel,
}: {
  list: HistoryList;
  /** What the screen has already chosen (the open wallet): sent with every press. */
  fixed?: Partial<HistoryQuery>;
  /** The filters this list offers; an empty value = all. */
  choices?: HistoryChoice[];
  /** The withdrawals' real date is the day of the withdrawal: «حسب يوم السحب». */
  realLabel?: string;
}) {
  const [range, setRange] = useState<Range>(() => initialRange('30d'));
  const [basis, setBasis] = useState<HistoryBasis>('real');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = (): HistoryQuery => ({
    ...(validRange(range) ? { from: range.from, to: range.to } : { from: '', to: '' }),
    basis,
    ...picked,
    ...fixed,
  });

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(historyExportUrl(list, query(), 'xlsx'), { timeoutMs: 60_000 });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { errorAr?: string; error?: string };
        throw new Error(data.errorAr || data.error || 'تعذر تجهيز ملف الإكسل');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${list}-${range.from}-${range.to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تجهيز ملف الإكسل');
    } finally {
      setBusy(false);
    }
  }

  const print = () => {
    window.open(historyExportUrl(list, query(), 'print'), '_blank', 'noopener');
  };

  return (
    <Card plain padding="sm" className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <DateRange value={range} onChange={setRange} label="الفترة" />
        <div className="w-40">
          <Select
            label="أي تاريخ"
            value={basis}
            onChange={(e) => setBasis(e.target.value as HistoryBasis)}
            options={BASIS_OPTIONS.map((o) => (o.value === 'real' && realLabel ? { ...o, label: realLabel } : o))}
          />
        </div>
        {choices.map((c) => (
          <div key={c.key} className="w-40">
            <Select
              label={c.label}
              value={picked[c.key] ?? ''}
              onChange={(e) => setPicked((now) => ({ ...now, [c.key]: e.target.value }))}
              options={[{ value: '', label: 'الكل' }, ...c.options]}
            />
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={download} loading={busy}>
          <RiFileExcel2Line className="w-4 h-4" /> تنزيل Excel
        </Button>
        <Button variant="secondary" size="sm" onClick={print}>
          <RiPrinterLine className="w-4 h-4" /> PDF
        </Button>
      </div>
      <p className="text-note text-[var(--sys-muted-foreground)]">{HISTORY_PDF_HELP}</p>
      {error && <p role="alert" className="text-sm text-[var(--sys-destructive)]">{error}</p>}
    </Card>
  );
}
