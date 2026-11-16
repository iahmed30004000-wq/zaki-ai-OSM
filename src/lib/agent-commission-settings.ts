import type { Prisma } from '@prisma/client';
import { updateCompanySettings } from './company-settings';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COMMISSION CALCULATOR'S SETTINGS (Confirmation Center v2, step G2): `Company.settings.agentCommission` — editable by the owner, defaults = the planner's figures.
 *
 *   tiers      the confirmed count at which each tier starts, and what it pays (a lump sum for the month): 100 → 25,000 · 120 → 35,000 · 140 → 50,000 · 160 → 60,000 · 200 → 100,000
 *   bonus      from `minOrders` confirmed orders in the month, `perOrder` for EVERY order instead of the tier's lump sum: 2,000 → 500
 *   qualityGate  optional: count the tier only when the delivery rate of her mature confirmations is at least `minDeliveryRate`%, else one tier down
 *
 * THIS IS A CALCULATOR, NOT THE LEDGER. It reads the existing commission base (`commission-metrics.ts`, one source of «confirmed»), writes NOTHING and pays NOTHING: what is
 * accrued and paid is still `commission.ts` / `commission-period.ts` / `commission-payout.ts` and the rules of the commission screen. The estimate says so on its face.
 *
 * No switch and no migration: the document sits under its own key, parsed strictly — anything that is not exactly a valid document is the defaults (a broken settings row must
 * never produce a wild estimate), and a SAVE refuses an invalid document with an Arabic sentence instead of storing it.
 * ═══════════════════════════════════════════════════════════════════════
 */

export const AGENT_COMMISSION_SETTINGS_KEY = 'agentCommission';

export interface CommissionTier {
  /** Confirmed orders in the month at which the tier starts. */
  from: number;
  /** The month's lump sum at this tier. */
  value: number;
}

export interface AgentCommissionConfig {
  tiers: CommissionTier[];
  bonus: { minOrders: number; perOrder: number };
  qualityGate: { enabled: boolean; minDeliveryRate: number };
}

export const AGENT_COMMISSION_DEFAULTS: AgentCommissionConfig = Object.freeze({
  tiers: [
    { from: 100, value: 25_000 },
    { from: 120, value: 35_000 },
    { from: 140, value: 50_000 },
    { from: 160, value: 60_000 },
    { from: 200, value: 100_000 },
  ],
  bonus: { minOrders: 2_000, perOrder: 500 },
  qualityGate: { enabled: false, minDeliveryRate: 80 },
}) as AgentCommissionConfig;

const MAX_TIERS = 12;
const MAX_MONEY = 1_000_000_000;
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export type Validation = { ok: true; config: AgentCommissionConfig } | { ok: false; error: string };

/** A document is valid only if it is exactly this shape: ascending whole tiers, whole money, a gate between 1 and 100. Returns the Arabic reason when not. */
export function validateAgentCommission(input: unknown): Validation {
  const o = (input && typeof input === 'object' ? input : null) as Record<string, any> | null;
  if (!o || Object.keys(o).some((k) => !['tiers', 'bonus', 'qualityGate'].includes(k))) return { ok: false, error: 'الإعداد لازم يكون شرائح وبونص وبوابة جودة فقط.' };
  if (!Array.isArray(o.tiers) || o.tiers.length < 1 || o.tiers.length > MAX_TIERS) return { ok: false, error: `لازم شريحة وحدة على الأقل وبحد أقصى ${MAX_TIERS}.` };
  let last = 0;
  for (const t of o.tiers) {
    if (!t || typeof t !== 'object' || Object.keys(t).some((k) => k !== 'from' && k !== 'value')) return { ok: false, error: 'كل شريحة فيها «من» و«المبلغ» فقط.' };
    if (!isWhole(t.from) || t.from < 1) return { ok: false, error: 'بداية الشريحة عدد صحيح من 1 وفوق.' };
    if (!isWhole(t.value) || t.value < 0 || t.value > MAX_MONEY) return { ok: false, error: 'مبلغ الشريحة عدد صحيح من صفر وفوق.' };
    if (t.from <= last) return { ok: false, error: 'بدايات الشرائح لازم تكبر شريحة ورا شريحة، بدون تكرار.' };
    last = t.from;
  }
  const b = o.bonus;
  if (!b || typeof b !== 'object' || Object.keys(b).some((k) => k !== 'minOrders' && k !== 'perOrder') || !isWhole(b.minOrders) || b.minOrders < 1 || !isWhole(b.perOrder) || b.perOrder < 0 || b.perOrder > MAX_MONEY) {
    return { ok: false, error: 'البونص: حد الطلبات من 1 وفوق، وسعر الطلب من صفر وفوق، أعداد صحيحة.' };
  }
  const g = o.qualityGate;
  if (!g || typeof g !== 'object' || Object.keys(g).some((k) => k !== 'enabled' && k !== 'minDeliveryRate') || typeof g.enabled !== 'boolean' || !isWhole(g.minDeliveryRate) || g.minDeliveryRate < 1 || g.minDeliveryRate > 100) {
    return { ok: false, error: 'بوابة الجودة: مفعّلة أو لا، ونسبة تسليم من 1 لـ100.' };
  }
  return {
    ok: true,
    config: {
      tiers: o.tiers.map((t: CommissionTier) => ({ from: t.from, value: t.value })),
      bonus: { minOrders: b.minOrders, perOrder: b.perOrder },
      qualityGate: { enabled: g.enabled, minDeliveryRate: g.minDeliveryRate },
    },
  };
}

/** A stored value as this build understands it — anything but a valid document is the defaults. */
export function parseAgentCommission(raw: unknown): AgentCommissionConfig {
  const checked = validateAgentCommission(raw);
  return checked.ok ? checked.config : AGENT_COMMISSION_DEFAULTS;
}

/** The settings of this company — the defaults on any failure. */
export async function readAgentCommission(client: Client, companyId: string): Promise<AgentCommissionConfig> {
  try {
    const company = await client.company.findUnique({ where: { id: companyId }, select: { settings: true } });
    return parseAgentCommission((company?.settings ? JSON.parse(company.settings) : {})[AGENT_COMMISSION_SETTINGS_KEY]);
  } catch {
    return AGENT_COMMISSION_DEFAULTS;
  }
}

/** Store a VALID document (the caller validated it) under its own key, under the row lock. */
export async function saveAgentCommission(companyId: string, config: AgentCommissionConfig): Promise<AgentCommissionConfig> {
  const stored = await updateCompanySettings<AgentCommissionConfig>(companyId, AGENT_COMMISSION_SETTINGS_KEY, () => config);
  return parseAgentCommission(stored);
}
