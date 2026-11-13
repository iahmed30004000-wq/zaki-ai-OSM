import type { Trust } from './cod-vitals';
import { fromMinorUnits, splitUnitsByShares, toMinorUnits } from './money';

/**
 * THE PARTNERS' ARITHMETIC — PURE, AND THE SAME FOR THE SERVER, THE SETTINGS CARD AND THE DIALOG (13/11).
 *
 * «هلأ احنا ٤ شركاء … الربح لازم يتم توزيعه وفق هاي النسب الربح الصافي … السحوبات لازم كمان تكون وفق هاي النسب … اذا حد تجاوز
 * نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner, 13/11).
 *
 *   · a partner's ENTITLEMENT is his share of the company's net profit — `share% × max(0, net)`, the whole split in whole minor
 *     units by largest remainder (`money.ts` `splitUnitsByShares`), so the entitlements add up to the net profit exactly;
 *   · his DRAWS are what he has taken out, in the store's currency;
 *   · his BALANCE is the one minus the other, since the beginning, so what he has over-drawn carries forward by construction;
 *   · «مكسور عليه» is the balance below zero. EQUAL IS NOT BROKEN. It is counted and shown — never a refusal.
 *
 * Nothing here reads a database or a clock and nothing here is a second profit: the net profit comes IN, as the one number the
 * profit screen prints (`lib/profit-to-date.ts`). It imports only `money.ts`, so a client component may use it: the settings card
 * validates with the very function the door saves with, and the dialog's «بعد هالسحب» is the very subtraction the statement does.
 */

/** The shares of the ACTIVE partners add up to exactly this many percent. */
export const PARTNER_SHARE_TOTAL = 100;
export const MAX_PARTNERS = 20;
const NAME_MIN = 2;
const NAME_MAX = 60;

export interface ShareRow {
  name: string;
  /** What a box or a request held: judged here, never trusted. */
  sharePercent: unknown;
  isActive: boolean;
}

export interface SharesRefusal {
  code: 'NO_PARTNERS' | 'TOO_MANY' | 'NAME_REQUIRED' | 'NAME_TOO_LONG' | 'NAME_TWICE' | 'SHARE_INVALID' | 'NO_ACTIVE' | 'SHARES_NOT_100';
  error: string;
}

/** A name compared the way a person would: spaces collapsed, case ignored. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A share as hundredths of a percent, or null when it is not a number in (0, 100] with at most two decimals.
 * A string is read only when it is written the way a plain decimal is — «15», «33.33», «.5» — never «0x10», «1e1» or «2,5», which
 * `Number()` would read as 16, 10 and nothing: the box holds characters, and the characters are judged, not repaired.
 */
export function shareHundredths(value: unknown): number | null {
  const n = typeof value === 'string' ? (/^\s*(\d+\.?\d*|\.\d+)\s*$/.test(value) ? Number(value) : Number.NaN) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const hundredths = Math.round(n * 100);
  if (Math.abs(n * 100 - hundredths) > 1e-6) return null;
  return hundredths > 0 && hundredths <= PARTNER_SHARE_TOTAL * 100 ? hundredths : null;
}

/** The ACTIVE shares added up, as a percent with two decimals — what the card prints live. Rows that are not shares count nothing. */
export function activeSharesTotal(rows: readonly ShareRow[]): number {
  return rows.reduce((sum, r) => sum + (r.isActive ? shareHundredths(r.sharePercent) ?? 0 : 0), 0) / 100;
}

/**
 * MAY THIS LIST OF PARTNERS BE SAVED? Null when it may; otherwise the refusal, in the words the card prints and the door answers.
 * One function for both, so the sentence the person reads before pressing is the sentence the server would have answered with.
 */
export function sharesProblem(rows: readonly ShareRow[]): SharesRefusal | null {
  if (rows.length === 0) return { code: 'NO_PARTNERS', error: 'أضف شريكاً واحداً على الأقل.' };
  if (rows.length > MAX_PARTNERS) return { code: 'TOO_MANY', error: `أكثر من ${MAX_PARTNERS} شريك — هاد كتير.` };

  const seen = new Set<string>();
  for (const r of rows) {
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if ([...name].length < NAME_MIN) return { code: 'NAME_REQUIRED', error: 'اكتب اسم كل شريك (حرفين على الأقل).' };
    if ([...name].length > NAME_MAX) return { code: 'NAME_TOO_LONG', error: `اسم الشريك طويل — ${NAME_MAX} حرف على الأكثر.` };
    const key = nameKey(name);
    if (seen.has(key)) return { code: 'NAME_TWICE', error: `في اسمين متشابهين: «${name}». غيّر وحد منهم.` };
    seen.add(key);
    if (shareHundredths(r.sharePercent) === null) {
      return {
        code: 'SHARE_INVALID',
        error: `نسبة «${name}» لازم تكون رقم أكبر من صفر وما تزيد عن ${PARTNER_SHARE_TOTAL}، وبخانتين عشريتين على الأكثر.`,
      };
    }
  }
  if (!rows.some((r) => r.isActive)) return { code: 'NO_ACTIVE', error: 'لازم يضل شريك فعّال واحد على الأقل.' };

  const total = activeSharesTotal(rows);
  if (Math.round(total * 100) !== PARTNER_SHARE_TOTAL * 100) {
    return { code: 'SHARES_NOT_100', error: `مجموع نسب الشركاء الفعّالين ${total} — لازم يكون ${PARTNER_SHARE_TOTAL} بالضبط.` };
  }
  return null;
}

/** What a partner has and has taken, in whole minor units: the balance, and what is «مكسور عليه» (never below zero). */
export function positionOf(entitlementUnits: number, drawsUnits: number): { balanceUnits: number; brokenUnits: number } {
  const balanceUnits = entitlementUnits - drawsUnits;
  return { balanceUnits, brokenUnits: Math.max(0, -balanceUnits) };
}

export interface StatementPartner {
  id: string;
  name: string;
  sharePercent: number;
  isActive: boolean;
}

export interface StatementLine extends StatementPartner {
  /** His share of the net profit since the beginning; null while the shares cannot be cut (see `state`). */
  entitlement: number | null;
  /** What he has drawn, in the store's currency; reversed draws are not in it. */
  draws: number;
  /** entitlement − draws; null when there is no entitlement to measure against. */
  balance: number | null;
  /** «مكسور عليه»: what he has drawn beyond his entitlement, or 0 — and null when it cannot be said. */
  broken: number | null;
}

export type StatementState = 'OK' | 'NO_PARTNERS' | 'SHARES_NOT_100';

export interface StatementLines {
  /** `OK` when the active shares total exactly 100.00; otherwise nothing is split and no one is «مكسور عليه». */
  state: StatementState;
  sharesTotal: number;
  lines: StatementLine[];
  totals: { entitlement: number | null; draws: number; broken: number | null };
}

/**
 * THE STATEMENT, FROM THREE INPUTS: the net profit (the profit screen's own number), the partners, and each partner's draws in whole
 * minor units. The partners are taken in the order given — that order also decides who gets the last cent of the split.
 *
 * A partner who is switched off is out of the split (his entitlement is 0: shares are today's shares for all history) and is listed
 * only while he has draws that stand, so money he took never disappears from the table.
 *
 * If the active shares do not total exactly 100.00 — or there is no active partner — NOTHING IS SPLIT: entitlements, balances and
 * «مكسور عليه» are null rather than zeros, because a zero entitlement would make every draw look broken.
 */
export function partnerLines(input: {
  netProfit: number;
  partners: readonly StatementPartner[];
  drawsUnits: Readonly<Record<string, number>>;
  minorUnit: number;
}): StatementLines {
  const { netProfit, partners, drawsUnits, minorUnit } = input;
  const active = partners.filter((p) => p.isActive);
  const sharesTotal = activeSharesTotal(active.map((p) => ({ name: p.name, sharePercent: p.sharePercent, isActive: true })));
  const state: StatementState = active.length === 0 ? 'NO_PARTNERS' : Math.round(sharesTotal * 100) !== PARTNER_SHARE_TOTAL * 100 ? 'SHARES_NOT_100' : 'OK';

  // A loss gives everyone nothing: the floor is the partners' rule, the profit itself is left as it is.
  const profitUnits = Math.max(0, toMinorUnits(netProfit, minorUnit));
  const split = state === 'OK' ? splitUnitsByShares(profitUnits, active.map((p) => p.sharePercent)) : [];
  const entitled = new Map(active.map((p, i) => [p.id, split[i] ?? 0]));

  const shown = partners.filter((p) => p.isActive || (drawsUnits[p.id] ?? 0) !== 0);
  const lines: StatementLine[] = shown.map((p) => {
    const draws = drawsUnits[p.id] ?? 0;
    if (state !== 'OK') {
      return { ...p, entitlement: null, draws: fromMinorUnits(draws, minorUnit), balance: null, broken: null };
    }
    const entitlement = entitled.get(p.id) ?? 0;
    const { balanceUnits, brokenUnits } = positionOf(entitlement, draws);
    return {
      ...p,
      entitlement: fromMinorUnits(entitlement, minorUnit),
      draws: fromMinorUnits(draws, minorUnit),
      balance: fromMinorUnits(balanceUnits, minorUnit),
      broken: fromMinorUnits(brokenUnits, minorUnit),
    };
  });

  const sum = (pick: (l: StatementLine) => number | null) => lines.reduce((s, l) => s + toMinorUnits(pick(l) ?? 0, minorUnit), 0);
  return {
    state,
    sharesTotal,
    lines,
    totals: {
      entitlement: state === 'OK' ? fromMinorUnits(sum((l) => l.entitlement), minorUnit) : null,
      draws: fromMinorUnits(sum((l) => l.draws), minorUnit),
      broken: state === 'OK' ? fromMinorUnits(sum((l) => l.broken), minorUnit) : null,
    },
  };
}

/** One partner draw as the list shows it — a wallet movement of category PARTNER_DRAW, read (`partner-statement.ts`). */
export interface PartnerDrawRow {
  /** The wallet movement. */
  id: string;
  walletId: string;
  walletName: string;
  partnerId: string | null;
  partnerName: string;
  /** In the wallet's own currency, as typed. */
  amount: number;
  currencyCode: string;
  /** In the store's currency — the number the ledger adds up. Null only on a row nobody should have been able to write. */
  valueInStoreCurrency: number | null;
  note: string;
  createdAt: string;
  createdByName: string | null;
  /** A reversing entry took it back: shown, marked, and counted as nothing. */
  reversed: boolean;
}

/** What `GET /api/finance/partners/statement` answers: the lines of `partnerLines`, and the figures that explain them. */
export interface PartnerStatement extends StatementLines {
  currency: string;
  minorUnit: number;
  /** Exactly `summary.netProfit` of the profit screen, losses included (the floor at zero is applied inside the split). */
  netProfit: number;
  /** Whether the cost of goods behind that profit was recorded on enough orders to say it out loud (`cod-vitals` `trustOf`). */
  trust: Trust;
  /** Draws that stand but cannot be counted (no partner or no store value). Normally zero; said on the screen when not. */
  uncounted: number;
  /** The newest draws, reversed ones marked. */
  draws: PartnerDrawRow[];
}

/**
 * «بعد هالسحب» — what one more draw would leave, by the same subtraction the statement makes. The draw is ALLOWED either way: this
 * only says, before the press, how much would be «مكسور عليه». Null figures stay null (the shares cannot be cut).
 */
export function afterDraw(
  line: { entitlement: number | null; draws: number },
  value: number,
  minorUnit: number
): { draws: number; balance: number | null; broken: number | null } {
  const draws = toMinorUnits(line.draws, minorUnit) + toMinorUnits(value, minorUnit);
  if (line.entitlement === null) return { draws: fromMinorUnits(draws, minorUnit), balance: null, broken: null };
  const { balanceUnits, brokenUnits } = positionOf(toMinorUnits(line.entitlement, minorUnit), draws);
  return { draws: fromMinorUnits(draws, minorUnit), balance: fromMinorUnits(balanceUnits, minorUnit), broken: fromMinorUnits(brokenUnits, minorUnit) };
}
