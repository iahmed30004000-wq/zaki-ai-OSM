import type { Prisma } from '@prisma/client';
import { isAge, type Age } from '../age-piles';
import { orderSearchOr } from '../order-filters';
import { SHIPPING_STATUS_AR } from '../shipping-workflow';
import { NOT_LATE, URGENCIES, type ChipKey, type ConditionKey } from './priority';

/**
 * WHAT A FOLLOW-UP AGENT ASKS OF THE PARCELS IN THE FIELD — THE WORDS, READ ONCE, IN ONE PLACE.
 *
 * «متابعة الشحن — صفحات + فلاتر + بحث». The screen took the two hundred oldest parcels, counted its seven chips over
 * THOSE, and sorted and filtered them in the browser. A shop with five hundred parcels under follow-up therefore read
 * «أُلغي والطرد يسير (3)» when it had eleven — the chip counted the rows it happened to hold — and the search typed
 * from the default view silently looked at every status (`OR` replaced `OR`).
 *
 * Everything a person can choose is read here: the state (the default is the screen's job description; «every» is
 * every state), the chip (one of the seven conditions `parcel-tracking/priority.ts` defines — never a second list of them),
 * the delivery company, the governorate, how long it has been out, and the word searched. A value this module does not
 * know is REFUSED, in Arabic, rather than ignored: ignoring it answers a question nobody asked with a list nobody
 * filtered.
 *
 * Only the state and the search are questions for the database. The company, the governorate, the age and the chip
 * are applied to what that question brought back, because the numbers beside each dropdown (and the seven chips) are
 * counted over the SAME parcels — one read, every number in agreement with the rows.
 *
 * This module imports nothing from the server: the screen reads it too.
 */

/** The state the screen opens on: what is moving, plus what arrived and is still owed. Written out in the door. */
export const DEFAULT_STATUS = 'default';
/** Every state — the old `status=all`, which still means exactly that. The screen sends `every`, because `all` is «no filter» to the list hook. */
export const EVERY_STATUS = 'every';

export const SHIPPING_STATUSES = Object.keys(SHIPPING_STATUS_AR) as (keyof typeof SHIPPING_STATUS_AR)[];
export type StatusChoice = typeof DEFAULT_STATUS | typeof EVERY_STATUS | (typeof SHIPPING_STATUSES)[number];

/** The seven chips, in the order they are drawn — the order of `URGENCIES`, minus «nothing». */
export const TASKS = URGENCIES.filter((k): k is ConditionKey => k !== 'NONE');
/** The chips the screen can press: the seven conditions, then «غير متأخرة» — which is a chip and never a reason. */
export const CHIPS: readonly ChipKey[] = [...TASKS, NOT_LATE];

/** «Nobody» as a courier or a governorate: the parcel has none on it. */
export const NOBODY = 'none';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOneOf = (v: unknown): v is string => typeof v === 'string' && (v === NOBODY || UUID.test(v));

export const isStatusChoice = (v: unknown): v is StatusChoice =>
  v === DEFAULT_STATUS || v === EVERY_STATUS || (typeof v === 'string' && (SHIPPING_STATUSES as readonly string[]).includes(v));
export const isTask = (v: unknown): v is ConditionKey => typeof v === 'string' && (TASKS as readonly string[]).includes(v);
export const isChip = (v: unknown): v is ChipKey => typeof v === 'string' && (CHIPS as readonly string[]).includes(v);

export const MAX_SEARCH_LENGTH = 100;

type Where = Prisma.OrderWhereInput;

/**
 * THE SHARED SEARCH — one builder for every order list, so «بحثت عنه بالطلبات ولقيته وما لقيته بالشحنات» cannot
 * happen. Anyone who reads this screen is shown the customer's phone (the contact buttons are in the row), so the
 * phone clauses are theirs to use.
 */
export const searchWhere = (q: string): Where => ({ OR: orderSearchOr(q) as Where[] });

export interface TrackingApplied {
  status: StatusChoice;
  task: ChipKey | null;
  courier: string | null;
  region: string | null;
  age: Age | null;
  /** The product the order is for — a question for the database, like the state and the search. */
  product: string | null;
  q: string | null;
}

export type TrackingFilterResult =
  | { ok: true; applied: TrackingApplied }
  | { ok: false; error: string; errorAr: string };

/**
 * THE URL'S CHOICES.
 *
 * `all`, an empty value and an absent one mean «no choice» — except the state, where nothing is the default and
 * `all` is kept to mean what it always meant here: every state.
 */
export function trackingFilters(params: URLSearchParams): TrackingFilterResult {
  const refuse = (what: string, arabic: string, value: string): TrackingFilterResult => ({
    ok: false,
    error: `Unknown ${what}: ${value}`,
    errorAr: `${arabic} غير معروف: ${value}`,
  });
  const word = (name: string) => {
    const raw = params.get(name)?.trim();
    return raw ? raw : undefined;
  };
  const choice = (name: string) => {
    const raw = word(name);
    return raw && raw !== 'all' ? raw : undefined;
  };

  const applied: TrackingApplied = { status: DEFAULT_STATUS, task: null, courier: null, region: null, age: null, product: null, q: null };

  const status = word('status');
  if (status) {
    // `all` was «every state» before this list had choices, and links and tests still say it.
    const wanted = status === 'all' ? EVERY_STATUS : status;
    if (!isStatusChoice(wanted)) return refuse('shipping status', 'الحالة', status);
    applied.status = wanted;
  }

  const task = choice('task');
  if (task) {
    if (!isChip(task)) return refuse('task', 'المهمة', task);
    applied.task = task;
  }

  const courier = choice('courier');
  if (courier) {
    if (!isOneOf(courier)) return refuse('courier', 'شركة الشحن', courier);
    applied.courier = courier;
  }

  const region = choice('region');
  if (region) {
    if (!isOneOf(region)) return refuse('region', 'المحافظة', region);
    applied.region = region;
  }

  const age = choice('age');
  if (age) {
    if (!isAge(age)) return refuse('age', 'مدّة الشحن', age);
    applied.age = age;
  }

  const product = choice('product');
  if (product) {
    // A product is a real id or nothing: «nobody» is not a product, and a word is not an id.
    if (!UUID.test(product)) return refuse('product', 'المنتج', product);
    applied.product = product;
  }

  const q = params.get('q')?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (q) applied.q = q;

  return { ok: true, applied };
}
