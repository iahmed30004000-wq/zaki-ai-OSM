import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { db as prismaDb } from './db';
import { lockProductsStock } from './reservation';
import { drawDownStock, onHandTotal } from './receiving';
import { roundMinor } from './money';
import { storeIsPlaced, type WarehouseRef } from './warehouse-intake';
import { freeStockOf, lockWarehousesForShare } from './stock-transfers';
import {
  EXIT_MOVEMENT_TYPE,
  EXIT_REASON_AR,
  EXIT_REASONS,
  EXIT_STATUS_AR,
  PENDING_EXIT,
  type ExitReason,
  type StockExitStatus,
} from './stock-exit-reasons';
import {
  VARIANT_LINE_AR,
  VARIANT_LINE_STATUS,
  assertFreeVariants,
  assertVariantsOnShelf,
  checkLineShapes,
  checkMembership,
  combosOf,
  exitVariants,
  exitVariantsOf,
  sameVariants,
  variantLinesField,
  withLineVariants,
  writeExitLineVariants,
  type Fail,
  type VariantLineRefusalCode,
} from './variant-lines';

type Tx = Prisma.TransactionClient | typeof prismaDb;

/**
 * GOODS LEAVE A WAREHOUSE FOR GOOD (the warehouse plan, request W6a) — not by a sale: damaged, expired, samples and
 * gifts, back to the supplier, sold outside the system, a partner's draw, or another reason in a sentence.
 *
 *   request   one warehouse of the store, its lines, ONE reason (`stock-exit-reasons.ts`). Each line must fit in the
 *             warehouse's FREE stock (`stock-transfers.freeStockOf` — the one formula the transfer asks too). From then
 *             on the units are HELD: the same function subtracts the lines of every PENDING exit, so a transfer or a
 *             second exit cannot promise them again, and the warehouse may not be stopped (`warehouses.warehouseStopBlockers`).
 *             Nothing moves on the shelf yet and nothing is written to the ledger.
 *   approve   by a DIFFERENT person (two hands — the requester can neither approve nor reject her own request, by any
 *             door, a replay included). The units are drawn oldest first IN THAT WAREHOUSE through the one draw every
 *             loss already goes through (`receiving.drawDownStock` with `warehouseId`: units on the road excluded, the
 *             guarded write, the batch-family cost) — remaining −n, sold +n, the very arithmetic of the refused-return
 *             losses. So «خرج» rises and the stock value falls by exactly those units at their batches' cost. Each line
 *             keeps that cost (`valueAtCost`, rounded once to the store currency's minor unit) and writes ONE ledger
 *             line of the reason's type (`DAMAGE` for the damaged, an `EXIT_…` type for the others), −n, in that
 *             warehouse, `referenceId` = the exit.
 *   reject    by a different person, with a reason. The hold is released (the exit is no longer pending); the shelf and
 *             the ledger are not touched.
 * Nothing is ever deleted.
 *
 * NO MONEY. The owner's default for decision 6 is «a report only»: the value at cost is written on the line for the
 * report and goes nowhere else. This module reads no wallet, writes no expense and posts nothing to a profit (pinned by
 * its test, which walks every file it imports). A profit only ever reads delivered orders, never `quantitySold`.
 *
 * LOCKS, in the order the transfers keep (so the two documents can never wait for each other in a circle):
 *   1. the exit row FOR UPDATE (approve, reject) — two presses on one exit go one after the other;
 *   2. the products' stock lock (`reservation.lockProductsStock`);
 *   3. the warehouse row FOR SHARE (request) — the stop door locks it FOR UPDATE before it counts pending exits.
 */

export type StockExitRefusalCode =
  | 'INVALID'
  | 'PRODUCT_TWICE'
  | 'EXIT_EXISTS'
  | 'STORE_NOT_PLACED'
  | 'WAREHOUSE_NOT_FOUND'
  | 'WAREHOUSE_OTHER_COUNTRY'
  | 'WAREHOUSE_STOPPED'
  | 'NOT_REACHED'
  | 'PRODUCT_NOT_FOUND'
  | 'NOT_ENOUGH_FREE'
  | 'NOT_ON_SHELF'
  | 'MOVED_MEANWHILE'
  | 'NOT_FOUND'
  | 'REQUESTER_CANNOT_DECIDE'
  | 'ALREADY_APPROVED'
  | 'ALREADY_REJECTED'
  | VariantLineRefusalCode;

const STATUS_OF: Record<StockExitRefusalCode, number> = {
  ...VARIANT_LINE_STATUS,
  INVALID: 400,
  PRODUCT_TWICE: 400,
  EXIT_EXISTS: 409,
  STORE_NOT_PLACED: 409,
  WAREHOUSE_NOT_FOUND: 404,
  WAREHOUSE_OTHER_COUNTRY: 400,
  WAREHOUSE_STOPPED: 409,
  NOT_REACHED: 403,
  PRODUCT_NOT_FOUND: 404,
  NOT_ENOUGH_FREE: 409,
  NOT_ON_SHELF: 409,
  MOVED_MEANWHILE: 409,
  NOT_FOUND: 404,
  REQUESTER_CANNOT_DECIDE: 403,
  ALREADY_APPROVED: 409,
  ALREADY_REJECTED: 409,
};

const AR: Record<StockExitRefusalCode, string> = {
  ...VARIANT_LINE_AR,
  INVALID: 'البيانات ناقصة.',
  PRODUCT_TWICE: 'نفس المنتج مكتوب بسطرين. اجمعهم بسطر واحد.',
  EXIT_EXISTS: 'طلب الإخراج هاد انسجّل من قبل بشكل تاني. حدّث الصفحة وراجع قبل ما تعيد.',
  STORE_NOT_PLACED: 'هالمتجر لسا ما توزّع على المخازن. وزّع الرصيد على المخازن أول، وبعدين اطلب إخراج.',
  WAREHOUSE_NOT_FOUND: 'المخزن مش موجود. حدّث الصفحة واختار من جديد.',
  WAREHOUSE_OTHER_COUNTRY: 'هالمخزن مش ببلد هالمتجر، وما بيشيل بضاعته.',
  WAREHOUSE_STOPPED: 'هالمخزن موقوف. ما بينطلب منه إخراج.',
  NOT_REACHED: 'ما إلك وصول على هالمخزن.',
  PRODUCT_NOT_FOUND: 'في منتج مش موجود بهالمتجر. حدّث الصفحة.',
  NOT_ENOUGH_FREE: 'ما في كفاية بالبضاعة الحرّة بهالمخزن.',
  NOT_ON_SHELF: 'المخزن ما فيه هالكمية هلق. ارفض الطلب، أو استنى لحد ما تتصحّح الكمية.',
  MOVED_MEANWHILE: 'البضاعة تحرّكت بنفس اللحظة من باب تاني. جرّب كمان مرة.',
  NOT_FOUND: 'طلب الإخراج مش موجود. حدّث الصفحة.',
  REQUESTER_CANNOT_DECIDE: 'إنت اللي طلبت هالإخراج، فما بتعتمده ولا بترفضه. لازم حدا تاني.',
  ALREADY_APPROVED: 'هالإخراج انعتمد من قبل. حدّث الصفحة.',
  ALREADY_REJECTED: 'هالإخراج انرفض من قبل. حدّث الصفحة.',
};

export class StockExitRefused extends Error {
  readonly status: number;
  constructor(
    readonly code: StockExitRefusalCode,
    readonly errorAr: string = AR[code],
    readonly extra: Record<string, unknown> = {}
  ) {
    super(errorAr);
    this.name = 'StockExitRefused';
    this.status = STATUS_OF[code];
  }
}

/** The JSON a door answers with: an Arabic sentence, a stable code, and whatever the refusal carries. */
export function exitRefusalBody(e: StockExitRefused) {
  return { error: e.errorAr, errorAr: e.errorAr, code: e.code, ...e.extra };
}

/** How `variant-lines.ts` refuses inside an exit: as the exit refuses. */
const fail: Fail = (code, errorAr, extra) => {
  throw new StockExitRefused(code, errorAr ?? AR[code], extra ?? {});
};

/* ───────────────────────────── the bodies (every message Arabic) ───────────────────────────── */

const qty = z
  .number({ message: 'الكمية لازم تكون رقم' })
  .int('الكمية لازم تكون عدد صحيح')
  .positive('الكمية لازم تكون أكبر من صفر');

export const requestSchema = z
  .object(
    {
      /** Made by the client before the first press: the same id pressed twice is one request. */
      id: z.string({ message: 'رقم الطلب مش صحيح' }).uuid('رقم الطلب مش صحيح').optional(),
      warehouseId: z.string({ message: 'اختار المخزن' }).min(1, 'اختار المخزن'),
      reason: z.enum(EXIT_REASONS, { message: 'اختار سبب الإخراج' }),
      note: z.string({ message: 'الملاحظة لازم تكون نص' }).trim().max(500, 'الملاحظة طويلة كتير').optional().nullable(),
      lines: z
        .array(
          z.object(
            {
              productId: z.string({ message: 'اختار المنتج' }).min(1, 'اختار المنتج'),
              quantity: qty,
              /** 20/11 (W8b): a product with combinations names them; their sum is `quantity`. */
              variants: variantLinesField.optional(),
            },
            { message: 'سطر المنتج مش مفهوم' }
          ),
          { message: 'زيد منتج واحد على الأقل' }
        )
        .min(1, 'زيد منتج واحد على الأقل')
        .max(200, 'كتير منتجات بطلب واحد. قسّمه.'),
    },
    { message: 'البيانات ناقصة' }
  )
  .superRefine((b, ctx) => {
    if (b.reason === 'OTHER' && (b.note ?? '').trim().length < 3) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'سبب «أخرى» بدّو جملة بتشرح ليش طالعة البضاعة' });
    }
  });

/** Approving asks nothing more than the press: an empty body, or none. */
export const approveSchema = z.object({}, { message: 'البيانات مش مفهومة' }).nullable();

export const rejectSchema = z.object(
  { reason: z.string({ message: 'اكتب سبب الرفض' }).trim().min(3, 'اكتب سبب الرفض').max(500, 'سبب الرفض طويل كتير') },
  { message: 'اكتب سبب الرفض' }
);

/* ───────────────────────────── shared reads ───────────────────────────── */

const EXIT_SELECT = {
  id: true,
  companyId: true,
  storeId: true,
  warehouseId: true,
  reason: true,
  note: true,
  status: true,
  requestedById: true,
  requestedAt: true,
  decidedById: true,
  decidedAt: true,
  rejectReason: true,
  lines: { select: { productId: true, quantity: true, valueAtCost: true }, orderBy: { productId: 'asc' as const } },
} as const;

/** 20/11 (W8b): an exit with its lines' combinations — added only to a line that has them. */
async function withVariants<T extends { id: string; lines: { productId: string; quantity: number; valueAtCost: number | null }[] }>(tx: Tx, e: T) {
  const lines = withLineVariants(e.lines, await exitVariantsOf(tx, e.id));
  return { ...(e as Omit<T, 'lines'>), lines };
}

async function readExit(tx: Tx, companyId: string, storeId: string, id: string) {
  const e = await tx.stockExit.findFirst({ where: { id, companyId, storeId }, select: EXIT_SELECT });
  if (!e) throw new StockExitRefused('NOT_FOUND');
  return withVariants(tx, e);
}

export type StockExitRow = Awaited<ReturnType<typeof readExit>>;

/** The exit row FOR UPDATE: two presses on one exit go one after the other. */
async function lockExit(tx: Tx, id: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "stock_exits" WHERE "id" = ${id} FOR UPDATE`;
}

const cleanNote = (n: string | null | undefined) => n?.trim() || null;

type VQ = { variantId: string; quantity: number };
const sameLines = (a: readonly { productId: string; quantity: number; variants?: VQ[] }[], b: readonly { productId: string; quantity: number; variants?: VQ[] }[]) => {
  if (a.length !== b.length) return false;
  const want = new Map(a.map((l) => [l.productId, l]));
  // 20/11 (W8b): the same combinations too (none on both sides for a product without them).
  return b.every((l) => want.get(l.productId)?.quantity === l.quantity && sameVariants(want.get(l.productId)?.variants, l.variants));
};

/* ───────────────────────────── request ───────────────────────────── */

export interface RequestInput {
  companyId: string;
  storeId: string;
  requestedById: string;
  body: z.infer<typeof requestSchema>;
  /** Does the requester reach this warehouse? The door passes `warehouses.reachesWarehouse` for the session. */
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

/**
 * A REPLAY: the same id, the same request (warehouse, reason, note, lines) and the same person → that exit, nothing
 * written. The same id carrying anything else is a conflict that says nothing about the row. Asked before the warehouse
 * is judged: the first press may have succeeded and the exit been decided since — a retry of it is still a success.
 */
export async function exitReplayOf(tx: Tx, input: Omit<RequestInput, 'mayUse'>) {
  const id = input.body.id;
  if (!id) return null;
  const found = await tx.stockExit.findUnique({ where: { id }, select: EXIT_SELECT });
  if (!found) return null;
  const row = await withVariants(tx, found);
  const same =
    row.companyId === input.companyId &&
    row.storeId === input.storeId &&
    row.requestedById === input.requestedById &&
    row.warehouseId === input.body.warehouseId &&
    row.reason === input.body.reason &&
    row.note === cleanNote(input.body.note) &&
    sameLines(input.body.lines, row.lines);
  if (!same) throw new StockExitRefused('EXIT_EXISTS');
  return row;
}

export async function requestExit(tx: Tx, input: RequestInput): Promise<{ exit: StockExitRow; replay: boolean }> {
  const { companyId, storeId, body } = input;

  const seen = new Set<string>();
  for (const l of body.lines) {
    if (seen.has(l.productId)) throw new StockExitRefused('PRODUCT_TWICE');
    seen.add(l.productId);
  }
  checkLineShapes(body.lines, fail);

  const replay = await exitReplayOf(tx, input);
  if (replay) return { exit: replay, replay: true };

  const productIds = [...seen];
  // 2. the products' stock lock, then 3. the warehouse FOR SHARE (the order every stock document keeps).
  await lockProductsStock(tx, companyId, productIds);
  const wh = (await lockWarehousesForShare(tx, [body.warehouseId])).get(body.warehouseId);
  if (!wh || wh.companyId !== companyId) throw new StockExitRefused('WAREHOUSE_NOT_FOUND');

  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { countryId: true } });
  if (!store) throw new StockExitRefused('NOT_FOUND');
  if (wh.countryId !== store.countryId) throw new StockExitRefused('WAREHOUSE_OTHER_COUNTRY');
  if (!(await storeIsPlaced(storeId, tx))) throw new StockExitRefused('STORE_NOT_PLACED');
  if (!wh.isActive) throw new StockExitRefused('WAREHOUSE_STOPPED');
  if (!(await input.mayUse({ id: wh.id, companyId: wh.companyId, countryId: wh.countryId }))) {
    throw new StockExitRefused('NOT_REACHED');
  }

  const products = await tx.product.findMany({ where: { id: { in: productIds }, companyId, storeId }, select: { id: true, name: true } });
  if (products.length !== productIds.length) throw new StockExitRefused('PRODUCT_NOT_FOUND');
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  // 20/11 (W8b): a product with active combinations names them; a product without any names none.
  const combos = await combosOf(tx, companyId, productIds);
  checkMembership(body.lines, combos, nameOf, fail, { required: true });

  const free = await freeStockOf(tx, { companyId, storeId, warehouseId: wh.id, productIds });
  const short = body.lines
    .filter((l) => l.quantity > (free.get(l.productId) ?? 0))
    .map((l) => ({ productId: l.productId, name: nameOf.get(l.productId) ?? '', asked: l.quantity, free: Math.max(0, free.get(l.productId) ?? 0) }));
  if (short.length > 0) {
    throw new StockExitRefused(
      'NOT_ENOUGH_FREE',
      `ما في كفاية ببضاعة ${wh.name} الحرّة: ${short.map((s) => `${s.name} (الحر ${s.free}، طالب ${s.asked})`).join(' · ')}.`,
      { short }
    );
  }
  await assertFreeVariants(tx, { companyId, storeId, warehouseId: wh.id, warehouseName: wh.name, lines: body.lines, combos, nameOf }, fail);

  const created = await tx.stockExit.create({
    data: {
      ...(body.id ? { id: body.id } : {}),
      companyId,
      storeId,
      warehouseId: wh.id,
      reason: body.reason,
      note: cleanNote(body.note),
      status: PENDING_EXIT,
      requestedById: input.requestedById,
      lines: { create: body.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) },
    },
    select: { id: true },
  });
  // The combinations' pieces are held from now on (`variant-lines.freeVariantsOf` subtracts a pending exit's rows).
  await writeExitLineVariants(tx, created.id, body.lines);
  return { exit: await readExit(tx, companyId, storeId, created.id), replay: false };
}

/* ───────────────────────────── approve ───────────────────────────── */

export interface DecideInput {
  companyId: string;
  storeId: string;
  exitId: string;
  decidedById: string;
  mayUse: (w: WarehouseRef) => Promise<boolean>;
}

/** Two hands, then the state — a replay is «done» only for the person who did it. */
async function openForDecision(tx: Tx, input: DecideInput, want: 'APPROVED' | 'REJECTED') {
  await lockExit(tx, input.exitId);
  const e = await readExit(tx, input.companyId, input.storeId, input.exitId);
  if (e.requestedById === input.decidedById) throw new StockExitRefused('REQUESTER_CANNOT_DECIDE');
  if (e.status !== PENDING_EXIT) {
    if (e.status === want && e.decidedById === input.decidedById) return { exit: e, replay: true as const };
    throw new StockExitRefused(e.status === 'APPROVED' ? 'ALREADY_APPROVED' : 'ALREADY_REJECTED');
  }
  const wh = await tx.warehouse.findFirst({ where: { id: e.warehouseId, companyId: input.companyId }, select: { id: true, companyId: true, countryId: true } });
  if (!wh) throw new StockExitRefused('WAREHOUSE_NOT_FOUND');
  if (!(await input.mayUse(wh))) throw new StockExitRefused('NOT_REACHED');
  return { exit: e, replay: false as const };
}

export async function approveExit(tx: Tx, input: DecideInput): Promise<{ exit: StockExitRow; replay: boolean }> {
  const { companyId, storeId, exitId } = input;
  const open = await openForDecision(tx, input, 'APPROVED');
  if (open.replay) return open;
  const e = open.exit;

  await lockProductsStock(tx, companyId, e.lines.map((l) => l.productId));
  const store = await tx.store.findFirst({ where: { id: storeId, companyId }, select: { country: { select: { minorUnit: true } } } });
  const minorUnit = store?.country?.minorUnit ?? 2;
  const reason = e.reason as ExitReason;
  const words = EXIT_REASON_AR[reason] ?? e.reason;
  // 20/11 (W8b): the combinations' pieces must be on THAT warehouse's shelf too — refused whole, nothing written.
  const byProduct = new Map(e.lines.filter((l) => (l.variants?.length ?? 0) > 0).map((l) => [l.productId, l.variants!]));
  await assertVariantsOnShelf(tx, { warehouseId: e.warehouseId, byProduct }, fail);

  for (const l of e.lines) {
    /*
     * The shelf of THAT warehouse must hold the units now. While the exit was pending its units were out of the free
     * stock, so no transfer or exit could take them; but a delivery draws store-wide (until W4b) and may have emptied
     * this warehouse's rows. Then the approval is refused whole — the approver rejects, or waits for a count — and
     * nothing is written: an exit never takes units from another warehouse, and never writes a short shelf.
     */
    const there = await tx.productionBatch.aggregate({
      where: { companyId, storeId, productId: l.productId, warehouseId: e.warehouseId, inTransitTransferId: null, quantityRemaining: { gt: 0 } },
      _sum: { quantityRemaining: true },
    });
    if ((there._sum.quantityRemaining ?? 0) < l.quantity) {
      throw new StockExitRefused('NOT_ON_SHELF', undefined, { productId: l.productId, onShelf: there._sum.quantityRemaining ?? 0, asked: l.quantity });
    }
    let drawn: { taken: number; short: number; cost: number };
    try {
      drawn = await drawDownStock(tx, {
        companyId,
        storeId,
        warehouseId: e.warehouseId,
        productId: l.productId,
        quantity: l.quantity,
        allowNegative: false,
      });
    } catch (err) {
      // The draw refuses in its own words when a writer slipped in between the check above and its write.
      if (err instanceof Error && !('code' in err)) throw new StockExitRefused('MOVED_MEANWHILE');
      throw err;
    }
    if (drawn.taken !== l.quantity) throw new StockExitRefused('MOVED_MEANWHILE');

    // WHAT LEFT, AT WHAT IT COST: the draw's own figure (each batch at its price, a run and its twins costed once),
    // rounded ONCE here, where the currency is known — never on the way.
    await tx.stockExitLine.updateMany({ where: { exitId, productId: l.productId }, data: { valueAtCost: roundMinor(drawn.cost, minorUnit) } });

    await tx.inventoryMovement.create({
      data: {
        companyId,
        storeId,
        warehouseId: e.warehouseId,
        productId: l.productId,
        batchId: null,
        type: EXIT_MOVEMENT_TYPE[reason] ?? 'EXIT_OTHER',
        quantity: -l.quantity,
        balanceAfter: await onHandTotal(tx, companyId, l.productId),
        referenceId: exitId,
        reason: e.note ? `إخراج (${words}): ${e.note}` : `إخراج (${words})`,
        createdById: input.decidedById,
      },
    });
  }
  await exitVariants(
    tx,
    { companyId, storeId, userId: input.decidedById, referenceId: exitId },
    { warehouseId: e.warehouseId, byProduct, reason: e.note ? `إخراج (${words}): ${e.note}` : `إخراج (${words})` },
    fail
  );

  await tx.stockExit.update({
    where: { id: exitId },
    data: { status: 'APPROVED', decidedById: input.decidedById, decidedAt: new Date() },
  });
  return { exit: await readExit(tx, companyId, storeId, exitId), replay: false };
}

/* ───────────────────────────── reject ───────────────────────────── */

export async function rejectExit(
  tx: Tx,
  input: DecideInput & { body: z.infer<typeof rejectSchema> }
): Promise<{ exit: StockExitRow; replay: boolean }> {
  const open = await openForDecision(tx, input, 'REJECTED');
  if (open.replay) return open;
  await tx.stockExit.update({
    where: { id: input.exitId },
    data: { status: 'REJECTED', decidedById: input.decidedById, decidedAt: new Date(), rejectReason: input.body.reason },
  });
  return { exit: await readExit(tx, input.companyId, input.storeId, input.exitId), replay: false };
}

/* ───────────────────────────── what a door shows ───────────────────────────── */

/**
 * An exit as a door answers it: the words for its status and reason, and the value at cost ONLY to a person who may see
 * what things cost (`cost-visibility.maySeeCost`, passed in by the door). For anybody else the fields are omitted —
 * not zeroed, not nulled: a null says «not approved yet» and a zero «cost nothing».
 */
export function exitShown<T extends { status: string; reason: string; lines: { productId: string; quantity: number; valueAtCost: number | null }[] }>(
  e: T,
  seesCost: boolean
) {
  // Per line only: a total of rounded line values is money arithmetic of its own, and belongs to the report (W6b),
  // which knows the currency.
  const lines = e.lines.map(({ valueAtCost, ...rest }) => (seesCost ? { ...rest, valueAtCost } : rest));
  return {
    ...e,
    statusAr: EXIT_STATUS_AR[e.status as StockExitStatus] ?? e.status,
    reasonAr: EXIT_REASON_AR[e.reason as ExitReason] ?? e.reason,
    lines,
  };
}
