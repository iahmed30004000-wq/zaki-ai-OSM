import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_CATALOG_KEYS,
  MODULE_LABELS,
  PERMISSION_MODULES,
  RETIRED_KEYS,
  SCOPE_LABELS,
  catalogItem,
  dependentsOf,
  isRetiredKey,
  newOrphans,
  orphanPairs,
  requiredChain,
  viewGrantFor,
  withoutRetired,
} from './permission-catalog';
import { LEGACY_ALIAS } from './permission-aliases';
import { ALL_ROUTES } from './route-registry';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PERMISSION MODEL — an action names the key that opens its screen.
 *
 * «تعديل الطلبات» ticked without «عرض الطلبات» is a box that is on and does
 * nothing: the person can never reach the button. The catalog now says, for
 * every action, which key it needs (`requires`), and the three places that
 * can create such a pair — the screens, the doors, and the engine one day —
 * all read the same field. This file holds the field itself still.
 *
 * The 67 pairs are written out BELOW rather than read back from the catalog:
 * a test that derives its expectation from the thing it checks passes when
 * the thing is empty.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** [action, the key that opens its screen] — only pairs whose two keys exist today. */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['orders.navigate', 'orders.view'], ['orders.import', 'orders.create'], ['orders.edit', 'orders.view'],
  ['orders.contact_log', 'orders.view'], ['orders.confirm', 'orders.view'], ['orders.assign', 'orders.view'],
  ['orders.claim', 'orders.view'], ['orders.release', 'orders.view'], ['orders.unlock', 'orders.view'],
  ['orders.change_status', 'orders.view'], ['reports.export', 'orders.view'],
  ['customers.view', 'customers.view_basic'],
  ['products.create', 'products.view'], ['products.edit', 'products.view'], ['products.change_price', 'products.view'],
  ['products.upload_images', 'products.view'], ['products.delete', 'products.view'],
  ['offers.manage', 'offers.view'], ['inventory.adjust', 'inventory.view'], ['production.manage', 'production.view'],
  ['finance.create', 'finance.view'], ['finance.update', 'finance.view'],
  ['settlement.upload', 'settlement.view'], ['settlement.review', 'settlement.view'],
  ['payroll.pay', 'payroll.view'], ['penalties.decide', 'penalties.view'], ['confirmation.pull', 'confirmation.work'],
  ['whatsapp.send', 'whatsapp.view'], ['whatsapp.assign', 'whatsapp.view'], ['whatsapp.manage', 'whatsapp.view'],
  ['telegram.manage', 'telegram.view'],
  ['users.create', 'users.view'], ['users.edit', 'users.view'],
  ['roles.create', 'roles.view'], ['roles.edit', 'roles.view'], ['roles.delete', 'roles.view'],
  ['settings.edit', 'settings.view'], ['settings.manage', 'settings.view'], ['geo.manage', 'geo.view'],
  ['storefront.manage', 'storefront.view'], ['storefront.publish', 'storefront.view'], ['storefront.domain', 'storefront.view'],
  ['landing_pages.create', 'landing_pages.view'], ['landing_pages.edit', 'landing_pages.view'],
  ['landing_pages.delete', 'landing_pages.view'], ['landing_pages.publish', 'landing_pages.view'],
  ['apps.manage', 'apps.view'],
  // PR-4: the settings doors that got a box each (migration 20261029150000_settings_split_keys). 47 -> 56.
  ['orders.migrate', 'orders.import'], ['offers.rules', 'settings.view'], ['settings.jobs', 'settings.view'],
  ['settings.messages', 'settings.view'], ['settings.delivery_fees', 'settings.view'], ['settings.tracking', 'settings.view'],
  ['penalties.rules', 'settings.view'], ['team.settings', 'settings.view'], ['commission.manage', 'commission.view'],
  // PR-6: the order actions that got a box each (migration 20261030130000_order_action_keys). 56 -> 63.
  ['orders.change_price', 'orders.edit'], ['orders.change_fee', 'orders.change_status'], ['orders.cancel', 'orders.view'],
  ['orders.note', 'orders.view'], ['orders.request_change', 'orders.view'], ['orders.rating_link', 'orders.view'],
  ['control.blacklist_manage', 'control.blacklist'],
  // PR-7: the confirmation and change-request doors that got a box each (migration 20261030140000_confirmation_split_keys). 63 -> 67.
  ['confirmation.winback', 'confirmation.supervise'], ['confirmation.reassign', 'confirmation.supervise'],
  ['confirmation.issues_correct', 'confirmation.issues'], ['control.change_requests', 'control.change_requests_view'],
];

const items = PERMISSION_MODULES.flatMap((m) => m.items);

describe('the catalog names what each action needs', () => {
  it('holds exactly the 67 pairs — none lost, none invented', () => {
    const actual = items.filter((i) => i.requires).map((i) => [i.key, i.requires] as const);
    expect(EXPECTED).toHaveLength(67);
    expect(actual.length, 'عدد الأزواج').toBe(EXPECTED.length);
    for (const [action, view] of EXPECTED) {
      expect(catalogItem(action)?.requires, `${action} لازم يطلب ${view}`).toBe(view);
    }
  });

  it('points only at keys that exist, are not retired, and are not aliases of something else', () => {
    for (const i of items) {
      if (!i.requires) continue;
      expect(ALL_CATALOG_KEYS.has(i.requires), `${i.key} بيطلب مفتاح مش بالقائمة: ${i.requires}`).toBe(true);
      expect(i.requires, `${i.key} بيطلب نفسه`).not.toBe(i.key);
      expect(isRetiredKey(i.requires), `${i.key} بيطلب مفتاح متقاعد`).toBe(false);
      // R6: a catalog key is a real box; the alias table holds only names that are not.
      expect(Object.keys(LEGACY_ALIAS).includes(i.requires), `${i.requires} اسم بديل`).toBe(false);
    }
  });

  it('has no cycle, and every chain ends at a key that needs nothing', () => {
    for (const i of items) {
      const chain = requiredChain(i.key);
      expect(chain.length, `${i.key}: سلسلة طويلة أو دائرية`).toBeLessThan(6);
      expect(chain.includes(i.key), `${i.key} بيعتمد على نفسه`).toBe(false);
      const last = chain.length ? chain[chain.length - 1] : i.key;
      expect(catalogItem(last)?.requires ?? null, `${i.key}: السلسلة ما وقفت`).toBeNull();
    }
  });

  it('says why when an action needs nothing: a standalone action carries its note', () => {
    const standalone = items.filter((i) => i.requires === null);
    // ai.assist (PR-5): no screen and no list of its own — it is held WITH the key of the work the helper sits in (R4).
    // confirmation.raise_issue and ops.decide_changes (PR-7): each has its own button or door and shows no list (R4).
    expect(standalone.map((i) => i.key).sort()).toEqual(['ai.assist', 'confirmation.raise_issue', 'customers.create', 'ops.decide_changes', 'orders.create']);
    for (const i of standalone) expect((i.note ?? '').trim().length, `${i.key} بلا ملاحظة`).toBeGreaterThan(10);
  });

  it('walks a chain nearest first, and finds every key that needs a given one', () => {
    expect(requiredChain('orders.import')).toEqual(['orders.create']);
    expect(requiredChain('orders.edit')).toEqual(['orders.view']);
    expect(requiredChain('orders.view')).toEqual([]);
    expect(dependentsOf('orders.create')).toEqual(['orders.import', 'orders.migrate']);
    const onOrders = dependentsOf('orders.view');
    for (const k of ['orders.edit', 'orders.navigate', 'orders.confirm', 'reports.export']) expect(onOrders).toContain(k);
    // NEGATIVE: a standalone action and an unrelated view are not on the list.
    expect(onOrders).not.toContain('orders.create');
    expect(onOrders).not.toContain('customers.view');
  });
});

describe('the keys the catalog stops offering', () => {
  it('names only keys the catalog no longer offers — a key joins in the SAME change that removes its last check', () => {
    /*
     * ⚠️ DO NOT "FIX" THIS BY ADDING A KEY. A key listed here is stripped
     * from every role and exception list on its next save. `categories.view`
     * is still asked by a route today: naming it would delete the row from
     * the first role the owner saves, and everybody on that role would lose a
     * working door with nothing saying so. `analytics.view` went on 29/10:
     * nothing asks it (the dashboard's numbers, the report and growth doors
     * ask `reports.view`), and a migration gave its holders that key.
     */
    expect(RETIRED_KEYS).toEqual(['analytics.view']);
    expect(ALL_CATALOG_KEYS.has('analytics.view')).toBe(false);
    expect(isRetiredKey('analytics.view')).toBe(true);
    // NEGATIVE: a retired key that is still offered would show up as a box on the roles screen.
    for (const k of RETIRED_KEYS) expect(ALL_CATALOG_KEYS.has(k), `${k} still offered`).toBe(false);
    expect(ALL_CATALOG_KEYS.has('categories.view')).toBe(true);
  });

  it('strips by the list it is given, and leaves a malformed row for validation to refuse', () => {
    const rows = [{ permission: 'a.old' }, { permission: 'orders.view' }, null, { permission: 7 }, 'x'];
    expect(withoutRetired(rows, ['a.old'])).toEqual([{ permission: 'orders.view' }, null, { permission: 7 }, 'x']);
    // With nothing retired every row stays, in order (and it is a copy).
    const same = withoutRetired(rows);
    expect(same).toEqual(rows);
    expect(same).not.toBe(rows);
  });
});

describe('an action without the key that opens its screen', () => {
  it('is found by presence alone — the scope is never compared', () => {
    expect(orphanPairs(['orders.view', 'orders.edit'])).toEqual([]);
    expect(orphanPairs(['orders.edit'])).toEqual([{ action: 'orders.edit', view: 'orders.view' }]);
    // A standalone action alone is whole.
    expect(orphanPairs(['orders.create', 'customers.create'])).toEqual([]);
    // Holding the view without the action is whole, too.
    expect(orphanPairs(['orders.view'])).toEqual([]);
  });

  it('names every missing pair, in catalog order', () => {
    const got = orphanPairs(['products.edit', 'orders.edit', 'orders.import']);
    expect(got.map((p) => `${p.action}>${p.view}`)).toEqual([
      'orders.edit>orders.view',
      'orders.import>orders.create',
      'products.edit>products.view',
    ]);
  });

  it('judges only what a save ADDS: the old pair stays, a second action on the same missing key does not', () => {
    // The shipped templates hold «عرض العملاء» without the basic tier.
    const stored = ['customers.view', 'orders.view'];
    expect(orphanPairs(stored)).toHaveLength(1);
    expect(newOrphans(stored, stored)).toEqual([]);
    expect(newOrphans(stored, [...stored, 'customers.create'])).toEqual([]);
    expect(newOrphans(stored, [...stored, 'orders.edit'])).toEqual([]);
    expect(newOrphans(stored, ['customers.view', 'orders.edit'])).toEqual([{ action: 'orders.edit', view: 'orders.view' }]);
    // NEGATIVE: taking the view off from under an action is a NEW pair.
    expect(newOrphans(['orders.view', 'orders.edit'], ['orders.edit'])).toEqual([{ action: 'orders.edit', view: 'orders.view' }]);
  });
});

describe('the grant a pulled-in key gets', () => {
  it('copies the scope when the key offers it, with its ids, and otherwise is for the whole company', () => {
    expect(viewGrantFor('orders.view', { scope: 'OWN', scopeIds: [] })).toEqual({ scope: 'OWN', scopeIds: [] });
    expect(viewGrantFor('products.view', { scope: 'SPECIFIC', scopeIds: ['p1', 'p2'] })).toEqual({ scope: 'SPECIFIC', scopeIds: ['p1', 'p2'] });
    // NEGATIVE: a key that offers no CATEGORY scope does not get one.
    expect(viewGrantFor('orders.view', { scope: 'CATEGORY', scopeIds: ['c1'] })).toEqual({ scope: 'ALL_COMPANY', scopeIds: [] });
    expect(viewGrantFor('orders.view', { scope: 'ALL_COMPANY', scopeIds: [] })).toEqual({ scope: 'ALL_COMPANY', scopeIds: [] });
  });

  it('does not share the array it was given', () => {
    const ids = ['p1'];
    expect(viewGrantFor('products.view', { scope: 'SPECIFIC', scopeIds: ids }).scopeIds).not.toBe(ids);
  });
});

describe('what a key says it opens', () => {
  it('is the menu name of a screen whose route lists that key', () => {
    const labelsOf = (key: string) => ALL_ROUTES.filter((r) => (r.permissions ?? []).includes(key)).map((r) => r.label);
    let checked = 0;
    for (const i of items) {
      for (const name of i.opens ?? []) {
        expect(labelsOf(i.key), `${i.key} بيقول إنه بيفتح «${name}»`).toContain(name);
        checked++;
      }
    }
    expect(checked, 'ما في ولا مفتاح بيقول شو بيفتح').toBeGreaterThan(30);
  });
});

describe('the word for a scope of categories', () => {
  it('is «تصنيفات محددة», as the products screen says, and no module is named after a menu that does not exist', () => {
    expect(SCOPE_LABELS.CATEGORY.ar).toBe('تصنيفات محددة');
    expect(Object.values(SCOPE_LABELS).some((l) => l.ar.includes('فئ'))).toBe(false);
    expect(Object.keys(MODULE_LABELS)).not.toContain('categories');
    for (const m of PERMISSION_MODULES) expect(MODULE_LABELS[m.module], `${m.module} بلا عنوان`).toBeTruthy();
  });
});

describe('the audit script reads the alias file', () => {
  it('imports LEGACY_ALIAS instead of scraping the file that no longer holds the table', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'audit-permissions.ts'), 'utf8');
    expect(src).toContain("from '../src/lib/permission-aliases'");
    expect(src).toContain('Object.entries(LEGACY_ALIAS)');
    // NEGATIVE: the old scrape of authorization.ts is gone (it found nothing and called live keys dead).
    expect(src).not.toMatch(/readFileSync\(join\(SRC, 'lib', 'authorization\.ts'\)/);
  });
});

describe('the pre-deploy report', () => {
  const sql = readFileSync(join(process.cwd(), 'scripts', 'permission-predeploy-report.sql'), 'utf8');
  const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('lists exactly the catalog’s pairs — a list that drifted would report the wrong roles', () => {
    const listed = [...body.matchAll(/\('([a-z_.]+)','([a-z_.]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const wanted = EXPECTED.map(([a, v]) => `${a}>${v}`).sort();
    expect(listed).toEqual(wanted);
  });

  it('only reads: no statement in it writes, creates or drops anything', () => {
    // The quoted key names are values (orders.create is a key, not a statement): strip them before looking at the words.
    const code = body.replace(/'[^']*'/g, "''");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(code).toMatch(/\bSELECT\b/);
  });
});
