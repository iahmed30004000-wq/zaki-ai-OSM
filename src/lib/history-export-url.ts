/**
 * «سحب السجل» — THE ADDRESS OF A HISTORY FILE, BUILT FROM THE FILTERS ON THE SCREEN (22/11, F5).
 *
 * The screens' buttons build it; the doors read the same names back (`readHistoryFilters`, lib/history-export-core). No import, no
 * money, no clock: the screens' bundles carry these few lines and nothing more — the work is the server's.
 */

export type HistoryList = 'movements' | 'transfers' | 'withdrawals';
export type HistoryFormat = 'xlsx' | 'print';
/** Which date the span is read on: «حسب تاريخ الحركة» (the real one) or «حسب تاريخ التسجيل». */
export type HistoryBasis = 'real' | 'registered';

export interface HistoryQuery {
  /** The STORE's days, yyyy-mm-dd, inclusive. */
  from: string;
  to: string;
  basis: HistoryBasis;
  walletId?: string;
  currency?: string;
  direction?: string;
  category?: string;
  partnerId?: string;
}

/** Each list's door, written out whole so a reader (and the unused-routes sweep) finds it by its name. */
const DOOR: Record<HistoryList, string> = {
  movements: '/api/finance/history/movements',
  transfers: '/api/finance/history/transfers',
  withdrawals: '/api/finance/history/withdrawals',
};

/** The order the names are written in, so one set of filters is always one address. */
const KEYS = ['from', 'to', 'basis', 'walletId', 'currency', 'direction', 'category', 'partnerId'] as const;

export function historyExportUrl(list: HistoryList, query: HistoryQuery, format: HistoryFormat): string {
  const params = new URLSearchParams();
  for (const key of KEYS) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  params.set('format', format);
  return `${DOOR[list]}?${params.toString()}`;
}

/** The words under the two buttons: a PDF is the browser's own «حفظ كـ PDF», no server makes one. */
export const HISTORY_PDF_HELP = 'زر «PDF» بيفتح صفحة جاهزة للطباعة — من نافذة الطباعة اختار «حفظ كـ PDF».';
