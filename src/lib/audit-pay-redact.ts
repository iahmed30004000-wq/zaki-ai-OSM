/**
 * PAY IN THE AUDIT TRAIL IS PAYROLL'S.
 *
 * «سجل التدقيق» opens on `audit.view`, which the stage-2 templates give the
 * accountant and the settlement officer. Every row went out with its raw
 * before/after data: each salary paid — salary, deductions, net, the amount
 * handed over — every penalty's amount, every commission payout, and every
 * change to somebody's salary on their user record. The payroll key's own
 * catalog note says a salary must not ride on a broad key; this was the
 * broad key it rode on.
 *
 * The rows stay — who did what to whom, and when, is what the audit is for.
 * Only the amounts are taken out, for anyone without «عرض الرواتب», and the
 * row says so (`payWithheld`), so the screen can say why a field is missing.
 */

type AuditRow = { entity: string; previousData: string | null; newData: string | null };

/**
 * The rows that are about somebody's pay through and through — and, for
 * them, the fields that are NOT money. An ALLOW-list: a field added to one of
 * these payloads tomorrow is held back until somebody decides it is safe,
 * rather than shown until somebody notices it is pay.
 *
 * The keys are the ones the doors actually write (payroll/payslip,
 * team/penalties, finance/commission/payout).
 */
const PAY_ENTITY_SAFE_KEYS: Record<string, ReadonlySet<string>> = {
  Payslip: new Set(['employeeId', 'currency', 'paidCurrency', 'month', 'status']),
  Penalty: new Set(['employeeId', 'kind', 'currency', 'reason', 'status']),
  CommissionPayout: new Set(['person', 'currency', 'paidCurrency', 'entries', 'status']),
};

/** On a person's own record, the fields that are what they are paid. */
const USER_PAY_FIELD = /^(salary|commissionRate|commissionCurrency)/i;

/** A value that says something. A null that says «no salary set» hides nothing. */
const meaningful = (v: unknown) => v !== null && v !== undefined && v !== '';

function strip(value: unknown, isPay: (key: string) => boolean): { value: unknown; touched: boolean } {
  if (Array.isArray(value)) {
    let touched = false;
    const out = value.map((v) => {
      const r = strip(v, isPay);
      touched ||= r.touched;
      return r.value;
    });
    return { value: out, touched };
  }
  if (value && typeof value === 'object') {
    let touched = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isPay(k)) {
        // Dropped either way; only a real figure counts as something hidden.
        touched ||= meaningful(v);
        continue;
      }
      const r = strip(v, isPay);
      touched ||= r.touched;
      out[k] = r.value;
    }
    return { value: out, touched };
  }
  return { value, touched: false };
}

/** Also what the partners' redaction (audit-partners-redact.ts) cuts with: one way to take a field out of a row. */
export function stripJson(raw: string | null, isPay: (key: string) => boolean): { raw: string | null; touched: boolean } {
  if (!raw) return { raw, touched: false };
  try {
    const parsed = JSON.parse(raw);
    const r = strip(parsed, isPay);
    const changed = JSON.stringify(r.value) !== JSON.stringify(parsed);
    return { raw: changed ? JSON.stringify(r.value) : raw, touched: r.touched };
  } catch {
    // Not JSON: a pay row's free text could be anything, so it does not leave.
    return { raw: null, touched: true };
  }
}

/** One audit row as somebody without «عرض الرواتب» may read it. */
export function withoutPay<T extends AuditRow>(row: T): T & { payWithheld?: true } {
  const safe = PAY_ENTITY_SAFE_KEYS[row.entity];
  // Top-level keys only for the pay rows: a nested object there is dropped whole.
  const isPay = safe
    ? (k: string) => !safe.has(k)
    : row.entity === 'User'
      ? (k: string) => USER_PAY_FIELD.test(k)
      : null;
  if (!isPay) return row;
  const before = stripJson(row.previousData, isPay);
  const after = stripJson(row.newData, isPay);
  const out = { ...row, previousData: before.raw, newData: after.raw };
  if (!before.touched && !after.touched) return out;
  return { ...out, payWithheld: true };
}
