import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { authorize, can } from '@/lib/authorization';
import { inStore } from '@/lib/store-filter';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import { CATEGORISE_BATCH, categoryKey } from '@/lib/product-categories';

/**
 * POST /api/products/categorise — FILE THE PRODUCTS THAT CARRY NO CATEGORY, ON THE SHELVES A PERSON CHOSE.
 *
 * THE OWNER, 22/10, about the products with no category: «انتا صنف افضل» — he wants the sorting done for him. The suggestion is
 * `lib/product-categories.ts` (a table, no model, nothing leaves the machine) and the products dialog shows it row by row; this is
 * the door the dialog presses. It takes `{ items: [{ productId, category }] }` — the category by NAME, because the dialog offers
 * shelves that do not exist yet — and answers `{ filed, skipped, created }`.
 *
 * WHAT IT WILL NOT DO, AND EACH IS A CLAIM:
 *   · It never moves a product that already has a category. The write is an `updateMany` whose WHERE carries `categoryId: null`, so
 *     a product somebody filed a second ago — through the product page, or through this very dialog open in another tab — is left
 *     where it is and counted as skipped. Re-filing is a deliberate act on the product's own page, not a side effect of tidying.
 *   · It never makes a shelf nothing is about to go onto. A shelf is created only for a product that is unfiled, in this store and
 *     within the caller's reach — so a request whose products are all filed already, foreign or out of reach makes nothing.
 *   · It never makes a second copy of a shelf. A name is matched to the company's existing categories first as written and then by
 *     `categoryKey` (spelling folded: «مكملات» is «مكمّلات»), so a spelling cannot double a shelf. Categories are the company's, not
 *     the store's — a shelf made here is the same shelf in every store.
 *   · It does not step outside the caller's reach. The gate is `products.edit` (the product page's), and MAKING a shelf is
 *     `categories.manage` (the categories door's, PR-11): without it the sorter files onto the shelves that exist and skips the
 *     products that wanted a new one. Each product is checked with `authorize(...,
 *     'products.edit', product)`: a grant scoped to a category or to specific products reaches only its own, and an UNFILED product is
 *     in no category, so a category-scoped editor files nothing here. The products read are this store's, as the list is.
 *   · It writes nothing it does not log. One audit row per product filed (`PRODUCT_CATEGORISED`, from no category to this one) and
 *     one per shelf made (`CATEGORY_CREATED`, the same action the categories door writes).
 *
 * A product named twice in one request is filed once, on the first shelf named. A product that is not found, not unfiled any more,
 * in another store, or out of reach is not told apart from the others — they are all `skipped`, so the answer cannot be used to
 * probe for products the caller may not see.
 *
 * IT IS NOT ONE TRANSACTION, ON PURPOSE. A product is filed by its own conditional write, so a failure part-way leaves the products
 * already filed filed and the rest untouched — and pressing again files the rest, because the filed ones are no longer unfiled and
 * are skipped. A single transaction over three hundred rows would make the whole press fail for one bad row; this makes it finish
 * what it can and say how many it did.
 *
 * It reads no customer, no order and no money, and it asks no model anything.
 */
const MESSAGE_NO_EDIT = 'لا تملك صلاحية تعديل المنتجات.';

/**
 * EVERY WAY THE BODY CAN BE WRONG HAS AN ARABIC SENTENCE. Zod's own text is English («expected array, received undefined»), and a
 * refusal that reaches the screen in English is one nobody reads — so the object, the list, the id and the name each carry theirs.
 */
const bodySchema = z.object(
  {
    items: z
      .array(
        z.object(
          {
            productId: z.string({ error: 'معرّف المنتج مطلوب' }).min(10, 'معرّف المنتج غير صالح').max(64, 'معرّف المنتج غير صالح'),
            category: z
              .string({ error: 'اسم التصنيف مطلوب' })
              .trim()
              .min(2, 'اسم التصنيف قصير جداً')
              .max(60, 'اسم التصنيف طويل جداً'),
          },
          { error: 'بيانات المنتج غير صالحة' }
        ),
        { error: 'لا منتجات للتصنيف' }
      )
      .min(1, 'لا منتجات للتصنيف')
      .max(CATEGORISE_BATCH, `الحدّ الأقصى ${CATEGORISE_BATCH} منتج في المرّة الواحدة`),
  },
  { error: 'الطلب غير صالح' }
);

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();

    if (!can(user, 'products.edit')) {
      return NextResponse.json({ error: MESSAGE_NO_EDIT, errorAr: MESSAGE_NO_EDIT }, { status: 403 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = parsed.error.issues[0].message;
      return NextResponse.json({ error: message, errorAr: message }, { status: 400 });
    }

    // The first shelf named for a product is the one it gets.
    const wanted = new Map<string, string>();
    for (const item of parsed.data.items) {
      if (!wanted.has(item.productId)) wanted.set(item.productId, item.category);
    }

    // This store's products that carry no category yet — and, of those, the ones the caller may edit.
    const unfiled = await db.product.findMany({
      where: { id: { in: [...wanted.keys()] }, categoryId: null, ...inStore(companyId, storeId) },
      select: { id: true, companyId: true, categoryId: true },
    });
    const reachable = unfiled.filter((p) => authorize(user, 'products.edit', p).allowed);

    // The company's shelves, by the name as written and by the name folded.
    const shelves = await db.category.findMany({ where: { companyId }, select: { id: true, name: true } });
    const byName = new Map(shelves.map((c) => [c.name, c]));
    const byKey = new Map<string, { id: string; name: string }>();
    for (const c of shelves) if (!byKey.has(categoryKey(c.name))) byKey.set(categoryKey(c.name), c);

    // MAKING a shelf is «إدارة التصنيفات» (PR-11) — the same key the categories door asks. Filing a product on a shelf that
    // exists stays `products.edit`, so the sorter keeps working for everyone who had it; without the key it makes no shelf and
    // the products that wanted a new one are skipped.
    const mayMakeShelves = can(user, 'categories.manage');
    const created: string[] = [];
    const shelfFor = async (name: string) => {
      const found = byName.get(name) ?? byKey.get(categoryKey(name));
      if (found) return found;
      if (!mayMakeShelves) return null;
      const made = await db.category.create({ data: { companyId, name }, select: { id: true, name: true } });
      // By its folded name only: the next product that names it — however it spells it — finds it there.
      byKey.set(categoryKey(made.name), made);
      created.push(made.name);
      await logAudit({
        companyId, userId: user.id, action: 'CATEGORY_CREATED',
        entity: 'Category', entityId: made.id, newData: { name: made.name },
      });
      return made;
    };

    let filed = 0;
    for (const product of reachable) {
      const shelf = await shelfFor(wanted.get(product.id) as string);
      if (!shelf) continue;
      // `categoryId: null` again, in the write itself: whatever was filed since the read above stays where it is.
      const { count } = await db.product.updateMany({
        where: { id: product.id, companyId, categoryId: null },
        data: { categoryId: shelf.id },
      });
      if (count === 0) continue;
      filed += 1;
      await logAudit({
        companyId, userId: user.id, action: 'PRODUCT_CATEGORISED',
        entity: 'Product', entityId: product.id,
        previousData: { categoryId: null }, newData: { categoryId: shelf.id, category: shelf.name },
      });
    }

    return NextResponse.json({ filed, skipped: wanted.size - filed, created });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
