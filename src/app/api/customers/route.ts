import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { requireContext } from '@/lib/geo-context';
import { ruleFor } from '@/lib/phone-rules';
import { findCustomer, findOrCreateCustomer } from '@/lib/customer-identity';
import { can, getPermissionScope, requirePermission } from '@/lib/authorization';
import { normalizePhoneNumber } from '@/lib/phone';
import { logAudit, redactCustomerForAudit } from '@/lib/audit';
import { apiErrorResponse, forbiddenAr } from '@/lib/api-error';
import { readLimit, readPage } from '@/lib/numeric-input';
import { customerFacts } from '@/lib/customer-insights';
import { customerFilters } from '@/lib/customer-filters';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { typed } from '@/lib/text-search';
import { shortMemo } from '@/lib/short-memo';
import { REPORT_TTL_MS } from '@/lib/heavy-lane';

/** The book's counters, per scope, for the window the reports are kept for (zero under test, so no test inherits another's). */
const KEPT_FACTS = shortMemo<ReturnType<typeof customerFacts>>(REPORT_TTL_MS, 200);

/**
 * Full PII projection for users holding 'customers.view'.
 * Includes contact details, address, notes and order stats.
 */
const FULL_CUSTOMER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  rawPhone: true,
  altPhone: true,
  address: true,
  city: true,
  country: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  // What the grade is derived from. Not a stored score: a score written
  // down was true in March, and goes stale the moment an order moves.
  totalOrders: true,
  deliveredOrders: true,
  cancelledOrders: true,
  totalPurchaseValue: true,
  lastOrderDate: true,
  orders: {
    select: {
      id: true,
      orderNumber: true,
      totalAmount: true,
      status: true,
      createdAt: true,
      product: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
};

/**
 * Limited projection for agents holding only 'customers.view_basic'
 * (CONFIRMATION_AGENT / FOLLOW_UP_AGENT): they need name + phone + city
 * to make calls, but must not see address, notes, altPhone or stats.
 */
const BASIC_CUSTOMER_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  rawPhone: true,
  city: true,
  country: true,
};

export async function GET(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    // Permission-tiered PII: full data for customers.view, limited
    // call-relevant fields for customers.view_basic, 403 for everyone else.
    const canViewFull = can(user, 'customers.view');
    if (!canViewFull && !can(user, 'customers.view_basic')) {
      return NextResponse.json(
        { error: 'Forbidden: missing required permission customers.view', errorAr: forbiddenAr('Forbidden: missing required permission customers.view') },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get('q')?.trim();

    // PAGED, NOT DUMPED: a book of thousands does not fit one request,
    // and `take: 100` did not let the reader choose which hundred.
    // 25 rows to a page, the number the orders screen shows, with the
    // shared reader's cap so a hand-crafted URL cannot pull the whole
    // table either. The page itself is re-clamped below, after the count
    // knows how many pages exist.
    const limit = readLimit(searchParams, 25, 100);

    // This store's customers. The stores are separate businesses: one
    // store's complaint about a person is not the other's to read.
    //
    // THE BOOK, before anything the reader typed or chose: who this person
    // may see at all. The figures above the list are counted over exactly
    // this, so a filter can narrow the list and never the figures.
    const bookWhere: any = { companyId, ...(storeId ? { storeId } : {}) };

    // OWN scope means the customers this person actually brought in: the
    // ones with at least one order they are the moderator of. A customer
    // has no owner column — the relationship lives in the orders — so it is
    // derived here rather than stored, the same way the order state is.
    const scope = getPermissionScope(user, canViewFull ? 'customers.view' : 'customers.view_basic');
    if (scope?.scope === 'OWN') {
      bookWhere.orders = { some: { companyId, moderatorId: user.id } };
    }

    /*
     * THE FILTERS: القائمة بحسب فئة العميل أو محافظته، وبترتيبٍ يختاره القارئ.
     *
     * Added on top of the book, never instead of it — the scope above is
     * already inside `bookWhere`, so no combination of parameters can reach
     * a customer the scope hides. And the limited view (`view_basic`) gets
     * none of them: a filter by refusals or a sort by purchase value would
     * show it the history it is deliberately not shown. See
     * `customer-filters.ts`; an unknown value is a 400, not a guess.
     */
    const filters = customerFilters(searchParams, { full: canViewFull, now: new Date() });
    if (!filters.ok) {
      return NextResponse.json({ error: filters.error, errorAr: filters.errorAr }, { status: 400 });
    }
    const whereClause: any = { ...bookWhere, ...filters.where };

    if (search) {
      const normalizedSearch = normalizePhoneNumber(search);
      whereClause.OR = [
        { fullName: typed(search) },
        { phone: typed(normalizedSearch || search) },
        { rawPhone: typed(search) },
        { city: typed(search) },
      ];
    }

    const total = await db.customer.count({ where: whereClause });
    /*
     * A PAGE PAST THE END IS THE LAST PAGE. `?page=999` with 690 pages
     * used to answer with the number as asked, an empty row list and a
     * bar reading «صفحة 999 من 690» — a screen that said it held nothing
     * and somewhere else at once. The clamp keeps the reader on real
     * rows: the last page, never off the shelf.
     */
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(readPage(searchParams), totalPages);
    const customers = await db.customer.findMany({
      where: whereClause,
      select: canViewFull ? FULL_CUSTOMER_SELECT : BASIC_CUSTOMER_SELECT,
      /*
       * THE BOOK READS FROM THE CUSTOMERS WHO MATTER. `updatedAt` alone
       * put the legacy import's never-ordered rows — created last, so
       * newest — across the first sixty pages of zeros, with the people
       * behind 17,021 orders on page one hundred and something. Count
       * first, recency second, and the id so a page is a place and not a
       * shuffle: equal counters and equal timestamps can still be told
       * apart, so the «التالي» of one reader never hands him another's.
       *
       * That is the DEFAULT. The reader may ask for another (`sort=`), and
       * every one of them still ends in the id for the same reason.
       */
      orderBy: filters.orderBy,
      skip: (page - 1) * limit,
      take: limit,
    });

    /**
     * THE FIGURES ABOVE THE LIST DESCRIBE THE BOOK, NOT THE PAGE.
     *
     * The list is a hundred rows of whatever was searched for. A strip
     * that counted those would change every time somebody typed, and
     * «١٦٧ عميلاً طلبوا» would silently become «٣ من نتائج بحثك». So the
     * counts are taken over everything this person may see, with the
     * search and the filters dropped (`bookWhere`) and only the counters
     * selected. The same figures print the number beside each filter, so
     * the count on «رفضوا طرداً (3)» is the book's, whatever is selected.
     *
     * Withheld from the limited projection on purpose: an agent who may
     * not see a customer's history may not see the history of all of them
     * added up either.
     */
    /*
     * KEPT A MINUTE, PER BOOK — NOT PER REQUEST.
     *
     * These counters read EVERY customer of the book (no `take`) and score each one, and the list asked for them on every
     * mount, every page turn and every pause in typing: the same answer, recomputed for the same scope, each time. They are
     * kept for a minute under the book's own `where` — which holds the company, the store and, for a person who sees only
     * their own customers, that person (`bookWhere.orders.some.moderatorId`) — so one scope can never be handed another's
     * figures. Only the figures are kept: the page of rows above is read afresh every time, so a customer who was just added
     * is on it at once and shows in the strip within the minute. A read that fails is not kept (`short-memo.ts`).
     */
    const facts = canViewFull
      ? await KEPT_FACTS.get(JSON.stringify(bookWhere), async () =>
          customerFacts(
            await db.customer.findMany({
              where: bookWhere,
              select: {
                city: true,
                totalOrders: true,
                deliveredOrders: true,
                cancelledOrders: true,
                totalPurchaseValue: true,
                lastOrderDate: true,
              },
            }),
            new Date()
          )
        )
      : null;

    /*
     * THE QUIET PATH OUT OF THE CUSTOMER TABLE.
     *
     * Everything above guards WHO may read and HOW MUCH per request. What
     * it cannot see is a person entitled to read customers reading all of
     * them, a hundred at a time, over an afternoon. Nothing is blocked —
     * somebody may have a real reason — but crossing the line leaves one
     * legible line in the audit trail and raises a hand.
     */
    await noteCustomersHandedOut({ companyId, storeId, user, where: 'قائمة العملاء', rows: customers });

    /*
     * The country's calling code travels with the list. The rows carry a
     * local number and `wa.me` takes full international digits only, so a
     * link built in the browser from `079…` opens a chat with a number
     * that does not exist. The country is known here, not there.
     */
    return NextResponse.json({
      customers,
      limited: !canViewFull,
      facts,
      pagination: { total, page, limit, totalPages },
      dialCode: ruleFor(country.code)?.dialCode ?? null,
    });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('customers.create');

    const body = await req.json();
    // `country` is NOT read from the body: it is the store's, not typed here.
    const { fullName, phone, altPhone, address, city, notes } = body;

    if (!fullName || !phone) {
      return NextResponse.json({ error: 'Full Name and Phone Number are required', errorAr: 'الاسم ورقم الهاتف مطلوبان.' }, { status: 400 });
    }

    const normalizedPhone = normalizePhoneNumber(phone, country.code);

    /*
     * THROUGH THE ONE OWNER, which this file already imported and never
     * called. Its own `create` had three faults, and the dead import is what
     * gave them away:
     *
     *   · it wrote NO `storeId`. The duplicate check above looked for
     *     `{ companyId, storeId, phone }` and the row landed with a null
     *     store, so the check could never find it again — and because
     *     Postgres treats NULLs as distinct in a unique index,
     *     `@@unique([companyId, storeId, phone])` did not bind these rows at
     *     all. The same person could be added from this screen without limit,
     *     and belonged to no store, so no store-scoped screen listed them.
     *   · it lost the race it was checking for: two clicks created two rows
     *     rather than the second reading the first. `findOrCreateCustomer`
     *     relies on the index and catches P2002.
     *   · `city: 'Cairo'` and `country: 'Egypt'` were invented for a company
     *     whose stores are elsewhere — and `country` is a two-letter code
     *     everywhere else (`@default("EG")`), so this door wrote a second
     *     vocabulary into one column. The country is the STORE's and is never
     *     typed here; the city is asked for or left empty.
     */
    const existing = await findCustomer(db, companyId, storeId, normalizedPhone);
    if (existing) {
      /*
       * «ALREADY HERE» IS NOT «HERE IS THEIR FILE».
       *
       * Typing a phone number into «عميل جديد» used to hand back the whole
       * row of whoever had it — address, notes, counters and every order
       * with its amount — to anyone allowed to ADD a customer. The screen
       * only says «موجود مسبقاً». The file is the address book's, within
       * its scope; everyone else learns that the person exists, and who.
       */
      const book = getPermissionScope(user, 'customers.view');
      const mayRead =
        book?.scope === 'ALL_COMPANY' ||
        (book?.scope === 'OWN' &&
          !!(await db.order.findFirst({ where: { companyId, customerId: existing.id, moderatorId: user.id }, select: { id: true } })));
      if (!mayRead) {
        return NextResponse.json({
          isExisting: true,
          message: 'Customer already exists. Reusing profile to prevent duplication.',
          customer: { id: existing.id, fullName: existing.fullName },
        });
      }
      const withOrders = await db.customer.findFirst({
        where: { id: existing.id },
        include: {
          orders: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              totalAmount: true,
              createdAt: true,
            },
          },
        },
      });
      return NextResponse.json({
        isExisting: true,
        message: 'Customer already exists. Reusing profile to prevent duplication.',
        customer: withOrders ?? existing,
      });
    }

    const customer = await findOrCreateCustomer(db, {
      companyId,
      storeId,
      phone: normalizedPhone,
      rawPhone: phone.trim(),
      fullName: fullName.trim(),
      address: address?.trim() || '',
      city: city?.trim() || '',
      altPhone: altPhone ? altPhone.trim() : null,
      notes: notes?.trim() || null,
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'CUSTOMER_CREATED',
      entity: 'Customer',
      entityId: customer.id,
      // Audit redaction: PII-heavy fields (address, altPhone, notes)
      // are stripped before persisting the audit snapshot.
      newData: redactCustomerForAudit(customer),
    });

    return NextResponse.json({ isExisting: false, customer });
  } catch (error: any) {
    return apiErrorResponse(error);
  }
}
