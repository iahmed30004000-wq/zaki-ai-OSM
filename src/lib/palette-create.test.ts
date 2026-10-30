import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';
import { ALL_ROUTES } from '@/lib/route-registry';
import { ALL_CATALOG_KEYS } from '@/lib/permission-catalog';
import { ICONS } from '@/components/shell/icons';
import { CREATE_KEYS, CREATE_PARAM, isCreateKey } from '@/lib/create-intent';
import { CREATABLES, creatablesFor } from '@/lib/palette-create';
import type { SessionUser } from '@/types/auth';

/**
 * «+ أنشئ» IN CTRL+K — THE LIST, WHO IS TOLD ABOUT IT, AND THE SCREENS THAT ANSWER IT (22/10).
 *
 * The box could find a screen and run five commands, and could create nothing. Seven forms already existed, each behind a button; the
 * box now goes to the screen the form lives on with `?new=<word>`, and the screen opens the form it already has. No form is new.
 *
 * What this file holds, and why each is a claim and not a hope:
 *
 *   1. THE LIST IS WELL FORMED — every row sits on a real screen, behind a real permission, under a name that is not a menu label
 *      (a form is not a screen under a verb), with an icon the box can draw, and the client's closed set of words is the server's list.
 *   2. THE ACCOUNT IS TOLD ONLY WHAT IT MAY DO — the screen must be openable (the registry's own question) AND the permission must be
 *      the one the form's button is behind. Each half is asked separately, because a row that fails either is a promise the box broke.
 *   3. EVERY WORD HAS A SCREEN THAT ANSWERS IT, behind the gate its own button has — read off the source of the five hosts, since a
 *      row that goes to a screen that ignores `?new=` is a row that does nothing.
 *   4. THE BOX CARRIES NO LIST — the labels are not in anything the browser downloads for every account.
 */

const user = (permissions: string[], over: Partial<SessionUser> = {}) =>
  ({ status: 'ACTIVE', role: 'STAFF', permissions, ...over }) as unknown as SessionUser;

const can = (u: SessionUser, p: string) => u.role === 'SUPER_ADMIN' || (u.permissions ?? []).includes(p);

const keysFor = (u: SessionUser) => creatablesFor(u, can).map((r) => r.key);

describe('the list is well formed', () => {
  it('has the seven forms, and the client’s closed set of words IS the server’s list — neither can grow alone', () => {
    expect(CREATABLES.map((c) => c.key)).toEqual([...CREATE_KEYS]);
    expect(new Set(CREATE_KEYS).size).toBe(CREATE_KEYS.length);
    expect(CREATE_KEYS.length).toBe(7);
  });

  it('puts every form on a screen that exists in the registry', () => {
    const paths = new Set(ALL_ROUTES.map((r) => r.path));
    for (const c of CREATABLES) expect(paths.has(c.route), `${c.key}: ${c.route} مش بالسجلّ`).toBe(true);
  });

  it('behind a permission that exists in the catalogue — a typo would offer nobody the form, silently', () => {
    for (const c of CREATABLES) expect(ALL_CATALOG_KEYS.has(c.needs), `${c.key}: ${c.needs} مش بالكتالوج`).toBe(true);
  });

  it('with an icon the box can draw — an unknown name falls back to the archive box and hides the mistake', () => {
    for (const c of CREATABLES) expect(ICONS[c.icon], `${c.key}: ${c.icon}`).toBeTruthy();
  });

  it('under a name that is no screen’s name — a form is not a screen under a verb', () => {
    const labels = new Set(ALL_ROUTES.map((r) => r.label));
    for (const c of CREATABLES) expect(labels.has(c.label), `${c.key}: «${c.label}» اسم شاشة`).toBe(false);
    expect(new Set(CREATABLES.map((c) => c.label)).size, 'اسمان متطابقان').toBe(CREATABLES.length);
  });

  it('and each row’s address is its screen with the one word — nothing else rides along', () => {
    const rows = creatablesFor(user([], { role: 'SUPER_ADMIN' }), can);
    expect(rows.length).toBe(7);
    for (const row of rows) {
      const c = CREATABLES.find((x) => x.key === row.key)!;
      expect(row.href).toBe(`${c.route}?${CREATE_PARAM}=${c.key}`);
    }
    expect(CREATE_PARAM).toBe('new');
  });

  it('and each row can be found by the noun somebody would type, and «أنشئ» / «جديد» alone find all of them', () => {
    const rows = creatablesFor(user([], { role: 'SUPER_ADMIN' }), can);
    const noun: Record<string, string> = {
      order: 'طلب', 'ai-order': 'ذكاء', 'import-orders': 'استورد', product: 'منتج', customer: 'عميل', user: 'موظف', campaign: 'حملة',
    };
    for (const row of rows) {
      expect(row.words, `${row.key}: ما فيها «أنشئ»`).toContain('أنشئ');
      expect(row.words, `${row.key}: ما فيها «جديد»`).toContain('جديد');
      expect(row.words, `${row.key}: ما فيها اسمها`).toContain(noun[row.key]);
    }
  });

  it('and a word typed into an address is only ever one of the seven', () => {
    expect(isCreateKey('product')).toBe(true);
    for (const bad of ['', 'constructor', '__proto__', 'toString', 'Product', 'orders', null, undefined, 7, ['product']]) {
      expect(isCreateKey(bad), String(bad)).toBe(false);
    }
  });
});

describe('an account is told only what it may do', () => {
  it('an owner is told all seven', () => {
    expect(keysFor(user([], { role: 'SUPER_ADMIN' }))).toEqual([...CREATE_KEYS]);
  });

  it('a desk that creates orders is told the two forms behind «orders.create», and not the import, which is behind its own key', () => {
    expect(keysFor(user(['orders.view', 'orders.create']))).toEqual(['order', 'ai-order']);
    expect(keysFor(user(['orders.view', 'orders.create', 'orders.import']))).toEqual(['order', 'ai-order', 'import-orders']);
  });

  it('the import is behind BOTH «orders.import» and «orders.create», the keys its BUTTON is behind (RV98) — neither alone offers it', () => {
    expect(keysFor(user(['orders.view', 'orders.create']))).not.toContain('import-orders');
    // was: ['import-orders'] — the dialog sends every row through the order door, which wants «orders.create» too
    expect(keysFor(user(['orders.view', 'orders.import']))).toEqual([]);
  });

  it('the screen must be openable: holding the create key without the screen’s own view key offers nothing', () => {
    // Without «orders.view» the orders screen answers «لا تملك صلاحية لهذه الشاشة» — a row that ends there is a broken promise.
    expect(keysFor(user(['orders.create']))).toEqual([]);
    expect(keysFor(user(['products.create']))).toEqual([]);
    expect(keysFor(user(['customers.create']))).toEqual([]);
    expect(keysFor(user(['users.create']))).toEqual([]);
  });

  it('and the key must be held: opening the screen is not enough', () => {
    expect(keysFor(user(['products.view']))).toEqual([]);
    expect(keysFor(user(['customers.view']))).toEqual([]);
    expect(keysFor(user(['users.view']))).toEqual([]);
  });

  it('each of the other four is offered when both halves hold', () => {
    expect(keysFor(user(['products.view', 'products.create']))).toEqual(['product']);
    expect(keysFor(user(['customers.view', 'customers.create']))).toEqual(['customer']);
    // The customers screen opens for either of two view keys.
    expect(keysFor(user(['customers.view_basic', 'customers.create']))).toEqual(['customer']);
    expect(keysFor(user(['users.view', 'users.create']))).toEqual(['user']);
    // The campaigns door is behind «campaigns.manage» (PR-11), and the screen it lands on opens on «campaigns.view».
    // was: keysFor(user(['reports.view'])) → ['campaign'] — the campaigns left the reports key; the migration gave both boxes to its holders.
    expect(keysFor(user(['campaigns.view', 'campaigns.manage']))).toEqual(['campaign']);
    // NEGATIVE: neither half alone offers it, and the old key no longer does.
    expect(keysFor(user(['campaigns.view']))).toEqual([]);
    expect(keysFor(user(['campaigns.manage']))).toEqual([]);
    expect(keysFor(user(['reports.view']))).toEqual([]);
  });

  it('an account with nothing granted is told nothing — and neither is one that is not active, whatever it holds', () => {
    expect(keysFor(user([]))).toEqual([]);
    expect(keysFor(user([], { role: 'PENDING_USER' }))).toEqual([]);
    const everything = ['orders.view', 'orders.create', 'orders.import', 'products.view', 'products.create'];
    expect(keysFor(user(everything, { status: 'SUSPENDED' as SessionUser['status'] }))).toEqual([]);
  });

  it('and a row says what it is for the screen to draw, and nothing about who may have it', () => {
    const row = creatablesFor(user([], { role: 'SUPER_ADMIN' }), can)[0];
    expect(Object.keys(row).sort()).toEqual(['hint', 'href', 'icon', 'key', 'label', 'words']);
    expect(row.hint).toBe('الطلبات');
  });
});

describe('every word has a screen that answers it, behind the gate its own button has', () => {
  /** Where each form lives. The route is the registry’s; the file is the screen that draws the button. */
  const HOSTS: Record<string, string> = {
    '/orders': 'src/components/screens/OrdersScreen.tsx',
    '/products': 'src/components/screens/ProductsScreen.tsx',
    '/customers': 'src/components/screens/CustomersScreen.tsx',
    '/admin/users': 'src/components/screens/UsersScreen.tsx',
    '/growth/campaigns': 'src/components/screens/CampaignsScreen.tsx',
  };

  /** The `useCreateIntent({ … })` argument, read off a screen’s source. */
  const intentArgument = (file: string): string => {
    const src = stripComments(repoFile(file));
    const at = src.indexOf('useCreateIntent({');
    expect(at, `${file}: ما فيها useCreateIntent`).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf('});', at) + 3);
  };

  it('knows a host for every route a form lives on', () => {
    for (const c of CREATABLES) expect(HOSTS[c.route], `${c.key}: لا شاشة مضيفة لـ${c.route}`).toBeTruthy();
  });

  it('and each host answers the word of every form that lives on it', () => {
    for (const c of CREATABLES) {
      const call = intentArgument(HOSTS[c.route]);
      const word = c.key.includes('-') ? `'${c.key}':` : `${c.key}:`;
      expect(call, `${c.key}: ${HOSTS[c.route]} ما بتجاوب على «${c.key}»`).toContain(word);
    }
  });

  it('and the handler is the button’s OWN setter — one form opened two ways, not a second copy of it', () => {
    const SETTER: Record<string, string> = {
      order: 'setCreateModalOpen',
      'ai-order': 'setAiModalOpen',
      'import-orders': 'setImporting',
      product: 'setCreateModalOpen',
      customer: 'setCreateModalOpen',
      user: 'setCreateOpen',
      campaign: 'setCreating',
    };
    for (const c of CREATABLES) {
      const file = HOSTS[c.route];
      const setter = SETTER[c.key];
      const call = intentArgument(file);
      const word = c.key.includes('-') ? `'${c.key}':` : `${c.key}:`;
      const line = call.split('\n').find((l) => l.includes(word)) ?? '';
      expect(line, `${c.key}: المعالج مش ${setter}(true)`).toContain(`${setter}(true)`);
      // …and the screen has a BUTTON that calls the same setter, outside this call — so the form it opens is one that is drawn.
      const outside = stripComments(repoFile(file)).replace(call, '');
      expect(outside, `${c.key}: ما في زرٌّ يستدعي ${setter}(true) بـ${file}`).toContain(`onClick={() => ${setter}(true)}`);
    }
  });

  it('and where the button is drawn only for a permission, the handler is passed only for that permission', () => {
    // order, ai-order and the import are gated in the orders header; the staff form in the staff header. The other three buttons are
    // drawn for everyone who may open the screen (the door refuses on save), and the handler is the same.
    const gated: Record<string, string> = {
      order: 'canCreate',
      'ai-order': 'canCreate',
      'import-orders': 'canImport',
      user: "userCan(currentUser, 'users.create')",
    };
    for (const [key, gate] of Object.entries(gated)) {
      const c = CREATABLES.find((x) => x.key === key)!;
      const call = intentArgument(HOSTS[c.route]);
      const word = key.includes('-') ? `'${key}':` : `${key}:`;
      const handler = call.slice(call.indexOf(word));
      expect(handler.startsWith(`${word} ${gate} ?`), `${key}: المعالج مش خلف ${gate}`).toBe(true);
    }
    // …and the gate each host uses IS the permission the list says (so the box never offers what the screen would not draw).
    expect(stripComments(repoFile(HOSTS['/orders']))).toContain("const canCreate = userCan(currentUser, 'orders.create');");
    // was: "const canImport = userCan(currentUser, 'orders.import');" — RV98: the import needs both keys, on the screen and in the box
    expect(stripComments(repoFile(HOSTS['/orders']))).toContain(
      "const canImport = userCan(currentUser, 'orders.import') && userCan(currentUser, 'orders.create');"
    );
    expect(CREATABLES.find((c) => c.key === 'user')!.needs).toBe('users.create');
    expect(CREATABLES.find((c) => c.key === 'import-orders')!.needs).toBe('orders.import');
    expect(CREATABLES.find((c) => c.key === 'import-orders')!.alsoNeeds).toBe('orders.create');
    expect(CREATABLES.filter((c) => c.route === '/orders' && c.key !== 'import-orders').every((c) => c.needs === 'orders.create')).toBe(true);
  });
});

describe('the box carries no list', () => {
  const download = ['src/components/shell/CommandPalette.tsx', 'src/hooks/useCreateIntent.ts', 'src/lib/create-intent.ts'];

  it('imports nothing from the server’s list', () => {
    for (const file of download) {
      expect(stripComments(repoFile(file)), file).not.toMatch(/palette-create/);
    }
  });

  it('and none of the seven names is written in anything it downloads for every account', () => {
    for (const file of download) {
      const src = stripComments(repoFile(file));
      for (const c of CREATABLES) expect(src.includes(c.label), `${file}: «${c.label}»`).toBe(false);
    }
  });
});
