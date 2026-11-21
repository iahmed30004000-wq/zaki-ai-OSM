import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { arabicIssue, refuse, TX_OPTIONS } from '@/lib/stock-transfer-door';
import {
  PAIR_HINT_AR,
  PAIR_HINTS,
  ProductPairRefused,
  isUniqueClash,
  pairRefusalBody,
  pairsOfStore,
  proposalsBetween,
  savePair,
  saveSchema,
  storesReachedBy,
} from '@/lib/product-pairs';

/**
 * GET  /api/inventory/pairs[?otherStoreId=…] (inventory.transfer) — the other stores she reaches, this store's pairs
 *      with them, and — for ONE other store named — the proposals (same sku first, then same name).
 * POST /api/inventory/pairs (inventory.transfer) — save: { productId (this store), otherProductId (another store) }.
 *
 * The warehouse plan, request W7a. Every rule is in `src/lib/product-pairs.ts`; this door adds the session — the
 * company, the store the caller stands in, her key, and the stores she reaches. The key is «نقل بضاعة بين المخازن»:
 * a pair only says where goods sent between stores land, and the people who send transfers are the ones who choose it.
 * Nothing reads the pairs yet (the transfer between stores, W7b, will). No stock and no money is touched.
 *
 * 21/11 (W7c): the caller is the twin picker of the transfer form «نقل البضاعة» (propose → choose → save → remove).
 */

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.transfer');

    const reached = (await storesReachedBy(db, user, companyId)).filter((s) => s.id !== storeId);
    const reachedIds = reached.map((s) => s.id);
    const otherStoreId = new URL(req.url).searchParams.get('otherStoreId');
    if (otherStoreId !== null && !reachedIds.includes(otherStoreId)) {
      return refuse(404, 'STORE_NOT_FOUND', 'المتجر التاني مش موجود، أو ما إلك وصول عليه.');
    }

    const [pairs, between] = await Promise.all([
      pairsOfStore(db, companyId, storeId, reachedIds),
      otherStoreId ? proposalsBetween(db, companyId, storeId, otherStoreId) : null,
    ]);

    const named = new Set([...pairs.flatMap((p) => [p.productId, p.otherProductId])]);
    const products = named.size
      ? await db.product.findMany({ where: { companyId, id: { in: [...named] } }, select: { id: true, name: true, sku: true } })
      : [];
    const known = new Map(products.map((p) => [p.id, p]));
    if (between) for (const p of [...between.mine, ...between.theirs]) known.set(p.id, { id: p.id, name: p.name, sku: p.sku });
    const shown = (id: string) => ({ id, name: known.get(id)?.name ?? null, sku: known.get(id)?.sku ?? null });
    const storeName = new Map(reached.map((s) => [s.id, s.name]));

    return NextResponse.json({
      stores: reached,
      hints: PAIR_HINTS.map((hint) => ({ hint, ar: PAIR_HINT_AR[hint] })),
      pairs: pairs.map((p) => ({
        id: p.id,
        hint: p.hint,
        createdAt: p.createdAt,
        product: shown(p.productId),
        otherProduct: shown(p.otherProductId),
        otherStore: { id: p.otherStoreId, name: storeName.get(p.otherStoreId) ?? null },
      })),
      proposals: between
        ? between.proposals.map((x) => ({
            hint: x.hint,
            hintAr: PAIR_HINT_AR[x.hint],
            sure: x.sure,
            product: shown(x.productId),
            candidates: x.candidateIds.map(shown),
          }))
        : null,
      /*
       * 21/11 (W7c): for ONE other store named, its products that are not paired yet — the twin picker of the transfer
       * form offers them when no proposal fits (a twin with another name or code). Null when no store is named.
       */
      otherProducts: between
        ? (() => {
            const taken = new Set(pairs.filter((p) => p.otherStoreId === otherStoreId).map((p) => p.otherProductId));
            return between.theirs.filter((p) => !taken.has(p.id)).map((p) => ({ id: p.id, name: p.name, sku: p.sku }));
          })()
        : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('inventory.transfer');

    const parsed = saveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return refuse(400, 'INVALID', arabicIssue(parsed.error));

    const reachedIds = new Set((await storesReachedBy(db, user, companyId)).map((s) => s.id));
    const run = () =>
      db.$transaction(
        (tx) =>
          savePair(tx, {
            companyId,
            storeId,
            userId: user.id,
            productId: parsed.data.productId,
            otherProductId: parsed.data.otherProductId,
            reaches: async (id) => reachedIds.has(id),
          }),
        TX_OPTIONS
      );

    let out;
    try {
      out = await run();
    } catch (e) {
      // Two presses at one moment: the database's unique keys refused the second; asked again, it is a replay or a clash.
      if (!isUniqueClash(e)) throw e;
      out = await run();
    }
    if (!out.replay) {
      await logAudit({
        companyId,
        userId: user.id,
        action: 'PRODUCT_PAIR_SAVED',
        entity: 'ProductPair',
        entityId: out.pair.id,
        newData: { productId: out.pair.productId, otherProductId: out.pair.otherProductId, otherStoreId: out.pair.otherStoreId, hint: out.pair.hint, by: user.name },
      });
    }
    return NextResponse.json({ pair: out.pair, replay: out.replay }, { status: out.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof ProductPairRefused) return NextResponse.json(pairRefusalBody(error), { status: error.status });
    return apiErrorResponse(error);
  }
}
