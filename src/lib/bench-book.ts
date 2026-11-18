import { db } from './db';
import { updateCompanySettings } from './company-settings';
import { parseBenchRules, storedBenchRules, type BenchRules } from './bench-verdict';
import { BenchRefused, storedSpend, type BenchSpendEntry } from './bench-spend';

/**
 * WHERE THE BENCH'S RULES AND HAND-WRITTEN SPEND ARE KEPT — no new table.
 *
 * Two keys of the company's settings document (`Company.settings`), the
 * same home as the performance bars (performance-settings.ts):
 *   · `benchRules` — { [productId]: BenchRules }, only the products whose
 *     owner changed a default; a product with no entry reads the defaults.
 *   · `benchSpend` — { [productId]: BenchSpendEntry[] }, voided entries kept.
 * Each save changes ONLY its own key, under the row lock
 * `updateCompanySettings` takes, so a rules save and a spend save at the same
 * moment cannot write each other's old copy back.
 *
 * Why not a table: a bench runs a handful of products for a few days each,
 * and a migration is a deploy step the owner has to watch. If the media
 * buyer's ad-spend table later feeds the bench, the hand-written spend can
 * move into it then.
 */

const RULES_KEY = 'benchRules';
const SPEND_KEY = 'benchSpend';

export interface BenchBook {
  rulesOf: (productId: string) => { rules: BenchRules; custom: boolean };
  spendOf: (productId: string) => BenchSpendEntry[];
}

export function bookFrom(settings: string | null | undefined): BenchBook {
  let all: Record<string, unknown> = {};
  try {
    all = settings ? JSON.parse(settings) : {};
  } catch {
    // A broken document must not take the bench down: defaults, no spend.
    all = {};
  }
  const rules = (all[RULES_KEY] ?? {}) as Record<string, unknown>;
  const spend = (all[SPEND_KEY] ?? {}) as Record<string, unknown>;
  return {
    rulesOf: (id) => (rules[id] ? { rules: storedBenchRules(rules[id]), custom: true } : { rules: storedBenchRules(null), custom: false }),
    spendOf: (id) => storedSpend(spend[id]),
  };
}

export async function readBenchBook(companyId: string): Promise<BenchBook> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  return bookFrom(company?.settings);
}

/**
 * A product of a BENCH store of this company, with the store's money and day.
 * Anything else is refused: these keys write about test products only.
 */
export async function benchProduct(companyId: string, productId: unknown) {
  if (typeof productId !== 'string' || !productId) throw new BenchRefused('اختار منتج.');
  const product = await db.product.findFirst({
    where: { id: productId, companyId, store: { isTest: true } },
    select: {
      id: true,
      name: true,
      store: { select: { country: { select: { currencyCode: true, minorUnit: true, timezone: true } } } },
    },
  });
  if (!product?.store) throw new BenchRefused('هالمنتج مش على منصّة التجريب.');
  return { id: product.id, name: product.name, ...product.store.country };
}

/** Save one product's rules (null = back to the defaults). Refuses with every problem in one sentence list. */
export async function saveBenchRules(companyId: string, productId: string, raw: unknown): Promise<BenchRules | null> {
  if (raw === null) {
    await updateCompanySettings<Record<string, BenchRules>>(companyId, RULES_KEY, (cur) => {
      const next = { ...(cur ?? {}) };
      delete next[productId];
      return Object.keys(next).length ? next : undefined;
    });
    return null;
  }
  const { rules, errors } = parseBenchRules(raw);
  if (errors.length) throw new BenchRefused(errors.join(' '));
  await updateCompanySettings<Record<string, BenchRules>>(companyId, RULES_KEY, (cur) => ({ ...(cur ?? {}), [productId]: rules }));
  return rules;
}

/** Change one product's spend list under the lock; `change` throws BenchRefused to refuse. */
export async function changeBenchSpend(
  companyId: string,
  productId: string,
  change: (list: BenchSpendEntry[]) => BenchSpendEntry[]
): Promise<BenchSpendEntry[]> {
  let out: BenchSpendEntry[] = [];
  await updateCompanySettings<Record<string, unknown>>(companyId, SPEND_KEY, (cur) => {
    out = change(storedSpend((cur ?? {})[productId]));
    return { ...(cur ?? {}), [productId]: out };
  });
  return out;
}
