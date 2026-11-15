import { describe, expect, it, vi } from 'vitest';
import { can, attachGrants } from './authorization';

vi.mock('./db', () => ({ db: {} }));

import { ALL_ROUTES, NAV, canAccessRoute, findRoute, visibleNav } from './route-registry';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A MENU ARRANGED BY SUBJECT, WHEN THE WORK RUNS BY STEP.
 *
 * The owner, 21/10: «حاسو معجوق وصعب جدا التعامل معه … الخطوة يتودي
 * للثانية». The two parcels' roads that the whole product exists for — a
 * parcel from the shelf to the courier and back, and the courier's money
 * from his hand to the books — were filed as if they were lists:
 *
 *   • shipping was already in the order the work goes, but nothing said so;
 *   • the money was «collection, matching, custody», with the closing two
 *     entries further on — the errand read backwards;
 *   • the AI's configuration sat in the group of the thing it configures,
 *     which broke the contract's own rule (operations with the work,
 *     configuration in settings) — the WhatsApp inbox and its setup are
 *     already split that way;
 *   • «التطبيقات» was a heading you opened to find two links; and
 *   • «الخصومات» sat one row from «تنبيهات الخصم», two meanings of one
 *     root — money off a salary, and a price cut for a customer.
 *
 * Nothing here moved an address. Every screen is at the path it was at, so
 * no bookmark, no notification and no saved arrangement changes meaning:
 * the registry is keyed on paths and a layout is three lists of them.
 * ═══════════════════════════════════════════════════════════════════════
 */

const group = (key: string) => NAV.find((g) => g.key === key)!;
const pathsOf = (key: string) => group(key).routes.map((r) => r.path);

function userWith(keys: string[], role = 'WAREHOUSE') {
  const user = { id: 'u1', role, status: 'ACTIVE', permissions: keys } as any;
  return attachGrants(user, {
    fullAccess: false,
    grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])),
  });
}

describe('shipping is one parcel’s road, and the road is numbered', () => {
  it('— five stops, in the order the parcel goes', () => {
    expect(group('ops').label).toBe('الشحن');
    expect(pathsOf('ops')).toEqual([
      '/ops/preparation',
      '/ops/shipments/new',
      '/ops/batches',
      '/ops/tracking',
      '/ops/returns',
    ]);
    expect(group('ops').routes.map((r) => r.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it('and the courier’s money is one errand, walked custody → statement → match → close', () => {
    expect(pathsOf('finance').slice(0, 4)).toEqual([
      '/finance/agents',
      '/finance/collection',
      '/finance/matching',
      '/finance/closing',
    ]);
    expect(group('finance').routes.slice(0, 4).map((r) => r.step)).toEqual([1, 2, 3, 4]);
  });

  it('while the wallets, the transfers and the profit are NOT steps of it', () => {
    // Where the money ends up and what it earned — not part of the errand,
    // and a number on them would say they were.
    for (const path of ['/finance/wallets', '/finance/transfers', '/finance/profit']) {
      expect(findRoute(path)!.step, path).toBeUndefined();
    }
  });

  it('and no other group is numbered — a menu is not a wizard', () => {
    const numbered = NAV.filter((g) => g.routes.some((r) => r.step !== undefined)).map((g) => g.key);
    expect(numbered).toEqual(['ops', 'finance']);
  });

  it('and a step is unique within its group, so two stops never claim to be the third', () => {
    for (const g of NAV) {
      const steps = g.routes.map((r) => r.step).filter((s): s is number => s !== undefined);
      expect(new Set(steps).size, g.key).toBe(steps.length);
    }
  });
});

describe('a number belongs to the SCREEN, not to its place in the list', () => {
  it('— somebody who may open only the first and the last stop sees «1» and «5»', () => {
    /*
     * THE CLAIM THAT RULES OUT COMPUTING IT FROM THE INDEX.
     *
     * A warehouse keeper holds ops.prepare and ops.returns and nothing in
     * between. If the number were the position in what they can see, this
     * would read «1» and «2» — and «2» is the wrong answer: returns is the
     * fifth stop, and saying so is the whole point of numbering a road.
     */
    const nav = visibleNav(userWith(['ops.prepare', 'ops.returns']), can);
    const ops = nav.find((g) => g.key === 'ops')!;
    expect(ops.routes.map((r) => [r.path, r.step])).toEqual([
      ['/ops/preparation', 1],
      ['/ops/returns', 5],
    ]);
  });

  it('and it is data only — the access check never reads it', () => {
    /*
     * A hint is not a gate. The function that decides who may open a screen
     * must not mention `step`: if it ever did, «you have not done stop 2»
     * would start to mean «you may not open stop 3».
     */
    const src = stripComments(repoFile('src/lib/route-registry.ts'));
    const body = src.slice(src.indexOf('export function canAccessRoute'));
    // The `\r?` is because a Windows checkout ends its lines in CRLF, and a
    // slice that looks for a bare newline-brace-newline finds nothing there
    // and ends up checking two characters of a function it never read.
    const end = body.search(/\r?\n\}\r?\n/);
    expect(end, 'ما لقيت نهاية الدالة').toBeGreaterThan(0);
    const fn = body.slice(0, end);
    expect(fn).toContain('route.permissions');
    expect(fn, 'canAccessRoute بدأت تقرأ الخطوة').not.toMatch(/\.step\b/);
  });

  it('and a person may open stop 4 without ever having opened 1, 2 or 3', () => {
    const tracker = userWith(['ops.track']);
    expect(canAccessRoute(tracker, findRoute('/ops/tracking')!, can)).toBe(true);
    expect(canAccessRoute(tracker, findRoute('/ops/preparation')!, can)).toBe(false);
  });
});

describe('operations sit with the work, and configuration sits in settings', () => {
  it('— the AI’s wiring is in settings, beside every other thing that is wired', () => {
    expect(pathsOf('settings')).toContain('/settings/ai');
    expect(pathsOf('growth')).not.toContain('/settings/ai');
  });

  it('and the AI’s work stays where the work is, as three distinct screens', () => {
    for (const path of ['/assistant', '/growth/intelligence', '/growth/bench']) {
      expect(pathsOf('growth'), path).toContain(path);
    }
    expect(group('growth').label).toBe('النمو والذكاء');
  });

  it('and the WhatsApp and Telegram pairing is the same shape: inbox here, setup there', () => {
    // The pairing the contract already had, which the AI was the exception to.
    // The inboxes are their own group, «المحادثات», since the menu was folded.
    expect(pathsOf('chats')).toEqual(['/growth/whatsapp/inbox', '/growth/telegram/orders']);
    // …and the setup is ONE page now, «الربط», with a card for each (owner, 24/10).
    expect(pathsOf('settings')).toContain('/settings/links');
    expect(pathsOf('settings')).not.toContain('/settings/whatsapp');
    expect(pathsOf('settings')).not.toContain('/settings/telegram');
  });

  it('and nothing under /settings is filed in another group', () => {
    for (const g of NAV.filter((x) => x.key !== 'settings')) {
      for (const route of g.routes) {
        expect(route.path.startsWith('/settings/'), `${route.path} في «${g.label}»`).toBe(false);
      }
    }
  });

  it('and the only things in settings that are NOT /settings/… are the front door and the three that arrived', () => {
    // Pinned by name so a fifth cannot drift in unnoticed: settings is the
    // group that grows by one «while we're here» at a time. The front door is
    // `/settings` itself — the page of cards the menu's one line opens.
    const arrived = pathsOf('settings').filter((p) => !p.startsWith('/settings/'));
    expect(arrived).toEqual(['/settings', '/apps/store', '/apps/installed', '/admin/jobs']);
  });

  it('and the schedule is no longer filed with the staff', () => {
    expect(pathsOf('admin')).not.toContain('/admin/jobs');
    expect(pathsOf('admin')).toEqual(['/admin/users', '/admin/permissions', '/admin/profile']);
    // Its own gate did not move: only the shelf it stands on.
    expect(findRoute('/admin/jobs')!.permissions).toEqual(['settings.view']);
  });
});

describe('two entries, one root, and nobody guessing which is which', () => {
  it('— the staff deductions say whose they are', () => {
    const penalties = findRoute('/control/penalties')!;
    const discounts = findRoute('/control/discount-alerts')!;
    expect(penalties.label).toBe('خصومات الموظفين');
    expect(penalties.label).not.toBe('الخصومات');
    expect(discounts.label).toBe('تنبيهات الخصم');
    expect(penalties.label).not.toBe(discounts.label);
  });

  it('and the screen, the tab and the menu all say the same name', () => {
    const label = findRoute('/control/penalties')!.label;
    const page = repoFile('src/app/(system)/(shell)/control/penalties/page.tsx');
    expect(page, 'عنوان التبويب غير اسم القائمة').toContain(`title: '${label}'`);

    // The screen reads its own name rather than restating it: a literal is
    // the thing that was left saying «الخصومات» after the menu moved on.
    const screen = stripComments(repoFile('src/components/screens/PenaltiesScreen.tsx'));
    expect(screen).toContain("routeLabel('/control/penalties')");
    expect(screen, 'عنوان حرفيّ ثانٍ').not.toMatch(/title="الخصومات"/);
  });
});

describe('nothing was moved that a link, a bookmark or a saved layout points at', () => {
  it('— every one of the 51 screens is still there, once, at its own address — and the front door is the 52nd', () => {
    const paths = ALL_ROUTES.map((r) => r.path);
    // 15/11: «السلات المهجورة» joined the loose main group beside «الطلبات» (contract oms-lp.v1 §9) — one more screen, one more line.
    expect(paths).toHaveLength(53);
    expect(new Set(paths).size).toBe(53);
    // The settings stand behind ONE menu line now; not one of them moved.
    for (const path of ['/settings/geo', '/settings/couriers', '/settings/tracking', '/apps/store', '/admin/jobs']) {
      expect(paths, path).toContain(path);
    }
  });

  it('and the eleven groups are the whole menu, with none left empty', () => {
    expect(NAV).toHaveLength(11);
    for (const g of NAV) expect(g.routes.length, g.key).toBeGreaterThan(0);
  });

  it('and the group keys the sidebar remembers are still real — or harmlessly gone', () => {
    // `osm.sidebar.open` stores group KEYS in the browser. `apps` no longer
    // exists, and that is fine: an unknown key is never matched, and the
    // group holding the current page opens itself. This pins that it is
    // fine, by pinning that the sidebar only ever compares keys it was
    // handed — it never indexes into a fixed list of them.
    const bar = stripComments(repoFile('src/components/shell/Sidebar.tsx'));
    expect(bar).toContain('open.has(group.key)');
    expect(bar, 'القائمة صارت تعتمد قائمة ثابتة من المفاتيح').not.toMatch(/\['main',/);
  });
});
