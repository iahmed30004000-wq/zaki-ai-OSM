import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * «استيراد طلبات» IS DRAWN FOR WHOEVER THE DOOR WILL SERVE (RV98).
 *
 * The import dialog posts every row through `POST /api/orders`, and `GET`/`POST /api/orders/import` ask for
 * `orders.create` as well as the import grant. A custom account holding `orders.import` alone got the button, opened
 * the dialog, and had every row refused. The button, the «+ أنشئ» handler and the migration button (which hangs off the
 * import one) now follow the doors: BOTH keys.
 */

const screen = () => stripComments(repoFile('src/components/screens/OrdersScreen.tsx'));
const door = () => stripComments(repoFile('src/app/api/orders/import/route.ts'));

describe('the import button follows the import door', () => {
  it('the door asks for «إنشاء الطلبات» — both of its verbs', () => {
    const asks = [...door().matchAll(/requirePermission\('([a-z.]+)'\)/g)].map((m) => m[1]);
    expect(asks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asks)).toEqual(new Set(['orders.create']));
  });

  it('the screen draws the button only for whoever holds that key AND the import key', () => {
    expect(screen()).toMatch(
      /const canImport = userCan\(currentUser, 'orders\.import'\) && userCan\(currentUser, 'orders\.create'\);/
    );
  });

  it('and the button, the Ctrl+K handler and the migration button all hang off that one value', () => {
    const s = screen();
    expect(s).toMatch(/\{canImport && \(\s*<Button[^>]*onClick=\{\(\) => setImporting\(true\)\}/);
    expect(s).toMatch(/'import-orders': canImport \? \(\) => setImporting\(true\) : undefined/);
    expect(s).toMatch(/const canMigrate = canImport && userCan\(currentUser, 'orders\.migrate'\)/);
  });

  it('and no second, looser test for the same button is left behind', () => {
    // A copy of the old one-key test next to the new one would pass for the wrong reason.
    expect(screen()).not.toMatch(/canImport\s*=\s*userCan\(currentUser, 'orders\.import'\);/);
    expect(screen().match(/setImporting\(true\)/g)?.length).toBe(2);
  });
});
