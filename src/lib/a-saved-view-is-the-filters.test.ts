import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';
import {
  EMPTY_ORDER_FILTERS,
  ORDER_FILTER_PARAMS,
  orderFiltersFromQuery,
  orderFiltersToQuery,
  ordersWhere,
} from './order-filters';

/**
 * «العروض المحفوظة» — THE SAME NINE FILTERS, NOT SET AGAIN EVERY MORNING.
 *
 * `SavedViews.tsx` was a finished component with its own tests and no
 * screen: `nothing-unused-ships.test.ts` listed it under «بُني ولم يُوصَل»
 * and said, correctly, that wiring it or dropping it was a product decision
 * and not that file's to make. It is wired now, to the orders list, which
 * is the screen whose nine controls cost the most to set.
 *
 * A VIEW IS A QUERY STRING AND A NAME. No rows, no counts, no customer and
 * no order id — nothing that could still be true after the data has moved
 * on. Recalling one re-asks the question; it never replays an answer. It
 * lives in `localStorage`, so it is this browser's habit and not an object
 * on the server with an owner, permissions and a lifecycle.
 *
 * WHAT THIS FILE IS FOR. The store is only as faithful as the function that
 * writes the string, so the two directions of the grammar are pinned
 * against each other AND against `ordersWhere`, which is the thing that
 * actually turns a string into rows. A short spelling that returned
 * different rows from the long one would be a second rule wearing the same
 * name.
 */

const SCREEN = 'src/components/screens/OrdersScreen.tsx';
const BUILDER = 'src/lib/order-filters.ts';
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const FULL = {
  q: '0789',
  status: 'DELIVERED',
  productId: 'prod-1',
  source: 'FACEBOOK',
  courierId: 'cour-1',
  regionId: 'reg-1',
  // «ماسكه» (2/11): who holds it now — carried by a saved view like the rest.
  holderId: 'u-7',
  from: '2026-09-01',
  to: '2026-09-30',
  lateDays: '10',
};

describe('the filters a person set, as the one string that asks for them', () => {
  it('writes every filter that is set and nothing that is not', () => {
    expect(orderFiltersToQuery(FULL)).toBe(
      'q=0789&status=DELIVERED&productId=prod-1&source=FACEBOOK&courierId=cour-1&regionId=reg-1&holderId=u-7&from=2026-09-01&to=2026-09-30&lateDays=10'
    );
    // Nothing set is the empty string — not nine `=all` nobody chose.
    expect(orderFiltersToQuery(EMPTY_ORDER_FILTERS)).toBe('');
  });

  it('treats «all», empty and absent as the one thing the builder treats them as', () => {
    // `ordersWhere` is `if (value && value !== 'all')` on every branch, so
    // these three spellings of «no filter» must produce the same string.
    expect(orderFiltersToQuery({ status: 'all', source: '', productId: 'all' })).toBe('');
    expect(orderFiltersToQuery({ q: '   ' })).toBe('');
  });

  it('and comes back as the controls that produced it', () => {
    expect(orderFiltersFromQuery(orderFiltersToQuery(FULL))).toEqual(FULL);
    expect(orderFiltersFromQuery('')).toEqual(EMPTY_ORDER_FILTERS);
    // A leading «?» is what a person pastes out of an address bar.
    expect(orderFiltersFromQuery('?status=DELIVERED').status).toBe('DELIVERED');
  });

  it('CLEARS what the view does not mention, rather than adding to the screen', () => {
    /*
     * «Show me this view» is the request. A recall that kept yesterday's
     * region on top of today's view would show rows neither the name nor
     * the screen accounts for — and the person reading it has no way to see
     * which half came from where.
     */
    const view = orderFiltersFromQuery('status=DELIVERED');
    expect(view.status).toBe('DELIVERED');
    expect(view.regionId).toBe('all');
    expect(view.q).toBe('');
    expect(view.lateDays).toBe('');
  });

  it('ignores a key it does not know, and an empty value in a stored string', () => {
    // A view saved before a filter was removed, or a hand-edited store.
    const view = orderFiltersFromQuery('status=DELIVERED&zone=NORTH&q=');
    expect(view.status).toBe('DELIVERED');
    expect(view.q).toBe('');
    expect(Object.keys(view).sort()).toEqual(Object.keys(EMPTY_ORDER_FILTERS).sort());
  });
});

describe('the short spelling and the long one ask for the same rows', () => {
  /** Every filter spelled out, including the ones that mean «no filter». */
  const longForm = (v: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...EMPTY_ORDER_FILTERS, ...v })) p.set(k, val);
    return p;
  };

  it('for the filters at rest: both produce an unfiltered question', () => {
    const short = ordersWhere(new URLSearchParams(orderFiltersToQuery(EMPTY_ORDER_FILTERS)));
    const long = ordersWhere(longForm({}));
    expect(short.ok && long.ok).toBe(true);
    expect(short.ok && short.where).toEqual(long.ok && long.where);
  });

  it('and for a real view, down to the generated `where`', () => {
    // `lateDays` is left out of the comparison and tested on its own: its
    // cutoff is `Date.now()`-relative, so two calls differ by milliseconds.
    const { lateDays: _late, ...rest } = FULL;
    const short = ordersWhere(new URLSearchParams(orderFiltersToQuery(rest)));
    const long = ordersWhere(longForm(rest));
    expect(short.ok && short.where).toEqual(long.ok && long.where);
    // And it is not vacuously equal because both are empty.
    expect(short.ok && Object.keys(short.where).length).toBeGreaterThan(3);
  });

  it('and the «late» filter the switch stores reaches the builder as a rule', () => {
    const built = ordersWhere(new URLSearchParams(orderFiltersToQuery({ lateDays: '10' })));
    expect(built.ok).toBe(true);
    const and = JSON.stringify(built.ok ? built.where.AND : null);
    expect(and).toContain('shippedAt');
    expect(and).toContain('shippingStatus');
  });

  it('and a state a stored view invented is refused by the builder, not obeyed', () => {
    /*
     * This is why the screen checks a recalled state against
     * `FILTERABLE_STATES` before setting it. `localStorage` is as typeable
     * as an address bar, and a view saved before a state was renamed would
     * otherwise take the whole list down with a 400 nobody asked for.
     */
    const built = ordersWhere(new URLSearchParams('status=NOT_A_STATE'));
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toContain('حالة غير معروفة');
  });
});

describe('the grammar has one key list, and it is not a hand-written one', () => {
  it('every parameter the builder reads is a filter a view can carry, or is named', () => {
    /*
     * A WALK OF THE BUILDER'S OWN SOURCE. Three guards in this repository
     * were found incomplete the day they were written because they were
     * lists of names; this one reads `params.get('…')` out of the file, so
     * a tenth filter added to `ordersWhere` is held to the rule
     * immediately — either a saved view can carry it, or this file says in
     * writing why not.
     */
    const builder = stripComments(src(BUILDER));
    const read = [...builder.matchAll(/params\.get\('([a-zA-Z]+)'\)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThanOrEqual(8);

    /** Read by the builder, and deliberately NOT part of a saved view. */
    const NOT_IN_A_VIEW: Record<string, string> = {
      moderatorId:
        'لا يوجد في شاشة الطلبات مُنتقٍ للمودريتور — حُذف العمود في 2026-09-21 وبقي البانى يقرأ المفتاح لمن يُرسله',
    };

    const carried = new Set(Object.keys(EMPTY_ORDER_FILTERS));
    const unclassified = [...new Set(read)].filter((k) => !carried.has(k) && !(k in NOT_IN_A_VIEW));
    expect(
      unclassified,
      `فلترٌ يقرأه البانى ولا يَحمله عرضٌ محفوظ ولا سببَ مكتوب:\n${unclassified.join('\n')}`
    ).toEqual([]);
  });

  it('and `from`/`to` are in a view although the builder never reads them', () => {
    // The routes read the dates themselves and hand `createdAt` in — so a
    // view that dropped them would silently widen every stored date range.
    const builder = stripComments(src(BUILDER));
    expect(builder).not.toContain("params.get('from')");
    expect(EMPTY_ORDER_FILTERS).toHaveProperty('from');
    expect(EMPTY_ORDER_FILTERS).toHaveProperty('to');
    expect(orderFiltersToQuery({ from: '2026-09-01' })).toBe('from=2026-09-01');
  });

  it('and the export still forwards the list it forwards', () => {
    // `ORDER_FILTER_PARAMS` is the audit record of which filters an export
    // was asked for. It is a different list for a different job, and this
    // pins that it did not quietly become the view's list.
    expect(ORDER_FILTER_PARAMS).toContain('lateDays');
    expect(ORDER_FILTER_PARAMS as readonly string[]).not.toContain('from');
  });
});

describe('the orders screen is where it is wired', () => {
  const screen = () => stripComments(src(SCREEN));

  it('renders the saved views with the filters it is currently showing', () => {
    const text = screen();
    expect(text).toContain('<SavedViews screen="orders" current={filterQuery} onApply={applyFilters} />');
    expect(text).toContain('const filterQuery = orderFiltersToQuery({');
  });

  it('and «إعادة تعيين» IS the empty view, so there is one list of defaults', () => {
    /*
     * This was thirteen setters repeating the defaults by hand, which meant
     * a filter added to the screen had to be remembered in a second place
     * or it survived a reset. Now the reset is the empty string.
     */
    expect(screen()).toContain("const resetFilters = () => applyFilters('');");
  });

  it('and a recalled state is checked before it is set', () => {
    const text = screen();
    const at = text.indexOf('const applyFilters');
    expect(at).toBeGreaterThan(0);
    const body = text.slice(at, text.indexOf('\n  };', at));
    expect(body).toContain('FILTERABLE_STATES');
    expect(body).toContain('EMPTY_ORDER_FILTERS.status');
  });

  it('and applying a view TOUCHES EVERY CONTROL, not only the ones it mentions', () => {
    /*
     * WHERE «replace, not add» ACTUALLY LIVES. `orderFiltersFromQuery`
     * always returns a full set of values — it starts from
     * `EMPTY_ORDER_FILTERS` — so the property can only be broken in the
     * screen, by a recall that sets the three controls the view names and
     * leaves the other six where yesterday left them. The rows would then
     * match neither the view's name nor anything the reader can see.
     */
    const text = screen();
    const at = text.indexOf('const applyFilters');
    const body = text.slice(at, text.indexOf('\n  };', at));
    for (const setter of [
      'setSearchInput(',
      'setSearch(',
      'setStatus(',
      'setSource(',
      'setProductId(',
      'setCourierId(',
      'setFromDate(',
      'setToDate(',
      'setLateOnly(',
      'setRegionId(',
    ]) {
      expect(body, `${setter}: عرضٌ يُطبَّق ولا يَلمس هذا المُرشِّح`).toContain(setter);
    }
    // And the selection goes with them: rows chosen under other filters.
    expect(body).toContain('setSelected(new Set())');
  });

  it('and every filter the screen holds is a filter the view carries', () => {
    /*
     * The one that actually rots: a tenth control added to this screen and
     * not to `filterQuery` would be silently absent from every saved view,
     * and the view would look like it worked. So the setters the reset
     * calls are compared against the keys the query is built from.
     */
    const text = screen();
    const at = text.indexOf('const filterQuery = orderFiltersToQuery({');
    const built = text.slice(at, text.indexOf('});', at));
    for (const key of Object.keys(EMPTY_ORDER_FILTERS)) {
      expect(built, `${key}: مفتاحٌ في القواعد ولا تكتبه الشاشة`).toContain(key);
    }
  });
});
