import { describe, expect, it } from 'vitest';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { repoFile, stripComments } from './guard-source';

/**
 * A DIMENSION THAT COULD BE READ AND NEVER WRITTEN.
 *
 * Measured: 114 products, 0 categories, 0 products categorised — and the
 * reason was not neglect. `/api/categories` had a GET and nothing else,
 * its own comment saying «Phase 6 adds full CRUD», and the product form
 * had no field. There was no way to make a category and no way to file
 * anything under one.
 *
 * What made it worth fixing rather than deleting: `products.list` narrows
 * by `categoryId` for anyone whose permission is scoped to categories. So
 * «this person sees only the skincare line» was a setting the permissions
 * screen offered, the service enforced, and nobody could configure —
 * because the list it picks from was always empty. A capability that
 * cannot be reached is indistinguishable from a broken one.
 */

describe('a category', () => {
  it('can be created, renamed and removed — not only read', () => {
    const api = stripComments(repoFile('src/app/api/categories/route.ts'));
    for (const verb of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(api, `لا ${verb} للتصنيفات`).toContain(`export async function ${verb}`);
    }
  });

  /**
   * Writing asks `categories.manage` (PR-11, D1m) — it used to ask `products.edit` and never read its scope.
   *
   * The migration 20261030180000_categories_campaign_keys gave the new key to every role and person that edited
   * products «كل الشركة», so the shelves did not close to anyone who had them; a product editor narrower than that
   * lost the company-wide shelf writes on purpose (the leak: renaming or deleting somebody else's line).
   */
  it('is written by whoever holds categories.manage, and the reading key is still offered', () => {
    const api = stripComments(repoFile('src/app/api/categories/route.ts'));
    expect(api).toContain("can(user, 'categories.manage')");
    // was: expect(api).toContain("can(user, 'products.edit')") — the product edit is no longer the key of the shelves.
    expect(api).not.toContain("can(user, 'products.edit')");
    const keys = [...ALL_CATALOG_KEYS];
    expect(keys, 'مفتاح القراءة اختفى').toContain('categories.view');
    // was: ['categories.view'] alone, "مفتاح صلاحية جديد يحتاج منحاً" — the grant is now a migration, not a thing to remember.
    expect(keys.filter((k) => k.startsWith('categories.'))).toEqual(['categories.view', 'categories.manage']);
  });

  /**
   * DELETING ONE THAT HOLDS PRODUCTS IS REFUSED, AND SAYS HOW MANY.
   *
   * Detaching them silently is the quiet kind of damage: anyone scoped to
   * that category stops seeing those products, and no screen anywhere
   * explains why.
   */
  it('cannot be deleted while products are filed under it', () => {
    const api = stripComments(repoFile('src/app/api/categories/route.ts'));
    expect(api).toMatch(/_count:\s*\{\s*select:\s*\{\s*products:\s*true/);
    expect(api).toContain('انقلها أوّلاً');
  });
});

describe('filing a product', () => {
  /**
   * A CATEGORY ID IN A REQUEST BODY IS A FOREIGN KEY SOMEBODY CAN TYPE.
   *
   * Two separate rules, and the second was a real defect in the first
   * version of this: the id must belong to THIS company, and an id that
   * does not resolve must be REFUSED rather than treated as «no
   * category». The first version used `?? null`, so a forged or
   * mistyped id quietly unfiled the product and answered 200 — the
   * category vanished and nothing said why. Clearing is a real intention
   * and it has its own value: `null`.
   */
  for (const file of ['src/app/api/products/route.ts', 'src/app/api/products/[id]/route.ts']) {
    it(`checks the category belongs to the company — ${file.split('/').slice(-2).join('/')}`, () => {
      const api = stripComments(repoFile(file));
      expect(api).toMatch(/db\.category\.findFirst\(\{\s*where:\s*\{\s*id:\s*categoryId,\s*companyId/);
      expect(api, 'معرّف لا يُحلّ يمسح الفئة بصمت').toContain('لا تصنيف بهذا المعرّف');
      expect(api, 'ما زال يبتلع المعرّف الخاطئ').not.toMatch(/\}\)\)\?\.id \?\? null/);
    });
  }

  it('and the screen can choose one, or name one on the spot', () => {
    const picker = stripComments(repoFile('src/components/products/CategoryPicker.tsx'));
    expect(picker).toContain("method: 'POST'");
    // Created and chosen in one step: naming a shelf and then hunting for
    // it in a list is two actions for one intention.
    expect(picker).toMatch(/onChange\(d\.category\.id\)/);
    /*
     * BOTH DOORS: a new product and an existing one — and the existing
     * one moved. The edit form was markup inside `ProductsScreen` while
     * the product's own page had no edit at all; it is now
     * `ProductEditDialog`, shared by the list and the detail page. So the
     * two doors are two FILES, and counting them in one would pass the
     * day the shared dialog lost its picker.
     */
    const create = stripComments(repoFile('src/components/screens/ProductsScreen.tsx'));
    const editDialog = stripComments(repoFile('src/components/products/ProductEditDialog.tsx'));
    expect((create.match(/<CategoryPicker/g) ?? []).length, 'منتقي الفئة راح من باب الإنشاء').toBe(1);
    expect((editDialog.match(/<CategoryPicker/g) ?? []).length, 'منتقي الفئة راح من باب التعديل').toBe(1);
  });
});
