import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE EARLY STEP HAS A CLOCK — «حارس الوقت» for «تسوية السطور النظيفة عند الاعتماد» (the money reviewer's RV1830 and RV1834 on #237).
 *
 * The approval and the press «سوّي الطلبات النظيفة هلّق» are each ONE database transaction with a hard timeout. When it runs out EVERY
 * later query of the transaction throws (a `ROLLBACK TO SAVEPOINT` included), so the savepoint of the first version could not save it: the
 * whole approval, the money with it, was rolled back. These tests run the REAL routes and the REAL engine (`settleStatement`,
 * `settleCleanLines`, the stock helper, the commission promotion) against one strict world that has what the earlier worlds did not:
 *
 *   · a SIMULATED CLOCK: every query costs `latencyMs` of it, `Date.now()` follows it, and a lock the step must wait for costs what it costs;
 *   · a TRANSACTION THAT EXPIRES like Prisma's: past its `timeout` the next query — `ROLLBACK TO SAVEPOINT` included — throws P2028, and so
 *     does the commit; a transaction with no `timeout` has Prisma's default, five seconds;
 *   · the database's LOCK TIMEOUT as a transaction-scoped setting with Postgres's own rules (set after a savepoint it is undone by a
 *     rollback to it and kept by its release; gone with the transaction);
 *   · a filter or a column the world was not taught is an ERROR, never a silent "match everything" (the reviewer's lesson: a fixture that
 *     cannot fail proves nothing — see the CONTROL test, which runs the first version of the step in this same world and watches it die).
 * ═══════════════════════════════════════════════════════════════════════
 */

type Any = Record<string, any>;

const H = vi.hoisted(() => {
  const BASE = Date.parse('2026-11-10T08:00:00Z');
  const fresh = () => ({
    statements: new Map<string, Any>(),
    rows: [] as Any[],
    receipts: new Map<string, Any[]>(),
    orders: new Map<string, Any>(),
    customers: new Map<string, Any>(),
    commission: new Map<string, string>(),
    activities: [] as Any[],
    movements: [] as Any[],
    invMovements: [] as Any[],
    batches: [] as Any[],
    penalties: [] as Any[],
    door: new Map<string, string>(),
    audits: [] as Any[],
    savepoints: [] as { name: string; snap: Any }[],
    /** Every query, in order: its number, what it was, whether it wrote, its arguments, and the simulated moment it ran. */
    calls: [] as Any[],
    /** Every raw statement, in order: the text with `?` for each value, and the values. */
    sql: [] as { kind: 'exec' | 'query'; text: string; values: unknown[] }[],
    queries: 0,
    switchOn: true,
    minorUnit: 2,
    /** The database's lock timeout: what a transaction sees now, and what a transaction begins with. */
    guc: { lock_timeout: '0' } as Any,
    gucSession: { lock_timeout: '0' } as Any,
    /** What `current_setting` answers when it should answer nothing. */
    settingUnreadable: false,
    /** The value in force when the last transaction asked to commit. */
    gucAtCommit: null as Any | null,
    // ── the clock ──
    clock: 0,
    latencyMs: 0,
    /** orderId → milliseconds its claim waits for a lock another transaction holds (once). */
    lockWaits: new Map<string, number>(),
    txStart: 0,
    txTimeout: 0,
    txDead: false,
    timeouts: 0,
    /** The simulated length of every transaction that ended, in ms, commit included. */
    txMs: [] as number[],
    failAt: null as number | null,
    /** Called with the order id just before its claim (a concurrent door). */
    beforeClaim: null as null | ((orderId: string) => void),
    /** Run the first version of the step (one savepoint around everything) instead of the new one. */
    reference: false,
    /** Called when a transaction asks to commit, before the commit. */
    onCommit: null as null | (() => void),
    /** Extra simulated milliseconds a query costs (a slow wallet write, a long wait for the statement's lock…). */
    extraCost: null as null | ((op: string, args: unknown) => number),
  });
  const world = fresh();
  const resetWorld = () => Object.assign(world, fresh());

  const p2028 = (what: string) =>
    Object.assign(new Error(`Transaction API error: Transaction already closed: ${what} (P2028)`), { code: 'P2028' });
  const setNow = () => vi.setSystemTime(BASE + world.clock);
  /** Time passes inside the transaction; past its timeout the transaction is dead, and this query with it. */
  const advance = (ms: number) => {
    world.clock += ms;
    if (ms !== 0) setNow();
    if (world.txTimeout > 0 && world.clock - world.txStart > world.txTimeout) {
      world.txDead = true;
      world.timeouts++;
      throw p2028('timeout');
    }
  };

  const rec = (op: string, write: boolean, args: unknown) => {
    if (world.txDead) throw p2028('expired');
    world.queries++;
    // fault injection: the database refuses exactly this query (a deadlock, a constraint, a lost connection…)
    if (world.failAt != null && world.queries === world.failAt) {
      world.failAt = null;
      throw Object.assign(new Error('injected database error'), { code: 'P2034' });
    }
    advance(world.latencyMs + (world.extraCost ? world.extraCost(op, args) : 0));
    world.calls.push({ n: world.queries, op, write, args: structuredClone(args), at: world.clock, guc: world.guc.lock_timeout });
  };

  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const lockMs = (v: string) => {
    const m = /^(\d+(?:\.\d+)?)(ms|s|min)?$/.exec(v);
    if (!m) throw new Error('world: a lock timeout the world does not read: ' + v);
    return Number(m[1]) * (m[2] === 'min' ? 60_000 : m[2] === 's' ? 1000 : 1);
  };

  // ───────────────────────────── filters (strict) ─────────────────────────────
  const OPEN_REQ = { intent: { in: ['CANCEL', 'POSTPONE'] }, OR: [{ status: 'PENDING' }, { status: 'APPROVED', appliedAt: null }] };
  const orderMatches = (o: Any, w: Any): boolean => {
    for (const [key, val] of Object.entries(w)) {
      if (key === 'companyId' || key === 'storeId') continue;
      if (key === 'id') { if (typeof val === 'string') { if (o.id !== val) return false; } else if (!(val as Any).in.includes(o.id)) return false; continue; }
      if (key === 'settlementStatus') {
        const v = val as Any;
        if (Object.keys(v).join() !== 'not') throw new Error('world: unknown settlementStatus filter ' + JSON.stringify(v));
        if (o.settlementStatus === v.not) return false; continue;
      }
      if (key === 'shippingStatus') { if (!(val as Any).in.includes(o.shippingStatus)) return false; continue; }
      if (key === 'collectedAmount') { if (val !== null) throw new Error('world: collectedAmount filter'); if (o.collectedAmount !== null) return false; continue; }
      if (key === 'changeRequests') {
        const v = val as Any;
        if (!sameJson(v, { none: OPEN_REQ })) throw new Error('world: the open-request filter is not the one the repository defines: ' + JSON.stringify(v));
        if (o.openRequest) return false; continue;
      }
      if (key === 'OR') { if (!(val as Any[]).some((alt) => orderMatches(o, alt))) return false; continue; }
      if (key === 'NOT') { if (orderMatches(o, val as Any)) return false; continue; }
      throw new Error('world: unknown order filter ' + key);
    }
    return true;
  };
  const rowMatches = (r: Any, w: Any): boolean => {
    for (const [key, val] of Object.entries(w)) {
      if (key === 'companyId') continue;
      if (key === 'id') { if (r.id !== val) return false; continue; }
      if (key === 'statementId') { if (r.statementId !== val) return false; continue; }
      if (key === 'result') { if (r.result !== val) return false; continue; }
      if (key === 'resolution') { if (val !== null) throw new Error('world: resolution filter'); if (r.resolution) return false; continue; }
      if (key === 'appliedAt') { if (val !== null) throw new Error('world: appliedAt filter value'); if (r.appliedAt) return false; continue; }
      if (key === 'orderId') {
        if (typeof val === 'string') { if (r.orderId !== val) return false; }
        else { const v = val as Any; if (!v.in) throw new Error('world: orderId filter'); if (!r.orderId || !v.in.includes(r.orderId)) return false; }
        continue;
      }
      if (key === 'statement') {
        const v = val as Any;
        if (!sameJson(v, { matchingClosedAt: null })) throw new Error('world: unknown statement relation filter ' + JSON.stringify(v));
        if (world.statements.get(r.statementId)!.matchingClosedAt) return false; continue;
      }
      throw new Error('world: unknown match-row filter ' + key);
    }
    return true;
  };

  // ───────────────────────────── select (a database returns only the columns asked for) ─────────────────────────────
  const earlierClaims = (orderId: string, statementId: string, whereSpec: Any) => {
    const expected = { resolution: 'OURS_STANDS', statementId: { not: statementId }, statement: { matchingClosedAt: { not: null } } };
    if (!sameJson(whereSpec, expected)) throw new Error('world: the earlier-claims relation filter changed: ' + JSON.stringify(whereSpec));
    return world.rows
      .filter((x) => x.orderId === orderId && x.resolution === 'OURS_STANDS' && x.statementId !== statementId && world.statements.get(x.statementId)!.matchingClosedAt)
      .map((x) => ({ statementAmount: x.statementAmount, statementFee: x.statementFee }));
  };
  const pickRow = (r: Any, select?: Any): Any => {
    if (!select) return { ...r };
    const out: Any = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (k === 'order') {
        const o = r.orderId ? world.orders.get(r.orderId) : null;
        if (!o) { out.order = null; continue; }
        const sel = (v as Any).select as Any;
        const ord: Any = {};
        for (const [ok, ov] of Object.entries(sel)) {
          if (!ov) continue;
          if (ok === 'settlementMatches') {
            const rel = ov as Any;
            const rows = earlierClaims(o.id, r.statementId, rel.where);
            ord.settlementMatches = rows.map((x) => { const q: Any = {}; for (const sk of Object.keys(rel.select)) q[sk] = (x as Any)[sk]; return q; });
          } else ord[ok] = o[ok];
        }
        out.order = ord;
      } else {
        if (!(k in r)) throw new Error('world: the match row has no column ' + k);
        out[k] = r[k];
      }
    }
    return out;
  };
  const pickFlat = (r: Any, select?: Any): Any => {
    if (!select) return { ...r };
    const out: Any = {};
    for (const [k, v] of Object.entries(select)) { if (!v) continue; if (typeof v === 'object') throw new Error('world: relation select ' + k); out[k] = r[k]; }
    return out;
  };

  // ───────────────────────────── snapshot / restore (rollback and savepoints) ─────────────────────────────
  const KEYS = ['statements', 'rows', 'receipts', 'orders', 'customers', 'commission', 'activities', 'movements', 'invMovements', 'batches', 'penalties', 'guc'] as const;
  const snapshot = () => structuredClone(Object.fromEntries(KEYS.map((k) => [k, (world as Any)[k]])));
  const restore = (s: Any) => { for (const k of KEYS) (world as Any)[k] = s[k]; };

  const statementRead = (a: Any) => {
    const id = typeof a.where.id === 'string' ? a.where.id : null;
    if (!id) throw new Error('world: statement lookup needs an id');
    const st = world.statements.get(id);
    if (!st) return null;
    const sel = a.include ?? a.select;
    const out: Any = {};
    for (const k of ['id', 'reference', 'currencyCode', 'createdAt', 'periodTo', 'status', 'approvedAt', 'matchingClosedAt', 'fileHash', 'gapExplanation']) out[k] = st[k];
    if (sel.receipts) out.receipts = (world.receipts.get(st.id) ?? []).map((x) => ({ ...x }));
    if (sel.matches) {
      const mSel = sel.matches.select;
      out.matches = world.rows.filter((r) => r.statementId === st.id).map((r) => pickRow(r, mSel));
    }
    return out;
  };

  const db: Any = {
    company: { findUnique: async (a: Any) => { rec('company.findUnique', false, a); return { settings: JSON.stringify(world.switchOn ? { perLineSettlement: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' } } : {}) }; } },
    courierStatement: {
      findFirst: async (a: Any) => { rec('courierStatement.findFirst', false, a); return statementRead(a); },
      updateMany: async (a: Any) => {
        rec('courierStatement.updateMany', true, a);
        const w = a.where as Any;
        const st = world.statements.get(w.id);
        if (!st) return { count: 0 };
        for (const [k, v] of Object.entries(w)) {
          if (k === 'id' || k === 'companyId' || k === 'storeId') continue;
          if (k === 'approvedAt') {
            if (v === null) { if (st.approvedAt) return { count: 0 }; }
            else if ((v as Any).not === null) { if (!st.approvedAt) return { count: 0 }; }
            else throw new Error('world: approvedAt filter');
            continue;
          }
          if (k === 'matchingClosedAt') { if (v === null && st.matchingClosedAt) return { count: 0 }; if (v !== null) throw new Error('world: matchingClosedAt filter'); continue; }
          if (k === 'status') { if ((v as Any).not !== undefined && st.status === (v as Any).not) return { count: 0 }; continue; }
          throw new Error('world: unknown statement filter ' + k);
        }
        for (const [k, v] of Object.entries(a.data as Any)) {
          if (!['status', 'approvedById', 'approvedAt', 'gapExplanation', 'matchingClosedAt', 'matchingClosedById'].includes(k)) throw new Error('world: unknown statement data ' + k);
          st[k] = v;
        }
        return { count: 1 };
      },
    },
    settlementMatch: {
      findMany: async (a: Any) => {
        rec('settlementMatch.findMany', false, a);
        const keys = Object.keys(a.where);
        if (keys.some((k) => !['statementId', 'companyId'].includes(k))) throw new Error('world: unknown findMany filter ' + keys.join());
        return world.rows.filter((r) => r.statementId === a.where.statementId).map((r) => pickRow(r, a.select));
      },
      updateMany: async (a: Any) => {
        rec('settlementMatch.updateMany', true, a);
        const hit = world.rows.filter((r) => rowMatches(r, a.where));
        for (const k of Object.keys(a.data)) if (!['appliedAt', 'resolution', 'resolutionNote', 'resolvedById', 'resolvedAt'].includes(k)) throw new Error('world: unknown row data ' + k);
        for (const r of hit) Object.assign(r, a.data);
        return { count: hit.length };
      },
    },
    walletMovement: {
      findMany: async (a: Any) => { rec('walletMovement.findMany', false, a); return []; },
      count: async (a: Any) => {
        rec('walletMovement.count', false, a);
        const w = a.where as Any;
        return world.movements.filter((m) => m.referenceId === w.referenceId && (w.statementReceiptId === null ? m.statementReceiptId === null : m.statementReceiptId !== null)).length;
      },
    },
    user: { findMany: async (a: Any) => { rec('user.findMany', false, a); return [{ id: 'u-door', name: 'سارة', role: 'FOLLOW_UP_AGENT' }].filter((u) => !a.where.id?.in || a.where.id.in.includes(u.id)); } },
    deliveryAttempt: {
      findMany: async (a: Any) => { rec('deliveryAttempt.findMany', false, a); return a.where.orderId.in.filter((id: string) => world.door.has(id)).map((orderId: string) => ({ orderId, deliveryAgentId: world.door.get(orderId) })); },
    },
    penalty: {
      findMany: async (a: Any) => { rec('penalty.findMany', false, a); return world.penalties.filter((p) => a.where.settlementMatchId.in.includes(p.settlementMatchId) && a.where.status.in.includes(p.status)).map((p) => ({ settlementMatchId: p.settlementMatchId })); },
      create: async (a: Any) => { rec('penalty.create', true, a); const row = { id: `pen-${world.penalties.length + 1}`, ...a.data }; world.penalties.push(row); return { id: row.id }; },
    },
    order: {
      updateMany: async (a: Any) => {
        rec('order.updateMany', true, a);
        // a lock another transaction holds on an order this claim names: the claim waits for it, or gives up when the lock timeout says so
        for (const id of a.where.id?.in ?? []) {
          const wait = world.lockWaits.get(id);
          if (wait == null) continue;
          world.lockWaits.delete(id);
          const limit = lockMs(world.guc.lock_timeout);
          if (limit > 0 && wait > limit) {
            advance(limit);
            throw Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010' });
          }
          advance(wait);
        }
        if (world.beforeClaim) for (const id of a.where.id?.in ?? []) world.beforeClaim(id);
        const keys = Object.keys(a.data);
        if (keys.join() !== 'settlementStatus') throw new Error('world: unknown order updateMany data ' + keys.join());
        const hit = [...world.orders.values()].filter((o) => orderMatches(o, a.where));
        for (const o of hit) o.settlementStatus = a.data.settlementStatus;
        return { count: hit.length };
      },
      findMany: async (a: Any) => { rec('order.findMany', false, a); return [...world.orders.values()].filter((o) => orderMatches(o, a.where)).map((o) => pickFlat(o, a.select)); },
      findFirst: async (a: Any) => {
        rec('order.findFirst', false, a);
        const o = [...world.orders.values()].find((x) => orderMatches(x, a.where));
        if (!o) return null;
        return { orderNumber: o.orderNumber, storeId: o.storeId, source: o.source ?? null, items: o.items.map((i: Any) => ({ ...i })), addOns: [], store: { country: { minorUnit: world.minorUnit } } };
      },
      update: async (a: Any) => {
        rec('order.update', true, a);
        const o = world.orders.get(a.where.id);
        if (!o) throw new Error('world: update of a missing order');
        for (const [k, v] of Object.entries(a.data as Any)) {
          if (k === 'version') { o.version += (v as Any).increment; }
          else if (['shippingStatus', 'deliveredAt', 'collectedAmount', 'estimatedCostOfGoods'].includes(k)) o[k] = v;
          else throw new Error('world: unknown order data ' + k);
        }
        return o;
      },
    },
    orderActivity: {
      create: async (a: Any) => { rec('orderActivity.create', true, a); world.activities.push({ orderId: a.data.orderId, action: a.data.action, userId: a.data.userId ?? null, metadata: a.data.metadata ?? null }); return {}; },
      findFirst: async (a: Any) => { rec('orderActivity.findFirst', false, a); return world.activities.find((x) => x.orderId === a.where.orderId && x.action === a.where.action) ? { id: 'x' } : null; },
    },
    customer: {
      update: async (a: Any) => {
        rec('customer.update', true, a);
        const c = world.customers.get(a.where.id) ?? { deliveredOrders: 0, totalPurchaseValue: 0 };
        c.deliveredOrders += a.data.deliveredOrders?.increment ?? 0;
        c.totalPurchaseValue += a.data.totalPurchaseValue?.increment ?? 0;
        world.customers.set(a.where.id, c);
        return c;
      },
    },
    commissionEntry: {
      updateMany: async (a: Any) => {
        rec('commissionEntry.updateMany', true, a);
        let n = 0;
        for (const id of a.where.orderId.in) if (world.commission.get(id) === 'ACCRUED') { world.commission.set(id, 'PAYABLE'); n++; }
        return { count: n };
      },
    },
    orderChangeRequest: { findMany: async (a: Any) => { rec('orderChangeRequest.findMany', false, a); return []; } },
    inventoryMovement: {
      findFirst: async (a: Any) => { rec('inventoryMovement.findFirst', false, a); return world.invMovements.find((m) => m.referenceId === a.where.referenceId && m.type === a.where.type) ? { id: 'x' } : null; },
      create: async (a: Any) => { rec('inventoryMovement.create', true, a); world.invMovements.push({ ...a.data }); return {}; },
    },
    productFixedCost: { findMany: async (a: Any) => { rec('productFixedCost.findMany', false, a); return (a.where.productId.in as string[]).filter((p) => p === 'P-FIXED').map((productId) => ({ productId, amount: 3 })); } },
    productionBatch: {
      findMany: async (a: Any) => {
        rec('productionBatch.findMany', false, a);
        const w = a.where;
        return world.batches
          .filter((b) => b.productId === w.productId && b.quantityRemaining > 0 && (!w.storeId || b.storeId === w.storeId))
          .sort((x, y) => x.productionDate - y.productionDate || x.createdAt - y.createdAt)
          .map((b) => pickFlat(b, a.select));
      },
      update: async (a: Any) => { rec('productionBatch.update', true, a); const b = world.batches.find((x) => x.id === a.where.id)!; Object.assign(b, a.data); return b; },
      aggregate: async (a: Any) => { rec('productionBatch.aggregate', false, a); return { _sum: { quantityRemaining: world.batches.filter((b) => b.productId === a.where.productId).reduce((s, b) => s + b.quantityRemaining, 0) } }; },
    },
    orderItem: { updateMany: async (a: Any) => { rec('orderItem.updateMany', true, a); return { count: 0 }; } },
    orderAddOn: { updateMany: async (a: Any) => { rec('orderAddOn.updateMany', true, a); return { count: 0 }; } },
    /** Raw reads: the statement lock, and the two questions the step asks about the lock timeout. Any other text is an error. */
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      rec('$queryRaw', false, text);
      world.sql.push({ kind: 'query', text, values });
      if (text === `SELECT current_setting('lock_timeout') AS "value"`) return world.settingUnreadable ? [] : [{ value: world.guc.lock_timeout }];
      if (text === `SELECT set_config('lock_timeout', ?, true)`) {
        if (typeof values[0] !== 'string') throw new Error('world: set_config needs a text value');
        world.guc.lock_timeout = values[0];
        return [{ set_config: values[0] }];
      }
      if (text === 'SELECT "id" FROM "courier_statements" WHERE "id" = ? FOR UPDATE') return [];
      throw new Error('world: unknown raw query: ' + text);
    },
    /** SAVEPOINT / RELEASE / ROLLBACK TO — what Postgres does, over the world's own snapshot (the lock timeout included). */
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').trim();
      rec('$executeRaw', true, sql);
      world.sql.push({ kind: 'exec', text: sql, values });
      const name = sql.split(/\s+/).at(-1)!;
      if (sql.startsWith('SAVEPOINT ')) world.savepoints.push({ name, snap: snapshot() });
      else if (sql.startsWith('RELEASE SAVEPOINT ')) {
        const at = world.savepoints.map((s) => s.name).lastIndexOf(name);
        if (at < 0) throw new Error('no such savepoint ' + name);
        world.savepoints.splice(at);
      } else if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        const at = world.savepoints.map((s) => s.name).lastIndexOf(name);
        if (at < 0) throw new Error('no such savepoint ' + name);
        restore(structuredClone(world.savepoints[at].snap));
        world.savepoints.splice(at + 1);
      } else throw new Error('world: unknown statement ' + sql);
      return 0;
    },
    $transaction: async (fn: (tx: unknown) => unknown, opts?: Any) => {
      const before = snapshot();
      world.savepoints = [];
      world.txStart = world.clock;
      // Prisma's interactive transaction lasts five seconds unless the door asks for more
      world.txTimeout = opts?.timeout ?? 5000;
      world.txDead = false;
      world.guc = { ...world.gucSession };
      try {
        const out = await fn(db);
        world.gucAtCommit = { ...world.guc };
        if (world.onCommit) world.onCommit();
        // The commit is a round trip too, and an expired transaction cannot be committed.
        if (world.txDead) throw p2028('expired at commit');
        advance(world.latencyMs);
        world.txMs.push(world.clock - world.txStart);
        return out;
      } catch (e) {
        world.txMs.push(world.clock - world.txStart);
        restore(before);
        world.calls.push({ n: -1, op: 'ROLLBACK', write: true, args: String((e as Error).message ?? e).slice(0, 80), at: world.clock });
        throw e;
      } finally {
        world.savepoints = [];
        world.txTimeout = 0;
        world.txDead = false;
        world.guc = { ...world.gucSession };
      }
    },
  };

  const mocks = {
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(async (a: Any) => { world.audits.push({ action: a.action, newData: structuredClone(a.newData) }); }),
    notify: vi.fn(),
    recordMovement: vi.fn(async (_tx: unknown, a: Any) => {
      if (a.statementReceiptId && world.movements.some((m) => m.statementReceiptId === a.statementReceiptId)) throw new Error('unique violation: wallet_movements_statementReceiptId_key');
      rec('wallet.read', false, { walletId: a.walletId });
      rec('walletMovement.create', true, a);
      world.movements.push({ referenceId: a.referenceId, statementReceiptId: a.statementReceiptId ?? null, amount: a.amount, walletId: a.walletId, direction: a.direction });
      return { id: `mv-${world.movements.length}` };
    }),
    receiptGap: vi.fn(async () => ({ claimed: 0, received: 0, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 })),
  };
  return { world, resetWorld, db, mocks, BASE };
});
const { world, resetWorld, mocks } = H;

vi.mock('@/lib/db', () => ({ db: H.db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => H.mocks.requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => H.mocks.requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => H.mocks.logAudit(...(a as [Any])) }));
vi.mock('@/lib/notify', () => ({ notify: (...a: unknown[]) => H.mocks.notify(...a) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => H.mocks.receiptGap(...(a as [])),
  runMatching: async () => ({ matched: 0 }),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => H.mocks.recordMovement(...(a as [unknown, Any])),
}));
/**
 * THE FIRST VERSION OF THE STEP, kept here as the yardstick: what stood on main before this change — ONE savepoint around the whole step,
 * no clock, no slices — copied from it, line for line (only the imports are the real module's). The world runs it in place of the new step
 * when `world.reference` is set: for the differential (a fast clock must make no difference below a slice) and for the CONTROL (the same
 * world must be able to watch it die, or it proves nothing).
 */
vi.mock('@/lib/statement-close', async (orig) => {
  const real = await orig<typeof import('@/lib/statement-close')>();
  const step237 = async (tx: Any, p: Any) => {
    const waiting = real.cleanPendingRows(p.matches);
    if (waiting.length === 0) return { ran: false, settled: 0, delivered: 0, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] };
    const clean = waiting.slice(0, real.EARLY_STEP_CAP);
    const remaining = waiting.length - clean.length;
    await tx.$executeRaw`SAVEPOINT per_line_settlement`;
    try {
      const result = await real.settleStatement(tx as never, { ...p, matches: clean, early: { at: p.at ?? new Date() } } as never);
      const why = new Map<string, string>();
      if (result.heldBack.length > 0) {
        const left = await tx.order.findMany({
          where: { id: { in: result.heldBack }, companyId: p.companyId, storeId: p.storeId },
          select: { id: true, settlementStatus: true },
        });
        for (const o of Array.isArray(left) ? left : []) {
          why.set(o.id, o.settlementStatus === 'SETTLED' ? real.HELD_BACK_WHY.settled : real.HELD_BACK_WHY.openRequest);
        }
      }
      const left = new Set(result.heldBack);
      const rows = clean.map((m: Any) => ({
        matchId: m.id,
        orderId: m.orderId as string,
        orderNumber: m.order?.orderNumber ?? (m.orderId as string),
        outcome: left.has(m.orderId as string) ? 'HELD_BACK' : 'SETTLED',
        why: left.has(m.orderId as string) ? why.get(m.orderId as string) ?? real.HELD_BACK_WHY.changed : null,
      }));
      await tx.$executeRaw`RELEASE SAVEPOINT per_line_settlement`;
      return { ran: true, settled: result.settledCount, delivered: result.deliveredCount, heldBack: result.heldBack.length, remaining, failed: false, failure: null, rows };
    } catch (e) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT per_line_settlement`;
      const name = e instanceof Error ? e.name : 'Error';
      return { ran: true, settled: 0, delivered: 0, heldBack: 0, remaining: waiting.length, failed: true, failure: name, rows: [] };
    }
  };
  return { ...real, settleCleanLines: (tx: Any, p: Any) => (H.world.reference ? step237(tx, p) : real.settleCleanLines(tx as never, p as never)) };
});

import { PATCH } from './[id]/route';
import { POST as CLOSE } from './[id]/close/route';
import { POST as PRESS } from './[id]/settle-clean/route';
import { forgetPerLineSwitch } from '@/lib/per-line-settlement-switch';
import {
  EARLY_STEP_BUDGET_MS, EARLY_STEP_CAP, EARLY_STEP_LOCK_WAIT, EARLY_STEP_SLICE,
  closeRowsSelect, earlyAnswer, settleCleanLines,
} from '@/lib/statement-close';
import { earlyMessage, pressMessage } from '@/lib/per-line-settlement-words';

/**
 * THE TIMEOUT OF THE TRANSACTIONS THAT CARRY THE STEP — the number both doors write (`{ timeout: 30_000 }`). It is a constant of this file, not of
 * the code: an older guard reads that literal in the approval as an anchor, so the doors keep writing it, and the last section reads it from
 * their source and holds it to this one. The budget (10 s) is a share of exactly this.
 */
const STATEMENT_TX_TIMEOUT_MS = 30_000;

/* ───────────────────────────── scenarios ───────────────────────────── */

const ord = (id: string, items = 1, ship = 'SHIPPED', over: Any = {}): Any => ({
  id, orderNumber: `ORD-${id}`, companyId: 'c1', storeId: 's1', shippingStatus: ship, settlementStatus: 'PENDING_COLLECTION', openRequest: false,
  collectedAmount: null, customerId: `cu-${id}`, deliveredAt: ship === 'DELIVERED' ? new Date('2026-10-18T09:00:00Z') : null,
  moderatorId: 'u-mod', confirmedById: 'u-conf', version: 1, estimatedCostOfGoods: 50, source: null,
  items: Array.from({ length: items }, (_, j) => ({ productId: j % 2 === 0 ? 'P1' : 'P2', productName: 'p', quantity: 1, freeQuantity: 0, reservedQty: 1 })),
  ...over,
});
const mrow = (id: string, orderId: string | null, over: Any = {}): Any => ({
  id, statementId: 'st1', orderId, result: 'MATCHED', resolution: null, resolutionNote: null, resolvedById: null, appliedAt: null, matchedBy: 'MERCHANT_REF',
  expectedAmount: 20, expectedFee: 5, statementAmount: 20, statementFee: 5, ...over,
});
/** A difference nobody answered — the line that holds the matching open. */
const question = (id: string, orderId: string) => mrow(id, orderId, { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 24 });
const PARK = { resolution: 'UNDER_REVIEW', resolutionNote: 'نراجع مع الشركة', resolvedById: 'u-decider' };

function load(orders: Any[], rows: Any[]) {
  for (const o of orders) { world.orders.set(o.id, o); world.commission.set(o.id, 'ACCRUED'); }
  world.statements.set('st1', {
    id: 'st1', reference: 'ST-BIG', currencyCode: 'SYP', createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z'),
    status: 'MATCHED', approvedAt: null, matchingClosedAt: null, fileHash: 'ab'.repeat(32), gapExplanation: null,
  });
  world.rows = rows;
  world.receipts.set('st1', [{ id: 'r1', walletId: 'w1', amount: 900 }]);
  world.batches = [
    { id: 'bP1', productId: 'P1', storeId: 's1', quantityRemaining: 1_000_000, quantitySold: 0, costPerUnit: 3, productionDate: 1, createdAt: 1 },
    { id: 'bP2', productId: 'P2', storeId: 's1', quantityRemaining: 1_000_000, quantitySold: 0, costPerUnit: 5, productionDate: 1, createdAt: 2 },
  ];
}
/** `n` clean lines on parcels still on the road (the item lines of their orders cycle 1, 2, 3 — or are fixed) and one line nobody answered. */
function bigStatement(n: number, itemsOf: (i: number) => number = (i) => 1 + (i % 3), open = true) {
  const orders: Any[] = [];
  const rows: Any[] = [];
  for (let i = 0; i < n; i++) {
    orders.push(ord(`o${i}`, itemsOf(i)));
    rows.push(mrow(`m${i}`, `o${i}`));
  }
  if (open) { orders.push(ord('oQ', 1)); rows.push(question('mQ', 'oQ')); }
  load(orders, rows);
}

const sendReq = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = () => ({ params: Promise.resolve({ id: 'st1' }) });
const approve = async () => { const res = await PATCH(sendReq('PATCH', { approve: true }), params()); return { res, body: (await res.clone().json().catch(() => ({}))) as Any }; };
const press = async () => { const res = await PRESS(sendReq('POST'), params()); return { res, body: (await res.clone().json().catch(() => ({}))) as Any }; };
const close = async () => { const res = await CLOSE(sendReq('POST', {}), params()); return { res, body: (await res.clone().json().catch(() => ({}))) as Any }; };
const park = () => { for (const r of world.rows) if (r.result === 'MISMATCHED' && !r.resolution) Object.assign(r, PARK); };

const marked = () => world.rows.filter((r) => r.appliedAt).map((r) => r.id);
const settledIds = () => [...world.orders.values()].filter((o) => o.settlementStatus === 'SETTLED').map((o) => o.id);
const sqlText = () => world.sql.map((s) => s.text);
const savepointSql = () => sqlText().filter((t) => /SAVEPOINT/.test(t));
const lockSql = () => world.sql.filter((s) => /lock_timeout/.test(s.text));
const audit = (action: string) => world.audits.filter((a) => a.action === action);
const stockOut = () => world.invMovements.map((m) => m.referenceId);

/** The state a statement leaves behind once its matching is closed — without the moments and the marks, which are allowed to differ. */
const rnd = (n: number | null | undefined) => (n == null ? null : Number(Number(n).toFixed(6)));
function finalState() {
  return {
    orders: [...world.orders.values()].map((o) => ({ id: o.id, ship: o.shippingStatus, settle: o.settlementStatus, collected: rnd(o.collectedAmount), at: o.deliveredAt?.toISOString() ?? null, version: o.version, cost: rnd(o.estimatedCostOfGoods) })).sort((a, b) => a.id.localeCompare(b.id)),
    customers: [...world.customers.entries()].map(([k, v]) => [k, v.deliveredOrders, rnd(v.totalPurchaseValue)] as const).sort((a, b) => a[0].localeCompare(b[0])),
    commission: [...world.commission.entries()].sort(([a], [b]) => a.localeCompare(b)),
    stock: world.invMovements.map((m) => `${m.referenceId}|${m.productId}|${m.quantity}|${m.balanceAfter}`).sort(),
    batches: world.batches.map((b) => `${b.id}|${b.quantityRemaining}|${b.quantitySold}`).sort(),
    wallet: world.movements.map((m) => `${m.referenceId}|${m.statementReceiptId}|${m.amount}|${m.walletId}|${m.direction}`).sort(),
    story: world.activities.map((a) => `${a.orderId}|${a.action}|${a.metadata}`).sort(),
    rows: world.rows.map((r) => ({ id: r.id, result: r.result, resolution: r.resolution })),
    stamps: [...world.statements.values()].map((s) => ({ id: s.id, approved: !!s.approvedAt, closed: !!s.matchingClosedAt })),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(H.BASE);
  vi.clearAllMocks();
  resetWorld();
  forgetPerLineSwitch();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.requireContext.mockResolvedValue({ user: { id: 'u-approver', name: 'المحاسب' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2, currencyCode: 'USD' } });
  mocks.requirePermission.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
});


/* ───────────────────────────── helpers for the engine called directly ───────────────────────────── */

const rowsOfStatement = () => H.db.settlementMatch.findMany({ where: { statementId: 'st1', companyId: 'c1' }, select: closeRowsSelect('st1') });
async function stepInput(extra: Any = {}) {
  return {
    companyId: 'c1', storeId: 's1', userId: 'u-approver', minorUnit: 2, at: new Date('2026-11-10T08:00:00Z'),
    statement: { id: 'st1', reference: 'ST-BIG', currencyCode: 'SYP', createdAt: new Date('2026-10-20T10:00:00Z'), periodTo: new Date('2026-10-20T00:00:00Z') },
    matches: await rowsOfStatement(),
    ...extra,
  };
}
const runStep = async (extra: Any = {}) => settleCleanLines(H.db as never, (await stepInput(extra)) as never);
/** A clock that answers the given readings in turn, and the last one for ever. */
const clockOf = (...reads: number[]) => {
  let i = 0;
  return () => reads[Math.min(i++, reads.length - 1)];
};
/** The slices that ran, each from its SAVEPOINT to its RELEASE (or ROLLBACK TO), as the numbers of the queries. */
function slicesRun() {
  const out: { from: number; to: number; ended: 'RELEASE' | 'ROLLBACK' }[] = [];
  let open: number | null = null;
  for (const c of world.calls) {
    if (c.op !== '$executeRaw') continue;
    if (c.args.startsWith('SAVEPOINT ')) open = c.n;
    else if (c.args.startsWith('RELEASE ') || c.args.startsWith('ROLLBACK TO ')) {
      out.push({ from: open as number, to: c.n, ended: c.args.startsWith('RELEASE') ? 'RELEASE' : 'ROLLBACK' });
      open = null;
    }
  }
  return out;
}
const callsBetween = (a: number, b: number) => world.calls.filter((c) => c.n > a && c.n < b);
const savepointPairs = (slices: number) => Array.from({ length: slices }).flatMap(() => ['SAVEPOINT per_line_settlement', 'RELEASE SAVEPOINT per_line_settlement']);
const claimedOrders = () => world.calls.filter((c) => c.op === 'order.updateMany').map((c) => (c.args.where.id.in as string[]).join(','));
const WHY_SETTLED = 'سُوِّي بباب آخر (تحصيل يدوي أو كشف ثاني)';

/** Does an approval of this statement come out alive at this latency — with the new step, or with the first version of it? */
async function survives(latencyMs: number, orders: number, itemsOf: (i: number) => number, reference = false) {
  resetWorld();
  forgetPerLineSwitch();
  world.reference = reference;
  world.latencyMs = latencyMs;
  bigStatement(orders, itemsOf);
  const { res } = await approve();
  return res.status === 200 && world.timeouts === 0 && world.movements.length === 1;
}

/* ───────────────────────────── 1 · THE NUMBERS THE BUDGET STANDS ON ───────────────────────────── */

describe('the numbers the budget stands on', () => {
  /** The per-query latency the guard is proved for here, with three item lines an order — eight times the latency the first version broke at. */
  const SAFE_LATENCY_MS = 25;

  it('says what it says: slices of 25 orders, 10 of the 30 seconds, a 3-second lock wait — and the cap of 300 stays as the second, total limit', () => {
    expect([EARLY_STEP_SLICE, EARLY_STEP_BUDGET_MS, STATEMENT_TX_TIMEOUT_MS, EARLY_STEP_CAP, EARLY_STEP_LOCK_WAIT]).toEqual([25, 10_000, 30_000, 300, '3s']);
    expect(EARLY_STEP_BUDGET_MS).toBeLessThan(STATEMENT_TX_TIMEOUT_MS / 2);
  });

  it('measured on the real code: a slice of 25 orders costs about 380 / 480 / 580 queries for one / two / three item lines — and the worst of them fits the timeout with the budget in front of it', async () => {
    const perSlice: number[] = [];
    for (const items of [1, 2, 3]) {
      resetWorld();
      forgetPerLineSwitch();
      bigStatement(EARLY_STEP_SLICE, () => items, false);
      await runStep();
      const s = slicesRun()[0];
      perSlice.push(s.to - s.from + 1);
    }
    expect(perSlice[0]).toBeLessThanOrEqual(400);
    expect(perSlice[1]).toBeLessThanOrEqual(500);
    expect(perSlice[2]).toBeLessThanOrEqual(600);
    // the worst slice, at the proved latency, started at the last moment the budget allows, and the commit after it: still inside the timeout, with room
    expect(EARLY_STEP_BUDGET_MS + perSlice[2] * SAFE_LATENCY_MS + SAFE_LATENCY_MS).toBeLessThanOrEqual(STATEMENT_TX_TIMEOUT_MS - 4_000);
  });

  it('where it breaks, measured: the first version dies at 5 ms a query on 300 orders of three item lines; the new step lives at every latency up to the 34 ms its arithmetic promises — cheap slices first and a dear one starting just under the budget included', async () => {
    const three = () => 3;
    expect(await survives(4, 300, three, true)).toBe(true);
    expect(await survives(5, 300, three, true)).toBe(false);
    for (const ms of [1, 2, 3, 5, 8, 10, 13, 17, 20, 25, 30, 34]) expect(await survives(ms, 300, three), `${ms} ms`).toBe(true);
    // the adversarial alignment: seven cheap slices (one item line an order), then dear ones (three) — the budget lets a dear one start late
    const cheapThenDear = (i: number) => (i < 175 ? 1 : 3);
    for (const ms of [20, 24, 25, 34]) expect(await survives(ms, 300, cheapThenDear), `cheap then dear, ${ms} ms`).toBe(true);
  });
});

/* ───────────────────────────── 2 · SLICES ───────────────────────────── */

describe('the step works in slices of 25 orders, each in a savepoint of its own', () => {
  it.each([[1, 1], [24, 1], [25, 1], [26, 2], [50, 2], [51, 3]])('%i clean orders go through in %i savepoint(s): taken, released, then the next — never nested', async (n, slices) => {
    bigStatement(n, () => 1, false);
    const out = await runStep();
    expect(out).toMatchObject({ ran: true, settled: n, delivered: n, heldBack: 0, remaining: 0, failed: false, failure: null });
    expect(out).not.toHaveProperty('stoppedForTime');
    expect(out.rows).toHaveLength(n);
    expect(savepointSql()).toEqual(savepointPairs(slices));
    expect(marked()).toHaveLength(n);
    expect(new Set(stockOut()).size).toBe(n);
    expect(stockOut()).toHaveLength(n);
  });

  it('the marks of a slice are written INSIDE that slice, with its settlements — one mark, one commission promotion, its own orders', async () => {
    bigStatement(60, () => 1, false);
    await runStep();
    const slices = slicesRun();
    expect(slices.map((s) => s.ended)).toEqual(['RELEASE', 'RELEASE', 'RELEASE']);
    const sizes = [25, 25, 10];
    slices.forEach((s, k) => {
      const inside = callsBetween(s.from, s.to);
      const marks = inside.filter((c) => c.op === 'settlementMatch.updateMany');
      expect(marks).toHaveLength(1);
      expect(marks[0].args.where.orderId.in).toHaveLength(sizes[k]);
      expect(marks[0].args.where.orderId.in[0]).toBe(`o${k * 25}`);
      expect(inside.filter((c) => c.op === 'commissionEntry.updateMany')).toHaveLength(1);
      expect(inside.filter((c) => c.op === 'order.updateMany')).toHaveLength(sizes[k]); // one claim per order, in the slice that owns it
    });
    // and nothing of a slice is written outside it
    const outside = world.calls.filter((c) => c.write && !slices.some((s) => c.n >= s.from && c.n <= s.to));
    expect(outside).toEqual([]);
  });

  it('the orders go in the order of the file — the claims of the second slice come after every write of the first', async () => {
    bigStatement(30, () => 1, false);
    await runStep();
    expect(claimedOrders()).toEqual(Array.from({ length: 30 }, (_, i) => `o${i}`));
    const [s1, s2] = slicesRun();
    expect(s1.to).toBeLessThan(s2.from);
  });

  it('an order two lines name, the second line far down the file, across a slice boundary: it goes with its FIRST line — settled once, both rows marked, never held back', async () => {
    bigStatement(26, () => 1, false);
    world.rows.push(mrow('m0b', 'o0')); // the 27th line names the first order again
    const out = await runStep();
    expect(out).toMatchObject({ settled: 26, delivered: 26, heldBack: 0, remaining: 0, failed: false });
    expect(out.rows).toHaveLength(27);
    expect(out.rows.every((r: Any) => r.outcome === 'SETTLED' && r.why === null)).toBe(true);
    expect(out.rows.map((r: Any) => r.matchId)).toEqual([...Array.from({ length: 26 }, (_, i) => `m${i}`), 'm0b']); // the file's order
    expect(marked().sort()).toEqual([...Array.from({ length: 26 }, (_, i) => `m${i}`), 'm0b'].sort());
    expect(claimedOrders().filter((c) => c === 'o0')).toHaveLength(1);
    expect(stockOut().filter((id) => id === 'o0')).toHaveLength(1);
    const [s1] = slicesRun();
    expect(callsBetween(s1.from, s1.to).find((c) => c.op === 'settlementMatch.updateMany')!.args.where.orderId.in).toContain('o0');
  });

  it('the same, with the two lines side by side and the boundary between orders: nothing changes', async () => {
    bigStatement(26, () => 1, false);
    world.rows.splice(1, 0, mrow('m0b', 'o0'));
    const out = await runStep();
    expect(out).toMatchObject({ settled: 26, heldBack: 0, remaining: 0 });
    expect(out.rows.map((r: Any) => r.matchId).slice(0, 3)).toEqual(['m0', 'm0b', 'm1']);
    expect(claimedOrders().filter((c) => c === 'o0')).toHaveLength(1);
  });

  it('a slice whose every order is held back: nothing is settled, nothing is marked, nothing is written — and the step goes on to the next slice', async () => {
    bigStatement(50, () => 1, false);
    for (let i = 0; i < 25; i++) world.orders.get(`o${i}`)!.settlementStatus = 'SETTLED'; // collected by hand meanwhile
    const out = await runStep();
    expect(out).toMatchObject({ ran: true, settled: 25, delivered: 25, heldBack: 25, remaining: 0, failed: false });
    expect(out).not.toHaveProperty('stoppedForTime');
    expect(out.rows.slice(0, 25).every((r: Any) => r.outcome === 'HELD_BACK' && r.why === WHY_SETTLED)).toBe(true);
    expect(out.rows.slice(25).every((r: Any) => r.outcome === 'SETTLED')).toBe(true);
    expect(marked()).toEqual(Array.from({ length: 25 }, (_, i) => `m${25 + i}`));
    const [s1, s2] = slicesRun();
    expect([s1.ended, s2.ended]).toEqual(['RELEASE', 'RELEASE']);
    // the first slice only claimed (and found nothing): not one other write
    expect(callsBetween(s1.from, s1.to).filter((c) => c.write && c.op !== 'order.updateMany')).toEqual([]);
    expect(new Set(stockOut())).toEqual(new Set(Array.from({ length: 25 }, (_, i) => `o${25 + i}`)));
  });

  it('exactly the cap: 300 clean orders are twelve slices, all of them run with a fast clock, nothing is left; one more is left alone', async () => {
    bigStatement(EARLY_STEP_CAP, () => 1, false);
    const exact = await runStep();
    expect(exact).toMatchObject({ settled: EARLY_STEP_CAP, remaining: 0, failed: false });
    expect(exact).not.toHaveProperty('stoppedForTime');
    expect(slicesRun()).toHaveLength(12);

    resetWorld();
    forgetPerLineSwitch();
    bigStatement(EARLY_STEP_CAP + 1, () => 1, false);
    const over = await runStep();
    expect(over).toMatchObject({ settled: EARLY_STEP_CAP, remaining: 1, failed: false });
    expect(over).not.toHaveProperty('stoppedForTime'); // the cap is not a time stop
    expect(world.orders.get(`o${EARLY_STEP_CAP}`)!.settlementStatus).toBe('PENDING_COLLECTION');
    expect(marked()).toHaveLength(EARLY_STEP_CAP);
  });

  it('the cap and the clock together: of 400 clean rows the cap leaves 100 and the clock leaves the 225 it did not reach — 325 wait, three slices went through', async () => {
    bigStatement(400, () => 1, false);
    const out = await runStep({ startedAt: 0, now: clockOf(0, 0, 0, EARLY_STEP_BUDGET_MS) });
    expect(out).toMatchObject({ ran: true, settled: 75, remaining: 325, failed: false, stoppedForTime: true });
    expect(out.rows).toHaveLength(75);
    expect(slicesRun()).toHaveLength(3);
    expect(marked()).toHaveLength(75);
    expect(world.orders.get('o75')!.settlementStatus).toBe('PENDING_COLLECTION');
  });
});

/* ───────────────────────────── 3 · THE CLOCK ───────────────────────────── */

describe('the clock decides before a slice starts, never inside one', () => {
  it('exactly at the budget the next slice does NOT start (the comparison is strict)', async () => {
    bigStatement(50, () => 1, false);
    const out = await runStep({ startedAt: 0, now: clockOf(0, EARLY_STEP_BUDGET_MS) });
    expect(out).toMatchObject({ settled: 25, remaining: 25, stoppedForTime: true, failed: false });
    expect(savepointSql()).toEqual(savepointPairs(1));
    expect(marked()).toHaveLength(25);
  });

  it('one millisecond under the budget it does', async () => {
    bigStatement(50, () => 1, false);
    const out = await runStep({ startedAt: 0, now: clockOf(0, EARLY_STEP_BUDGET_MS - 1) });
    expect(out).toMatchObject({ settled: 50, remaining: 0, failed: false });
    expect(out).not.toHaveProperty('stoppedForTime');
    expect(savepointSql()).toEqual(savepointPairs(2));
  });

  it('the clock is read before EVERY slice, not once: three slices run, the fourth is refused', async () => {
    bigStatement(100, () => 1, false);
    const reads = [0, 4_000, 9_999, 10_001];
    let n = 0;
    const now = () => reads[Math.min(n++, reads.length - 1)];
    const out = await runStep({ startedAt: 0, now });
    expect(out).toMatchObject({ settled: 75, remaining: 25, stoppedForTime: true });
    expect(n).toBe(4);
  });

  it('the budget runs out INSIDE a slice: that slice is finished, whole and released — it is never cut — and no other starts', async () => {
    bigStatement(50, () => 1, false);
    world.latencyMs = 40; // a slice of 25 one-item orders is about 15 simulated seconds
    const out = await runStep({ startedAt: world.clock, now: () => world.clock });
    expect(out).toMatchObject({ ran: true, settled: 25, delivered: 25, remaining: 25, failed: false, stoppedForTime: true });
    expect(slicesRun().map((s) => s.ended)).toEqual(['RELEASE']);
    expect(marked()).toHaveLength(25);
    expect(world.clock).toBeGreaterThan(EARLY_STEP_BUDGET_MS); // it did run past the budget — and was not interrupted
  });

  it('the budget was already spent when the step was called (the money loop took too long): nothing runs — no savepoint, no query, nothing marked', async () => {
    bigStatement(50, () => 1, false);
    const out = await runStep({ startedAt: -15_000, now: () => 0 });
    expect(out).toEqual({ ran: true, settled: 0, delivered: 0, heldBack: 0, remaining: 50, failed: false, failure: null, rows: [], stoppedForTime: true });
    expect(world.sql).toEqual([]);
    expect(world.calls.filter((c) => c.write)).toEqual([]);
    expect(marked()).toEqual([]);
  });

  it('with no start handed in, the step times itself from its own first moment', async () => {
    bigStatement(50, () => 1, false);
    const out = await runStep({ now: clockOf(7_000_000, 7_000_000, 7_000_000 + EARLY_STEP_BUDGET_MS) }); // start, slice 1, slice 2
    expect(out).toMatchObject({ settled: 25, remaining: 25, stoppedForTime: true });
  });

  it('with no clock handed in, it reads Date.now — the one the transaction’s own first line reads', async () => {
    bigStatement(50, () => 1, false);
    world.latencyMs = 40;
    const out = await runStep(); // neither startedAt nor now: Date.now follows the world's clock
    expect(out).toMatchObject({ settled: 25, remaining: 25, stoppedForTime: true });
  });

  it('a clock that goes BACKWARDS cannot make it loop: the slices are the orders there are, each runs once, and the end is the fast clock’s', async () => {
    bigStatement(100, () => 1, false);
    let t = 100;
    let reads = 0;
    const out = await runStep({ startedAt: 100, now: () => { reads++; return (t -= 7); } });
    expect(out).toMatchObject({ settled: 100, remaining: 0, failed: false });
    expect(out).not.toHaveProperty('stoppedForTime');
    expect(reads).toBe(4); // one reading per slice, no more
    expect(savepointSql()).toEqual(savepointPairs(4));
  });

  it.each([['not a number', NaN], ['infinite', Infinity], ['minus infinite', -Infinity]])('a clock that answers with a time that is %s says the time is up: nothing runs', async (_name, bad) => {
    bigStatement(30, () => 1, false);
    const out = await runStep({ startedAt: 0, now: () => bad });
    expect(out).toMatchObject({ ran: true, settled: 0, remaining: 30, stoppedForTime: true });
    expect(world.sql).toEqual([]);
  });

  it('…and so does a start that is not a time', async () => {
    bigStatement(30, () => 1, false);
    const out = await runStep({ startedAt: NaN, now: () => 0 });
    expect(out).toMatchObject({ settled: 0, remaining: 30, stoppedForTime: true });
    expect(world.sql).toEqual([]);
  });

  it('nothing waiting is nothing to do: no clock is read, no savepoint is taken', async () => {
    bigStatement(0, () => 1, true);
    let reads = 0;
    const out = await runStep({ now: () => { reads++; return 0; } });
    expect(out).toEqual({ ran: false, settled: 0, delivered: 0, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] });
    expect(reads).toBe(0);
    expect(world.sql).toEqual([]);
  });
});

/* ───────────────────────────── 4 · THE WHOLE STATEMENT AGAINST A SLOW DATABASE ───────────────────────────── */

describe('1,000 clean lines and one that is a question, against a database that takes X milliseconds a query', () => {
  /** The statement as the switch OFF settles it: the money at the approval, every order at the close, a transaction with no clock. */
  async function offState() {
    resetWorld();
    forgetPerLineSwitch();
    bigStatement(1000);
    world.switchOn = false;
    expect((await approve()).res.status).toBe(200);
    park();
    expect((await close()).res.status).toBe(200);
    return finalState();
  }

  it.each([1, 2, 5, 10, 20])('%i ms a query: approved with the money posted once, every transaction inside its timeout, the press finishes the rest, and the end is what the switch OFF produces', async (ms) => {
    bigStatement(1000);
    world.latencyMs = ms;
    const first = await approve();
    expect(first.res.status).toBe(200);
    expect(world.timeouts).toBe(0);
    expect(world.movements).toHaveLength(1); // the money, once — exactly as before
    expect(world.statements.get('st1')!.approvedAt).not.toBeNull();
    const early = first.body.earlySettlement;
    expect(early).toMatchObject({ ran: true, failed: false });
    expect(first.body).toMatchObject({ matchingClosed: false, openLines: 1, settledOrders: 0 }); // the fields it always had keep their values
    expect(early.settled).toBeGreaterThanOrEqual(EARLY_STEP_SLICE); // the first slice always runs
    expect(early.settled).toBeLessThanOrEqual(EARLY_STEP_CAP);
    expect(early.settled + early.remaining).toBe(1000); // what was settled and what waits are every line there is
    expect(marked()).toHaveLength(early.settled);
    if (early.stoppedForTime) expect(world.txMs[0]).toBeGreaterThanOrEqual(EARLY_STEP_BUDGET_MS);
    else expect(early.settled).toBe(EARLY_STEP_CAP); // nothing but the cap stopped it
    expect(early.message).toContain(`بقي ${early.remaining} نظيف`);

    // the rows the step did not reach are unmarked and untouched, and the press settles them — as many as its own clock allows each time
    let presses = 0;
    while (world.rows.some((r) => r.result === 'MATCHED' && !r.appliedAt)) {
      const left = world.rows.filter((r) => r.result === 'MATCHED' && !r.appliedAt).length;
      const p = await press();
      expect(p.res.status).toBe(200);
      expect(p.body.settled).toBeGreaterThanOrEqual(Math.min(EARLY_STEP_SLICE, left));
      expect(p.body.settled + p.body.remaining).toBe(left);
      expect(world.timeouts).toBe(0);
      expect(++presses).toBeLessThan(100);
    }
    expect(marked()).toHaveLength(1000);
    expect(Math.max(...world.txMs)).toBeLessThan(STATEMENT_TX_TIMEOUT_MS); // every transaction of the whole story, commit included

    park();
    const closed = await close();
    expect(closed.res.status).toBe(200);
    expect(closed.body).toMatchObject({ matchingClosed: true, settledOrders: 1000, settledEarlier: 1000 });
    expect(world.movements).toHaveLength(1); // the close and the presses wrote no money
    const on = finalState();
    expect(on).toEqual(await offState());
  });

  it('CONTROL — the same statement at the same latency with the FIRST version of the step: the transaction expires, the whole approval is rolled back with its money, the owner gets an error. (A world that cannot fail proves nothing.)', async () => {
    world.reference = true;
    world.latencyMs = 6;
    bigStatement(300);
    const dead = await approve();
    expect(dead.res.status).toBeGreaterThanOrEqual(500);
    expect(world.timeouts).toBeGreaterThan(0);
    expect(world.movements).toEqual([]);
    expect(world.statements.get('st1')!.approvedAt).toBeNull();
    expect(settledIds()).toEqual([]);

    resetWorld();
    forgetPerLineSwitch();
    world.latencyMs = 6;
    bigStatement(300);
    const alive = await approve();
    expect(alive.res.status).toBe(200);
    expect(world.timeouts).toBe(0);
    expect(world.movements).toHaveLength(1);
    expect(alive.body.earlySettlement).toMatchObject({ failed: false, stoppedForTime: true });
    expect(alive.body.earlySettlement.settled).toBeGreaterThan(0);
    expect(alive.body.earlySettlement.settled).toBeLessThan(300);
  });

  it('a fast database is not slowed, and not changed: at 1 ms a query nothing but the cap stops the step, and the answer carries no new field', async () => {
    bigStatement(400);
    world.latencyMs = 1;
    const { body } = await approve();
    expect(body.earlySettlement).toMatchObject({ settled: EARLY_STEP_CAP, remaining: 100, failed: false });
    expect(body.earlySettlement).not.toHaveProperty('stoppedForTime');
    expect(Object.keys(body.earlySettlement).sort()).toEqual(['delivered', 'failed', 'heldBack', 'message', 'ran', 'remaining', 'settled']);
  });

  it('the money loop took the whole budget (a slow wallet write): the step does not start, the approval stands, and the answer says what to do', async () => {
    bigStatement(60);
    world.extraCost = (op) => (op === 'walletMovement.create' ? EARLY_STEP_BUDGET_MS + 1_000 : 0);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(world.movements).toHaveLength(1);
    expect(body.earlySettlement).toMatchObject({ ran: true, settled: 0, remaining: 60, failed: false, stoppedForTime: true });
    expect(body.earlySettlement.message).toBe('ما لحق يتسوّى شي مع الاعتماد. وقفت التسوية لأن الوقت خلص وبقي 60 نظيف — زر «سوّي الطلبات النظيفة» أو بتتسوّى لما تتسكّر المطابقة');
    expect(savepointSql()).toEqual([]);
    expect(marked()).toEqual([]);
    expect(audit('STATEMENT_APPROVED')[0].newData.perLineSettlement).toMatchObject({ ran: true, settled: 0, remaining: 60, stoppedForTime: true });
  });

  it('what the clock left is settled by the close exactly as anything the step did not take: one claim for the rest, never for what was marked, no stock twice', async () => {
    bigStatement(60);
    world.latencyMs = 20; // the approval gets through two slices of the sixty
    const { body } = await approve();
    expect(body.earlySettlement).toMatchObject({ settled: 50, remaining: 10, stoppedForTime: true });
    park();
    const claimsBefore = claimedOrders().length;
    const closed = await close();
    expect(closed.res.status).toBe(200);
    expect(closed.body).toMatchObject({ settledOrders: 60, settledEarlier: 50 });
    const claimedByTheClose = claimedOrders().slice(claimsBefore);
    expect(claimedByTheClose).toHaveLength(1); // one claim, for the ten the clock left
    expect(claimedByTheClose[0].split(',')).toEqual(Array.from({ length: 10 }, (_, i) => `o${50 + i}`));
    const stockPerOrder = new Map<string, number>();
    for (const m of world.invMovements) stockPerOrder.set(m.referenceId, (stockPerOrder.get(m.referenceId) ?? 0) + 1);
    for (let i = 0; i < 60; i++) expect(stockPerOrder.get(`o${i}`)).toBe(1 + (i % 3)); // one movement per item line, once
  });
});

/* ───────────────────────────── 5 · A SLICE THAT FAILS ───────────────────────────── */

describe('a database error at ANY query of a slice: that slice is undone, the earlier ones stay, the approval stands with its money', () => {
  const N = 30; // slices of 25 and 5 orders, and a question
  const OLD_FAILED_SENTENCE = 'تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»';
  const items = () => 1;
  const fresh = () => {
    resetWorld();
    forgetPerLineSwitch();
    bigStatement(N, items);
  };
  /** The query numbers a slice spans in a clean run: after its SAVEPOINT up to and including its RELEASE. */
  async function spans() {
    fresh();
    expect((await approve()).res.status).toBe(200);
    return slicesRun().map((s) => ({ from: s.from + 1, to: s.to }));
  }

  it('slice 1, at each of its queries (the savepoint’s own statements aside): nothing of the step is written — the answer is the one the first version gave — and the money is posted', async () => {
    const [one] = await spans();
    let runs = 0;
    for (let k = one.from; k <= one.to; k++) {
      fresh();
      world.failAt = k;
      const { res, body } = await approve();
      runs++;
      const where = `query #${k}`;
      expect(res.status, where).toBe(200);
      expect(world.movements, where).toHaveLength(1);
      expect(world.statements.get('st1')!.approvedAt, where).not.toBeNull();
      expect(body.earlySettlement, where).toMatchObject({ ran: true, settled: 0, delivered: 0, remaining: N, failed: true, failure: 'Error' });
      expect(body.earlySettlement.message, where).toBe(OLD_FAILED_SENTENCE);
      expect(body.earlySettlement, where).not.toHaveProperty('stoppedForTime');
      expect(marked(), where).toEqual([]);
      expect(settledIds(), where).toEqual([]);
      expect(world.invMovements, where).toEqual([]);
      expect([...world.commission.values()].every((c) => c === 'ACCRUED'), where).toBe(true);
      expect(world.customers.size, where).toBe(0);
      expect(savepointSql(), where).toEqual(['SAVEPOINT per_line_settlement', 'ROLLBACK TO SAVEPOINT per_line_settlement']);
      expect(world.gucAtCommit!.lock_timeout, where).toBe('0'); // the rollback took the lock timeout with it
      expect(audit('STATEMENT_APPROVED')[0].newData.perLineSettlement, where).toMatchObject({ failed: true, settled: 0 });
    }
    expect(runs).toBeGreaterThan(300); // every query of a 25-order slice
  });

  it('slice 2, at each of its queries: slice 1 stays applied — settled, delivered, marked, stocked, whole — and slice 2 leaves not a trace; the approval answers 200 and says what went through', async () => {
    const [, two] = await spans();
    let runs = 0;
    for (let k = two.from; k <= two.to; k++) {
      fresh();
      world.failAt = k;
      const { res, body } = await approve();
      runs++;
      const where = `query #${k}`;
      expect(res.status, where).toBe(200);
      expect(world.movements, where).toHaveLength(1);
      expect(body.earlySettlement, where).toMatchObject({ ran: true, settled: 25, delivered: 25, remaining: 5, failed: true, failure: 'Error' });
      expect(body.earlySettlement.message, where).toBe('تسوّى 25 طلب نظيف مع الاعتماد، وبعدها تعذّرت تسوية الباقي — بتتسوّى عند «إغلاق المطابقة»');
      expect(marked().sort(), where).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`).sort());
      expect(settledIds().sort(), where).toEqual(Array.from({ length: 25 }, (_, i) => `o${i}`).sort());
      expect(new Set(stockOut()), where).toEqual(new Set(Array.from({ length: 25 }, (_, i) => `o${i}`)));
      for (let i = 25; i < N; i++) expect(world.orders.get(`o${i}`), where).toEqual(ord(`o${i}`, 1)); // untouched, byte for byte
      expect([...world.commission.entries()].filter(([, v]) => v === 'PAYABLE').map(([id]) => id).sort(), where).toEqual(Array.from({ length: 25 }, (_, i) => `o${i}`).sort());
      expect(savepointSql(), where).toEqual([...savepointPairs(1), 'SAVEPOINT per_line_settlement', 'ROLLBACK TO SAVEPOINT per_line_settlement']);
      expect(world.gucAtCommit!.lock_timeout, where).toBe('0');
    }
    expect(runs).toBeGreaterThan(70);
  });

  it('a step that failed in slice 2 is finished by the press and the close, and the end is what the switch OFF produces', async () => {
    const [, two] = await spans();
    fresh();
    world.failAt = two.from + 20;
    await approve();
    expect(marked()).toHaveLength(25);
    const pressed = await press();
    expect(pressed.res.status).toBe(200);
    expect(pressed.body).toMatchObject({ settled: 5, remaining: 0 });
    park();
    expect((await close()).res.status).toBe(200);
    const on = finalState();
    resetWorld();
    forgetPerLineSwitch();
    bigStatement(N, items);
    world.switchOn = false;
    await approve();
    park();
    await close();
    expect(on).toEqual(finalState());
  });

  it('an error that is not the database’s — a plain exception from the code of the stock helper — is the same: that slice only', async () => {
    fresh();
    world.beforeClaim = (id) => {
      if (id === 'o27') throw new TypeError('a bug in a slice');
    };
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 25, remaining: 5, failed: true, failure: 'TypeError' });
    expect(marked()).toHaveLength(25);
    expect(world.movements).toHaveLength(1);
  });

  it('the failure of a slice is logged by name and database code only — never the message, which can carry a value', async () => {
    fresh();
    world.failAt = 40;
    await approve();
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).includes('per-line-settlement'));
    expect(logged).toHaveLength(1);
    expect(logged[0].slice(1)).toEqual(['Error', 'P2034']);
  });
});

/* ───────────────────────────── 6 · THE LOCK WAIT ───────────────────────────── */

describe('a lock wait inside a slice is bounded — and the setting never reaches the rest of the transaction', () => {
  const stmt = (name: string, values: unknown[] = []) => ({ text: name, values });
  const SET = (v: string) => stmt(`SELECT set_config('lock_timeout', ?, true)`, [v]);

  it('the exact statements, in order: the question once, then per slice — set after the savepoint, put back before its release', async () => {
    bigStatement(30, () => 1);
    await approve();
    expect(world.sql.map((s) => ({ text: s.text, values: s.values }))).toEqual([
      stmt('SAVEPOINT per_line_settlement'),
      stmt(`SELECT current_setting('lock_timeout') AS "value"`),
      SET('3s'),
      SET('0'),
      stmt('RELEASE SAVEPOINT per_line_settlement'),
      stmt('SAVEPOINT per_line_settlement'),
      SET('3s'),
      SET('0'),
      stmt('RELEASE SAVEPOINT per_line_settlement'),
    ]);
  });

  it('only the transaction-local form: set_config is always asked with `true`, nothing is a session-level SET, and the value travels as a parameter, never in the text', async () => {
    bigStatement(60, () => 1);
    await approve();
    for (const s of lockSql()) {
      if (s.text.startsWith('SELECT set_config')) {
        expect(s.text).toBe(`SELECT set_config('lock_timeout', ?, true)`);
        expect(s.text).not.toMatch(/3s|'0'/);
      }
    }
    expect(world.sql.filter((s) => /^\s*SET\b/i.test(s.text))).toEqual([]);
    expect(world.sql.filter((s) => /RESET|DEFAULT|false\)/i.test(s.text))).toEqual([]);
  });

  it('the wait is 3 seconds INSIDE every slice, and the database’s own value outside it — between the slices, before the money, at the commit', async () => {
    bigStatement(60, () => 1);
    await approve();
    const claims = world.calls.filter((c) => c.op === 'order.updateMany');
    expect(claims).toHaveLength(60);
    expect(claims.every((c) => c.guc === '3s')).toBe(true);
    const savepoints = world.calls.filter((c) => c.op === '$executeRaw' && c.args.startsWith('SAVEPOINT'));
    expect(savepoints).toHaveLength(3);
    expect(savepoints.every((c) => c.guc === '0')).toBe(true); // every slice begins with the value given back
    expect(world.calls.find((c) => c.op === 'walletMovement.create')!.guc).toBe('0');
    expect(world.gucAtCommit).toEqual({ lock_timeout: '0' });
    expect(world.guc).toEqual({ lock_timeout: '0' }); // and the next transaction starts clean
  });

  it('a slice that fails takes the setting down with it: the rollback to its savepoint undoes it, and the code writes nothing more', async () => {
    bigStatement(30, () => 1);
    await approve();
    const firstClaim = world.calls.find((c) => c.op === 'order.updateMany')!.n;
    resetWorld();
    forgetPerLineSwitch();
    bigStatement(30, () => 1);
    world.failAt = firstClaim + 3;
    await approve();
    expect(world.sql.map((s) => s.text)).toEqual([
      'SAVEPOINT per_line_settlement',
      `SELECT current_setting('lock_timeout') AS "value"`,
      `SELECT set_config('lock_timeout', ?, true)`,
      'ROLLBACK TO SAVEPOINT per_line_settlement',
    ]);
    expect(world.gucAtCommit).toEqual({ lock_timeout: '0' });
  });

  it.each(['15s', '1s', '500ms'])('a lock timeout somebody set on purpose (%s) is never loosened or replaced: the step asks, finds it is not off, and sets nothing', async (own) => {
    world.gucSession.lock_timeout = own;
    bigStatement(60, () => 1);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 60, failed: false });
    expect(lockSql().map((s) => s.text)).toEqual([`SELECT current_setting('lock_timeout') AS "value"`]); // asked once
    expect(world.calls.filter((c) => c.op === 'order.updateMany').every((c) => c.guc === own)).toBe(true);
    expect(world.gucAtCommit).toEqual({ lock_timeout: own });
  });

  it('a setting that cannot be read is a setting that is not touched: the step works, and sets nothing', async () => {
    world.settingUnreadable = true;
    bigStatement(30, () => 1);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 30, failed: false });
    expect(lockSql().map((s) => s.text)).toEqual([`SELECT current_setting('lock_timeout') AS "value"`]);
  });

  it('a lock held for 40 seconds by another door, on an order of the second slice: that slice gives up after 3 — the first stays applied, the money is posted, the transaction lives', async () => {
    bigStatement(60, () => 1);
    world.lockWaits.set('o25', 40_000);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(world.timeouts).toBe(0);
    expect(world.txMs[0]).toBeLessThan(STATEMENT_TX_TIMEOUT_MS);
    expect(world.movements).toHaveLength(1);
    expect(body.earlySettlement).toMatchObject({ settled: 25, remaining: 35, failed: true });
    expect(marked()).toHaveLength(25);
    expect(world.gucAtCommit).toEqual({ lock_timeout: '0' });
  });

  it('CONTROL — the same lock, the same statement, with the FIRST version of the step: the wait eats the transaction, and the approval dies with its money', async () => {
    world.reference = true;
    bigStatement(60, () => 1);
    world.lockWaits.set('o25', 40_000);
    const { res } = await approve();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(world.timeouts).toBeGreaterThan(0);
    expect(world.movements).toEqual([]);
  });

  it('a lock held for 40 seconds on an order of the FIRST slice: that slice gives up, nothing is written, and the answer is the first version’s', async () => {
    bigStatement(60, () => 1);
    world.lockWaits.set('o3', 40_000);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 0, remaining: 60, failed: true });
    expect(body.earlySettlement.message).toBe('تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»');
    expect(marked()).toEqual([]);
  });

  it('waits shorter than the limit only cost time, and the clock counts them: four slices that each wait 3 seconds for a lock — the fourth is refused', async () => {
    bigStatement(100, () => 1);
    world.latencyMs = 1;
    for (const id of ['o0', 'o25', 'o50', 'o75']) world.lockWaits.set(id, 3_000); // exactly the limit: waited for, not given up
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 75, remaining: 25, failed: false, stoppedForTime: true });
    expect(world.timeouts).toBe(0);
  });
});

/* ───────────────────────────── 7 · THE PRESS ───────────────────────────── */

describe('«سوّي الطلبات النظيفة هلّق» carries the same clock, with its own start', () => {
  /** A statement approved while the switch was OFF — the one the press is for — and the switch turned ON afterwards. */
  async function approvedBeforeTheSwitch(n: number, itemsOf?: (i: number) => number) {
    bigStatement(n, itemsOf);
    world.switchOn = false;
    forgetPerLineSwitch();
    expect((await approve()).res.status).toBe(200);
    world.switchOn = true;
    forgetPerLineSwitch();
    world.queries = 0;
    world.calls = [];
    world.sql = [];
  }

  it('the clock starts with the press’s own transaction: the wait for the statement’s lock is in the count — 11 seconds there and the step never starts', async () => {
    await approvedBeforeTheSwitch(40);
    world.extraCost = (op, args) => (op === '$queryRaw' && String(args).includes('FOR UPDATE') ? EARLY_STEP_BUDGET_MS + 1_000 : 0);
    const { res, body } = await press();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ settled: 0, delivered: 0, heldBack: 0, remaining: 40, rows: [], stoppedForTime: true });
    expect(body.message).toBe('ما لحق يتسوّى شي. وقفت التسوية لأن الوقت خلص وبقي 40 نظيف — اضغط مرة تانية، أو بتتسوّى لما تتسكّر المطابقة');
    expect(savepointSql()).toEqual([]);
    expect(marked()).toEqual([]);
    expect(audit('STATEMENT_CLEAN_LINES_SETTLED')[0].newData).toMatchObject({ ran: true, settled: 0, remaining: 40, stoppedForTime: true });
  });

  it('at 20 ms a query a press settles two slices and says the time was the reason; the next press carries on; 600 lines take as many presses as they take, none past its timeout', async () => {
    await approvedBeforeTheSwitch(600);
    world.latencyMs = 20;
    const reports: Any[] = [];
    while (world.rows.some((r) => r.result === 'MATCHED' && !r.appliedAt)) {
      const { res, body } = await press();
      expect(res.status).toBe(200);
      reports.push(body);
      expect(reports.length).toBeLessThan(60);
    }
    expect(world.timeouts).toBe(0);
    expect(Math.max(...world.txMs)).toBeLessThan(STATEMENT_TX_TIMEOUT_MS);
    expect(reports[0]).toMatchObject({ stoppedForTime: true });
    expect(reports[0].settled).toBeGreaterThanOrEqual(EARLY_STEP_SLICE);
    expect(reports[0].settled + reports[0].remaining).toBe(600);
    expect(reports[0].message).toBe(`تسوّى ${reports[0].settled} طلب نظيف. وقفت التسوية لأن الوقت خلص وبقي ${reports[0].remaining} نظيف — اضغط مرة تانية، أو بتتسوّى لما تتسكّر المطابقة`);
    expect(reports.reduce((s, r) => s + r.settled, 0)).toBe(600);
    expect(reports.at(-1)).toMatchObject({ remaining: 0 });
    expect(reports.at(-1)).not.toHaveProperty('stoppedForTime');
    expect(marked()).toHaveLength(600);
    expect(new Set(stockOut()).size).toBe(600);
  });

  it('the report lists only the rows the press went through, in the order of the file — a row it did not reach is not on it', async () => {
    await approvedBeforeTheSwitch(80);
    world.latencyMs = 40; // one slice and out
    const { body } = await press();
    expect(body.settled).toBe(25);
    expect(body.rows).toHaveLength(25);
    expect(body.rows.map((r: Any) => r.matchId)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
    expect(body.remaining).toBe(55);
  });

  /** The query numbers a press's slices span, learned from a clean press of the same statement. */
  async function pressSpans(n: number) {
    await approvedBeforeTheSwitch(n, () => 1);
    expect((await press()).res.status).toBe(200);
    const spans = slicesRun().map((s) => ({ from: s.from + 1, to: s.to }));
    resetWorld();
    forgetPerLineSwitch();
    return spans;
  }

  it('a press whose FIRST slice fails writes nothing and says so — the refusal it always gave, no audit row', async () => {
    const [one] = await pressSpans(40);
    await approvedBeforeTheSwitch(40, () => 1);
    world.failAt = one.from + 5;
    const { res, body } = await press();
    expect(res.status).toBe(409);
    expect(body.code).toBe('CLEAN_SETTLE_FAILED');
    expect(body.error).toBe('تعذّرت تسوية الطلبات النظيفة هلّق وما انكتب شي — جرّب بعد شوي، أو اضغط «إغلاق المطابقة» لما تخلص الأسطر');
    expect(marked()).toEqual([]);
    expect(settledIds()).toEqual([]);
    expect(audit('STATEMENT_CLEAN_LINES_SETTLED')).toEqual([]);
  });

  it('a press whose SECOND slice fails keeps the first (it is complete): 200, what went through, what is left, and the failure — with its audit row', async () => {
    const [, two] = await pressSpans(40);
    await approvedBeforeTheSwitch(40, () => 1);
    world.failAt = two.from + 40; // well inside the second slice
    const { res, body } = await press();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ settled: 25, delivered: 25, heldBack: 0, remaining: 15, failed: true });
    expect(body).not.toHaveProperty('stoppedForTime');
    expect(body.rows).toHaveLength(25);
    expect(body.message).toBe('تسوّى 25 طلب نظيف، وبعدها تعذّرت تسوية الباقي (بقي 15) — جرّب مرة تانية بعد شوي');
    expect(marked()).toHaveLength(25);
    expect(audit('STATEMENT_CLEAN_LINES_SETTLED')[0].newData).toMatchObject({ ran: true, settled: 25, failed: true, remaining: 15 });
    // pressed again it settles the rest, and nothing twice
    const again = await press();
    expect(again.body).toMatchObject({ settled: 15, remaining: 0 });
    expect(new Set(stockOut()).size).toBe(40);
  });

  it('an ordinary press keeps the answer it always had: the same six fields, no new one', async () => {
    await approvedBeforeTheSwitch(30);
    const { res, body } = await press();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['delivered', 'heldBack', 'message', 'remaining', 'rows', 'settled']);
    expect(body).toMatchObject({ settled: 30, remaining: 0, message: 'تسوّى 30 طلب نظيف' });
  });

  it('pressed twice: the second finds nothing left and writes nothing — one settlement per order', async () => {
    await approvedBeforeTheSwitch(30);
    await press();
    const writes = world.calls.filter((c) => c.write).length;
    const again = await press();
    expect(again.body).toMatchObject({ settled: 0, heldBack: 0, rows: [], message: 'ما في طلبات نظيفة بتنتظر التسوية' });
    expect(world.calls.filter((c) => c.write).length).toBe(writes);
  });
});

/* ───────────────────────────── 8 · THE WORDS ───────────────────────────── */

describe('the words: short, plain, spoken — and the old ones said again to the letter', () => {
  const base = { ran: true, settled: 5, heldBack: 0, failed: false };

  it('every sentence the step said before is the same sentence', () => {
    expect(earlyMessage({ ...base, ran: false })).toBe('');
    expect(earlyMessage({ ...base, settled: 3 })).toBe('تسوّى 3 طلب نظيف مع الاعتماد');
    expect(earlyMessage({ ...base, settled: 3, heldBack: 1 })).toBe('تسوّى 3 طلب نظيف مع الاعتماد، و1 بقوا للإغلاق (تغيّر وضعهم)');
    expect(earlyMessage({ ...base, settled: 300, remaining: 5 })).toBe('تسوّى 300 طلب نظيف مع الاعتماد. بقي 5 نظيف — زر «سوّي الطلبات النظيفة»');
    expect(earlyMessage({ ...base, settled: 0 })).toBe('');
    expect(earlyMessage({ ...base, settled: 0, failed: true })).toBe('تعذّرت تسوية الطلبات النظيفة مع الاعتماد — بتتسوّى كلها عند «إغلاق المطابقة»');
    expect(pressMessage({ settled: 0, heldBack: 0 })).toBe('ما في طلبات نظيفة بتنتظر التسوية');
    expect(pressMessage({ settled: 3, heldBack: 0 })).toBe('تسوّى 3 طلب نظيف');
    expect(pressMessage({ settled: 1, heldBack: 2 })).toBe('تسوّى 1 طلب نظيف، و2 بقوا للإغلاق (تغيّر وضعهم)');
    expect(pressMessage({ settled: 300, heldBack: 0, remaining: 5 })).toBe('تسوّى 300 طلب نظيف. بقي 5 نظيف — اضغط مرة تانية');
  });

  it('a time stop says it and says what to do: the approval points at the button and at the close, the press at the button again', () => {
    expect(earlyMessage({ ...base, settled: 75, remaining: 225, stoppedForTime: true })).toBe(
      'تسوّى 75 طلب نظيف مع الاعتماد. وقفت التسوية لأن الوقت خلص وبقي 225 نظيف — زر «سوّي الطلبات النظيفة» أو بتتسوّى لما تتسكّر المطابقة'
    );
    expect(earlyMessage({ ...base, settled: 75, heldBack: 2, remaining: 10, stoppedForTime: true })).toContain('تسوّى 75 طلب نظيف مع الاعتماد، و2 بقوا للإغلاق (تغيّر وضعهم). وقفت التسوية لأن الوقت خلص');
    expect(earlyMessage({ ...base, settled: 0, remaining: 60, stoppedForTime: true })).toBe(
      'ما لحق يتسوّى شي مع الاعتماد. وقفت التسوية لأن الوقت خلص وبقي 60 نظيف — زر «سوّي الطلبات النظيفة» أو بتتسوّى لما تتسكّر المطابقة'
    );
    expect(pressMessage({ settled: 50, heldBack: 0, remaining: 550, stoppedForTime: true })).toBe(
      'تسوّى 50 طلب نظيف. وقفت التسوية لأن الوقت خلص وبقي 550 نظيف — اضغط مرة تانية، أو بتتسوّى لما تتسكّر المطابقة'
    );
    expect(pressMessage({ settled: 0, heldBack: 0, remaining: 40, stoppedForTime: true })).toBe(
      'ما لحق يتسوّى شي. وقفت التسوية لأن الوقت خلص وبقي 40 نظيف — اضغط مرة تانية، أو بتتسوّى لما تتسكّر المطابقة'
    );
  });

  it('a failure after some slices went through says what went through and what is left — and does not say «nothing was settled»', () => {
    expect(earlyMessage({ ...base, settled: 25, remaining: 35, failed: true })).toBe('تسوّى 25 طلب نظيف مع الاعتماد، وبعدها تعذّرت تسوية الباقي — بتتسوّى عند «إغلاق المطابقة»');
    expect(earlyMessage({ ...base, settled: 25, heldBack: 1, remaining: 35, failed: true })).toBe('تسوّى 25 طلب نظيف مع الاعتماد، و1 بقوا للإغلاق (تغيّر وضعهم)، وبعدها تعذّرت تسوية الباقي — بتتسوّى عند «إغلاق المطابقة»');
    expect(pressMessage({ settled: 25, heldBack: 0, remaining: 15, failed: true })).toBe('تسوّى 25 طلب نظيف، وبعدها تعذّرت تسوية الباقي (بقي 15) — جرّب مرة تانية بعد شوي');
  });

  it('every sentence is Arabic only — no Latin letter, no code name — and none is longer than the guides’ ceiling of 220 characters', () => {
    const grid = [0, 1, 25, 300, 1000];
    const all: string[] = [];
    for (const settled of grid) for (const remaining of grid) for (const heldBack of [0, 3]) {
      for (const flags of [{ stoppedForTime: true }, { failed: true }, { stoppedForTime: true, failed: false }, {}]) {
        all.push(earlyMessage({ ran: true, settled, heldBack, failed: false, remaining, ...flags }));
        all.push(pressMessage({ settled, heldBack, remaining, ...flags }));
      }
    }
    expect(all.length).toBeGreaterThan(100);
    for (const s of all) {
      expect(/[A-Za-z]/.test(s), s).toBe(false);
      expect(s.length, s).toBeLessThanOrEqual(220);
      expect(s.trim(), s).toBe(s);
    }
  });

  it('the answer names the time stop only when there was one — and every other field keeps the value it had', () => {
    const idle = { ran: true, settled: 5, delivered: 5, heldBack: 0, remaining: 0, failed: false, failure: null, rows: [] };
    expect(earlyAnswer(idle)).not.toHaveProperty('stoppedForTime');
    expect(earlyAnswer({ ...idle, stoppedForTime: false })).not.toHaveProperty('stoppedForTime');
    const stopped = earlyAnswer({ ...idle, remaining: 9, stoppedForTime: true });
    expect(stopped).toMatchObject({ ran: true, settled: 5, delivered: 5, heldBack: [], failed: false, remaining: 9, stoppedForTime: true });
    expect(Object.keys(earlyAnswer(idle)).sort()).toEqual(['delivered', 'failed', 'heldBack', 'message', 'ran', 'settled']);
  });
});

/* ───────────────────────────── 9 · NOTHING OF THIS WHEN THE STEP DOES NOT RUN ───────────────────────────── */

describe('with the switch OFF, or with no line left to answer, none of this exists', () => {
  it('OFF: 400 clean lines and a question — the money, and not a savepoint, not a lock statement, not a word about a clock, in the answer or the audit row', async () => {
    world.switchOn = false;
    bigStatement(400);
    world.latencyMs = 5;
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ matchingClosed: false, openLines: 1, settledOrders: 0, deliveredByStatement: 0, claimsOpened: 0 });
    expect(body).not.toHaveProperty('earlySettlement');
    expect(world.sql).toEqual([]);
    expect(JSON.stringify([body, audit('STATEMENT_APPROVED')])).not.toMatch(/stoppedForTime|perLineSettlement|earlySettlement/);
    expect(settledIds()).toEqual([]);
    expect(marked()).toEqual([]);
  });

  it('ON with no line left to answer: the matching closes in the approval’s own transaction exactly as in both modes — the step does not run: no savepoint, no lock statement, no clock field', async () => {
    bigStatement(40, undefined, false);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ matchingClosed: true, openLines: 0, settledOrders: 40 });
    expect(body).not.toHaveProperty('earlySettlement');
    expect(world.sql).toEqual([]);
    expect(marked()).toEqual([]);
    expect(audit('STATEMENT_APPROVED')[0].newData.perLineSettlement).toEqual({ ran: false });
  });
});

/* ───────────────────────────── 10 · A FAST CLOCK CHANGES NOTHING ───────────────────────────── */

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const chance = (p: number) => next() < p;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  return { next, int, chance, pick };
}
const SHIP = ['SHIPPED', 'OUT_FOR_DELIVERY', 'READY_FOR_PICKUP', 'FAILED_DELIVERY', 'DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURN_REQUESTED'] as const;
const ACCEPTED = { resolution: 'ACCEPTED_COURIER', resolutionNote: 'خصم أعطاه الموظف للزبون', resolvedById: 'u-decider' };

/**
 * A statement of `nClean` clean lines — orders in every state (on the road, delivered by hand, partly delivered, coming back, settled
 * already, with a cancel asked for), one to three item lines, a fee or none, some orders named by a second clean line far down the file —
 * and the lines the step must leave alone (a figure accepted from the company, a claim kept, a line parked, an excluded one, one no
 * order owns) and the question that keeps the matching open.
 */
function seeded(seed: number, nClean: number) {
  const r = rng(seed);
  const orders: Any[] = [];
  const rows: Any[] = [];
  const later: Any[] = [];
  for (let i = 0; i < nClean; i++) {
    const ship = r.pick(SHIP);
    orders.push(ord(`o${i}`, r.int(1, 3), ship, {
      settlementStatus: r.chance(0.06) ? 'SETTLED' : 'PENDING_COLLECTION',
      openRequest: r.chance(0.05),
      collectedAmount: ship === 'DELIVERED' && r.chance(0.3) ? r.int(10, 60) : null,
      customerId: `cu-${i % 5}`,
    }));
    const amount = r.int(5, 60) * 5;
    rows.push(mrow(`m${i}`, `o${i}`, { expectedAmount: amount, statementAmount: amount, statementFee: r.chance(0.2) ? null : 5 }));
    if (r.chance(0.1)) later.push(mrow(`m${i}b`, `o${i}`, { expectedAmount: amount, statementAmount: amount }));
  }
  orders.push(ord('oAcc', 1, 'DELIVERED'), ord('oOurs', 1), ord('oPark', 1), ord('oEx', 1, 'RETURN_REQUESTED'), ord('oQ', 1));
  rows.push(
    ...later,
    mrow('mAcc', 'oAcc', { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 27, ...ACCEPTED }),
    mrow('mOurs', 'oOurs', { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 20, resolution: 'OURS_STANDS', resolutionNote: 'نطالب الشركة بالباقي', resolvedById: 'u-decider' }),
    mrow('mPark', 'oPark', { result: 'MISMATCHED', expectedAmount: 25, statementAmount: 0, ...PARK }),
    mrow('mEx', 'oEx', { result: 'EXCLUDED', expectedAmount: null, statementAmount: 0 }),
    mrow('mNone', null, { result: 'MISSING_IN_SYSTEM', expectedAmount: null }),
    question('mQ', 'oQ'),
  );
  load(orders, rows);
}

/** What a statement's life writes, in the shape two runs can be compared in: the answers, the audit rows, the state, the queries. */
async function lifeOf(seed: number, nClean: number, reference: boolean, via: 'approval' | 'press') {
  resetWorld();
  forgetPerLineSwitch();
  world.reference = reference;
  seeded(seed, nClean);
  const answers: unknown[] = [];
  if (via === 'press') {
    world.switchOn = false;
    forgetPerLineSwitch();
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    world.calls = [];
    const { res, body } = await press();
    answers.push(res.status, body);
  } else {
    const { res, body } = await approve();
    answers.push(res.status, body);
  }
  const queries = world.calls
    .filter((c) => c.op !== '$executeRaw' && !(c.op === '$queryRaw' && /lock_timeout/.test(c.args)))
    .map((c) => ({ op: c.op, write: c.write, args: c.args }));
  const afterStep = finalState();
  const audits = world.audits.map((a) => ({ action: a.action, newData: a.newData }));
  park();
  const closed = await close();
  answers.push(closed.res.status, closed.body);
  return { answers, queries, afterStep, audits, end: finalState(), savepoints: savepointSql().length };
}

describe('with a fast clock the guard is invisible: below a slice, the first version and the new one write the same, in the same order, and answer the same', () => {
  it('150 seeded statements of 1 to 25 clean lines, through the approval: every query with its arguments, the answers, the audit rows and the end', async () => {
    let compared = 0;
    let steps = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const nClean = 1 + (seed % 25);
      const was = await lifeOf(seed, nClean, true, 'approval');
      const now = await lifeOf(seed, nClean, false, 'approval');
      compared += was.queries.length;
      if (was.savepoints > 0) steps++;
      expect(now.answers, `seed ${seed}`).toEqual(was.answers);
      expect(now.queries, `seed ${seed}`).toEqual(was.queries);
      expect(now.afterStep, `seed ${seed}`).toEqual(was.afterStep);
      expect(now.audits, `seed ${seed}`).toEqual(was.audits);
      expect(now.end, `seed ${seed}`).toEqual(was.end);
      expect(now.savepoints, `seed ${seed}`).toBe(was.savepoints); // one savepoint, as before, below a slice
    }
    expect(compared).toBeGreaterThan(15_000);
    expect(steps).toBe(150);
  });

  it('150 seeded statements of 1 to 25 clean lines, through the press of a statement approved before the switch', async () => {
    for (let seed = 1001; seed <= 1150; seed++) {
      const nClean = 1 + (seed % 25);
      const was = await lifeOf(seed, nClean, true, 'press');
      const now = await lifeOf(seed, nClean, false, 'press');
      expect(now.answers, `seed ${seed}`).toEqual(was.answers);
      expect(now.queries, `seed ${seed}`).toEqual(was.queries);
      expect(now.afterStep, `seed ${seed}`).toEqual(was.afterStep);
      expect(now.audits, `seed ${seed}`).toEqual(was.audits);
      expect(now.end, `seed ${seed}`).toEqual(was.end);
    }
  });

  it('60 seeded statements of 26 to 120 clean lines: the answers, the audit rows and the end are the same — only the savepoints are cut into slices', async () => {
    let sliced = 0;
    for (let seed = 2001; seed <= 2060; seed++) {
      const nClean = 26 + (seed % 95);
      const via = seed % 2 === 0 ? 'approval' : 'press';
      const was = await lifeOf(seed, nClean, true, via);
      const now = await lifeOf(seed, nClean, false, via);
      expect(now.answers, `seed ${seed} ${via}`).toEqual(was.answers);
      expect(now.afterStep, `seed ${seed} ${via}`).toEqual(was.afterStep);
      expect(now.audits, `seed ${seed} ${via}`).toEqual(was.audits);
      expect(now.end, `seed ${seed} ${via}`).toEqual(was.end);
      expect(was.savepoints).toBe(2); // the first version: one around everything
      sliced += now.savepoints / 2; // the new one: a pair a slice
      expect(now.savepoints).toBeGreaterThan(2);
    }
    expect(sliced).toBeGreaterThan(120);
  });

  it('the lines of every other kind are left to the close in the sliced step too: an accepted figure, a claim, a parked line, an excluded one, one no order owns', async () => {
    seeded(7, 60);
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement.settled).toBeGreaterThan(0);
    for (const id of ['mAcc', 'mOurs', 'mPark', 'mEx', 'mNone', 'mQ']) expect(marked()).not.toContain(id);
    for (const id of ['oAcc', 'oOurs', 'oPark', 'oEx', 'oQ']) expect(world.orders.get(id)!.settlementStatus).toBe('PENDING_COLLECTION');
  });
});

/* ───────────────────────────── 11 · A DOOR GETS IN, AND NO ORDER IS SETTLED TWICE ───────────────────────────── */

describe('one winner, however the doors interleave: no order settled twice, none counted twice', () => {
  it('a door settles an order of the SECOND slice between the read and the claim: that order is left (named, unmarked), the other fifty-nine settle, and the close reports it as it always did', async () => {
    bigStatement(60, () => 1);
    world.beforeClaim = (id) => {
      if (id === 'o30') world.orders.get('o30')!.settlementStatus = 'SETTLED';
    };
    const { res, body } = await approve();
    expect(res.status).toBe(200);
    expect(body.earlySettlement).toMatchObject({ settled: 59, failed: false, heldBack: [{ orderNumber: 'ORD-o30', why: WHY_SETTLED }] });
    expect(body.earlySettlement).not.toHaveProperty('remaining');
    expect(marked()).toHaveLength(59);
    expect(marked()).not.toContain('m30');
    expect(world.movements).toHaveLength(1);
    park();
    world.beforeClaim = null;
    const closed = await close();
    expect(closed.res.status).toBe(409);
    expect(closed.body).toMatchObject({ code: 'ORDERS_CHANGED', orders: ['ORD-o30'] });
    expect(world.statements.get('st1')!.matchingClosedAt).toBeNull();
  });

  it('the approval’s claim on the statement row is the first thing it writes and every slice comes after it — the row lock the close waits on; the press takes the same lock before it reads anything', async () => {
    bigStatement(60, () => 1);
    await approve();
    const writes = world.calls.filter((c) => c.write);
    expect(writes[0].op).toBe('courierStatement.updateMany');
    expect(writes[0].args.where).toMatchObject({ approvedAt: null });
    expect(world.calls.filter((c) => c.op === '$executeRaw' && c.args.startsWith('SAVEPOINT')).every((c) => c.n > writes[0].n)).toBe(true);

    resetWorld();
    forgetPerLineSwitch();
    bigStatement(60, () => 1);
    world.switchOn = false;
    await approve();
    world.switchOn = true;
    forgetPerLineSwitch();
    world.calls = [];
    await press();
    const queries = world.calls.filter((c) => c.op === '$queryRaw');
    expect(queries[0].args).toBe('SELECT "id" FROM "courier_statements" WHERE "id" = ? FOR UPDATE');
    expect(world.calls.find((c) => c.op === 'settlementMatch.findMany')!.n).toBeGreaterThan(queries[0].n);
  });

  it('a close that comes BEFORE the approval is refused and writes nothing; the approval then runs as ever — one settlement, one winner', async () => {
    bigStatement(40, () => 1);
    const early = await close();
    expect(early.res.status).toBe(409);
    expect(world.calls.filter((c) => c.write && c.op !== 'courierStatement.updateMany')).toEqual([]);
    expect(world.statements.get('st1')!.matchingClosedAt).toBeNull();
    const { res } = await approve();
    expect(res.status).toBe(200);
    expect(marked()).toHaveLength(40);
    expect(new Set(stockOut()).size).toBe(40);
  });

  it('a press and a press and a close, one after the other: every order is claimed once and its stock goes out once', async () => {
    bigStatement(80, () => 2);
    world.latencyMs = 40; // one slice a press
    await approve();
    await press();
    await press();
    park();
    world.latencyMs = 0;
    const closed = await close();
    expect(closed.res.status).toBe(200);
    expect(closed.body).toMatchObject({ settledOrders: 80, settledEarlier: 75 });
    const claimed = claimedOrders().flatMap((c) => c.split(','));
    expect(claimed).toHaveLength(80);
    expect(new Set(claimed).size).toBe(80);
    const perOrder = new Map<string, number>();
    for (const m of world.invMovements) perOrder.set(m.referenceId, (perOrder.get(m.referenceId) ?? 0) + 1);
    expect([...perOrder.values()].every((n) => n === 2)).toBe(true); // two item lines, one movement each, once
    expect(perOrder.size).toBe(80);
  });
});

/* ───────────────────────────── 12 · READ FROM THE SOURCE ───────────────────────────── */

describe('the clock is wired the same way in both doors — read from the source', () => {
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));
  const APPROVE = 'src/app/api/finance/statements/[id]/route.ts';
  const PRESS = 'src/app/api/finance/statements/[id]/settle-clean/route.ts';

  it.each([[APPROVE], [PRESS]])('%s: the transaction has ONE timeout and it is the shared constant’s — the budget is a share of exactly this', (file) => {
    const given = [...src(file).matchAll(/timeout:\s*([\d_]+)/g)].map((m) => Number(m[1].replace(/_/g, '')));
    expect(given).toEqual([STATEMENT_TX_TIMEOUT_MS]);
  });

  it.each([[APPROVE], [PRESS]])('%s: the first line of the transaction takes its start, and the step is handed it', (file) => {
    const s = src(file);
    expect(s).toMatch(/\$transaction\(\s*async \(tx\) => \{\s*const startedAt = Date\.now\(\);/);
    expect(s).toMatch(/settleCleanLines\(tx, \{[^}]*\bstartedAt\b/);
    expect(s.match(/Date\.now\(\)/g)).toHaveLength(1);
  });

  it('the engine sets the lock timeout only in its transaction-local form, never on the session, and never outside a slice', () => {
    const s = src('src/lib/statement-close.ts');
    expect(s).not.toMatch(/SET\s+(LOCAL\s+|SESSION\s+)?lock_timeout/i);
    expect(s).toMatch(/set_config\('lock_timeout', \$\{value\}, true\)/);
    expect(s.match(/set_config\(/g)).toHaveLength(1);
    expect(s.match(/setLockTimeout\(tx, /g)).toHaveLength(2); // set after the savepoint, given back before its release
    const body = s.slice(s.indexOf('export async function settleCleanLines'));
    const order = ['SAVEPOINT per_line_settlement', 'setLockTimeout(tx, EARLY_STEP_LOCK_WAIT)', 'settleStatement(tx', 'setLockTimeout(tx, LOCK_TIMEOUT_OFF)', 'RELEASE SAVEPOINT per_line_settlement']
      .map((needle) => body.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the cap stays as the second limit and the clock is checked once per slice, before it starts', () => {
    const s = src('src/lib/statement-close.ts');
    expect(s).toMatch(/const clean = waiting\.slice\(0, EARLY_STEP_CAP\);/);
    expect(s.match(/spent\(\) < EARLY_STEP_BUDGET_MS/g)).toHaveLength(1);
  });
});
