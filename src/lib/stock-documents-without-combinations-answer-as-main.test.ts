import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, type Row } from './stock-transfers.memory-db.test';
import { EXIT_REASONS } from './stock-exit-reasons';

/**
 * A PRODUCT WITHOUT COMBINATIONS MOVES EXACTLY AS BEFORE (the warehouse plan, W8b).
 *
 * W8b taught the transfer (send · receive · cancel · the difference), the exit (request · approve · reject) and the
 * opening placement (preview · press) to carry a product's combinations. For a product that has none — every product
 * of these scenarios — nothing may change: the same answers, the same refusals (code, sentence, status, what they
 * carry), the same rows with the same values, the same writes in the same order, the same locks.
 *
 * The frozen file beside this test holds what the MAIN branch's code answered for the same random scenarios — `git show
 * osm/main:` of src/lib/stock-transfers.ts, src/lib/stock-exits.ts and src/lib/warehouse-placement.ts — run against the
 * in-memory database of the transfer tests. This test runs today's code on the very same scenarios and compares
 * everything, `toEqual`. Each scenario: a random store, its placement (preview, then a press that is sometimes exact,
 * sometimes not, sometimes signed by nobody or naming a wrong warehouse), then a dozen random documents by three people
 * — sends of every shape (too much, the same product twice, the same warehouse twice, a stopped or a foreign warehouse,
 * a reused id), receipts (whole, short, zero, over, by the sender), cancels, differences, exit requests, approvals and
 * rejections.
 *
 * TO REGENERATE (only if main itself changes these files): copy main's three files next to their originals as
 * `stock-transfers.w8b-main.ts`, `stock-exits.w8b-main.ts` (its `./stock-transfers` import pointed at the copy) and
 * `warehouse-placement.w8b-main.ts`, run this file with `W8B_WRITE_GOLDEN=1`, delete the copies.
 *
 * 20/11 (W7b): ONE answer of the frozen file was changed by hand, on purpose, and nothing else: a send to a warehouse of
 * another country with NO destination store named (7 sends over the 70 seeds). Old: 400 KIND_NOT_BUILT «لسا مش مبني» with
 * `{ kind: 'BETWEEN_COUNTRIES' }`. New: 400 TO_OTHER_COUNTRY with its sentence and no extra — transfers across stores and
 * countries are built, and such a warehouse holds none of this store's goods. Every other answer, row, write and lock of
 * the frozen file is main's, untouched.
 */

const H = vi.hoisted(() => ({ hex: 0 }));
// A twin's batch number ends in 6 random hex digits (`batch-split.twinBatchNumber`): counted here, so both runs agree.
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  const randomBytes = (n: number) => Buffer.from(String(++H.hex).padStart(n * 2, '0').slice(-n * 2), 'hex');
  return { ...real, randomBytes, default: { ...real, randomBytes } };
});

const GOLDEN = join(__dirname, 'stock-documents.w8b-main-golden.json');
const WRITE = process.env.W8B_WRITE_GOLDEN === '1';
const SEEDS = 70;

type Mod = Record<string, (...a: never[]) => Promise<Row>>;
interface Impl {
  T: Mod;
  E: Mod;
  P: Mod;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C = 'c1';
const S = 's1';
const PEOPLE = ['u1', 'u2', 'u3'];
const SHIPPING = ['PENDING', 'READY_TO_SHIP', 'READY_FOR_PICKUP', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'];
const CONFIRMATION = ['PENDING', 'CONFIRMED', 'CONFIRMED', 'REJECTED'];

function world(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  const days = [0, 1, 3].map((d) => new Date(Date.UTC(2026, 9, 1 + d)));
  const data: Record<string, Row[]> = {
    country: [
      { id: 'k1', companyId: C, isActive: true, minorUnit: 2 },
      { id: 'k2', companyId: C, isActive: true, minorUnit: 3 },
    ],
    store: [
      { id: S, companyId: C, countryId: 'k1', name: 'المتجر' },
      { id: 's2', companyId: C, countryId: 'k1', name: 'متجر تاني' },
    ],
    warehouse: [
      { id: 'w1', companyId: C, countryId: 'k1', name: 'أ', isActive: true },
      { id: 'w2', companyId: C, countryId: 'k1', name: 'ب', isActive: true },
      { id: 'wOff', companyId: C, countryId: 'k1', name: 'موقوف', isActive: false },
      { id: 'wJ', companyId: C, countryId: 'k2', name: 'برّا', isActive: true },
    ],
    product: [],
    productionBatch: [],
    order: [],
    orderItem: [],
    orderAddOn: [],
  };
  const nProducts = 1 + int(4);
  let created = 0;
  for (let p = 0; p < nProducts; p++) {
    data.product.push({ id: `p${p}`, companyId: C, storeId: S, name: `منتج ${p}`, sku: `SKU${p}` });
    for (let b = 1 + int(3); b > 0; b--) {
      const produced = 5 + int(30);
      const sold = int(produced);
      const cost = r() < 0.15 ? 0 : Math.round(r() * 100000) / 10000;
      data.productionBatch.push({
        id: `b${p}-${b}`,
        companyId: C,
        storeId: S,
        productId: `p${p}`,
        batchNumber: `RCV-${p}-${b}`,
        quantityProduced: produced,
        quantitySold: sold,
        quantityRemaining: produced - sold,
        quantityMovedIn: 0,
        quantityMovedOut: 0,
        manufacturingCost: 0,
        packagingCost: 0,
        rawMaterialCost: 0,
        otherCosts: 0,
        totalProductionCost: cost * produced,
        costPerUnit: cost,
        productionDate: days[int(days.length)],
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++created)),
        status: 'COMPLETED',
        notes: cost === 0 ? 'عيّنة' : null,
        warehouseId: null,
        inTransitTransferId: null,
        splitFromBatchId: null,
      });
    }
  }
  for (let o = int(5); o > 0; o--) {
    const placedLater = r() < 0.5;
    data.order.push({
      id: `o${o}`,
      companyId: C,
      storeId: S,
      confirmationStatus: CONFIRMATION[int(CONFIRMATION.length)],
      shippingStatus: SHIPPING[int(SHIPPING.length)],
      shippedAt: r() < 0.2 ? new Date('2026-10-02T00:00:00Z') : null,
      labelPrintedAt: null,
      // Some orders are sourced from a warehouse (W4a) — their reserved units are not free there.
      sourceWarehouseId: placedLater ? (r() < 0.5 ? 'w1' : 'w2') : null,
    });
    data.orderItem.push({ id: `oi${o}`, orderId: `o${o}`, companyId: C, productId: `p${int(nProducts)}`, reservedQty: int(4) });
    if (r() < 0.3) data.orderAddOn.push({ id: `oa${o}`, orderId: `o${o}`, companyId: C, productId: `p${int(nProducts)}`, reservedQty: int(3) });
  }
  return { data, nProducts };
}

const CHANGING = [
  'productionBatch',
  'inventoryMovement',
  'warehousePlacement',
  'stockTransfer',
  'stockTransferLine',
  'stockExit',
  'stockExitLine',
  'productVariantStock',
  'variantStockMovement',
  'stockTransferLineVariant',
  'stockExitLineVariant',
];
const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
};
/** A batch row without the fields no door of these three ever writes (they are copied by the split, unchanged by W8b). */
const STILL = ['companyId', 'storeId', 'manufacturingCost', 'packagingCost', 'rawMaterialCost', 'otherCosts', 'status', 'notes', 'updatedAt'];
const slim = (b: Row) => Object.fromEntries(Object.entries(b).filter(([k]) => !STILL.includes(k)));
const answer = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));
async function attempt(fn: () => Promise<unknown>) {
  try {
    return { ok: answer(await fn()) };
  } catch (e) {
    const x = e as Row;
    return { refused: { name: x?.name ?? null, code: x?.code ?? null, message: x?.message ?? String(e), status: x?.status ?? null, extra: answer(x?.extra ?? x?.differing ?? null) } };
  }
}

async function runAll(impl: Impl) {
  H.hex = 0;
  const out: Row[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const int = (n: number) => Math.floor(r() * n);
    const pick = <X,>(xs: readonly X[]) => xs[int(xs.length)];
    const { data, nProducts } = world(r);
    const m = memoryDb(data as never);
    const db = m.db as Row;
    const steps: Row[] = [];
    const mayUseFor = (who: string) => async (w: { id: string }) => !(seed % 3 === 0 && who === 'u3' && w.id === 'w2');
    // Mostly a person the two-hands rule allows; now and then whoever comes.
    const other = (...not: (string | null | undefined)[]) => (r() < 0.85 ? (PEOPLE.find((p) => !not.includes(p)) ?? 'u1') : pick(PEOPLE));

    // 1. The placement: the preview of nothing typed, then a press built from it (sometimes off by one, or wrong).
    const preview = await attempt(() => db.$transaction((tx: Row) => impl.P.previewPlacement(tx as never, { companyId: C, storeId: S, counts: [] } as never)));
    steps.push({ op: 'preview', ...preview });
    const rows: Row[] = (preview.ok as Row)?.rows ?? [];
    const counts = [
      { warehouseId: 'w1', lines: [] as Row[] },
      { warehouseId: 'w2', lines: [] as Row[] },
    ];
    const offByOne = r() < 0.12;
    for (const row of rows) {
      const toPlace = Math.max(0, row.toPlace);
      const a = int(toPlace + 1);
      counts[0].lines.push({ productId: row.productId, quantity: a });
      counts[1].lines.push({ productId: row.productId, quantity: toPlace - a + (offByOne && row === rows[0] ? 1 : 0) });
    }
    if (r() < 0.08) counts.push({ warehouseId: pick(['wOff', 'wJ', 'nope']), lines: [] });
    const previewTyped = await attempt(() => db.$transaction((tx: Row) => impl.P.previewPlacement(tx as never, { companyId: C, storeId: S, counts } as never)));
    steps.push({ op: 'preview-typed', ...previewTyped });
    const press = await attempt(() =>
      db.$transaction((tx: Row) =>
        impl.P.placeStore(tx as never, {
          companyId: C,
          storeId: S,
          countedByName: r() < 0.07 ? 'ab' : 'أمين المخزن',
          countedAt: new Date('2026-11-19T08:00:00Z'),
          note: null,
          recordedById: 'u1',
          counts,
        } as never)
      )
    );
    steps.push({ op: 'place', ...press });

    // 2. A dozen random documents.
    const transfers: string[] = [];
    const exits: string[] = [];
    const ids: Row[] = [];
    for (let k = 0; k < 12; k++) {
      const who = pick(PEOPLE);
      const kind = pick(['send', 'send', 'send', 'receive', 'receive', 'cancel', 'difference', 'exit', 'exit', 'approve', 'reject']);
      // Distinct products per document, now and then the same one twice or one that does not exist.
      const products = () => {
        const n = Math.min(nProducts, 1 + int(2));
        const first = int(nProducts);
        const list = Array.from({ length: n }, (_, i) => `p${(first + i) % nProducts}`);
        if (r() < 0.05) list.push(list[0]);
        if (r() < 0.04) list.push('p-none');
        return list;
      };
      if (kind === 'send') {
        const lines: Row[] = products().map((productId) => ({ productId, quantity: r() < 0.06 ? 999 : 1 + int(6) }));
        const from = r() < 0.5 ? 'w1' : 'w2';
        const to = r() < 0.06 ? from : r() < 0.06 ? pick(['wOff', 'wJ', 'nope']) : from === 'w1' ? 'w2' : 'w1';
        const reuse = ids.length > 0 && r() < 0.12 ? pick(ids) : null;
        const body: Row = reuse ? { ...reuse.body } : { fromWarehouseId: from, toWarehouseId: to, lines, ...(r() < 0.4 ? { id: `00000000-0000-4000-8000-${String(seed * 100 + k).padStart(12, '0')}` } : {}) };
        const res = await attempt(() => db.$transaction((tx: Row) => impl.T.sendTransfer(tx as never, { companyId: C, storeId: S, sentById: reuse ? reuse.who : who, body, mayUse: mayUseFor(who) } as never)));
        if (body.id) ids.push({ body, who });
        const id = (res.ok as Row)?.transfer?.id;
        if (id && !transfers.includes(id)) transfers.push(id);
        steps.push({ op: 'send', who, ...res });
      } else if (kind === 'receive' || kind === 'cancel' || kind === 'difference') {
        const id = transfers.length > 0 && r() < 0.95 ? pick(transfers) : 'nope';
        const t = m.data.stockTransfer.find((x: Row) => x.id === id);
        const lines = m.data.stockTransferLine
          .filter((l: Row) => l.transferId === id)
          .map((l: Row) => ({ productId: l.productId, quantity: r() < 0.05 ? l.quantitySent + 1 : r() < 0.6 ? l.quantitySent : int(l.quantitySent + 1) }));
        if (r() < 0.05) lines.pop();
        const actor = !t ? who : r() < 0.1 ? t.sentById : kind === 'difference' ? other(t.sentById, t.receivedById) : kind === 'cancel' ? t.sentById : other(t.sentById);
        const res =
          kind === 'receive'
            ? await attempt(() => db.$transaction((tx: Row) => impl.T.receiveTransfer(tx as never, { companyId: C, storeId: S, transferId: id, receivedById: actor, body: { lines }, mayUse: mayUseFor(actor) } as never)))
            : kind === 'cancel'
              ? await attempt(() => db.$transaction((tx: Row) => impl.T.cancelTransfer(tx as never, { companyId: C, storeId: S, transferId: id, cancelledById: actor, body: { reason: 'غلط' }, mayUse: mayUseFor(actor) } as never)))
              : await attempt(() =>
                  db.$transaction((tx: Row) =>
                    impl.T.approveDifference(tx as never, { companyId: C, storeId: S, transferId: id, approvedById: actor, body: { type: r() < 0.5 ? 'LOSS' : 'DAMAGE', reason: 'انكسر' }, mayUse: mayUseFor(actor) } as never)
                  )
                );
        steps.push({ op: kind, who: actor, ...res });
      } else if (kind === 'exit') {
        const lines: Row[] = products().map((productId) => ({ productId, quantity: r() < 0.06 ? 500 : 1 + int(4) }));
        const reason = pick(EXIT_REASONS);
        const body = { warehouseId: r() < 0.08 ? pick(['wOff', 'wJ', 'nope']) : pick(['w1', 'w2']), reason, note: reason === 'OTHER' || r() < 0.3 ? 'سبب مكتوب' : null, lines };
        const res = await attempt(() => db.$transaction((tx: Row) => impl.E.requestExit(tx as never, { companyId: C, storeId: S, requestedById: who, body, mayUse: mayUseFor(who) } as never)));
        const id = (res.ok as Row)?.exit?.id;
        if (id) exits.push(id);
        steps.push({ op: 'exit', who, ...res });
      } else {
        const id = exits.length > 0 && r() < 0.95 ? pick(exits) : 'nope';
        const asker = m.data.stockExit.find((x: Row) => x.id === id)?.requestedById;
        const decider = other(asker);
        const res =
          kind === 'approve'
            ? await attempt(() => db.$transaction((tx: Row) => impl.E.approveExit(tx as never, { companyId: C, storeId: S, exitId: id, decidedById: decider, mayUse: mayUseFor(decider) } as never)))
            : await attempt(() =>
                db.$transaction((tx: Row) => impl.E.rejectExit(tx as never, { companyId: C, storeId: S, exitId: id, decidedById: decider, body: { reason: 'مش لازم' }, mayUse: mayUseFor(decider) } as never))
              );
        steps.push({ op: kind, who: decider, ...res });
      }
    }
    // The tables a document may write (the variant tables included: they must stay empty), and the locks as one hash.
    const tables = Object.fromEntries(CHANGING.map((t) => [t, answer(t === 'productionBatch' ? m.data[t].map(slim) : m.data[t])]));
    out.push({ seed, steps, data: tables, touched: [...m.touched], locks: { n: m.locks.length, hash: fnv(m.locks.join('|')) } });
  }
  return out;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T09:00:00.000Z'));
});
afterAll(() => vi.useRealTimers());

describe('a product without combinations: the transfer, the exit and the placement answer as osm/main did (frozen golden)', () => {
  it(`${SEEDS} random stores — the same answers, refusals, rows, writes and locks`, async () => {
    if (WRITE) {
      // Paths built at run time: the copies exist only while the golden is being written.
      const at = (p: string) => join(process.cwd(), p);
      const main: Impl = {
        T: await import(/* @vite-ignore */ at('src/lib/stock-transfers.w8b-main.ts')),
        E: await import(/* @vite-ignore */ at('src/lib/stock-exits.w8b-main.ts')),
        P: await import(/* @vite-ignore */ at('src/lib/warehouse-placement.w8b-main.ts')),
      };
      writeFileSync(GOLDEN, JSON.stringify(await runAll(main)));
    }
    const golden: Row[] = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(golden).toHaveLength(SEEDS);
    // Not vacuous: every door both did something and refused something, and the placement happened in most stores.
    const steps = golden.flatMap((g) => g.steps);
    for (const op of ['place', 'send', 'receive', 'cancel', 'difference', 'exit', 'approve', 'reject']) {
      const mine = steps.filter((s) => s.op === op);
      expect(mine.some((s) => s.ok), `${op} succeeded somewhere`).toBe(true);
      expect(mine.some((s) => s.refused), `${op} was refused somewhere`).toBe(true);
    }
    expect(golden.filter((g) => g.steps.find((s: Row) => s.op === 'place')?.ok).length).toBeGreaterThan(SEEDS / 2);

    const today: Impl = {
      T: (await import('./stock-transfers')) as never,
      E: (await import('./stock-exits')) as never,
      P: (await import('./warehouse-placement')) as never,
    };
    const now = await runAll(today);
    for (let i = 0; i < golden.length; i++) expect(now[i], `seed ${golden[i].seed}`).toEqual(golden[i]);
  });
});
