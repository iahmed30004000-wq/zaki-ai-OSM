import { PAGE_SEEDS } from './store-pages';

/**
 * WHEN A STORE — OR A CITY — MAY BE DELETED, SAID ONCE.
 *
 * The owner, 21/10: «بدي زر لحذف المتجر اذا ما كان مدخل عليه اشي» and «بدي زر
 * لحذف المدن اذا ما كان مربوط فيها ولا طلب». Until then the routes said, in
 * three places, «there is no DELETE» — and a store made by mistake, or to try
 * something, stayed in every picker for ever.
 *
 * ── ONE QUESTION, TWO ASKERS ──
 *
 * The screen asks it to decide whether the button is pressable and to say why
 * not BEFORE a click; the DELETE route asks it again, inside the transaction
 * that deletes, because the screen's answer may be a minute old. Both call the
 * functions below, so a button can never be live for something the route
 * refuses, nor refused for something the route would allow.
 *
 * ── «NOTHING ENTERED» MEANS: NO ROW IN ANY TABLE THAT POINTS AT IT ──
 *
 * Counted per model, from `STORE_TABLES`, because the database cannot be
 * trusted to say it: of the twenty-eight models that carry a `storeId`, ten
 * stop the delete on their own (`Restrict`), eight vanish with it silently
 * (`Cascade`), two let go (`SetNull` — a courier scoped to the store would
 * quietly become company-wide), and EIGHT have no foreign key at all — an
 * inventory movement, a payslip, a courier statement would be left behind
 * pointing at a store that no longer exists. So every one is listed here, by
 * name, with what it is called on the screen; and `geo-removal.test.ts` reads
 * Prisma's generated model and fails the day a twenty-ninth table gains a
 * `storeId` without somebody deciding what it means for deleting a store.
 *
 * ── WHAT DOES NOT COUNT ──
 *
 *   • the three skeleton pages a store is created with (privacy, terms,
 *     refund), while they are still exactly the skeleton and still drafts —
 *     the shop's own name in them is the only thing that varies;
 *   • notifications, which the system writes about a store and the database
 *     removes with it;
 *   • the store's own face — logo, colours, tagline, a draft of its home
 *     page. They are looks, not business, and the dialog says they go.
 *
 * ── WHAT COUNTS EVEN THOUGH IT IS NOT A ROW ──
 *
 * A store open to customers, one with its own domain, one fronted by a landing
 * page, and the one the person asking is standing in. And a person confined to
 * named stores (`UserStoreAccess`): taking the store away from a user whose
 * ONLY named store it was would leave them with none, and «no named stores»
 * means «every store» (see `reachesStore`) — deleting a store would WIDEN
 * somebody's access. They are asked to be released first.
 *
 * A city is simpler: an order that names it (the database refuses that one
 * too) or a courier's fee for it (the database would silently delete THAT one,
 * which is a price somebody typed).
 *
 * Nothing here deletes anything. It answers, and the route acts.
 */

export interface Blocker {
  /** A stable word for tests and the screen — a model name, or `selected`, `live`, `domain`, `front`. */
  key: string;
  /** What the person reads: a noun with its count, or a whole sentence when it is not a count. */
  text: string;
  count?: number;
}

export interface StoreTable {
  /** Prisma's delegate name: `db.order`. A test holds every entry to a real generated model. */
  model: string;
  /** What the rows ARE, as a noun — printed beside the count. */
  label: string;
  /**
   * `blocks` — one row means somebody entered something here, and the store stays.
   * `pages`  — the skeleton pages made with the store do not count; an edited or published one does.
   * `goes`   — written by the system, not by a person; it goes with the store.
   */
  how: 'blocks' | 'pages' | 'goes';
}

export const STORE_TABLES: readonly StoreTable[] = [
  // Business: what the store is FOR.
  { model: 'order', label: 'الطلبات', how: 'blocks' },
  { model: 'customer', label: 'العملاء', how: 'blocks' },
  { model: 'product', label: 'المنتجات', how: 'blocks' },
  { model: 'inventoryMovement', label: 'حركات المخزون', how: 'blocks' },
  { model: 'stockOpeningCount', label: 'جرد افتتاح المخزون', how: 'blocks' },
  // The opening placement of the warehouse plan (W1a): a store whose stock was divided between warehouses has a history.
  { model: 'warehousePlacement', label: 'توزيع المخزون على المخازن', how: 'blocks' },
  // W8a: the ledger of a combination's count per warehouse (size/colour) — a store with one has a stock history.
  { model: 'variantStockMovement', label: 'حركات عدد الخيارات', how: 'blocks' },
  // Transfers between the store's warehouses (W3a): a document of goods that moved — never deleted, so the store stays.
  { model: 'stockTransfer', label: 'نقل البضاعة بين المخازن', how: 'blocks' },
  // Goods out of the store's warehouses for good (W6a): a document of goods that left — never deleted, so the store stays.
  { model: 'stockExit', label: 'إخراج بضاعة من المخازن', how: 'blocks' },
  // Count sheets of the store's goods in its warehouses (W5a): a document of what was counted and approved — never deleted.
  { model: 'stockCount', label: 'أوراق الجرد على المخازن', how: 'blocks' },
  { model: 'productionBatch', label: 'تشغيلات الإنتاج', how: 'blocks' },
  { model: 'shippingBatch', label: 'دفعات الشحن', how: 'blocks' },
  { model: 'courierStatement', label: 'كشوف شركات الشحن', how: 'blocks' },
  { model: 'deliveryProvider', label: 'شركات شحن خاصّة به', how: 'blocks' },
  // Money.
  { model: 'wallet', label: 'المحافظ المالية', how: 'blocks' },
  { model: 'payslip', label: 'كشوف الرواتب', how: 'blocks' },
  { model: 'expense', label: 'المصاريف', how: 'blocks' },
  { model: 'commissionRule', label: 'قواعد العمولة', how: 'blocks' },
  { model: 'penaltyRule', label: 'قواعد الجزاءات', how: 'blocks' },
  { model: 'penalty', label: 'الجزاءات', how: 'blocks' },
  // «المسحوبات» (22/11): a record of what a partner took from this store — never deleted, no foreign key, so the store stays.
  { model: 'partnerWithdrawal', label: 'مسحوبات الشركاء', how: 'blocks' },
  // Selling.
  { model: 'landingPage', label: 'صفحات الهبوط', how: 'blocks' },
  { model: 'landingPageView', label: 'زيارات صفحات الهبوط', how: 'blocks' },
  { model: 'landingPageBrowserView', label: 'زيارات صفحات الهبوط (عدّ المتصفح)', how: 'blocks' },
  { model: 'campaign', label: 'الحملات', how: 'blocks' },
  { model: 'adAccount', label: 'الحسابات الإعلانية', how: 'blocks' },
  // What each ad spent each day (the media buyer's doors, PR-A): a record of what the platform said, no foreign key — never deleted with a store.
  { model: 'adSpendDay', label: 'الإنفاق الإعلاني اليومي', how: 'blocks' },
  // The team leader's end-of-day reports (step H2): a record, never deleted — a store that has them is not empty.
  { model: 'confirmationEodReport', label: 'تقارير نهاية اليوم', how: 'blocks' },
  // The leads the pages system sent (step E1): a record of people who left their details — never deleted with a store.
  { model: 'lead', label: 'ليدز الصفحات', how: 'blocks' },
  // «سجل الرفض» of the confirmation desk (request Q2a, 19/11): no foreign key on purpose (a refusal must never fail a door), so it stops a removal like every keyless record; kept 90 days.
  { model: 'deskRefusal', label: 'سجل رفض مكتب التأكيد', how: 'blocks' },
  // «قواعد خاصة» of the confirmation desk (request Q4a, 20/11): stopped, never deleted, and no foreign key to the store — a store that has them is not empty.
  { model: 'confirmationRule', label: 'قواعد مركز التأكيد الخاصة', how: 'blocks' },
  { model: 'trackingPixel', label: 'بكسلات التتبّع', how: 'blocks' },
  // A system key bound to this store (2026-11-23, Zaki Pages per store): RESTRICT — stopped on «توكنات الأنظمة», never
  // widened to the whole country by the store going from under it.
  { model: 'systemToken', label: 'مفاتيح أنظمة مربوطة بهذا المتجر', how: 'blocks' },
  // The landing chat threads a store-bound key opened (2026-11-23): no foreign key, like every thread's link — kept.
  { model: 'landingChatThread', label: 'محادثات صفحات الهبوط', how: 'blocks' },
  { model: 'telegramSource', label: 'مصادر تلجرام', how: 'blocks' },
  // «أسماء المنتجات» of the Telegram door (10/11): switched off, never deleted — a store that has them is not empty.
  { model: 'telegramUpsellProduct', label: 'أسماء منتجات تلجرام', how: 'blocks' },
  { model: 'productReview', label: 'تقييمات المنتجات', how: 'blocks' },
  // The shop window.
  { model: 'storeMenu', label: 'قوائم المتجر', how: 'blocks' },
  { model: 'storeRedirect', label: 'تحويلات الروابط', how: 'blocks' },
  { model: 'storeFont', label: 'الخطوط المرفوعة', how: 'blocks' },
  // People.
  { model: 'userStoreAccess', label: 'موظفون مقيَّدون بهذا المتجر', how: 'blocks' },
  // The two that are not plain.
  { model: 'storePage', label: 'صفحات معدَّلة أو منشورة', how: 'pages' },
  { model: 'notification', label: 'إشعارات', how: 'goes' },
];

/** Every model a store's `id` may sit in — the guard test compares this with the generated schema. */
export const STORE_TABLE_MODELS: readonly string[] = STORE_TABLES.map((t) => t.model);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this page still exactly the skeleton the store was created with?
 *
 * The skeleton carries the shop's name where `{{store}}` stands, and the shop
 * may have been renamed since — so it is matched as a pattern in which the
 * name is anything on one line, the same anywhere it appears. A page whose
 * words were edited, or that was published, or that is not one of the three,
 * is somebody's work, and the store stays.
 *
 * `seeds` is a parameter only so a claim can hand it a skeleton that names the
 * shop twice — the three real ones name it once each.
 */
export function isUntouchedSeed(
  page: { slug: string; title: string; kind: string; body: string; isPublished: boolean },
  seeds: readonly { slug: string; title: string; kind: string; body: string }[] = PAGE_SEEDS
): boolean {
  const seed = seeds.find((s) => s.slug === page.slug);
  if (!seed || page.isPublished || page.kind !== seed.kind || page.title !== seed.title) return false;
  const parts = seed.body.split('{{store}}').map(escape);
  const pattern = parts.reduce((acc, part, i) => (i === 0 ? part : `${acc}${i === 1 ? '([^\\n]+)' : '\\1'}${part}`), '');
  return new RegExp(`^${pattern}$`).test(page.body);
}

export interface StoreFacts {
  id: string;
  storefrontEnabled: boolean;
  domain: string | null;
  landingPageId: string | null;
}

/**
 * Who is asking: their company — every count is of THEIR company's rows, and the
 * indexes on these tables lead with it (`companyId, storeId`), so asking without
 * it would scan whole tables inside a transaction — and the one thing no row
 * can say, where they are standing.
 */
export interface StoreAsker {
  companyId: string;
  selectedStoreId?: string | null;
}

/** The one table with no `companyId` column — the guard test holds this to the generated schema. */
export const NO_COMPANY_COLUMN: ReadonlySet<string> = new Set(['userStoreAccess']);

interface Delegate {
  groupBy(args: unknown): Promise<{ storeId: string | null; _count: { _all: number } }[]>;
  findMany(args: unknown): Promise<{ storeId: string; slug: string; title: string; kind: string; body: string; isPublished: boolean }[]>;
}

/** The client or a transaction — only the delegates named in `STORE_TABLES` are touched. */
const delegate = (db: unknown, model: string) => (db as Record<string, Delegate>)[model];

/**
 * Why each of these stores may NOT be deleted. An empty list is a store that may.
 *
 * Twenty-six queries whatever the number of stores — one `groupBy` per table
 * over all of them, never one per store — so the screen can ask for a whole
 * country at once.
 */
export async function storeBlockers(
  db: unknown,
  stores: readonly StoreFacts[],
  asker: StoreAsker
): Promise<Map<string, Blocker[]>> {
  const ids = stores.map((s) => s.id);
  const counted = new Map<string, Map<string, number>>();
  const bump = (storeId: string, model: string, n: number) => {
    const row = counted.get(storeId) ?? new Map<string, number>();
    row.set(model, (row.get(model) ?? 0) + n);
    counted.set(storeId, row);
  };

  if (ids.length > 0) {
    await Promise.all([
      ...STORE_TABLES.filter((t) => t.how === 'blocks').map(async (t) => {
        const where = NO_COMPANY_COLUMN.has(t.model) ? { storeId: { in: ids } } : { companyId: asker.companyId, storeId: { in: ids } };
        const rows = await delegate(db, t.model).groupBy({ by: ['storeId'], where, _count: { _all: true } });
        for (const r of rows) if (r.storeId) bump(r.storeId, t.model, r._count._all);
      }),
      (async () => {
        const pages = await delegate(db, 'storePage').findMany({
          where: { companyId: asker.companyId, storeId: { in: ids } },
          select: { storeId: true, slug: true, title: true, kind: true, body: true, isPublished: true },
        });
        for (const p of pages) if (!isUntouchedSeed(p)) bump(p.storeId, 'storePage', 1);
      })(),
    ]);
  }

  const out = new Map<string, Blocker[]>();
  for (const s of stores) {
    const why: Blocker[] = [];
    if (asker.selectedStoreId === s.id) {
      why.push({ key: 'selected', text: 'أنت داخل هذا المتجر الآن — بدّل إلى متجر آخر ثم احذفه' });
    }
    if (s.storefrontEnabled) {
      why.push({ key: 'live', text: 'واجهته مفتوحة للزبائن — أغلقها من «الهوية والواجهة» أولاً' });
    }
    if (s.domain) {
      why.push({ key: 'domain', text: 'له نطاق خاص — أزِله من «الهوية والواجهة» أولاً' });
    }
    if (s.landingPageId) {
      why.push({ key: 'front', text: 'واجهته صفحة هبوط — افصلها عنه أولاً' });
    }
    const row = counted.get(s.id);
    for (const t of STORE_TABLES) {
      const n = row?.get(t.model) ?? 0;
      if (n > 0) why.push({ key: t.model, text: `${t.label} (${n})`, count: n });
    }
    out.set(s.id, why);
  }
  return out;
}

/** What a refusal says in one line — the screen prints the list, a script reads this. */
export function blockersSentence(what: 'المتجر' | 'المحافظة', blockers: readonly Blocker[]): string {
  return `لا يُحذف ${what}: ${blockers.map((b) => b.text).join(' · ')}`;
}

// ───────────────────────── cities ─────────────────────────

export interface RegionUse {
  orders: number;
  fees: number;
}

interface RegionDelegate {
  groupBy(args: unknown): Promise<{ regionId: string | null; _count: { _all: number } }[]>;
}

/**
 * How many orders name each city, and how many courier fees are set for it.
 *
 * Both by `regionId`, both over every id at once. Orders are counted whatever
 * their state: a cancelled order still says where it was going, and an order
 * is never deleted to make room for a city to go.
 */
export async function regionUse(db: unknown, ids: readonly string[]): Promise<Map<string, RegionUse>> {
  const out = new Map<string, RegionUse>(ids.map((id) => [id, { orders: 0, fees: 0 }]));
  if (ids.length === 0) return out;
  const ask = (model: 'order' | 'deliveryFee') =>
    (db as Record<string, RegionDelegate>)[model].groupBy({ by: ['regionId'], where: { regionId: { in: [...ids] } }, _count: { _all: true } });
  const [orders, fees] = await Promise.all([ask('order'), ask('deliveryFee')]);
  for (const r of orders) if (r.regionId && out.has(r.regionId)) out.get(r.regionId)!.orders = r._count._all;
  for (const r of fees) if (r.regionId && out.has(r.regionId)) out.get(r.regionId)!.fees = r._count._all;
  return out;
}

/** Why a city may NOT be deleted; empty means it may. */
export function regionBlockers(use: RegionUse | undefined): Blocker[] {
  const why: Blocker[] = [];
  if (use && use.orders > 0) why.push({ key: 'orders', text: `الطلبات (${use.orders})`, count: use.orders });
  if (use && use.fees > 0) why.push({ key: 'fees', text: `أجور التوصيل (${use.fees})`, count: use.fees });
  return why;
}
