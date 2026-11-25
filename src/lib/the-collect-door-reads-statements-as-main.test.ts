import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectTotalRefusal, lineCarriesNoMoney, statementNamingRefusal, type LinkedLine, type NamingLine } from './settlement-gates';
import { stripComments } from './guard-source';

/**
 * 25/11 (A3): «استلمت منه» READS A STATEMENT EXACTLY AS IT DID — BYTE FOR BYTE.
 *
 * A3 lets ONE door («تراجع عن التسليم») set aside a statement line at zero whose word reads «returned». The collect door, the
 * manual statement and «إقفال القديمة» keep asking `statementNamingRefusal` with no such exception. This file runs 1,000 seeded
 * random scenarios — orders with and without a reference, a barcode or a courier; lines at zero and with money, every word
 * («تم إرجاعها» included), rows MATCHED / MISMATCHED / EXCLUDED / missing, answered and not, statements approved and not;
 * links tied by hand — through `statementNamingRefusal`, `lineCarriesNoMoney` and `collectTotalRefusal`, and compares the
 * base64url SHA-256 of every answer with the golden file THE SAME FILE wrote against `git show osm/main:src/lib/settlement-gates.ts`
 * (A3_WRITE_GOLDEN=1, with main's file in place).
 */

const GOLDEN = join(__dirname, 'the-collect-door-reads-statements-as-main.main-golden.json');
const SCENARIOS = 1000;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APPROVED_AT = '2026-11-20T10:00:00.000Z';
const WORDS = ['تم إرجاعها', 'تم ارجاعها', 'مؤجلة', null, '', 'تم توصيلها', 'حالة جديدة', 'ملغاة'];
const RESULTS = ['MATCHED', 'MISMATCHED', 'EXCLUDED', 'MISSING_IN_SYSTEM'];

function scenario(seed: number) {
  const r = prng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const statement = () => {
    const approved = r() < 0.5;
    return {
      reference: `ST-${int(1, 4)}`,
      status: approved ? pick(['APPROVED', 'MATCHED']) : pick(['DRAFT', 'IMPORTED', 'MATCHED']),
      approvedAt: approved && r() < 0.8 ? APPROVED_AT : null,
      deliveryProviderId: pick(['p1', 'p2']),
    };
  };
  const row = () => ({
    result: pick(RESULTS),
    resolution: pick([null, null, 'ACCEPTED_COURIER', 'OURS_STANDS']),
    appliedAt: r() < 0.15 ? APPROVED_AT : null,
    matchedBy: pick([null, 'BARCODE', 'MERCHANT_REF', 'MANUAL']),
  });
  const orders = Array.from({ length: int(1, 3) }, (_, i) => ({
    ...(r() < 0.8 ? { id: `o${i}` } : {}),
    orderNumber: `ORD-2026-${1000 + i}`,
    merchantRef: pick(['R1', 'R2', 'R3', null]),
    trackingNumber: pick(['B1', 'B2', 'B3', null]),
    deliveryProviderId: pick(['p1', 'p2', null]),
  }));
  const lines = Array.from({ length: int(0, 5) }, () => ({
    merchantRef: pick(['R1', 'R2', 'R3', null]),
    barcode: pick(['B1', 'B2', 'B3', null]),
    // Figures and words the collect door never reads — present so a rule that started reading them would change an answer.
    amount: pick([0, 0, 0, 25, -3]),
    collected: pick([null, 0, 3]),
    fee: pick([null, 0, 3]),
    status: pick(WORDS),
    statement: statement(),
    ...(r() < 0.15 ? {} : { matches: Array.from({ length: int(0, 3) }, row) }),
  }));
  const links = Array.from({ length: int(0, 3) }, () => ({
    orderId: pick(['o0', 'o1', 'o2', null]),
    ...(r() < 0.2 ? {} : { result: pick(RESULTS) }),
    resolution: pick([null, 'ACCEPTED_COURIER']),
    appliedAt: null,
    matchedBy: pick([null, 'MANUAL']),
    statement: statement(),
    statementLine: { amount: pick([0, 25]), collected: null, fee: null, status: pick(WORDS) },
  }));
  const total = { expected: pick([-5, 0, 12.5, 40]), owed: 5, currency: pick(['USD', 'SYP']), count: int(1, 3) };
  return { orders, lines, links, total };
}

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url');

function answers() {
  const out: string[] = [];
  for (let seed = 1; seed <= SCENARIOS; seed++) {
    const s = scenario(seed);
    out.push(
      digest({
        naming: statementNamingRefusal(s.orders, s.lines as NamingLine[], s.links as LinkedLine[]),
        // each order alone too — how «إقفال القديمة» asks
        each: s.orders.map((o) => statementNamingRefusal([o], s.lines as NamingLine[], s.links as LinkedLine[])),
        noMoney: s.lines.map((l) => lineCarriesNoMoney(l)),
        total: collectTotalRefusal(s.total),
      })
    );
  }
  return out;
}

describe('the collect door reads a statement exactly as main did', () => {
  it(`${SCENARIOS} random scenarios: every answer's digest equals main's`, () => {
    const now = answers();
    if (process.env.A3_WRITE_GOLDEN === '1') {
      writeFileSync(GOLDEN, JSON.stringify({ scenarios: SCENARIOS, all: digest(now), digests: now }) + '\n');
    }
    expect(existsSync(GOLDEN), 'the golden file written against osm/main').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { scenarios: number; all: string; digests: string[] };
    expect(golden.scenarios).toBe(SCENARIOS);
    const differ = now.map((d, i) => (d === golden.digests[i] ? null : i + 1)).filter((x) => x !== null);
    expect(differ, 'seeds whose answer differs from main').toEqual([]);
    expect(digest(now)).toBe(golden.all);
  });

  it('the scenarios do reach the case A3 changes: zero «returned» lines with an unanswered MISMATCHED row that the collect door refuses on', () => {
    let reached = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = scenario(seed);
      for (const o of s.orders) {
        const zeroReturned = s.lines.filter(
          (l) =>
            l.amount === 0 &&
            (l.status === 'تم إرجاعها' || l.status === 'تم ارجاعها') &&
            (l.matches ?? []).some((m) => m.result === 'MISMATCHED' && m.resolution === null) &&
            ((!!o.merchantRef && l.merchantRef === o.merchantRef) ||
              (!!o.trackingNumber && l.barcode === o.trackingNumber && l.statement.deliveryProviderId === o.deliveryProviderId))
        );
        if (zeroReturned.length > 0 && statementNamingRefusal([o], zeroReturned as NamingLine[])) reached++;
      }
    }
    expect(reached).toBeGreaterThanOrEqual(10);
  });

  it('the three doors that use the collect rule still call it, and none of them calls the undo\'s rule', () => {
    for (const f of ['src/app/api/ops/tracking/collect/route.ts', 'src/lib/manual-statement.ts', 'src/lib/legacy-closeout.ts', 'src/lib/legacy-closeout-picked.ts']) {
      const src = stripComments(readFileSync(join(process.cwd(), f), 'utf8'));
      expect(src, f).toContain('statementNamingRefusal(');
      expect(src, f).not.toMatch(/undoDeliveryNamingRefusal|zeroReturnCarriesNoMoney|isZeroReturnedLine/);
    }
  });
});
