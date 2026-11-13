import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoFile, stripComments } from './guard-source';

/**
 * «طلب تبديل» IS THE COURIER'S FIGURE WITH A REASON ATTACHED — NOT A NEW MONEY PATH (the owner, 13/11).
 *
 *   «احيانا بيكون طلب تبديل او زبون وصلو الطلب ناقص فنبعثلو حبة فلازم يا تعمل خيار يعطيك انو طلب تبديل»
 *
 * The design keeps the money paths UNTOUCHED: the stored answer stays `ACCEPTED_COURIER` (every reader of that literal — the matcher, the
 * claim, the close, the stats — reads what it always read), and a column beside it, `resolutionKind`, says WHY. This file holds that
 * design in four places:
 *
 *   · THE WORDS AND THE SMALL RULES — what the qualifier is, when a row counts as an exchange, what is written beside every answer;
 *   · THE SHORTFALL — `proposeShortfalls` is the ONLY writer of a «فرق تحصيل» from a statement line, and an exchange is dropped before it
 *     measures, names, writes or asks anything;
 *   · THE TIMELINE — the order's history reads «طلب تبديل» in Arabic, never a code;
 *   · THE SOURCE — which files may name the qualifier at all (so a money path cannot start to read it without a test turning red), that
 *     every door that writes an answer writes the qualifier too, and that nothing else can create a penalty from a match.
 */

import {
  EXCHANGE_AR,
  EXCHANGE_APPLIED_ACTION,
  EXCHANGE_COMBINATION_SENTENCE,
  EXCHANGE_KIND,
  EXCHANGE_MEANING,
  EXCHANGE_NOT_IN_BULK_SENTENCE,
  RESOLUTIONS,
  RESOLUTION_AR,
  isExchange,
} from './settlement-difference';
import {
  DECISIONS,
  DECISION_AR,
  decisionData,
  decisionKind,
  decisionMatrix,
  decisionNoteBody,
  type DecisionFacts,
} from './settlement-decisions';
import { claimingRowWhere } from './match-integrity';
import { ON_THE_COMPANY, proposeShortfalls, type ShortfallCandidate, type ShortfallScope } from './shortfall';
import { describeAction, summariseChange } from './audit-view';

const arabicOnly = (s: string) => !/[A-Za-z]/.test(s);

/* ───────────────────────── the words and the small rules ───────────────────────── */

describe('the words', () => {
  it('the qualifier is EXCHANGE, the answer is «طلب تبديل», and the hint is the owner’s own sentence', () => {
    expect(EXCHANGE_KIND).toBe('EXCHANGE');
    expect(EXCHANGE_AR).toBe('طلب تبديل');
    expect(EXCHANGE_MEANING).toBe('تبديل أو حبة ناقصة بعتناها للزبون — ما إلها ثمن؛ رقم الشركة هو الصحيح وما بينحسب خصم على حدا.');
  });

  it('everything a person reads is Arabic — the answer, the hint, the two refusals', () => {
    for (const text of [EXCHANGE_AR, EXCHANGE_MEANING, EXCHANGE_COMBINATION_SENTENCE, EXCHANGE_NOT_IN_BULK_SENTENCE]) expect(arabicOnly(text), text).toBe(true);
  });

  it('it is NOT a resolution: the answers that are stored are still the old three, and the exchange joined none of the lists built from them', () => {
    expect([...DECISIONS]).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
    expect([...RESOLUTIONS]).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS']);
    expect(Object.keys(RESOLUTION_AR).sort()).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS']);
    expect(Object.keys(DECISION_AR).sort()).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
    expect(Object.values(DECISION_AR)).not.toContain(EXCHANGE_AR);
  });
});

describe('`isExchange` — the one rule every reader asks', () => {
  it('is the courier’s figure with the qualifier, and nothing else', () => {
    expect(isExchange({ resolution: 'ACCEPTED_COURIER', resolutionKind: 'EXCHANGE' })).toBe(true);
    for (const resolutionKind of [null, undefined, '', 'exchange', 'SOMETHING_ELSE']) {
      expect(isExchange({ resolution: 'ACCEPTED_COURIER', resolutionKind }), String(resolutionKind)).toBe(false);
    }
  });

  it('a qualifier beside any other answer — or none — is read as nothing', () => {
    for (const resolution of ['OURS_STANDS', 'UNDER_REVIEW', null, undefined, '']) {
      expect(isExchange({ resolution, resolutionKind: 'EXCHANGE' }), String(resolution)).toBe(false);
    }
    expect(isExchange({})).toBe(false);
  });
});

describe('what is written beside every answer', () => {
  it('`decisionKind()` clears; `decisionKind(true)` sets — and it always has the key, so a spread of it always writes', () => {
    expect(decisionKind()).toEqual({ resolutionKind: null });
    expect(decisionKind(false)).toEqual({ resolutionKind: null });
    expect(decisionKind(true)).toEqual({ resolutionKind: 'EXCHANGE' });
    for (const exchange of [true, false, undefined]) expect(Object.prototype.hasOwnProperty.call(decisionKind(exchange), 'resolutionKind')).toBe(true);
  });

  it('`decisionData` is the answer’s own shape and is left exactly as it was — the qualifier is its own spread', () => {
    const at = new Date('2026-11-13T01:00:00Z');
    expect(decisionData({ resolution: 'ACCEPTED_COURIER', note: 'تبديل حبة ناقصة', userId: 'u1', at })).toEqual({
      resolution: 'ACCEPTED_COURIER', resolutionNote: 'تبديل حبة ناقصة', resolvedById: 'u1', resolvedAt: at,
    });
  });

  it('the note on the order says «طلب تبديل» for an exchange and the answer’s own word for every other — and the plain note is byte for byte what it was', () => {
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'ACCEPTED_COURIER', gap: 20, note: 'تبديل حبة ناقصة', exchange: true })).toBe(
      'مطابقة كشف ST-1: طلب تبديل — الفرق 20. تبديل حبة ناقصة'
    );
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'ACCEPTED_COURIER', gap: 2, note: 'خصم متفق عليه' })).toBe(
      'مطابقة كشف ST-1: اعتُمد رقم الشركة — الفرق 2. خصم متفق عليه'
    );
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'ACCEPTED_COURIER', gap: 2, note: 'خصم متفق عليه', exchange: false })).toBe(
      'مطابقة كشف ST-1: اعتُمد رقم الشركة — الفرق 2. خصم متفق عليه'
    );
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'UNDER_REVIEW', gap: null, note: 'ننتظر' })).toBe('مطابقة كشف ST-1: قيد المراجعة. ننتظر');
  });

  it('…and an `exchange` flag beside another answer is ignored by the words as it is by the rule: the note reads the answer that was given', () => {
    expect(decisionNoteBody({ statement: 'ST-1', resolution: 'OURS_STANDS', gap: 2, note: 'نطالب بالفرق', exchange: true })).toBe(
      'مطابقة كشف ST-1: رقمنا هو المعتمد — الفرق 2. نطالب بالفرق'
    );
  });
});

describe('the matrix has no cell of its own for it — so it cannot be allowed anywhere their figure is not', () => {
  const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
    hasOrder: true, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', openRequests: [], claimedElsewhere: false,
    statementApproved: false, expectedAmount: 20, statementAmount: 18, courierOutcome: null, minorUnit: 3, ...over,
  });

  it('three cells, the three answers — never a fourth', () => {
    expect(Object.keys(decisionMatrix(facts())).sort()).toEqual(['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']);
  });

  it('the matching list’s door asks that cell about an exchange: its answer IS the courier’s figure — read from the very sources that send it', () => {
    // The single door: the matrix is indexed by the stored answer, and an exchange's stored answer is ACCEPTED_COURIER (the route
    // refuses `exchange` beside any other). The screen: the button is disabled by `verdict('ACCEPTED_COURIER')`.
    const route = stripComments(repoFile('src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts'));
    expect(route).toMatch(/decisionMatrix\(facts\.get\(match\.id\)!\)\[resolution\]/);
    expect(route).toMatch(/exchange && resolution !== 'ACCEPTED_COURIER'/);
    const screen = stripComments(repoFile('src/components/screens/finance/DifferenceActions.tsx'));
    expect(screen).toMatch(/disabled=\{busy !== null \|\| !verdict\('ACCEPTED_COURIER'\)\.allowed\}[\s\S]{0,200}title=\{EXCHANGE_MEANING\}/);
  });
});

/* ───────────────────────── the shortfall ───────────────────────── */

describe('`proposeShortfalls` — an exchange is nobody’s shortfall', () => {
  const SCOPE: ShortfallScope = {
    companyId: 'c1', storeId: 's1', approverId: 'u-approver',
    statement: { id: 'st1', reference: 'JO-ST-1', currencyCode: 'USD', importedAt: new Date('2026-10-20T10:00:00Z') },
    fallbackDeliveredAt: new Date('2026-10-19T00:00:00Z'),
    minorUnit: 2,
  };
  const FOLLOWER = { id: 'u-follow', name: 'سارة', role: 'FOLLOW_UP_AGENT' };
  const SCREENSHOT = { expectedAmount: 17, expectedFee: 3, statementAmount: -3, statementFee: 3 };
  const cand = (n: string, over: Partial<ShortfallCandidate> = {}): ShortfallCandidate => ({
    matchId: `m-${n}`, orderId: `o-${n}`, orderNumber: `ORD-${n}`, ...SCREENSHOT, explanation: 'تبديل حبة ناقصة', ...over,
  });
  const fakeTx = () => ({
    order: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, shippingStatus: 'DELIVERED', deliveredAt: new Date('2026-10-18T09:00:00Z'), moderatorId: 'u-mod', confirmedById: 'u-conf' }))
      ),
    },
    deliveryAttempt: { findMany: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) => where.orderId.in.map((orderId) => ({ orderId, deliveryAgentId: FOLLOWER.id }))) },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id?.in ? [FOLLOWER, { id: 'u-owner', name: 'المالك', role: 'SUPER_ADMIN' }].filter((u) => where.id!.in.includes(u.id)) : [FOLLOWER]
      ),
    },
    penalty: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'pen-1' })) },
    orderActivity: { create: vi.fn() },
  });
  const touched = (tx: ReturnType<typeof fakeTx>) => [tx.order.findMany, tx.deliveryAttempt.findMany, tx.user.findMany, tx.penalty.findMany, tx.penalty.create, tx.orderActivity.create];

  it('the plain line of the screenshot charges 20 to the one at the door — so the fixture bites', async () => {
    const tx = fakeTx();
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1')]);
    expect(r.charges).toEqual([expect.objectContaining({ userId: 'u-follow', amount: 20 })]);
    expect(tx.penalty.create).toHaveBeenCalledTimes(1);
  });

  it('the same line flagged as an exchange: nothing is measured, read, named, written or asked — the result is empty', async () => {
    const tx = fakeTx();
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { exchange: true })]);
    expect(r).toEqual({ charges: [], onCompany: [], stop: null });
    for (const fn of touched(tx)) expect(fn).not.toHaveBeenCalled();
  });

  it('with no door on the parcel the plain line ASKS (a stop with the line and the candidates) — and the exchange does not', async () => {
    const noDoor = () => {
      const tx = fakeTx();
      tx.deliveryAttempt.findMany = vi.fn(async () => []);
      return tx;
    };
    const asked = await proposeShortfalls(noDoor() as never, SCOPE, [cand('1')]);
    expect(asked.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED', lines: [expect.objectContaining({ matchId: 'm-1', amount: 20 })] });

    const through = await proposeShortfalls(noDoor() as never, SCOPE, [cand('1', { exchange: true })]);
    expect(through).toEqual({ charges: [], onCompany: [], stop: null });
  });

  it('a mixed statement: the plain line is charged and the exchange is not, in the same call', async () => {
    const tx = fakeTx();
    const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', { exchange: true }), cand('2')]);
    expect(r.charges.map((c) => c.matchId)).toEqual(['m-2']);
    expect(tx.penalty.create).toHaveBeenCalledTimes(1);
    expect((tx.penalty.create.mock.calls[0] as unknown as [{ data: { settlementMatchId: string } }])[0].data.settlementMatchId).toBe('m-2');
    expect(tx.orderActivity.create).toHaveBeenCalledTimes(1);
  });

  it('whatever the approver NAMES for it is never read — a person, the owner (refused for a plain line), or «على الشركة»', async () => {
    for (const naming of [{ 'm-1': 'u-follow' }, { 'm-1': 'u-owner' }, { 'm-1': ON_THE_COMPANY }, { 'm-1': 'u-ghost' }]) {
      const tx = fakeTx();
      tx.deliveryAttempt.findMany = vi.fn(async () => []);
      const r = await proposeShortfalls(tx as never, { ...SCOPE, naming }, [cand('1', { exchange: true })]);
      expect(r, JSON.stringify(naming)).toEqual({ charges: [], onCompany: [], stop: null });
      expect(tx.penalty.create).not.toHaveBeenCalled();
      expect(tx.orderActivity.create).not.toHaveBeenCalled();
    }
  });

  it('`exchange: false` or no flag is the plain line, as every older caller sends it', async () => {
    for (const over of [{ exchange: false }, {}]) {
      const tx = fakeTx();
      const r = await proposeShortfalls(tx as never, SCOPE, [cand('1', over)]);
      expect(r.charges, JSON.stringify(over)).toHaveLength(1);
    }
  });
});

/* ───────────────────────── the timeline and the audit trail ───────────────────────── */

const { db } = vi.hoisted(() => ({
  db: {
    orderClaimHistory: { findMany: vi.fn() },
    orderStatusLog: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
    callLog: { findMany: vi.fn() },
    callHelperReading: { findMany: vi.fn() },
    deliveryAttempt: { findMany: vi.fn() },
    orderNote: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderIssue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

describe('the order’s timeline reads the exchange in Arabic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const table of [db.orderStatusLog, db.orderClaimHistory, db.orderContactAttempt, db.deliveryAttempt, db.orderNote, db.orderChangeRequest, db.orderIssue, db.callLog, db.callHelperReading]) {
      table.findMany.mockResolvedValue([]);
    }
    db.user.findMany.mockResolvedValue([{ id: 'u1', name: 'المحاسب' }]);
  });

  const line = (action: string, id: string) => ({
    id, createdAt: new Date('2026-11-12T10:00:00Z'), action, userId: 'u1', newStatus: null,
    metadata: JSON.stringify({ statement: 'ST-1', decision: 'ACCEPTED_COURIER', explanation: 'تبديل حبة ناقصة', collected: 0 }),
  });

  it('the exchange’s settlement line has its own Arabic sentence — not the code, and not the discount’s sentence', async () => {
    const { orderTimeline } = await import('./order-timeline');
    db.orderActivity.findMany.mockResolvedValue([line('SETTLEMENT_DECISION_APPLIED', 'a1'), line(EXCHANGE_APPLIED_ACTION, 'a2')]);
    const events = await orderTimeline(db as never, 'o1');
    const [plain, exchange] = events.map((e) => e.title);
    expect(plain).toBe('سُوّي الطلب برقم الشركة بعد بتّ مكتوب');
    expect(exchange).not.toBe(plain);
    expect(exchange).not.toBe(EXCHANGE_APPLIED_ACTION);
    expect(exchange).toContain(EXCHANGE_AR);
    expect(arabicOnly(exchange), exchange).toBe(true);
    expect(exchange).toContain('لا يُحسب خصماً');
  });

  it('the action’s code is stable — it is what the close writes — and no Latin word reaches the page', async () => {
    expect(EXCHANGE_APPLIED_ACTION).toBe('SETTLEMENT_EXCHANGE_APPLIED');
    const { orderTimeline } = await import('./order-timeline');
    db.orderActivity.findMany.mockResolvedValue([line(EXCHANGE_APPLIED_ACTION, 'a2')]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).not.toMatch(/[A-Z_]{6,}/);
    expect(event.actorName).toBe('المحاسب');
  });
});

describe('the audit trail reads the exchange in Arabic', () => {
  it('the answer’s audit row is the same action as every other answer’s, and that action reads in Arabic', () => {
    expect(describeAction('SETTLEMENT_DIFFERENCE_RESOLVED', 'SettlementMatch')).toBe('تسوية فرق كشف');
    expect(arabicOnly(describeAction('SETTLEMENT_DIFFERENCE_RESOLVED', 'SettlementMatch'))).toBe(true);
  });

  it('the change column shows «طلب تبديل» among the first fields of an exchange’s row', () => {
    const newData = { resolution: 'ACCEPTED_COURIER', kind: EXCHANGE_KIND, answer: EXCHANGE_AR, explanation: 'تبديل حبة ناقصة', orderNumber: 'ORD-1', statement: 'ST-1', gap: 20 };
    expect(summariseChange(JSON.stringify(newData))).toContain('answer: طلب تبديل');
  });
});

/* ───────────────────────── the source ───────────────────────── */

const SRC = join(process.cwd(), 'src');
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');
const SOURCES = files(SRC).map((p) => ({ name: rel(p), code: stripComments(readFileSync(p, 'utf8')) }));
const namesIt = (re: RegExp) => SOURCES.filter((s) => re.test(s.code)).map((s) => s.name).sort();

describe('which files may name the qualifier at all — a money path cannot start to read it without this turning red', () => {
  it('only these files mention `resolutionKind`, and none of them is a place that settles, pays, matches or counts stock', () => {
    expect(namesIt(/resolutionKind/)).toEqual([
      'src/app/api/finance/settlement-differences/route.ts',
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
      'src/app/api/finance/statements/[id]/route.ts',
      'src/components/screens/finance/DifferenceActions.tsx',
      'src/components/screens/finance/MatchingScreen.tsx',
      'src/lib/settlement-decisions.ts',
      'src/lib/settlement-difference.ts',
      'src/lib/statement-close.ts',
    ]);
    // (The bulk door writes the qualifier through `decisionKind()` and never names the column.)
  });

  it('and only these ask `isExchange` or name the kind constant: the rule itself, the close (twice), the screen (the chip) and the doors that write it', () => {
    expect(namesIt(/\bisExchange\b/)).toEqual([
      'src/components/screens/finance/DifferenceActions.tsx',
      'src/lib/settlement-difference.ts',
      'src/lib/statement-close.ts',
    ]);
    expect(namesIt(/\bEXCHANGE_KIND\b/)).toEqual([
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
      'src/components/screens/finance/DifferenceActions.tsx',
      'src/lib/settlement-decisions.ts',
      'src/lib/settlement-difference.ts',
      'src/lib/statement-close.ts',
    ]);
  });

  it('the places that settle money, match lines or read the answer as a literal never name the exchange', () => {
    for (const name of [
      'src/lib/settlement.ts', 'src/lib/match-integrity.ts', 'src/lib/settlement-gates.ts', 'src/lib/wallets.ts', 'src/lib/commission.ts',
      'src/lib/stock-consumption.ts', 'src/lib/legacy-closeout.ts', 'src/lib/legacy-closeout-picked.ts', 'src/lib/parcel-swap.ts', 'src/lib/hand-link.ts',
      'src/lib/statement-open-lines.ts', 'src/lib/money.ts',
    ]) {
      const code = SOURCES.find((s) => s.name === name)?.code;
      expect(code, `${name} is a source file`).toBeTruthy();
      expect(code, name).not.toMatch(/EXCHANGE|resolutionKind|isExchange|طلب تبديل/);
    }
  });

  it('the stored answer is read as the old literal by every money path: the matcher’s reservation still says ACCEPTED_COURIER', () => {
    expect(claimingRowWhere()).toEqual([{ result: 'MATCHED' }, { resolution: 'ACCEPTED_COURIER' }]);
    const settlement = SOURCES.find((s) => s.name === 'src/lib/settlement.ts')!.code;
    expect(settlement.match(/resolution === 'ACCEPTED_COURIER'/g)!.length).toBeGreaterThanOrEqual(1);
    expect(settlement.match(/resolution: 'ACCEPTED_COURIER'/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('no file writes a resolution VALUE other than the three words — the exchange is never stored as an answer', () => {
    expect(namesIt(/resolution:\s*'EXCHANGE'|resolution === 'EXCHANGE'|resolution: EXCHANGE_KIND/)).toEqual([]);
    expect(namesIt(/ACCEPTED_COURIER\s*\|\s*OURS_STANDS\s*\|\s*EXCHANGE/)).toEqual([]);
  });
});

describe('every door that writes an answer writes its qualifier too', () => {
  it('the files that build an answer’s data with `decisionData(` are exactly the single door and the bulk door — and each spreads `decisionKind(` beside it', () => {
    const writers = SOURCES.filter((s) => /\bdecisionData\(/.test(s.code) && s.name !== 'src/lib/settlement-decisions.ts');
    expect(writers.map((s) => s.name).sort()).toEqual([
      'src/app/api/finance/statements/[id]/decisions/route.ts',
      'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts',
    ]);
    for (const w of writers) {
      expect(w.code, w.name).toMatch(/\.\.\.decisionData\(\{[^}]*\}\),\s*\.\.\.decisionKind\(/);
    }
  });

  it('the single door passes what the person asked, the bulk door passes nothing — it can never set the mark', () => {
    const single = SOURCES.find((s) => s.name === 'src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts')!.code;
    const bulk = SOURCES.find((s) => s.name === 'src/app/api/finance/statements/[id]/decisions/route.ts')!.code;
    expect(single).toMatch(/\.\.\.decisionKind\(exchange\)/);
    expect(bulk).toMatch(/\.\.\.decisionKind\(\)/);
    expect(bulk).not.toMatch(/decisionKind\(\s*(true|exchange)/);
  });

  it('the doors that record an answer still name no money word (the old guard, asked again of the new text)', () => {
    for (const name of ['src/app/api/finance/statements/[id]/matches/[matchId]/resolve/route.ts', 'src/app/api/finance/statements/[id]/decisions/route.ts']) {
      const code = SOURCES.find((s) => s.name === name)!.code;
      for (const word of ['walletMovement', 'recordMovement', 'COURIER_SETTLEMENT', 'settlementStatus', 'collectedAmount', 'markPayableForOrders']) {
        expect(code, `${word} in ${name}`).not.toContain(word);
      }
    }
  });
});

describe('nothing but `proposeShortfalls` writes a «فرق تحصيل» from a statement line', () => {
  it('the files that create a penalty are the shortfall writer and the payroll rules’ own service — no third', () => {
    expect(namesIt(/\.penalty\.create\(/)).toEqual(['src/lib/penalty-service.ts', 'src/lib/shortfall.ts']);
  });

  it('inside the service, the only creations that carry a statement line are the retarget of an EXISTING charge — never a first one', () => {
    const service = SOURCES.find((s) => s.name === 'src/lib/penalty-service.ts')!.code;
    const withLine = service.split('tx.penalty.create(').slice(1).filter((chunk) => /settlementMatchId/.test(chunk.slice(0, 700)));
    expect(withLine).toHaveLength(1);
    // …and it reads the charge it moves first, refusing a row that is not a shortfall tied to a line.
    expect(service).toMatch(/row\.kind !== SHORTFALL_KIND \|\| !row\.settlementMatchId\) throw new PenaltyRefused\('NOT_SHORTFALL'\)/);
  });

  it('the shortfall writer drops an exchange BEFORE it measures — it is the first thing done to the candidates', () => {
    const shortfall = SOURCES.find((s) => s.name === 'src/lib/shortfall.ts')!.code;
    expect(shortfall).toMatch(/const owing = candidates\s*\.filter\(\(c\) => !c\.exchange\)\s*\.map\(\(c\) => \(\{ c, amount: shortfallOf\(c, scope\.minorUnit\) \}\)\)/);
  });

  it('the close hands it the flag, from the one rule — and only the shortfall and the timeline sentence read it', () => {
    const close = SOURCES.find((s) => s.name === 'src/lib/statement-close.ts')!.code;
    expect(close).toMatch(/exchange: isExchange\(m\),/);
    expect(close.match(/\bisExchange\(/g)).toHaveLength(2);

    // The two regions that may name the exchange: the candidates handed to the shortfall, and the timeline sentence written for an accepted row.
    const a = [close.indexOf('const shortfall = await proposeShortfalls('), close.indexOf('if (shortfall.stop) {')];
    const b = [close.indexOf('const exchange = isExchange(m);'), close.indexOf('const claims = matches.filter(')];
    for (const edge of [...a, ...b]) expect(edge, 'a region of statement-close moved').toBeGreaterThan(0);
    const inRegion = (at: number) => (at > a[0] && at < a[1]) || (at > b[0] && at < b[1]);
    const lineAt = (at: number) => close.slice(close.lastIndexOf('\n', at) + 1, close.indexOf('\n', at));
    // What DECLARES the qualifier (the import, the select, the row's type) is not deciding anything with it.
    const declares = (line: string) => /^\s*import /.test(line) || /^\s*resolutionKind\??:/.test(line);
    const names = [...close.matchAll(/\bisExchange\(|\bEXCHANGE_KIND\b|\bEXCHANGE_APPLIED_ACTION\b|resolutionKind/g)].map((m) => m.index!);
    const deciding = names.filter((at) => !declares(lineAt(at)));
    expect(deciding.length, 'the close names the exchange where it decides').toBeGreaterThanOrEqual(4);
    for (const at of deciding) expect(inRegion(at), lineAt(at).trim()).toBe(true);

    // And no MONEY statement of the close sits inside either region: the claim that settles, the commission, the delivery, the stock, the customer.
    for (const money of ["settlementStatus: 'SETTLED'", 'await markPayableForOrders(', 'await consumeOrderStock(', 'tx.order.update(', 'tx.customer.update(', 'collectedAmount:']) {
      const at = [...close.matchAll(new RegExp(money.replace(/[()]/g, '\\$&'), 'g'))].map((m) => m.index!);
      expect(at.length, money).toBeGreaterThan(0);
      for (const i of at) expect(inRegion(i), `${money} is inside a region that names the exchange`).toBe(false);
    }
  });

  it('and no other place decides anything from the kind in the doors that run the close — the approval and «إغلاق المطابقة» only read the rows through the select', () => {
    for (const name of ['src/app/api/finance/statements/[id]/route.ts', 'src/app/api/finance/statements/[id]/close/route.ts', 'src/app/api/finance/statements/[id]/settle-clean/route.ts']) {
      const code = SOURCES.find((s) => s.name === name)!.code;
      expect(code, name).not.toMatch(/isExchange|EXCHANGE_KIND/);
    }
  });
});
