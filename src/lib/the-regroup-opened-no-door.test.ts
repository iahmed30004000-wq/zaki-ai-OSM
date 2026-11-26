import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ROUTES, NAV } from './route-registry';

/**
 * A MENU REGROUPING OPENS NO DOOR AND CLOSES NONE (18/11, R0 of the restructure).
 *
 * The restructure re-groups the menu (R6: eleven groups to nine, sixteen lines to ten) and adds three pages. Moving a page
 * from one group to another is a statement about the MENU; what a person may OPEN is `permissions`, and that must not move
 * with it. A page that quietly gained a key opens a door for somebody who was refused; one that lost a key shuts it on somebody
 * who worked there yesterday. Neither shows in a diff of group membership.
 *
 * So the pair (path, permissions) of every page the registry has is pinned below, and the comparison is made against the REAL
 * `ALL_ROUTES` — not against a retyped list of what the menu should say — so it holds however the groups are arranged. The
 * 53 pairs of `ORIGINAL` were GENERATED from the registry on 18/11 (path-sorted, keys sorted) and are not edited. Group,
 * order, label, icon, `step`, `foldedUnder` and `offMenu` are menu facts and are not pinned here.
 *
 * ── TO ADD, REMOVE OR RE-KEY A PAGE: ONE EDIT ──
 *
 * Add ONE entry to `DATED` below — the date, the path, what changed, the keys the page ends up with, and a sentence that says
 * why. Nothing else in this file changes. A page the registry gained or lost, or whose keys changed, without such an entry
 * fails this test and names the page.
 */

type Keys = readonly string[] | null;

const ORIGINAL: ReadonlyArray<readonly [string, Keys]> = [
  ['/abandoned-carts', ['orders.view']],
  ['/admin/jobs', ['settings.view']],
  ['/admin/permissions', ['roles.view']],
  ['/admin/profile', null],
  ['/admin/users', ['users.view']],
  ['/apps/installed', ['apps.view']],
  ['/apps/store', ['apps.view']],
  ['/assistant', ['ai.use']],
  ['/confirmation/follow-up', ['confirmation.supervise']],
  ['/confirmation/issues', ['confirmation.issues']],
  ['/confirmation/mine', ['confirmation.pull', 'confirmation.work']],
  ['/confirmation/queue', ['confirmation.supervise']],
  ['/control/audit', ['audit.view']],
  ['/control/blacklist', ['control.blacklist']],
  ['/control/change-requests', ['control.change_requests']],
  ['/control/discount-alerts', ['control.discount_alerts']],
  ['/control/penalties', ['penalties.view']],
  ['/customers', ['customers.view', 'customers.view_basic']],
  ['/dashboard', ['dashboard.view']],
  ['/finance/agents', ['settlement.review', 'settlement.view']],
  ['/finance/closing', ['finance.cashbox_view']],
  ['/finance/collection', ['settlement.upload', 'settlement.view']],
  ['/finance/matching', ['settlement.review']],
  ['/finance/profit', ['finance.view']],
  ['/finance/transfers', ['finance.cashbox_view']],
  ['/finance/wallets', ['finance.cashbox_view']],
  ['/growth/bench', ['growth.intelligence']],
  ['/growth/campaigns', ['campaigns.view']],
  ['/growth/intelligence', ['growth.intelligence']],
  ['/growth/performance', ['reports.view']],
  ['/growth/telegram/orders', ['telegram.view']],
  ['/growth/whatsapp/inbox', ['whatsapp.view']],
  ['/inventory/balances', ['inventory.view']],
  ['/inventory/movements', ['inventory.view']],
  ['/manufacturing', ['production.view']],
  ['/ops/batches', ['ops.batches']],
  ['/ops/preparation', ['ops.prepare']],
  ['/ops/returns', ['ops.returns']],
  ['/ops/shipments/new', ['ops.ship']],
  ['/ops/tracking', ['ops.track']],
  ['/orders', ['orders.view']],
  ['/products', ['products.view']],
  ['/settings', ['apps.view', 'commission.view', 'geo.view', 'settings.view', 'telegram.connect', 'whatsapp.manage']],
  ['/settings/ai', ['settings.view']],
  ['/settings/channels', ['settings.view']],
  ['/settings/commission', ['commission.view']],
  ['/settings/couriers', ['settings.view']],
  ['/settings/geo', ['geo.view']],
  ['/settings/links', ['telegram.connect', 'whatsapp.manage']],
  ['/settings/system', ['settings.view']],
  ['/settings/tracking', ['settings.view']],
  ['/store', ['geo.manage', 'storefront.manage', 'storefront.view']],
  ['/store/landing-pages', ['landing_pages.view']],
];

interface Dated {
  /** The day the change was merged, `YYYY-MM-DD`. */
  on: string;
  path: string;
  change: 'added' | 'removed' | 'permissions';
  /** The keys the page ends up with (`added`, `permissions`); ignored for `removed`. `null` is «every active user». */
  permissions?: Keys;
  /** One sentence: what the page is for and why it opens on exactly these keys. */
  sentence: string;
}

/**
 * THE CHANGES AFTER 18/11, EACH WITH ITS DATE AND ITS SENTENCE. Empty on the day the pin was taken.
 *
 *   { on: '2026-12-01', path: '/confirmation/rules', change: 'added', permissions: ['settings.view'],
 *     sentence: 'قواعد مركز التأكيد: صفحة جديدة بمفتاح الإعدادات، تأخذ ثماني بطاقات كانت في إعدادات النظام.' },
 */
const DATED: Dated[] = [
  {
    on: '2026-11-18',
    path: '/confirmation/rules',
    change: 'added',
    permissions: ['settings.view'],
    sentence: 'قواعد مركز التأكيد (C1): صفحة جديدة آخر تبويب بمركز التأكيد، بمفتاح settings.view اللي أبواب بطاقاتها بتسألو أصلاً — أخدت ثماني بطاقات كانت بإعدادات النظام.',
  },
  {
    on: '2026-11-18',
    path: '/growth/landing-chats',
    change: 'added',
    permissions: ['whatsapp.view'],
    sentence: 'رسائل اللاندينج: تبويب ثالث بالمحادثات جنب واتساب وتلجرام، فيه محادثات مساعدة صفحات الهبوط والفريق بيرد منها — بمفتاح صندوق واتساب نفسه، فنفس الناس بيشوفوها وما في دور بيتغيّر.',
  },
  {
    on: '2026-11-19',
    path: '/finance/rules',
    change: 'added',
    permissions: ['settings.view'],
    sentence: 'قواعد المال: صفحة جديدة بمفتاح الإعدادات نفسه، تأخذ بطاقتي تسوية السطور والشركاء من إعدادات النظام.',
  },
  {
    on: '2026-11-19',
    path: '/admin/staff-rules',
    change: 'added',
    permissions: ['settings.view'],
    sentence: 'قواعد الموظفين: صفحة جديدة بمفتاح الإعدادات نفسه، تأخذ بطاقتي سكور الموظفين وقواعد الخصم من إعدادات النظام.',
  },
  {
    on: '2026-11-20',
    path: '/inventory/transfers',
    change: 'added',
    permissions: ['inventory.view'],
    sentence: 'نقل البضاعة (W3b): صفحة جديدة آخر تبويب بالمخزون، بمفتاح inventory.view متل جارتيها الأرصدة والحركات — بتشوف النقلات بس؛ الإرسال والاستلام واعتماد الفرق كل ضغطة بتسأل مفتاحها.',
  },
  {
    on: '2026-11-20',
    path: '/inventory/exits',
    change: 'added',
    permissions: ['inventory.view'],
    sentence: 'إخراج بضاعة (W6b): صفحة جديدة آخر تبويب بالمخزون، بمفتاح inventory.view متل جاراتها — بتشوف الطلبات وتقرير الشهر بس؛ الطلب بيسأل inventory.exit، والاعتماد والرفض inventory.exit_approve، والقيمة بالكلفة لصاحب costs.view بس.',
  },
  {
    on: '2026-11-21',
    path: '/inventory/counts',
    change: 'added',
    permissions: ['inventory.view'],
    sentence: 'الجرد (W5b): صفحة جديدة آخر تبويب بالمخزون، بمفتاح inventory.view متل جاراتها — اللي ما إله غير هالمفتاح بيشوف أوراق الجرد واللي انعدّ بس، بلا ولا رقم دفتر؛ العدّ والتسليم بيسألوا inventory.count، والاعتماد وكشف عهدة الأمين inventory.count_approve، والقيمة بالكلفة لصاحب costs.view بس.',
  },
  {
    on: '2026-11-22',
    path: '/control/app-errors',
    change: 'added',
    permissions: ['audit.view'],
    sentence: 'أعطال التطبيق: صفحة جديدة جنب سجل التدقيق بالرقابة، بتعرض الانهيارات والشاشات المعلّقة اللي بيبعتها تطبيق الطلبات على الموبايل — بمفتاح audit.view نفسه، فاللي بيقرأ السجل بيقرأ الأعطال وما في دور بيتغيّر.',
  },
  {
    on: '2026-11-25',
    path: '/settings/authenticity',
    change: 'added',
    permissions: ['settings.view'],
    sentence: 'رموز الأصالة: صفحة جديدة بمفتاح الإعدادات نفسه (طلب المالك)، تأخذ بطاقة رموز الأصالة من إعدادات النظام كما هي — الإضافة والحذف بيسألوا settings.edit متل قبل.',
  },
  {
    on: '2026-11-25',
    path: '/settings/product-barcodes',
    change: 'added',
    permissions: ['settings.view'],
    sentence: 'باركود المنتجات: صفحة جديدة جنب رموز الأصالة بمفتاح الإعدادات نفسه، لكل منتج باركود وصفحة تحقق عامة يصممها المالك — الحفظ بيسأل settings.edit.',
  },
  {
    on: '2026-11-25',
    path: '/confirmation/winback-list',
    change: 'added',
    permissions: ['confirmation.work'],
    sentence: 'قايمة الاسترجاع (F12، قرار المالك «A»): صفحة جديدة تبويب بالتأكيد بمفتاح confirmation.work — كل موظفة بتشوف قايمتها الخاصة بس (طلبات الاسترجاع اللي انوزّعت إلها، برّا حدّها)؛ قايمة موظفة تانية للمدير صاحب orders.assign بس، وتغيير القطع 1/3 لصاحبة القايمة أو المدير.',
  },
];

// ───────────────────────── the comparison ─────────────────────────

const same = (a: Keys, b: Keys): boolean => {
  if (a === null || b === null) return a === b;
  return [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
};
const show = (k: Keys): string => (k === null ? 'كل مستخدم نشِط' : `[${[...k].sort().join(', ')}]`);

/** The pairs the registry SHOULD have: the original pin with every dated change applied in order. Throws on an entry that makes no sense. */
function expectedPairs(original: typeof ORIGINAL, dated: Dated[]): Map<string, Keys> {
  const out = new Map<string, Keys>(original.map(([p, k]) => [p, k]));
  for (const d of dated) {
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d.on), `${d.path}: تاريخ الجملة «${d.on}» ليس بصيغة YYYY-MM-DD`).toBe(true);
    expect(d.sentence.trim().length, `${d.path}: جملة التاريخ فارغة أو قصيرة — اكتب لماذا`).toBeGreaterThanOrEqual(20);
    if (d.change === 'added') {
      expect(out.has(d.path), `${d.path}: مُسجَّلة «أُضيفت» وهي موجودة أصلاً`).toBe(false);
      expect(d.permissions !== undefined, `${d.path}: «أُضيفت» بلا permissions`).toBe(true);
      out.set(d.path, d.permissions!);
    } else if (d.change === 'removed') {
      expect(out.has(d.path), `${d.path}: مُسجَّلة «أُزيلت» وليست موجودة`).toBe(true);
      out.delete(d.path);
    } else {
      expect(out.has(d.path), `${d.path}: مُسجَّلة «تغيّرت مفاتيحها» وليست موجودة`).toBe(true);
      expect(d.permissions !== undefined, `${d.path}: «تغيّرت» بلا permissions`).toBe(true);
      out.set(d.path, d.permissions!);
    }
  }
  return out;
}

/** What differs between the registry and what is pinned — one sentence per page, each telling the reader the one edit that fixes it. */
function drift(actual: ReadonlyArray<{ path: string; permissions: Keys }>, expected: Map<string, Keys>): string[] {
  const out: string[] = [];
  const have = new Map(actual.map((r) => [r.path, r.permissions] as const));
  const fix = 'أضف جملة مؤرّخة في DATED (التاريخ، المسار، نوع التغيير، المفاتيح، ولماذا) — لا شيء غيرها';
  for (const [path, keys] of have) {
    if (!expected.has(path)) out.push(`صفحة جديدة «${path}» بمفاتيح ${show(keys)} — ${fix}`);
    else if (!same(keys, expected.get(path)!)) out.push(`صفحة «${path}» تغيّرت مفاتيحها: ${show(expected.get(path)!)} ← ${show(keys)} — ${fix}`);
  }
  for (const [path, keys] of expected) {
    if (!have.has(path)) out.push(`صفحة «${path}» (${show(keys)}) اختفت من السجل — ${fix}`);
  }
  return out;
}

describe('the pages and who may open them — pinned, so a regrouping can be proved to open no door and close none', () => {
  it('pins the 53 pages the registry had on 18/11, each once', () => {
    expect(ORIGINAL).toHaveLength(53);
    expect(new Set(ORIGINAL.map(([p]) => p)).size).toBe(53);
  });

  it('every page of the registry has exactly the keys it is pinned with — and there is no page more or less', () => {
    const problems = drift(ALL_ROUTES, expectedPairs(ORIGINAL, DATED));
    expect(problems, `فتح باب أو إغلاقه بلا جملة مؤرّخة:\n${problems.join('\n')}`).toEqual([]);
  });

  it('reads the registry, not the menu: the same pairs, whichever group a page sits in', () => {
    const fromGroups = NAV.flatMap((g) => g.routes.map((r) => ({ path: r.path, permissions: r.permissions })));
    expect(drift(fromGroups, expectedPairs(ORIGINAL, DATED))).toEqual([]);
    expect(new Set(fromGroups.map((r) => r.path)).size, 'صفحة مكرّرة في المجموعات').toBe(fromGroups.length);
  });

  it('a page is a real page: each registry path has its page file under the shell', () => {
    const missing = ALL_ROUTES.map((r) => r.path).filter((p) => !existsSync(join(process.cwd(), 'src', 'app', '(system)', '(shell)', p, 'page.tsx')));
    expect(missing, `مسارات في السجل بلا ملف صفحة:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every dated sentence is well-formed and names a page that makes sense for its change', () => {
    expect(() => expectedPairs(ORIGINAL, DATED)).not.toThrow();
  });
});

// ───────────────────────── the pin catches what it is for ─────────────────────────

const real = ALL_ROUTES.map((r) => ({ path: r.path, permissions: r.permissions }));
// 18/11 (C1): the pins the registry SHOULD have today — the original with DATED applied. Was `expectedPairs(ORIGINAL, [])`, written on the day DATED was empty; with the first
// dated page (/confirmation/rules) that read every real registry as one drift, so the cases below compare against the dated pins.
const pins = () => expectedPairs(ORIGINAL, DATED);

describe('the pin fails, and says what to do, when a door is opened or closed', () => {
  it('a key ADDED to a page — a door opened to somebody who was refused', () => {
    const changed = real.map((r) => (r.path === '/finance/profit' ? { ...r, permissions: [...r.permissions!, 'orders.view'] } : r));
    const found = drift(changed, pins());
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('/finance/profit');
    expect(found[0]).toContain('جملة مؤرّخة');
  });

  it('a key REMOVED — a door shut on somebody who worked there yesterday', () => {
    const changed = real.map((r) => (r.path === '/customers' ? { ...r, permissions: ['customers.view'] } : r));
    expect(drift(changed, pins())).toHaveLength(1);
  });

  it('a page that was open to every user and now asks a key, or the other way', () => {
    expect(drift(real.map((r) => (r.path === '/admin/profile' ? { ...r, permissions: ['users.view'] } : r)), pins())).toHaveLength(1);
    expect(drift(real.map((r) => (r.path === '/orders' ? { ...r, permissions: null } : r)), pins())).toHaveLength(1);
  });

  it('«nobody» is not «everybody»: an empty list is a different door from null', () => {
    expect(drift(real.map((r) => (r.path === '/admin/profile' ? { ...r, permissions: [] } : r)), pins())).toHaveLength(1);
  });

  it('a page ADDED and a page REMOVED', () => {
    expect(drift([...real, { path: '/finance/hypothetical', permissions: ['settings.view'] }], pins())).toEqual([expect.stringContaining('/finance/hypothetical')]);
    expect(drift(real.filter((r) => r.path !== '/assistant'), pins())).toEqual([expect.stringContaining('/assistant')]);
  });

  it('the order of the keys, and the order of the pages, change nothing', () => {
    const shuffled = [...real].reverse().map((r) => (r.permissions && r.permissions.length > 1 ? { ...r, permissions: [...r.permissions].reverse() } : r));
    expect(drift(shuffled, pins())).toEqual([]);
  });

  it('a dated sentence makes the same change legitimate — the ONE edit that adds a page', () => {
    const added = [...real, { path: '/finance/hypothetical', permissions: ['settings.view'] }];
    expect(drift(added, pins())).toHaveLength(1);
    // 18/11 (C1): the hypothetical page is /finance/rules now — /confirmation/rules is a real dated page.
    // 19/11 (R13i): and /finance/hypothetical now — /finance/rules «قواعد المال» is a real dated page too, so the made-up one is a path no page will ever take.
    const dated: Dated[] = [
      ...DATED,
      { on: '2026-12-01', path: '/finance/hypothetical', change: 'added', permissions: ['settings.view'], sentence: 'صفحة تجريبية بمفتاح الإعدادات فقط، لهذا الاختبار.' },
    ];
    expect(drift(added, expectedPairs(ORIGINAL, dated))).toEqual([]);
    // …and it legitimises that change ONLY: the same page with another key set is still a drift.
    expect(drift([...real, { path: '/finance/hypothetical', permissions: ['users.view'] }], expectedPairs(ORIGINAL, dated))).toHaveLength(1);
  });

  it('a dated sentence needs its date, a real reason, and a change that fits the page', () => {
    const base = { path: '/confirmation/rules', change: 'added' as const, permissions: ['settings.view'] };
    expect(() => expectedPairs(ORIGINAL, [{ ...base, on: '1/12', sentence: 'جملة طويلة بما يكفي للسبب هنا.' }])).toThrow();
    expect(() => expectedPairs(ORIGINAL, [{ ...base, on: '2026-12-01', sentence: 'قصيرة' }])).toThrow();
    expect(() => expectedPairs(ORIGINAL, [{ ...base, path: '/orders', on: '2026-12-01', sentence: 'جملة طويلة بما يكفي للسبب هنا.' }])).toThrow();
    expect(() => expectedPairs(ORIGINAL, [{ path: '/nowhere', change: 'removed', on: '2026-12-01', sentence: 'جملة طويلة بما يكفي للسبب هنا.' }])).toThrow();
  });
});
