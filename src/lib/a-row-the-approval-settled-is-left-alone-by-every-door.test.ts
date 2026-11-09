import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A ROW THE APPROVAL ALREADY SETTLED IS FINAL — AND EVERY DOOR THAT WRITES A MATCH ROW LEAVES IT ALONE (S5 of the brief).
 *
 * «تسوية السطور النظيفة عند الاعتماد»: the early step settles a clean row’s order and marks the row `appliedAt`. From that moment the
 * row says something that is true of the world — an order settled and delivered — and nothing may rewrite, rebuild, answer, link,
 * swap or delete it before the matching closes. Restrict-only: each door gained `appliedAt: null` in its WHERE, none lost a condition.
 *
 *   · the matching again — the one that matters most: it DELETES every unanswered machine row and builds them afresh, so an applied row
 *     without the guard would be judged afresh as “collected by hand” and handed to the close as a contradicting second row;
 *   · the single answer and the bulk answer, the hand link, the parcel swap;
 *   · and a sweep of the source, so a door written tomorrow cannot forget it without this file failing.
 * ═══════════════════════════════════════════════════════════════════════
 */

/* ───────────────────────────── the matching again ───────────────────────────── */

const { mdb, rows, lines, orders } = vi.hoisted(() => {
  const rows: Record<string, any>[] = [];
  const lines: Record<string, any>[] = [];
  const orders = new Map<string, Record<string, any>>();
  const created: Record<string, any>[] = [];
  const mdb = {
    statementLine: {
      findMany: vi.fn(async (a: { where: { statementId?: string } }) => (a.where.statementId ? lines : [])),
    },
    courierStatement: {
      findFirst: vi.fn(async () => ({
        id: 'st1', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-10-20T00:00:00Z'), fileHash: 'ab'.repeat(32),
      })),
    },
    settlementMatch: {
      /** The delete says its WHERE and the store APPLIES it: a row the condition does not name stays. */
      deleteMany: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const gone = rows.filter(
          (r) =>
            r.statementId === where.statementId &&
            (where.resolution === null ? !r.resolution : true) &&
            (!('appliedAt' in where) || (where.appliedAt === null && !r.appliedAt)) &&
            (where.OR as { matchedBy: unknown }[]).some((alt) => (alt.matchedBy === null ? r.matchedBy == null : r.matchedBy !== 'MANUAL'))
        );
        for (const g of gone) rows.splice(rows.indexOf(g), 1);
        return { count: gone.length };
      }),
      findMany: vi.fn(async (a: { where: Record<string, any> }) => {
        if (a.where.statementId === 'st1') return rows.map((r) => ({ ...r }));
        return [];
      }),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        created.push(data);
        rows.push({ id: `new-${created.length}`, appliedAt: null, resolution: null, ...data });
        return {};
      }),
    },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    order: {
      findFirst: vi.fn(async (a: { where: { merchantRef?: string } }) => {
        for (const o of orders.values()) if (o.merchantRef === a.where.merchantRef) return o;
        return null;
      }),
      findMany: vi.fn(async () => []),
    },
  };
  return { mdb, rows, lines, orders, created };
});
import { runMatching } from './settlement';

const shop = (id: string, over: Record<string, any> = {}) => ({
  id, merchantRef: `REF-${id}`, trackingNumber: null, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION',
  totalAmount: 20, priceIncludesDelivery: false, collectedAmount: null, deliveryFee: 0, returnReceipt: null, addOns: [],
  items: [{ quantity: 1, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 20, deliveredQty: null }], ...over,
});
const line = (id: string, ref: string) => ({ id, merchantRef: ref, barcode: null, amount: 20, collected: 20, fee: null, status: null, createdAt: new Date() });
const scope = { companyId: 'c1', storeId: 's1', statementId: 'st1', minorUnit: 3 };
const kept = (r: Record<string, any>) => ({ statementId: 'st1', companyId: 'c1', resolution: null, matchedBy: 'MERCHANT_REF', appliedAt: null, ...r });

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0;
  lines.length = 0;
  orders.clear();
});

describe('matching again does not rebuild a row the approval settled', () => {
  it('its delete says `appliedAt: null` in its own WHERE — beside the conditions it always had, none dropped', async () => {
    await runMatching(mdb as never, scope);
    const where = mdb.settlementMatch.deleteMany.mock.calls[0][0].where;
    expect(where).toEqual({
      statementId: 'st1', resolution: null, appliedAt: null,
      OR: [{ matchedBy: null }, { matchedBy: { not: 'MANUAL' } }],
    });
  });

  it('an applied clean row survives the run, byte for byte; the clean row beside it that was NOT applied is rebuilt', async () => {
    orders.set('oA', shop('oA', { settlementStatus: 'SETTLED', shippingStatus: 'DELIVERED' }));
    orders.set('oB', shop('oB'));
    lines.push(line('lA', 'REF-oA'), line('lB', 'REF-oB'));
    const applied = kept({ id: 'rA', statementLineId: 'lA', orderId: 'oA', result: 'MATCHED', appliedAt: new Date('2026-11-09T10:00:00Z') });
    const pending = kept({ id: 'rB', statementLineId: 'lB', orderId: 'oB', result: 'MATCHED' });
    rows.push({ ...applied }, { ...pending });

    const outcome = await runMatching(mdb as never, scope);

    // The applied row is the very same row — not deleted, not recreated — and its line was not matched a second time.
    expect(rows.find((r) => r.id === 'rA')).toEqual(applied);
    expect(mdb.order.findFirst.mock.calls.map((c) => (c[0] as { where: { merchantRef: string } }).where.merchantRef)).toEqual(['REF-oB']);
    // The pending one was deleted and rebuilt, as it always was.
    expect(rows.find((r) => r.id === 'rB')).toBeUndefined();
    expect(rows.filter((r) => r.orderId === 'oB')).toHaveLength(1);
    expect(rows.find((r) => r.orderId === 'oB')).toMatchObject({ result: 'MATCHED', statementLineId: 'lB' });
    expect(outcome).toMatchObject({ matched: 2, kept: 1 });
  });

  it('and it is not judged as “collected by hand” afresh: no row says so, though its order is settled now', async () => {
    orders.set('oA', shop('oA', { settlementStatus: 'SETTLED' }));
    lines.push(line('lA', 'REF-oA'));
    rows.push(kept({ id: 'rA', statementLineId: 'lA', orderId: 'oA', result: 'MATCHED', appliedAt: new Date() }));
    await runMatching(mdb as never, scope);
    expect(mdb.settlementMatch.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('MATCHED');
  });

  it('a second line naming the applied row’s order is flagged as the second claim it is — the applied row still holds the order', async () => {
    orders.set('oA', shop('oA', { settlementStatus: 'SETTLED' }));
    lines.push(line('lA', 'REF-oA'), line('lA2', 'REF-oA'));
    rows.push(kept({ id: 'rA', statementLineId: 'lA', orderId: 'oA', result: 'MATCHED', appliedAt: new Date() }));
    await runMatching(mdb as never, scope);
    const second = rows.find((r) => r.statementLineId === 'lA2')!;
    expect(second.result).toBe('MISMATCHED');
    expect(second.note).toContain('الطلب مذكور بسطر آخر من هذا الكشف');
    expect(rows.find((r) => r.id === 'rA')!.appliedAt).not.toBeNull();
  });

  it('NEGATIVE — the same run with a row that is NOT applied rebuilds it: the guard is the mark, nothing wider', async () => {
    orders.set('oB', shop('oB'));
    lines.push(line('lB', 'REF-oB'));
    rows.push(kept({ id: 'rB', statementLineId: 'lB', orderId: 'oB', result: 'MATCHED' }));
    await runMatching(mdb as never, scope);
    expect(mdb.settlementMatch.create).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.id === 'rB')).toBeUndefined();
  });

  it('a row a person answered or tied by hand is kept as it always was, applied or not', async () => {
    orders.set('oC', shop('oC'));
    lines.push(line('lC', 'REF-oC'));
    rows.push(kept({ id: 'rC', statementLineId: 'lC', orderId: 'oC', result: 'MISMATCHED', resolution: 'UNDER_REVIEW' }));
    await runMatching(mdb as never, scope);
    expect(rows.map((r) => r.id)).toEqual(['rC']);
  });
});

/* ───────────────────────────── the answer doors ───────────────────────────── */

const { ddb, dworld, requireContext, requirePermission, logAudit } = vi.hoisted(() => {
  const dworld = {
    statement: { id: 'st1', companyId: 'c1', storeId: 's1', reference: 'ST-1', status: 'APPROVED', approvedAt: new Date('2026-11-09T08:00:00Z'), matchingClosedAt: null as Date | null },
    match: null as Record<string, any> | null,
    matches: [] as Record<string, any>[],
    writes: [] as Record<string, any>[],
    notes: [] as unknown[],
  };
  /** What a database does with `select`: only the columns asked for come back — a door that forgets one does not see it. */
  const pick = (r: Record<string, any> | null, select?: Record<string, unknown>) =>
    r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r;
  const ddb = {
    courierStatement: { findFirst: vi.fn(async () => dworld.statement) },
    settlementMatch: {
      findFirst: vi.fn(async (a: { select?: Record<string, unknown> }) => pick(dworld.match, a?.select)),
      findMany: vi.fn(async (a: { where: Record<string, any>; select?: Record<string, unknown> }) =>
        a.where.OR ? [] : dworld.matches.map((r) => pick(r, a.select))
      ),
      updateMany: vi.fn(async (a: { where: Record<string, any>; data: Record<string, any> }) => {
        dworld.writes.push(a);
        return { count: 1 };
      }),
    },
    order: { findMany: vi.fn(async () => [{ id: 'o1', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION' }]) },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    orderNote: { create: vi.fn(async (a: unknown) => { dworld.notes.push(a); }) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(ddb)),
  };
  return { ddb, dworld, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db: ddb }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST as resolveOne } from '../app/api/finance/statements/[id]/matches/[matchId]/resolve/route';
import { POST as resolveMany } from '../app/api/finance/statements/[id]/decisions/route';
import { ROW_APPLIED_SENTENCE } from './settlement-gates';

const MID = '11111111-1111-4111-8111-111111111111';
const aDifference = (over: Record<string, any> = {}) => ({
  id: MID, result: 'MISMATCHED', resolution: null, appliedAt: null, orderId: 'o1', expectedAmount: 20, statementAmount: 18, difference: -2,
  statementLine: { status: null }, statement: { reference: 'ST-1' }, order: { orderNumber: 'ORD-1' }, ...over,
});
const one = (body: Record<string, unknown> = { resolution: 'ACCEPTED_COURIER', note: 'اتفقنا مع الزبون' }) =>
  resolveOne(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'st1', matchId: MID }) });
const many = (body: Record<string, unknown> = { matchIds: [MID], resolution: 'ACCEPTED_COURIER', note: 'اتفقنا مع الزبون' }) =>
  resolveMany(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'st1' }) });

describe('the single answer door', () => {
  beforeEach(() => {
    dworld.statement.matchingClosedAt = null;
    dworld.writes = [];
    dworld.notes = [];
    requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
    requirePermission.mockResolvedValue({});
  });

  it('refuses an applied row in plain Arabic with its own code, and writes nothing: no row, no note, no audit', async () => {
    dworld.match = aDifference({ result: 'MATCHED', appliedAt: new Date('2026-11-09T09:00:00Z'), difference: 0 });
    const res = await one();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ROW_APPLIED', error: ROW_APPLIED_SENTENCE });
    expect(dworld.writes).toEqual([]);
    expect(dworld.notes).toEqual([]);
    expect(logAudit).not.toHaveBeenCalled();
    expect(ddb.$transaction).not.toHaveBeenCalled();
  });

  it('its sentence is spoken Arabic with no English word', () => {
    expect(/[A-Za-z]/.test(ROW_APPLIED_SENTENCE)).toBe(false);
    expect(ROW_APPLIED_SENTENCE).toContain('تسوّى لحظة اعتماد الكشف');
  });

  it('a difference that is NOT applied is answered as it always was — and the write itself says `appliedAt: null`', async () => {
    dworld.match = aDifference();
    const res = await one();
    expect(res.status).toBe(200);
    expect(dworld.writes).toHaveLength(1);
    expect(dworld.writes[0].where).toMatchObject({ id: MID, statementId: 'st1', result: 'MISMATCHED', appliedAt: null, statement: { matchingClosedAt: null } });
  });

  it('a row the approval settled between the read and the write: the write finds it applied and the answer says the line changed', async () => {
    dworld.match = aDifference();
    ddb.settlementMatch.updateMany.mockImplementationOnce(async (a: any) => {
      dworld.writes.push(a);
      return { count: 0 };
    });
    const res = await one();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CHANGED');
    expect(dworld.notes).toEqual([]);
  });

  it('a clean row that is NOT applied still answers “this line is matched — nothing to decide”, as before', async () => {
    dworld.match = aDifference({ result: 'MATCHED', difference: 0 });
    const res = await one();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_A_DIFFERENCE');
  });
});

describe('the bulk answer door', () => {
  beforeEach(() => {
    dworld.statement.matchingClosedAt = null;
    dworld.writes = [];
    dworld.notes = [];
    requireContext.mockResolvedValue({ user: { id: 'u1', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 3 } });
    requirePermission.mockResolvedValue({});
  });

  it('refuses the whole press when ONE row is applied — the sentence, nothing saved', async () => {
    dworld.matches = [aDifference(), aDifference({ id: '22222222-2222-4222-8222-222222222222', result: 'MATCHED', appliedAt: new Date() })];
    const res = await many({ matchIds: [MID, '22222222-2222-4222-8222-222222222222'], resolution: 'UNDER_REVIEW', note: 'نراجع مع الشركة' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ROW_APPLIED', error: ROW_APPLIED_SENTENCE });
    expect(dworld.writes).toEqual([]);
    expect(dworld.notes).toEqual([]);
  });

  it('rows that are not applied are decided as before — and each write says `appliedAt: null`', async () => {
    dworld.matches = [aDifference()];
    const res = await many({ matchIds: [MID], resolution: 'UNDER_REVIEW', note: 'نراجع مع الشركة' });
    expect(res.status).toBe(200);
    expect(dworld.writes).toHaveLength(1);
    expect(dworld.writes[0].where).toMatchObject({ id: MID, result: 'MISMATCHED', appliedAt: null, statement: { matchingClosedAt: null } });
  });
});

/* ───────────────────────────── the hand link and the parcel swap ───────────────────────────── */

import { linkLineToOrder, LinkRefused } from './hand-link';
import { findSwapCandidates, recordParcelSwap } from './parcel-swap';

/** What a database does with `select`: only the columns asked for come back — a door that forgets one does not see it. */
const pickOf = (r: Record<string, any> | null, select?: Record<string, unknown>) =>
  r && select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r;

function tx(over: { match: Record<string, any> | null }) {
  return {
    $queryRaw: vi.fn(async () => []),
    courierStatement: {
      findFirst: vi.fn(async () => ({
        id: 'st1', status: 'APPROVED', approvedAt: new Date(), matchingClosedAt: null, reference: 'ST-1', deliveryProviderId: 'dp1',
        currencyCode: 'JOD', fileHash: 'ab'.repeat(32), periodTo: null, storeId: 's1',
      })),
    },
    settlementMatch: {
      findFirst: vi.fn(async (a?: { select?: Record<string, unknown> }) => pickOf(over.match, a?.select)),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(),
      count: vi.fn(async () => 0),
    },
    order: { findFirst: vi.fn(async () => ({ id: 'o1', orderNumber: 'ORD-1' })), findMany: vi.fn(async () => []) },
  };
}

describe('the hand link', () => {
  it('refuses to tie an applied row (it already has its order): the “tied before” sentence, nothing written', async () => {
    const t = tx({ match: { id: 'm1', result: 'MATCHED', orderId: 'o1', statementLineId: 'l1', appliedAt: new Date(), statementLine: { amount: 20, fee: 5, status: null } } });
    await expect(
      linkLineToOrder(t as never, { companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', orderId: 'o2', userId: 'u1', minorUnit: 3, acceptOtherCourier: false })
    ).rejects.toBeInstanceOf(LinkRefused);
    expect(t.settlementMatch.updateMany).not.toHaveBeenCalled();
  });
});

describe('the parcel swap', () => {
  const swap = (match: Record<string, any>) => ({
    companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', ownerOrderId: 'o2', pieces: 1, minorUnit: 3,
    user: { id: 'u1', name: 'x', role: 'ACCOUNTANT' }, orderPrefix: 'ORD', attempt: 0, ownerBoxBack: false, allowNegativeStock: true, match,
  });

  it('refuses a swap on an applied row with the one sentence, before it locks or reads either order', async () => {
    const t = tx({ match: { id: 'm1', result: 'MATCHED', matchedBy: 'MERCHANT_REF', resolution: null, orderId: 'o1', statementLineId: 'l1', appliedAt: new Date(), statementLine: { amount: 20, fee: 5, status: null } } });
    const out = await recordParcelSwap(t as never, swap({}) as never).catch((e: unknown) => e);
    // The swap answers a refusal as a value (409, ROW_APPLIED) or as a thrown refusal — either way nothing of the swap happened.
    const body = (out as { status?: number; body?: { code: string } }).body ?? (out as { code?: string });
    expect(JSON.stringify(body)).toContain('ROW_APPLIED');
    expect(t.order.findFirst).not.toHaveBeenCalled();
    expect(t.settlementMatch.updateMany).not.toHaveBeenCalled();
  });

  it('the candidates search refuses it too, before it reads the box’s order', async () => {
    const t = tx({ match: { id: 'm1', result: 'MATCHED', orderId: 'o1', matchedBy: 'MERCHANT_REF', resolution: null, appliedAt: new Date() } });
    const out = await findSwapCandidates(t as never, { companyId: 'c1', storeId: 's1', statementId: 'st1', matchId: 'm1', query: 'abc', minorUnit: 3 }).catch((e: unknown) => e);
    expect(JSON.stringify(out)).toContain('ROW_APPLIED');
    expect(t.order.findFirst).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── the sweep: no writer can forget it ───────────────────────────── */

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(f);
  }
  return out;
}

/** The text of every call matching `re`, parentheses balanced, strings skipped. */
function callsOf(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    let end = open;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { end = i; break; }
    }
    out.push(src.slice(open, end + 1));
  }
  return out;
}

describe('every write to a match row says `appliedAt: null` in its own call', () => {
  const EDIT = /\bsettlementMatch\.(update|updateMany|delete|deleteMany|upsert)\(/g;
  const found = files(join(process.cwd(), 'src'))
    .map((p) => ({ p: p.slice(process.cwd().length + 1).split('\\').join('/'), src: stripComments(readFileSync(p, 'utf8')) }))
    .map((f) => ({ ...f, calls: callsOf(f.src, new RegExp(EDIT.source, 'g')) }))
    .filter((f) => f.calls.length > 0);

  it('finds the writers at all (a sweep over nothing passes everything inside it)', () => {
    expect(found.map((f) => f.p).sort()).toEqual([
      'src/app/api/finance/statements/[id]/decisions/route.ts',
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
      'src/lib/hand-link.ts',
      'src/lib/parcel-swap.ts',
      'src/lib/settlement.ts',
      'src/lib/statement-close.ts',
    ]);
  });

  it.each(['decisions/route.ts', 'resolve/route.ts', 'hand-link.ts', 'parcel-swap.ts', 'settlement.ts', 'statement-close.ts'])(
    '%s — each edit or delete carries the condition',
    (name) => {
      const file = found.find((f) => f.p.endsWith(name))!;
      for (const call of file.calls) expect(call, `${file.p}: ${call.slice(0, 160)}`).toMatch(/appliedAt: null/);
    }
  );

  it('the counts: 1 · 1 · 2 · 2 · 1 · 1 — a new writer is a decision, not a diff', () => {
    const counts = Object.fromEntries(found.map((f) => [f.p.split('/').slice(-2).join('/'), f.calls.length]));
    expect(counts).toEqual({
      'decisions/route.ts': 1,
      'resolve/route.ts': 1,
      'lib/hand-link.ts': 2,
      'lib/parcel-swap.ts': 2,
      'lib/settlement.ts': 1,
      'lib/statement-close.ts': 1,
    });
  });
});
