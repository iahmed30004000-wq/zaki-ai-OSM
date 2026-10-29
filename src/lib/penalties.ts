/**
 * DEDUCTIONS — WHAT MAY BE CHARGED, AND WHAT MAY NEVER BE.
 *
 * This is the most dangerous file added to this system, because everything
 * else here reports and this takes money. Four things hold it in place:
 *
 * 1. The system PROPOSES. A person APPLIES. No deduction becomes money
 *    because a job ran at midnight — the same rule every other movement in
 *    this system lives by, and for the same reason: the machine cannot know
 *    there was a funeral, a closed road, or a shift swapped by phone.
 *
 * 2. A measurement that is an ESTIMATE may not be charged at all. Lateness
 *    taken from the first order somebody touched is an upper bound — they
 *    were at their desk before that, and nobody knows how long before.
 *    Charging an upper bound is not a policy; it is an error with a receipt.
 *
 * 3. Grace and a cap, on every rule. A rule with no grace charges somebody
 *    every day traffic exists, and a deduction that happens daily stops
 *    being a signal about anything. A rule with no cap can eat a salary
 *    over one illness.
 *
 * 4. Nothing is deleted. A wrong deduction is REVERSED by a linked opposite
 *    row, so the record shows that it happened and that it was undone.
 */

export interface PenaltyKind {
  key: string;
  ar: string;
  /** What one unit is, said in the seller's words. */
  unitAr: string;
  /** What the deduction is read from, so nobody has to guess. */
  sourceAr: string;
}

export const PENALTY_KINDS: PenaltyKind[] = [
  {
    key: 'LATE',
    ar: 'التأخير',
    unitAr: 'دقيقة',
    sourceAr: 'الفرق بين وصوله وبداية دوامه هو — لا دوام البلد.',
  },
  {
    key: 'ABSENT',
    ar: 'الغياب',
    unitAr: 'يوم',
    sourceAr: 'يوم دوام لم يظهر فيه أثر حضور ولا عمل.',
  },
  {
    key: 'EARLY_LEAVE',
    ar: 'المغادرة المبكرة',
    unitAr: 'دقيقة',
    sourceAr: 'الفرق بين مغادرته ونهاية دوامه، ولا يُحتسب إلا بتسجيل خروج.',
  },
  {
    key: 'NO_ACTION',
    ar: 'طلب سُحب ولم يُعمل عليه',
    unitAr: 'طلب',
    sourceAr: 'طلبات سحبها ومرّت المهلة بلا محاولة اتصال واحدة.',
  },
];

export const PENALTY_KEYS = PENALTY_KINDS.map((k) => k.key);

/**
 * «فرق تحصيل» — a kind that NO RULE measures, which is why it is not in `PENALTY_KINDS`.
 *
 * Every kind above is a count (minutes, days, orders) multiplied by a rule's price, and the settings screen
 * offers a rule per kind. A collection shortfall is a sum of money that a courier statement already measured:
 * there is nothing to price, and a «rule» for it would be a second way to invent the number. It is written only
 * by the approval of a statement (see lib/shortfall) and listed beside the others wherever deductions are read.
 */
export const SHORTFALL_KIND_INFO: PenaltyKind = {
  key: 'SHORTFALL',
  ar: 'فرق تحصيل',
  unitAr: 'طلب',
  sourceAr: 'طلب سلّمه الموظف فدفعت الشركة عنه أقل من المتوقَّع، واعتُمد رقم الشركة.',
};

/** PROPOSED → APPLIED | WAIVED; APPLIED → REVERSED. Nothing else. */
export const PENALTY_STATUSES = ['PROPOSED', 'APPLIED', 'WAIVED', 'REVERSED'] as const;
export type PenaltyStatus = (typeof PENALTY_STATUSES)[number];

const NEXT: Record<PenaltyStatus, PenaltyStatus[]> = {
  PROPOSED: ['APPLIED', 'WAIVED'],
  // Applied money is undone by a reversal, never by being "unapplied".
  APPLIED: ['REVERSED'],
  WAIVED: [],
  REVERSED: [],
};

export function mayMove(from: string, to: PenaltyStatus): boolean {
  return (NEXT[from as PenaltyStatus] ?? []).includes(to);
}

export interface PenaltyRuleShape {
  perUnit: number;
  grace: number;
  periodCap: number | null;
}

export interface Charge {
  /** What was measured. */
  units: number;
  /** What is actually being charged after grace and the cap. */
  chargedUnits: number;
  amount: number;
  /** Null when there is something to charge. */
  refused: 'WITHIN_GRACE' | 'NOTHING_MEASURED' | 'ESTIMATED' | null;
}

const NOTHING = (units: number, refused: Charge['refused']): Charge => ({
  units,
  chargedUnits: 0,
  amount: 0,
  refused,
});

/**
 * What one occurrence costs.
 *
 * `alreadyCharged` is what this rule has already taken from this person in
 * the period, so the cap is a cap on the PERIOD and not on the day — a cap
 * applied per day is not a cap at all.
 *
 * `estimated` refuses outright. It is the guard that matters most here: an
 * arrival inferred from the first order somebody touched is an upper bound,
 * and the whole point of the flag is that we do not know when they sat down.
 */
export function chargeFor(
  rule: PenaltyRuleShape,
  input: { units: number; estimated?: boolean; alreadyCharged?: number; minorUnit?: number }
): Charge {
  const units = Math.max(0, Math.floor(input.units));
  if (units <= 0) return NOTHING(units, 'NOTHING_MEASURED');
  if (input.estimated) return NOTHING(units, 'ESTIMATED');

  const chargeable = units - Math.max(0, rule.grace);
  if (chargeable <= 0) return NOTHING(units, 'WITHIN_GRACE');

  const minorUnit = input.minorUnit ?? 2;
  const factor = 10 ** minorUnit;
  let amount = Math.round(chargeable * rule.perUnit * factor) / factor;

  if (rule.periodCap !== null && rule.periodCap !== undefined) {
    const room = Math.max(0, rule.periodCap - (input.alreadyCharged ?? 0));
    if (room <= 0) return NOTHING(units, 'WITHIN_GRACE');
    amount = Math.min(amount, Math.round(room * factor) / factor);
  }

  // A charge that rounds to nothing is not a charge. Proposing a zero would
  // put a row in front of a manager that costs them a decision and the
  // person nothing.
  if (amount <= 0) return NOTHING(units, 'WITHIN_GRACE');

  return { units, chargedUnits: chargeable, amount, refused: null };
}

/**
 * The rule that applies to this person, for this kind, on this day.
 *
 * The most specific wins: a rule naming their role beats one naming every
 * role, and a rule naming their store beats one naming every store. Two
 * rules of equal specificity is a configuration mistake, and the newer one
 * wins so that fixing it is a matter of writing a new rule rather than
 * hunting for the old one.
 */
export interface RuleRow extends PenaltyRuleShape {
  id: string;
  kind: string;
  storeId: string | null;
  role: string | null;
  currencyCode: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  createdAt: Date;
}

export function ruleFor(
  rules: RuleRow[],
  target: { kind: string; storeId: string; role: string; on: Date }
): RuleRow | null {
  const live = rules.filter(
    (r) =>
      r.isActive &&
      r.kind === target.kind &&
      (r.storeId === null || r.storeId === target.storeId) &&
      (r.role === null || r.role === target.role) &&
      r.effectiveFrom <= target.on &&
      (r.effectiveTo === null || r.effectiveTo > target.on)
  );
  if (live.length === 0) return null;

  const weight = (r: RuleRow) => (r.storeId ? 2 : 0) + (r.role ? 1 : 0);
  return live.sort((a, b) => weight(b) - weight(a) || +b.createdAt - +a.createdAt)[0];
}
