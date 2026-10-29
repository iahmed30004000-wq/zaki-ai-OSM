import { describe, expect, it } from 'vitest';
import { ALL_CATALOG_KEYS, PERMISSION_MODULES, dependentsOf, newOrphans, requiredChain } from './permission-catalog';
import { heldAfter, planOverride, removalBlock, type PlanDraft, type PlanRow } from './override-plan';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE EXCEPTION, AND WHAT IT PULLS WITH IT.
 *
 * The exceptions door refuses a list that leaves a person holding an action
 * without the key that opens its screen. So the editor must never SEND such a
 * list: «منح» on «تعديل الطلبات» grants «عرض الطلبات» with it, and «منع» on
 * «عرض الطلبات» denies the actions that need it — and says so before the press.
 *
 * The last block sweeps EVERY key in the catalog, both effects, over several
 * roles, and holds the plan to the door's own rule (`newOrphans`) — by laying
 * the exceptions over the role the way the engine does, written out again
 * here and not imported from the code under test.
 * ═══════════════════════════════════════════════════════════════════════
 */

const draft = (key: string, effect: 'ALLOW' | 'DENY', scope: PlanDraft['scope'] = 'ALL_COMPANY', scopeIds: string[] = []): PlanDraft => ({
  key, effect, scope, scopeIds,
});
const everyone = () => true;
const nobody = () => false;
const keysOf = (rows: PlanRow[]) => rows.map((r) => `${r.effect}:${r.permission}`).sort();

describe('«منح» on an action', () => {
  it('grants the screen key with it, at the same scope when the key offers it', () => {
    const plan = planOverride({ baseKeys: [], others: [], draft: draft('orders.edit', 'ALLOW', 'OWN'), canGrant: everyone });
    expect(plan.blocked).toBeNull();
    expect(plan.list).toHaveLength(2);
    expect(plan.list).toContainEqual({ permission: 'orders.view', effect: 'ALLOW', scope: 'OWN' });
    expect(plan.list).toContainEqual({ permission: 'orders.edit', effect: 'ALLOW', scope: 'OWN' });
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain('«عرض الطلبات»');
  });

  it('a scope the screen key does not offer becomes the whole company, with no ids', () => {
    const plan = planOverride({
      baseKeys: [], others: [], draft: draft('products.edit', 'ALLOW', 'SPECIFIC', ['p1']), canGrant: everyone,
    });
    const view = plan.list.find((r) => r.permission === 'products.view');
    expect(view).toEqual({ permission: 'products.view', effect: 'ALLOW', scope: 'SPECIFIC', scopeIds: ['p1'] });
    // orders.view offers no SPECIFIC scope: an action that somehow carried one gets ALL_COMPANY.
    const odd = planOverride({ baseKeys: [], others: [], draft: draft('orders.edit', 'ALLOW', 'SPECIFIC', ['p1']), canGrant: everyone });
    expect(odd.list.find((r) => r.permission === 'orders.view')).toEqual({ permission: 'orders.view', effect: 'ALLOW', scope: 'ALL_COMPANY' });
  });

  it('adds nothing when the person already holds the screen key — from the role, or from another exception', () => {
    const fromRole = planOverride({ baseKeys: ['orders.view'], others: [], draft: draft('orders.edit', 'ALLOW'), canGrant: nobody });
    expect(keysOf(fromRole.list)).toEqual(['ALLOW:orders.edit']);
    expect(fromRole.notes).toEqual([]);
    expect(fromRole.blocked).toBeNull();

    const other: PlanRow[] = [{ permission: 'orders.view', effect: 'ALLOW', scope: 'OWN' }];
    const fromOther = planOverride({ baseKeys: [], others: other, draft: draft('orders.edit', 'ALLOW'), canGrant: nobody });
    expect(keysOf(fromOther.list)).toEqual(['ALLOW:orders.edit', 'ALLOW:orders.view']);
    expect(fromOther.notes).toEqual([]);
  });

  it('lifts a «منع» on the screen key it needs, and says so', () => {
    const others: PlanRow[] = [{ permission: 'orders.view', effect: 'DENY' }];
    const plan = planOverride({ baseKeys: ['orders.view'], others, draft: draft('orders.edit', 'ALLOW'), canGrant: everyone });
    expect(keysOf(plan.list)).toEqual(['ALLOW:orders.edit', 'ALLOW:orders.view']);
    expect(plan.notes[0]).toContain('ينشال المنع');
  });

  it('is blocked, in Arabic and before the press, when the person cannot grant the screen key', () => {
    const plan = planOverride({ baseKeys: [], others: [], draft: draft('orders.edit', 'ALLOW'), canGrant: nobody });
    expect(plan.blocked).toBe('«تعديل الطلبات» بتحتاج «عرض الطلبات»، وإنت ما عندك «عرض الطلبات» لتمنحها.');
  });

  it('follows a chain one link at a time: import needs create, and nothing more', () => {
    const plan = planOverride({ baseKeys: [], others: [], draft: draft('orders.import', 'ALLOW'), canGrant: everyone });
    expect(keysOf(plan.list)).toEqual(['ALLOW:orders.create', 'ALLOW:orders.import']);
  });

  it('NEGATIVE: a view and a standalone action pull nothing with them', () => {
    for (const key of ['orders.view', 'orders.create', 'customers.create', 'finance.view']) {
      const plan = planOverride({ baseKeys: [], others: [], draft: draft(key, 'ALLOW'), canGrant: nobody });
      expect(keysOf(plan.list), key).toEqual([`ALLOW:${key}`]);
      expect(plan.notes, key).toEqual([]);
      expect(plan.blocked, key).toBeNull();
    }
  });
});

describe('«منع» on a screen key', () => {
  it('denies the actions the person would still hold, and only those', () => {
    const plan = planOverride({
      baseKeys: ['orders.view', 'orders.edit', 'orders.navigate', 'products.view'],
      others: [],
      draft: draft('orders.view', 'DENY'),
      canGrant: nobody,
    });
    expect(keysOf(plan.list)).toEqual(['DENY:orders.edit', 'DENY:orders.navigate', 'DENY:orders.view']);
    expect(plan.notes).toHaveLength(2);
    for (const n of plan.notes) expect(n).toContain('«عرض الطلبات»');
    // NEGATIVE: an action the person does not hold, and keys of another area, are left alone.
    expect(plan.list.some((r) => r.permission === 'orders.confirm' || r.permission === 'products.view')).toBe(false);
  });

  it('replaces a «منح» the person was given on the action — it would be an orphan once the view is gone', () => {
    const others: PlanRow[] = [{ permission: 'orders.edit', effect: 'ALLOW', scope: 'ALL_COMPANY' }];
    const plan = planOverride({ baseKeys: ['orders.view'], others, draft: draft('orders.view', 'DENY'), canGrant: nobody });
    expect(keysOf(plan.list)).toEqual(['DENY:orders.edit', 'DENY:orders.view']);
  });

  it('keeps every other exception verbatim', () => {
    const others: PlanRow[] = [
      { permission: 'finance.view', effect: 'DENY' },
      { permission: 'products.view', effect: 'ALLOW', scope: 'CATEGORY', scopeIds: ['c1'] },
    ];
    const plan = planOverride({ baseKeys: ['orders.view'], others, draft: draft('orders.view', 'DENY'), canGrant: nobody });
    expect(plan.list).toContainEqual(others[0]);
    expect(plan.list).toContainEqual(others[1]);
  });

  it('NEGATIVE: a «منع» on an action, or on a view nothing needs, adds nothing', () => {
    const plan = planOverride({ baseKeys: ['orders.view', 'orders.edit'], others: [], draft: draft('orders.edit', 'DENY'), canGrant: nobody });
    expect(keysOf(plan.list)).toEqual(['DENY:orders.edit']);
    const alone = planOverride({ baseKeys: ['audit.view'], others: [], draft: draft('audit.view', 'DENY'), canGrant: nobody });
    expect(keysOf(alone.list)).toEqual(['DENY:audit.view']);
    expect(alone.notes).toEqual([]);
  });
});

describe('removing one exception', () => {
  const role = ['orders.view', 'orders.edit'];

  it('is refused when lifting a «منح» on a screen key would leave its action without it', () => {
    const rows: PlanRow[] = [{ permission: 'orders.view', effect: 'ALLOW' }, { permission: 'orders.edit', effect: 'ALLOW' }];
    const msg = removalBlock({ baseKeys: [], rows, removing: 'orders.view' });
    expect(msg).toContain('ما بينشال');
    expect(msg).toContain('«عرض الطلبات»');
    expect(msg).toContain('«تعديل الطلبات»');
  });

  it('is refused when lifting a «منع» on an action while its screen key stays denied', () => {
    const rows: PlanRow[] = [{ permission: 'orders.view', effect: 'DENY' }, { permission: 'orders.edit', effect: 'DENY' }];
    const msg = removalBlock({ baseKeys: role, rows, removing: 'orders.edit' });
    expect(msg).toContain('ما بينشال المنع عن «تعديل الطلبات»');
    expect(msg).toContain('امنحه «عرض الطلبات»');
  });

  it('NEGATIVE: lifting what nothing depends on is allowed, and so is the «منع» on a screen key', () => {
    const rows: PlanRow[] = [{ permission: 'orders.view', effect: 'DENY' }, { permission: 'orders.edit', effect: 'DENY' }];
    // Lifting the view's «منع» gives the view back — the actions come back WITH it.
    expect(removalBlock({ baseKeys: role, rows, removing: 'orders.view' })).toBeNull();
    expect(removalBlock({ baseKeys: role, rows: [{ permission: 'audit.view', effect: 'ALLOW' }], removing: 'audit.view' })).toBeNull();
    expect(removalBlock({ baseKeys: role, rows, removing: 'finance.view' })).toBeNull();
  });
});

describe('every key, both effects, over several roles', () => {
  const ALL = [...ALL_CATALOG_KEYS];
  /** The engine, written out again: «منع» removes, «منح» adds. */
  const engine = (base: Iterable<string>, rows: PlanRow[]) => {
    const held = new Set(base);
    for (const r of rows) (r.effect === 'DENY' ? held.delete(r.permission) : held.add(r.permission));
    return held;
  };

  const roles = (key: string): Array<[string, string[]]> => [
    ['a role that gives nothing', []],
    ['a role that gives everything', ALL],
    ['a role that gives only what the key needs', requiredChain(key)],
    ['a role that gives the actions that need the key, but not the key', dependentsOf(key)],
    ['a role that gives the key and everything that needs it', [key, ...requiredChain(key), ...dependentsOf(key)]],
  ];
  const stored = (key: string): Array<[string, PlanRow[]]> => [
    ['no other exception', []],
    ['a «منع» on everything the key needs', requiredChain(key).map((k) => ({ permission: k, effect: 'DENY' as const }))],
    ['a «منح» on everything that needs the key', dependentsOf(key).map((k) => ({ permission: k, effect: 'ALLOW' as const, scope: 'ALL_COMPANY' }))],
  ];

  it('never sends a list that adds an orphan — whoever the person is, whatever else they were given', () => {
    let cases = 0;
    for (const item of PERMISSION_MODULES.flatMap((m) => m.items)) {
      for (const effect of ['ALLOW', 'DENY'] as const) {
        for (const [roleName, base] of roles(item.key)) {
          for (const [storedName, others] of stored(item.key)) {
            // The plan replaces an exception on the key itself, so the "stored" rows never include it.
            const rows = others.filter((r) => r.permission !== item.key);
            const plan = planOverride({ baseKeys: base, others: rows, draft: draft(item.key, effect), canGrant: everyone });
            const where = `${effect} ${item.key} · ${roleName} · ${storedName}`;
            expect(plan.blocked, where).toBeNull();
            const before = engine(base, rows);
            const after = engine(base, plan.list);
            expect(newOrphans(before, after), where).toEqual([]);
            // The exception that was asked for is in the list, as asked.
            expect(plan.list.find((r) => r.permission === item.key)?.effect, where).toBe(effect);
            // Every key in the list is a real one, once.
            const names = plan.list.map((r) => r.permission);
            expect(new Set(names).size, where).toBe(names.length);
            for (const n of names) expect(ALL_CATALOG_KEYS.has(n), `${where}: ${n}`).toBe(true);
            cases++;
          }
        }
      }
    }
    expect(cases, 'the sweep ran').toBeGreaterThan(1000);
  });

  it('and is blocked, never silently short, when the person cannot grant what a «منح» needs', () => {
    for (const item of PERMISSION_MODULES.flatMap((m) => m.items)) {
      const plan = planOverride({ baseKeys: [], others: [], draft: draft(item.key, 'ALLOW'), canGrant: nobody });
      if (requiredChain(item.key).length === 0) expect(plan.blocked, item.key).toBeNull();
      else expect(plan.blocked, item.key).toContain('وإنت ما عندك');
    }
  });

  it('the held set it reasons over is the engine’s: «منع» removes, «منح» adds', () => {
    const rows: PlanRow[] = [{ permission: 'a.x', effect: 'DENY' }, { permission: 'b.y', effect: 'ALLOW' }];
    expect([...heldAfter(['a.x', 'c.z'], rows)].sort()).toEqual(['b.y', 'c.z']);
  });
});
