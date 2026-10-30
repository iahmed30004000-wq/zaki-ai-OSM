import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A NUMBER THAT IS NOT REAL IS NOT SOCIAL PROOF.
 *
 * Owner decision D8, design docs/storefront/AUDIT.md §7.6. The whole of
 * this item is one promise made four ways:
 *
 *   · a rating that cannot be checked never says «مشتري مؤكَّد»;
 *   · an average is a measurement or it is not shown;
 *   · a countdown reads the moment the price actually stops;
 *   · and a customer's words are their own — their name, their phone and
 *     their address do not travel with them.
 *
 * Every assertion below is one of those four, and each of them is a claim
 * that was ARGUED FOR in the design before it was written down. The badge
 * is bound to an `orderId` and not to a `source` column because a column
 * is a thing a seller can set; the floor is five because
 * `delivery-time.ts` already taught the reader that number; the countdown
 * is refused rather than corrected because a silent correction leaves the
 * screen saying «تلقائي» over the per-visitor timer.
 *
 * WHY SO MUCH OF THIS READS SOURCE. Three of the seven claims are about a
 * thing that must NEVER happen — no phone rendered, no badge on a manual
 * item, no second reading of the badge — and «never» is a sweep, not an
 * example. `stripComments` first, every time: a comment that NAMES the
 * thing it forbids is how these files explain themselves, and a guard that
 * cannot tell a mention from a call is a guard that has to be argued with.
 * ═══════════════════════════════════════════════════════════════════════
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => stripComments(read(p));

// ─────────────────────────────────────────────────────
// The mocks: this suite never touches a database.
// ─────────────────────────────────────────────────────

const { dbMock, logAudit, notify } = vi.hoisted(() => {
  const table = () => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  });
  return {
    dbMock: { productReview: table(), order: table(), product: table() },
    logAudit: vi.fn(),
    notify: vi.fn(),
  };
});

vi.mock('./db', () => ({ db: dbMock }));
vi.mock('./audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('./notify', () => ({ notify: (...a: unknown[]) => notify(...a) }));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

/** A plausible order id. The token is derived from it, so it must be a uuid. */
const ORDER = '11111111-2222-4333-8444-555555555555';
const STORE = { id: 'store-1', companyId: 'co-1' };

const delivered = {
  id: ORDER,
  productId: 'prod-1',
  productNameSnapshot: 'كريم الأذن',
  storeId: STORE.id,
  companyId: STORE.companyId,
  shippingStatus: 'DELIVERED',
  confirmationStatus: 'CONFIRMED',
  claimedById: 'u1',
  product: { name: 'كريم الأذن' },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'rev-1',
  productId: 'prod-1',
  orderId: ORDER,
  rating: 5,
  text: 'وصل بسرعة',
  firstName: 'سارة',
  city: 'إربد',
  source: 'order',
  status: 'PUBLISHED',
  consent: true,
  publishedAt: new Date('2026-10-01T10:30:00Z'),
  createdAt: new Date('2026-09-30T08:00:00Z'),
  ...over,
});

// ─────────────────────────────────────────────────────
// 1 · A manual review never renders «مشتري مؤكَّد»
// ─────────────────────────────────────────────────────

describe('«مشتري مؤكَّد» belongs to a buyer somebody can check', () => {
  it('is false for a row with no order, whatever its source says', async () => {
    const { verified, publicReview } = await import('./reviews');

    /*
     * `source: 'order'` AND `orderId: null` IS THE EXACT TRAP.
     *
     * It is not a hypothetical: the order's `onDelete: SetNull` produces
     * exactly this row when an order is removed. A badge read off `source`
     * would keep saying «checkable» about a review whose order is gone, so
     * the test asks about the pair rather than about an obviously manual
     * row.
     */
    expect(verified({ orderId: null }), 'مراجعةٌ بلا طلبٍ تلبس شارةَ التأكيد').toBe(false);
    expect(publicReview(row({ orderId: null, source: 'order' })).verified).toBe(false);
    expect(publicReview(row({ orderId: ORDER })).verified).toBe(true);
  });

  it('and the MANUAL block has no field that could hold an order', async () => {
    const { landingSectionSchema } = await import('./landing-sections');
    const parsed = landingSectionSchema.parse({
      id: 'u1',
      type: 'reviews',
      items: [{ name: 'أم خالد', text: 'حبيته', stars: 5, source: 'whatsapp' }],
    });
    expect(parsed.type).toBe('reviews');
    const item = (parsed as { items: Record<string, unknown>[] }).items[0];
    // The enforcement is the ABSENCE. A seller cannot claim the badge
    // because there is nowhere to type the thing it is bound to — the same
    // shape the `comparison` block uses to make naming a competitor
    // impossible rather than merely forbidden.
    expect(Object.keys(item), 'بلوك الآراء اليدوي صار فيه حقلٌ لرقم طلب').not.toContain('orderId');
    expect(item.source).toBe('whatsapp');
    // `order` is not on the manual list: offering the word would be
    // offering the badge.
    const { MANUAL_SOURCES } = await import('./reviews');
    expect(MANUAL_SOURCES, 'مصدرٌ يدويٌّ اسمه «طلب»').not.toContain('order');
  });

  it('and its author is written by the server, never by the editor', async () => {
    const { stampManualReviews, landingSectionsSchema } = await import('./landing-sections');
    const sections = landingSectionsSchema.parse([
      {
        id: 'u1',
        type: 'reviews',
        items: [
          { name: 'أم خالد', text: 'حبيته', stars: 5, source: 'whatsapp' },
          // Already attributed — a colleague's transcription.
          { name: 'سمير', text: 'ممتاز', stars: 4, source: 'call', addedBy: 'زميل', addedAt: '2026-09-01' },
          // An empty row the editor opened and nobody filled.
          { name: '', text: '', stars: 5, source: 'other' },
        ],
      },
    ]);
    const out = stampManualReviews(sections, { name: 'المالك', at: new Date('2026-10-15T22:00:00Z') });
    const items = (out.sections[0] as { items: Record<string, string>[] }).items;

    expect(out.stamped, 'ما خُتم أي رأيٍ يدويّ').toBe(1);
    expect(items[0].addedBy).toBe('المالك');
    // A DAY, not a timestamp: the hour a seller typed it in is a detail
    // about their evening.
    expect(items[0].addedAt).toBe('2026-10-15');
    /*
     * AN EXISTING ATTRIBUTION IS NOT OVERWRITTEN. Whoever fixes a typo in
     * a colleague's transcription is not its source, and reassigning the
     * claim on every save would make the field mean «last person to press
     * حفظ» — which is what the audit log is for.
     */
    expect(items[1].addedBy, 'الحفظُ أعاد نسبةَ رأيٍ لشخصٍ آخر').toBe('زميل');
    expect(items[1].addedAt).toBe('2026-09-01');
    // And an empty row is nobody's transcription.
    expect(items[2].addedBy).toBe('');
  });

  it('and both doors that write sections do the stamping', () => {
    for (const door of [
      'src/app/api/landing-pages/[id]/content/route.ts',
      'src/app/api/store/design/route.ts',
    ]) {
      const src = code(door);
      expect(src, `${door}: الآراءُ اليدوية تُحفَظ بلا كاتب`).toContain('stampManualReviews');
      // The name comes from the SESSION, not from the request body.
      expect(src).toMatch(/name: user\.name \|\| user\.email/);
      // And the count lands in the audit row, which is where «who added
      // this» has always been answerable from.
      expect(src).toContain('manualReviewsStamped');
    }
  });

  it('and the renderer reads the badge from one place and nowhere else', () => {
    const src = code('src/components/landing/blocks/PageBlocks.tsx');
    const at = src.indexOf('مشتري مؤكَّد');
    expect(at, 'لا شارةَ تأكيدٍ في العارض إطلاقاً').toBeGreaterThan(0);
    /*
     * ONE OCCURRENCE, AND IT IS INSIDE THE VERIFIED LOOP.
     *
     * A second one — in the manual items' loop, under a condition that
     * «looks right» — is precisely the regression this item exists to
     * prevent, and it is the kind a diff four hundred lines long hides.
     * So the count is pinned, not the presence.
     */
    expect(src.split('مشتري مؤكَّد').length - 1, 'الشارةُ مرسومةٌ في أكثر من موضع').toBe(1);
    // And the block it sits in is the one fed by the server's list.
    const before = src.slice(0, at);
    expect(before.lastIndexOf('verified.map')).toBeGreaterThan(before.lastIndexOf('items.map'));
  });
});

// ─────────────────────────────────────────────────────
// 2 · A verified review exists only for a delivered order, once
// ─────────────────────────────────────────────────────

describe('a rating comes from a delivered order, once', () => {
  it('refuses an order that has not been delivered', async () => {
    const { ratingTarget } = await import('./product-reviews');
    const { reviewToken } = await import('./review-link');
    dbMock.order.findFirst.mockResolvedValue({ ...delivered, shippingStatus: 'SHIPPED' });

    const res = await ratingTarget(reviewToken(ORDER), STORE);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.refusal, 'طلبٌ في الطريق قَبِل تقييماً').toBe('NOT_DELIVERED');
  });

  it('accepts a delivered one — and a partially delivered one too', async () => {
    const { ratingTarget } = await import('./product-reviews');
    const { reviewToken } = await import('./review-link');
    dbMock.productReview.findFirst.mockResolvedValue(null);

    for (const shippingStatus of ['DELIVERED', 'PARTIALLY_DELIVERED']) {
      dbMock.order.findFirst.mockResolvedValue({ ...delivered, shippingStatus });
      const res = await ratingTarget(reviewToken(ORDER), STORE);
      // A partial delivery is goods taken and paid for. Refusing that
      // opinion would be the system deciding whose experience counted.
      expect(res.ok, shippingStatus).toBe(true);
    }
  });

  it('refuses a second rating for the same order', async () => {
    const { ratingTarget } = await import('./product-reviews');
    const { reviewToken } = await import('./review-link');
    dbMock.order.findFirst.mockResolvedValue(delivered);
    dbMock.productReview.findFirst.mockResolvedValue({ id: 'rev-1' });

    const res = await ratingTarget(reviewToken(ORDER), STORE);
    expect(res.ok === false && res.refusal, 'طلبٌ واحدٌ قَبِل رأيين').toBe('ALREADY_RATED');
  });

  it('and lets the DATABASE refuse the race the check cannot see', async () => {
    /*
     * The check above is a read followed by a write, and two taps on a
     * slow phone are two requests in the same second. `submitRating` does
     * not ask again — it writes, and treats the unique violation as the
     * answer. The same shape `penalty-service.ts` uses, for the same
     * reason: this is the only version of «once» that survives a race.
     */
    const { submitRating } = await import('./product-reviews');
    dbMock.productReview.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    const res = await submitRating(
      { orderId: ORDER, productId: 'prod-1', productName: 'x', storeId: STORE.id, companyId: STORE.companyId },
      { rating: 5, text: '', firstName: '', city: '', consent: true }
    );
    expect(res.ok === false && res.refusal, 'تضاربُ الفريد صار خطأ 500 لا رفضاً').toBe('ALREADY_RATED');
  });

  it('and the uniqueness is a PARTIAL index, named in the schema', () => {
    const sql = read('prisma/migrations/20261015240000_reviews_and_the_counter/migration.sql');
    /*
     * PARTIAL AND NOT PLAIN, and the reason is in the migration: `orderId`
     * is ALSO what distinguishes a manual row, and Postgres counts every
     * NULL as distinct — so a full `UNIQUE (order_id)` would look like it
     * constrained the manual rows while constraining nothing.
     */
    expect(sql).toMatch(/CREATE UNIQUE INDEX "product_reviews_order_key"/);
    expect(sql).toMatch(/WHERE "order_id" IS NOT NULL/);
    // And `a-rule-the-schema-hides.test.ts` demands the name be findable
    // in the model. Asserted here too, so this file fails for its own
    // reason rather than in a sweep three files away.
    expect(
      read('prisma/schema.prisma'),
      'قيدٌ تحفظه قاعدة البيانات ولا يذكره المخطّط'
    ).toContain('product_reviews_order_key');
  });
});

// ─────────────────────────────────────────────────────
// 3 · A used or foreign link is refused
// ─────────────────────────────────────────────────────

describe('the rating link opens one order and no other', () => {
  it('refuses a tampered signature, a wrong shape and a foreign id alike', async () => {
    const { orderIdFromToken, reviewToken } = await import('./review-link');
    const good = reviewToken(ORDER);
    expect(orderIdFromToken(good)).toBe(ORDER);

    const other = '99999999-8888-4777-8666-555555555555';
    for (const bad of [
      '',
      'not-a-token',
      ORDER,
      `${ORDER}.deadbeefdeadbeefdeadbeefdeadbeef`,
      // The id swapped under a signature that is valid FOR ANOTHER ORDER —
      // the attack a bare id in the URL would have handed over.
      `${other}.${good.split('.')[1]}`,
      // One character of the signature changed.
      good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'),
    ]) {
      expect(orderIdFromToken(bad), `وقّعَ رابطاً مزوَّراً: ${bad}`).toBeNull();
    }
  });

  it('and a valid link for ANOTHER SHOP answers exactly like a bad one', async () => {
    const { ratingTarget } = await import('./product-reviews');
    const { reviewToken } = await import('./review-link');
    // The store scope is on the query, so another shop's order is simply
    // not found.
    dbMock.order.findFirst.mockResolvedValue(null);

    const foreign = await ratingTarget(reviewToken(ORDER), STORE);
    const forged = await ratingTarget('nonsense', STORE);
    /*
     * THE ONE PAIR THAT MUST NOT BE TOLD APART. A different sentence for
     * «that order is in another shop» says «that order exists», one guess
     * at a time — which is the whole reason /track answers every failure
     * identically.
     */
    expect(foreign).toEqual(forged);
    expect(foreign.ok === false && foreign.refusal).toBe('BAD_LINK');
  });

  it('and nothing about the link is stored, so there is no token column', () => {
    const sql = read('prisma/migrations/20261015240000_reviews_and_the_counter/migration.sql');
    // A column holding a credential is a column a backup copy hands to
    // whoever reads it — the lesson `reset-token.ts` already paid for. The
    // token is derived; there is nothing to steal and nothing to expire.
    expect(sql.toLowerCase(), 'الرابطُ صار عموداً مخزَّناً').not.toMatch(/"(review_)?token"/);
    expect(code('src/lib/review-link.ts')).toContain('createHmac');
    // Constant-time, for the reason reset-token.ts gives.
    expect(code('src/lib/review-link.ts')).toContain('timingSafeEqual');
  });
});

// ─────────────────────────────────────────────────────
// 4 · No phone, address or full name is ever rendered
// ─────────────────────────────────────────────────────

describe('a review carries a first name and a city, and nothing else', () => {
  it('the public view is exactly the listed fields, in both directions', async () => {
    const { PUBLIC_REVIEW_FIELDS, publicReview } = await import('./reviews');
    const built = publicReview(row());
    /*
     * BOTH DIRECTIONS, the way `order-tracking.ts` does it. A field added
     * to the payload and forgotten in the list fails; a field listed and
     * never sent fails too. It is the whole defence against a phone number
     * reaching a public page because somebody widened a `select` three
     * files away.
     */
    expect(Object.keys(built).sort()).toEqual([...PUBLIC_REVIEW_FIELDS].sort());
  });

  it('and the table has no column that could hold one', () => {
    const schema = read('prisma/schema.prisma');
    const at = schema.indexOf('model ProductReview {');
    /*
     * THE FIELDS, NOT THE PROSE.
     *
     * The model's own comments SAY the words this sweep forbids — «there is
     * nowhere here for a phone, an address or a surname» is the paragraph
     * that explains the rule. A guard that cannot tell a column from a
     * sentence about columns is a guard that has to be argued with, which
     * is the whole reason `stripComments` exists for the .ts files. Prisma's
     * `///` is its own comment marker, so it is stripped here by hand.
     */
    const block = schema
      .slice(at, schema.indexOf('\n}', at))
      .replace(/^\s*\/\/\/.*$/gm, '');
    for (const forbidden of ['phone', 'altPhone', 'address', 'fullName', 'lastName', 'email']) {
      expect(block, `جدولُ المراجعات صار فيه ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`, 'i')
      );
    }
    // What IS there, so the test fails if the two honest columns go too.
    expect(block).toMatch(/first_name/);
    expect(block).toMatch(/city/);
  });

  it('and the shop reads the rows through a narrow select', () => {
    const src = code('src/lib/product-reviews.ts');
    const fn = src.slice(src.indexOf('export async function shownReviews'));
    for (const forbidden of ['customer', 'phone', 'address']) {
      expect(fn, `قراءةُ الآراء وسّعت ما تطلبه: ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`, 'i')
      );
    }
  });

  it('and the customer’s words are rendered as text, never as markup', () => {
    const src = code('src/components/landing/blocks/PageBlocks.tsx');
    const at = src.indexOf('verified.map');
    const loop = src.slice(at, src.indexOf('items.map', at));
    /*
     * `rich()` AND `dangerouslySetInnerHTML` ARE BOTH ABSENT, and they are
     * absent for different reasons that land in the same place. Every other
     * free field on a page is the SELLER's and goes through rich-text.ts's
     * allowlist; this is what a stranger typed into a public form, and the
     * only safe reading of it is «characters».
     *
     * A review is DATA, never an instruction — not to a renderer, and not
     * to a model.
     */
    expect(loop, 'كلامُ الزبون يُرسَم كَوَسْم').not.toContain('dangerouslySetInnerHTML');
    expect(loop, 'كلامُ الزبون يمرُّ على مُنسِّق الوسوم').not.toMatch(/\{\.\.\.rich\(/);
    expect(loop).toContain('{r.text}');
  });

  it('and it never reaches a model that is not on the owner’s own machine', () => {
    /*
     * «Customer-written review text never reaches an external model — any
     * AI on it goes through aiChat({ localOnly: true })».
     *
     * Enforced as a SWEEP and not as an example: there is no AI over
     * reviews today, and the claim is about the one somebody adds next
     * month. Any call that mentions a review and a model must carry the
     * flag.
     */
    const service = code('src/lib/product-reviews.ts');
    const pure = code('src/lib/reviews.ts');
    for (const [name, src] of [['product-reviews', service], ['reviews', pure]] as const) {
      if (/aiChat\(/.test(src)) {
        expect(src, `${name}: نصُّ مراجعةٍ وصل نموذجاً غير محلّي`).toMatch(/localOnly:\s*true/);
      }
    }
    // And the guarantee it would lean on is real: `aiChat` refuses before
    // any network call when the route is not LOCAL.
    const provider = code('src/lib/ai-provider/call.ts');
    expect(provider).toMatch(/req\.localOnly && route\.provider !== 'LOCAL'/);
    expect(provider).toMatch(/throw new AiNotLocal/);
  });
});

// ─────────────────────────────────────────────────────
// 5 · Hiding needs a reason and is audit-logged
// ─────────────────────────────────────────────────────

describe('hiding a review costs a reason, and the reason is kept', () => {
  it('refuses a hide with no reason, and writes nothing', async () => {
    const { hideReview } = await import('./product-reviews');
    const res = await hideReview({
      companyId: 'co-1',
      reviewId: 'rev-1',
      userId: 'u1',
      reason: '' as never,
    });
    expect(res.ok, 'أُخفيت مراجعةٌ بلا سبب').toBe(false);
    // NEGATIVE: not merely refused — nothing was written and nothing was
    // logged. A refusal that still updated the row would be the defect
    // wearing an error message.
    expect(dbMock.productReview.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('refuses a reason that is not one of the three', async () => {
    const { hideReview, HIDE_REASONS } = await import('./product-reviews');
    // A free-text reason would be a delete button with extra steps: the
    // review would be gone whatever was typed, and the average above it
    // would stop meaning anything. «السعر غالي» is the one a seller would
    // reach for, so it is the one tested.
    expect(HIDE_REASONS).toEqual(['ABUSE', 'PERSONAL_DATA', 'OFF_TOPIC']);
    const res = await hideReview({
      companyId: 'co-1',
      reviewId: 'rev-1',
      userId: 'u1',
      reason: 'PRICE_TOO_HIGH' as never,
    });
    expect(res.ok).toBe(false);
    expect(dbMock.productReview.update).not.toHaveBeenCalled();
  });

  it('and a real hide records the reason, the person and the moment', async () => {
    const { hideReview } = await import('./product-reviews');
    dbMock.productReview.findFirst.mockResolvedValue({ id: 'rev-1', status: 'PUBLISHED' });

    const res = await hideReview({
      companyId: 'co-1',
      reviewId: 'rev-1',
      userId: 'u-mod',
      reason: 'PERSONAL_DATA',
      note: 'فيه رقم هاتف',
    });
    expect(res.ok).toBe(true);

    const written = dbMock.productReview.update.mock.calls[0][0].data;
    expect(written.status).toBe('HIDDEN');
    expect(written.hiddenReason).toBe('PERSONAL_DATA');
    expect(written.hiddenById).toBe('u-mod');
    expect(written.hiddenAt).toBeInstanceOf(Date);

    const audit = logAudit.mock.calls[0][0];
    expect(audit.action, 'الإخفاءُ لم يُسجَّل').toBe('REVIEW_HIDDEN');
    expect(audit.entity).toBe('ProductReview');
    expect(audit.userId).toBe('u-mod');
    expect(audit.newData.reason).toBe('PERSONAL_DATA');
  });

  it('and there is no delete — a review is declined, never unsaid', () => {
    const service = code('src/lib/product-reviews.ts');
    expect(service, 'صار في حذفٌ للمراجعات').not.toMatch(/productReview\.delete/);
    const route = code('src/app/api/reviews/[id]/route.ts');
    expect(route, 'باب المراجعات فتح طريقة حذف').not.toMatch(/export async function DELETE/);
  });

  it('and a review nobody consented to is never published', async () => {
    const { publishReview } = await import('./product-reviews');
    dbMock.productReview.findFirst.mockResolvedValue({
      id: 'rev-1', productId: 'prod-1', status: 'PENDING', consent: false, orderId: ORDER, storeId: STORE.id,
    });
    const res = await publishReview({ companyId: 'co-1', reviewId: 'rev-1', userId: 'u-mod' });
    /*
     * CONSENT IS THE CUSTOMER'S AND THE STATUS IS THE MODERATOR'S, and
     * they are two different people's decisions. A moderator may publish;
     * a moderator may not consent on somebody's behalf.
     */
    expect(res.ok, 'نُشر رأيٌ بلا موافقةِ صاحبه').toBe(false);
    expect(dbMock.productReview.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// 6 · The auto-switch fires at 5 and notifies
// ─────────────────────────────────────────────────────

describe('five real opinions and the product stops needing the seller’s', () => {
  const product = { id: 'prod-1', name: 'كريم الأذن', reviewMode: null, storeId: STORE.id };

  it('does nothing at four', async () => {
    const { maybeAutoSwitch, AUTO_SWITCH_FLOOR } = await import('./product-reviews');
    expect(AUTO_SWITCH_FLOOR).toBe(5);
    dbMock.product.findFirst.mockResolvedValue(product);
    dbMock.productReview.count.mockResolvedValue(AUTO_SWITCH_FLOOR - 1);

    expect(await maybeAutoSwitch({ companyId: 'co-1', productId: 'prod-1' })).toBe(false);
    expect(dbMock.product.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('switches at five, and tells the owner where to put it back', async () => {
    const { maybeAutoSwitch } = await import('./product-reviews');
    dbMock.product.findFirst.mockResolvedValue(product);
    dbMock.productReview.count.mockResolvedValue(5);

    expect(await maybeAutoSwitch({ companyId: 'co-1', productId: 'prod-1' })).toBe(true);
    expect(dbMock.product.update.mock.calls[0][0].data).toEqual({ reviewMode: 'auto' });

    const sent = notify.mock.calls[0][0] as { message: string; link: string };
    // A page that changed what it shows without saying so is a page the
    // seller stops trusting — so the message carries the screen that
    // undoes it, not just the news.
    expect(sent.link, 'البشارةُ ما دلّت على الشاشة التي تُرجِعها').toBe('/store/reviews');
    expect(sent.message).toContain('كريم الأذن');
    expect(logAudit.mock.calls.some((c) => c[0].action === 'REVIEW_MODE_AUTO_SWITCHED')).toBe(true);
  });

  it('counts only VERIFIED published reviews towards the floor', async () => {
    const { maybeAutoSwitch } = await import('./product-reviews');
    dbMock.product.findFirst.mockResolvedValue(product);
    dbMock.productReview.count.mockResolvedValue(5);
    await maybeAutoSwitch({ companyId: 'co-1', productId: 'prod-1' });

    const where = dbMock.productReview.count.mock.calls[0][0].where;
    // Five transcribed WhatsApp messages are not five checkable opinions,
    // and this floor is about evidence.
    expect(where.orderId, 'العدّةُ حسبت آراءً يدوية').toEqual({ not: null });
    expect(where.status).toBe('PUBLISHED');
    expect(where.consent).toBe(true);
  });

  it('and never overrides a choice the owner already made', async () => {
    const { maybeAutoSwitch } = await import('./product-reviews');
    for (const reviewMode of ['auto', 'both']) {
      vi.clearAllMocks();
      dbMock.product.findFirst.mockResolvedValue({ ...product, reviewMode });
      dbMock.productReview.count.mockResolvedValue(50);
      // `both` is a seller who chose to show both sources WITH the real
      // reviews already arriving. Overriding that would be the system
      // retaking a decision the owner had taken.
      expect(await maybeAutoSwitch({ companyId: 'co-1', productId: 'prod-1' }), reviewMode).toBe(false);
      expect(dbMock.product.update).not.toHaveBeenCalled();
    }
  });

  it('and the floor is the same five the delivery estimate already taught', () => {
    const reviews = read('src/lib/reviews.ts');
    const delivery = read('src/lib/delivery-time.ts');
    expect(delivery).toMatch(/MIN_DELIVERIES\s*=\s*5/);
    // Not a coincidence to be rediscovered: the file says which number it
    // is and why, so nobody «tunes» one of the two.
    expect(reviews).toContain('MIN_DELIVERIES');
  });

  it('and an unknown or absent mode reads as «manual», never as «auto»', async () => {
    const { reviewMode, shows } = await import('./reviews');
    for (const raw of [null, undefined, '', 'AUTO', 'tilqa2i']) {
      expect(reviewMode(raw), String(raw)).toBe('manual');
    }
    // The direction of the fallback is the honesty: a product with no
    // delivered orders has nothing automatic to show, so an unreadable
    // value must not open the automatic source.
    expect(shows(reviewMode(null)).auto).toBe(false);
  });
});

// ─────────────────────────────────────────────────────
// 7 · A countdown without a real end date is not «automatic»
// ─────────────────────────────────────────────────────

describe('the clock and the price read one fact', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const soon = new Date('2026-10-16T12:00:00Z');
  const later = new Date('2026-10-20T12:00:00Z');
  const past = new Date('2026-10-01T12:00:00Z');

  it('refuses «automatic» when no offer has a future ending', async () => {
    const { countdownRefusal } = await import('./countdown');
    for (const endsAt of [[], [null], [past], [null, past]]) {
      const refusal = countdownRefusal('offer', { endsAt, now });
      expect(refusal, `عدّادٌ تلقائيٌّ بلا نهاية: ${JSON.stringify(endsAt)}`).toBeTruthy();
      // The sentence says what to do, not merely that it failed.
      expect(refusal).toContain('تاريخ انتهاء');
    }
  });

  it('allows it the moment there is one, and reads the SOONEST', async () => {
    const { countdownRefusal, countdownEnd } = await import('./countdown');
    expect(countdownRefusal('offer', { endsAt: [later, soon], now })).toBeNull();
    // The soonest and not the latest: the customer is being told when the
    // thing in front of them stops, and the first bundle to expire is the
    // first promise the page breaks if it says otherwise.
    expect(countdownEnd({ endsAt: [later, soon, past, null], now })).toEqual(soon);
  });

  it('never refuses the per-visitor timer — it tells the truth about it instead', async () => {
    const { countdownRefusal, VISITOR_TIMER_WARNING, VISITOR_TIMER_FIX } = await import('./countdown');
    expect(countdownRefusal('visitor', { endsAt: [], now })).toBeNull();
    /*
     * It stays legal because «ثلاث ساعات لعرض اليوم» on a page that really
     * does change daily is a reasonable thing to want. What changes is
     * that the editor says out loud what it does — the brief's own two
     * sentences, not a paraphrase of them.
     */
    expect(VISITOR_TIMER_WARNING).toContain('العدّاد بيرجع لكل زائر');
    expect(VISITOR_TIMER_FIX).toContain('اربطه بتاريخ انتهاء حقيقي');
    const editor = read('src/components/landing-editor/BlockBuilder.tsx');
    expect(editor, 'المحرّر لا يُظهر التحذير').toContain('VISITOR_TIMER_WARNING');
    expect(editor, 'التحذيرُ بلا إصلاحٍ بجانبه').toContain('VISITOR_TIMER_FIX');
  });

  it('and the refusal is at the SAVE DOOR, in both places sections are written', () => {
    for (const door of [
      'src/app/api/landing-pages/[id]/content/route.ts',
      'src/app/api/store/design/route.ts',
    ]) {
      const src = code(door);
      /*
       * REFUSED AND NOT CORRECTED. Quietly rewriting `countdown: 'offer'`
       * back to `'visitor'` would leave the seller looking at a screen
       * saying «تلقائي» over the per-visitor timer — the exact confusion
       * this item exists to end.
       */
      expect(src, `${door}: الأقسامُ تُحفَظ بلا فحصِ العدّاد`).toContain('countdownRefusalIn');
      expect(src, `${door}: الرفضُ ما صار جواباً`).toMatch(/status: 400/);
      // The same function in both, never a second copy of the rule.
      expect(src).toContain("from '@/lib/landing-sections'");
    }
  });

  it('and a saved block defaults to the honest reading of what it already was', async () => {
    const { landingSectionSchema } = await import('./landing-sections');
    // A page written before this exists has no `countdown` field. It keeps
    // meaning exactly what it meant — the per-visitor timer — rather than
    // being promoted to a claim nobody made.
    const parsed = landingSectionSchema.parse({ id: 'u1', type: 'urgency', minutes: 30 });
    expect((parsed as { countdown: string }).countdown).toBe('visitor');
  });

  it('and the renderer draws nothing rather than falling back', () => {
    const src = code('src/components/landing/blocks/PageBlocks.tsx');
    const fn = src.slice(src.indexOf('function Urgency'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    /*
     * A fallback is how a seller ends up showing the dishonest clock they
     * thought they had replaced. `showsClock` is false for an offer-bound
     * countdown with no ending, so the block renders nothing at all.
     */
    expect(body).toMatch(/s\.countdown === 'offer'/);
    expect(body).toMatch(/showsClock/);
    expect(body).toContain('ctx.offerEndsAt');
  });
});

// ─────────────────────────────────────────────────────
// The counter, and the minimum it is shown above
// ─────────────────────────────────────────────────────

describe('an average is a measurement, or it is not shown', () => {
  it('is withheld below the floor and shown above it', async () => {
    const { reviewAverage, MIN_SHOWN_FOR_AVERAGE } = await import('./reviews');
    const four = Array.from({ length: 4 }, () => ({ rating: 5 }));
    const five = Array.from({ length: 5 }, () => ({ rating: 5 }));

    expect(reviewAverage([])).toEqual({ count: 0, average: null, show: false });
    /*
     * «٥ من ٥» over four reviews is a TRUE statement and a misleading
     * number: it reads as a measurement and it is four people. So the
     * average is computed either way — the seller's own screen shows the
     * count — and `show` is the answer to «may a shopper be given this as
     * a statistic».
     */
    expect(reviewAverage(four).show, 'معدَّلٌ مَعروضٌ تحت الحدّ').toBe(false);
    expect(reviewAverage(five).show).toBe(true);
    expect(MIN_SHOWN_FOR_AVERAGE).toBe(5);
  });

  it('rounds in the honest direction, never in the shop’s favour', async () => {
    const { reviewAverage } = await import('./reviews');
    // 4.4 and not 4.5: a tenth invented in the seller's favour is the same
    // defect as a struck-through price nothing supports.
    const rows = [{ rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 5 }, { rating: 3 }];
    expect(reviewAverage(rows).average).toBe(4.6);
    expect(reviewAverage([{ rating: 5 }, { rating: 4 }, { rating: 4 }]).average).toBe(4.3);
  });

  it('and the shop is handed nothing at all when the mode does not show it', async () => {
    const { shownReviews } = await import('./product-reviews');
    const out = await shownReviews({ companyId: 'co-1', productId: 'prod-1', reviewMode: 'manual' });
    // The server answers the question the mode asked, so the renderer
    // never has to remember to.
    expect(out).toEqual({ items: [], count: 0, average: null, showAverage: false });
    expect(dbMock.productReview.findMany, 'سألت قاعدةَ البيانات عن آراءٍ لا تُعرَض').not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────
// The house rules this item had to keep
// ─────────────────────────────────────────────────────

describe('the doors this item opened keep the house rules', () => {
  it('the moderation list pages through readPage and searches with typed()', () => {
    const src = code('src/app/api/reviews/route.ts');
    // Both are swept for across this repository. A door that rolls its own
    // is the door that answers 500 to `?page=abc`, or finds nothing for a
    // name typed in lowercase.
    expect(src, 'بابٌ مُصفَّحٌ بلا readPage').toContain('readPage(searchParams)');
    expect(src, 'بحثٌ نصّيٌّ بلا typed()').toContain('typed(term)');
  });

  it('the public rating door is rate limited and POSTs its token', () => {
    const src = code('src/app/api/public/stores/[store]/reviews/route.ts');
    expect(src).toContain('rateLimit(');
    // A credential in a query string is the browser's history, the access
    // log and the next page's referrer. POST is the privacy decision.
    expect(src, 'بابٌ عامٌّ يكتب عبر GET').not.toMatch(/export async function GET/);
    expect(src).toMatch(/export async function POST/);
  });

  it('the rating link is only handed out to somebody who proved both halves', () => {
    const src = code('src/lib/order-tracking.ts');
    // The tracking answer is the one place a stranger has already shown
    // they hold the phone AND the reference. Anywhere else would be handing
    // out the right to rate somebody else's order.
    expect(src).toContain('ratingPath');
    expect(src).toMatch(/RATEABLE\.includes\(state\)/);
    // And the field is on the list the payload is compared against, so it
    // cannot have been added quietly.
    expect(src).toMatch(/'ratingPath',/);
  });

  it('and the two variable families stay on their own side of the line', () => {
    // --store-* on a shop's pages, --sys-* on the dashboard's, and this
    // item wrote on both sides. `theme-isolation.test.ts` sweeps for it;
    // asserted here too, on the three files this item added.
    for (const shopFile of [
      'src/components/storefront/RatingForm.tsx',
      'src/app/s/[store]/r/[token]/page.tsx',
      'src/components/landing/blocks/styles.ts',
    ]) {
      expect(code(shopFile), `${shopFile}: لونُ النظام وصل متجراً`).not.toMatch(/--sys-/);
    }
    expect(
      code('src/components/screens/StoreReviewsScreen.tsx'),
      'لونُ المتجر وصل لوحةَ التحكّم'
    ).not.toMatch(/--store-/);
  });

  it('and a client screen never imports the half that carries Prisma', () => {
    for (const client of [
      'src/components/screens/StoreReviewsScreen.tsx',
      'src/components/landing-editor/BlockBuilder.tsx',
    ]) {
      const src = code(client);
      expect(src, `${client}: شاشةٌ تسحب قاعدةَ البيانات إلى المتصفّح`).not.toContain(
        "from '@/lib/product-reviews'"
      );
      expect(src).toContain("from '@/lib/reviews'");
    }
    // And the pure half really is pure: nothing server-side in it, for the
    // same reason route-registry.ts imports nothing server-side.
    const pure = code('src/lib/reviews.ts');
    for (const forbidden of ["'./db'", "'./audit'", "'./notify'", 'next/server']) {
      expect(pure, `reviews.ts استورد ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('and the migration is additive, with a rollback beside it', () => {
    const dir = 'prisma/migrations/20261015240000_reviews_and_the_counter';
    const sql = read(`${dir}/migration.sql`);
    const rollback = read(`${dir}/rollback.sql`);
    /*
     * ADDITIVE ONLY. One CREATE TABLE and one NULLABLE column with no
     * default, so not one existing row is written to — the rule every
     * migration in this repository is held to, and the one a
     * `prisma migrate dev` reset would have broken.
     */
    expect(sql, 'هجرةٌ تُسقِط').not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql, 'هجرةٌ تُفرِغ').not.toMatch(/\b(TRUNCATE|DELETE\s+FROM)\b/i);
    expect(sql, 'عمودٌ جديدٌ بقيمةٍ افتراضية يكتب في كلِّ صف').toMatch(
      /ADD COLUMN "review_mode" TEXT;/
    );
    expect(rollback).toMatch(/DROP TABLE IF EXISTS "product_reviews"/);
    expect(rollback).toMatch(/DELETE FROM "_prisma_migrations"/);
  });
});
