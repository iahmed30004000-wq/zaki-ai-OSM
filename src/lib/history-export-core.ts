import type { Prisma } from '@prisma/client';
import { dayRange } from './eod-report';
import { fromMinorUnits, roundMinor, toMinorUnits } from './money';
import { MOVEMENT_CATEGORY_AR } from './movement-category-words';
import { rateText } from './exchange-rate-words';
import { TRANSFER_STATE_AR, type TransferState } from './transfer-reversal';
import type { Cell } from './xlsx-writer';
import type { HistoryBasis } from './history-export-url';

/**
 * «سحب سجل حركات وتحويلات وتواريخ ينزلو PDF أو Excel» (the owner, 22/11, F5) — THE RULES OF A HISTORY FILE, with no database.
 *
 *   · `readHistoryFilters`  what the address asked for, checked — an unknown word or a span that runs backwards is an Arabic refusal.
 *   · the three WHERE builders — the ONE filter of each list. The list on screen calls the same builder with no filters and gets
 *     exactly the clause it always had (`{ walletId }`, `{ companyId }`, `{ companyId, storeId: { in } }`); the file adds the
 *     filters to it. There is no second filter logic to drift from the screen.
 *   · the three sheets — Arabic headers, the store's clock, amounts rounded to their currency's decimals, and a totals block per
 *     currency per direction over the rows that STAND (a reversed row and its reversing entry, a cancelled withdrawal and its cancel
 *     are listed, marked, and left out of the totals). Two currencies are never added together.
 *
 * Nothing here writes or changes money: the figures are read, rounded for display, and summed in minor units for the totals only.
 */

/**
 * THE MOST ROWS ONE FILE CARRIES: 5,000. A month of a busy store's cash box is a few hundred movements; past this the answer is
 * a refusal that names a narrower span — never a file that takes a minute to build while the pool waits.
 */
export const HISTORY_ROW_CAP = 5000;

export interface HistoryRefusal {
  status: number;
  code: string;
  errorAr: string;
}

export const TOO_MANY_ROWS: HistoryRefusal = {
  status: 422,
  code: 'HISTORY_TOO_MANY_ROWS',
  errorAr: `الفترة فيها أكتر من ${HISTORY_ROW_CAP} سطر — ضيّق التاريخ (مثلاً شهر واحد) أو اختار محفظة أو عملة وحدة، ونزّل كل جزء لحاله.`,
};

const BAD_RANGE: HistoryRefusal = {
  status: 400,
  code: 'HISTORY_BAD_RANGE',
  errorAr: 'الفترة مش مفهومة — اختار يوم البداية ويوم النهاية من خانة التاريخ.',
};
const BAD_FILTER: HistoryRefusal = { status: 400, code: 'HISTORY_BAD_FILTER', errorAr: 'فلتر مش مفهوم — أعد تحميل الصفحة وجرّب مرة تانية.' };

export interface HistoryFilters {
  /** The store's days, inclusive; both or neither. */
  from: string | null;
  to: string | null;
  basis: HistoryBasis;
  walletId?: string;
  currency?: string;
  direction?: 'IN' | 'OUT';
  category?: string;
  partnerId?: string;
}

/** What the list on the screen asks: no span, no filter. */
export const NO_FILTERS: HistoryFilters = { from: null, to: null, basis: 'real' };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function isRealDay(day: string): boolean {
  const m = DAY.exec(day);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const ID = /^[A-Za-z0-9-]{1,64}$/;

export type FiltersReading = { ok: true; value: HistoryFilters } | { ok: false; refusal: HistoryRefusal };

export function readHistoryFilters(params: URLSearchParams): FiltersReading {
  const get = (k: string) => {
    const v = params.get(k);
    return v === null || v.trim() === '' ? undefined : v.trim();
  };
  const from = get('from') ?? null;
  const to = get('to') ?? null;
  if ((from === null) !== (to === null)) return { ok: false, refusal: BAD_RANGE };
  if (from !== null && to !== null && (!isRealDay(from) || !isRealDay(to) || from > to)) return { ok: false, refusal: BAD_RANGE };

  const basis = get('basis') ?? 'real';
  if (basis !== 'real' && basis !== 'registered') return { ok: false, refusal: BAD_FILTER };
  const value: HistoryFilters = { from, to, basis };

  const walletId = get('walletId');
  const partnerId = get('partnerId');
  const currency = get('currency');
  const direction = get('direction');
  const category = get('category');
  if (walletId !== undefined) {
    if (!ID.test(walletId)) return { ok: false, refusal: BAD_FILTER };
    value.walletId = walletId;
  }
  if (partnerId !== undefined) {
    if (!ID.test(partnerId)) return { ok: false, refusal: BAD_FILTER };
    value.partnerId = partnerId;
  }
  if (currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, refusal: BAD_FILTER };
    value.currency = currency;
  }
  if (direction !== undefined) {
    if (direction !== 'IN' && direction !== 'OUT') return { ok: false, refusal: BAD_FILTER };
    value.direction = direction;
  }
  if (category !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(MOVEMENT_CATEGORY_AR, category)) return { ok: false, refusal: BAD_FILTER };
    value.category = category;
  }
  return { ok: true, value };
}

/** The instants the span covers, in the STORE's days (`dayRange`: one clock with every other screen). Null = no span. */
export function historyWindow(f: HistoryFilters, timeZone: string): { start: Date; end: Date } | null {
  if (!f.from || !f.to) return null;
  const a = dayRange(f.from, timeZone);
  const b = dayRange(f.to, timeZone);
  return a && b ? { start: a.start, end: b.end } : null;
}

/** The span on the real date (the typed one, or the registration when none was typed) or on the registration. */
function onDate(f: HistoryFilters, timeZone: string): Prisma.WalletMovementWhereInput | null {
  const w = historyWindow(f, timeZone);
  if (!w) return null;
  const span = { gte: w.start, lt: w.end };
  if (f.basis === 'registered') return { createdAt: span };
  return { OR: [{ occurredAt: span }, { occurredAt: null, createdAt: span }] };
}

/**
 * THE MOVEMENTS OF A WALLET (or of the store's wallets). `scope` is the list's own clause; with `NO_FILTERS` the answer IS `scope`.
 */
export function movementsWhere(
  scope: { walletId: string | { in: string[] } },
  f: HistoryFilters,
  timeZone: string
): Prisma.WalletMovementWhereInput {
  const where: Prisma.WalletMovementWhereInput = { ...scope };
  if (f.direction) where.direction = f.direction;
  if (f.category) where.category = f.category;
  if (f.currency) where.currencyCode = f.currency;
  const date = onDate(f, timeZone);
  if (date) Object.assign(where, date);
  return where;
}

/** THE COMPANY'S TRANSFERS. `walletIds` = the wallets the wallet/currency filter left (either side of the transfer). */
export function transfersWhere(
  companyId: string,
  f: HistoryFilters,
  timeZone: string,
  walletIds?: string[] | null
): Prisma.WalletTransferWhereInput {
  const where: Prisma.WalletTransferWhereInput = { companyId };
  const and: Prisma.WalletTransferWhereInput[] = [];
  if (walletIds) and.push({ OR: [{ fromWalletId: { in: walletIds } }, { toWalletId: { in: walletIds } }] });
  const date = onDate(f, timeZone) as Prisma.WalletTransferWhereInput | null;
  if (date) and.push(date);
  if (and.length === 1) Object.assign(where, and[0]);
  else if (and.length > 1) where.AND = and;
  return where;
}

/** The day after a store day, yyyy-mm-dd. */
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * THE PARTNERS' WITHDRAWALS of these stores. With `NO_FILTERS` the answer is the book's own clause. With filters it reads the
 * ORIGINALS the filters pick (a cancel is read beside its original by the caller, whatever its own date): the real date of a
 * withdrawal is its day (`withdrawnOn`, the store's day as typed), the registration is `createdAt`.
 */
export function withdrawalsWhere(
  companyId: string,
  storeIds: string[],
  f: HistoryFilters,
  timeZone: string
): Prisma.PartnerWithdrawalWhereInput {
  const where: Prisma.PartnerWithdrawalWhereInput = { companyId, storeId: { in: storeIds } };
  if (f === NO_FILTERS) return where;
  where.reversalOfId = null;
  if (f.partnerId) where.partnerId = f.partnerId;
  if (f.currency) where.currencyCode = f.currency;
  if (f.from && f.to) {
    if (f.basis === 'registered') {
      const w = historyWindow(f, timeZone);
      if (w) where.createdAt = { gte: w.start, lt: w.end };
    } else {
      where.withdrawnOn = { gte: new Date(`${f.from}T00:00:00Z`), lt: new Date(`${nextDay(f.to)}T00:00:00Z`) };
    }
  }
  return where;
}

/** A moment on the store's clock, Western digits: «2026-11-19 14:30». */
export function storeMoment(at: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// ───────────────────────────── the sheets ─────────────────────────────

/** One row: its cells, and the decimals of each money column in it (column index → minor unit). */
export interface HistoryRow {
  cells: Cell[];
  minors: Record<number, number>;
}

export interface HistoryTotal {
  label: string;
  currency: string;
  minorUnit: number;
  amount: number;
  count: number;
}

export interface HistorySheet {
  title: string;
  header: string[];
  rows: HistoryRow[];
  totals: HistoryTotal[];
}

export const TOTALS_TITLE = 'المجموع — لكل عملة لحالها، بدون المعكوس والملغى';
export const TOTALS_HEADER = ['البند', 'العملة', 'المجموع', 'عدد السطور'];

/** Totals in minor units, keyed by (label, currency) — the currency is ALWAYS part of the key. */
function totalsOf(items: { label: string; currency: string; minorUnit: number; amount: number }[]): HistoryTotal[] {
  const acc = new Map<string, { label: string; currency: string; minorUnit: number; units: number; count: number }>();
  for (const it of items) {
    const key = `${it.label}|${it.currency}`;
    const cur = acc.get(key) ?? { label: it.label, currency: it.currency, minorUnit: it.minorUnit, units: 0, count: 0 };
    cur.units += toMinorUnits(it.amount, it.minorUnit);
    cur.count += 1;
    acc.set(key, cur);
  }
  return [...acc.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency) || a.label.localeCompare(b.label))
    .map((t) => ({ label: t.label, currency: t.currency, minorUnit: t.minorUnit, amount: fromMinorUnits(t.units, t.minorUnit), count: t.count }));
}

export const DIRECTION_AR: Record<string, string> = { IN: 'وارد', OUT: 'صادر' };

/** A movement as the list answers it (`movementListRows`), plus its wallet's name and decimals. */
export interface MovementLine {
  id: string;
  direction: string;
  amount: number;
  currencyCode: string;
  party: string;
  category: string;
  note: string;
  createdAt: Date | string;
  realDate: string;
  createdByName: string | null;
  reversalOfId?: string | null;
  reversalReason?: string | null;
  reversedBy?: { reversalReason: string | null } | null;
  walletName: string;
  minorUnit: number;
}

export const MOVEMENT_HEADER = [
  'تاريخ الحركة', 'تاريخ التسجيل', 'سجّلها', 'المحفظة', 'الاتجاه', 'المبلغ', 'العملة', 'الطرف', 'البند', 'ملاحظة', 'الحالة',
];

function movementState(m: MovementLine): string {
  if (m.reversalOfId) return `قيد عكسي${m.reversalReason ? ` — ${m.reversalReason}` : ''}`;
  if (m.reversedBy) return `معكوس${m.reversedBy.reversalReason ? ` — ${m.reversedBy.reversalReason}` : ''}`;
  return 'ساري';
}

export function movementSheet(lines: MovementLine[], timeZone: string): HistorySheet {
  const AMOUNT = 5;
  return {
    title: 'سجل حركات المحافظ',
    header: MOVEMENT_HEADER,
    rows: lines.map((m) => ({
      cells: [
        storeMoment(m.realDate, timeZone),
        storeMoment(m.createdAt, timeZone),
        m.createdByName ?? '—',
        m.walletName,
        DIRECTION_AR[m.direction] ?? m.direction,
        roundMinor(m.amount, m.minorUnit),
        m.currencyCode,
        m.party,
        MOVEMENT_CATEGORY_AR[m.category] ?? 'بند آخر',
        m.note,
        movementState(m),
      ],
      minors: { [AMOUNT]: m.minorUnit },
    })),
    totals: totalsOf(
      lines
        .filter((m) => !m.reversalOfId && !m.reversedBy)
        .map((m) => ({ label: DIRECTION_AR[m.direction] ?? m.direction, currency: m.currencyCode, minorUnit: m.minorUnit, amount: m.amount }))
    ),
  };
}

/** A transfer as the list answers it (`transferListRows`), plus the two wallets' decimals. */
export interface TransferLine {
  id: string;
  amountOut: number;
  amountIn: number;
  exchangeRate: number;
  kindLabel: string;
  note: string;
  createdAt: Date | string;
  realDate: string;
  createdByName: string | null;
  from: { name: string; currencyCode: string } | null;
  to: { name: string; currencyCode: string } | null;
  state: TransferState;
  reversal: { reason: string | null } | null;
  fromMinor: number;
  toMinor: number;
}

export const TRANSFER_HEADER = [
  'تاريخ التحويل', 'تاريخ التسجيل', 'سجّله', 'من محفظة', 'إلى محفظة', 'النوع', 'المبلغ الصادر', 'عملة الصادر', 'المبلغ الواصل',
  'عملة الواصل', 'سعر الصرف', 'ملاحظة', 'الحالة',
];

export function transferSheet(lines: TransferLine[], timeZone: string): HistorySheet {
  const OUT = 6;
  const IN = 8;
  const standing = lines.filter((t) => t.state === 'ACTIVE');
  return {
    title: 'سجل التحويلات',
    header: TRANSFER_HEADER,
    rows: lines.map((t) => {
      const fromCode = t.from?.currencyCode ?? '';
      const toCode = t.to?.currencyCode ?? '';
      const state = TRANSFER_STATE_AR[t.state] ?? TRANSFER_STATE_AR.ACTIVE;
      return {
        cells: [
          storeMoment(t.realDate, timeZone),
          storeMoment(t.createdAt, timeZone),
          t.createdByName ?? '—',
          t.from?.name ?? '—',
          t.to?.name ?? '—',
          t.kindLabel,
          roundMinor(t.amountOut, t.fromMinor),
          fromCode,
          roundMinor(t.amountIn, t.toMinor),
          toCode,
          // The rate is said only where the currency changed, with fixed decimals and never an exponent (lib/exchange-rate-words).
          fromCode && toCode && fromCode !== toCode ? `${rateText(t.exchangeRate)} (1 ${fromCode} = ${rateText(t.exchangeRate)} ${toCode})` : '',
          t.note,
          t.state !== 'ACTIVE' && t.reversal?.reason ? `${state} — ${t.reversal.reason}` : state,
        ],
        minors: { [OUT]: t.fromMinor, [IN]: t.toMinor },
      };
    }),
    totals: totalsOf([
      ...standing.filter((t) => t.from).map((t) => ({ label: 'صادر', currency: t.from!.currencyCode, minorUnit: t.fromMinor, amount: t.amountOut })),
      ...standing.filter((t) => t.to).map((t) => ({ label: 'واصل', currency: t.to!.currencyCode, minorUnit: t.toMinor, amount: t.amountIn })),
    ]),
  };
}

/** A withdrawal as the tab's list answers it (`describeWithdrawals`), plus the store's name. */
export interface WithdrawalLine {
  id: string;
  partnerName: string;
  currencyCode: string;
  minorUnit: number;
  amount: number;
  withdrawnOn: string;
  fromStanding: boolean;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
  cancelled: { reason: string } | null;
  storeName: string;
}

export const WITHDRAWAL_HEADER = [
  'يوم السحب', 'تاريخ التسجيل', 'سجّله', 'الشريك', 'المتجر', 'المبلغ', 'العملة', 'من المبلغ الثابت', 'ملاحظة', 'الحالة',
];

export function withdrawalSheet(lines: WithdrawalLine[], timeZone: string): HistorySheet {
  const AMOUNT = 5;
  return {
    title: 'سجل مسحوبات الشركاء',
    header: WITHDRAWAL_HEADER,
    rows: lines.map((w) => ({
      cells: [
        w.withdrawnOn,
        storeMoment(w.createdAt, timeZone),
        w.createdByName ?? '—',
        w.partnerName,
        w.storeName,
        roundMinor(w.amount, w.minorUnit),
        w.currencyCode,
        w.fromStanding ? 'نعم' : 'لا',
        w.note ?? '',
        w.cancelled ? `ملغى${w.cancelled.reason ? ` — ${w.cancelled.reason}` : ''}` : 'ساري',
      ],
      minors: { [AMOUNT]: w.minorUnit },
    })),
    totals: totalsOf(
      lines.filter((w) => !w.cancelled).map((w) => ({ label: 'مسحوبات', currency: w.currencyCode, minorUnit: w.minorUnit, amount: w.amount }))
    ),
  };
}

/** The sheet's cells as the Excel file carries them: the rows, an empty line, then the totals block. */
export function sheetCells(sheet: HistorySheet): Cell[][] {
  const rows = sheet.rows.map((r) => r.cells);
  if (sheet.totals.length === 0) return rows;
  return [
    ...rows,
    [],
    [TOTALS_TITLE],
    TOTALS_HEADER,
    ...sheet.totals.map((t) => [t.label, t.currency, roundMinor(t.amount, t.minorUnit), t.count]),
  ];
}
