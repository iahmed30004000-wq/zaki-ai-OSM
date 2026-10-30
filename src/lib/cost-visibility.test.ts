import { describe, expect, it } from 'vitest';
import { maySeeCost, withoutCost } from './cost-visibility';
import { attachGrants } from './authorization';
import { legacyEffectiveKeys, mapLegacyPermission } from './permissions-core';
import { VISIBILITY_KEYS_FROM } from './visibility-keys';
import { repoFile, stripComments } from './guard-source';
import type { SessionUser } from '@/types/auth';
import { ROLE_PERMISSIONS } from '@/types/auth';

/**
 * THE MARGIN IS NOT PART OF «WHAT IS THIS PRODUCT».
 *
 * `GET /api/products` was gated on `products.view` and returned, for every
 * product, each batch's manufacturing, packaging, raw-material and total
 * production cost plus the average cost per unit. `products.view` is held
 * by the moderator and by the confirmation and follow-up agents — people
 * who need a name, a price and a stock figure to talk to a customer.
 *
 * So the company's cost on every line it sells was readable by anyone who
 * could open the products screen, and the screen printed it in a column.
 */

function userWith(role: keyof typeof ROLE_PERMISSIONS): SessionUser {
  const user = { id: 'u1', role, status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
  const grants: Record<string, unknown> = {};
  for (const legacy of ROLE_PERMISSIONS[role] ?? []) {
    grants[legacy] = mapLegacyPermission(legacy)[0];
  }
  // PR-10, as the engine's in-code fallback does it: `costs.view` goes to whoever held any of the five keys `maySeeCost` used to
  // be an OR of (src/lib/visibility-keys.ts), so what a role sees did not change on the day.
  for (const { key, from } of VISIBILITY_KEYS_FROM) if (from.some((k) => grants[k])) grants[key] = { scope: 'ALL_COMPANY' };
  // SUPER_ADMIN is fullAccess in a real session, as it is in the database.
  attachGrants(user, { fullAccess: role === 'SUPER_ADMIN', grants } as never);
  return user;
}

describe('who may see what a thing cost', () => {
  it('the people who run stock, production or money — and nobody else', () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] as const) {
      expect(maySeeCost(userWith(role)), `${role} لا يرى التكلفة وهو يحتاجها`).toBe(true);
    }

    /**
     * THE SHIPPING MANAGER IS NOT ON THIS LIST, AND THAT IS THE POINT.
     *
     * They hold the legacy `inventory.manage`, which is a ROLE key the
     * permissions screen cannot grant and the catalogue does not carry —
     * so it is not a key anything may enforce. What they need is the
     * stock figure and the parcel, and both stay. The cost of goods was
     * never their business, and saying so costs them nothing they use.
     */
    expect(maySeeCost(userWith('DELIVERY_MANAGER')), 'مدير الشحن يرى كلفة البضاعة').toBe(false);
    // The three that hold products.view and nothing financial.
    for (const role of ['MODERATOR', 'CONFIRMATION_AGENT', 'FOLLOW_UP_AGENT'] as const) {
      const user = userWith(role);
      expect(
        (ROLE_PERMISSIONS[role] as readonly string[]).includes('products.view'),
        `${role} فقد products.view — الاختبار لم يعد يفحص ما وُضع له`
      ).toBe(true);
      expect(maySeeCost(user), `${role} يرى هامش الشركة`).toBe(false);
    }
  });

  it('and a suspended account sees nothing at all', () => {
    const user = userWith('COMPANY_ADMIN');
    (user as { status: string }).status = 'SUSPENDED';
    expect(maySeeCost(user)).toBe(false);
  });

  it('a batch handed to them keeps its quantities and loses its money', () => {
    const batch = {
      id: 'b1',
      batchNumber: 'B-1',
      quantityProduced: 500,
      quantityRemaining: 120,
      productionDate: '2026-01-01',
      totalProductionCost: 2500,
      costPerUnit: 5,
      manufacturingCost: 1500,
      packagingCost: 400,
      rawMaterialCost: 600,
      otherCosts: 0,
    };
    const safe = withoutCost(batch) as Record<string, unknown>;
    for (const money of ['totalProductionCost', 'costPerUnit', 'manufacturingCost', 'packagingCost', 'rawMaterialCost', 'otherCosts']) {
      expect(money in safe, `${money} ما زال في الحمولة`).toBe(false);
    }
    // Omitted, never zeroed: a zero is the claim «this cost nothing».
    expect(Object.values(safe)).not.toContain(0);
    expect(safe.quantityProduced).toBe(500);
    expect(safe.batchNumber).toBe('B-1');
  });

  it('and the product list applies it', () => {
    const src = stripComments(repoFile('src/app/api/products/route.ts'));
    expect(src).toMatch(/const showCost = maySeeCost\(user\)/);
    // Both halves: the batches and the totals.
    expect(src, 'الدفعات ما زالت تحمل تكلفتها للجميع').toMatch(
      /batches: showCost \? prod\.batches : prod\.batches\.map\(withoutCost\)/
    );
    expect(src, 'المجاميع ما زالت تُرسل للجميع').toMatch(/\.\.\.\(showCost\s*\?\s*\{/);
  });

  /**
   * The screen must not print a zero where the server withheld a figure:
   * a column of zeros is not «you may not see this», it is «these cost
   * nothing», and somebody would quote it.
   */
  it('and the screen shows no cost column when no cost arrived', () => {
    const src = stripComments(repoFile('src/components/screens/ProductsScreen.tsx'));
    expect(src).toMatch(/const showsCost = products\.some\([\s\S]{0,120}avgCostPerUnit !== undefined/);
    expect(src).toMatch(/\.\.\.\(showsCost/);
  });
});

/**
 * ONE KEY, NOT AN OR OF FIVE (perm-plan PR-10, D3).
 *
 * `maySeeCost` was `inventory.view || inventory.adjust || production.view || production.manage || finance.view`, so the owner
 * could never take the cost away from the warehouse and keep the shelf. It is `costs.view` now; the migration
 * 20261030170000_costs_insights_keys gave that key to everybody who held any of the five, and
 * `the-visibility-keys-keep-every-door.test.ts` proves nobody lost a figure on the day. These are the other half: that the
 * old keys alone no longer open it.
 */
describe('costs.view is the only key that shows a cost', () => {
  const holding = (...keys: string[]): SessionUser => {
    const user = { id: 'u2', role: 'MODERATOR', status: 'ACTIVE', companyId: 'c1' } as unknown as SessionUser;
    const grants: Record<string, unknown> = {};
    for (const k of keys) grants[k] = { scope: 'ALL_COMPANY' };
    attachGrants(user, { fullAccess: false, grants } as never);
    return user;
  };

  it('the key alone shows the cost, with none of the five', () => {
    expect(maySeeCost(holding('costs.view'))).toBe(true);
  });

  it('NEGATIVE: each of the five old keys, alone, shows nothing any more', () => {
    for (const old of ['inventory.view', 'inventory.adjust', 'production.view', 'production.manage', 'finance.view']) {
      expect(maySeeCost(holding(old)), `${old} وحده ما زال يفتح الكلفة`).toBe(false);
    }
  });

  it('NEGATIVE: all five together, without the key, show nothing', () => {
    expect(maySeeCost(holding('inventory.view', 'inventory.adjust', 'production.view', 'production.manage', 'finance.view'))).toBe(false);
  });

  it('the legacy baseline of every role that held one of the five carries the key — the warehouse, the accountant, the managers', () => {
    const holders = Object.keys(ROLE_PERMISSIONS).filter((r) => {
      const keys = legacyEffectiveKeys(r as keyof typeof ROLE_PERMISSIONS);
      return ['inventory.view', 'inventory.adjust', 'production.view', 'production.manage', 'finance.view'].some((k) => keys.includes(k));
    });
    expect(holders.length, 'a check over nobody would pass for the wrong reason').toBeGreaterThan(3);
    for (const r of holders) expect(legacyEffectiveKeys(r as keyof typeof ROLE_PERMISSIONS), r).toContain('costs.view');
    for (const r of Object.keys(ROLE_PERMISSIONS)) {
      if (!holders.includes(r)) expect(legacyEffectiveKeys(r as keyof typeof ROLE_PERMISSIONS), r).not.toContain('costs.view');
    }
  });

  it('and the inventory and stock doors ask it, not the stock key', () => {
    for (const file of ['src/app/api/inventory/route.ts', 'src/app/api/products/[id]/stock/route.ts']) {
      const src = stripComments(repoFile(file));
      expect(src, `${file}: بلا maySeeCost`).toMatch(/const showCost = maySeeCost\(user\)/);
    }
    const stock = stripComments(repoFile('src/app/api/products/[id]/stock/route.ts'));
    expect(stock, 'كلفة المخزون تُرسل للجميع').toMatch(/\.\.\.\(showCost \? \{ averageCost: cost\.average, nextOutCost: cost\.nextOut, stockValue: cost\.stockValue \} : \{\}\)/);
    const inv = stripComments(repoFile('src/app/api/inventory/route.ts'));
    expect(inv, 'آخر كلفة تُرسل للجميع').toMatch(/\.\.\.\(showCost\s*\?\s*\{\s*lastUnitCost,/);
  });
});
