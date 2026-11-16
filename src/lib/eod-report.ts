import type { Prisma } from '@prisma/client';
import { zonedParts, zonedTimeToInstant } from './business-calendar';
import { NO_ANSWER_RESULTS, REJECTION_REASON_AR } from './confirmation-workflow';
import { isValidPhoneFor } from './phone-rules';
import { EOD_METRICS, EOD_METRIC_AR, MAX_TEXT, type EodMetric } from './eod-metrics';
import type { db } from './db';

type Client = Prisma.TransactionClient | typeof db;

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TEAM LEADER'S END-OF-DAY REPORT (Confirmation Center v2, step H2) — what she says, what the system counted, and how far apart they are.
 *
 *   · `systemNumbers`  per agent, for one local day of the store: claims · confirmed · rejected (and by reason) · «لا يرد» lines · winback offered (and how many became a confirmed
 *     order) · orders held more than 48 hours. Read only; agents and counts only — no customer field.
 *   · `validateSubmission`  her form: the same six figures per agent as WHOLE numbers, plus the biggest problem and the tip for tomorrow (text). Anything else is refused in Arabic.
 *   · `varianceOf`  her figure against the system's, in percent of the system's — the owner's audit reads it; she never sees a verdict.
 *   · `sampleRejected`  ten rejected orders of the day, chosen by a shuffle that depends only on the day (the same ten every time the owner opens it), each with its reason and whether the
 *     number is valid for the store's country — never the number itself.
 *
 * A report is written once and never edited (`confirmation_eod_reports`, a unique key per store, day and person): the system's numbers are frozen WITH hers.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** An order held this long without being decided is «stuck». */
export const STUCK_HOURS = 48;
export const SAMPLE_SIZE = 10;
const MAX_FIGURE = 100_000;

export interface AgentNumbers extends Record<EodMetric, number> {
  userId: string;
  name: string;
  rejectedByReason: Record<string, number>;
  winbackConverted: number;
}

export interface Submission {
  agents: ({ userId: string } & Record<EodMetric, number>)[];
  biggestProblem: string;
  tip: string;
}

export type Checked = { ok: true; value: Submission } | { ok: false; error: string };

/** Her form, validated whole: every agent is one the system knows for the day, every figure a whole number, the texts short. */
export function validateSubmission(input: unknown, knownUserIds: ReadonlySet<string>): Checked {
  const o = (input && typeof input === 'object' ? input : null) as Record<string, any> | null;
  if (!o || !Array.isArray(o.agents) || o.agents.length === 0) return { ok: false, error: 'أرسل أرقام موظفة وحدة على الأقل.' };
  if (typeof o.biggestProblem !== 'string' || typeof o.tip !== 'string') return { ok: false, error: 'اكتبي أكبر مشكلة ونصيحة بكرا (نص).' };
  if (o.biggestProblem.length > MAX_TEXT || o.tip.length > MAX_TEXT) return { ok: false, error: `النص أطول من ${MAX_TEXT} حرف.` };
  const seen = new Set<string>();
  const agents: Submission['agents'] = [];
  for (const a of o.agents) {
    if (!a || typeof a.userId !== 'string' || !knownUserIds.has(a.userId)) return { ok: false, error: 'موظفة مش من فريق اليوم.' };
    if (seen.has(a.userId)) return { ok: false, error: 'نفس الموظفة مكررة.' };
    seen.add(a.userId);
    const row = { userId: a.userId } as Submission['agents'][number];
    for (const m of EOD_METRICS) {
      const v = a[m];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_FIGURE) return { ok: false, error: `رقم «${EOD_METRIC_AR[m]}» لازم يكون عدد صحيح من صفر وفوق.` };
      row[m] = v;
    }
    agents.push(row);
  }
  return { ok: true, value: { agents, biggestProblem: o.biggestProblem.trim(), tip: o.tip.trim() } };
}

export interface Variance {
  /** Her figure minus the system's, over the system's, as a whole percent; null when the system's figure is zero and hers is not (no base to measure from). */
  percent: number | null;
  submitted: number;
  system: number;
}

/** (submitted − system) ÷ system. Both zero is an agreement (0%); a system zero against a non-zero figure has no percent. */
export function varianceOf(submitted: number, system: number): Variance {
  if (system === 0) return { percent: submitted === 0 ? 0 : null, submitted, system };
  return { percent: Math.round(((submitted - system) / system) * 100), submitted, system };
}

/** Per agent, per metric: the variance of what she said against what the system froze. An agent she left out of her form is reported as zero figures. */
export function compare(submission: Submission, system: readonly AgentNumbers[]): { userId: string; name: string; metrics: Record<EodMetric, Variance> }[] {
  return system.map((s) => {
    const said = submission.agents.find((a) => a.userId === s.userId);
    const metrics = {} as Record<EodMetric, Variance>;
    for (const m of EOD_METRICS) metrics[m] = varianceOf(said ? said[m] : 0, s[m]);
    return { userId: s.userId, name: s.name, metrics };
  });
}

/** The store's local day, YYYY-MM-DD, of an instant. */
export function localDay(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The instants a local day of the store starts and ends at (end exclusive). */
export function dayRange(day: string, timeZone: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = zonedTimeToInstant(timeZone, y, mo, d, 0, 0);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = zonedTimeToInstant(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
}

/** A report may be written for today or yesterday of the store — not for a day long gone, where it could be made up from what the system shows. */
export function mayReportDay(day: string, now: Date, timeZone: string): boolean {
  const today = localDay(now, timeZone);
  const yesterday = localDay(new Date(now.getTime() - 86_400_000), timeZone);
  return day === today || day === yesterday;
}

/** A small deterministic generator: the same seed gives the same ten orders every time the owner opens the day. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `size` of the ids, in an order that depends only on the seed; fewer when there are fewer. */
export function shuffleSample<T>(items: readonly T[], seed: string, size: number = SAMPLE_SIZE): T[] {
  const a = [...items];
  const rnd = seeded(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, size);
}

/** The system's numbers for one local day, per agent who did anything that day. Read only. */
export async function systemNumbers(
  client: Client,
  scope: { companyId: string; storeId: string; start: Date; end: Date },
  now: Date = new Date()
): Promise<AgentNumbers[]> {
  const inDay = { gte: scope.start, lt: scope.end };
  const [claims, decisions, attempts, offers, held] = await Promise.all([
    client.orderClaimHistory.findMany({
      where: { companyId: scope.companyId, action: 'CLAIMED', createdAt: inDay, order: { storeId: scope.storeId } },
      select: { userId: true, orderId: true },
      take: 50_000,
    }),
    client.orderStatusLog.findMany({
      where: { companyId: scope.companyId, statusType: 'CONFIRMATION', newValue: { in: ['CONFIRMED', 'REJECTED'] }, createdAt: inDay, order: { storeId: scope.storeId } },
      select: { changedById: true, orderId: true, newValue: true, createdAt: true, order: { select: { rejectionReason: true } } },
      orderBy: { createdAt: 'asc' },
      take: 50_000,
    }),
    client.orderContactAttempt.findMany({
      where: { companyId: scope.companyId, createdAt: inDay, result: { in: [...NO_ANSWER_RESULTS] }, order: { storeId: scope.storeId } },
      select: { employeeId: true },
      take: 100_000,
    }),
    client.auditLog.findMany({
      where: { companyId: scope.companyId, action: 'WINBACK_OFFERED', createdAt: inDay, userId: { not: null } },
      select: { userId: true, newData: true },
      take: 20_000,
    }),
    client.order.findMany({
      where: {
        companyId: scope.companyId,
        storeId: scope.storeId,
        claimedById: { not: null },
        confirmationStatus: { in: ['NEW', 'IN_PROGRESS', 'NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED'] },
        claimedAt: { lt: new Date(now.getTime() - STUCK_HOURS * 3_600_000) },
      },
      select: { claimedById: true },
      take: 20_000,
    }),
  ]);

  // winback offered: how many of the new orders it made are confirmed by now
  const newOrderIds: string[] = [];
  const offeredBy = new Map<string, string[]>();
  for (const o of offers) {
    let id: string | null = null;
    try {
      id = (JSON.parse(o.newData ?? '{}') as { newOrderId?: string }).newOrderId ?? null;
    } catch {
      id = null;
    }
    offeredBy.set(o.userId!, [...(offeredBy.get(o.userId!) ?? []), id ?? '']);
    if (id) newOrderIds.push(id);
  }
  const confirmedNew = new Set(
    newOrderIds.length ? (await client.order.findMany({ where: { id: { in: newOrderIds }, confirmationStatus: 'CONFIRMED' }, select: { id: true } })).map((o) => o.id) : []
  );

  const rows = new Map<string, AgentNumbers>();
  const row = (userId: string): AgentNumbers => {
    let r = rows.get(userId);
    if (!r) {
      r = { userId, name: '—', claims: 0, confirmed: 0, rejected: 0, noAnswer: 0, winback: 0, stuck: 0, rejectedByReason: {}, winbackConverted: 0 };
      rows.set(userId, r);
    }
    return r;
  };
  const claimed = new Map<string, Set<string>>();
  for (const c of claims) claimed.set(c.userId, (claimed.get(c.userId) ?? new Set()).add(c.orderId));
  for (const [u, set] of claimed) row(u).claims = set.size;

  // the LAST decision of each (agent, order) stands
  const last = new Map<string, (typeof decisions)[number]>();
  for (const d of decisions) last.set(`${d.changedById}|${d.orderId}`, d);
  for (const d of last.values()) {
    const r = row(d.changedById);
    if (d.newValue === 'CONFIRMED') r.confirmed += 1;
    else {
      r.rejected += 1;
      const reason = d.order.rejectionReason ?? 'OTHER';
      r.rejectedByReason[reason] = (r.rejectedByReason[reason] ?? 0) + 1;
    }
  }
  for (const a of attempts) row(a.employeeId).noAnswer += 1;
  for (const [u, ids] of offeredBy) {
    const r = row(u);
    r.winback = ids.length;
    r.winbackConverted = ids.filter((id) => id && confirmedNew.has(id)).length;
  }
  for (const h of held) row(h.claimedById!).stuck += 1;

  const ids = [...rows.keys()];
  const users = ids.length ? await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  for (const u of users) row(u.id).name = u.name ?? '—';
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

export interface SampleRow {
  /** The order's id — so the owner can open it; an id is not a customer field. */
  orderId: string;
  orderNumber: string;
  reason: string;
  reasonAr: string;
  agent: string;
  /** Whether the customer's number has the shape of a number of the store's country — a yes or a no, never the number. */
  phoneValid: boolean;
}

/** Ten rejected orders of the day, the same ten every time the day is opened. Customer fields are used only to answer «is the number valid». */
export async function sampleRejected(
  client: Client,
  scope: { companyId: string; storeId: string; start: Date; end: Date; countryCode: string; day: string }
): Promise<SampleRow[]> {
  const logs = await client.orderStatusLog.findMany({
    where: { companyId: scope.companyId, statusType: 'CONFIRMATION', newValue: 'REJECTED', createdAt: { gte: scope.start, lt: scope.end }, order: { storeId: scope.storeId, confirmationStatus: 'REJECTED' } },
    select: {
      orderId: true,
      changer: { select: { name: true } },
      order: { select: { orderNumber: true, rejectionReason: true, customer: { select: { rawPhone: true, phone: true } } } },
    },
    orderBy: { orderId: 'asc' },
    take: 5_000,
  });
  const byOrder = new Map(logs.map((l) => [l.orderId, l]));
  const chosen = shuffleSample([...byOrder.keys()].sort(), `${scope.companyId}:${scope.storeId}:${scope.day}`);
  return chosen.map((id) => {
    const l = byOrder.get(id)!;
    const reason = l.order.rejectionReason ?? 'OTHER';
    return {
      orderId: id,
      orderNumber: l.order.orderNumber,
      reason,
      reasonAr: REJECTION_REASON_AR[reason] ?? reason,
      agent: l.changer?.name ?? '—',
      phoneValid: isValidPhoneFor(scope.countryCode, l.order.customer?.rawPhone ?? l.order.customer?.phone ?? ''),
    };
  });
}
