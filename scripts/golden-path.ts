/**
 * THE GOLDEN PATH — one order, every door, the same figure traced.
 *
 * «At every step, trace the SAME figure. Any stop where the number changes
 * without a rule explaining it is a P0.» — تشطيب ١, stage 4.
 *
 * Every stop in this system is proven on its own: there are 449 test files
 * and eight invariant ledgers. NOTHING proved the figure survives the
 * HANDOFFS between them, because there is no e2e harness in the repository
 * at all. This is that harness, and it is deliberately not a vitest file:
 * it speaks to a RUNNING server over HTTP, through the same doors a browser
 * uses, with a real session cookie — so a guard that exists only in a route
 * handler, a permission, or a serialiser is exercised rather than mocked.
 *
 * It CREATES and it never destroys: orders, one courier statement, receipts,
 * a closing, commission entries. It never deletes a row, never touches an
 * order it did not create, and prints everything it made so the rows can be
 * found afterwards.
 *
 *   npx tsx scripts/golden-path.ts
 *
 * THE THIRTEEN STOPS
 *
 *   0  setup — the offer, the shop's policy, the courier's fee table
 *   1  the order enters through the landing page a customer sees
 *   2  the agent confirms, and the shelf is held
 *   3  the warehouse prepares
 *   4  the shipment batch — WHERE THE COURIER'S FEE LANDS and the COD is
 *      recomputed. The per-order shipping transition never prices anything;
 *      this door does, and it is the one the warehouse screen uses.
 *   5  part of it, or all of it, is taken at the door
 *   6  what the tracking screen says settlement should expect
 *   7  the return comes back and is counted and inspected
 *   8  the courier's statement file is uploaded
 *   9  the receipt, split across two wallets
 *  10  matching — matched / mismatched / missing, both kinds
 *  11  approval: the wallet movements, and not one minor unit earlier
 *  12  the daily closing, with a difference and a written explanation
 *  13  the profit report and the commission ledger
 *
 * WHAT IT CANNOT WALK, AND SAYS SO RATHER THAN SKIPPING
 *
 *   - It does not walk the settlement stops AS AN ACCOUNTANT. ACCOUNTANT and
 *     SETTLEMENT_OFFICER are in TWO_FACTOR_ROLES and this harness is
 *     forbidden to enrol a second factor on anybody. Permissions in this
 *     codebase are ROWS (Role + RolePermission) and are separate from the
 *     role STRING that `requiresTwoFactor` reads, so the walk is done by a
 *     WAREHOUSE-role user holding `settlement.*` and `finance.*` grants.
 *     Every API guard is therefore exercised for real; the ROLE guard is
 *     not. Printed as a deviation at the end of every run.
 *   - A statement mixing old and new references is NOT attempted: the old
 *     system's reference format is unknown, so a "mixed" file would only
 *     prove that an invented string does not match.
 *
 * Requires the dev server on :3000 and a user it can sign in as. Pass
 * GOLDEN_EMAIL / GOLDEN_PASSWORD, or it will tell you what to create.
 *
 * ONE FULL WALK IS EIGHT ORDERS, and the public landing-page door allows ten
 * per IP per ten minutes. So it cannot be run twice inside the window: wait
 * it out, or walk a subset with GOLDEN_ONLY=MAIN,PARTIAL. A run that runs
 * into the limit says so under «محطّات لم تُمشَ» rather than reporting a
 * figure it never obtained.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
/*
 * THE RULES ARE IMPORTED, NEVER RETYPED.
 *
 * This script used to carry its OWN copy of the settlement rule —
 * `(collectedAmount ?? totalAmount) − deliveryFee`, written out by hand at
 * stop 6. When `expectedAmountFor` changed shape the copy did not, and no
 * compiler and no test suite reads this file, so the only end-to-end check
 * in the repository spent its runs announcing a defect that had already been
 * fixed: three `problem()` lines on a journey whose doors were all correct.
 * A harness that cries wolf is worse than no harness, because the next real
 * alarm is read as noise.
 *
 * So every rule the walk CHECKS is now called, not restated. Where the walk
 * deliberately keeps its own arithmetic — `honestNet` at stop 6 — it is
 * because the comparison would otherwise be `x === x`, and that is said at
 * the spot in so many words.
 */
import { commissionAmount, isPerOrderRule, PROMOTABLE_BY_PAYOUT, ruleFor, type RuleLike } from '../src/lib/commission';
import { roundMinor } from '../src/lib/money';
import { expectedAmountFor, SETTLEMENT_ORDER_SELECT } from '../src/lib/settlement';

/**
 * ROUNDING IS THE LIBRARY'S, NOT THIS SCRIPT'S.
 *
 * The local copy was `Math.round(value * f + EPSILON) / f`, and it disagreed
 * with `roundMinor` on exactly the figures the settlement rule can now
 * produce: `Math.round` breaks a negative tie TOWARDS ZERO (−2.5 → −2) while
 * `roundMinor` is half-away-from-zero (−2.5 → −3). A return fee larger than
 * what the customer kept makes the expectation negative, so a walk comparing
 * its own rounding against the rule's would have reported a one-minor-unit
 * «defect» that is nothing but two different roundings of one number.
 */
const round = roundMinor;

const db = new PrismaClient();
const BASE = process.env.GOLDEN_BASE || 'http://localhost:3000';

type Stop = { stop: string; figure: string; value: number | string | null; note?: string };
const trace: Stop[] = [];
const problems: string[] = [];
const created: string[] = [];
const notes: string[] = [];
/** A stop that could not be walked, and the plain sentence saying why. */
const blocked: string[] = [];

function record(stop: string, figure: string, value: number | string | null, note?: string) {
  trace.push({ stop, figure, value, note });
}
function problem(what: string) {
  problems.push(what);
}
function made(what: string) {
  created.push(what);
}
/**
 * A measured note. The SAME sentence about eight orders is one fact, not
 * eight: the first run of this harness printed the dropped-tracking-field
 * note once per scenario and buried the three findings that mattered.
 * `key` is what makes two notes the same note.
 */
const seenNotes = new Set<string>();
function observe(what: string, key?: string) {
  if (key) {
    if (seenNotes.has(key)) return;
    seenNotes.add(key);
  }
  notes.push(what);
}
function cannot(stop: string, why: string) {
  blocked.push(`${stop} — ${why}`);
}

let cookie = '';

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* an HTML error page is also an answer */
  }
  return { status: res.status, body: body as Record<string, unknown>, raw: res };
}

/** The same call as `api`, but with somebody else's session. */
async function apiAs(session: string, path: string, init: RequestInit = {}) {
  const keep = cookie;
  cookie = session;
  try {
    return await api(path, init);
  } finally {
    cookie = keep;
  }
}

async function signIn(email: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const session = setCookie.split(';')[0];
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!session.startsWith('salesflow_session=')) {
    throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  if (body.twoFactor && body.twoFactor !== 'none') {
    throw new Error(`this account needs a second factor (${String(body.twoFactor)}) — use a role outside TWO_FACTOR_ROLES`);
  }
  return { session, body };
}

/**
 * PICK THE COUNTRY AND THE STORE — the thing `/entry` does in a browser.
 *
 * `requireContext` reads a signed, HTTP-only cookie bound to the user id, and
 * every door that touches money refuses without it («اختر البلد والمتجر
 * أولاً»). A script that only signs in gets exactly as far as a person who
 * never picked a shop, which is the right behaviour and a real stop on this
 * walk: the guard is at the API, not on the sidebar.
 */
async function pickContext(session: string, countryId: string, storeId: string) {
  const res = await fetch(`${BASE}/api/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: session },
    body: JSON.stringify({ countryId, storeId }),
  });
  const set = res.headers.get('set-cookie') ?? '';
  const ctx = set.split(';')[0];
  if (!ctx.startsWith('salesflow_ctx=')) {
    throw new Error(`context not granted (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return `${session}; ${ctx}`;
}

/* ──────────────────────────────────────────────────────────────────────
 * STOP 0 — THE STAGE.
 *
 * The dev database is nearly empty, and the brief authorises building the
 * scenarios the walk needs. Everything here is ADDITIVE and idempotent:
 * grants are upserted, the approver is upserted, the discount offer is
 * looked up before it is made. Nothing is ever deleted.
 * ────────────────────────────────────────────────────────────────────── */

/** Permissions the settlement half of the walk needs, as ROWS on the role. */
const NEEDED_GRANTS = [
  'settlement.view',
  'settlement.upload',
  'settlement.review',
  'finance.view',
  'finance.create',
  'finance.cashbox',
  'ops.returns',
  // The walk reads the follow-up list by every state, returned ones included.
  'ops.returns_view',
  'ops.ship',
  'ops.track',
];

/** The second pair of hands the daily closing insists on. See STOP 12. */
const APPROVER_EMAIL = 'golden.path.approver@osm.local';
/**
 * NOT WRITTEN DOWN, BECAUSE IT NEVER NEEDS TO BE.
 *
 * This password used to be a literal in this file, in a public repository.
 * It did not need to be: the script creates the approver account and signs
 * in as it inside the same process, and re-hashes the password on every
 * run — so nothing outside this run has ever had to know it.
 *
 * A fresh random value per run is therefore strictly better than any fixed
 * one: there is no literal to read, and nothing is left behind that would
 * still open the account tomorrow. `GOLDEN_PATH_APPROVER_PASSWORD` is there
 * for the case where somebody needs to sign in as this account by hand
 * afterwards.
 */
const APPROVER_PASSWORD =
  process.env.GOLDEN_PATH_APPROVER_PASSWORD || `gp-${randomBytes(18).toString('base64url')}`;

interface Stage {
  storeId: string;
  countryId: string;
  minorUnit: number;
  currencyCode: string;
  slug: string;
  productId: string;
  regionId: string;
  regionName: string;
  providerId: string;
  providerName: string;
  fee: number;
  returnFee: number;
  cashWalletId: string;
  bankWalletId: string;
  cashWalletName: string;
  bankWalletName: string;
  userId: string;
  /** The walking user's ROLE STRING — what `ruleFor` matches a role rule on. */
  userRole: string;
  approverSession: string | null;
  discountOfferId: string | null;
}

async function setUpStage(userId: string, roleId: string | null, companyId: string): Promise<Stage> {
  /*
   * THE SHOP THE WALK HAPPENS IN is the one with a published landing page
   * whose product has costed stock on the shelf, a region with a FEE ROW for
   * an active courier, and at least two wallets to split a receipt across.
   * Picking the first of everything is how the earlier version of this
   * script ended up ordering a Jordanian phone into a Syrian governorate
   * with no fee table, and then tracing a delivery fee of zero through
   * thirteen stops — the figure never moved because there was no figure.
   */
  // The role STRING, which is a separate fact from the Role ROW the grants
  // hang off — and the fact `ruleFor` matches a role-scoped rule on.
  const walker = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });

  const page = await db.landingPage.findFirst({
    where: { isPublished: true, productId: { not: null }, storeId: { not: null } },
    select: { slug: true, productId: true, storeId: true },
  });
  if (!page?.productId || !page.storeId) throw new Error('no published landing page with a product to order from');

  const store = await db.store.findUniqueOrThrow({
    where: { id: page.storeId },
    select: { id: true, name: true, countryId: true, priceIncludesDelivery: true, country: { select: { minorUnit: true, currencyCode: true, allowNegativeStock: true } } },
  });

  /*
   * A REGION WITH A PRICE ON IT. `shipmentBlocks` HARD-blocks an order whose
   * region and courier have no fee row, so a region chosen for being first
   * in the table is a walk that stops at stop 4.
   */
  const feeRow = await db.deliveryFee.findFirst({
    where: {
      isActive: true,
      fee: { gt: 0 },
      region: { isActive: true, countryId: store.countryId },
      provider: { isActive: true, companyId },
    },
    orderBy: { fee: 'asc' },
    select: {
      fee: true, returnFee: true,
      region: { select: { id: true, name: true } },
      provider: { select: { id: true, name: true } },
    },
  });
  if (!feeRow) throw new Error(`no active delivery-fee row for any region of ${store.name} — stop 4 cannot price anything`);

  const wallets = await db.wallet.findMany({
    where: { companyId, storeId: store.id, isActive: true, currencyCode: store.country.currencyCode },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  if (wallets.length < 2) {
    throw new Error(
      `the store has ${wallets.length} active ${store.country.currencyCode} wallet(s); stop 9 splits one receipt across two`
    );
  }

  // ── the grants, as ROWS. See the header: this is the 2FA deviation. ──
  if (roleId) {
    const held = new Set(
      (await db.rolePermission.findMany({ where: { roleId }, select: { permission: true } })).map((r) => r.permission)
    );
    const addNew = NEEDED_GRANTS.filter((p) => !held.has(p));
    for (const permission of addNew) {
      await db.rolePermission.create({ data: { roleId, permission, scope: 'ALL_COMPANY' } });
    }
    if (addNew.length > 0) made(`RolePermission × ${addNew.length} على الدور ${roleId}: ${addNew.join(', ')}`);
  } else {
    observe('the walking user has no Role row — it is relying on its role STRING, so the grants below were not added');
  }

  /*
   * AN OFFER WITH A DISCOUNT ON IT, for the breaking order the brief names.
   * Looked up first; made only if the shop has none.
   */
  let discountOffer = await db.offer.findFirst({
    where: { productId: page.productId, status: 'ACTIVE', discount: { gt: 0 } },
    select: { id: true },
  });
  if (!discountOffer) {
    const base = await db.offer.findFirst({
      where: { productId: page.productId, status: 'ACTIVE', quantity: 2 },
      select: { companyId: true, sellingPrice: true, deliveryIncluded: true },
    });
    if (base) {
      discountOffer = await db.offer.create({
        data: {
          companyId: base.companyId,
          productId: page.productId,
          name: 'قطعتان بحسم ٣ — طلب كسر (المسار الذهبي)',
          quantity: 2,
          freeQuantity: 0,
          sellingPrice: base.sellingPrice,
          discount: 3,
          deliveryIncluded: base.deliveryIncluded,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      made(`Offer «قطعتان بحسم ٣ — طلب كسر (المسار الذهبي)» (${discountOffer.id})`);
    }
  }

  /*
   * A COMMISSION RULE FOR THIS STORE, or stop 13 only ever reports NO_RULE.
   * Scoped to THE WALKING USER rather than to a role, so it cannot start
   * paying anybody else's real deliveries.
   */
  const existingRule = await db.commissionRule.findFirst({
    where: { companyId, storeId: store.id, appliesToUserId: userId, isActive: true },
    select: { id: true },
  });
  if (!existingRule) {
    const rule = await db.commissionRule.create({
      data: {
        companyId,
        storeId: store.id,
        name: 'عمولة المسار الذهبي (سكربت)',
        appliesToRole: null,
        appliesToUserId: userId,
        basis: 'ORDER_DELIVERED',
        type: 'PERCENT',
        value: 5,
        metric: 'ORDER_DELIVERED',
        period: 'PER_ORDER',
        effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
        effectiveTo: null,
        isActive: true,
        createdById: userId,
      },
      select: { id: true },
    });
    made(`CommissionRule «عمولة المسار الذهبي (سكربت)» 5% (${rule.id})`);
  }

  /*
   * THE SECOND PAIR OF HANDS. «من يسجّل الحركات أو الجرد لا يعتمد الإغلاق».
   * The walking user posts the wallet movements at stop 11, so by stop 12 it
   * is disqualified from approving its own count — which is the rule, and
   * the only way to walk past it is with another person.
   *
   * Role STRING 'WAREHOUSE', deliberately: it is outside TWO_FACTOR_ROLES, so
   * no second factor is enrolled on anybody. It shares the walking user's
   * Role row, so it holds the same grant set and no new Role is invented.
   */
  let approverSession: string | null = null;
  const approver = await db.user.upsert({
    where: { email: APPROVER_EMAIL },
    update: { status: 'ACTIVE', companyId, roleId, role: 'WAREHOUSE' },
    create: {
      email: APPROVER_EMAIL,
      name: 'معتمِد الإغلاق (المسار الذهبي)',
      passwordHash: await bcrypt.hash(APPROVER_PASSWORD, 10),
      role: 'WAREHOUSE',
      status: 'ACTIVE',
      companyId,
      roleId,
    },
    select: { id: true, createdAt: true, updatedAt: true },
  });
  // The password is rewritten on every run, so the one this run generated is
  // always the live one — an approver nobody can sign in as is no approver.
  // It is not written down anywhere; this run holds it and then it is gone.
  await db.user.update({ where: { id: approver.id }, data: { passwordHash: await bcrypt.hash(APPROVER_PASSWORD, 10) } });
  made(
    `User ${APPROVER_EMAIL} (${approver.id}) — كلمة المرور مولّدة لهالتشغيل` +
      ' (حطّ GOLDEN_PATH_APPROVER_PASSWORD إذا بدّك تدخل عليه بإيدك بعدين)'
  );
  /*
   * AND THE COUNTRY, or `/api/context` answers «Forbidden: country not
   * accessible» and the second pair of hands never gets through the door.
   * Permissions say WHAT somebody may do; UserCountryAccess says WHERE —
   * two separate gates, and the first run of this stop remembered only one.
   */
  await db.userCountryAccess.upsert({
    where: { userId_countryId: { userId: approver.id, countryId: store.countryId } },
    update: {},
    create: { userId: approver.id, countryId: store.countryId },
  });
  /*
   * And a named store ONLY if they were already confined to named stores:
   * `hasStoreGrants` is read ACROSS countries, so handing a row to somebody
   * who has none would narrow them rather than widen them.
   */
  if ((await db.userStoreAccess.count({ where: { userId: approver.id } })) > 0) {
    await db.userStoreAccess.upsert({
      where: { userId_storeId: { userId: approver.id, storeId: store.id } },
      update: {},
      create: { userId: approver.id, storeId: store.id },
    });
  }
  try {
    const { session } = await signIn(APPROVER_EMAIL, APPROVER_PASSWORD);
    approverSession = await pickContext(session, store.countryId, store.id);
  } catch (e) {
    cannot('١٢ · الإغلاق اليومي', `could not sign the approver in: ${e instanceof Error ? e.message : String(e)}`);
  }

  record('٠ · الإعداد', 'المتجر', store.name);
  record('٠ · الإعداد', 'سياسة المتجر تشمل التوصيل', String(store.priceIncludesDelivery));
  record('٠ · الإعداد', 'المنطقة', feeRow.region.name);
  record('٠ · الإعداد', 'شركة الشحن', feeRow.provider.name);
  record('٠ · الإعداد', 'أجرة التوصيل من الجدول', Number(feeRow.fee));
  record('٠ · الإعداد', 'أجرة الإرجاع من الجدول', Number(feeRow.returnFee));

  return {
    storeId: store.id,
    countryId: store.countryId,
    minorUnit: store.country.minorUnit,
    currencyCode: store.country.currencyCode,
    slug: page.slug,
    productId: page.productId,
    regionId: feeRow.region.id,
    regionName: feeRow.region.name,
    providerId: feeRow.provider.id,
    providerName: feeRow.provider.name,
    fee: Number(feeRow.fee),
    returnFee: Number(feeRow.returnFee),
    cashWalletId: wallets[0].id,
    cashWalletName: wallets[0].name,
    bankWalletId: wallets[1].id,
    bankWalletName: wallets[1].name,
    userId,
    userRole: walker.role,
    approverSession,
    discountOfferId: discountOffer?.id ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * THE SIX BREAKING ORDERS, as scenarios.
 *
 * Each one is a shape where the figure CAN drift: the plain walk cannot show
 * a drift it has no room for, and «the number did not change» over an order
 * of one unit at a round price proves very little.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * What happened at the door. `SKIP` means NOBODY TICKED ANYTHING — the
 * parcel stays SHIPPED and the courier's statement is what proves it was
 * delivered. That is the documented main path for an integrated courier
 * («THE STATEMENT IS THE DELIVERY PROOF, AND THE ONLY SOURCE OF THE MONEY»
 * in src/app/api/finance/statements/[id]/route.ts), and the only path where
 * an order becomes DELIVERED and SETTLED in the same instant.
 */
type Door = 'ALL' | 'PARTIAL' | 'NONE' | 'SKIP';

interface Scenario {
  key: string;
  label: string;
  /** How the offer is chosen out of the shop's live offers. */
  pick: 'single' | 'multi-no-delivery' | 'discount' | 'delivery-included' | 'bundle-free';
  door: Door;
  /** Whether the courier's file lists this parcel at all. */
  inStatement: boolean;
  /** What to add to the honest net, to force a MISMATCH. 0 = state it right. */
  statedDelta: number;
  /** State a wrong delivery fee instead of a wrong net. */
  feeDelta?: number;
  /** Charge the courier the return fee when the goods come back. */
  chargeReturnFee?: boolean;
}

const SCENARIOS: Scenario[] = [
  { key: 'MAIN', label: 'الطلب الأصل — قطعة واحدة، السعر يشمل التوصيل', pick: 'single', door: 'ALL', inStatement: true, statedDelta: 0 },
  { key: 'PARTIAL', label: 'طلب كسر — تسليم جزئي، والسعر لا يشمل التوصيل', pick: 'multi-no-delivery', door: 'PARTIAL', inStatement: true, statedDelta: 0 },
  { key: 'DISCOUNT', label: 'طلب كسر — عرض عليه حسم', pick: 'discount', door: 'ALL', inStatement: true, statedDelta: 0 },
  { key: 'FREE_DELIVERY', label: 'طلب كسر — توصيل مجاني للعميل (المتجر يتحمّله)', pick: 'delivery-included', door: 'ALL', inStatement: true, statedDelta: 0, feeDelta: 1 },
  { key: 'RETURN_FEE', label: 'طلب كسر — مرتجع كامل بأجرة إرجاع', pick: 'single', door: 'NONE', inStatement: false, statedDelta: 0, chargeReturnFee: true },
  { key: 'BUNDLE_FREE', label: 'طلب كسر — حزمة فيها قطعة مجانية', pick: 'bundle-free', door: 'ALL', inStatement: true, statedDelta: 2 },
  { key: 'UNLISTED', label: 'طلب مسلَّم تركته الشركة خارج كشفها', pick: 'single', door: 'ALL', inStatement: false, statedDelta: 0 },
  { key: 'BY_STATEMENT', label: 'طلب لم يُسجّل تسليمه يداً — الكشف هو إثبات التسليم', pick: 'single', door: 'SKIP', inStatement: true, statedDelta: 0 },
];

async function offerFor(stage: Stage, pick: Scenario['pick']) {
  const base = { productId: stage.productId, status: 'ACTIVE' as const };
  switch (pick) {
    case 'single':
      return db.offer.findFirst({ where: { ...base, quantity: 1, freeQuantity: 0 }, select: OFFER_FIELDS });
    case 'multi-no-delivery':
      return db.offer.findFirst({
        where: { ...base, quantity: { gte: 2 }, deliveryIncluded: false },
        orderBy: { quantity: 'desc' },
        select: OFFER_FIELDS,
      });
    case 'discount':
      return stage.discountOfferId
        ? db.offer.findUnique({ where: { id: stage.discountOfferId }, select: OFFER_FIELDS })
        : null;
    case 'delivery-included':
      return db.offer.findFirst({
        where: { ...base, deliveryIncluded: true, quantity: { gte: 2 }, freeQuantity: 0 },
        select: OFFER_FIELDS,
      });
    case 'bundle-free':
      return db.offer.findFirst({ where: { ...base, freeQuantity: { gt: 0 } }, select: OFFER_FIELDS });
  }
}

const OFFER_FIELDS = {
  id: true, name: true, quantity: true, freeQuantity: true,
  sellingPrice: true, discount: true, deliveryIncluded: true,
} as const;

/**
 * The order as the database holds it right now — the figure after a stop.
 *
 * `SETTLEMENT_ORDER_SELECT` IS SPREAD, NOT COPIED, and its nested `items`
 * select is spread inside this one. That is the whole guarantee: when the
 * settlement rule grows a field, every `reread` on this walk selects it on
 * the next run, and `expectedAmountFor(o, …)` keeps type-checking. Listing
 * `totalAmount, deliveryFee, collectedAmount, …` by hand is how `items` and
 * `returnReceipt` came to be missing here while the rule had started reading
 * both.
 */
async function reread(id: string) {
  const o = await db.order.findUnique({
    where: { id },
    select: {
      ...SETTLEMENT_ORDER_SELECT,
      id: true, orderNumber: true, version: true, confirmationStatus: true,
      settlementStatus: true, estimatedCostOfGoods: true,
      merchantRef: true, trackingNumber: true, discountAmount: true,
      items: {
        select: {
          ...SETTLEMENT_ORDER_SELECT.items.select,
          id: true, productId: true, reservedQty: true,
        },
      },
    },
  });
  if (!o) throw new Error('the order vanished mid-walk');
  return o;
}

type Walked = Awaited<ReturnType<typeof reread>>;

interface Run {
  scenario: Scenario;
  order: Walked;
  offerPrice: number;
  offerName: string;
  /** What the door said we should expect the courier to hand over. */
  doorExpected: number | null;
  /** What the tracking screen said settlement should expect. */
  screenExpected: number | null;
  /**
   * THE TRUTH: what the courier should hand over for this parcel, derived
   * from what the door says the customer actually paid, minus the fee the
   * courier keeps. This is what the statement file states.
   */
  honestNet: number;
  /**
   * WHAT THE SYSTEM THINKS it should get — `expectedAmountFor` in
   * lib/settlement.ts, which is also what the collection screen prints. The
   * two are the same figure or stop 6 is a P0.
   */
  systemExpects: number;
  reachedDoor: boolean;
}

/* ──────────────────────────────────────────────────────────────────────
 * STOPS 1–6 — the order enters, is confirmed, held, priced, shipped, taken
 * at the door, and read back off the screen that chases the money.
 * ────────────────────────────────────────────────────────────────────── */

async function stopOneOrderEnters(stage: Stage, scenario: Scenario) {
  const offer = await offerFor(stage, scenario.pick);
  if (!offer) {
    cannot(`١ · ${scenario.key}`, `the shop has no live offer of the shape «${scenario.pick}», so this breaking order has nothing to be made of`);
    return null;
  }

  // A Jordanian-shaped mobile: the store's country decides the rule, and the
  // public door refuses anything else — invariant 4 of the customer section
  // proving itself at the first stop.
  const phone = `079${String(Date.now()).slice(-7)}`;
  const payload = JSON.stringify({
    full_name: `المسار الذهبي — ${scenario.key}`,
    phone,
    address: 'شارع الاختبار، بناء ١٢',
    city: stage.regionName,
    offerId: offer.id,
    notes: `طلب أنشأه سكربت المسار الذهبي (${scenario.key})`,
  });
  let res = await api(`/api/public/landing-pages/${stage.slug}/orders`, { method: 'POST', body: payload });
  /*
   * THE PUBLIC DOOR RATE-LIMITS: `rateLimit('lp_order:' + ip, 10, 10 min)`.
   * It is a real guard on a real door and this harness does not get to
   * pretend otherwise — but seven breaking orders plus a second run inside
   * ten minutes is over it, and then the walk reports a rate limit instead
   * of a figure. So a short wait is taken once, and a long one is NAMED and
   * the stop is declared unwalked rather than quietly skipped.
   */
  if (res.status === 429) {
    const said = String((res.body as { error?: string }).error ?? '');
    const wait = Number(/(\d+)/.exec(said)?.[1] ?? 0);
    if (wait > 0 && wait <= 75) {
      observe(`١ · ${scenario.key}: الباب العام ردّ ٤٢٩، فانتظر السكربت ${wait} ثانية وأعاد المحاولة`);
      await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      res = await api(`/api/public/landing-pages/${stage.slug}/orders`, { method: 'POST', body: payload });
    }
  }
  if (res.status === 429) {
    cannot(
      `١ · ${scenario.key}`,
      'the public landing-page door rate-limits to 10 orders per IP per 10 minutes (rateLimit("lp_order:"+ip) in ' +
        'src/app/api/public/landing-pages/[slug]/orders/route.ts) and this run is over it. The full walk needs ' +
        'seven orders, so it cannot be run twice inside the window: wait it out, or pass GOLDEN_ONLY=KEY,KEY.'
    );
    return null;
  }
  if (res.status !== 200 && res.status !== 201) {
    problem(`١ · ${scenario.key}: الباب العام رفض الطلب (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
    return null;
  }

  const orderNumber = String(
    (res.body.orderNumber as string) ?? ((res.body.order as Record<string, unknown>)?.orderNumber as string) ?? ''
  );
  if (!orderNumber) {
    problem(`١ · ${scenario.key}: الباب أجاب ٢٠٠ بلا رقم طلب: ${JSON.stringify(res.body).slice(0, 200)}`);
    return null;
  }
  const row = await db.order.findFirst({ where: { orderNumber }, select: { id: true } });
  if (!row) {
    problem(`١ · ${scenario.key}: الطلب ${orderNumber} أُجيب عنه وليس في القاعدة`);
    return null;
  }
  const order = await reread(row.id);
  made(`Order ${order.orderNumber} (${order.id}) — ${scenario.label}`);

  const offerPrice = Number(offer.sellingPrice);
  const offerDiscount = Number(offer.discount ?? 0);
  record(`١ · ${scenario.key}`, 'سعر العرض', offerPrice, offer.name);
  if (offerDiscount > 0) record(`١ · ${scenario.key}`, 'حسم العرض', offerDiscount);
  record(`١ · ${scenario.key}`, 'الإجمالي عند الدخول', Number(order.totalAmount));
  record(`١ · ${scenario.key}`, 'أجرة التوصيل عند الدخول', Number(order.deliveryFee ?? 0));
  record(`١ · ${scenario.key}`, 'السعر يشمل التوصيل', String(order.priceIncludesDelivery));

  /*
   * THE RULE FIXED ON 2026-10-02: «if ANY line includes delivery, the whole
   * order does» — read back off the row rather than taken on trust.
   */
  if (offer.deliveryIncluded && !order.priceIncludesDelivery) {
    problem(`١ · ${scenario.key}: العرض «${offer.name}» يقول إنّ السعر يشمل التوصيل، والطلب كُتب بعكس ذلك`);
  }
  if (!order.merchantRef) {
    problem(`١ · ${scenario.key}: الطلب ${order.orderNumber} بلا مرجع تاجر — والعقد يطلبه عند كل باب`);
  }

  /*
   * THE DISCOUNT THAT NEVER ARRIVED.
   *
   * `Offer.discount` is a column the offer editor writes and the landing page
   * prints. `createPublicOrder` calls `computeCod` with the lines only — no
   * `discount` argument — so the offer's discount is not in the COD, not in
   * `Order.discountAmount`, and not in any line's `discountShare`. The number
   * the customer was shown and the number they are asked for at the door are
   * two different numbers, and nothing between them says so.
   */
  if (offerDiscount > 0) {
    const onOrder = Number(order.discountAmount ?? 0);
    const shares = order.items.reduce((s, i) => s + Number(i.discountShare ?? 0), 0);
    record(`١ · ${scenario.key}`, 'الحسم كما كُتب على الطلب', onOrder);
    record(`١ · ${scenario.key}`, 'مجموع حصص الحسم على البنود', shares);
    if (onOrder === 0 && shares === 0) {
      problem(
        `١ · ${scenario.key}: حسم العرض ${offerDiscount} لم يصل الطلب — الإجمالي ${Number(order.totalAmount)} ` +
          `وهو سعر العرض كاملاً (${offerPrice}). الباب العام يستدعي computeCod بلا وسيط discount أصلاً ` +
          `(src/lib/public-order.ts)، فلا الإجمالي ولا discountAmount ولا discountShare يحمل الحسم.`
      );
    }
  }

  return { order, offer, offerPrice };
}

async function confirmAndHold(stage: Stage, scenario: Scenario, orderId: string) {
  let o = await reread(orderId);
  const confirm = await api(`/api/orders/${orderId}/confirmation`, {
    method: 'POST',
    body: JSON.stringify({ action: 'confirm', expectedVersion: o.version }),
  });
  if (confirm.status !== 200) {
    problem(`٢ · ${scenario.key}: التأكيد رُفض (${confirm.status}): ${JSON.stringify(confirm.body).slice(0, 220)}`);
    return null;
  }
  o = await reread(orderId);
  record(`٢ · ${scenario.key}`, 'الإجمالي بعد التأكيد', Number(o.totalAmount));

  /*
   * A LINE LEFT UNRESERVED IS NOT A DEFECT ON ITS OWN.
   *
   * The first run of this script called «reserved 0 of 1» a problem and it
   * was wrong: the shelf was empty, the country disallows negative stock, so
   * `reserveOrderLines` leaves the line unreserved ON PURPOSE and the
   * READY_TO_SHIP guard then refuses the order. That is the contract working.
   * So the shelf is read first, and only a line that COULD have been held and
   * was not is a problem.
   */
  const needed = o.items.reduce((s, i) => s + i.quantity + i.freeQuantity, 0);
  const held = o.items.reduce((s, i) => s + i.reservedQty, 0);
  /*
   * AVAILABLE, THE WAY THE RESERVER COMPUTES IT: `availableStock` in
   * lib/reservation.ts is `onHand − reservedElsewhere`, not the batch sum.
   * This read the batch sum alone, and by the eighth order of one walk the
   * seven before it were holding reservations against the same shelf — so
   * the harness announced «the line could have been held and was not» about
   * a shelf that was genuinely empty. A false alarm in a harness is worse
   * than a missing check: it teaches whoever reads it to skim the list.
   */
  const productIds = o.items.map((i) => i.productId);
  const [shelf, elsewhere] = await Promise.all([
    db.productionBatch.aggregate({
      where: { productId: { in: productIds }, quantityRemaining: { gt: 0 } },
      _sum: { quantityRemaining: true },
    }),
    db.orderItem.aggregate({
      where: { productId: { in: productIds }, orderId: { not: orderId }, reservedQty: { gt: 0 } },
      _sum: { reservedQty: true },
    }),
  ]);
  const onHand = shelf._sum.quantityRemaining ?? 0;
  const reservedElsewhere = elsewhere._sum.reservedQty ?? 0;
  const available = onHand - reservedElsewhere;
  record(
    `٢ · ${scenario.key}`,
    'المحجوز / المطلوب',
    `${held} / ${needed}`,
    `على الرف ${onHand} ومحجوزٌ لطلباتٍ أخرى ${reservedElsewhere} فالمتاح ${available}`
  );
  if (held !== needed && available >= needed) {
    problem(`٢ · ${scenario.key}: حُجز ${held} من ${needed} والرف فيه ${available} — فالسطر كان يمكن حجزه ولم يُحجز`);
    return null;
  }
  if (held !== needed) {
    cannot(
      `٢ · ${scenario.key}`,
      `the shelf holds ${onHand} of which ${reservedElsewhere} is reserved for other orders, leaving ` +
        `${available} against a need of ${needed}. The country disallows negative stock, so the line stays ` +
        'unreserved ON PURPOSE and READY_TO_SHIP refuses the order — the contract working. This ' +
        'order walk ends here; produce more stock for the walked product to see it through.'
    );
    return null;
  }
  return o;
}

/**
 * STOPS 3 AND 4 — the warehouse prepares, then the SHIPMENT BATCH prices it.
 *
 * THE DOOR THAT WAS MISSING FROM THIS HARNESS. The earlier version walked
 * NOT_READY → READY_FOR_SHIPPING → PACKING → READY_FOR_PICKUP → SHIPPED
 * through `/api/orders/:id/shipping`, which transitions a status and prices
 * NOTHING: it never chooses a courier, never reads the fee table, never
 * recomputes the COD. So `deliveryFee` stayed null for the whole walk and
 * the figure was traced through thirteen stops with the one quantity that
 * can make it move set to zero.
 *
 * `POST /api/ops/shipments` is the door the warehouse screen actually uses.
 * It assigns the courier, snapshots the fee from the table, RECOMPUTES
 * `totalAmount` through `codForOrder`, and moves the order to
 * READY_FOR_PICKUP / PENDING_COLLECTION in the same transaction.
 */
async function prepareAndShip(stage: Stage, scenario: Scenario, orderId: string) {
  for (const to of ['READY_FOR_SHIPPING', 'PACKING']) {
    const o = await reread(orderId);
    const r = await api(`/api/orders/${orderId}/shipping`, {
      method: 'POST',
      body: JSON.stringify({ action: 'transition', to, expectedVersion: o.version }),
    });
    if (r.status !== 200) {
      problem(`٣ · ${scenario.key}: الانتقال إلى ${to} رُفض (${r.status}): ${JSON.stringify(r.body).slice(0, 220)}`);
      return null;
    }
  }
  let o = await reread(orderId);
  record(`٣ · ${scenario.key}`, 'الإجمالي في المستودع', Number(o.totalAmount), o.shippingStatus);

  /*
   * THE COURIER'S BARCODE, THROUGH THE ONLY DOOR THAT WRITES IT.
   *
   * Matching keys on the barcode first and falls back to our merchant
   * reference. The earlier version of this harness sent `trackingNumber`
   * alongside the SHIPPED transition, got 200, and shipped every order with
   * no barcode at all — so thirteen stops were walked and the PRIMARY match
   * key was never once exercised. `action: 'transition'` does not write the
   * field; `action: 'update_tracking'` does, and only before SHIPPED.
   */
  const barcode = `GP${scenario.key.slice(0, 4)}${Date.now().toString(36).toUpperCase()}`;
  const tracked = await api(`/api/orders/${orderId}/shipping`, {
    method: 'POST',
    body: JSON.stringify({ action: 'update_tracking', trackingNumber: barcode, expectedVersion: o.version }),
  });
  if (tracked.status !== 200) {
    problem(`٣ · ${scenario.key}: تثبيت الباركود رُفض (${tracked.status}): ${JSON.stringify(tracked.body).slice(0, 220)}`);
  }
  o = await reread(orderId);
  record(`٣ · ${scenario.key}`, 'باركود الشركة', o.trackingNumber ?? '— غائب —');
  if (o.trackingNumber !== barcode) {
    problem(`٣ · ${scenario.key}: الباركود لم يُكتب — والمطابقة تقرأه أولاً`);
  }

  const before = Number(o.totalAmount);
  const batch = await api('/api/ops/shipments', {
    method: 'POST',
    body: JSON.stringify({
      deliveryProviderId: stage.providerId,
      orderIds: [orderId],
      // Soft warnings (a recent return from the same customer, another
      // shipment in flight) must be acknowledged PER ORDER; a walk that
      // creates its own customers has none, but a dev database that has
      // seen other runs may.
      acknowledgedOrderIds: [orderId],
      notes: 'المسار الذهبي',
    }),
  });
  if (batch.status !== 201) {
    problem(`٤ · ${scenario.key}: إنشاء الشحنة رُفض (${batch.status}): ${JSON.stringify(batch.body).slice(0, 300)}`);
    return null;
  }
  made(`ShippingBatch ${String((batch.body.batch as Record<string, unknown>)?.batchNumber ?? '?')} — ${scenario.key}`);

  o = await reread(orderId);
  const after = Number(o.totalAmount);
  record(`٤ · ${scenario.key}`, 'الإجمالي بعد التسعير', after);
  record(`٤ · ${scenario.key}`, 'أجرة التوصيل المثبَّتة', Number(o.deliveryFee ?? 0));
  record(`٤ · ${scenario.key}`, 'حالة التسوية', o.settlementStatus);

  /*
   * THE FIGURE MOVES HERE, AND THERE IS A RULE FOR IT: COD = net + fee when
   * the price EXCLUDES delivery, and COD = net when it includes it. So a
   * delivery-included order must come out of this door unchanged, and a
   * delivery-excluded one must come out exactly one fee higher. Anything
   * else is the stop where the number changed for no reason.
   */
  const fee = Number(o.deliveryFee ?? 0);
  const expectedAfter = o.priceIncludesDelivery ? before : before + fee;
  if (Math.abs(after - expectedAfter) > 1e-9) {
    problem(
      `٤ · ${scenario.key}: الإجمالي صار ${after} وكان ${before} بأجرة ${fee}; ` +
        `القاعدة (COD = الصافي ${o.priceIncludesDelivery ? '' : '+ الأجرة'}) تقول ${expectedAfter}`
    );
  } else if (after !== before) {
    observe(
      `٤ · ${scenario.key}: الإجمالي ارتفع من ${before} إلى ${after} بأجرة التوصيل ${fee} — ` +
        'وهو ما تقوله القاعدة لطلبٍ سعره لا يشمل التوصيل. ما رآه العميل على صفحة الهبوط هو ' +
        `${before}، وما سيُطلب منه على الباب ${after}.`
    );
  }

  o = await reread(orderId);
  /*
   * AND A SECOND BARCODE SENT WITH THE TRANSITION, which the route accepts
   * in its body and never writes. It is sent on purpose so the answer is
   * measured rather than asserted: a door that takes a field, answers 200
   * and stores nothing is how this harness shipped barcode-less orders.
   */
  const ignoredBarcode = `GP-IGNORED-${Date.now().toString(36).toUpperCase()}`;
  const ship = await api(`/api/orders/${orderId}/shipping`, {
    method: 'POST',
    body: JSON.stringify({
      action: 'transition',
      to: 'SHIPPED',
      expectedVersion: o.version,
      deliveryProviderId: stage.providerId,
      trackingNumber: ignoredBarcode,
    }),
  });
  if (ship.status !== 200) {
    problem(`٤ · ${scenario.key}: الشحن رُفض (${ship.status}): ${JSON.stringify(ship.body).slice(0, 220)}`);
    return null;
  }
  o = await reread(orderId);
  record(`٤ · ${scenario.key}`, 'الإجمالي بعد الشحن', Number(o.totalAmount));
  record(`٤ · ${scenario.key}`, 'الباركود بعد الشحن', o.trackingNumber ?? '— غائب —');
  if (!o.trackingNumber) {
    problem(`٤ · ${scenario.key}: الطلب شُحن بلا باركود — والمطابقة تقرأ الباركود أولاً`);
  }
  if (o.trackingNumber === ignoredBarcode) {
    problem(`٤ · ${scenario.key}: انتقال SHIPPED كتب رقم التتبّع، والعقد يقول إنّ البوليصة لا تُعدَّل بعد الشحن`);
  } else if (ship.status === 200) {
    observe(
      '٤ · أُرسل trackingNumber مع انتقال SHIPPED وأجاب الباب ٢٠٠ ولم يكتب شيئاً — على كل طلبٍ مُشي. ' +
        'الحالة transition في src/app/api/orders/[id]/shipping/route.ts تقرأ الحقل من الجسم ولا ' +
        'تستعمله، والكتابة كلُّها في update_tracking وهي ممنوعة بعد الشحن. حقلٌ مقبولٌ ومُهمَل بلا كلمة، ' +
        'والباركود هو المفتاح الأول للمطابقة.',
      'tracking-dropped'
    );
  }
  return o;
}

/** STOP 5 — the door. And STOP 6 — the screen that chases the money. */
async function atTheDoor(stage: Stage, scenario: Scenario, order: Walked) {
  const lines = order.items;

  /*
   * NOBODY STOOD AT THE DOOR. The parcel is with the courier and no
   * follow-up agent ticked anything; the statement will say it arrived and
   * how much came with it. Everything after this is the same walk.
   */
  if (scenario.door === 'SKIP') {
    const o = await reread(order.id);
    /*
     * HERE TOO THE RULE IS CALLED. This branch used to compute ONE figure,
     * `totalAmount − deliveryFee`, and hand it back as BOTH answers — so the
     * walk's loudest check (honest vs. system) was hard-wired to pass on
     * this scenario whatever the rule said. The door's figure is the whole
     * order, because nobody stood at the door and the customer is still
     * expected to pay for all of it; the rule's figure comes from the rule,
     * which reaches the same place by its own road (no line has a
     * `deliveredQty`, so `collectedAtDoor` falls back to the order's total).
     * The two agreeing is now a measurement rather than an assignment.
     */
    const doorAll = round(Number(o.totalAmount), stage.minorUnit);
    const net = honestNetFor(o, doorAll, stage.minorUnit);
    const ruleSays = expectedAmountFor(o, stage.minorUnit);
    record(`٥ · ${scenario.key}`, 'لم يُسجَّل تسليم يدوي', o.shippingStatus);
    record(`٦ · ${scenario.key}`, 'الصافي الصحيح من الباب', net, 'لا باب — القيمة كلُّها منتظرة');
    record(`٦ · ${scenario.key}`, 'الصافي كما تحسبه القاعدة', ruleSays);
    if (net !== ruleSays) {
      problem(
        `٦ · ${scenario.key}: لا أحد وقف على الباب، فالمنتظر كامل الطلب ناقصاً الأجرة = ${net}، ` +
          `و«expectedAmountFor» تقول ${ruleSays} — فرق ${round(ruleSays - net, stage.minorUnit)} على طلبٍ ` +
          'لم يُسجَّل تسليمه يداً، وهو الطلب الذي الكشفُ وحده إثباتُ تسليمه.'
      );
    }
    /*
     * `doorExpected` is the whole order and not null: nobody stood at the
     * door, but the customer is still expected to pay for all of it. Leaving
     * it null made this order contribute ZERO to the «what the door expected
     * from customers» total at stop 13, and that total was then compared
     * against a revenue figure that does include it.
     */
    return {
      order: o,
      doorExpected: doorAll,
      screenExpected: null,
      honestNet: net,
      systemExpects: ruleSays,
    };
  }

  let body: Record<string, unknown>;
  if (scenario.door === 'ALL') {
    body = { orderId: order.id, outcome: 'ALL', note: 'المسار الذهبي: تسليم كامل' };
  } else if (scenario.door === 'NONE') {
    body = { orderId: order.id, outcome: 'NONE', note: 'المسار الذهبي: رفض الاستلام بالكامل' };
  } else {
    const head = lines[0];
    const take = Math.max(0, head.quantity + head.freeQuantity - 1);
    body = {
      orderId: order.id,
      lines: [{ itemId: head.id, deliveredQty: take }, ...lines.slice(1).map((l) => ({ itemId: l.id, deliveredQty: l.quantity + l.freeQuantity }))],
      note: 'المسار الذهبي: تسليم جزئي',
    };
  }

  const deliver = await api('/api/ops/tracking/deliver', { method: 'POST', body: JSON.stringify(body) });
  if (deliver.status !== 200) {
    problem(`٥ · ${scenario.key}: التسليم رُفض (${deliver.status}): ${JSON.stringify(deliver.body).slice(0, 220)}`);
    return null;
  }
  const outcome = (deliver.body.outcome ?? deliver.body) as Record<string, unknown>;
  const doorExpected = outcome.collectedAmount === undefined ? null : Number(outcome.collectedAmount);

  const o = await reread(order.id);
  record(`٥ · ${scenario.key}`, 'ما ينتظره الباب من المندوب', doorExpected ?? '— لم يُرسَل —');
  record(`٥ · ${scenario.key}`, 'المقبوض على الصف', o.collectedAmount === null ? 'null (لم يُكتب بعد)' : Number(o.collectedAmount));
  record(`٥ · ${scenario.key}`, 'كلفة البضاعة', Number(o.estimatedCostOfGoods ?? 0));
  record(`٥ · ${scenario.key}`, 'الحالة', o.shippingStatus);

  /*
   * THE DOOR DOES NOT WRITE THE MONEY — on purpose, and the comment at the
   * top of lib/partial-delivery.ts says why. So `collectedAmount` must still
   * be null here, and the courier's statement is the only thing that writes
   * it. If it is not null, something put a typed figure on the row and that
   * order has quietly left the set the statement checks.
   */
  if (o.collectedAmount !== null) {
    problem(`٥ · ${scenario.key}: الباب كتب المقبوض (${Number(o.collectedAmount)}) — والعقد يقول إنّ كشف الشركة وحده يكتبه`);
  }

  // ── STOP 6 — through the filter, which is where the screen's default is. ──
  const tracking = await api(`/api/ops/tracking?status=${o.shippingStatus}`);
  const rows = ((tracking.body as { orders?: Record<string, unknown>[] }).orders ?? []) as Record<string, unknown>[];
  const row = rows.find((r) => r.id === order.id);
  let screenExpected: number | null = null;
  if (!row) {
    problem(`٦ · ${scenario.key}: الطلب لا يظهر في شاشة التتبّع بحالة ${o.shippingStatus} — فلا يمكن تحصيله`);
  } else {
    screenExpected = row.expectedCollection === undefined || row.expectedCollection === null ? null : Number(row.expectedCollection);
    record(`٦ · ${scenario.key}`, 'ما تنتظره شاشة التحصيل', screenExpected ?? '— لم يُرسَل —');
    /*
     * THE SUPERSEDED FORMULA, written out ON PURPOSE and the one place in
     * this file where that is right: it is not a live rule being restated,
     * it is the DEAD one, kept so the walk can show the gap between what the
     * strip used to print and what the screen prints now, on a real order.
     * Nothing compares it against anything; it only feeds the observation.
     */
    const oldFormula = Number(o.totalAmount) - Number(o.deliveryFee ?? 0);
    record(`٦ · ${scenario.key}`, 'الصيغة القديمة المهجورة للشريط', oldFormula);
    if (screenExpected === null) {
      problem(`٦ · ${scenario.key}: شاشة التتبّع لا ترسل expectedCollection — والشاشة تحتاجه لتعرض الصافي`);
    } else if (screenExpected !== oldFormula) {
      observe(
        `٦ · ${scenario.key}: الشريط القديم كان يطبع ${oldFormula} والنافذة ${screenExpected} — الفرق ` +
          `${Math.abs(oldFormula - screenExpected)}. هذه هي المخالفة التي أُصلحت، ظاهرةً على طلبٍ حقيقي.`
      );
    }
  }

  const fee = Number(o.deliveryFee ?? 0);

  /*
   * TWO ANSWERS TO ONE QUESTION, and this is the stop the whole harness is
   * for. They must come from TWO PLACES or the comparison proves nothing.
   *
   * THE TRUTH is the DOOR'S, and it is the one figure this script still
   * computes itself (`honestNetFor`): the door's own HTTP answer said what
   * the customer handed over, the courier keeps its fees out of that, and
   * the remainder is what reaches us. It may not call `expectedAmountFor` —
   * if it did, the next line would be `x === x` and stop 6 would be a check
   * that can never fail.
   *
   * THE SYSTEM'S ANSWER is `expectedAmountFor` itself, CALLED, on the very
   * row the matcher will read. It used to be retyped here as
   * `(collectedAmount ?? totalAmount) − deliveryFee`; the rule outgrew that
   * copy and the copy is what this walk then reported as a defect.
   */
  const honestNet = honestNetFor(o, doorExpected, stage.minorUnit);
  const systemExpects = expectedAmountFor(o, stage.minorUnit);
  record(`٦ · ${scenario.key}`, 'الصافي الصحيح من الباب', honestNet);
  record(`٦ · ${scenario.key}`, 'الصافي كما تحسبه القاعدة', systemExpects);

  if (honestNet !== systemExpects) {
    problem(
      `٦ · ${scenario.key}: الطلب ${o.orderNumber} حالته ${o.shippingStatus}. الباب يقول إنّ العميل دفع ` +
        `${doorExpected}، فالواصل إلينا ${honestNet} بعد أجرة ${fee} وأجرة إرجاع ` +
        `${Number(o.returnReceipt?.courierFeeAmount ?? 0)}. و«expectedAmountFor» — وهي ما تقارن به ` +
        `المطابقة وما تطبعه شاشة التحصيل — تنتظر ${systemExpects}، أي الفرق ${round(systemExpects - honestNet, stage.minorUnit)}. ` +
        'والرقمان مأخوذان من مصدرين: الأول من جواب باب التسليم، والثاني من القاعدة على الصفّ نفسه. ' +
        'فاختلافُهما يعني أنّ حساب الباب وحساب المطابقة افترقا على طلبٍ حقيقي.'
    );
  }
  if (screenExpected !== null && screenExpected !== honestNet) {
    problem(
      `٦ · ${scenario.key}: شاشة التحصيل تطبع ${screenExpected} والواصل الصحيح ${honestNet} — ` +
        `فالموظّف يطالب المندوب بفرق ${round(screenExpected - honestNet, stage.minorUnit)} لا يملكه`
    );
  }

  return { order: o, doorExpected, screenExpected, honestNet, systemExpects };
}

/**
 * THE SCRIPT'S OWN ANSWER to "what should the courier hand over", derived
 * from the DOOR's figure and nothing else. The one piece of settlement
 * arithmetic this file is allowed to keep, because it is the other half of
 * stop 6's comparison: the rule is called, this is computed, and they are
 * held against each other. Calling the rule here too would delete the check.
 *
 * It is pinned to `expectedAmountFor` in three ways, all of them deliberate:
 *
 *   THE DELIVERY FEE comes out whatever was taken. The courier travelled to
 *   that door. Under both pricing modes one expression covers it, because
 *   the door already put the fee inside `collectedAmount` when the price
 *   excludes delivery and left it inside the line prices when it includes
 *   delivery.
 *
 *   THE RETURN FEE comes out too, read off `ReturnReceipt.courierFeeAmount`
 *   — the same column the rule reads. Before this existed the script's
 *   figure stopped at the delivery fee while the rule went on to the return
 *   fee, so any scenario that charged one would have reported a difference
 *   that was only the script being a version behind.
 *
 *   A RETURNED PARCEL IS ZERO on both sides, and the rule's own short-circuit
 *   is what says so — asked here rather than re-tested, so a change to which
 *   statuses count as returned cannot make the two disagree.
 *
 * AND IT IS NOT CLAMPED AT ZERO. The old line was
 * `round(Math.max(0, doorExpected − fee))`, and the rule's comment now says
 * in as many words that it returns a negative figure as it stands: a return
 * fee bigger than the goods the customer kept means WE owe the courier, and
 * rounding that up to zero hides a real debt. Clamping one side of a
 * comparison is the defect this whole task is about, one layer down — the
 * script would have been reporting a difference it created itself, and the
 * only way to make it «pass» would have been to clamp the rule too, i.e. to
 * silence the debt in the product so the harness would stop mentioning it.
 * So the script asserts the SIGNED figure, matches the rule's sign, and a
 * genuinely negative expectation flows through to stop 8 as a negative
 * stated net — which is what an honest courier's file would say when they
 * are owed money for the trip back.
 */
function honestNetFor(
  order: { shippingStatus: string; totalAmount: unknown; returnReceipt: { courierFeeAmount: unknown } | null; deliveryFee: unknown },
  doorExpected: number | null,
  minorUnit: number
): number {
  if (order.shippingStatus === 'RETURNED' || order.shippingStatus === 'RETURN_REQUESTED') return 0;
  const fee = round(Number(order.deliveryFee ?? 0), minorUnit);
  const returnFee = round(Number(order.returnReceipt?.courierFeeAmount ?? 0), minorUnit);
  const atDoor = doorExpected ?? Number(order.totalAmount);
  return round(atDoor - fee - returnFee, minorUnit);
}

/* ──────────────────────────────────────────────────────────────────────
 * STOP 7 — the goods come back, and are COUNTED AND INSPECTED.
 *
 * «Nothing re-enters stock before the count-and-inspect acknowledgement.»
 * Two halves settle separately here: this desk closes the GOODS half, and
 * the courier's statement closes the MONEY half. The endpoint reports
 * `completion` precisely so nobody reads a half-settled order as finished.
 * ────────────────────────────────────────────────────────────────────── */
async function stopSevenReturns(stage: Stage, runs: Run[]) {
  const list = await api('/api/ops/returns');
  if (list.status !== 200) {
    problem(`٧ · قائمة المرتجعات رُفضت (${list.status}): ${JSON.stringify(list.body).slice(0, 220)}`);
    return;
  }
  const rows = ((list.body as { orders?: Record<string, unknown>[] }).orders ?? []) as Record<string, unknown>[];
  record('٧ · المرتجعات', 'عدد المرتجعات المعلنة في القائمة', rows.length);

  const comingBack = runs.filter((r) => ['RETURNED', 'PARTIALLY_DELIVERED', 'FAILED_DELIVERY', 'RETURN_REQUESTED'].includes(r.order.shippingStatus));
  if (comingBack.length === 0) {
    cannot('٧ · استلام المرتجع', 'no order on this walk had units coming back');
    return;
  }

  for (const run of comingBack) {
    const row = rows.find((r) => r.id === run.order.id);
    if (!row) {
      problem(`٧ · ${run.scenario.key}: الطلب ${run.order.orderNumber} حالته ${run.order.shippingStatus} ولا يظهر في قائمة المرتجعات — فلا أحد يعدّ بضاعته`);
      continue;
    }
    const expectedQty = Number(row.expectedQty ?? 0);
    record(`٧ · ${run.scenario.key}`, 'الكمية المنتظرة رجوعاً', expectedQty);

    /*
     * THE ACKNOWLEDGEMENT IS NOT OPTIONAL — proved by asking without it.
     * `countedAndInspected: z.literal(true)` is the schema's own refusal.
     */
    const without = await api('/api/ops/returns', {
      method: 'POST',
      body: JSON.stringify({ orderId: run.order.id, receivedQty: expectedQty, damagedQty: 0 }),
    });
    record(`٧ · ${run.scenario.key}`, 'الاستلام بلا إقرار العد', `${without.status} — ${String((without.body as { error?: string }).error ?? '').slice(0, 60)}`);
    if (without.status === 201) {
      problem(`٧ · ${run.scenario.key}: المرتجع استُلم بلا إقرار العد والفحص — والعقد يمنعه`);
    }

    // One unit short on purpose where there is room for it, so `missingQty`
    // is COMPUTED rather than typed — which is what the route promises.
    const damaged = expectedQty >= 2 ? 1 : 0;
    const receivedQty = expectedQty - damaged;
    const got = await api('/api/ops/returns', {
      method: 'POST',
      body: JSON.stringify({
        orderId: run.order.id,
        receivedQty,
        damagedQty: damaged,
        countedAndInspected: true,
        chargeCourierFee: !!run.scenario.chargeReturnFee,
        note: 'المسار الذهبي: عدٌّ وفحص',
      }),
    });
    if (got.status !== 201) {
      problem(`٧ · ${run.scenario.key}: استلام المرتجع رُفض (${got.status}): ${JSON.stringify(got.body).slice(0, 220)}`);
      continue;
    }
    const receipt = got.body.receipt as Record<string, unknown>;
    made(`ReturnReceipt ${String(receipt.id)} — ${run.scenario.key}`);
    const completion = got.body.completion as Record<string, unknown> | undefined;
    record(`٧ · ${run.scenario.key}`, 'وصل / تالف / ناقص', `${receivedQty} / ${damaged} / ${Number(got.body.missingQty ?? 0)}`);
    record(`٧ · ${run.scenario.key}`, 'أجرة الإرجاع المحمَّلة', Number(got.body.courierFeeAmount ?? 0));
    record(`٧ · ${run.scenario.key}`, 'اكتمال الطلب', String(completion?.label ?? completion?.degree ?? '—'));

    if (run.scenario.chargeReturnFee) {
      const charged = Number(got.body.courierFeeAmount ?? 0);
      if (charged !== stage.returnFee) {
        problem(
          `٧ · ${run.scenario.key}: أجرة الإرجاع المحمَّلة ${charged} وجدول الأجور يقول ${stage.returnFee} — ` +
            'والعقد يقول إنها تُقرأ من الجدول ولا تُكتب يداً'
        );
      }
      /*
       * AND WHERE DOES THAT FEE GO? `ReturnReceipt.courierFeeAmount` is
       * written and nothing else is: no wallet movement, no order column, no
       * statement line. It is a number we intend to claim off the courier
       * and the only place it exists is on the receipt.
       */
      const owed = await db.walletMovement.count({ where: { referenceType: 'ORDER', referenceId: run.order.id } });
      record(`٧ · ${run.scenario.key}`, 'حركات محفظة بأجرة الإرجاع', owed);
      if (charged > 0 && owed === 0) {
        observe(
          `٧ · ${run.scenario.key}: أجرة الإرجاع ${charged} سُجّلت على إيصال المرتجع وحده. لا حركة محفظة ولا ` +
            'سطر كشف يحملها، فهي لا تدخل رصيداً ولا إغلاقاً ولا تقرير ربح — تُقتطع عملياً عند ' +
            'تسوية الشركة، ولا شيء في النظام يقابل الاثنين.'
        );
      }
    }

    // The goods half is closed; the money half must NOT have moved with it.
    const after = await reread(run.order.id);
    record(`٧ · ${run.scenario.key}`, 'الحالة بعد الاستلام', after.shippingStatus);
    record(`٧ · ${run.scenario.key}`, 'حالة التسوية بعد الاستلام', after.settlementStatus);
    run.order = after;

    /*
     * AND THE EXPECTATION IS RE-ASKED, because this desk just changed one of
     * its inputs. `expectedAmountFor` reads `ReturnReceipt.courierFeeAmount`,
     * and that receipt did not exist when stop 6 measured. A figure captured
     * at stop 6 and carried to stop 8 would write a courier file stating a
     * net the rule no longer expects, and stop 10 would then report a
     * difference that this script created by holding a stale number — the
     * same class of fault as the hand-copied formula, one stop later.
     *
     * Both halves are re-derived, each from its own source: the rule from the
     * refreshed row, the door's truth from the door's remembered figure plus
     * the return fee now on the row. The gap between stop 6 and stop 7 is
     * recorded rather than swallowed, so a return fee that moves the money is
     * visible in the trace instead of showing up as a mismatch at stop 10.
     */
    const reExpected = expectedAmountFor(after, stage.minorUnit);
    const reHonest = honestNetFor(after, run.doorExpected, stage.minorUnit);
    if (reExpected !== run.systemExpects || reHonest !== run.honestNet) {
      record(
        `٧ · ${run.scenario.key}`,
        'الصافي المنتظر بعد إيصال المرتجع',
        `${run.honestNet} → ${reHonest} / ${run.systemExpects} → ${reExpected}`,
        'أجرة الإرجاع دخلت الحساب'
      );
    }
    run.honestNet = reHonest;
    run.systemExpects = reExpected;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * STOPS 8–11 — the courier's file, the money that actually arrived, the
 * matching, and the only moment a wallet moves.
 * ────────────────────────────────────────────────────────────────────── */
async function stopsEightToEleven(stage: Stage, runs: Run[], windowFrom: Date) {
  const listed = runs.filter((r) => r.scenario.inStatement && r.reachedDoor);
  if (listed.length === 0) {
    cannot('٨ · كشف الشركة', 'no order reached the door, so there is nothing for a courier to state');
    return null;
  }

  /*
   * THE FILE, written the way a courier writes one: their barcode, the COD
   * they took off the customer, the fee they kept, and the net they are
   * handing over. Column names come from HEADER_ALIASES in lib/settlement.ts
   * — the parser prefers an explicit `net` over deriving it, so both are
   * written and they agree on the honest rows.
   */
  const header = 'barcode,cod,fee,net,status,notes';
  const rows: string[] = [];
  const stated = new Map<string, { net: number; fee: number }>();
  for (const run of listed) {
    const o = run.order;
    const fee = round(Number(o.deliveryFee ?? 0) + (run.scenario.feeDelta ?? 0), stage.minorUnit);
    const net = round(run.honestNet + run.scenario.statedDelta, stage.minorUnit);
    const cod = round(net + fee, stage.minorUnit);
    stated.set(o.id, { net, fee });
    rows.push(`${o.trackingNumber},${cod},${fee},${net},DELIVERED,${o.merchantRef ?? ''}`);
    record(`٨ · ${run.scenario.key}`, 'الصافي كما أقرّته الشركة', net, run.scenario.statedDelta || run.scenario.feeDelta ? 'مُحرَّف على عمد' : 'مطابق');
  }
  /*
   * AND ONE LINE FOR A PARCEL WE HAVE NEVER HEARD OF — the MISSING_IN_SYSTEM
   * queue, which is the courier claiming money for something that is not
   * ours. A barcode no order can carry, so it cannot collide with a real row.
   */
  const ghostNet = 7;
  rows.push(`GP-GHOST-${Date.now().toString(36).toUpperCase()},${ghostNet + stage.fee},${stage.fee},${ghostNet},DELIVERED,`);

  const csv = [header, ...rows].join('\r\n');
  const reference = `GP-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
  const fileName = `${reference}.csv`;
  const filePath = path.join(os.tmpdir(), fileName);
  try {
    fs.writeFileSync(filePath, csv, 'utf8');
    made(`ملف الكشف ${filePath}`);
  } catch {
    /* the bytes are what the API needs; the file on disk is a courtesy */
  }

  const claimed = round(
    [...stated.values()].reduce((s, v) => s + v.net, 0) + ghostNet,
    stage.minorUnit
  );
  record('٨ · الكشف', 'ما تقرّه الشركة في الملف', claimed, `${rows.length} سطراً`);

  const upload = await api('/api/finance/statements', {
    method: 'POST',
    body: JSON.stringify({
      deliveryProviderId: stage.providerId,
      reference,
      fileName,
      content: csv,
      encoding: 'text',
      periodFrom: windowFrom.toISOString(),
      periodTo: new Date().toISOString(),
    }),
  });
  if (upload.status !== 201) {
    problem(`٨ · رفع الكشف رُفض (${upload.status}): ${JSON.stringify(upload.body).slice(0, 300)}`);
    cannot('٨ · كشف الشركة', `the upload door answered ${upload.status}`);
    return null;
  }
  const statement = upload.body.statement as Record<string, unknown>;
  const statementId = String(statement.id);
  made(`CourierStatement ${reference} (${statementId})`);
  record('٨ · الكشف', 'الإجمالي كما قرأه النظام', Number(statement.totalAmount));
  if (round(Number(statement.totalAmount), stage.minorUnit) !== claimed) {
    problem(
      `٨ · الملف يقرّ ${claimed} والنظام قرأ ${Number(statement.totalAmount)} — الفرق ` +
        `${round(Number(statement.totalAmount) - claimed, stage.minorUnit)} بين الملف وما خُزِّن عنه`
    );
  }

  /*
   * THE SAME FILE TWICE IS IMPOSSIBLE, and the hash is the whole point of
   * storing it. Asked rather than assumed.
   */
  const again = await api('/api/finance/statements', {
    method: 'POST',
    body: JSON.stringify({
      deliveryProviderId: stage.providerId,
      reference: `${reference}-REPEAT`,
      fileName,
      content: csv,
      encoding: 'text',
    }),
  });
  record('٨ · الكشف', 'رفع الملف نفسه مرة ثانية', `${again.status} ${String((again.body as { code?: string }).code ?? '')}`);
  if (again.status !== 409) {
    problem(`٨ · الكشف نفسه استُورد مرتين (${again.status}) — والبصمة موجودة لتمنع هذا بالضبط`);
  }

  // ── STOP 9 — the receipt, split across two wallets, with a gap. ──
  /*
   * MANY RECEIPTS PER STATEMENT is the normal case: a courier pays part in
   * cash and part by transfer. The split here is deliberate, and so is the
   * SHORTFALL: the receipts come to less than the courier claimed, which is
   * the case the approval gate exists for.
   */
  const shortfall = round(1 / 10 ** Math.min(stage.minorUnit, 2), stage.minorUnit) * 5;
  const toCash = round(Math.floor(claimed / 2), stage.minorUnit);
  const toBank = round(claimed - toCash - shortfall, stage.minorUnit);

  for (const [walletId, walletName, amount] of [
    [stage.cashWalletId, stage.cashWalletName, toCash],
    [stage.bankWalletId, stage.bankWalletName, toBank],
  ] as [string, string, number][]) {
    if (amount <= 0) continue;
    const r = await api(`/api/finance/statements/${statementId}/receipts`, {
      method: 'POST',
      body: JSON.stringify({ walletId, amount, note: `المسار الذهبي — ${walletName}` }),
    });
    if (r.status !== 201) {
      problem(`٩ · إيصال ${walletName} رُفض (${r.status}): ${JSON.stringify(r.body).slice(0, 220)}`);
      continue;
    }
    made(`StatementReceipt ${String((r.body.receipt as Record<string, unknown>).id)} — ${walletName} ${amount}`);
    record('٩ · الإيصالات', `وصل إلى ${walletName}`, amount);
  }

  const gapBody = (await api(`/api/finance/statements/${statementId}`)).body as Record<string, unknown>;
  const gap = gapBody.gap as Record<string, unknown>;
  record('٩ · الإيصالات', 'ما أقرّته الشركة', Number(gap.claimed));
  record('٩ · الإيصالات', 'ما وصل فعلاً', Number(gap.received));
  record('٩ · الإيصالات', 'الفرق', Number(gap.gap));

  /*
   * NO MONEY HAS MOVED YET. Asserted, not assumed: the receipts are a record
   * of what arrived, and the wallet movement is written at APPROVAL. If a
   * balance has already changed here, approval would write it twice.
   */
  const movementsBefore = await db.walletMovement.count({ where: { referenceType: 'STATEMENT', referenceId: statementId } });
  record('٩ · الإيصالات', 'حركات المحافظ قبل الاعتماد', movementsBefore);
  if (movementsBefore !== 0) {
    problem(`٩ · ${movementsBefore} حركة محفظة كُتبت قبل الاعتماد — والعقد يقول إنّ المال لا يتحرّك إلا بالاعتماد`);
  }

  // ── STOP 10 — matching. ──
  /*
   * MATCHING COMES AFTER THE RECEIPT, and the route refuses the other order.
   * It is asked the wrong way round first, because a gate nobody tries is a
   * gate nobody knows is there.
   */
  const match = await api(`/api/finance/statements/${statementId}/match`, { method: 'POST' });
  if (match.status !== 200) {
    problem(`١٠ · المطابقة رُفضت (${match.status}): ${JSON.stringify(match.body).slice(0, 300)}`);
    cannot('١٠ · المطابقة', `the match door answered ${match.status}`);
    return null;
  }
  const outcome = (match.body.outcome ?? {}) as Record<string, number>;
  record('١٠ · المطابقة', 'مطابق', outcome.matched ?? 0);
  record('١٠ · المطابقة', 'مختلف', outcome.mismatched ?? 0);
  record('١٠ · المطابقة', 'منه بفرق أجرة', outcome.feeMismatched ?? 0);
  record('١٠ · المطابقة', 'غير موجود في النظام', outcome.missingInSystem ?? 0);
  record('١٠ · المطابقة', 'غائب عن كشف الشركة', outcome.missingInStatement ?? 0);

  const detail = (await api(`/api/finance/statements/${statementId}`)).body as Record<string, unknown>;
  const queues = detail.queues as Record<string, Record<string, unknown>[]>;
  const allMatches = [...(queues.matched ?? []), ...(queues.mismatched ?? []), ...(queues.missing ?? [])];

  for (const run of runs) {
    const m = allMatches.find((x) => x.orderId === run.order.id);
    if (!m) {
      /*
       * `inStatement` is what the SCENARIO asked for; `reachedDoor` is
       * whether the order got far enough to be written into the file. An
       * order whose walk ended at the shelf is not in the file, and
       * demanding a match row for it blames settlement for a stock shortage.
       */
      if (run.scenario.inStatement && run.reachedDoor) {
        problem(`١٠ · ${run.scenario.key}: الطلب ${run.order.orderNumber} في الملف ولا صفّ مطابقة له`);
      }
      continue;
    }
    /*
     * A parcel the courier never listed HAS a match row — MISSING_IN_STATEMENT,
     * written by the sweep — so it is found here and must not then be judged
     * against MATCHED. Its own expectation is checked below, where the whole
     * question is whether the sweep noticed it at all.
     */
    if (!run.scenario.inStatement) continue;
    const expected = m.expectedAmount === null || m.expectedAmount === undefined ? null : Number(m.expectedAmount);
    const says = m.statementAmount === null || m.statementAmount === undefined ? null : Number(m.statementAmount);
    record(`١٠ · ${run.scenario.key}`, 'نتيجة المطابقة', String(m.result), String(m.matchedBy ?? '—'));
    record(`١٠ · ${run.scenario.key}`, 'ما نتوقّعه / ما تقوله الشركة', `${expected ?? '—'} / ${says ?? '—'}`);
    if (m.feeDifference !== null && m.feeDifference !== undefined && Number(m.feeDifference) !== 0) {
      record(`١٠ · ${run.scenario.key}`, 'فرق أجرة التوصيل', Number(m.feeDifference));
    }

    /*
     * THE ONE CHECK THIS WHOLE HARNESS IS FOR: the figure the door produced
     * and the figure matching expects are the same figure, or a rule says
     * why not.
     */
    if (expected !== null && Math.abs(expected - run.systemExpects) > 1e-9) {
      problem(
        `١٠ · ${run.scenario.key}: صفّ المطابقة ينتظر ${expected}، و«expectedAmountFor» على الصفّ نفسه ` +
          `تعطي ${run.systemExpects} — رقمان لصيغةٍ واحدة`
      );
    }
    /*
     * THE COURIER STATED THE TRUTH. So MATCHED is the only honest answer
     * unless this scenario deliberately bent the file — OR the system's own
     * expectation already disagreed with the door at stop 6, in which case
     * matching is about to blame the courier for OUR arithmetic. Both are
     * named, because «mismatched» alone does not say whose fault it is.
     */
    const bent = run.scenario.statedDelta !== 0 || (run.scenario.feeDelta ?? 0) !== 0;
    /*
     * `ourFault` KEPT, AND IT IS NOT DEAD. It was reviewed as «always false
     * once systemExpects comes from the rule», and that is half true: it is
     * EXPECTED to be false, and its being false is the pass condition — but
     * it is not structurally false, because its two sides come from two
     * different producers. `honestNet` is derived from the HTTP answer the
     * delivery door gave (partial-delivery.ts' arithmetic, over the wire);
     * `systemExpects` is `expectedAmountFor` called on the database row.
     * settlement.ts says those two are pinned to each other by a unit guard,
     * «if they ever disagree, the screen's figure and the matcher's would
     * too» — and a unit guard pins them on constructed objects. This is the
     * only place they are held together on a REAL row that has been through
     * every door, so deleting it would delete the end-to-end half of that
     * pin.
     *
     * It is load-bearing besides. The file at stop 8 states `honestNet` and
     * the matcher compares against `systemExpects`, so MATCHED is arithmetic-
     * ally reachable only when the two agree. Dropping `ourFault` from
     * `wanted` would make the walk demand MATCHED unconditionally and then
     * report «matching said MISMATCHED» with no word on WHOSE arithmetic was
     * wrong — which is exactly the diagnosis the second `problem()` below
     * exists to give.
     */
    const ourFault = run.systemExpects !== run.honestNet;
    const wanted = bent || ourFault ? 'MISMATCHED' : 'MATCHED';
    if (String(m.result) !== wanted) {
      problem(
        `١٠ · ${run.scenario.key}: المطابقة قالت ${String(m.result)} والمنتظر ${wanted} ` +
          `(تحريف الصافي ${run.scenario.statedDelta}، تحريف الأجرة ${run.scenario.feeDelta ?? 0})`
      );
    }
    if (ourFault && !bent && String(m.result) === 'MISMATCHED') {
      problem(
        `١٠ · ${run.scenario.key}: الشركة أقرّت الصافي الصحيح ${run.honestNet} وصفّها جاء MISMATCHED بفرق ` +
          `${Number(m.difference ?? 0)} — الفرق كلُّه حسابُنا لا حسابُها. هذا طابور «مختلف» يملأ نفسه ` +
          'بكل تسليمٍ جزئيٍّ ثم يُطلب من موظّفٍ أن يحلّه يداً.'
      );
    }
  }

  const unlisted = runs.filter((r) => !r.scenario.inStatement && r.reachedDoor && r.order.shippingStatus !== 'RETURNED');
  for (const run of unlisted) {
    const m = allMatches.find((x) => x.orderId === run.order.id);
    record(`١٠ · ${run.scenario.key}`, 'طلب تُرك خارج الكشف', m ? String(m.result) : '— لا صفّ —');
    if (!m || !String(m.result).startsWith('MISSING')) {
      problem(
        `١٠ · ${run.scenario.key}: الطلب ${run.order.orderNumber} مسلَّم بالفترة نفسها وبالشركة نفسها وتُرك خارج ` +
          'الكشف، ولم يظهر في قائمة «غائب عن كشف الشركة» — وهو الفحص الذي كلُّ عمله التقاط ما لم تذكره الشركة'
      );
    }
  }

  // ── STOP 11 — approval, and the gates in front of it. ──
  /*
   * AN UNEXPLAINED GAP IS REFUSED. Asked first without an explanation, so
   * the refusal is a measured fact and not a comment.
   */
  const bare = await api(`/api/finance/statements/${statementId}`, {
    method: 'PATCH',
    body: JSON.stringify({ approve: true }),
  });
  record('١١ · الاعتماد', 'اعتماد بفرق بلا تفسير', `${bare.status} ${String((bare.body as { code?: string }).code ?? '')}`);
  if (bare.status !== 409) {
    problem(`١١ · كشف فيه فرق ${Number(gap.gap)} اعتُمد بلا تفسير (${bare.status}) — والعقد يمنعه`);
  }

  const balancesBefore = await Promise.all(
    [stage.cashWalletId, stage.bankWalletId].map(async (id) => {
      const r = (await api(`/api/finance/wallets/${id}/movements?limit=1`)).body as Record<string, unknown>;
      return Number((r.balance as Record<string, unknown> | undefined)?.balance ?? NaN);
    })
  );
  record('١١ · الاعتماد', `رصيد ${stage.cashWalletName} قبل`, balancesBefore[0]);
  record('١١ · الاعتماد', `رصيد ${stage.bankWalletName} قبل`, balancesBefore[1]);

  const approve = await api(`/api/finance/statements/${statementId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      approve: true,
      gapExplanation: `نقص ${Number(gap.gap)} — المندوب سلّم الباقي نقداً في اليوم التالي (سكربت المسار الذهبي)`,
    }),
  });
  if (approve.status !== 200) {
    problem(`١١ · الاعتماد رُفض (${approve.status}): ${JSON.stringify(approve.body).slice(0, 300)}`);
    cannot('١١ · حركات المحافظ', `approval answered ${approve.status}`);
    return null;
  }
  record('١١ · الاعتماد', 'أغلقها الكشف تسليماً', Number(approve.body.deliveredByStatement ?? 0));

  const movements = await db.walletMovement.findMany({
    where: { referenceType: 'STATEMENT', referenceId: statementId },
    select: { id: true, walletId: true, direction: true, amount: true, category: true },
  });
  const posted = round(movements.reduce((s, m) => s + (m.direction === 'IN' ? 1 : -1) * Number(m.amount), 0), stage.minorUnit);
  record('١١ · الاعتماد', 'حركات كُتبت بالاعتماد', movements.length);
  record('١١ · الاعتماد', 'مجموع ما دخل المحافظ', posted);
  for (const m of movements) made(`WalletMovement ${m.id} — ${m.direction} ${Number(m.amount)} ${m.category}`);

  /*
   * THE FIGURE AGAIN: what arrived (stop 9) is what moved (stop 11). One
   * movement per receipt, each in the wallet the money actually landed in,
   * and not one minor unit more.
   */
  if (posted !== round(Number(gap.received), stage.minorUnit)) {
    problem(
      `١١ · وصل ${Number(gap.received)} وتحرّك ${posted} — الفرق ${round(posted - Number(gap.received), stage.minorUnit)} ` +
        'بين الإيصالات وحركات المحافظ'
    );
  }

  const balancesAfter = await Promise.all(
    [stage.cashWalletId, stage.bankWalletId].map(async (id) => {
      const r = (await api(`/api/finance/wallets/${id}/movements?limit=1`)).body as Record<string, unknown>;
      return Number((r.balance as Record<string, unknown> | undefined)?.balance ?? NaN);
    })
  );
  record('١١ · الاعتماد', `رصيد ${stage.cashWalletName} بعد`, balancesAfter[0]);
  record('١١ · الاعتماد', `رصيد ${stage.bankWalletName} بعد`, balancesAfter[1]);
  const moved = round(balancesAfter[0] - balancesBefore[0] + balancesAfter[1] - balancesBefore[1], stage.minorUnit);
  record('١١ · الاعتماد', 'ما تحرّكت به الأرصدة', moved);
  if (Number.isFinite(moved) && moved !== posted) {
    problem(`١١ · الأرصدة تحرّكت ${moved} والحركات تقول ${posted}`);
  }

  /*
   * RE-RUNNING MATCHING ON AN APPROVED STATEMENT used to roll it back to
   * MATCHED, after which every approval gate passed again and a SECOND
   * movement was written for the same receipt. Measured on this very
   * database: 1,889.48 USD posted twice from a button. Asked again here, on
   * a statement that is now approved.
   */
  const rematch = await api(`/api/finance/statements/${statementId}/match`, { method: 'POST' });
  record('١١ · الاعتماد', 'إعادة المطابقة بعد الاعتماد', `${rematch.status} ${String((rematch.body as { code?: string }).code ?? '')}`);
  const movementsNow = await db.walletMovement.count({ where: { referenceType: 'STATEMENT', referenceId: statementId } });
  if (movementsNow !== movements.length) {
    problem(`١١ · إعادة المطابقة بعد الاعتماد ضاعفت الحركات: ${movements.length} صارت ${movementsNow}`);
  }
  const twice = await api(`/api/finance/statements/${statementId}`, { method: 'PATCH', body: JSON.stringify({ approve: true }) });
  record('١١ · الاعتماد', 'اعتماد ثانٍ', `${twice.status} ${String((twice.body as { code?: string }).code ?? '')}`);

  // What the statement wrote onto the orders — the money half, at last.
  for (const run of runs) {
    const after = await reread(run.order.id);
    record(`١١ · ${run.scenario.key}`, 'المقبوض بعد الاعتماد', after.collectedAmount === null ? 'null' : Number(after.collectedAmount));
    record(`١١ · ${run.scenario.key}`, 'حالة التسوية', after.settlementStatus);
    const says = stated.get(run.order.id);
    if (says && after.collectedAmount !== null && round(Number(after.collectedAmount), stage.minorUnit) !== says.net) {
      problem(
        `١١ · ${run.scenario.key}: الكشف يقول ${says.net} والمقبوض كُتب ${Number(after.collectedAmount)}`
      );
    }
    /*
     * AND THE COLUMN CHANGED MEANING ON THE WAY. `collectedAmount` is what
     * the door computes as «ما ينتظره الباب من المندوب» — the customer's
     * money. The statement writes the courier's NET into the same column.
     * For a delivery-included order the two differ by the whole fee, and
     * every screen that reads this column as revenue reads the net.
     */
    if (run.doorExpected !== null && after.collectedAmount !== null) {
      const now = round(Number(after.collectedAmount), stage.minorUnit);
      if (now !== run.doorExpected) {
        observe(
          `١١ · ${run.scenario.key}: الباب انتظر ${run.doorExpected} من العميل، وعمود collectedAmount صار ` +
            `${now} — أي صافي الشركة بعد أجرتها (${round(run.doorExpected - now, stage.minorUnit)}). ` +
            'العمود واحد والمعنيان اثنان، ومنه تقرأ شاشات الإيراد.'
        );
      }
    }
    run.order = after;
  }

  return { statementId, reference, gap, posted };
}

/* ──────────────────────────────────────────────────────────────────────
 * STOP 12 — the daily closing, with a difference and a written explanation.
 *
 * Three rules, all of them exercised rather than described:
 *   - a non-zero difference needs a written explanation;
 *   - whoever recorded the movements may not approve the closing;
 *   - the difference is RECHECKED at approval, never trusted.
 * ────────────────────────────────────────────────────────────────────── */
async function stopTwelveClosing(stage: Stage) {
  const today = new Date().toISOString().slice(0, 10);
  const view = await api(`/api/finance/closing?date=${today}`);
  if (view.status !== 200) {
    problem(`١٢ · شاشة الإغلاق رُفضت (${view.status}): ${JSON.stringify(view.body).slice(0, 220)}`);
    cannot('١٢ · الإغلاق اليومي', `the closing screen answered ${view.status}`);
    return;
  }
  const rows = ((view.body as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  record('١٢ · الإغلاق', 'محافظ على شاشة الإغلاق', rows.length, today);

  /*
   * A WALLET WHOSE DAY IS STILL OPEN.
   *
   * `@@unique([walletId, date])` — one closing per wallet per day — and an
   * APPROVED one is final: «إغلاق هذا اليوم معتمد». So a second walk on the
   * same day cannot re-close the wallet the first one closed, and asking it
   * to is not a defect in the product. The walk moves to a wallet whose day
   * is open; if every wallet's day is already approved it says so plainly
   * rather than reporting a 409 as a finding.
   */
  const walletIds = [stage.cashWalletId, stage.bankWalletId];
  const candidates = rows.filter((r) => walletIds.includes(String(r.walletId)));
  const row = candidates.find((r) => {
    const c = r.closing as Record<string, unknown> | null;
    return !c || String(c.status) !== 'APPROVED';
  });
  if (!row) {
    cannot(
      '١٢ · الإغلاق اليومي',
      `both walked wallets already have an APPROVED closing for ${today} (one closing per wallet per day, ` +
        '@@unique([walletId, date]), and an approved one is final). An earlier walk today closed them — ' +
        'the stop was walked then. Run again tomorrow, or give the store a third wallet.'
    );
    return;
  }
  const walletId = String(row.walletId);
  const walletName = String(row.walletName ?? walletId);
  const book = Number(row.bookBalance);
  record('١٢ · الإغلاق', 'رصيد الدفتر', book, walletName);
  if (row.closing) {
    record('١٢ · الإغلاق', 'إغلاق اليوم موجود سلفاً', String((row.closing as Record<string, unknown>).status));
  }
  if (row.blockedBy) {
    const b = row.blockedBy as Record<string, unknown>;
    record('١٢ · الإغلاق', 'يومٌ سابق يحجب هذا اليوم', `${String(b.date).slice(0, 10)} بفرق ${Number(b.difference)}`);
  }

  /*
   * A DIFFERENCE NEEDS A SENTENCE. The count is one minor step short of the
   * book on purpose; the first attempt carries no explanation.
   */
  const step = 1 / 10 ** Math.min(stage.minorUnit, 2);
  const counted = round(book - step, stage.minorUnit);
  const bare = await api('/api/finance/closing', {
    method: 'POST',
    body: JSON.stringify({ walletId, date: today, actualBalance: counted }),
  });
  record('١٢ · الإغلاق', 'جرد بفرق بلا تفسير', `${bare.status} ${String((bare.body as { code?: string }).code ?? '')}`);
  if (bare.status === 201) {
    problem(`١٢ · فرق جردٍ قدره ${round(counted - book, stage.minorUnit)} سُجّل بلا تفسير — والعقد يطلب تفسيراً مكتوباً`);
  }

  const explained = await api('/api/finance/closing', {
    method: 'POST',
    body: JSON.stringify({
      walletId,
      date: today,
      actualBalance: counted,
      explanation: `عجز ${round(step, stage.minorUnit)} — فكّة لم تُردّ إلى الصندوق (سكربت المسار الذهبي)`,
    }),
  });
  if (explained.status !== 201) {
    problem(`١٢ · تسجيل الجرد رُفض (${explained.status}): ${JSON.stringify(explained.body).slice(0, 220)}`);
    cannot('١٢ · الإغلاق اليومي', `recording the count answered ${explained.status}`);
    return;
  }
  const closing = explained.body.closing as Record<string, unknown>;
  made(`DailyClosing ${String(closing.id)} — ${walletName} ${today}`);
  record('١٢ · الإغلاق', 'الدفتر كما سجّله الإغلاق', Number(closing.bookBalance));
  record('١٢ · الإغلاق', 'المعدود', Number(closing.actualBalance));
  record('١٢ · الإغلاق', 'الفرق', Number(closing.difference));
  if (round(Number(closing.bookBalance), stage.minorUnit) !== round(book, stage.minorUnit)) {
    problem(`١٢ · شاشة الإغلاق قالت ${book} والصفّ كُتب بـ ${Number(closing.bookBalance)}`);
  }

  /*
   * SEPARATION OF DUTIES. The walking user posted this wallet's movements at
   * stop 11, so its own approval must be refused — and then somebody else's
   * must pass. Both halves are asked; a rule proved only by its refusal is a
   * rule that might be refusing everybody.
   */
  const own = await api('/api/finance/closing', { method: 'PATCH', body: JSON.stringify({ closingId: closing.id }) });
  record('١٢ · الإغلاق', 'اعتماد من سجَّل الحركات', `${own.status} ${String((own.body as { code?: string }).code ?? '')}`);
  if (own.status === 200) {
    problem('١٢ · من سجّل حركات المحفظة اعتمد إغلاقها بنفسه — والعقد يفصل الدورين');
  }

  if (!stage.approverSession) {
    cannot('١٢ · اعتماد الإغلاق', 'no second signed-in user, so the approval half of segregation-of-duties was not walked');
    return;
  }
  const byOther = await apiAs(stage.approverSession, '/api/finance/closing', {
    method: 'PATCH',
    body: JSON.stringify({ closingId: closing.id }),
  });
  record('١٢ · الإغلاق', 'اعتماد من شخصٍ آخر', `${byOther.status} ${String((byOther.body as { code?: string }).code ?? '')}`);
  if (byOther.status !== 200) {
    problem(`١٢ · اعتماد الإغلاق من شخص آخر رُفض أيضاً (${byOther.status}): ${JSON.stringify(byOther.body).slice(0, 220)}`);
    return;
  }
  const approved = byOther.body.closing as Record<string, unknown>;
  record('١٢ · الإغلاق', 'الفرق المعتمد', Number(approved.difference));
  record('١٢ · الإغلاق', 'التفسير المعتمد', String(approved.explanation ?? '—').slice(0, 50));
  if (round(Number(approved.difference), stage.minorUnit) !== round(counted - book, stage.minorUnit)) {
    problem(`١٢ · الفرق المعتمد ${Number(approved.difference)} يخالف ${round(counted - book, stage.minorUnit)}`);
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * STOP 13 — the profit report, and the commission ledger.
 * ────────────────────────────────────────────────────────────────────── */
async function profitFor(stage: Stage) {
  const r = await api(`/api/finance/profitability?limit=100`);
  if (r.status !== 200) return null;
  const products = ((r.body as { products?: Record<string, unknown>[] }).products ?? []) as Record<string, unknown>[];
  const mine = products.find((p) => p.productId === stage.productId);
  if (!mine) return { revenue: 0, cogs: 0, netProfit: 0, delivered: 0 };
  return {
    revenue: Number(mine.revenue),
    cogs: Number(mine.cogs),
    netProfit: Number(mine.netProfit),
    delivered: Number(mine.deliveredOrders),
  };
}

async function stopThirteen(
  stage: Stage,
  runs: Run[],
  profitBefore: Awaited<ReturnType<typeof profitFor>>
) {
  // ── the profit report ──
  const after = await profitFor(stage);
  if (!after || !profitBefore) {
    cannot('١٣ · تقرير الربح', 'the profitability door did not answer with the walked product');
  } else {
    const deltaRevenue = round(after.revenue - profitBefore.revenue, 2);
    const deltaCogs = round(after.cogs - profitBefore.cogs, 2);
    const deltaProfit = round(after.netProfit - profitBefore.netProfit, 2);
    record('١٣ · الربح', 'إيراد المنتج قبل المشي', profitBefore.revenue);
    record('١٣ · الربح', 'إيراد المنتج بعده', after.revenue);
    record('١٣ · الربح', 'ما أضافه هذا المشي إيراداً', deltaRevenue);
    record('١٣ · الربح', 'ما أضافه كلفةً', deltaCogs);
    record('١٣ · الربح', 'ما أضافه ربحاً', deltaProfit);

    /*
     * WHAT THE REPORT SHOULD HAVE ADDED. Revenue in lib/analytics.ts is
     * `collectedAmount ?? totalAmount` over the DELIVERED and
     * PARTIALLY_DELIVERED orders — so the walk's own contribution is
     * computable from the rows, and the report either agrees or the figure
     * moved between the ledger and the report.
     */
    const counted = runs.filter((r) => ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(r.order.shippingStatus));
    const expected = round(
      counted.reduce((s, r) => s + (r.order.collectedAmount === null ? Number(r.order.totalAmount) : Number(r.order.collectedAmount)), 0),
      2
    );
    record('١٣ · الربح', 'ما تقوله صفوف الطلبات', expected, `${counted.length} طلباً مسلَّماً`);
    if (Math.abs(deltaRevenue - expected) > 0.05) {
      problem(
        `١٣ · تقرير الربح أضاف ${deltaRevenue} والطلبات التي مشت تقول ${expected} — الفرق ` +
          `${round(deltaRevenue - expected, 2)} بين الدفتر والتقرير`
      );
    }
    const doorSum = round(counted.reduce((s, r) => s + (r.doorExpected ?? 0), 0), 2);
    record('١٣ · الربح', 'ما انتظره الباب من العملاء', doorSum);

    /*
     * TWO CAUSES PULL THIS APART IN OPPOSITE DIRECTIONS, and one sentence
     * blaming «the delivery fee» for the net would be arithmetic that
     * happens to add up:
     *
     *   the fee, on every SETTLED order — the statement wrote the courier's
     *   net into `collectedAmount`, so the report's revenue is the net and
     *   not the sale. `shippingCost` is zero on these rows, so the bottom
     *   line still comes out right and only the revenue LINE is the net.
     *
     *   the partials, in the other direction — `collectedAmount` is still
     *   null, so revenue falls back to `totalAmount`, the price of lines the
     *   customer handed back. That one is not a naming problem.
     */
    const feeHeld = round(
      counted
        .filter((r) => r.order.collectedAmount !== null && r.doorExpected !== null)
        .reduce((s, r) => s + (r.doorExpected as number) - Number(r.order.collectedAmount), 0),
      2
    );
    const partialOverstated = round(
      counted
        .filter((r) => r.order.collectedAmount === null && r.doorExpected !== null)
        .reduce((s, r) => s + Number(r.order.totalAmount) - (r.doorExpected as number), 0),
      2
    );
    record('١٣ · الربح', 'أجرةُ التوصيل مخصومةً من الإيراد', -feeHeld);
    record('١٣ · الربح', 'إيرادٌ زائدٌ على ما استُلم فعلاً', partialOverstated);
    if (feeHeld !== 0) {
      observe(
        `١٣ · إيراد التقرير أقلُّ بـ ${feeHeld} من قيمة البيع على الطلبات المسوَّاة: الكشف كتب صافي ` +
          'الشركة في collectedAmount، وتقرير الربح يقرأ ذلك العمود إيراداً. عمود shippingCost صفر على ' +
          'هذه الصفوف فالربح الصافي يخرج صحيحاً — والمخالفة في اسم السطر لا في المحصّلة.'
      );
    }
    if (partialOverstated !== 0) {
      problem(
        `١٣ · تقرير الربح يسجّل ${partialOverstated} إيراداً زائداً: التسليم الجزئي يبقى collectedAmount ` +
          'فيه null (الباب لا يكتبه، والكشف لم يطابقه فلم يكتبه)، فـ analytics.ts يسقط إلى totalAmount — ' +
          'وهو ثمن بنودٍ أعادها العميل. وكلفةُ البضاعة تبقى كلفةَ الطلب كلِّه كذلك، مع أنّ الوحدة ' +
          'المرفوضة رجعت إلى الرف بإيصال مرتجع.'
      );
    }
  }

  // ── the commission ledger ──
  const period = new Date().toISOString().slice(0, 7);
  const accrue = await api('/api/finance/commission', {
    method: 'POST',
    body: JSON.stringify({ orderIds: runs.map((r) => r.order.id) }),
  });
  if (accrue.status !== 200) {
    problem(`١٣ · استحقاق العمولة رُفض (${accrue.status}): ${JSON.stringify(accrue.body).slice(0, 220)}`);
    cannot('١٣ · العمولة', `the accrual door answered ${accrue.status}`);
    return;
  }
  record('١٣ · العمولة', 'طلبات نظر فيها', Number(accrue.body.orders ?? 0));
  record('١٣ · العمولة', 'قيوداً أنشأها', Number(accrue.body.created ?? 0));
  record('١٣ · العمولة', 'ولماذا تخطّى الباقي', JSON.stringify(accrue.body.skipped ?? {}));

  const entries = await db.commissionEntry.findMany({
    where: { orderId: { in: runs.map((r) => r.order.id) } },
    select: { id: true, orderId: true, userId: true, amount: true, status: true, periodMonth: true },
  });
  for (const e of entries) made(`CommissionEntry ${e.id} — ${Number(e.amount)} ${e.status}`);

  /*
   * WHICH RULE GOVERNS, ASKED OF `ruleFor` — not of a WHERE clause.
   *
   * This used to be `findFirst({ appliesToUserId: stage.userId })`, which is
   * a hand-written restatement of two exported rules at once: `isPerOrderRule`
   * (a rule counting a DAY's confirmed orders cannot be answered from one
   * order, and is accrued by a different file entirely) and `ruleFor`'s
   * specificity-and-date ordering (a personal rule beats a role rule; the
   * rule in force ON THE DELIVERY DAY beats today's). `findFirst` with no
   * `orderBy` would have silently picked whichever row Postgres handed back
   * first the day a second rule existed, and then blamed the accrual for the
   * difference. So the whole active set is fetched and the library chooses.
   */
  const companyId = (await db.order.findUniqueOrThrow({ where: { id: runs[0].order.id }, select: { companyId: true } })).companyId;
  const storeRules = ((await db.commissionRule.findMany({
    where: { companyId, storeId: stage.storeId, isActive: true },
  })) as unknown as RuleLike[]).filter(isPerOrderRule);
  const rule = ruleFor(storeRules, { userId: stage.userId, role: stage.userRole, at: new Date() });
  record('١٣ · العمولة', 'القاعدة الحاكمة', rule ? `${rule.type} ${Number(rule.value)}` : '— لا قاعدة —', `من ${storeRules.length} قاعدة`);
  for (const run of runs) {
    const mine = entries.filter((e) => e.orderId === run.order.id);
    const base = round(Number(run.order.totalAmount) - Number(run.order.deliveryFee ?? 0), stage.minorUnit);
    record(`١٣ · ${run.scenario.key}`, 'أساس العمولة', base, run.order.shippingStatus);
    record(`١٣ · ${run.scenario.key}`, 'العمولة المستحقة', mine.length === 0 ? '— لا قيد —' : mine.map((e) => `${Number(e.amount)} ${e.status}`).join(' + '));

    if (run.order.shippingStatus === 'DELIVERED' && rule && mine.length === 0) {
      problem(`١٣ · ${run.scenario.key}: طلب مسلَّم بلا قيد عمولة، وللمتجر قاعدة سارية`);
    }
    if (run.order.shippingStatus === 'RETURNED' && mine.some((e) => e.status !== 'REVERSED' && Number(e.amount) > 0)) {
      problem(`١٣ · ${run.scenario.key}: طلب مرتجع يحمل عمولة موجبة — «المرتجع لا يولّد عمولة»`);
    }
    /*
     * AND THE AMOUNT IS ASKED OF `commissionAmount`, not of `base * value /
     * 100`. The hand-written percentage was already wrong in substance for
     * any rule with TIERS: a per-order rule reads its tiers against the SALE
     * VALUE ("an order over 200 pays more"), so a tiered PERCENT rule pays a
     * rate the flat multiplication cannot produce. Restricting the check to
     * `type === 'PERCENT'` also meant a FIXED rule's amount was never checked
     * at all. Calling the library covers every rule shape and cannot drift.
     */
    const live = mine.filter((e) => e.status !== 'REVERSED');
    if (rule && live.length > 0) {
      const earned = round(live.reduce((s, e) => s + Number(e.amount), 0), stage.minorUnit);
      const want = commissionAmount(rule, base, stage.minorUnit);
      if (Math.abs(earned - want) > 10 ** -stage.minorUnit) {
        problem(
          `١٣ · ${run.scenario.key}: العمولة المقيَّدة ${earned} و«commissionAmount» على الأساس ${base} ` +
            `بقاعدة ${rule.type} ${Number(rule.value)} تعطي ${want} — رقمان لقاعدةٍ واحدة`
        );
      }
    }
  }

  /*
   * AND PAYABLE ONLY AFTER THE SETTLEMENT THAT COVERS IT. The statement was
   * approved at stop 11 and the accrual ran after it, so an entry on a
   * settled order should be PAYABLE and one on an unsettled order ACCRUED.
   * Read off the screen the payout actually reads.
   */
  const screen = await api(`/api/finance/commission?period=${period}`);
  if (screen.status !== 200) {
    problem(`١٣ · شاشة العمولة رُفضت (${screen.status})`);
    return;
  }
  const totals = ((screen.body as { totals?: Record<string, unknown>[] }).totals ?? []) as Record<string, unknown>[];
  const mine = totals.find((t) => t.userId === stage.userId);
  record('١٣ · العمولة', 'مستحق / واجب الدفع / مدفوع / معكوس',
    mine ? `${Number(mine.accrued)} / ${Number(mine.payable)} / ${Number(mine.paid)} / ${Number(mine.reversed)}` : '— لا صفّ —');

  for (const run of runs) {
    const settled = run.order.settlementStatus === 'SETTLED';
    const mineHere = entries.filter((e) => e.orderId === run.order.id && e.status !== 'REVERSED');
    if (mineHere.length === 0) continue;
    const statuses = [...new Set(mineHere.map((e) => e.status))].join(',');
    record(`١٣ · ${run.scenario.key}`, 'حالة القيد مقابل حالة التسوية', `${statuses} / ${run.order.settlementStatus}`);
    if (!settled && statuses.includes('PAYABLE')) {
      problem(`١٣ · ${run.scenario.key}: عمولة صارت واجبة الدفع وتسوية الطلب ${run.order.settlementStatus} — والعقد يربطها بالاعتماد`);
    }
    /*
     * THE QUESTION IS REACHABILITY, NOT THE LABEL — and `ebda101` is what
     * changed it.
     *
     * This check used to read: SETTLED order + ACCRUED entry = «فلا يمكن
     * صرفه أبداً», it can never be paid. That was true when
     * `markPayableForOrders` at statement approval was the only writer of
     * PAYABLE: the accrual ran after the approval, so the one moment that
     * could promote the entry had already passed and the entry sat at ACCRUED
     * for ever. The ruling is now the opposite way round. An entry STAYS
     * ACCRUED at rest and is promoted AT THE MOMENT OF PAYMENT, by the payout
     * door, through the filter `PROMOTABLE_BY_PAYOUT`. So ACCRUED on a
     * SETTLED order is the normal, correct resting state and the old sentence
     * was false in substance while still true in letter — this walk performs
     * no payout, so of course nothing promoted it.
     *
     * What is worth asking is whether the payout door can still REACH the
     * entry. So the filter is handed to the database verbatim, scoped to this
     * order's entries. Restating its conditions here is the defect this whole
     * pass is about: the filter carries four of them (ACCRUED, no payoutId,
     * not reversed, order SETTLED) and any copy would go stale the same way.
     * A zero answer is the real P0 — an entry neither PAYABLE nor promotable
     * is money owed that no door can pay.
     */
    if (settled && statuses === 'ACCRUED') {
      const reachable = await db.commissionEntry.count({
        where: { ...PROMOTABLE_BY_PAYOUT, id: { in: mineHere.map((e) => e.id) } },
      });
      record(
        `١٣ · ${run.scenario.key}`,
        'يصل إليه بابُ الصرف',
        `${reachable}/${mineHere.length}`,
        'ACCRUED عند السكون، ويُرقّى لحظةَ الصرف'
      );
      if (reachable === 0) {
        problem(
          `١٣ · ${run.scenario.key}: الطلب ${run.order.orderNumber} مسوَّى (SETTLED) وقيدُ عمولته ACCRUED ` +
            'ولا يصل إليه بابُ الصرف: مُرشِّح `PROMOTABLE_BY_PAYOUT` في src/lib/commission.ts لا يختاره، ' +
            'فلا هو واجبُ الدفع ولا هو قابلٌ للترقية عند الدفع. وهذا مالٌ مستحقٌّ لا بابَ له — ' +
            'والشروط أربعة (ACCRUED، ولا payoutId، وغير معكوس، والطلب SETTLED) فليُنظر أيُّها سقط.'
        );
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────── */

async function main() {
  const email = process.env.GOLDEN_EMAIL;
  const password = process.env.GOLDEN_PASSWORD;
  const only = process.env.GOLDEN_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const windowFrom = new Date(Date.now() - 60_000);

  console.log('── المسار الذهبي ───────────────────────────────');
  const up = await fetch(`${BASE}/api/public/landing-pages/x/meta`).then(() => true).catch(() => false);
  if (!up) throw new Error(`no server answering at ${BASE} — start the dev server first`);

  if (!email || !password) {
    throw new Error(
      'GOLDEN_EMAIL / GOLDEN_PASSWORD are required: every stop after the public door needs a real session. ' +
        'Use an account whose ROLE STRING is outside TWO_FACTOR_ROLES (WAREHOUSE, MODERATOR, …) and whose ' +
        'Role row carries the settlement and finance grants — this script adds the grants, never the role.'
    );
  }

  const signedIn = await signIn(email, password);
  const who = signedIn.body.user as Record<string, unknown> | undefined;
  console.log(`موقَّع باسم: ${String(who?.name ?? email)} — الدور ${String(who?.role ?? '?')}`);
  const me = await db.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, roleId: true, companyId: true, role: true },
  });
  if (!me.companyId) throw new Error('the signing-in user belongs to no company');

  const stage = await setUpStage(me.id, me.roleId, me.companyId);
  cookie = await pickContext(signedIn.session, stage.countryId, stage.storeId);
  console.log(`السياق: ${stage.storeId} / ${stage.regionName} / ${stage.providerName}`);

  const profitBefore = await profitFor(stage);

  const runs: Run[] = [];
  for (const scenario of SCENARIOS) {
    if (only && !only.includes(scenario.key)) continue;
    console.log(`\n▸ ${scenario.key} — ${scenario.label}`);
    const entered = await stopOneOrderEnters(stage, scenario);
    if (!entered) continue;
    const run: Run = {
      scenario,
      order: entered.order,
      offerPrice: entered.offerPrice,
      offerName: entered.offer.name,
      doorExpected: null,
      screenExpected: null,
      honestNet: 0,
      systemExpects: 0,
      reachedDoor: false,
    };
    runs.push(run);

    const confirmed = await confirmAndHold(stage, scenario, entered.order.id);
    if (!confirmed) continue;
    const shipped = await prepareAndShip(stage, scenario, entered.order.id);
    if (!shipped) continue;
    const door = await atTheDoor(stage, scenario, shipped);
    if (!door) {
      run.order = await reread(entered.order.id);
      continue;
    }
    run.order = door.order;
    run.doorExpected = door.doorExpected;
    run.screenExpected = door.screenExpected;
    run.honestNet = door.honestNet;
    run.systemExpects = door.systemExpects;
    run.reachedDoor = true;
  }

  if (runs.length === 0) throw new Error('no order survived the first stop — nothing to trace');

  console.log('\n▸ ٧ — المرتجعات');
  await stopSevenReturns(stage, runs);

  console.log('▸ ٨–١١ — الكشف، الإيصالات، المطابقة، الاعتماد');
  const settled = await stopsEightToEleven(stage, runs, windowFrom);

  console.log('▸ ١٢ — الإغلاق اليومي');
  if (settled) await stopTwelveClosing(stage);
  else cannot('١٢ · الإغلاق اليومي', 'settlement did not reach approval, so no movement existed to close a day over');

  console.log('▸ ١٣ — الربح والعمولة');
  await stopThirteen(stage, runs, profitBefore);

  /* ── THE TABLE ── */
  console.log('');
  console.log('الرقم عبر المحطّات:');
  for (const t of trace) {
    console.log(`  ${t.stop.padEnd(26)} ${t.figure.padEnd(34)} ${String(t.value)}${t.note ? `   (${t.note})` : ''}`);
  }

  console.log('');
  console.log(`ما أُنشئ (${created.length}):`);
  for (const c of created) console.log(`  + ${c}`);

  if (notes.length > 0) {
    console.log('');
    console.log(`ملاحظات مقيسة — الرقم تغيّر وثمّة قاعدة تشرحه (${notes.length}):`);
    for (const n of notes) console.log(`  · ${n}`);
  }

  if (blocked.length > 0) {
    console.log('');
    console.log(`محطّات لم تُمشَ (${blocked.length}):`);
    for (const b of blocked) console.log(`  × ${b}`);
  }

  console.log('');
  if (problems.length === 0) {
    console.log('لا خلل في المحطّات التي مُشِيَت.');
  } else {
    console.log(`خلل (${problems.length}):`);
    for (const p of problems) console.log(`  · ${p}`);
  }

  console.log('');
  console.log('انحراف معلن: المحطّات المالية مُشِيَت بمستخدمٍ دورُه WAREHOUSE يحمل منحَ settlement.* وfinance.* صفوفاً،');
  console.log('لا بمحاسبٍ ولا بموظّف تسويات — لأن دورَيهما في TWO_FACTOR_ROLES، وهذا السكربت ممنوعٌ من تسجيل عاملٍ ثانٍ.');
  console.log('حُرّاس الأبواب (requirePermission) مُشِيت حقيقةً؛ حارسُ الدور لم يُمشَ.');
  console.log('ولم يُجرَّب كشفٌ يخلط مراجع النظام القديم بالجديد: صيغةُ مرجع النظام القديم غير معروفة،');
  console.log('فملفٌ «مختلط» بسلسلةٍ مُختلَقة لا يثبت إلا أنّ المُختلَق لا يطابق.');
  console.log('');
  console.log(`الطلبات التي مُشِيت: ${runs.map((r) => `${r.scenario.key}=${r.order.orderNumber}`).join('  ')}`);
}

main()
  .catch((e) => {
    console.error('توقّف:', e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
